// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Alloc, FrontObligation, ObligationState } from "../../lib/Types.sol";
import { Errors } from "../../lib/Errors.sol";
import { Events } from "../../lib/Events.sol";
import { BoundedSetLib } from "./BoundedSetLib.sol";
import { PoolLib } from "./PoolLib.sol";

/// @title FrontObligationLib
/// @author Aqua0 Team
/// @notice Delegatecall-linked logic for the DESTINATION half of cross-chain LP fronting: recording who is on
///         the hook for a front, redirecting the proceeds of their sourced principal to the LP they stand in
///         for, and settling both out of the measured bridge landing.
///
/// @dev NO STORAGE OF ITS OWN. The vault owns every mapping; this library is handed references. It lives in a
///      library rather than in `AssetVault` because that contract runs at ~93% of the EIP-170 runtime cap, and
///      library code linked by delegatecall does not count against the caller's runtime size. Writing this
///      inline and refactoring under the ceiling later would mean refactoring under pressure on a contract
///      being deployed to twelve places.
///
///      THE DEFECT THIS CLOSES. On release, the source chain destroys LP-A's principal
///      (`FrontLockLib.release`), and `creditFrontLanding` previously credited the landing to `sharedIdle` and
///      to nobody. `principal[]` is written in exactly one other place, `deposit`. So the bridged capital
///      arrived as UNOWNED idle: unsourceable (sourcing gates on principal room), unwithdrawable (withdraw
///      draws the caller's own principal), and silently relaxing the availability gate for the destination
///      vault's other committers.
///
///      WHY THE REDIRECT RESOLVES HERE AND NOT AT CREDIT TIME. `settleVenueOut` runs on the vault being sold
///      from; `settleVenueCredit` runs on the counter vault. They are different contracts with different
///      storage. The obligation lives with the filler's pledged principal, i.e. on the sourcing side, so the
///      beneficiary must be resolved THERE and carried across in `Alloc`. Resolving at credit time would look
///      up an obligation that vault never recorded and quietly find nothing - the filler would keep the
///      composition and the IL redirect would not fire, with no revert and no wrong number to notice.
library FrontObligationLib {
    /// @dev Scalar args for `open`, grouped for the same stack reason.
    struct OpenParams {
        bytes32 frontId;
        uint256 strategyId;
        address filler;
        address beneficiary;
        uint256 pledged;
        uint256 feeOwed;
        uint256 maxCommitters;
        uint256 maxCommitments;
    }

    /// @notice Record one filler's leg of a front. Reverts if that filler already has an open front on this
    ///         strategy.
    ///
    /// @dev Concurrent fronts are refused rather than queued. The matcher does not currently prevent an LP with
    ///      spare capacity being allocated to two fronts on one strategy - the reservation is keyed
    ///      `(frontId, lp)` and bounds an LP's total allocation, not their count of fronts - so without this a
    ///      second open would overwrite the first, orphaning an obligation and routing one beneficiary's value
    ///      to another. Supporting N concurrently would require deciding which beneficiary receives which share
    ///      of a single draw, which is more state and more branching on the mid-swap path for a capability
    ///      nothing needs yet.
    ///
    ///      Consent is checked by the vault before this is reached: a filler must have opted in explicitly, and
    ///      the opt-in registry is read literally (absent is NOT participating).
    function open(
        mapping(bytes32 => FrontObligation[]) storage obligations,
        mapping(address => mapping(uint256 => bytes32)) storage openFrontOf,
        mapping(address => mapping(uint256 => bool)) storage committed,
        address[] storage committers,
        mapping(address => uint256) storage committerIndex,
        mapping(address => uint256[]) storage committedLists,
        mapping(address => mapping(uint256 => uint256)) storage commitmentIndexes,
        mapping(address => mapping(uint256 => uint256)) storage pendingFrontCredits,
        OpenParams memory p
    ) external {
        bytes32 frontId = p.frontId;
        uint256 strategyId = p.strategyId;
        address filler = p.filler;
        address beneficiary = p.beneficiary;
        uint256 pledged = p.pledged;
        uint256 feeOwed = p.feeOwed;
        require(filler != address(0) && beneficiary != address(0), Errors.ZeroAddress());
        require(pledged > 0, Errors.ZeroAmount());
        // A filler standing in for themselves is not a front; it would also make the redirect a no-op that
        // still consumed the exclusivity slot.
        require(filler != beneficiary, Errors.FrontSelfObligation(filler, strategyId));
        // Exclusivity: one open front per (filler, strategy). See the dev note above.
        bytes32 held = openFrontOf[filler][strategyId];
        require(held == bytes32(0), Errors.FillerFrontExclusive(filler, strategyId, held));

        obligations[frontId].push(
            FrontObligation({
                strategyId: strategyId,
                filler: filler,
                beneficiary: beneficiary,
                pledged: pledged,
                redirected: 0,
                feeOwed: feeOwed,
                state: uint8(ObligationState.Open)
            })
        );
        openFrontOf[filler][strategyId] = frontId;

        // Commit the beneficiary NOW, not at settlement. `creditFromSwap` auto-commits any credited LP and
        // reverts `CommitterSetFull` at the cap; if that revert landed at settlement the bridged tokens would
        // already have arrived and could not be booked - irreversibly moved, unbookable, stranded. Failing
        // here costs nothing because nothing has moved yet. Committing is not backing: it records
        // consent-to-participate, while `principal` is what makes capital sourceable, and a beneficiary's
        // stays zero until settlement credits them composition.
        if (!committed[beneficiary][strategyId]) {
            committed[beneficiary][strategyId] = true;
            BoundedSetLib.addAddress(committers, committerIndex, beneficiary, p.maxCommitters);
            BoundedSetLib.addUint(
                committedLists[beneficiary], commitmentIndexes[beneficiary], strategyId, p.maxCommitments
            );
        }
        // Committing is not enough on its own: `setCommitment(strategyId, false)` is permissionless and both of
        // its gates read REALISED state (`deployedInto`, `composition`), which is zero for a beneficiary until
        // the landing credits them. Record the unsettled claim so un-commit has something to see. Without it the
        // beneficiary can leave the committer set inside the bridge window and the landing then credits
        // composition outside the set conservation folds over, reverting every later capital op on the strategy.
        // Counted rather than flagged: one front may carry several legs naming the same beneficiary.
        pendingFrontCredits[beneficiary][strategyId] += 1;

        emit Events.FrontObligationOpened(address(this), strategyId, frontId, filler, beneficiary, pledged, feeOwed);
    }

    /// @notice Rewrite an `Alloc[]` in place with fronting attribution: for each entry whose LP has an open
    ///         front on this strategy, set the beneficiary and charge the redirected portion to the pledge.
    ///
    /// @dev Deliberately a post-pass over the allocation rather than a hook inside `sellForSwap`. Two reasons:
    ///      it leaves the sourcing function's signature and semantics untouched, and - because this is a
    ///      delegatecall-linked library - the loop and its storage writes cost the vault NO runtime bytes,
    ///      which matters on a contract at ~93% of the EIP-170 cap.
    ///
    ///      RULE: `redirect = min(drawn, pledged - redirected)`. A filler is an ordinary committer whose front
    ///      pledges only PART of their principal, so redirecting all of their proceeds would strip the earnings
    ///      on capital they never pledged - leaving them worse off than not participating, which inverts the
    ///      design's own principle.
    ///
    ///      Pro-rata (`drawn * pledged / principal`) is the purer reading since capital is fungible, and is
    ///      deliberately NOT used: it needs the pledge decremented in lockstep every draw or the ratio drifts
    ///      upward as principal shrinks - a subtle invariant for a second-order economic difference. The cap is
    ///      bounded by construction (`redirected <= pledged`, checkable by inspection), leaves the filler
    ///      strictly LESS retained IL exposure than pro-rata would, and makes settlement's restore exactly this
    ///      accumulator with no drift to reconcile.
    ///
    ///      Entries with no open front keep the identity attribution `sellForSwap` already set
    ///      (`beneficiary == lp`, `redirected == 0`), so the common path writes nothing.
    ///
    /// @return The allocation with fronting attribution applied. The caller MUST take the return value: an
    ///         external library call copies the memory array, so in-place mutation would be lost.
    function applyRedirects(
        mapping(bytes32 => FrontObligation[]) storage obligations,
        mapping(address => mapping(uint256 => bytes32)) storage openFrontOf,
        Alloc[] memory alloc,
        uint256 strategyId
    ) external returns (Alloc[] memory) {
        uint256 n = alloc.length;
        for (uint256 i; i < n; ++i) {
            uint256 drawn = alloc[i].drawn;
            if (drawn == 0) continue;

            bytes32 frontId = openFrontOf[alloc[i].lp][strategyId];
            // The overwhelmingly common path: this LP is not fronting, so attribution stays the identity.
            if (frontId == bytes32(0)) continue;

            FrontObligation[] storage rows = obligations[frontId];
            uint256 m = rows.length;
            for (uint256 j; j < m; ++j) {
                FrontObligation storage o = rows[j];
                if (o.filler != alloc[i].lp || o.strategyId != strategyId) continue;
                if (o.state != uint8(ObligationState.Open)) continue;

                uint256 remaining = o.pledged - o.redirected;
                uint256 take = drawn < remaining ? drawn : remaining;
                if (take > 0) {
                    o.redirected += take;
                    alloc[i].beneficiary = o.beneficiary;
                    alloc[i].redirected = take;
                }
                break;
            }
        }
        // MUST return: this is an `external` library function, so `alloc` arrives as a COPY. Mutating it in
        // place updates the copy and the caller keeps the original - a redirect that resolves correctly,
        // writes the obligation accumulator, and then silently attributes nothing. Returning hands the
        // rewritten array back. Making this `internal` would also work and would cost the vault runtime bytes,
        // which is the thing the library exists to avoid.
        return alloc;
    }

    /// @dev Scalar args for `resolve`, grouped for the same stack reason as `OpenParams`.
    struct ResolveParams {
        bytes32 frontId;
        // Tokens that physically arrived for this front and are therefore available to pay its legs. Zero is
        // valid: it resolves the legs without moving value.
        uint256 received;
        // True when no bridge landing backs this resolution, which decides the terminal state and the event
        // only. Every payout rule below is identical either way, because both are bounded by `received`.
        bool aborting;
    }

    /// @dev The two payout pools and their pro-rata denominators, walked down in lockstep by `_clampedShare`.
    ///      Carried in memory rather than on the stack because the accumulate and pay halves together exceed
    ///      it. Each `left` starts at what its pool may pay and each `weight` at the aggregate claim behind
    ///      it, so `left <= weight` holds on entry, which is the clamp's loop invariant.
    struct Split {
        uint256 restoreLeft;
        uint256 restoreWeight;
        uint256 feeLeft;
        uint256 feeWeight;
    }

    /// @notice Resolve every open leg of a front out of `received`: restore each filler what the redirect took
    ///         from them, pay each their fee, and credit the residual to the beneficiary.
    ///
    /// @dev BOUNDED, NEVER REFUSING. Every payout is clamped to what arrived, so nothing is minted, and a
    ///      `received` below the aggregate claim pays each leg its clamped pro-rata share instead of reverting.
    ///      Refusing is not a safe refusal here and the shape of the damage says why: the redirect debited the
    ///      fillers' principal and credited the proceeds to the beneficiary one transaction earlier, on a
    ///      vault this one cannot reach. A revert gives none of that back. It only makes the position
    ///      permanent, because `received` cannot rise to meet a `required` fixed in storage, so every retry
    ///      fails identically while the legs stay Open, the exclusivity slot stays held and the beneficiary
    ///      stays pinned in the bounded committer set. That is the same "arrived, unbookable, stranded" state
    ///      the fail-open below exists to avoid, reached by a different door.
    ///
    ///      RESTORE RANKS AHEAD OF FEE. The restore is capital the redirect already took; the fee is
    ///      compensation for having taken it. Paying the fee first would fund compensation out of the
    ///      filler's own repayment.
    ///
    ///      `restored` is `redirected`, NOT `pledged` - exactly what was taken - which makes the filler whole
    ///      by construction whenever the landing covers it, and keeps the vault from having to reconcile
    ///      against backend numbers it cannot verify.
    ///
    ///      Single-asset holds by CONSTRUCTION, not by any caller assertion. `obligations` is the settling
    ///      vault's own storage and a row can only be written by `open` on that same vault, so every
    ///      `redirected` this restores was accrued in this vault's asset. A front matched across two
    ///      destination vaults writes a disjoint row set into each, and each vault settles only its own from
    ///      its own landing - so the multi-vault case needs no extra guard here either.
    ///
    /// @return feesPaid Fees ACTUALLY credited to fillers, which the vault adds to `segregatedFees` to hold
    ///         `segregatedFees >= sum(credit)` and to lock those tokens out of deployable idle. Returning the
    ///         nominal claim instead would reserve idle against a fee that was never credited.
    function resolve(
        mapping(bytes32 => FrontObligation[]) storage obligations,
        mapping(address => mapping(uint256 => bytes32)) storage openFrontOf,
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage credit,
        mapping(uint256 => mapping(address => uint256)) storage composition,
        mapping(uint256 => uint256) storage strategyComposition,
        mapping(address => mapping(uint256 => uint256)) storage pendingFrontCredits,
        ResolveParams memory p
    ) external returns (uint256 feesPaid) {
        FrontObligation[] storage rows = obligations[p.frontId];
        uint256 n = rows.length;
        // FAIL OPEN, deliberately. A landing with no recorded obligations credits shared idle and returns, as
        // it did before this layer existed. Requiring an obligation would be the safer-sounding choice and is
        // wrong: the tokens have ALREADY bridged by the time this runs, so a revert here does not prevent a
        // bad state, it creates one - arrived, unbookable, stranded. That is the same failure that put the
        // beneficiary commit at open rather than at settlement.
        //
        // The cost is that a front never opened through `FRONT_OPEN` still leaves its landing as unowned idle,
        // which is the defect this library exists to close. That gap is closed by the backend always opening
        // before releasing, not by reverting after the bridge has moved.
        if (n == 0) return 0;

        uint256 totalRestored;
        uint256 totalFees;
        uint256 live;
        for (uint256 i; i < n; ++i) {
            FrontObligation storage o = rows[i];
            // A leg already resolved is SKIPPED, not refused. It pays nothing and blocks nothing, which is what
            // keeps double payment impossible while leaving a late or repeated landing bookable. Reverting on
            // it would strand exactly the capital this whole layer exists to book.
            if (o.state != uint8(ObligationState.Open)) continue;
            unchecked {
                ++live;
            }
            totalRestored += o.redirected;
            totalFees += o.feeOwed;
        }
        // Nothing left to resolve: the landing stays in shared idle rather than being credited to a
        // beneficiary whose hold this call no longer carries, which would put it outside the index set
        // conservation folds over.
        if (live == 0) return 0;

        // Restore ranks ahead of the fee, and both are clamped to what arrived.
        Split memory s;
        s.restoreWeight = totalRestored;
        s.feeWeight = totalFees;
        s.restoreLeft = totalRestored < p.received ? totalRestored : p.received;
        s.feeLeft = totalFees < p.received - s.restoreLeft ? totalFees : p.received - s.restoreLeft;
        feesPaid = s.feeLeft;
        uint256 paid = s.restoreLeft + s.feeLeft;

        (address beneficiary, uint256 sid) = _payLegs(rows, openFrontOf, principal, credit, pendingFrontCredits, p, s);

        if (totalRestored + totalFees > p.received) {
            emit Events.FrontLandingUnderpaid(address(this), sid, p.frontId, totalRestored + totalFees, p.received);
        }

        // The residual is the beneficiary's: their bridged capital, minus what repaid the fillers who stood in
        // for it. Credited as COMPOSITION, not principal - crediting principal would commit them as BACKING on
        // a chain they never committed to, re-risking an LP without asking. They convert it themselves if they
        // want it sellable. They were committed at open AND held in the committer set for the whole bridge
        // window by `pendingFrontCredits`, so the conservation fold sees this credit. The commit alone does
        // not carry that: un-commit is permissionless, and without the hold the beneficiary can leave the set
        // before the landing and this write then lands outside the folded index set. Reached only when a leg
        // was live in this call, which is what carries that hold; a resolution that found none returned above.
        uint256 residual = p.received - paid;
        if (residual > 0) {
            composition[sid][beneficiary] += residual;
            strategyComposition[sid] += residual;
        }
    }

    /// @dev The write half of `resolve`, split out because the two halves together exceed the stack. Pays each
    ///      live leg its clamped pro-rata share of the two pools, marks it terminal, and releases both holds
    ///      it placed at open.
    /// @return beneficiary The beneficiary of the first live leg, who the residual belongs to.
    /// @return sid That leg's strategy.
    function _payLegs(
        FrontObligation[] storage rows,
        mapping(address => mapping(uint256 => bytes32)) storage openFrontOf,
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage credit,
        mapping(address => mapping(uint256 => uint256)) storage pendingFrontCredits,
        ResolveParams memory p,
        Split memory s
    ) private returns (address beneficiary, uint256 sid) {
        uint256 n = rows.length;
        for (uint256 i; i < n; ++i) {
            FrontObligation storage o = rows[i];
            if (o.state != uint8(ObligationState.Open)) continue;
            if (beneficiary == address(0)) {
                beneficiary = o.beneficiary;
                sid = o.strategyId;
            }

            // A zero-weight leg takes nothing and must be skipped rather than shared: the clamp divides by the
            // remaining weight, which is zero exactly when no leg claims anything under that pool. A front
            // with no fee, or one opened and never drawn against, is an ordinary case, not an edge one.
            uint256 restore;
            uint256 fee;
            if (o.redirected > 0) {
                (restore, s.restoreLeft, s.restoreWeight) =
                    PoolLib._clampedShare(s.restoreLeft, o.redirected, s.restoreWeight);
            }
            if (o.feeOwed > 0) {
                (fee, s.feeLeft, s.feeWeight) = PoolLib._clampedShare(s.feeLeft, o.feeOwed, s.feeWeight);
            }

            // Restore the filler at par for what the redirect took, then pay the fee into `credit`, the
            // realised withdrawable bucket - never into composition, which is the IL-bearing one and the whole
            // thing a filler is meant to be spared.
            if (restore > 0) principal[o.filler] += restore;
            if (fee > 0) credit[o.filler] += fee;

            o.state = uint8(p.aborting ? ObligationState.Aborted : ObligationState.Settled);
            delete openFrontOf[o.filler][o.strategyId];
            // Release the un-commit block this leg placed on its beneficiary. EVERY path that resolves a leg
            // must do this: the hold is what keeps the beneficiary inside the folded committer set across the
            // bridge window, and a leg left holding it with no way to reach settlement occupies a slot in a
            // bounded set that nothing can then free. Safe to do before the residual is credited: no external
            // call runs in between, and any residual leaves live `composition`, on which the second un-commit
            // gate then bites.
            pendingFrontCredits[o.beneficiary][o.strategyId] -= 1;

            if (p.aborting) {
                emit Events.FrontObligationAborted(
                    address(this), o.strategyId, p.frontId, o.filler, restore, fee, o.redirected - restore
                );
            } else {
                emit Events.FrontObligationSettled(address(this), o.strategyId, p.frontId, o.filler, restore, fee);
            }
        }
    }
}
