// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketRebalancer, PoolKey} from "../src/MarketRebalancer.sol";
import {ProfitReturnDistributor} from "../src/ProfitReturnDistributor.sol";
import {ISwapVMVenue, IFleetAquaMaker} from "../src/SwapVMVenue.sol";

interface IProductionRegistry {
    function vaultForAsset(address token) external view returns (address);
}

interface IProductionVaultCapacity {
    function availableFor(uint256) external view returns (uint256);
    function committersOf(uint256) external view returns (address[] memory);
    function freePrincipal(address) external view returns (uint256);
}

interface IProductionMaker {
    function registry() external view returns (address);
}

interface IProductionVMQuote {
    function quote(ISwapVMVenue.Order calldata, address, address, uint256, bytes calldata)
        external
        view
        returns (uint256, uint256, bytes32);
}

interface IProductionV3 {
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

interface IProductionQuoter {
    struct Input {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }
    function quoteExactInputSingle(Input calldata) external returns (uint256, uint160, uint32, uint256);
}

interface IProductionAqua {
    function safeBalances(address, address, bytes32, address, address) external view returns (uint256, uint256);
}

/// Uses the ACTUAL deployed Aqua0 maker and vaults. Only local bot/test-trader balances are seeded.
/// Profitable cycles additionally displace the real external pool through a local test swap.
contract ProductionAquaAdapterForkTest is Test {
    address router;
    address aqua;
    address maker;
    address token0;
    address token1;
    address externalPool;
    address vault0;
    address vault1;
    bytes32 strategyId;
    bytes32 orderHash;
    uint256 classId;
    uint24 fee;
    MarketRebalancer bot;
    IProductionQuoter quoter;
    ISwapVMVenue.Order order;
    bool private displacing;
    uint256 private callbackBudget;
    address private callbackToken;
    uint256 constant INPUT = 1e6;
    bytes32 constant SOLD = keccak256("StrategyPrincipalSold(address,uint256,address,uint256)");
    bytes32 constant SETTLED = keccak256("ClassVenueSettled(address,uint256,address,int256)");

    function setUp() public {
        string memory cfg =
            vm.readFile(vm.envOr("PRODUCTION_MAKER_FIXTURE", string("config/production-maker-fork.json")));
        vm.createSelectFork(
            vm.envOr("PRODUCTION_MAKER_RPC_URL", vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"))),
            vm.parseJsonUint(cfg, ".block")
        );
        assertEq(block.chainid, vm.envOr("PRODUCTION_MAKER_CHAIN_ID", uint256(8453)));
        router = vm.parseJsonAddress(cfg, ".router");
        aqua = vm.parseJsonAddress(cfg, ".aqua");
        maker = vm.parseJsonAddress(cfg, ".maker");
        token0 = vm.parseJsonAddress(cfg, ".token0");
        token1 = vm.parseJsonAddress(cfg, ".token1");
        externalPool = vm.parseJsonAddress(cfg, ".externalPool");
        strategyId = vm.parseJsonBytes32(cfg, ".strategyId");
        orderHash = vm.parseJsonBytes32(cfg, ".orderHash");
        classId = vm.parseJsonUint(cfg, ".classId");
        fee = uint24(vm.parseJsonUint(cfg, ".externalFee"));
        quoter = IProductionQuoter(vm.parseJsonAddress(cfg, ".quoter"));
        order = ISwapVMVenue.Order(
            maker, vm.parseUint(vm.parseJsonString(cfg, ".traits")), vm.parseJsonBytes(cfg, ".program")
        );
        assertEq(maker.codehash, vm.parseJsonBytes32(cfg, ".makerCodeHash"));
        assertEq(IFleetAquaMaker(maker).currentAquaHash(strategyId), orderHash);
        assertEq(ISwapVMVenue(router).hash(order), orderHash);
        assertEq(IFleetAquaMaker(maker).strategyClassId(strategyId), classId);
        assertEq(IFleetAquaMaker(maker).aquaSwapVMRouter(), router);
        address registry = IProductionMaker(maker).registry();
        vault0 = IProductionRegistry(registry).vaultForAsset(token0);
        vault1 = IProductionRegistry(registry).vaultForAsset(token1);
        assertGt(vault0.code.length, 0);
        assertGt(vault1.code.length, 0);
        emit log_named_address("Production maker", maker);
        emit log_named_address("Input vault", vault0);
        emit log_named_address("Output vault", vault1);
        bot = new MarketRebalancer(
            address(this),
            vm.parseJsonAddress(cfg, ".universalRouter"),
            vm.parseJsonAddress(cfg, ".permit2"),
            vm.parseJsonAddress(cfg, ".hook"),
            false
        );
        bot.setOperator(address(this), true);
        bot.setLimits(token0, 5e6, 1);
        bot.setLimits(token1, 5e6, 1);
        bot.setGasPriceLimit(100 gwei);
        bot.setV3Pool(externalPool, true);
        bot.setSwapVMRouter(router, aqua, 10, true);
        bot.setSwapVMStrategy(router, maker, strategyId, true);
        bot.setPaused(false);
        deal(token0, address(bot), 5e6);
        deal(token1, address(bot), 5e6);
    }

    function taker(uint256 floor) internal pure returns (bytes memory data) {
        data = new bytes(20);
        for (uint256 i; i < 10; i++) {
            data[2 * i + 1] = bytes1(uint8(32));
        }
        data = bytes.concat(data, hex"0041", abi.encode(floor));
    }

    function quoteVM(address input, address output, uint256 amount) internal view returns (uint256 out) {
        (uint256 used, uint256 result, bytes32 hash) = IProductionVMQuote(router)
            .quote(order, input, output, amount, abi.encodePacked(new bytes(20), uint16(0x0041)));
        assertEq(used, amount);
        assertEq(hash, orderHash);
        assertGt(result, 0);
        return result;
    }

    function checkVaultEvents(Vm.Log[] memory logs, address outputVault, address inputVault, uint256 out, uint256 input)
        internal
        pure
    {
        uint256 sold;
        uint256 outSettlements;
        uint256 inSettlements;
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.topics.length != 4) continue;
            if (l.emitter == outputVault && l.topics[0] == SOLD) sold += abi.decode(l.data, (uint256));
            if (l.topics[0] == SETTLED) {
                int256 delta = abi.decode(l.data, (int256));
                if (l.emitter == outputVault && delta < 0) outSettlements += uint256(-delta);
                if (l.emitter == inputVault && delta > 0) inSettlements += uint256(delta);
            }
        }
        assertEq(sold, out, "Actual per-LP principal sales must equal delivered output");
        assertEq(outSettlements, out);
        assertEq(inSettlements, input);
    }

    function direct(bool zeroForOne) internal {
        address input = zeroForOne ? token0 : token1;
        address output = zeroForOne ? token1 : token0;
        address iv = zeroForOne ? vault0 : vault1;
        address ov = zeroForOne ? vault1 : vault0;
        uint256 expected = quoteVM(input, output, INPUT);
        uint256 beforeOut = IERC20(output).balanceOf(address(bot));
        uint256 beforeIn = IERC20(input).balanceOf(address(bot));
        uint256 inVault = IERC20(input).balanceOf(iv);
        uint256 outVault = IERC20(output).balanceOf(ov);
        vm.prank(address(bot));
        IERC20(input).approve(router, INPUT);
        vm.recordLogs();
        vm.prank(address(bot));
        (uint256 used, uint256 out, bytes32 hash) =
            ISwapVMVenue(router).swap(order, input, output, INPUT, taker(expected));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(used, INPUT);
        assertEq(out, expected);
        assertEq(hash, orderHash);
        assertEq(IERC20(input).balanceOf(address(bot)), beforeIn - INPUT);
        assertEq(IERC20(output).balanceOf(address(bot)), beforeOut + out);
        assertEq(IERC20(input).balanceOf(iv), inVault + INPUT);
        assertEq(IERC20(output).balanceOf(ov), outVault - out);
        assertEq(IERC20(input).allowance(address(bot), router), 0);
        assertEq(IERC20(output).allowance(maker, aqua), 0);
        assertEq(IERC20(input).allowance(maker, iv), 0);
        checkVaultEvents(logs, ov, iv, out, INPUT);
        emit log_named_uint("Actual input", INPUT);
        emit log_named_uint("Actual output", out);
    }

    function testFork_ActualProductionVaults_USDCToUSDT() public {
        direct(true);
    }

    function testFork_ActualProductionVaults_USDTToUSDC() public {
        direct(false);
    }

    function displace(bool zeroForOne, uint256 amount) internal {
        callbackToken = zeroForOne ? token0 : token1;
        callbackBudget = amount;
        deal(callbackToken, address(this), callbackBudget);
        displacing = true;
        IProductionV3(externalPool)
            .swap(
                address(this),
                zeroForOne,
                int256(callbackBudget),
                zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
                bytes("")
            );
        displacing = false;
        callbackBudget = 0;
        callbackToken = address(0);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(displacing && msg.sender == externalPool);
        uint256 amount = uint256(d0 > 0 ? d0 : d1);
        require(amount <= callbackBudget);
        callbackBudget -= amount;
        IERC20(callbackToken).transfer(msg.sender, amount);
    }

    function physicalCapacity(address vault) internal view returns (uint256) {
        IProductionVaultCapacity v = IProductionVaultCapacity(vault);
        uint256 available = v.availableFor(classId);
        address[] memory lps = v.committersOf(classId);
        require(lps.length <= 256, "Unbounded production committer set");
        uint256 free;
        for (uint256 i; i < lps.length; i++) {
            free += v.freePrincipal(lps[i]);
        }
        return available < free ? available : free;
    }

    function cycle(bool aquaFirst) internal returns (MarketRebalancer.Trade memory t) {
        // Search bounded local displacement rather than draining the real tiny vault's curve.
        // Neither real LP balances, commitments nor the shipped program are changed.
        uint256 firstOut;
        uint256 finalOut;
        uint256 cap = physicalCapacity(aquaFirst ? vault1 : vault0);
        bool found;
        // Different external pools need different local-only displacement budgets.
        // This never changes INPUT, actual vault backing or any production permission.
        uint256 steps = vm.envOr("PRODUCTION_TEST_DISPLACEMENT_STEPS", uint256(12));
        require(steps > 0 && steps <= 24, "Invalid local displacement search bound");
        for (uint256 attempt; attempt < steps; attempt++) {
            uint256 snapshot = vm.snapshotState();
            displace(aquaFirst, uint256(1e6) << attempt);
            if (aquaFirst) {
                firstOut = quoteVM(token0, token1, INPUT);
                (finalOut,,,) = quoter.quoteExactInputSingle(IProductionQuoter.Input(token1, token0, firstOut, fee, 0));
            } else {
                (firstOut,,,) = quoter.quoteExactInputSingle(IProductionQuoter.Input(token0, token1, INPUT, fee, 0));
                finalOut = quoteVM(token1, token0, firstOut);
            }
            uint256 physicalOutput = aquaFirst ? firstOut : finalOut;
            if (finalOut > INPUT && physicalOutput <= cap) {
                found = true;
                emit log_named_uint("Synthetic external displacement", uint256(1e6) << attempt);
                break;
            }
            require(vm.revertToState(snapshot), "Failed to restore trial state");
        }
        require(found, "No profitable bounded-displacement fixture within actual vault backing");
        emit log_named_uint("Actual physical output capacity", cap);
        emit log_named_uint("Round trip quoted output", finalOut);
        PoolKey memory empty;
        t.id = keccak256(abi.encode("production-maker-local-test", aquaFirst));
        t.deadline = block.timestamp + 60;
        t.validUntilBlock = block.number + 2;
        t.minProfit = 1;
        t.first = MarketRebalancer.Leg(
            aquaFirst ? MarketRebalancer.Venue.AquaSwapVM : MarketRebalancer.Venue.V3,
            aquaFirst ? router : externalPool,
            token0,
            token1,
            INPUT,
            firstOut,
            empty,
            aquaFirst ? abi.encode(strategyId, order) : bytes("")
        );
        t.second = MarketRebalancer.Leg(
            aquaFirst ? MarketRebalancer.Venue.V3 : MarketRebalancer.Venue.AquaSwapVM,
            aquaFirst ? externalPool : router,
            token1,
            token0,
            firstOut,
            finalOut,
            empty,
            aquaFirst ? bytes("") : abi.encode(strategyId, order)
        );
    }

    function profitable(bool aquaFirst) internal {
        MarketRebalancer.Trade memory t = cycle(aquaFirst);
        uint256 beforeBalance = IERC20(token0).balanceOf(address(bot));
        vm.recordLogs();
        uint256 profit = bot.execute(t);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(profit, 0);
        assertEq(IERC20(token0).balanceOf(address(bot)), beforeBalance + profit);
        assertTrue(bot.used(t.id));
        checkVaultEvents(
            logs,
            aquaFirst ? vault1 : vault0,
            aquaFirst ? vault0 : vault1,
            aquaFirst ? t.second.amountIn : t.second.minOut,
            aquaFirst ? INPUT : t.second.amountIn
        );
        assertEq(IERC20(token0).allowance(address(bot), router), 0);
        assertEq(IERC20(token1).allowance(address(bot), router), 0);
        emit log_named_uint("Actual guarded profit", profit);
    }

    function testFork_ProductionMakerThenExternalV3_AtomicProfit() public {
        profitable(true);
    }

    function testFork_ExternalV3ThenProductionMaker_AtomicProfit() public {
        profitable(false);
    }

    function testFork_ProductionMaker_LosingCycleRestoresVaultsAndVirtualBalances() public {
        MarketRebalancer.Trade memory t = cycle(true);
        uint256 b0 = IERC20(token0).balanceOf(vault0);
        uint256 b1 = IERC20(token1).balanceOf(vault1);
        (uint256 v0, uint256 v1) = IProductionAqua(aqua).safeBalances(maker, router, orderHash, token0, token1);
        t.minProfit = type(uint128).max;
        vm.expectRevert(MarketRebalancer.Unprofitable.selector);
        bot.execute(t);
        assertEq(IERC20(token0).balanceOf(vault0), b0);
        assertEq(IERC20(token1).balanceOf(vault1), b1);
        assertEq(IERC20(token0).balanceOf(address(bot)), 5e6);
        (uint256 a0, uint256 a1) = IProductionAqua(aqua).safeBalances(maker, router, orderHash, token0, token1);
        assertEq(a0, v0);
        assertEq(a1, v1);
        assertFalse(bot.used(t.id));
    }

    function testFork_ActualVaultSourcesReceiveNinetyPercentOfLocalNetProfit() public {
        // Foundry-only transaction has zero gas price. This proves the payout path, not live economics.
        vm.txGasPrice(0);
        MarketRebalancer.Trade memory t = cycle(true);
        vm.recordLogs();
        uint256 profit = bot.execute(t);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[] memory lp = new address[](logs.length);
        uint256[] memory principal = new uint256[](logs.length);
        uint256 count;
        uint256 total;
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (
                l.emitter != vault1 || l.topics.length != 4 || l.topics[0] != SOLD
                    || address(uint160(uint256(l.topics[1]))) != vault1 || uint256(l.topics[2]) != classId
            ) continue;
            address source = address(uint160(uint256(l.topics[3])));
            uint256 sold = abi.decode(l.data, (uint256));
            assertGt(sold, 0);
            uint256 j;
            for (; j < count && lp[j] != source; j++) {}
            if (j == count) lp[count++] = source;
            principal[j] += sold;
            total += sold;
        }
        assertGt(count, 0);
        assertLe(count, 100);
        assertEq(total, t.first.minOut);
        for (uint256 i; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (lp[j] < lp[i]) {
                    (lp[i], lp[j]) = (lp[j], lp[i]);
                    (principal[i], principal[j]) = (principal[j], principal[i]);
                }
            }
        }
        uint256 returned = profit * 9 / 10;
        uint256[] memory shares = new uint256[](count);
        uint256[] memory remainder = new uint256[](count);
        uint256 allocated;
        for (uint256 i; i < count; i++) {
            shares[i] = returned * principal[i] / total;
            remainder[i] = returned * principal[i] % total;
            allocated += shares[i];
        }
        while (allocated < returned) {
            uint256 best;
            for (uint256 i = 1; i < count; i++) {
                if (remainder[i] > remainder[best]) best = i;
            }
            shares[best]++;
            remainder[best] = 0;
            allocated++;
        }
        uint256 positive;
        for (uint256 i; i < count; i++) {
            if (shares[i] > 0) positive++;
        }
        address[] memory recipients = new address[](positive);
        uint256[] memory amounts = new uint256[](positive);
        uint256[] memory beforeBalances = new uint256[](positive);
        uint256 next;
        for (uint256 i; i < count; i++) {
            if (shares[i] == 0) continue;
            recipients[next] = lp[i];
            amounts[next] = shares[i];
            beforeBalances[next] = IERC20(token0).balanceOf(lp[i]);
            next++;
        }
        bot.withdraw(token0, address(this), profit);
        assertEq(IERC20(token0).balanceOf(address(bot)), 5e6, "Operating principal stays in executor");
        ProfitReturnDistributor distributor = new ProfitReturnDistributor(address(this), address(bot), token0);
        IERC20(token0).approve(address(distributor), returned);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256(abi.encode("synthetic-local-execution-id", t.id));
        distributor.distribute(ids, keccak256(abi.encode(logs)), profit, recipients, amounts);
        for (uint256 i; i < positive; i++) {
            assertEq(IERC20(token0).balanceOf(recipients[i]), beforeBalances[i] + amounts[i]);
        }
        assertEq(IERC20(token0).balanceOf(address(distributor)), 0);
        assertEq(IERC20(token0).allowance(address(this), address(distributor)), 0);
        assertTrue(distributor.processed(ids[0]));
        emit log_named_uint("Actual local cycle profit", profit);
        emit log_named_uint("Returned to actual LP source wallets", returned);
        emit log_named_uint("LP recipients", positive);
    }
}
