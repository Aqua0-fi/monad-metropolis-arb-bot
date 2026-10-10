// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { FrontState, FrontLock } from "../../lib/Types.sol";
import { Events } from "../../lib/Events.sol";
import { Errors } from "../../lib/Errors.sol";

/// @title FrontLockLib
/// @author Aqua0 Team
/// @notice Delegatecall-linked logic for the cross-chain LP fronting lifecycle (`requestFrontLock` /
///         `commitFrontLock` / `releaseFrontToBridge` / `cancelFrontLock` / `creditFrontLanding`). The escrow
///         substrate is the LP's PRINCIPAL claim (an `amount` of asset units), not a transferable share: the
///         vault holds it out of the owner's free principal and reserves it from shared availability at commit
///         at commit. Split out of `AssetVault` for EIP-170 headroom; fronting is a peripheral surface (LP-B
///         make-whole + bridge timeout still pending).
/// @dev NO STORAGE OF ITS OWN. The vault owns the principal / reservation / idle scalars and writes them back
///      from the returns. Delegatecalled, so `msg.sender` / `address(this)` are the vault's.
library FrontLockLib {
    using SafeERC20 for IERC20;

    /// @notice Validate + write a new front lock (state -> Locked). The vault holds `amount` of the owner's
    ///         principal after this returns.
    /// @param frontLocks The vault's frontId -> FrontLock ledger.
    /// @param strategyId The strategy the front is attributed to.
    /// @param amount Principal to hold out of the owner's free principal.
    /// @param owner The LP whose principal backs the front.
    /// @param frontId Caller-chosen unique id for this front; must be unused.
    /// @param frontingReleaseLimit The vault's per-window release cap; zero means fronting is disabled.
    /// @param frontLockTimeout Seconds after which an uncommitted lock becomes self-cancellable.
    /// @param frontHeldPrincipal The vault's per-LP fronting-hold ledger; `amount` is added to the owner's hold.
    function lock(
        mapping(bytes32 => FrontLock) storage frontLocks,
        mapping(address => uint256) storage frontHeldPrincipal,
        uint256 strategyId,
        uint256 amount,
        address owner,
        bytes32 frontId,
        uint256 frontingReleaseLimit,
        uint64 frontLockTimeout
    ) external {
        // A zero release limit means fronting is turned off for this vault; do not open a lock.
        require(frontingReleaseLimit != 0, Errors.FrontingDisabled());
        require(amount > 0, Errors.ZeroAmount());
        // `frontId` must be unused: only a `None` slot may transition to `Locked`, so a live/terminal
        // front can never be silently overwritten (which would strand or double-spend its principal hold).
        require(frontLocks[frontId].state == uint8(FrontState.None), Errors.FrontIdExists(frontId));

        // Record the lock. `cancellableAt` fixes when the owner may self-cancel an uncommitted lock; the
        // vault (its caller) is what actually holds `amount` out of the owner's free principal.
        frontLocks[frontId] = FrontLock({
            strategyId: strategyId,
            owner: owner,
            amount: amount,
            lockedAt: uint64(block.timestamp),
            cancellableAt: uint64(block.timestamp) + frontLockTimeout,
            state: uint8(FrontState.Locked)
        });
        // Hold `amount` out of the owner's free principal (the escrow substrate is the principal claim itself).
        frontHeldPrincipal[owner] += amount;
        emit Events.FrontLocked(address(this), strategyId, frontId, owner, amount);
    }

    /// @notice Harden Locked -> Committed. Requires the front's principal to fit shared availability now; the
    ///         vault adds it to `frontReservedAssets` on return.
    /// @param frontLocks The vault's frontId -> FrontLock ledger.
    /// @param strategyId The strategy the front must match (guards a cross-strategy commit).
    /// @param frontId The front to harden; must currently be Locked.
    /// @param availableIdle Shared idle currently deployable; the front amount must not exceed it.
    /// @return reserved The front's principal amount the vault adds to its hard-reserved idle on return.
    function commit(
        mapping(bytes32 => FrontLock) storage frontLocks,
        uint256 strategyId,
        bytes32 frontId,
        uint256 availableIdle
    ) external returns (uint256 reserved) {
        FrontLock storage f = frontLocks[frontId];
        // Only a Locked front for the SAME strategy may harden (guards a cross-strategy commit).
        require(
            f.state == uint8(FrontState.Locked) && f.strategyId == strategyId,
            Errors.FrontWrongState(frontId, uint8(FrontState.Locked), f.state)
        );
        // The front's principal must fit deployable idle NOW; the vault then hard-reserves it so the same
        // idle is never double-promised to another commit.
        require(f.amount <= availableIdle, Errors.InsufficientSharedIdle(f.amount, availableIdle));
        // Locked -> Committed; the vault adds `reserved` to its hard-reserved idle on return.
        reserved = f.amount;
        f.state = uint8(FrontState.Committed);
        emit Events.FrontCommitted(address(this), strategyId, frontId);
    }

    /// @notice Meter + release a committed front (Committed -> Released, terminal). Returns the `amount` and
    ///         `owner` for the vault to move the principal + transfer, plus the updated meter window/net.
    /// @param frontLocks The vault's frontId -> FrontLock ledger.
    /// @param strategyId The strategy the front must match.
    /// @param frontId The front to release; must currently be Committed.
    /// @param sharedIdle Current shared idle; the release amount must not exceed it.
    /// @param frontingReleaseLimit Per-window release cap enforced by the rolling meter.
    /// @param releaseWindow Meter window length in seconds.
    /// @param windowStart Start timestamp of the current meter window.
    /// @param windowNet Amount already released in the current window.
    /// @param frontHeldPrincipal The vault's per-LP fronting-hold ledger; the released amount is removed here.
    /// @param principal The vault's per-LP principal cap ledger; the released amount leaves this chain here.
    /// @return amount Principal released to the bridge.
    /// @return newWindowStart Meter window start after this release (rolls forward when the window elapsed).
    /// @return newWindowNet Cumulative released amount in the (possibly reset) window after this release.
    function release(
        mapping(bytes32 => FrontLock) storage frontLocks,
        mapping(address => uint256) storage frontHeldPrincipal,
        mapping(address => uint256) storage principal,
        uint256 strategyId,
        bytes32 frontId,
        uint256 sharedIdle,
        uint256 frontingReleaseLimit,
        uint256 releaseWindow,
        uint256 windowStart,
        uint256 windowNet
    ) external returns (uint256 amount, uint256 newWindowStart, uint256 newWindowNet) {
        FrontLock storage f = frontLocks[frontId];
        // Only a Committed front for the SAME strategy may release; `Released` is terminal, so single-shot.
        require(
            f.state == uint8(FrontState.Committed) && f.strategyId == strategyId,
            Errors.FrontWrongState(frontId, uint8(FrontState.Committed), f.state)
        );

        // The struck amount + owner drive the principal move; the vault transfers to the Composer on return.
        amount = f.amount;
        address owner = f.owner;
        // Meter first (rolling per-window release cap), then re-check the amount still fits shared idle.
        (newWindowStart, newWindowNet) = _meter(amount, frontingReleaseLimit, releaseWindow, windowStart, windowNet);
        require(amount <= sharedIdle, Errors.InsufficientSharedIdle(amount, sharedIdle));

        // Terminal transition BEFORE the vault moves the principal, so a re-entrant release cannot double-strike.
        f.state = uint8(FrontState.Released);
        // The fronted principal leaves this chain: drop the owner's hold AND their principal cap by it. The
        // vault drops `frontReservedAssets` + `sharedIdle` (scalars) and transfers on return.
        frontHeldPrincipal[owner] -= amount;
        principal[owner] -= amount;
        emit Events.FrontReleased(address(this), strategyId, frontId, amount);
    }

    /// @notice Recover a never-committed lock (Locked -> Cancelled, terminal). Returns the strategy id, owner, +
    ///         amount for the vault to release the principal hold. Timing (non-admin) checked here; the
    ///         owner/admin auth is re-asserted in the vault wrapper (a revert there unwinds this flip).
    /// @param frontLocks The vault's frontId -> FrontLock ledger.
    /// @param frontHeldPrincipal The vault's per-LP fronting-hold ledger; the owner's hold is released here.
    /// @param frontId The front to cancel; must currently be Locked.
    /// @param isAdmin When true, skips the self-cancel timeout (admin may cancel a Locked front early).
    /// @return owner The LP whose principal hold is released (the vault re-asserts owner/admin auth on return).
    function cancel(
        mapping(bytes32 => FrontLock) storage frontLocks,
        mapping(address => uint256) storage frontHeldPrincipal,
        bytes32 frontId,
        bool isAdmin
    ) external returns (address owner) {
        FrontLock storage f = frontLocks[frontId];
        // Only a never-committed (Locked) front may self/owner-cancel; a Committed front needs `abort` below
        // (admin/guardian-gated) instead.
        require(f.state == uint8(FrontState.Locked), Errors.FrontWrongState(frontId, uint8(FrontState.Locked), f.state));

        // The held principal details drive the hold release back to the owner's free principal.
        uint256 strategyId = f.strategyId;
        owner = f.owner;
        uint256 amount = f.amount;
        // Self-cancel is gated by the lock timeout; an admin may cancel a stuck Locked front early.
        if (!isAdmin) {
            require(block.timestamp >= f.cancellableAt, Errors.FrontNotCancellable(frontId, f.cancellableAt));
        }
        // Locked -> Cancelled (terminal); release the owner's principal hold back to free principal. A revert in
        // the vault's owner/admin auth re-check unwinds this whole call, so releasing the hold here is safe.
        f.state = uint8(FrontState.Cancelled);
        frontHeldPrincipal[owner] -= amount;
        emit Events.FrontCancelled(address(this), strategyId, frontId, amount);
    }

    /// @notice Admin/guardian abort of a Committed front (Committed -> Cancelled, terminal). The escape
    ///         hatch a Committed front otherwise lacks: `cancel` above only ever accepts Locked, and
    ///         `release` can be permanently blocked by `setFrontingConfig(0, ...)` disabling fronting (the
    ///         `_meter` exemption above lets a healthy release still go through, but if the bridge/operator
    ///         flow is itself stuck, this is the last-resort unwind). Returns the strategy id, owner, and
    ///         amount for the vault to release BOTH the hard reservation and the owner's principal hold.
    /// @dev No principal ever leaves the vault here - this is a pure accounting unwind, the reverse of
    ///      `commit`. Auth is enforced in the vault wrapper (a revert there unwinds this flip).
    /// @param frontLocks The vault's frontId -> FrontLock ledger.
    /// @param frontHeldPrincipal The vault's per-LP fronting-hold ledger; the owner's hold is released here.
    /// @param frontId The Committed front to abort.
    /// @return amount The principal amount released back to the owner's free principal (the vault also drops the
    ///         matching `frontReservedAssets` reservation on return).
    function abort(
        mapping(bytes32 => FrontLock) storage frontLocks,
        mapping(address => uint256) storage frontHeldPrincipal,
        bytes32 frontId
    ) external returns (uint256 amount) {
        FrontLock storage f = frontLocks[frontId];
        require(
            f.state == uint8(FrontState.Committed),
            Errors.FrontWrongState(frontId, uint8(FrontState.Committed), f.state)
        );
        uint256 strategyId = f.strategyId;
        address owner = f.owner;
        amount = f.amount;
        // Committed -> Cancelled (terminal); release the owner's hold here, the vault drops the reservation on
        // return. No principal leaves the vault - a pure accounting unwind, the reverse of `commit`.
        f.state = uint8(FrontState.Cancelled);
        frontHeldPrincipal[owner] -= amount;
        emit Events.FrontAborted(address(this), strategyId, frontId, amount);
    }

    /// @notice One-shot consume the domain-tagged landing key, pull the MEASURED landing, and return the
    ///         received amount for the vault to credit to shared idle.
    /// @param settlementConsumed The vault's one-shot ledger keyed by (strategyId, front, settlementId).
    /// @param strategyId The strategy the landing is credited to.
    /// @param frontId The front this landing settles.
    /// @param settlementId The bridge landing id; must be non-zero and unused for this key.
    /// @param amount Amount to pull from `msg.sender` (the Composer forwarding the landing).
    /// @param asset The underlying token being credited.
    /// @param frontLandingDomain Domain tag separating front landings from other settlement keys.
    /// @return received Amount actually pulled (measured post-transfer delta, FOT-safe), credited to shared idle.
    function credit(
        mapping(bytes32 => bool) storage settlementConsumed,
        uint256 strategyId,
        bytes32 frontId,
        bytes32 settlementId,
        uint256 amount,
        address asset,
        bytes32 frontLandingDomain
    ) external returns (uint256 received) {
        require(settlementId != bytes32(0), Errors.ZeroSettlementId());
        // Domain-tag the front id before keying, so a front landing can never collide with a bridge-settle
        // key that reuses the same `(strategyId, settlementId)` pair.
        bytes32 key =
            keccak256(abi.encode(strategyId, keccak256(abi.encode(frontLandingDomain, frontId)), settlementId));
        // One-shot: consume the key before pulling, so a replayed landing cannot credit idle twice.
        require(!settlementConsumed[key], Errors.SettlementAlreadyConsumed(strategyId, frontId, settlementId));
        // Mark consumed BEFORE the external pull (CEI), so a token callback cannot re-enter and re-settle.
        settlementConsumed[key] = true;

        // Measure-what-landed: credit only the tokens that physically arrived (FOT-safe), never the nominal.
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(asset).balanceOf(address(this)) - before;
        // Something must have arrived; the vault credits exactly `received` to shared idle on return.
        require(received > 0, Errors.ZeroAmount());
        emit Events.FrontLandingCredited(address(this), strategyId, frontId, settlementId, received);
    }

    /// @dev Fixed-grid-window meter for the dedicated cross-chain fronting-release drain. Once `window`
    ///      seconds have elapsed since `start`, `start` snaps FORWARD to the fixed grid point at or before
    ///      `now` (`start + floor((now - start) / window) * window`), NOT to `block.timestamp` itself - a
    ///      tumbling reset would let whoever triggers the reset transaction pick the new window's phase,
    ///      letting a release drain the full limit at the tail of one window and immediately again at the
    ///      head of the next, repeatable every cycle for a sustained ~2x rate rather than a one-time
    ///      boundary straddle. Then requires the running net to stay within `limit`.
    /// @param amount Release amount to add to the window net.
    /// @param limit Per-window release ceiling.
    /// @param window Window length in seconds.
    /// @param start Current window start timestamp.
    /// @param net Amount already released in the current window.
    /// @return newStart Window start after this call (snaps forward on a fixed-grid reset).
    /// @return newNet Running net after adding `amount` (in the reset window when the prior window elapsed).
    function _meter(uint256 amount, uint256 limit, uint256 window, uint256 start, uint256 net)
        private
        view
        returns (uint256 newStart, uint256 newNet)
    {
        // A zero limit blocks NEW locks (FrontLockLib.lock enforces that separately) but must not strand a
        // front that was ALREADY hardened to Committed under a real, nonzero limit - exempt the meter
        // entirely while disabled, so a Committed front can still be released after an admin kill-switches
        // fronting. There is nothing meaningful to track against a
        // limit that no longer exists, so the window state passes through unchanged.
        if (limit == 0) return (start, net);
        // Fixed-grid reset: once the window has fully elapsed, snap forward to the grid point at/before now.
        if (block.timestamp >= start + window) {
            // The divide-then-multiply is intentional integer flooring: it snaps `start` forward to the most
            // recent whole-`window` boundary, so the grid stays fixed-phase. Exact by construction, not a
            // precision loss. Same suppression and same reason as the venue-outflow meter in the vault.
            // slither-disable-next-line divide-before-multiply
            start += ((block.timestamp - start) / window) * window;
            net = 0;
        }
        // The running net (including this release) must stay within the per-window ceiling.
        newNet = net + amount;
        require(newNet <= limit, Errors.FrontingReleaseMeterExceeded(amount, limit > net ? limit - net : 0));
        newStart = start;
    }
}
