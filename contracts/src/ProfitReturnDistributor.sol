// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Optional hackathon return mechanism, separate from the trading executor.
/// @dev Receipt provenance and realized net profit are reviewed offchain by the owner.
///      This contract enforces the approved 90% total, exact transfers and non-reuse of executions;
///      it does not claim to verify a historical DEX receipt or an offchain gas-token valuation.
///      It pulls only the owner's explicit token allowance, never executor or LP vault inventory.
contract ProfitReturnDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable executor;
    IERC20 public immutable token;
    mapping(bytes32 => bool) public processed;

    error InvalidAllocation();
    error ExecutionAlreadyReturned();
    error UnsupportedTransfer();

    event ExecutionIncluded(bytes32 indexed transactionHash, bytes32 indexed evidenceHash);
    event ProfitReturned(bytes32 indexed evidenceHash, address indexed lp, uint256 amount);
    event BatchReturned(bytes32 indexed evidenceHash, uint256 reviewedNetProfit, uint256 returnedAmount);

    constructor(address initialOwner, address executor_, address token_) Ownable(initialOwner) {
        if (executor_.code.length == 0 || token_.code.length == 0) revert InvalidAllocation();
        executor = executor_;
        token = IERC20(token_);
    }

    function distribute(
        bytes32[] calldata executionHashes,
        bytes32 evidenceHash,
        uint256 reviewedNetProfit,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyOwner nonReentrant {
        if (
            evidenceHash == bytes32(0) || executionHashes.length == 0 || executionHashes.length > 100
                || recipients.length == 0 || recipients.length > 100 || recipients.length != amounts.length
        ) revert InvalidAllocation();
        uint256 expected = Math.mulDiv(reviewedNetProfit, 9000, 10000);
        if (expected == 0) revert InvalidAllocation();
        uint256 total;
        address previous;
        for (uint256 i; i < recipients.length; i++) {
            if (
                recipients[i] <= previous || recipients[i] == address(this) || recipients[i] == msg.sender
                    || amounts[i] == 0
            ) {
                revert InvalidAllocation();
            }
            previous = recipients[i];
            total += amounts[i];
        }
        if (total != expected) revert InvalidAllocation();
        for (uint256 i; i < executionHashes.length; i++) {
            bytes32 id = executionHashes[i];
            if (id == bytes32(0)) revert InvalidAllocation();
            if (processed[id]) revert ExecutionAlreadyReturned();
            processed[id] = true;
            emit ExecutionIncluded(id, evidenceHash);
        }
        for (uint256 i; i < recipients.length; i++) {
            uint256 beforeBalance = token.balanceOf(recipients[i]);
            token.safeTransferFrom(msg.sender, recipients[i], amounts[i]);
            if (token.balanceOf(recipients[i]) != beforeBalance + amounts[i]) revert UnsupportedTransfer();
            emit ProfitReturned(evidenceHash, recipients[i], amounts[i]);
        }
        emit BatchReturned(evidenceHash, reviewedNetProfit, total);
    }
}
