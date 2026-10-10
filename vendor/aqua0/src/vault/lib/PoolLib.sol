// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { Strategy, Alloc } from "../../lib/Types.sol";
import { Errors } from "../../lib/Errors.sol";
import { Events } from "../../lib/Events.sol";
import { BoundedSetLib } from "./BoundedSetLib.sol";

/// @title PoolLib
/// @author Aqua0 Team
/// @notice Delegatecall-linked shared-pool sourcing math for `AssetVault`. Holds the pro-rata-by-room source
///         and return computation and the plain-storage effects (per-committer principal, per-strategy
///         deployed). There is no token ledger to keep: the shared pool mints nothing, so a per-strategy
///         position is derived from committed backing on read.
///         The three fund-safety require sites live HERE, in one legible place a reviewer reads to
///         confirm them:
///           amount <= availableIdle               shared-pool solvency (the single shared-idle underflow)
///           deployed + amount <= committedBacking  consent bound
///           draw <= room per committer             per-LP cap (deployedByLp <= principal by construction)
/// @dev NO STORAGE OF ITS OWN; the vault owns the storage and passes refs. Pool scalars (`sharedIdle` /
///      `totalDeployed`) are value-in / value-out because a plain state variable cannot be a storage-reference
///      parameter. Delegatecalled, so `msg.sender` / `address(this)` are the vault's.
library PoolLib {
    using SafeERC20 for IERC20;

    /// @dev Fixed-point scale (1e27) for the fee-per-share accumulator and swap reference price.
    uint256 internal constant RAY = 1e27;

    // ============================================================
    // Argument structs (stack-too-deep avoidance for the entrypoints)
    // ============================================================

    /// @dev Scalar args for `_source`. Struct-packed to dodge stack-too-deep in the delegatecall entrypoints.
    struct SourceState {
        // Strategy to source into.
        uint256 strategyId;
        // Principal to source from the committers' free room.
        uint256 amount;
        // Deployable shared idle (INV-GLOBAL gate: `amount <= availableIdle`).
        uint256 availableIdle;
        // Raw shared idle the source debits `amount` from.
        uint256 sharedIdle;
        // Pool-wide deployed counter the source credits `amount` to.
        uint256 totalDeployed;
    }

    /// @dev Scalar args for `deployIntoVenue` (source + measured egress in one call).
    struct DeployState {
        // Strategy to deploy for.
        uint256 strategyId;
        // Principal to source and push to the venue.
        uint256 amount;
        // Deployable shared idle at source time.
        uint256 availableIdle;
        // Raw shared idle to debit.
        uint256 sharedIdle;
        // Pool-wide deployed counter.
        uint256 totalDeployed;
        // Live-TVL meter (down by any short-delivery loss).
        uint256 vaultLiveTvl;
        // Underlying token moved to the venue.
        address asset;
        // Recipient whose balance delta measures what actually landed.
        address venue;
    }

    /// @dev Scalar args for `returnFromStrategy`.
    struct ReturnState {
        // Strategy the principal returns to.
        uint256 strategyId;
        // Principal that actually returned (measured, FOT-safe).
        uint256 received;
        // Pool-wide deployed counter to debit.
        uint256 totalDeployed;
        // Live-TVL meter (down by any final-close residual loss).
        uint256 vaultLiveTvl;
        // True fully unwinds the strategy and charges a short return as a realized loss.
        bool finalClose;
    }

    /// @dev Scalar args for `withdraw`.
    struct WithdrawState {
        // Amount to withdraw (from free principal first, then credit).
        uint256 assets;
        // Deployable shared idle bounding the payout.
        uint256 availableIdle;
        // Raw shared idle to debit.
        uint256 sharedIdle;
        // Live-TVL meter (down by principal actually leaving).
        uint256 vaultLiveTvl;
    }

    /// @dev Scalar args for `sellForSwap` (mid-swap OUT leg).
    struct SellState {
        // Strategy backing the sell.
        uint256 strategyId;
        // Asset to sell out of the committers' free principal.
        uint256 amount;
        // Deployable shared idle (INV-GLOBAL gate).
        uint256 availableIdle;
        // Raw shared idle to debit.
        uint256 sharedIdle;
        // Live-TVL meter (down by principal sold).
        uint256 vaultLiveTvl;
    }

    /// @dev Scalar args for `creditFromSwap` (mid-swap IN leg).
    struct CreditState {
        // Strategy the IN leg credits.
        uint256 strategyId;
        // Physical receipt bounding the credited proceeds + fee.
        uint256 received;
        // Amount the caller DECLARED it was sending, before any transfer fee. Equals `received` for a normal
        // token; exceeds it exactly by the skim for a fee-on-transfer one. The pair is what lets the credit
        // absorb a transfer fee proportionally instead of reverting - see `creditFromSwap`.
        uint256 declared;
        // RAY reference price valuing each LP's draw into proceeds.
        uint256 refPriceRay;
        // Bound on the committer address set (auto-commit cap).
        uint256 maxCommitters;
        // Bound on each LP's committed-strategy list.
        uint256 maxCommitments;
    }

    // ============================================================
    // Mid-swap net settlement (IN / OUT legs)
    // ============================================================

    /// @notice Credit a strategy's mid-swap IN leg to the sourcing committers named in `alloc`: each LP's
    ///         proceeds (`drawn * refPrice`) accrue as their `composition` in this vault, the spread over the
    ///         summed proceeds is the fee (credited pro-rata by draw), and each LP is auto-committed so the
    ///         conservation fold + redemption see them. `Σ proceeds <= received` bounds the credit to the
    ///         physical receipt, so a dishonest `refPrice` can never mint unbacked principal.
    /// @param composition Per-strategy, per-LP composition (swap-proceeds) ledger.
    /// @param strategyComposition Per-strategy composition aggregate (the conservation compare).
    /// @param credit Per-LP realized, withdrawable credit.
    /// @param committed Per-LP, per-strategy consent flag.
    /// @param committers The strategy's bounded committer address set.
    /// @param committerIndex Membership index for `committers`.
    /// @param committedLists Per-LP list of committed strategy ids.
    /// @param commitmentIndexes Membership index for each LP's committed list.
    /// @param alloc Who sourced how much on the OUT leg (drives proceeds + fee attribution).
    /// @param st Strategy id, reference price, received amount, and set-size bounds for this credit.
    /// @return fee Spread over summed proceeds, credited pro-rata by draw to the sourcing LPs.
    /// @return unallocated The part of `fee` no LP was credited with, which happens only when the allocation
    ///         names no draw at all. The caller reserves the whole `fee` either way, so this is the portion of
    ///         that reservation owed to nobody and therefore the only portion an operator may ever release.
    function creditFromSwap(
        mapping(uint256 => mapping(address => uint256)) storage composition,
        mapping(uint256 => uint256) storage strategyComposition,
        mapping(address => uint256) storage credit,
        mapping(address => mapping(uint256 => bool)) storage committed,
        address[] storage committers,
        mapping(address => uint256) storage committerIndex,
        mapping(address => uint256[]) storage committedLists,
        mapping(address => mapping(uint256 => uint256)) storage commitmentIndexes,
        Alloc[] calldata alloc,
        CreditState memory st
    ) external returns (uint256 fee, uint256 unallocated) {
        // First pass: value + book each sourcer's proceeds and auto-commit first-time sourcers.
        uint256 totalProceeds;
        uint256 totalDrawn;
        for (uint256 i; i < alloc.length; ++i) {
            if (alloc[i].drawn == 0) continue;
            address lp = alloc[i].lp;
            // Value this LP's OUT-leg draw at the reference price: `proceeds = drawn * refPrice / RAY`.
            uint256 proceeds = Math.mulDiv(alloc[i].drawn, st.refPriceRay, RAY);
            // Absorb a fee-on-transfer skim proportionally. The adapter prices against what IT measured, but
            // the vault's own pull is a SECOND transfer and skims again - an amount the adapter cannot know in
            // advance. Scaling by the observed `received/declared` ratio keeps every LP's share of the receipt
            // intact and lets the swap settle, where valuing the unskimmed amount would push the summed
            // proceeds past the physical receipt and revert the whole swap as `BackingCapExceeded` - an error
            // naming the wrong cause. For a normal token the ratio is exactly 1 and this is a no-op.
            //
            // This is a SCALE, not a cap: the backing-cap `require` below still runs on the scaled total, so a
            // dishonest `refPriceRay` is still rejected loudly rather than silently clamped to fit.
            if (st.received < st.declared) proceeds = Math.mulDiv(proceeds, st.received, st.declared);
            // Split the proceeds by fronting attribution, resolved on the SOURCING vault and carried here in
            // `Alloc` (see FrontObligationLib: the crediting vault holds no obligation state, so a lookup here
            // would resolve to nothing and the redirect would silently not fire). `redirected` accrues to the
            // beneficiary the filler stands in for; the remainder stays with the filler, so a filler keeps the
            // earnings on capital they never pledged. With no front open `beneficiary == lp` and
            // `redirected == 0`, so this reduces exactly to the previous single-credit behaviour.
            address beneficiary = alloc[i].beneficiary;
            uint256 toBeneficiary =
                alloc[i].redirected == 0 ? 0 : Math.mulDiv(proceeds, alloc[i].redirected, alloc[i].drawn);
            if (toBeneficiary > 0 && beneficiary != lp) {
                composition[st.strategyId][beneficiary] += toBeneficiary;
                _autoCommit(committed, committers, committerIndex, committedLists, commitmentIndexes, beneficiary, st);
            } else {
                toBeneficiary = 0;
            }
            composition[st.strategyId][lp] += proceeds - toBeneficiary;
            strategyComposition[st.strategyId] += proceeds;
            totalProceeds += proceeds;
            totalDrawn += alloc[i].drawn;
            // Auto-commit a first-time sourcing LP so the conservation fold + redemption see it.
            _autoCommit(committed, committers, committerIndex, committedLists, commitmentIndexes, lp, st);
        }
        // Backing cap: the priced proceeds must not exceed the physical receipt, so a dishonest `refPrice`
        // can never mint principal the vault did not actually receive.
        require(totalProceeds <= st.received, Errors.BackingCapExceeded(st.strategyId, totalProceeds, st.received));

        // The spread over the summed proceeds is the fee: credit it to the sourcing LPs pro-rata by draw.
        fee = st.received - totalProceeds;
        uint256 leftFee = fee;
        uint256 remDrawn = totalDrawn;
        for (uint256 i; i < alloc.length && leftFee > 0; ++i) {
            if (alloc[i].drawn == 0) continue;
            // Exact pro-rata: `share = leftFee * drawn / remDrawn` keeps `leftFee <= remDrawn` after each step,
            // so the last sourcer absorbs the flooring dust and `Σ share == fee` with no residue.
            uint256 share = Math.mulDiv(leftFee, alloc[i].drawn, remDrawn);
            remDrawn -= alloc[i].drawn;
            if (share > leftFee) share = leftFee;
            // The spread follows composition to the beneficiary, in the SAME ratio - a founder economic
            // decision: fillers earn a fixed fee and nothing else, and the beneficiary carries the inventory
            // risk that produced the spread. Splitting one and not the other would contradict that ruling in
            // exactly the partial-redirect case the cap exists to handle. Currently moves zero value, because
            // `alloc.drawn == amountOut` combined with `refPriceRay = received/amountOut` makes
            // `totalProceeds == received` identically, so `fee` is zero by construction on both venues today.
            if (alloc[i].redirected > 0 && alloc[i].beneficiary != alloc[i].lp && share > 0) {
                uint256 feeToBeneficiary = Math.mulDiv(share, alloc[i].redirected, alloc[i].drawn);
                if (feeToBeneficiary > 0) {
                    credit[alloc[i].beneficiary] += feeToBeneficiary;
                    emit Events.StrategyFeeAccrued(address(this), st.strategyId, alloc[i].beneficiary, feeToBeneficiary);
                    share -= feeToBeneficiary;
                    leftFee -= feeToBeneficiary;
                }
            }
            // Credit the fee share to the LP's realized, withdrawable credit bucket.
            credit[alloc[i].lp] += share;
            leftFee -= share;
            // Per-LP fee: the mid-swap spread credited to this sourcing LP (observable alongside the
            // deployed-fee crystallization emitted by `_accrue`).
            if (share > 0) emit Events.StrategyFeeAccrued(address(this), st.strategyId, alloc[i].lp, share);
        }
        // With any draw at all the pro-rata is exact and this is zero (the last sourcer absorbs the flooring
        // dust). It is non-zero only for an allocation that names no draw, where the whole spread is credited
        // to nobody. The caller tracks it so the reservation owed to nobody stays distinguishable from the
        // reservation owed to LPs.
        unallocated = leftFee;
    }

    /// @notice Reclassify `amount` of an LP's swap-proceeds `composition` as its own `principal`, in place.
    /// @dev No tokens move: the proceeds are ALREADY in this vault's `sharedIdle` (`settleVenueCredit` credited
    ///      the measured receipt there). This only moves the claim between two per-LP buckets, so the custody
    ///      bound `sharedIdle == balanceOf(vault)` is untouched and total claims are unchanged.
    ///
    ///      WHY THIS EXISTS: sourcing gates on FREE PRINCIPAL (`_free`, summed into `sellForSwap`'s
    ///      `totalRoom`), never on composition. Swap proceeds therefore satisfy the idle gate while
    ///      contributing ZERO sellable room, so an LP's remote-chain inventory sits inert and every remote fill
    ///      needs fronting again. The alternative route is `redeemComposition` followed by a fresh `deposit`,
    ///      which pays out and re-pulls the same tokens across two transactions AND can revert on
    ///      `_redeemableIdle()` exactly when capital is deployed, which is when an LP most needs to convert.
    ///
    ///      BACKING IS RELOCATED, NEVER MINTED. Composition only ever arises in `creditFromSwap`, from a swap
    ///      whose counter vault decremented an equal value of some LP's principal in `sellForSwap`. Converting
    ///      therefore moves backing between vaults rather than creating it, and `creditFromSwap` separately
    ///      caps the credited proceeds at the physical receipt, so no conversion can claim assets the vaults
    ///      do not hold. The consequence to know: `principal` gains a second writer, so per-vault
    ///      "backing <= that vault's deposits" no longer holds. Backing is bounded by `sharedIdle` and by the
    ///      fund-safety gates, which is the property that actually matters; do not reintroduce the old
    ///      shorthand and read this function as a bug.
    /// @param composition Per-strategy, per-LP composition (swap-proceeds) ledger.
    /// @param strategyComposition Per-strategy composition aggregate (the conservation compare).
    /// @param principal The vault's per-LP principal cap ledger.
    /// @param strategyId The strategy whose composition is converted.
    /// @param amount The composition amount to reclassify as principal.
    /// @param lp The composition holder; only its OWN holding is convertible.
    function convertComposition(
        mapping(uint256 => mapping(address => uint256)) storage composition,
        mapping(uint256 => uint256) storage strategyComposition,
        mapping(address => uint256) storage principal,
        uint256 strategyId,
        uint256 amount,
        address lp
    ) external {
        require(amount > 0, Errors.ZeroAmount());
        uint256 held = composition[strategyId][lp];
        require(amount <= held, Errors.ExceedsWithdrawable(lp, amount, held));

        // Decrement the holding FIRST so the same composition can never be converted twice, and move the
        // aggregate in lockstep: `assertConservation` folds composition over the committer set and compares it
        // to this aggregate, so a one-sided write desyncs the fold and bricks every later settle.
        composition[strategyId][lp] = held - amount;
        strategyComposition[strategyId] -= amount;
        principal[lp] += amount;
    }

    /// @dev Auto-commit an LP into a strategy's bounded sets, idempotently. Extracted so the sourcing LP and a
    ///      fronting beneficiary enter through ONE path: a beneficiary credited composition must appear in the
    ///      committer set or `assertConservation`'s fold over that set desyncs from `strategyComposition` and
    ///      bricks every later settle. Committing is not backing - it records consent-to-participate, while
    ///      `principal` is what makes capital sourceable, and a beneficiary's stays zero.
    function _autoCommit(
        mapping(address => mapping(uint256 => bool)) storage committed,
        address[] storage committers,
        mapping(address => uint256) storage committerIndex,
        mapping(address => uint256[]) storage committedLists,
        mapping(address => mapping(uint256 => uint256)) storage commitmentIndexes,
        address lp,
        CreditState memory st
    ) private {
        if (committed[lp][st.strategyId]) return;
        committed[lp][st.strategyId] = true;
        BoundedSetLib.addAddress(committers, committerIndex, lp, st.maxCommitters);
        BoundedSetLib.addUint(committedLists[lp], commitmentIndexes[lp], st.strategyId, st.maxCommitments);
    }

    /// @notice Sell `amount` of this vault's asset for a strategy's mid-swap OUT leg, sourcing it from the
    ///         committers' FREE principal (`principal - deployedByLp - frontHeld`) pro-rata by room. Reduces
    ///         each sold committer's principal + live exposure, returns the `Alloc[]` (who sold how much) for the
    ///         adapter to thread into the counter vault, and the updated pool scalars. INV-GLOBAL (`amount <=
    ///         availableIdle`) is enforced here so custody stays safe regardless of any downstream price.
    /// @param principal Per-LP principal cap ledger.
    /// @param deployedByLp Per-LP principal currently sourced out.
    /// @param frontHeldPrincipal Per-LP principal reserved by a cross-chain front.
    /// @param asyncHeld Per-LP principal escrowed by a pending async redeem.
    /// @param committers The strategy's committer set to source from.
    /// @param st Strategy id, sell amount, available idle, shared idle, and live-TVL for this OUT leg.
    /// @return alloc Per-committer sold amounts, threaded into the counter vault by the adapter.
    /// @return newSharedIdle Shared idle after the sell debit.
    /// @return newVaultLiveTvl Live-TVL meter after reducing each sold committer's principal.
    function sellForSwap(
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => uint256) storage frontHeldPrincipal,
        mapping(address => uint256) storage asyncHeld,
        address[] storage committers,
        SellState memory st
    ) external returns (Alloc[] memory alloc, uint256 newSharedIdle, uint256 newVaultLiveTvl) {
        // INV-GLOBAL gate: never sell more than the deployable shared idle, whatever the downstream price.
        require(st.amount <= st.availableIdle, Errors.InsufficientSharedIdle(st.amount, st.availableIdle));
        uint256 n = committers.length;
        // `alloc[i]` records what committer `i` sold; the adapter threads it into the counter vault.
        alloc = new Alloc[](n);
        newVaultLiveTvl = st.vaultLiveTvl;

        // First pass: total FREE room across the committer set (excludes deployed / front-held / async-escrowed).
        uint256 totalRoom;
        for (uint256 i; i < n; ++i) {
            totalRoom += _free(principal, deployedByLp, frontHeldPrincipal, asyncHeld, committers[i]);
        }
        // Backing must physically cover the sell, else there is no free principal to source it from.
        require(
            totalRoom >= st.amount,
            Errors.RanOutOfBacking(st.strategyId, st.amount > totalRoom ? st.amount - totalRoom : 0)
        );

        // Second pass: exact single-pass pro-rata by room; every `draw <= room` so principal never underflows.
        uint256 left = st.amount;
        uint256 remRoom = totalRoom;
        for (uint256 i; i < n && left > 0; ++i) {
            address lp = committers[i];
            uint256 room = _free(principal, deployedByLp, frontHeldPrincipal, asyncHeld, lp);
            // Fully-encumbered committers contribute nothing to sell from.
            if (room == 0) continue;
            uint256 draw;
            (draw, left, remRoom) = _clampedShare(left, room, remRoom);
            if (draw > 0) {
                // Reduce the sold LP's principal cap + its live exposure; record who sold how much.
                principal[lp] -= draw;
                newVaultLiveTvl = newVaultLiveTvl > draw ? newVaultLiveTvl - draw : 0;
                alloc[i] = Alloc(lp, draw, lp, 0);
                // Announce the per-LP debit. Nothing else names the LP here, so without this the
                // sale is invisible off-chain and an indexed balance drifts above the vault's.
                emit Events.StrategyPrincipalSold(address(this), st.strategyId, lp, draw);
            }
        }
        // The pro-rata must fully cover `amount` (room was checked >= amount above); a residue is a bug.
        require(left == 0, Errors.RanOutOfBacking(st.strategyId, left));
        // Debit shared idle by the sold amount; the counter leg lands later via `creditFromSwap`.
        newSharedIdle = st.sharedIdle - st.amount;
    }

    /// @notice One member's clamped pro-rata share of `left`, weighted by `weight` out of `remWeight`, with the
    ///         loop scalars advanced. The single source for the in-library single-pass pro-rata splits (source /
    ///         sell / return / deploy-shortfall), each of which walks a set advancing `remWeight` by the current
    ///         member's `weight` and `left` by the taken `share`.
    /// @dev `share = mulDiv(left, weight, remWeight)`, clamped to `min(weight, left)`. Both clamps are inert
    ///      under the loop invariant (`left <= remWeight` and `weight <= remWeight`, so `mulDiv <= min(weight,
    ///      left)`), but kept so a member off the invariant path can never over-draw itself or over-distribute
    ///      the remainder. `newRemWeight = remWeight - weight` cannot underflow: `weight` is one addend of the
    ///      `remWeight` sum the caller maintains. Proven byte-equivalent to the inline sites it replaces by
    ///      `testFuzz_clampedShare_equivalence` and symbolically by the halmos `_clampedShare` check.
    /// @param left Remaining amount still to distribute across the set.
    /// @param weight This member's weight (free room / participation / sourced draw).
    /// @param remWeight Remaining total weight, the pro-rata denominator (>= weight).
    /// @return share This member's clamped pro-rata share, `<= min(weight, left)`.
    /// @return newLeft `left` after taking `share` (never underflows: `share <= left`).
    /// @return newRemWeight `remWeight` after removing this member's `weight`.
    function _clampedShare(uint256 left, uint256 weight, uint256 remWeight)
        internal
        pure
        returns (uint256 share, uint256 newLeft, uint256 newRemWeight)
    {
        share = Math.mulDiv(left, weight, remWeight);
        newRemWeight = remWeight - weight;
        if (share > weight) share = weight;
        if (share > left) share = left;
        newLeft = left - share;
    }

    /// @dev An LP's free (unencumbered) principal - MUST match `AssetVault.freePrincipal`. The async escrow
    ///      (`asyncHeld`) and the deployed principal (`deployedByLp`) target the same principal, so they combine
    ///      as a `max`; the fronting hold (`frontHeld`) is additive. Both a committed-ship deploy and a mid-swap
    ///      sell source from THIS, so a front-reserved or async-reserved principal can never be sourced.
    /// @param principal The vault's per-LP principal ledger.
    /// @param deployedByLp The vault's per-LP deployed-principal ledger.
    /// @param frontHeldPrincipal The vault's per-LP fronting-hold ledger (additive reservation).
    /// @param asyncHeld The vault's per-LP async-redeem escrow ledger (shares the principal with `deployedByLp`).
    /// @param lp The LP whose free principal is computed.
    /// @return The LP's unencumbered principal (`principal - max(deployed, async) - frontHeld`, floored at 0).
    function _free(
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => uint256) storage frontHeldPrincipal,
        mapping(address => uint256) storage asyncHeld,
        address lp
    ) private view returns (uint256) {
        // `deployed` and `async` target the same principal, so take the max, not the sum (double-counting them
        // would over-encumber and under-report free room). The front hold is a separate reservation, so add it.
        uint256 deployedOrHeld = deployedByLp[lp] > asyncHeld[lp] ? deployedByLp[lp] : asyncHeld[lp];
        uint256 encumbered = deployedOrHeld + frontHeldPrincipal[lp];
        // Saturating: an over-encumbered LP (never expected) reports 0 free rather than underflowing.
        return principal[lp] > encumbered ? principal[lp] - encumbered : 0;
    }

    /// @dev Scalar args for `setCommitment` (consent-toggle bounds).
    struct SetRefs {
        // Strategy whose consent flag toggles.
        uint256 strategyId;
        // Bound on the strategy's committer address set.
        uint256 maxCommitters;
        // Bound on the LP's committed-strategy list.
        uint256 maxCommitments;
    }

    // ============================================================
    // Consent / backing (commit, derived backing)
    // ============================================================

    /// @notice Set (backing) or clear a non-subtractive commitment of `lp`'s principal for a strategy. Backing
    ///         is DERIVED (Σ current principal over the committer set), so there is nothing to snapshot: this
    ///         just toggles the consent flag and the two bounded membership sets. Un-commit is blocked while the
    ///         LP has capital sourced into the strategy; the consent bound (deployed <= backing) is then
    ///         preserved automatically because an uncommitting LP contributes 0 to `deployed`.
    /// @param strategies The vault's strategy registry (existence check).
    /// @param committed Per-LP, per-strategy consent flag.
    /// @param deployedInto Per-LP, per-strategy sourced principal (blocks un-commit while non-zero).
    /// @param composition Per-strategy, per-LP cross-vault swap composition (blocks un-commit while non-zero
    ///        too: `_assertStrategyConservation` only folds `composition` over CURRENT committers, so
    ///        removing an LP with a live composition balance would permanently desync
    ///        `Σ composition != strategyComposition` and brick every future settle on the strategy).
    /// @param pendingFrontCredits Per-LP, per-strategy count of unsettled cross-chain fronts naming the LP as
    ///        beneficiary (blocks un-commit too: the landing credits their composition, and leaving the
    ///        committer set first strands it outside the fold and bricks every later capital op).
    /// @param committers The strategy's bounded committer set.
    /// @param committerIndex Membership index for `committers`.
    /// @param committedList The LP's list of committed strategy ids.
    /// @param commitmentIndex Membership index for `committedList`.
    /// @param lp The LP toggling consent.
    /// @param backing True to add backing, false to clear it.
    /// @param r Strategy id and the two bounded set-size caps.
    function setCommitment(
        mapping(uint256 => Strategy) storage strategies,
        mapping(address => mapping(uint256 => bool)) storage committed,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        mapping(uint256 => mapping(address => uint256)) storage composition,
        mapping(address => mapping(uint256 => uint256)) storage pendingFrontCredits,
        address[] storage committers,
        mapping(address => uint256) storage committerIndex,
        uint256[] storage committedList,
        mapping(uint256 => uint256) storage commitmentIndex,
        address lp,
        bool backing,
        SetRefs memory r
    ) external {
        // Consent can only be toggled for a registered strategy.
        require(strategies[r.strategyId].exists, Errors.ClassNotRegistered(r.strategyId));

        if (backing) {
            // Idempotent add: a repeated commit is a no-op (the bounded sets stay single-entry per LP).
            if (committed[lp][r.strategyId]) return;
            committed[lp][r.strategyId] = true;
            // Add to both bounded sets (the strategy's committer set and the LP's committed-strategy list).
            BoundedSetLib.addAddress(committers, committerIndex, lp, r.maxCommitters);
            BoundedSetLib.addUint(committedList, commitmentIndex, r.strategyId, r.maxCommitments);
        } else {
            // Idempotent clear: nothing to do if the LP was not committed.
            if (!committed[lp][r.strategyId]) return;
            // Un-commit is blocked while the LP still has capital sourced here, so the consent bound
            // (deployed <= backing) is preserved: an uncommitting LP contributes 0 to `deployed`.
            uint256 di = deployedInto[lp][r.strategyId];
            require(di == 0, Errors.CannotUncommitLiveCapital(r.strategyId, lp, di));
            // Un-commit is ALSO blocked while the LP still holds live cross-vault swap composition: the LP
            // redeems it via `redeemComposition` first (always available, whenNotPaused), the same
            // self-service escape hatch `deployedInto` already relies on above.
            uint256 comp = composition[r.strategyId][lp];
            require(comp == 0, Errors.CannotUncommitLiveComposition(r.strategyId, lp, comp));
            // Un-commit is ALSO blocked while an unsettled front names this LP as beneficiary. Both gates above
            // read REALISED state, which is still zero across the whole bridge window: the beneficiary is
            // committed at open precisely because the landing must be bookable, and the landing credits
            // composition. Leaving the set in between puts that composition outside the index set conservation
            // folds over. Unlike the two gates above, the release is the front settling rather than an LP
            // action; a beneficiary that wants no exposure meanwhile withdraws free principal, which backing
            // derives from and which commitment does not gate, so this holds consent open, not capital.
            uint256 pendingFronts = pendingFrontCredits[lp][r.strategyId];
            require(pendingFronts == 0, Errors.CannotUncommitPendingFront(r.strategyId, lp, pendingFronts));
            committed[lp][r.strategyId] = false;
            BoundedSetLib.removeAddress(committers, committerIndex, lp);
            BoundedSetLib.removeUint(committedList, commitmentIndex, r.strategyId);
        }
        // Emit the toggle so the indexer tracks the strategy's committer set from events.
        emit Events.StrategyCommitmentSet(address(this), lp, r.strategyId, backing);
    }

    /// @notice Derived backing ceiling for a strategy: the sum of its committers' current principal. Bounded by
    ///         the committer set. Deposits after commit are counted automatically (no snapshot footgun).
    /// @param principal Per-LP principal cap ledger.
    /// @param committers The strategy's committer set to sum over.
    /// @return backing Sum of the committers' current principal.
    function committedBacking(mapping(address => uint256) storage principal, address[] storage committers)
        public
        view
        returns (uint256 backing)
    {
        // Derived live, never snapshotted: a deposit after commit raises backing automatically, and a
        // withdraw lowers it, with no per-strategy maintenance. The set is bounded (BoundedSetLib caps it).
        for (uint256 i; i < committers.length; ++i) {
            backing += principal[committers[i]];
        }
    }

    // ============================================================
    // Withdraw (free principal, then credit)
    // ============================================================

    /// @notice Withdraw from the shared pool, drawn from `owner`'s free principal first, then realized credit.
    ///         Only the owner moves their principal. Backing is derived from current principal, so lowering it
    ///         needs no per-strategy maintenance: the consent bound (deployed <= backing) survives because a
    ///         withdraw can only draw FREE principal, leaving `principal >= deployedByLp >= any deployedInto`.
    ///         Releases live-TVL exposure and transfers. Returns the updated pool scalars to write back.
    /// @param principal Per-LP principal cap ledger.
    /// @param deployedByLp Per-LP principal currently sourced out.
    /// @param frontHeldPrincipal Per-LP principal reserved by a cross-chain front.
    /// @param asyncHeld Per-LP principal escrowed by a pending async redeem.
    /// @param credit Per-LP realized, withdrawable credit (drawn after free principal).
    /// @param receiver Account paid the withdrawn assets.
    /// @param owner The LP whose principal/credit is drawn (must equal `msg.sender`).
    /// @param asset The underlying token transferred out.
    /// @param ws Withdraw amount, available idle, shared idle, and live-TVL for this call.
    /// @return newSharedIdle Shared idle after the withdraw.
    /// @return newVaultLiveTvl Live-TVL meter after the withdraw (down by principal actually leaving).
    /// @return fromCredit Portion paid from realized credit (the segregated fee bucket).
    function withdraw(
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => uint256) storage frontHeldPrincipal,
        mapping(address => uint256) storage asyncHeld,
        mapping(address => uint256) storage credit,
        address receiver,
        address owner,
        address asset,
        WithdrawState memory ws
    ) external returns (uint256 newSharedIdle, uint256 newVaultLiveTvl, uint256 fromCredit) {
        // Only the principal owner may move their own principal (no delegated withdraw).
        require(msg.sender == owner, Errors.PrincipalUnauthorized(msg.sender, owner));
        // Draw only TRULY-free principal: the SAME `_free` the source/sell paths use, so a locked front's hold
        // (`frontHeld`) and a pending async redeem's escrow (`asyncHeld`) cannot be withdrawn out from under
        // them. Using `principal - deployedByLp` here let an LP withdraw front-locked principal and then commit
        // a front against another LP's idle that could never release (a shared-idle freeze).
        uint256 free = _free(principal, deployedByLp, frontHeldPrincipal, asyncHeld, owner);
        // Payout ceiling: the owner's free principal plus its realized credit.
        uint256 payable_ = free + credit[owner];
        require(ws.assets <= payable_, Errors.ExceedsWithdrawable(owner, ws.assets, payable_));
        // INV-GLOBAL gate: the payout must fit deployable shared idle.
        require(ws.assets <= ws.availableIdle, Errors.InsufficientSharedIdle(ws.assets, ws.availableIdle));

        // Draw free principal first, then dip into credit for the remainder.
        uint256 fromPrincipal = ws.assets < free ? ws.assets : free;
        fromCredit = ws.assets - fromPrincipal;

        principal[owner] -= fromPrincipal;
        credit[owner] -= fromCredit;
        newSharedIdle = ws.sharedIdle - ws.assets;

        // Live-TVL meter drops by the principal actually leaving the vault (credit is already outside the meter).
        newVaultLiveTvl = ws.vaultLiveTvl > fromPrincipal ? ws.vaultLiveTvl - fromPrincipal : 0;

        IERC20(asset).safeTransfer(receiver, ws.assets);
        emit Events.VaultWithdraw(address(this), msg.sender, owner, receiver, ws.assets, fromPrincipal, fromCredit);
    }

    // ============================================================
    // Committed deploy (source + measured egress, loss charging)
    // ============================================================

    /// @notice Source `amount` of shared idle into a strategy, pro-rata by available room across its committers.
    ///         Writes the per-committer and per-strategy principal and crystallizes each sourced committer's
    ///         accrued fee (via `deployedInto`, their actual participation) before their participation changes.
    ///         Returns the updated pool scalars. No shares are minted: the per-strategy position is a read-only
    ///         view over the committed backing.
    /// @param strategies The vault's strategy registry (reads/writes the strategy's `deployed`).
    /// @param principal Per-LP principal cap ledger.
    /// @param deployedByLp Per-LP principal currently sourced out.
    /// @param deployedInto Per-LP, per-strategy sourced principal (actual participation).
    /// @param credit Per-LP realized credit (crystallized before participation changes).
    /// @param feeCheckpointRay Per-LP, per-strategy fee accumulator checkpoint.
    /// @param frontHeld Per-LP principal reserved by a cross-chain front.
    /// @param asyncHeld Per-LP principal escrowed by a pending async redeem.
    /// @param committers The strategy's committer set to source from.
    /// @param st Strategy id, source amount, available idle, shared idle, and total deployed.
    /// @return alloc Per-committer sourced split (drives egress-shortfall attribution).
    /// @return newSharedIdle Shared idle after the source debit.
    /// @return newTotalDeployed Total deployed after crediting the sourced principal.
    function _source(
        mapping(uint256 => Strategy) storage strategies,
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        mapping(address => uint256) storage credit,
        mapping(address => mapping(uint256 => uint256)) storage feeCheckpointRay,
        mapping(address => uint256) storage frontHeld,
        mapping(address => uint256) storage asyncHeld,
        address[] storage committers,
        SourceState memory st
    ) internal returns (Alloc[] memory alloc, uint256 newSharedIdle, uint256 newTotalDeployed) {
        // INV-GLOBAL gate (fund-safety require #1): never source more than the deployable shared idle.
        require(st.amount <= st.availableIdle, Errors.InsufficientSharedIdle(st.amount, st.availableIdle));
        // Caller guarantees the strategy exists; no existence check here (this is an internal source path).
        Strategy storage s = strategies[st.strategyId];
        // Snapshot the fee accumulator once; every committer accrues against this same `fps` in this call.
        uint256 fps = s.feePerShareRay;
        uint256 n = committers.length;
        // Per-committer sourced split (who funded how much of THIS deploy). Returned so `deployCapital` can charge
        // a fee-on-transfer / rebase egress shortfall back to exactly these committers, in these proportions.
        alloc = new Alloc[](n);

        // One pass computes both the derived backing ceiling (Σ current principal) and the available room
        // (Σ free principal - excludes deployed / front-held / async-escrowed principal).
        uint256 backing;
        uint256 totalRoom;
        for (uint256 i; i < n; ++i) {
            address c = committers[i];
            // `backing` is the consent ceiling (Σ principal); `totalRoom` is what is physically drawable now.
            backing += principal[c];
            totalRoom += _free(principal, deployedByLp, frontHeld, asyncHeld, c);
        }
        // Consent bound (fund-safety require #2): a strategy can never have more deployed than its derived
        // backing (Σ current principal over the committers who consented). Checked against the POST-source
        // total (`s.deployed + amount`) so a source can never push deployed past backing.
        require(
            s.deployed + st.amount <= backing, Errors.BackingCapExceeded(st.strategyId, s.deployed + st.amount, backing)
        );
        // And the free room must actually cover the source, else there is nothing physically to draw.
        require(
            totalRoom >= st.amount,
            Errors.RanOutOfBacking(st.strategyId, st.amount > totalRoom ? st.amount - totalRoom : 0)
        );

        // Exact single-pass pro-rata: draw = left * room / remainingRoom keeps `left <= remainingRoom` after
        // every step, so the last committer with room absorbs the flooring dust and every draw <= its room.
        uint256 left = st.amount;
        uint256 remRoom = totalRoom;
        for (uint256 i; i < n && left > 0; ++i) {
            address lp = committers[i];
            uint256 room = _free(principal, deployedByLp, frontHeld, asyncHeld, lp);
            // Fully-encumbered committers contribute nothing to source from.
            if (room == 0) continue;
            // Per-committer cap (fund-safety require #3): `draw <= room` (clamped in `_clampedShare`) so
            // `deployedByLp[lp]` never exceeds `principal[lp]`.
            uint256 draw;
            (draw, left, remRoom) = _clampedShare(left, room, remRoom);
            if (draw > 0) {
                // Crystallize the LP's fee at the current accumulator BEFORE its participation grows.
                _accrue(credit, feeCheckpointRay, deployedInto, lp, st.strategyId, fps);
                deployedByLp[lp] += draw;
                deployedInto[lp][st.strategyId] += draw;
                alloc[i] = Alloc(lp, draw, lp, 0);
                emit Events.StrategyCapitalSourced(address(this), st.strategyId, lp, draw);
            }
        }
        // Exact-pro-rata guarantee: the loop must have fully sourced `amount`; a residue is a bug.
        require(left == 0, Errors.RanOutOfBacking(st.strategyId, left));

        // Book the source: strategy + pool deployed rise by `amount`, shared idle falls by the same.
        s.deployed += st.amount;
        newSharedIdle = st.sharedIdle - st.amount;
        newTotalDeployed = st.totalDeployed + st.amount;
    }

    /// @notice Return up to `received` of a strategy's sourced principal to its committers, pro-rata by their
    ///         current participation, crystallizing each returned committer's accrued fee first. A surplus over
    ///         `deployed` is a realized gain, booked HERE (bumping feePerShareRay, or routed to pnlPool when
    ///         nothing is deployed) before the fee snapshot; the vault locks the matching `segregatedDelta` into
    ///         `segregatedFees` on return. On a signalled FINAL close (`st.finalClose`) where the return came up
    ///         short (`received < deployed`), the leftover
    ///         `deployed` is charged as a realized loss (`_chargeResidual`) so the position fully unwinds and no
    ///         committer is trapped; on a PARTIAL return the residual is left as legitimately-still-deployed.
    ///         Returns the updated pool scalars.
    /// @param strategies The vault's strategy registry (reads/writes the strategy's `deployed`).
    /// @param principal Per-LP principal cap ledger.
    /// @param deployedByLp Per-LP principal currently sourced out.
    /// @param deployedInto Per-LP, per-strategy sourced principal (drives the pro-rata return).
    /// @param credit Per-LP realized credit (crystallized before participation changes).
    /// @param feeCheckpointRay Per-LP, per-strategy fee accumulator checkpoint.
    /// @param committers The strategy's committer set to return to.
    /// @param st Strategy id, received amount, final-close flag, total deployed, and live-TVL.
    /// @return newTotalDeployed Total deployed after applying the return (and any residual loss).
    /// @return newVaultLiveTvl Live-TVL meter after the return (down by any charged residual loss).
    /// @return segregatedDelta The surplus the vault adds to `segregatedFees` (non-zero only when `deployed > 0`).
    function returnFromStrategy(
        mapping(uint256 => Strategy) storage strategies,
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        mapping(address => uint256) storage credit,
        mapping(address => mapping(uint256 => uint256)) storage feeCheckpointRay,
        address[] storage committers,
        ReturnState memory st
    ) external returns (uint256 newTotalDeployed, uint256 newVaultLiveTvl, uint256 segregatedDelta) {
        Strategy storage s = strategies[st.strategyId];
        uint256 deployed = s.deployed;
        // Book the surplus over `deployed` (a realized GAIN) to the strategy's holders BEFORE snapshotting the
        // fee accumulator, so the return below crystallizes it to the returning committers. With nothing
        // deployed the surplus lands in `pnlPool` (orphaned; cross-vault attribution is later-scoped, not claimable
        // via `credit` today) and mints no segregated idle; with `deployed > 0` it bumps the per-share
        // accumulator and the vault locks the same amount into `segregatedFees` on return (the "measured surplus
        // books credit AND raises segregatedFees in lockstep" invariant). The vault gates this path behind vault
        // + strategy pause BEFORE calling (a gain up-mark is pause-gated).
        if (st.received > deployed) {
            uint256 surplus = st.received - deployed;
            if (deployed == 0) {
                s.pnlPool += int256(surplus);
            } else {
                s.feePerShareRay += Math.mulDiv(surplus, RAY, deployed);
                segregatedDelta = surplus;
            }
        }
        // Snapshot the fee accumulator (now including any surplus bump) and outstanding deployed before the
        // return mutates participation.
        uint256 fps = s.feePerShareRay;
        // Only principal is returned here; the surplus over `deployed` was booked as the fee just above, so cap
        // the applied amount at the outstanding deployed principal.
        uint256 applied = st.received < deployed ? st.received : deployed;
        newTotalDeployed = st.totalDeployed;
        newVaultLiveTvl = st.vaultLiveTvl;
        // Nothing outstanding to return (or a pure-fee return): leave the scalars unchanged.
        if (applied == 0) return (newTotalDeployed, newVaultLiveTvl, segregatedDelta);

        // Return pro-rata by each committer's CURRENT participation (`deployedInto`), crystallizing fees first.
        // `remDeployed` tracks the un-returned participation so the pro-rata denominator shrinks exactly.
        uint256 left = applied;
        uint256 remDeployed = deployed;
        uint256 n = committers.length;
        for (uint256 i; i < n && left > 0; ++i) {
            address lp = committers[i];
            uint256 di = deployedInto[lp][st.strategyId];
            // Skip committers with no live participation in this strategy (nothing to return to them).
            if (di == 0) continue;
            // Exact pro-rata: `red = left * di / remDeployed`; the last participant absorbs the flooring dust.
            uint256 red;
            (red, left, remDeployed) = _clampedShare(left, di, remDeployed);
            if (red > 0) {
                // Crystallize the LP's accrued fee BEFORE its participation shrinks.
                _accrue(credit, feeCheckpointRay, deployedInto, lp, st.strategyId, fps);
                deployedByLp[lp] -= red;
                deployedInto[lp][st.strategyId] -= red;
                // Per-LP mirror of StrategyCapitalSourced: the indexer reconstructs the unwind from events
                // instead of replaying this pro-rata loop (the committer order is swap-and-pop, not inferable).
                emit Events.StrategyCapitalReturned(address(this), st.strategyId, lp, red);
            }
        }
        // The applied return must be fully attributed across the participants; a residue is a bug.
        require(left == 0, Errors.RanOutOfBacking(st.strategyId, left));

        // Book the returned principal down. Any leftover `s.deployed` here is the un-returned remainder.
        s.deployed -= applied;
        newTotalDeployed = st.totalDeployed - applied;

        // FINAL close that came up short: the leftover `s.deployed` (== deployed - received) is unrecoverable
        // (fee-on-transfer return skim, or a realized trading loss). Charge it as a loss and fully unwind.
        // A PARTIAL return skips this: its residual is still legitimately deployed and recoverable at the venue.
        if (st.finalClose && s.deployed > 0) {
            // Drop the pool deployed counter by the residual too, before charging it per-committer.
            newTotalDeployed -= s.deployed;
            newVaultLiveTvl = _chargeResidual(
                strategies, principal, deployedByLp, deployedInto, committers, st.strategyId, newVaultLiveTvl
            );
        }
    }

    /// @notice Charge a strategy's leftover `deployed` (after a short FINAL-close return) as a realized loss to
    ///         its committers pro-rata. Each committer's LEFTOVER `deployedInto` is exactly its pro-rata share of
    ///         the residual, so this zeroes `deployedInto` and debits `principal`/`deployedByLp` by that share,
    ///         and `s.deployed -> 0`. The strategy fully winds down; no committer is trapped.
    /// @dev Only reached on a FULL close, never a partial (a partial's residual is recoverable at the venue, not
    ///      a loss). Per-LP cap survives: `deployedByLp` and `principal` drop by the same `loss`. Conservation is
    ///      exact: `Σ leftover deployedInto == s.deployed` (the return loop is exact-pro-rata), so the charges
    ///      zero `s.deployed` exactly. No re-`_accrue`: the return just crystallized fees at the unchanged
    ///      `feePerShareRay` in this same call.
    /// @param strategies The vault's strategy registry (zeroes the strategy's `deployed`).
    /// @param principal Per-LP principal cap ledger (debited by each committer's residual share).
    /// @param deployedByLp Per-LP principal currently sourced out (debited by the same share).
    /// @param deployedInto Per-LP, per-strategy sourced principal (zeroed here).
    /// @param committers The strategy's committer set to charge.
    /// @param strategyId The strategy being fully wound down.
    /// @param vaultLiveTvl Live-TVL meter before charging the residual loss.
    /// @return newVaultLiveTvl Live-TVL meter after charging the residual loss to each committer.
    function _chargeResidual(
        mapping(uint256 => Strategy) storage strategies,
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        address[] storage committers,
        uint256 strategyId,
        uint256 vaultLiveTvl
    ) internal returns (uint256 newVaultLiveTvl) {
        newVaultLiveTvl = vaultLiveTvl;
        // Walk every committer once, charging exactly its residual participation as a realized loss.
        uint256 n = committers.length;
        for (uint256 i; i < n; ++i) {
            address lp = committers[i];
            // Each committer's LEFTOVER participation IS its pro-rata share of the residual (the return loop
            // was exact-pro-rata), so charge exactly that as the loss and zero the participation.
            uint256 loss = deployedInto[lp][strategyId];
            if (loss == 0) continue;
            // Both sides drop by the same `loss`, so the per-LP cap (`deployedByLp <= principal`) survives.
            principal[lp] -= loss;
            deployedByLp[lp] -= loss;
            deployedInto[lp][strategyId] = 0;
            newVaultLiveTvl = newVaultLiveTvl > loss ? newVaultLiveTvl - loss : 0;
            emit Events.StrategyReturnLoss(address(this), strategyId, lp, loss);
        }
        // `Σ leftover deployedInto == s.deployed`, so this zeroes the strategy's deployed exactly.
        strategies[strategyId].deployed = 0;
    }

    /// @notice The whole `deployCapital` capital motion in ONE call: SOURCE `amount` from the strategy's
    ///         committers' free principal (pro-rata by room), then the EGRESS leg - transfer the sourced `amount`
    ///         to the venue, MEASURE what landed, and book what the venue actually received. Returns
    ///         `booked = min(amount, delivered)` (never inflate `deployed` above what was sourced - a
    ///         positive-rebase surplus stays at the venue and returns later as a gain), plus the updated pool
    ///         scalars. On a short delivery it charges the shortfall as a realized loss to exactly the committers
    ///         who sourced this deploy, pro-rata (`_chargeShortfall`).
    /// @dev Runs by delegatecall in the vault's context, so `address(this)` is the vault: the transfer moves the
    ///      vault's asset and `balanceOf(venue)` measures the landing. `sharedIdle` is decremented by the source
    ///      (by the full `amount`) and NOT touched again by the egress - the tokens left the vault on the
    ///      transfer, so INV-GLOBAL (`sharedIdle == balanceOf`) holds with both down by `amount`. Folding source +
    ///      egress into one external entrypoint keeps the beacon-impl `AssetVault` lean (one call site, not two).
    /// @param strategies The vault's per-strategy config ledger (committer set, composition, backing).
    /// @param principal The vault's per-LP principal ledger.
    /// @param deployedByLp The vault's per-LP deployed-principal ledger.
    /// @param deployedInto The vault's per-LP, per-strategy deployed-amount ledger.
    /// @param credit The vault's per-LP swap-proceeds credit ledger.
    /// @param feeCheckpointRay The vault's per-LP, per-strategy fee-checkpoint (ray) ledger.
    /// @param frontHeld The vault's per-LP fronting-hold ledger.
    /// @param asyncHeld The vault's per-LP async-redeem escrow ledger.
    /// @param committers The strategy's committer address list (iterated for pro-rata sourcing).
    /// @param st The deploy inputs (strategy id, venue, amount, and current pool scalars) for this motion.
    /// @return booked Principal booked as deployed, `min(amount, delivered)` (never above what was sourced).
    /// @return newSharedIdle Shared idle after the source debit (down by the full sourced `amount`).
    /// @return newTotalDeployed Total deployed after crediting the booked principal.
    /// @return newVaultLiveTvl Live-TVL meter after the deploy (down by any shortfall charged as a realized loss).
    function deployIntoVenue(
        mapping(uint256 => Strategy) storage strategies,
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        mapping(address => uint256) storage credit,
        mapping(address => mapping(uint256 => uint256)) storage feeCheckpointRay,
        mapping(address => uint256) storage frontHeld,
        mapping(address => uint256) storage asyncHeld,
        address[] storage committers,
        DeployState memory st
    ) external returns (uint256 booked, uint256 newSharedIdle, uint256 newTotalDeployed, uint256 newVaultLiveTvl) {
        // Leg 1: source the principal from the committers (debits shared idle by the full `amount`).
        Alloc[] memory sourced;
        (sourced, newSharedIdle, newTotalDeployed) = _source(
            strategies,
            principal,
            deployedByLp,
            deployedInto,
            credit,
            feeCheckpointRay,
            frontHeld,
            asyncHeld,
            committers,
            SourceState(st.strategyId, st.amount, st.availableIdle, st.sharedIdle, st.totalDeployed)
        );

        // Leg 2: measure-what-landed egress. Read the venue balance before/after so a fee-on-transfer or
        // rebasing asset books `delivered` (what physically arrived), never the nominal `amount`.
        uint256 beforeBal = IERC20(st.asset).balanceOf(st.venue);
        IERC20(st.asset).safeTransfer(st.venue, st.amount);
        // `delivered` is the measured landing; the tokens already left the vault, so shared idle is NOT
        // touched again here (INV-GLOBAL `sharedIdle == balanceOf` holds with both down by `amount`).
        uint256 delivered = IERC20(st.asset).balanceOf(st.venue) - beforeBal;
        newVaultLiveTvl = st.vaultLiveTvl;
        if (delivered >= st.amount) {
            // Normal or positive rebase: book the sourced amount, no loss (a surplus returns later as a gain).
            return (st.amount, newSharedIdle, newTotalDeployed, newVaultLiveTvl);
        }
        // Short delivery: book only what landed and charge the shortfall to the exact sourcers, pro-rata.
        booked = delivered;
        newVaultLiveTvl =
            _chargeShortfall(strategies, principal, deployedByLp, deployedInto, sourced, st, st.amount - delivered);
    }

    /// @notice Charge a deploy egress shortfall as a realized loss to exactly the committers who sourced this
    ///         deploy, pro-rata. Reduces each charged committer's `principal`, `deployedByLp`, and `deployedInto`
    ///         by its pro-rata share, and the strategy's `deployed` by the full shortfall, so `deployed` ends
    ///         equal to what the venue received (`delivered`).
    /// @dev No re-`_accrue`: `feePerShareRay` cannot have moved since `_source` crystallized each
    ///      committer's fee in this same nonReentrant call, so a re-accrue would be a no-op at the unchanged
    ///      checkpoint. The pro-rata mirrors `_source` (`charge = left * drawn / remDrawn`): `left`
    ///      reaches 0 exactly and the last charged committer absorbs the flooring dust, so `Σ charge == shortfall`
    ///      and no phantom principal remains. Loss containment: each `charge <= drawn <= principal - deployedByLp`
    ///      at source time, so principal never underflows and the per-LP cap survives (both sides drop by `charge`).
    /// @param strategies The vault's strategy registry (reduces the strategy's `deployed` by the shortfall).
    /// @param principal Per-LP principal cap ledger (debited by each sourcer's pro-rata share).
    /// @param deployedByLp Per-LP principal currently sourced out (debited by the same share).
    /// @param deployedInto Per-LP, per-strategy sourced principal (debited by the same share).
    /// @param sourced Per-committer sourced split from `_source` (drives the pro-rata charge).
    /// @param st Deploy context (strategy id, amount, live-TVL) for this egress.
    /// @param shortfall Amount the venue received below the sourced amount, charged as a realized loss.
    /// @return newVaultLiveTvl Live-TVL meter after charging the shortfall to each sourcer.
    function _chargeShortfall(
        mapping(uint256 => Strategy) storage strategies,
        mapping(address => uint256) storage principal,
        mapping(address => uint256) storage deployedByLp,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        Alloc[] memory sourced,
        DeployState memory st,
        uint256 shortfall
    ) internal returns (uint256 newVaultLiveTvl) {
        newVaultLiveTvl = st.vaultLiveTvl;
        // Distribute the `shortfall` loss over the SAME `sourced` split `_source` returned, in the same shares.
        uint256 left = shortfall;
        uint256 remDrawn = st.amount; // Σ sourced.drawn == amount (_source required left == 0)
        uint256 n = sourced.length;
        // `strategyId` is read out of `st` ONCE, before the loop, and `drawn` is scoped to the block that
        // consumes it. Both exist to keep this frame allocatable under `--ir-minimum` (via_ir at minimum
        // optimization), which `forge coverage` forces and which cannot spill: holding the `st` memory
        // pointer and `drawn` live across the write block puts this function two slots too deep. The
        // shipping profile optimizes them away, so this costs no runtime bytecode and changes no behavior.
        uint256 strategyId = st.strategyId;
        for (uint256 i; i < n && left > 0; ++i) {
            uint256 charge;
            {
                uint256 drawn = sourced[i].drawn;
                // Skip entries that sourced nothing (a committer with zero room in `_source`).
                if (drawn == 0) continue;
                // Charge each sourcer its pro-rata share of the shortfall; `charge <= drawn` (clamped) so
                // the principal it just sourced always covers it and cannot underflow.
                (charge, left, remDrawn) = _clampedShare(left, drawn, remDrawn);
            }
            if (charge > 0) {
                address lp = sourced[i].lp;
                principal[lp] -= charge;
                deployedByLp[lp] -= charge;
                deployedInto[lp][strategyId] -= charge;
                newVaultLiveTvl = newVaultLiveTvl > charge ? newVaultLiveTvl - charge : 0;
                emit Events.StrategyDeployShortfall(address(this), strategyId, lp, charge);
            }
        }
        // Exact conservation: `Σ charge == shortfall`, so no phantom principal remains.
        require(left == 0, Errors.RanOutOfBacking(strategyId, left));
        // `deployed` ends equal to what the venue actually received (`delivered == amount - shortfall`).
        strategies[strategyId].deployed -= shortfall;
    }

    // ============================================================
    // Conservation
    // ============================================================

    /// @notice INV-CONSERVATION, asserted on every settle. Two per-strategy folds over the strategy's
    ///         committers: committed-ship principal (`Σ deployedInto == expectedDeployed`) and cross-vault
    ///         swap composition (`Σ composition == expectedComposition`). Moved out of `AssetVault` verbatim
    ///         (same invariant, same revert conditions); called right after the existing `deployIntoVenue` /
    ///         `returnFromStrategy` / `sellForSwap` / `creditFromSwap` delegatecalls, which already run in
    ///         this same breath.
    /// @param deployedInto Per-LP, per-strategy sourced principal.
    /// @param composition Per-strategy, per-LP cross-vault swap composition.
    /// @param committers The strategy's committer set to fold over.
    /// @param strategyId The strategy whose conservation is re-verified.
    /// @param expectedDeployed The strategy's recorded `deployed` (compared against the deployedInto fold).
    /// @param expectedComposition The strategy's recorded `strategyComposition` (compared against the
    ///        composition fold).
    function assertConservation(
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        mapping(uint256 => mapping(address => uint256)) storage composition,
        address[] storage committers,
        uint256 strategyId,
        uint256 expectedDeployed,
        uint256 expectedComposition
    ) external view {
        uint256 deployedSum;
        uint256 compSum;
        uint256 n = committers.length;
        for (uint256 i; i < n; ++i) {
            deployedSum += deployedInto[committers[i]][strategyId];
            compSum += composition[strategyId][committers[i]];
        }
        require(deployedSum == expectedDeployed, Errors.RanOutOfBacking(strategyId, 0));
        require(compSum == expectedComposition, Errors.RanOutOfBacking(strategyId, 1));
    }

    // ============================================================
    // Participation-fee accrual
    // ============================================================

    /// @notice Crystallize one LP's accrued fee for a strategy into `credit` (for a claim outside the source /
    ///         return paths). Fee follows actual participation (`deployedInto`), not the position view.
    /// @param credit Per-LP realized, withdrawable credit.
    /// @param feeCheckpointRay Per-LP, per-strategy fee accumulator checkpoint.
    /// @param deployedInto Per-LP, per-strategy sourced principal (the participation weight).
    /// @param lp The LP whose fee is crystallized.
    /// @param strategyId The strategy the fee is claimed from.
    /// @param feePerShareRay The strategy's current RAY fee-per-share accumulator.
    function accrueOne(
        mapping(address => uint256) storage credit,
        mapping(address => mapping(uint256 => uint256)) storage feeCheckpointRay,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        address lp,
        uint256 strategyId,
        uint256 feePerShareRay
    ) external {
        // External wrapper so the vault's standalone fee-claim path reuses the exact same accrual as source/return.
        _accrue(credit, feeCheckpointRay, deployedInto, lp, strategyId, feePerShareRay);
    }

    /// @dev Credit `lp`'s accrued fee since its checkpoint (weighted by current participation) and re-checkpoint.
    ///      Called BEFORE any change to `deployedInto[lp][strategyId]`.
    /// @param credit Per-LP realized, withdrawable credit.
    /// @param feeCheckpointRay Per-LP, per-strategy fee accumulator checkpoint (advanced to `fps`).
    /// @param deployedInto Per-LP, per-strategy sourced principal (the participation weight).
    /// @param lp The LP whose fee is crystallized.
    /// @param strategyId The strategy the fee accrues from.
    /// @param fps The strategy's current RAY fee-per-share accumulator.
    function _accrue(
        mapping(address => uint256) storage credit,
        mapping(address => mapping(uint256 => uint256)) storage feeCheckpointRay,
        mapping(address => mapping(uint256 => uint256)) storage deployedInto,
        address lp,
        uint256 strategyId,
        uint256 fps
    ) private {
        // v3-style accumulator: owed = participation * (accumulator - lastCheckpoint) / RAY. Re-checkpoint to
        // `fps` unconditionally so the LP is never paid twice for the same accumulator span.
        uint256 cp = feeCheckpointRay[lp][strategyId];
        if (fps > cp) {
            uint256 owed = Math.mulDiv(deployedInto[lp][strategyId], fps - cp, RAY);
            if (owed > 0) {
                credit[lp] += owed;
                // Per-LP fee crystallization: every change to a committer's credit is observable from events.
                emit Events.StrategyFeeAccrued(address(this), strategyId, lp, owed);
            }
        }
        feeCheckpointRay[lp][strategyId] = fps;
    }
}
