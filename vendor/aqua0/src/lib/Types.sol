// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// forgefmt: disable-start
//
//         █████╗  ██████╗ ██╗   ██╗ █████╗  ██████╗
//        ██╔══██╗██╔═══██╗██║   ██║██╔══██╗██╔═████╗
//        ███████║██║   ██║██║   ██║███████║██║██╔██║
//        ██╔══██║██║▄▄ ██║██║   ██║██╔══██║████╔╝██║
//        ██║  ██║╚██████╔╝╚██████╔╝██║  ██║╚██████╔╝
//        ╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝
//
//        Cross-Chain Shared Liquidity Protocol
//
// forgefmt: disable-end

// Single canonical types file for the vaults. Two groups live here:
//
//  1. File-level storage types (Strategy / RedeemRequest / FrontState / Alloc / FrontLock) so the vault and
//     its logic libraries can reference them with no import cycle (`forge inspect ... storageLayout` breaks on
//     a cycle). Member order + types are the vault's committed storage layout: do NOT reorder; append only, at
//     the end of a mapping-value struct. Fresh design; re-blessable pre-deploy.
//  2. The `V4Types` library: interface/EIP-712 struct types for the V4 asset-vault adapter. Field order is
//     ABI/EIP-712 significant, do NOT reorder.

struct Strategy {
    bool exists;
    bool paused;
    bool reporterFrozen;
    address strategist;
    uint256 deployed;
    int256 pnlPool;
    uint256 feePerShareRay;
    int256 xChainPnL;
    uint256 vestingGain;
    uint64 vestStart;
    uint64 vestDuration;
    uint64 lastReportedEpoch;
    uint64 clampWindowStart;
    uint64 pausedAt;
}

struct RedeemRequest {
    uint256 strategyId;
    address controller;
    uint256 shares;
    uint256 assetsOwed;
    bytes32 route;
    uint64 requestedAt;
    uint64 claimableAt;
    bool fulfilled;
    bool claimed;
    address owner;
}

enum FrontState {
    None,
    Locked,
    Committed,
    Released,
    Cancelled
}

/// @notice One committer's sourced amount from a `settleVenueOut` leg. The venue adapter threads the returned
///         allocation into the counter vault's `settleVenueCredit` so the LP's proceeds are credited to THEM
///         (ownership follows sourcing), keeping the two per-asset vaults decoupled.
///
/// @dev `beneficiary` / `redirected` carry cross-chain fronting attribution. They are resolved on the SOURCING
///      vault (where the `FrontObligation` and the filler's pledged principal both live) and merely READ by the
///      counter vault, because `settleVenueOut` and `settleVenueCredit` run on DIFFERENT vaults - so a
///      redirect decided at credit time would look up an obligation the crediting vault never recorded, resolve
///      to nothing, and leave the filler holding exposure the design forbids them. Failing silently, which is
///      the one outcome the redirect exists to prevent.
///
///      `redirected <= drawn` always. `redirected` of the proceeds accrue to `beneficiary`; the remaining
///      `drawn - redirected` accrue to `lp`, so a filler keeps the proceeds on capital they never pledged.
///      When no front is open, `beneficiary == lp` and `redirected == 0`, which is the identity case.
struct Alloc {
    address lp;
    uint256 drawn;
    address beneficiary;
    uint256 redirected;
}

/// @notice One filler's leg of a cross-chain front, recorded on the DESTINATION vault.
///
/// @dev A front fans out across N fillers (the matcher fills greedily), so one `frontId` maps to an array of
///      these. The obligation is what makes the `Alloc.beneficiary` field populatable at all: nothing else
///      on-chain knows that a given LP's sourced principal was pledged on someone else's behalf.
struct FrontObligation {
    uint256 strategyId;
    // The ordinary committer standing in for the beneficiary's not-yet-arrived capital. Their principal is
    // sourced normally; only the ATTRIBUTION of the proceeds is redirected.
    address filler;
    // LP-A: the source-chain LP whose principal was destroyed on release and is bridging in.
    address beneficiary;
    // This filler's pledged amount, mirroring the backend reservation row committed to by `allocationsRoot`.
    uint256 pledged;
    // Cumulative proceeds redirected away from the filler so far; never exceeds `pledged`. Settlement restores
    // exactly this, not `pledged`, so the filler is returned whole by construction rather than by reconciling
    // against numbers the vault cannot see.
    uint256 redirected;
    // The filler's compensation, denominated in this vault's asset. Backend-authoritative, inside the signed op.
    uint256 feeOwed;
    // `ObligationState` stored raw, for the same forge-inspect layout reason as `FrontLock.state`.
    uint8 state;
}

enum ObligationState {
    None,
    Open,
    // Resolved out of a bridge landing that arrived.
    Settled,
    // Resolved without one. Terminal in the same way `Settled` is: a leg in either state pays nothing and
    // blocks nothing, so a landing that turns up afterwards is still bookable and still cannot pay twice.
    Aborted
}

struct FrontLock {
    uint256 strategyId;
    address owner;
    // Principal (asset units) fronted: held out of the owner's free principal at lock and reserved from shared
    // availability at commit (non-transferable principal claim escrow, not a share transfer).
    uint256 amount;
    uint64 lockedAt;
    uint64 cancellableAt;
    // `FrontState` stored raw: an enum member is omitted from the forge-inspect layout the CI comparator
    // reads, which false-flags a typechange; a uint8 sidesteps that (cast via uint8(FrontState.X)).
    uint8 state;
}

/// @title V4Types
/// @author Aqua0 Team
/// @notice Struct types for the multi-class V4 asset-vault adapter. A JIT is attributed to one consent class,
///         and both pool currencies settle to that same class in their respective per-asset vaults. Field order
///         is ABI/EIP-712 significant, do NOT reorder.
library V4Types {
    /// @notice A single tick range for JIT liquidity injection.
    struct V4Range {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    /// @notice Backend-signed payload authorizing a single JIT swap, attributed to `classId`.
    /// @dev The digest binds the exact swap (`zeroForOne`, `amountSpecified`, `sqrtPriceLimitX96`) plus the
    ///      pool, class, ranges, and the `executor` (the router expected to trigger this swap on the
    ///      PoolManager), so a payload lifted from the mempool cannot be replayed against a different,
    ///      LP-adverse swap, a different class, or through a different router ahead of the intended trader.
    struct JITPayload {
        bytes32 swapId;
        bytes32 poolId;
        uint256 classId;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        uint256 nonce;
        uint256 deadline;
        address executor;
        bytes signature;
    }

    /// @notice A pool's protocol-fee rate OVERRIDE. Storage-only: never signed and never on the wire, so
    ///         unlike the payload structs above its field order carries no ABI/EIP-712 meaning.
    /// @dev `set` exists so a DELIBERATE ZERO is expressible. With a bare `mapping(PoolId => uint32)` an
    ///      operator who waives the fee on a pair by writing 0 produces a value indistinguishable from "no
    ///      override here": the resolver falls through to the global rate and the pool keeps being charged.
    ///      That is a fee taken where the operator believed they had waived it, with nothing reverting and
    ///      nothing logged as wrong. Splitting presence from value is what makes `0` mean FREE rather than
    ///      UNSET. Chosen over a `ppb + 1` sentinel because the packed struct costs the same single slot
    ///      (1 + 4 bytes) and one SLOAD while reading unambiguously, in code and in raw storage alike.
    struct PoolProtocolFee {
        bool set; // true when this pool carries an override at all; false falls back to the global rate
        uint32 ppb; // the override rate in PARTS PER BILLION (1e9 == 100%); meaningful only when `set`
    }

    /// @notice Persisted configuration for a JIT-enabled pool. Both tokens must have a registry vault so the
    ///         net settlement can route each currency to its own vault.
    struct JITPositionInfo {
        bool exists;
        bool active;
        int24 tickLower;
        int24 tickUpper;
        address token0;
        address token1;
    }
}
