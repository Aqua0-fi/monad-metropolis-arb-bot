// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { RedeemRequest } from "../../lib/Types.sol";
import { Events } from "../../lib/Events.sol";
import { Errors } from "../../lib/Errors.sol";

/// @title AsyncRedeemLib
/// @author Aqua0 Team
/// @notice Delegatecall-linked logic library for the ERC-7540 async redeem lifecycle
///         (`requestRedeem` / `fulfillRedeem` / `claimRedeem`), re-scoped from per-class-deployed to
///         POOL-principal-deployed. Split out of `AssetVault` to reclaim EIP-170 runtime headroom; async redeem
///         is a peripheral surface (the full escrow-against-principal machine and operator-attested strike are
///         still in progress), not the same-chain solvency core.
/// @dev NO STORAGE OF ITS OWN. The coupled storage effects that cannot cleanly leave the vault (principal /
///      shared-idle debit, per-strategy backing lowering, live-TVL release, asset egress) stay as thin vault
///      glue: the vault passes the LP's free principal + available idle as values, and this library returns the
///      resolved `assets` + `owner` for the vault to settle. Because the vault calls these by delegatecall,
///      `msg.sender`, `address(this)`, and the reentrancy guard are the vault's.
library AsyncRedeemLib {
    /// @dev MUST equal `AssetVault.GLOBAL_MAX_TIMEOUT`. Fallback + never-trapped ceiling.
    uint64 internal constant GLOBAL_MAX_TIMEOUT = 7 days;

    /// @notice Validate + write an async redeem request against `owner`'s currently-sourced principal (the
    ///         vault has already advanced `nextRequestId`). Claimable when the backing returns, or at timeout.
    /// @dev The four requires are the request-time guards: non-zero assets, non-zero controller, and
    ///      `msg.sender == owner` (only the principal owner may pledge their own deployed capital, since the
    ///      vault calls this by delegatecall so `msg.sender` is the original caller). `assets <=
    ///      deployedByLpOwner` bounds the request to principal not already escrowed by another pending request;
    ///      the vault passes `deployedByLp[owner] - asyncHeld[owner]` here, and adds `assets` to `asyncHeld`
    ///      after this returns, so two requests can never double-pledge the same deployed principal. The
    ///      never-trapped `claimableAt` is `now + effective timeout` (the route timeout, or `GLOBAL_MAX_TIMEOUT`
    ///      when the route is unset) so a claim always vests even if the backing never returns.
    /// @param redeemRequests The vault's request table, written at `requestId`.
    /// @param settlementRoute Strategy id to settlement-route key map (selects the claim timeout).
    /// @param routeTimeout Route to configured claim timeout; 0 falls back to `GLOBAL_MAX_TIMEOUT`.
    /// @param strategyId The strategy whose deployed principal is being redeemed (a routing label; one pool).
    /// @param assets The fixed asset amount pledged, escrowed against the owner's deployed principal.
    /// @param controller The account authorized to later claim the fulfilled/timed-out request.
    /// @param owner The principal owner; must equal `msg.sender`.
    /// @param requestId The pre-incremented request id to write.
    /// @param deployedByLpOwner The owner's redeemable deployed principal (deployed minus already-escrowed).
    function request(
        mapping(uint256 => RedeemRequest) storage redeemRequests,
        mapping(uint256 => bytes32) storage settlementRoute,
        mapping(bytes32 => uint64) storage routeTimeout,
        uint256 strategyId,
        uint256 assets,
        address controller,
        address owner,
        uint256 requestId,
        uint256 deployedByLpOwner
    ) external {
        require(assets > 0, Errors.ZeroAmount());
        require(controller != address(0), Errors.ZeroAddress());
        require(msg.sender == owner, Errors.PrincipalUnauthorized(msg.sender, owner));
        require(assets <= deployedByLpOwner, Errors.ExceedsWithdrawable(owner, assets, deployedByLpOwner));

        bytes32 route = settlementRoute[strategyId];
        uint64 requestedAt = uint64(block.timestamp);
        uint64 timeout = routeTimeout[route];
        uint64 claimableAt = requestedAt + (timeout == 0 ? GLOBAL_MAX_TIMEOUT : timeout);

        redeemRequests[requestId] = RedeemRequest({
            strategyId: strategyId,
            controller: controller,
            shares: assets,
            assetsOwed: 0,
            route: route,
            requestedAt: requestedAt,
            claimableAt: claimableAt,
            fulfilled: false,
            claimed: false,
            owner: owner
        });
        emit Events.ClassSettlementRequested(
            address(this), strategyId, controller, requestId, assets, route, requestedAt, claimableAt
        );
    }

    /// @notice Attest that capital backing `requestId` is free and lock the owed amount. Idempotent.
    /// @dev Requires the request to exist (`controller != address(0)`) and not already be claimed; a
    ///      second fulfill of an already-fulfilled request is a no-op (early return), so the Composer spine can
    ///      re-attest safely. Freezing `assetsOwed = shares` snapshots the amount owed at fulfil time; the
    ///      later `claim` still bounds the payout by surviving principal so a loss between fulfil and claim is
    ///      not paid out of other LPs' capital.
    /// @param redeemRequests The vault's request table.
    /// @param requestId The request to mark fulfilled.
    function fulfill(mapping(uint256 => RedeemRequest) storage redeemRequests, uint256 requestId) external {
        RedeemRequest storage r = redeemRequests[requestId];
        require(r.controller != address(0), Errors.RedeemRequestNotClaimable(requestId, 0));
        require(!r.claimed, Errors.RedeemRequestClaimed(requestId));
        if (r.fulfilled) return;
        r.assetsOwed = r.shares;
        r.fulfilled = true;
    }

    /// @notice Validate a claim (fulfilled or timed out) and pay it, requiring the freed capital to be present
    ///         (`assets <= redeemableIdle`, so a not-yet-returned claim reverts and is retried). Marks the
    ///         request claimed and emits. Returns the paid `assets`, `owner`, `strategyId`, and the full
    ///         `escrowReleased` (the amount originally escrowed into `asyncHeld`); the vault performs the escrow
    ///         / principal / idle / exposure / transfer effects.
    /// @dev A realized strategy loss writes the owner's principal down BELOW the fixed escrowed amount but never
    ///      reduces `asyncHeld`. If the payout were always pinned to the escrowed `r.shares`, both this claim
    ///      (bounded by the surviving principal) and a synchronous withdraw (`asyncHeld > principal` zeroes free
    ///      principal) would revert forever, trapping the surviving principal. The relief is scoped to a realized
    ///      LOSS only, detected by `ownerPrincipal < r.shares` (principal can drop below the escrow ONLY via a
    ///      writedown - a pending async redeem reserves the escrow from any withdraw, and deploying capital does
    ///      not reduce principal). A shortfall from capital STILL DEPLOYED or reserved for a committed front is a
    ///      transient state that will free up, so it keeps the original revert-and-retry behavior. On a loss the
    ///      payout is the surviving, returned, unreserved principal (the redeemer bears the loss, as on any
    ///      deployed-capital exit); the FULL escrow is released regardless, so the redeem is always terminal.
    ///
    ///      The three claim-time requires: only the recorded `controller` may claim; the request is not already
    ///      claimed (one-shot); and it is fulfilled OR past `claimableAt` (the never-trapped timeout). The
    ///      `assets <= redeemableIdle` check in both branches keeps the vault solvent - a claim of not-yet-
    ///      returned capital reverts and is retried once the idle is present.
    /// @param redeemRequests The vault's request table.
    /// @param requestId The request to settle.
    /// @param redeemableIdle Shared idle available to redeemers (all of `sharedIdle` less the front reservation).
    /// @param ownerReturnedPrincipal The owner's principal that has RETURNED and is unreserved (deployed and
    ///        committed-front holds excluded); the no-loss payout may not exceed this, preserving the per-LP cap.
    /// @param ownerPrincipal The owner's current total principal; `< r.shares` signals a realized writedown.
    /// @return assets The amount actually paid out (the full escrow, or the surviving principal on a loss).
    /// @return owner The principal owner recorded on the request, for the vault to settle against.
    /// @return strategyId The strategy the request was routed to.
    /// @return escrowReleased The full amount originally escrowed into `asyncHeld`, released regardless of `assets`.
    function claim(
        mapping(uint256 => RedeemRequest) storage redeemRequests,
        uint256 requestId,
        uint256 redeemableIdle,
        uint256 ownerReturnedPrincipal,
        uint256 ownerPrincipal
    ) external returns (uint256 assets, address owner, uint256 strategyId, uint256 escrowReleased) {
        RedeemRequest storage r = redeemRequests[requestId];
        require(msg.sender == r.controller, Errors.NotRequestController(msg.sender, r.controller));
        require(!r.claimed, Errors.RedeemRequestClaimed(requestId));
        require(
            r.fulfilled || block.timestamp >= r.claimableAt, Errors.RedeemRequestNotClaimable(requestId, r.claimableAt)
        );

        escrowReleased = r.shares;
        if (ownerPrincipal >= escrowReleased) {
            // No loss: the full escrow is recoverable. The pool must physically hold it AND the owner's own
            // deployed capital must have returned (so cutting their principal preserves the per-LP cap); either
            // unmet reverts and the claim is retried.
            assets = escrowReleased;
            require(assets <= redeemableIdle, Errors.InsufficientSharedIdle(assets, redeemableIdle));
            require(
                assets <= ownerReturnedPrincipal, Errors.ExceedsWithdrawable(r.owner, assets, ownerReturnedPrincipal)
            );
        } else {
            // A realized loss capped recovery below the escrow: pay the surviving, returned, unreserved principal.
            assets = ownerReturnedPrincipal;
            require(assets <= redeemableIdle, Errors.InsufficientSharedIdle(assets, redeemableIdle));
        }
        r.claimed = true;
        owner = r.owner;
        strategyId = r.strategyId;
        emit Events.ClassSettlementClaimed(
            address(this), strategyId, r.controller, requestId, assets, r.fulfilled, r.owner, escrowReleased
        );
    }
}
