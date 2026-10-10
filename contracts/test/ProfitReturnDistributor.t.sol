// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProfitReturnDistributor} from "../src/ProfitReturnDistributor.sol";

contract ReturnTestToken is ERC20 {
    address public rejected;
    constructor() ERC20("Test USD", "TUSD") {}

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    function reject(address to) external {
        rejected = to;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != rejected, "rejected recipient");
        super._update(from, to, value);
    }
}

contract ReturnTestExecutor {}

contract ProfitReturnDistributorTest is Test {
    ReturnTestToken token;
    ProfitReturnDistributor distributor;
    address constant LP_A = address(0xA1);
    address constant LP_B = address(0xB1);

    function setUp() public {
        token = new ReturnTestToken();
        distributor = new ProfitReturnDistributor(address(this), address(new ReturnTestExecutor()), address(token));
        token.mint(address(this), 20e6);
        token.approve(address(distributor), 20e6);
    }

    function data() internal pure returns (bytes32[] memory ids, address[] memory lps, uint256[] memory amounts) {
        ids = new bytes32[](2);
        ids[0] = bytes32(uint256(1));
        ids[1] = bytes32(uint256(2));
        lps = new address[](2);
        lps[0] = LP_A;
        lps[1] = LP_B;
        amounts = new uint256[](2);
        amounts[0] = 3_375_000;
        amounts[1] = 1_125_000;
    }

    function test_ReturnsExactlyNinetyPercentAndRecordsEachExecution() public {
        (bytes32[] memory ids, address[] memory lps, uint256[] memory amounts) = data();
        distributor.distribute(ids, keccak256("reviewed receipt evidence"), 5e6, lps, amounts);
        assertEq(token.balanceOf(LP_A), 3_375_000);
        assertEq(token.balanceOf(LP_B), 1_125_000);
        assertEq(token.balanceOf(address(this)), 15_500_000);
        assertTrue(distributor.processed(ids[0]));
        assertTrue(distributor.processed(ids[1]));
        assertEq(token.balanceOf(address(distributor)), 0);
    }

    function test_RejectsOutsiderEvenWithApprovedOwnerFunds() public {
        (bytes32[] memory ids, address[] memory lps, uint256[] memory amounts) = data();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        distributor.distribute(ids, keccak256("evidence"), 5e6, lps, amounts);
        assertFalse(distributor.processed(ids[0]));
        assertEq(token.balanceOf(LP_A), 0);
    }

    function test_RejectsOverlapEvenWithDifferentBatchMetadata() public {
        (bytes32[] memory ids, address[] memory lps, uint256[] memory amounts) = data();
        distributor.distribute(ids, keccak256("first"), 5e6, lps, amounts);
        ids[0] = bytes32(uint256(3));
        vm.expectRevert(ProfitReturnDistributor.ExecutionAlreadyReturned.selector);
        distributor.distribute(ids, keccak256("changed"), 5e6, lps, amounts);
        assertFalse(distributor.processed(ids[0]));
        assertEq(token.balanceOf(LP_A), 3_375_000);
    }

    function test_RejectsWrongTotalAndDuplicateRecipients() public {
        (bytes32[] memory ids, address[] memory lps, uint256[] memory amounts) = data();
        amounts[0]++;
        vm.expectRevert(ProfitReturnDistributor.InvalidAllocation.selector);
        distributor.distribute(ids, keccak256("evidence"), 5e6, lps, amounts);
        amounts[0]--;
        lps[1] = lps[0];
        vm.expectRevert(ProfitReturnDistributor.InvalidAllocation.selector);
        distributor.distribute(ids, keccak256("evidence"), 5e6, lps, amounts);
    }

    function test_FailedRecipientRollsBackEarlierPayoutAndReplayState() public {
        (bytes32[] memory ids, address[] memory lps, uint256[] memory amounts) = data();
        token.reject(LP_B);
        vm.expectRevert();
        distributor.distribute(ids, keccak256("evidence"), 5e6, lps, amounts);
        assertEq(token.balanceOf(LP_A), 0);
        assertEq(token.balanceOf(address(this)), 20e6);
        assertFalse(distributor.processed(ids[0]));
    }
}
