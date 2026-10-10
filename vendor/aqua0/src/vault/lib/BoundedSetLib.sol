// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Errors } from "../../lib/Errors.sol";

/// @title BoundedSetLib
/// @author Aqua0 Team
/// @notice Delegatecall-linked bookkeeping for the shared-pool vault's two bounded membership sets: a
///         strategy's committer set (`address[]`) and an LP's commitment set (`uint256[]`). Pure mechanical
///         swap-pop membership with an index-plus-1 map for O(1) removal; NO fund authority and NO storage of
///         its own. Extracted to reclaim EIP-170 runtime headroom on the beacon implementation; the solvency /
///         containment invariants that read these sets (pro-rata sourcing, the conservation fold) stay INLINE
///         in the vault.
/// @dev The bound is the load-bearing property: the pro-rata source pass and the withdraw/uncommit backing
///      loop iterate these sets, so their size must stay bounded. `max` is a layout-safe tunable.
library BoundedSetLib {
    /// @notice Add `item` to the address `set` if absent, bounded by `max`. `indexPlus1[item]` becomes its
    ///         1-based index so membership is O(1) to test and `removeAddress` is O(1).
    /// @dev Idempotent: a present member (`indexPlus1[item] != 0`) is a no-op, so re-adding never grows the set
    ///      or corrupts the index. The bound is load-bearing, not cosmetic: callers iterate this set on the
    ///      pro-rata source pass and the conservation fold, so an unbounded set would make those O(n) loops a
    ///      gas-DoS surface. The 1-based index reserves 0 as the "absent" sentinel.
    /// @param set The strategy's committer set to insert into.
    /// @param indexPlus1 Membership map: `set` index + 1 for a member, 0 for a non-member.
    /// @param item The address to insert.
    /// @param max The inclusive cap on `set.length`; the insert reverts `CommitterSetFull` at capacity.
    function addAddress(
        address[] storage set,
        mapping(address => uint256) storage indexPlus1,
        address item,
        uint256 max
    ) external {
        if (indexPlus1[item] != 0) return;
        require(set.length < max, Errors.CommitterSetFull(0, max));
        set.push(item);
        indexPlus1[item] = set.length;
    }

    /// @notice Remove `item` from the address `set` if present (swap-pop, O(1)).
    /// @dev Overwrites the removed slot with the last element and pops, so the set stays dense (no gaps) and
    ///      the iterating loops never visit a stale entry. The moved element's `indexPlus1` is rewritten to its
    ///      new slot; the removed item's `indexPlus1` is cleared to 0 (absent). Absent `item` is a no-op.
    /// @param set The strategy's committer set to remove from.
    /// @param indexPlus1 Membership map kept in lockstep with `set`.
    /// @param item The address to remove.
    function removeAddress(address[] storage set, mapping(address => uint256) storage indexPlus1, address item)
        external
    {
        uint256 idxPlus1 = indexPlus1[item];
        if (idxPlus1 == 0) return;
        uint256 idx = idxPlus1 - 1;
        uint256 last = set.length - 1;
        // Move the last element into the vacated slot only when `item` is not itself the last element; either
        // way the tail is then popped, keeping the array dense.
        if (idx != last) {
            address moved = set[last];
            set[idx] = moved;
            indexPlus1[moved] = idx + 1;
        }
        set.pop();
        indexPlus1[item] = 0;
    }

    /// @notice Add `item` to the uint `set` if absent, bounded by `max`. The uint twin of `addAddress`, used
    ///         for an LP's commitment set (the strategy ids it backs).
    /// @dev Same idempotent, 1-based-index, bounded contract as `addAddress`. The bound caps the withdraw /
    ///      uncommit backing loop that walks every strategy an LP has committed to.
    /// @param set The LP's commitment set (strategy ids) to insert into.
    /// @param indexPlus1 Membership map: `set` index + 1 for a member, 0 for a non-member.
    /// @param item The strategy id to insert.
    /// @param max The inclusive cap on `set.length`; the insert reverts `TooManyCommitments` at capacity.
    function addUint(uint256[] storage set, mapping(uint256 => uint256) storage indexPlus1, uint256 item, uint256 max)
        external
    {
        if (indexPlus1[item] != 0) return;
        require(set.length < max, Errors.TooManyCommitments(address(0), max));
        set.push(item);
        indexPlus1[item] = set.length;
    }

    /// @notice Remove `item` from the uint `set` if present (swap-pop, O(1)). The uint twin of `removeAddress`.
    /// @dev Same swap-pop-and-clear mechanics as `removeAddress`; keeps `set` dense and `indexPlus1` in
    ///      lockstep. Absent `item` is a no-op.
    /// @param set The LP's commitment set (strategy ids) to remove from.
    /// @param indexPlus1 Membership map kept in lockstep with `set`.
    /// @param item The strategy id to remove.
    function removeUint(uint256[] storage set, mapping(uint256 => uint256) storage indexPlus1, uint256 item) external {
        uint256 idxPlus1 = indexPlus1[item];
        if (idxPlus1 == 0) return;
        uint256 idx = idxPlus1 - 1;
        uint256 last = set.length - 1;
        if (idx != last) {
            uint256 moved = set[last];
            set[idx] = moved;
            indexPlus1[moved] = idx + 1;
        }
        set.pop();
        indexPlus1[item] = 0;
    }
}
