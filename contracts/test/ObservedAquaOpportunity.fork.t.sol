// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketRebalancer, PoolKey} from "../src/MarketRebalancer.sol";
import {ISwapVMVenue, IFleetAquaMaker} from "../src/SwapVMVenue.sol";
import {
    IProductionRegistry,
    IProductionMaker,
    IProductionVMQuote,
    IProductionQuoter,
    IProductionAqua
} from "./ProductionAquaAdapter.fork.t.sol";

interface IObservedExternalPool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

/// Replays an actually observed quote without changing either pool's price or LP backing.
/// Only the deployed executor's local-fork permissions and USDC inventory are supplied.
contract ObservedAquaOpportunityForkTest is Test {
    MarketRebalancer private bot;
    address private owner;
    address private router;
    address private aqua;
    address private maker;
    address private base;
    address private other;
    address private inputVault;
    address private outputVault;
    address private externalPool;
    bytes32 private orderHash;
    uint256 private classId;
    uint256 private input;
    uint256 private expectedFirst;
    uint256 private expectedFinal;
    uint256 private quotedFinalFloor;
    uint256 private gasBudget;
    ISwapVMVenue.Order private order;
    MarketRebalancer.Trade private trade;

    function number(string memory cfg, string memory path) private pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(cfg, path));
    }

    function setUp() public {
        string memory cfg = vm.readFile(
            vm.envOr("OBSERVED_OPPORTUNITY_FIXTURE", string("config/observed-opportunity-arbitrum-fork.json"))
        );
        vm.createSelectFork(
            vm.envOr("OBSERVED_OPPORTUNITY_RPC_URL", string("https://arb1.arbitrum.io/rpc")),
            number(cfg, ".quote.blockNumber")
        );
        assertEq(block.chainid, 42161);
        // Canonical block/hash and code were independently captured before this replay.
        bot = MarketRebalancer(vm.parseJsonAddress(cfg, ".quote.caller"));
        assertEq(address(bot).codehash, vm.parseJsonBytes32(cfg, ".expectedExecutorCodeHash"));
        owner = vm.parseJsonAddress(cfg, ".expectedOwner");
        assertEq(bot.owner(), owner);
        assertTrue(bot.paused(), "Capture must not silently rely on a live enabled executor");
        router = vm.parseJsonAddress(cfg, ".quote.market.router");
        aqua = vm.parseJsonAddress(cfg, ".quote.market.aqua");
        maker = vm.parseJsonAddress(cfg, ".quote.market.maker");
        assertEq(maker.codehash, vm.parseJsonBytes32(cfg, ".expectedMakerCodeHash"));
        base = vm.parseJsonAddress(cfg, ".quote.baseToken");
        address t0 = vm.parseJsonAddress(cfg, ".quote.market.token0");
        address t1 = vm.parseJsonAddress(cfg, ".quote.market.token1");
        other = base == t0 ? t1 : t0;
        assertTrue(base == t0 || base == t1);
        bytes32 strategy = vm.parseJsonBytes32(cfg, ".quote.market.stableStrategyId");
        orderHash = vm.parseJsonBytes32(cfg, ".quote.market.currentAquaHash");
        classId = number(cfg, ".quote.market.classId");
        order = ISwapVMVenue.Order(
            maker, number(cfg, ".quote.market.order.traits"), vm.parseJsonBytes(cfg, ".quote.market.order.data")
        );
        assertEq(IFleetAquaMaker(maker).currentAquaHash(strategy), orderHash);
        assertEq(IFleetAquaMaker(maker).strategyClassId(strategy), classId);
        assertEq(IFleetAquaMaker(maker).aquaSwapVMRouter(), router);
        assertEq(ISwapVMVenue(router).hash(order), orderHash);
        externalPool = vm.parseJsonAddress(cfg, ".quote.externalPool");
        IObservedExternalPool pool = IObservedExternalPool(externalPool);
        assertEq(pool.factory(), vm.parseJsonAddress(cfg, ".quote.externalFactory"));
        assertEq(pool.token0(), t0);
        assertEq(pool.token1(), t1);
        assertEq(pool.fee(), vm.parseJsonUint(cfg, ".quote.externalFee"));
        address registry = IProductionMaker(maker).registry();
        inputVault = IProductionRegistry(registry).vaultForAsset(base);
        outputVault = IProductionRegistry(registry).vaultForAsset(other);
        input = number(cfg, ".quote.candidates[0].amountIn");
        expectedFirst = number(cfg, ".quote.candidates[0].firstAmountOut");
        quotedFinalFloor = number(cfg, ".quote.candidates[0].finalAmountOut");
        gasBudget = number(cfg, ".quote.gasBudget");
        require(vm.parseJsonBool(cfg, ".quote.candidates[0].aquaFirst"), "Expected Aqua-first capture");
        require(input <= 5e6, "Pilot input cap");
        uint256 secondInput = number(cfg, ".quote.candidates[0].secondAmountIn");
        vm.prank(address(bot));
        (uint256 used, uint256 actualQuote, bytes32 hash) =
            IProductionVMQuote(router).quote(order, base, other, input, abi.encodePacked(new bytes(20), uint16(0x0041)));
        assertEq(used, input);
        assertEq(hash, orderHash);
        assertEq(actualQuote, expectedFirst);
        (expectedFinal,,,) = IProductionQuoter(vm.parseJsonAddress(cfg, ".externalQuoter"))
            .quoteExactInputSingle(IProductionQuoter.Input(other, base, secondInput, pool.fee(), 0));
        assertGe(expectedFinal, quotedFinalFloor);
        PoolKey memory empty;
        trade = MarketRebalancer.Trade({
            id: keccak256("observed-arbitrum-aqua-opportunity"),
            deadline: block.timestamp + 30,
            validUntilBlock: bot.executionBlockNumber() + 1,
            minProfit: gasBudget + number(cfg, ".quote.minNetProfit"),
            first: MarketRebalancer.Leg(
                MarketRebalancer.Venue.AquaSwapVM,
                router,
                base,
                other,
                input,
                secondInput,
                empty,
                abi.encode(strategy, order)
            ),
            second: MarketRebalancer.Leg(
                MarketRebalancer.Venue.V3, externalPool, other, base, secondInput, quotedFinalFloor, empty, ""
            )
        });
        // Every state mutation here targets this local fork, not Arbitrum.
        vm.startPrank(owner);
        bot.setOperator(owner, true);
        bot.setLimits(base, 5e6, 10_000);
        bot.setGasPriceLimit(100 gwei);
        bot.setV3Pool(externalPool, true);
        bot.setSwapVMRouter(router, aqua, uint8(vm.parseJsonUint(cfg, ".quote.market.slices")), true);
        bot.setSwapVMStrategy(router, maker, strategy, true);
        bot.setPaused(false);
        vm.stopPrank();
        deal(base, address(bot), 5e6);
        assertEq(IERC20(other).balanceOf(address(bot)), 0, "No old intermediate inventory");
    }

    function testFork_ObservedQuoteExecutesAgainstActualVaultsWithoutPriceDisplacement() public {
        uint256 inputBefore = IERC20(base).balanceOf(inputVault);
        uint256 outputBefore = IERC20(other).balanceOf(outputVault);
        vm.recordLogs();
        vm.prank(owner);
        uint256 profit = bot.execute(trade);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(profit, expectedFinal - input);
        assertGe(profit, trade.minProfit);
        assertEq(IERC20(base).balanceOf(address(bot)), 5e6 + profit);
        assertEq(IERC20(other).balanceOf(address(bot)), expectedFirst - trade.second.amountIn);
        assertEq(IERC20(base).balanceOf(inputVault), inputBefore + input);
        assertEq(IERC20(other).balanceOf(outputVault), outputBefore - expectedFirst);
        uint256 sold;
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (
                l.emitter == outputVault && l.topics.length == 4
                    && l.topics[0] == keccak256("StrategyPrincipalSold(address,uint256,address,uint256)")
            ) {
                assertEq(uint256(l.topics[2]), classId);
                sold += abi.decode(l.data, (uint256));
                emit log_named_address("Actual liquidity source", address(uint160(uint256(l.topics[3]))));
            }
        }
        assertEq(sold, expectedFirst);
        assertEq(IERC20(base).allowance(address(bot), router), 0);
        assertEq(IERC20(other).allowance(maker, aqua), 0);
        assertTrue(bot.used(trade.id));
        emit log_named_uint("Input USDC raw", input);
        emit log_named_uint("Final received USDC raw", expectedFinal);
        emit log_named_uint("Trading gain USDC raw", profit);
        emit log_named_uint("Screening fee budget USDC raw, not a receipt", gasBudget);
        emit log_named_uint("Gain after screening budget USDC raw", profit - gasBudget);
    }

    function testFork_ObservedRouteImpossibleProfitRevertsActualVaultEffects() public {
        uint256 beforeIn = IERC20(base).balanceOf(inputVault);
        uint256 beforeOut = IERC20(other).balanceOf(outputVault);
        (uint256 v0, uint256 v1) = IProductionAqua(aqua).safeBalances(maker, router, orderHash, base, other);
        trade.minProfit = type(uint128).max;
        vm.prank(owner);
        vm.expectRevert(MarketRebalancer.Unprofitable.selector);
        bot.execute(trade);
        assertEq(IERC20(base).balanceOf(inputVault), beforeIn);
        assertEq(IERC20(other).balanceOf(outputVault), beforeOut);
        assertEq(IERC20(base).balanceOf(address(bot)), 5e6);
        assertEq(IERC20(other).balanceOf(address(bot)), 0);
        (uint256 a0, uint256 a1) = IProductionAqua(aqua).safeBalances(maker, router, orderHash, base, other);
        assertEq(a0, v0);
        assertEq(a1, v1);
        assertFalse(bot.used(trade.id));
    }
}
