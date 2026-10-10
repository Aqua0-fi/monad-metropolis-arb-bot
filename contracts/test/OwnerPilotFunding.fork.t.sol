// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketRebalancer} from "../src/MarketRebalancer.sol";

interface IFundingRouter {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
    function refundETH() external payable;
    function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results);
}

/// Tests the owner helper's exact captured funding calldata on a local fork only.
contract OwnerPilotFundingForkTest is Test {
    address private owner;
    address private executor;
    address private router;
    address private usdc;
    address private weth;
    uint256 private value;
    uint256 private target;
    uint256 private deadline;
    uint24 private fee;
    bytes private data;

    function setUp() public {
        string memory cfg = vm.readFile("config/owner-pilot-funding-fork.json");
        uint256 blockNumber = vm.parseUint(vm.parseJsonString(cfg, ".state.blockNumber"));
        vm.createSelectFork(vm.envOr("OWNER_FUNDING_RPC_URL", string("https://arb1.arbitrum.io/rpc")), blockNumber);
        assertEq(block.chainid, 42161);
        owner = vm.parseJsonAddress(cfg, ".policy.owner");
        executor = vm.parseJsonAddress(cfg, ".policy.executor");
        router = vm.parseJsonAddress(cfg, ".policy.fundingRouter");
        usdc = vm.parseJsonAddress(cfg, ".policy.baseToken");
        weth = vm.parseJsonAddress(cfg, ".policy.wrappedNative");
        value = vm.parseUint(vm.parseJsonString(cfg, ".step.value"));
        deadline = vm.parseUint(vm.parseJsonString(cfg, ".step.deadline"));
        target = vm.parseUint(vm.parseJsonString(cfg, ".policy.inventoryTarget"));
        fee = uint24(vm.parseJsonUint(cfg, ".state.externalFee"));
        data = vm.parseJsonBytes(cfg, ".step.data");
        assertEq(router.codehash, vm.parseJsonBytes32(cfg, ".fundingRouterCodeHash"));
        assertEq(executor.codehash, vm.parseJsonBytes32(cfg, ".state.executorCodeHash"));
        assertEq(MarketRebalancer(executor).owner(), owner);
        assertTrue(MarketRebalancer(executor).paused());
        assertEq(IERC20(usdc).balanceOf(executor), vm.parseUint(vm.parseJsonString(cfg, ".state.inventory")));
        assertGt(owner.balance, value);
        assertEq(router.balance, 0, "Capture has no prior router ETH dust to confuse the refund proof");
        vm.deal(address(this), 0);
    }

    function testFork_OwnerFundingBuysExactUsdcIntoPausedExecutorAndRefundsChange() public {
        uint256 beforeOwner = owner.balance;
        uint256 beforeUsdc = IERC20(usdc).balanceOf(executor);
        vm.prank(owner);
        (bool ok, bytes memory result) = router.call{value: value}(data);
        assertTrue(ok, "Captured owner funding calldata must execute against the real router");
        bytes[] memory outputs = abi.decode(result, (bytes[]));
        uint256 consumed = abi.decode(outputs[0], (uint256));
        assertGt(consumed, 0);
        assertLt(consumed, value, "The quoted funding buffer must be refunded, not left in the router");
        assertEq(beforeOwner - owner.balance, consumed);
        assertEq(IERC20(usdc).balanceOf(executor), target);
        assertGt(target, beforeUsdc);
        assertEq(router.balance, 0);
        assertEq(IERC20(weth).balanceOf(executor), 0);
        assertTrue(MarketRebalancer(executor).paused(), "Funding alone does not enable trades");
        emit log_named_uint("Exact USDC inventory raw", target);
        emit log_named_uint("Actual ETH consumed before network fees", consumed);
        emit log_named_uint("Unused ETH refunded", value - consumed);
    }

    function testFork_FundingInputCapRevertsTheWholePurchaseAndReturnsTheValue() public {
        uint256 beforeOwner = owner.balance;
        uint256 beforeUsdc = IERC20(usdc).balanceOf(executor);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            IFundingRouter.exactOutputSingle,
            (IFundingRouter.ExactOutputSingleParams({
                    tokenIn: weth,
                    tokenOut: usdc,
                    fee: fee,
                    recipient: executor,
                    amountOut: target - beforeUsdc,
                    amountInMaximum: 1,
                    sqrtPriceLimitX96: 0
                }))
        );
        calls[1] = abi.encodeCall(IFundingRouter.refundETH, ());
        vm.prank(owner);
        vm.expectRevert(bytes("Too much requested"));
        IFundingRouter(router).multicall{value: value}(deadline, calls);
        assertEq(owner.balance, beforeOwner);
        assertEq(IERC20(usdc).balanceOf(executor), beforeUsdc);
        assertEq(router.balance, 0);
        assertTrue(MarketRebalancer(executor).paused());
    }
}
