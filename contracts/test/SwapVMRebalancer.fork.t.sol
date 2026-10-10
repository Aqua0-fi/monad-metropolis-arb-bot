// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketRebalancer, PoolKey} from "../src/MarketRebalancer.sol";
import {SwapVMVenue, ISwapVMVenue} from "../src/SwapVMVenue.sol";
import {Permit, Router} from "./MarketRebalancer.t.sol";

interface IAquaFork {
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32);
    function safeBalances(address maker, address app, bytes32 hash, address a, address b)
        external
        view
        returns (uint256, uint256);
}

interface IV3ForkQuoter {
    struct Input {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }
    function quoteExactInputSingle(Input calldata params) external returns (uint256, uint160, uint32, uint256);
}

interface ISwapVMForkQuote {
    function quote(
        ISwapVMVenue.Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bytes calldata takerData
    ) external view returns (uint256, uint256, bytes32);
}

/// @dev Controlled maker on a real-router fork. It owns test funds; it is NOT the deployed Aqua0
/// vault adapter. Its identity getters let this suite isolate the executor/router interaction.
contract ForkVenueMaker {
    address public immutable aqua;
    address public immutable aquaSwapVMRouter;
    bytes32 public stableId;
    bytes32 public liveHash;
    uint256 public classId = 7;
    address[] private tokens;

    constructor(address a, address r) {
        aqua = a;
        aquaSwapVMRouter = r;
    }

    function ship(bytes memory bytes_, address a, address b, uint256 balanceA, uint256 balanceB) external {
        tokens.push(a);
        tokens.push(b);
        IERC20(a).approve(aqua, type(uint256).max);
        IERC20(b).approve(aqua, type(uint256).max);
        uint256[] memory balances = new uint256[](2);
        balances[0] = balanceA;
        balances[1] = balanceB;
        stableId = IAquaFork(aqua).ship(aquaSwapVMRouter, bytes_, tokens, balances);
        liveHash = stableId;
    }

    function currentAquaHash(bytes32 id) external view returns (bytes32) {
        return id == stableId ? liveHash : bytes32(0);
    }

    function strategyClassId(bytes32 id) external view returns (uint256) {
        return id == stableId ? classId : 0;
    }

    function getStrategyTokens(bytes32 id) external view returns (address[] memory) {
        require(id == stableId);
        return tokens;
    }

    function changeClass() external {
        classId++;
    }

    function invalidateProgram() external {
        liveHash = bytes32(uint256(1));
    }
}

contract SwapVMRebalancerForkTest is Test {
    address constant VM_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant V3_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    uint256 constant INPUT = 100e6;
    MarketRebalancer bot;
    ForkVenueMaker maker;
    ISwapVMVenue.Order order;
    IV3ForkQuoter quoter;

    function setUp() public {
        vm.createSelectFork(
            vm.envOr("BASE_RPC_URL", string("https://base-rpc.publicnode.com")), vm.envUint("SWAPVM_FORK_BLOCK")
        );
        assertEq(block.chainid, 8453);
        assertGt(VM_ROUTER.code.length, 0);
        assertGt(V3_POOL.code.length, 0);
        assertEq(ISwapVMVenue(VM_ROUTER).AQUA(), AQUA);
        // The quoter comes from the canonical generated worker configuration, not a guessed address.
        quoter = IV3ForkQuoter(vm.envAddress("SWAPVM_FORK_QUOTER"));
        Permit permit = new Permit();
        Router legacyRouter = new Router(permit);
        bot = new MarketRebalancer(address(this), address(legacyRouter), address(permit), WETH, false);
        bot.setOperator(address(this), true);
        bot.setLimits(USDC, 10_000e6, 1);
        bot.setGasPriceLimit(100 gwei);
        bot.setV3Pool(V3_POOL, true);
        bot.setSwapVMRouter(VM_ROUTER, AQUA, 10, true);
        bot.setPaused(false);
        deal(USDC, address(bot), 10_000e6);
    }

    function setupMaker(bool aquaFirst) internal returns (MarketRebalancer.Trade memory t) {
        (uint256 externalWeth,,,) = quoter.quoteExactInputSingle(IV3ForkQuoter.Input(USDC, WETH, INPUT, 500, 0));
        maker = new ForkVenueMaker(AQUA, VM_ROUTER);
        uint256 reserveUsdc = INPUT * (aquaFirst ? 10000 : 20000);
        uint256 reserveWeth = externalWeth * (aquaFirst ? 20000 : 10000);
        deal(USDC, address(maker), reserveUsdc);
        deal(WETH, address(maker), reserveWeth);
        // Opcode 17 is the bound router's execution-proven constant-product instruction.
        order = ISwapVMVenue.Order(address(maker), uint256(1) << 254, hex"1100");
        maker.ship(abi.encode(order), USDC, WETH, reserveUsdc, reserveWeth);
        bot.setSwapVMStrategy(VM_ROUTER, address(maker), maker.stableId(), true);
        bytes memory quoteData = abi.encodePacked(new bytes(20), uint16(0x0041));
        uint256 firstOut;
        uint256 finalOut;
        if (aquaFirst) {
            (, firstOut,) = ISwapVMForkQuote(VM_ROUTER).quote(order, USDC, WETH, INPUT, quoteData);
            (finalOut,,,) = quoter.quoteExactInputSingle(IV3ForkQuoter.Input(WETH, USDC, firstOut * 999 / 1000, 500, 0));
        } else {
            firstOut = externalWeth;
            (, finalOut,) = ISwapVMForkQuote(VM_ROUTER).quote(order, WETH, USDC, firstOut * 999 / 1000, quoteData);
        }
        require(finalOut > INPUT + 1e6, "fixture must have a real quoted profit");
        PoolKey memory empty;
        t.id = keccak256(abi.encode("real-router-cycle", aquaFirst));
        t.deadline = block.timestamp + 60;
        t.validUntilBlock = block.number + 2;
        t.minProfit = 1e6;
        t.first = MarketRebalancer.Leg(
            aquaFirst ? MarketRebalancer.Venue.AquaSwapVM : MarketRebalancer.Venue.V3,
            aquaFirst ? VM_ROUTER : V3_POOL,
            USDC,
            WETH,
            INPUT,
            firstOut * 999 / 1000,
            empty,
            aquaFirst ? abi.encode(maker.stableId(), order) : bytes("")
        );
        t.second = MarketRebalancer.Leg(
            aquaFirst ? MarketRebalancer.Venue.V3 : MarketRebalancer.Venue.AquaSwapVM,
            aquaFirst ? V3_POOL : VM_ROUTER,
            WETH,
            USDC,
            firstOut * 999 / 1000,
            finalOut * 999 / 1000,
            empty,
            aquaFirst ? bytes("") : abi.encode(maker.stableId(), order)
        );
    }

    function runCycle(bool aquaFirst) internal {
        MarketRebalancer.Trade memory t = setupMaker(aquaFirst);
        uint256 before = IERC20(USDC).balanceOf(address(bot));
        vm.recordLogs();
        uint256 profit = bot.execute(t);
        Vm.Log[] memory emitted = vm.getRecordedLogs();
        bytes32 signature =
            keccak256("SwapVMLegExecuted(address,address,bytes32,bytes32,uint256,address,address,uint256,uint256)");
        uint256 matching;
        for (uint256 i; i < emitted.length; i++) {
            if (emitted[i].emitter != address(bot) || emitted[i].topics[0] != signature) continue;
            matching++;
            assertEq(address(uint160(uint256(emitted[i].topics[1]))), VM_ROUTER);
            assertEq(address(uint160(uint256(emitted[i].topics[2]))), address(maker));
            assertEq(emitted[i].topics[3], maker.stableId());
            (bytes32 hash, uint256 classId, address tokenIn, address tokenOut, uint256 usedIn, uint256 out) =
                abi.decode(emitted[i].data, (bytes32, uint256, address, address, uint256, uint256));
            MarketRebalancer.Leg memory leg = aquaFirst ? t.first : t.second;
            assertEq(hash, maker.liveHash());
            assertEq(classId, maker.classId());
            assertEq(tokenIn, leg.tokenIn);
            assertEq(tokenOut, leg.tokenOut);
            assertEq(usedIn, leg.amountIn);
            assertGe(out, leg.minOut);
        }
        assertEq(matching, 1, "one fully bound receipt anchor per SwapVM leg");
        assertGe(profit, t.minProfit);
        assertEq(IERC20(USDC).balanceOf(address(bot)), before + profit);
        assertEq(IERC20(USDC).allowance(address(bot), VM_ROUTER), 0);
        assertEq(IERC20(WETH).allowance(address(bot), VM_ROUTER), 0);
        assertTrue(bot.used(t.id));
        vm.expectRevert(MarketRebalancer.Replayed.selector);
        bot.execute(t);
    }

    function testFork_SwapVMThenRealV3AtomicProfit() public {
        runCycle(true);
    }

    function testFork_RealV3ThenSwapVMAtomicProfit() public {
        runCycle(false);
    }

    function testFork_UnprofitableCycleRestoresTokensVirtualBalancesAndReplayState() public {
        MarketRebalancer.Trade memory t = setupMaker(true);
        (uint256 virtualA, uint256 virtualB) =
            IAquaFork(AQUA).safeBalances(address(maker), VM_ROUTER, maker.liveHash(), USDC, WETH);
        uint256 before = IERC20(USDC).balanceOf(address(bot));
        uint256 makerBefore = IERC20(WETH).balanceOf(address(maker));
        t.minProfit = 1_000_000e6;
        vm.expectRevert(MarketRebalancer.Unprofitable.selector);
        bot.execute(t);
        assertEq(IERC20(USDC).balanceOf(address(bot)), before);
        assertEq(IERC20(WETH).balanceOf(address(maker)), makerBefore);
        (uint256 afterA, uint256 afterB) =
            IAquaFork(AQUA).safeBalances(address(maker), VM_ROUTER, maker.liveHash(), USDC, WETH);
        assertEq(afterA, virtualA);
        assertEq(afterB, virtualB);
        assertFalse(bot.used(t.id));
        assertEq(IERC20(USDC).allowance(address(bot), VM_ROUTER), 0);
    }

    function testFork_StaleProgramAndChangedClassAreRefusedBeforeSpending() public {
        MarketRebalancer.Trade memory t = setupMaker(true);
        maker.changeClass();
        vm.expectRevert(SwapVMVenue.SwapVMRouteInvalid.selector);
        bot.execute(t);
        bot.setSwapVMStrategy(VM_ROUTER, address(maker), maker.stableId(), true);
        maker.invalidateProgram();
        vm.expectRevert(SwapVMVenue.SwapVMRouteInvalid.selector);
        bot.execute(t);
        assertFalse(bot.used(t.id));
        assertEq(IERC20(USDC).balanceOf(address(bot)), 10_000e6);
    }

    function testFork_TooHighMinimumOutputRevertsWholeCycle() public {
        MarketRebalancer.Trade memory t = setupMaker(false);
        t.second.minOut = 1_000_000e6;
        vm.expectRevert();
        bot.execute(t);
        assertFalse(bot.used(t.id));
        assertEq(IERC20(USDC).balanceOf(address(bot)), 10_000e6);
    }
}
