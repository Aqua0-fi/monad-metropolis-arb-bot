// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {ICompilerRebalancer, MarketRebalancer, PoolKey as ExecutorPoolKey} from "./generated/CompilerRebalancer.sol";
import {V4Adapter} from "aqua0/v4/V4Adapter.sol";
import {V4Types} from "aqua0/lib/Types.sol";
import {AssetVault} from "aqua0/vault/AssetVault.sol";
import {VaultRegistry} from "aqua0/vault/VaultRegistry.sol";
import {Roles} from "aqua0/lib/Roles.sol";
import {PoolKey} from "@uniswap/v4-core/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/interfaces/IPoolManager.sol";

interface IFactory {
    function getPool(address, address, uint24) external view returns (address);
}

interface IMarketPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
}

/// @dev Real tokens, V3 pool, V4 PoolManager, UniversalRouter and Permit2; local Aqua0 vaults/hook.
/// Only the local Aqua0 price and test inventory are seeded. No live key, admin or user funds are used.
contract MarketRebalancerForkTest is Test {
    ICompilerRebalancer rebalancer;
    V4Adapter hook;
    AssetVault vault0;
    AssetVault vault1;
    IPoolManager manager;
    PoolKey key;
    address token0;
    address token1;
    address v3;
    address router;
    uint160 marketSqrt;
    uint256 amount;
    uint24 poolFee;
    int24 tickSpacing;
    int24 lowerTick;
    int24 upperTick;
    uint128 jitLiquidity;
    uint256 signerPk = uint256(keccak256("aqua0.rebalancing.fork.signer"));
    uint256 strategistPk = uint256(keccak256("aqua0.rebalancing.fork.strategist"));
    uint256 constant CLASS = 1;

    function setUp() public {
        vm.createSelectFork(vm.envString("FORK_RPC_URL"), vm.envUint("FORK_BLOCK"));
        string memory config = vm.readFile("config/chains.json");
        string memory row = string.concat(".chains[", vm.toString(vm.envUint("FORK_CHAIN_INDEX")), "]");
        assertEq(block.chainid, vm.parseJsonUint(config, string.concat(row, ".chainId")));
        manager = IPoolManager(vm.parseJsonAddress(config, string.concat(row, ".poolManager")));
        router = vm.parseJsonAddress(config, string.concat(row, ".universalRouter"));
        // Optional TEST-ONLY pair fixture. The default remains the original registry pair.
        string memory pairPath = vm.envOr("FORK_PAIR_FIXTURE", string(""));
        bool customPair = bytes(pairPath).length != 0;
        string memory pairConfig = customPair ? vm.readFile(pairPath) : config;
        string memory poolRow = customPair ? ".pool" : string.concat(row, ".pools[0]");
        if (customPair) assertEq(vm.parseJsonUint(pairConfig, ".chainId"), block.chainid);
        token0 = vm.parseJsonAddress(pairConfig, string.concat(poolRow, ".currency0"));
        token1 = vm.parseJsonAddress(pairConfig, string.concat(poolRow, ".currency1"));
        require(token0 < token1, "Unsorted fixture currencies");
        uint256 fee = vm.parseJsonUint(pairConfig, string.concat(poolRow, ".fee"));
        uint256 spacing = vm.parseJsonUint(pairConfig, string.concat(poolRow, ".tickSpacing"));
        require(fee <= 1_000_000 && spacing > 0 && spacing <= 32767, "Invalid fixture pool key");
        poolFee = uint24(fee);
        tickSpacing = int24(int256(spacing));
        lowerTick = (-887272 / tickSpacing) * tickSpacing;
        upperTick = (887272 / tickSpacing) * tickSpacing;
        uint256 testLiquidity = customPair ? vm.parseJsonUint(pairConfig, ".jitLiquidity") : 1e18;
        require(testLiquidity > 0 && testLiquidity <= type(uint128).max, "Invalid fixture liquidity");
        jitLiquidity = uint128(testLiquidity);
        address factory = vm.parseJsonAddress(
            config, string.concat(row, ".venues[", vm.toString(vm.envOr("FORK_VENUE_INDEX", uint256(0))), "].factory")
        );
        uint24[4] memory fees = [uint24(500), 3000, 100, 10000];
        uint256 externalFee = customPair ? vm.parseJsonUint(pairConfig, ".externalFee") : 0;
        for (uint256 i; i < fees.length; i++) {
            if (customPair && fees[i] != externalFee) continue;
            address candidate = IFactory(factory).getPool(token0, token1, fees[i]);
            if (candidate != address(0) && IMarketPool(candidate).liquidity() > 0) {
                v3 = candidate;
                break;
            }
        }
        require(v3 != address(0), "No liquid external V3 pool for this pair at pinned block");
        (marketSqrt,,,,,,) = IMarketPool(v3).slot0();
        VaultRegistry registry = VaultRegistry(
            address(
                new ERC1967Proxy(
                    address(new VaultRegistry()),
                    abi.encodeCall(VaultRegistry.initialize, (address(this), address(this), address(this)))
                )
            )
        );
        vault0 = _vault(token0);
        vault1 = _vault(token1);
        registry.register(token0, address(vault0));
        registry.register(token1, address(vault1));
        address hookAddress =
            address((uint160(uint256(keccak256("market-rebalancer.fork.hook"))) & ~uint160(0x3fff)) | 0xc8);
        deployCodeTo(
            "V4Adapter.sol", abi.encode(manager, address(registry), address(this), vm.addr(signerPk), "1"), hookAddress
        );
        hook = V4Adapter(hookAddress);
        key = PoolKey(Currency.wrap(token0), Currency.wrap(token1), poolFee, tickSpacing, IHooks(hookAddress));
        hook.setJITPosition(key, lowerTick, upperTick);
        hook.setJitTriggerRouterAllowed(router, true);
        _fund(vault0, token0);
        _fund(vault1, token1);
        uint256 deadline = block.timestamp + 60;
        bytes32 approval =
            keccak256(abi.encode(hook.CLASS_APPROVAL_TYPEHASH(), keccak256(abi.encode(key)), CLASS, true, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strategistPk, _digest(approval));
        hook.approveClassForPool(key, CLASS, 0, deadline, abi.encodePacked(r, s, v));
        // The legacy Aqua0 fixtures compile unchanged with 0.8.34. The deployed executor is the
        // separately built production artifact pinned to 0.8.37, not an old compiler copy.
        rebalancer = ICompilerRebalancer(
            deployCode(
                "contracts/src/MarketRebalancer.sol:MarketRebalancer",
                abi.encode(
                    address(this),
                    router,
                    vm.parseJsonAddress(config, string.concat(row, ".permit2")),
                    hookAddress,
                    vm.parseJsonBool(config, string.concat(row, ".extendedV4Encoding"))
                )
            )
        );
        rebalancer.setOperator(address(this), true);
        amount = customPair
            ? vm.parseJsonUint(pairConfig, ".inputAmount")
            : (IERC20Metadata(token0).decimals() >= 18 ? 0.01 ether : 10 * 10 ** IERC20Metadata(token0).decimals());
        require(amount > 0 && amount <= type(uint128).max / 100, "Invalid test amount");
        rebalancer.setLimits(token0, amount * 100, 1);
        rebalancer.setAquaPool(ExecutorPoolKey(token0, token1, poolFee, tickSpacing, hookAddress), true);
        rebalancer.setV3Pool(v3, true);
        rebalancer.setGasPriceLimit(100 gwei);
        rebalancer.setPaused(false);
        rebalancer.setActiveUntil(uint64(block.timestamp + 1 days));
        deal(token0, address(rebalancer), amount * 10);
        emit log_named_uint("chain", block.chainid);
        emit log_named_uint("forkBlock", block.number);
        emit log_named_address("externalPool", v3);
        emit log_named_uint("v4Fee", poolFee);
        emit log_named_int("tickSpacing", tickSpacing);
        emit log_named_uint("inputAmount", amount);
    }

    function _vault(address token) private returns (AssetVault) {
        address beacon = address(new UpgradeableBeacon(address(new AssetVault()), address(this)));
        return AssetVault(
            address(
                new BeaconProxy(
                    beacon,
                    abi.encodeCall(
                        AssetVault.initialize,
                        (
                            IERC20(token),
                            "Market rebalancer fork",
                            "REBAL",
                            address(this),
                            address(this),
                            type(uint256).max
                        )
                    )
                )
            )
        );
    }

    function _fund(AssetVault vault, address token) private {
        uint256 inventory = 1_000_000 * 10 ** IERC20Metadata(token).decimals();
        vault.registerStrategy(CLASS, vm.addr(strategistPk));
        vault.grantRole(Roles.VENUE_SETTLER_ROLE, address(hook));
        deal(token, address(this), inventory);
        IERC20(token).approve(address(vault), inventory);
        vault.deposit(inventory, address(this));
        vault.setCommitment(CLASS, true);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("V4Adapter"),
                keccak256("1"),
                block.chainid,
                address(hook)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signed(bool zeroForOne, uint256 input) private view returns (bytes memory) {
        V4Types.V4Range[] memory ranges = new V4Types.V4Range[](1);
        ranges[0] = V4Types.V4Range(lowerTick, upperTick, jitLiquidity);
        uint160 sqrtLimit = zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341;
        V4Types.JITPayload memory p = V4Types.JITPayload(
            keccak256("testSwap"),
            keccak256(abi.encode(key)),
            CLASS,
            zeroForOne,
            -int256(input),
            sqrtLimit,
            1,
            block.timestamp + 60,
            router,
            bytes("")
        );
        bytes32 hash = keccak256(
            abi.encode(
                hook.V4_JIT_TYPEHASH(),
                p.swapId,
                p.poolId,
                p.classId,
                p.zeroForOne,
                p.amountSpecified,
                p.sqrtPriceLimitX96,
                p.nonce,
                p.deadline,
                p.executor,
                keccak256(abi.encode(ranges))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, _digest(hash));
        p.signature = abi.encodePacked(r, s, v);
        return abi.encode(hook.AQUA0_MAGIC(), abi.encode(p), ranges, bytes(""));
    }

    function _leg(bool aqua, bool zeroForOne, uint256 input) private view returns (MarketRebalancer.Leg memory) {
        return MarketRebalancer.Leg(
            MarketRebalancer.Venue.wrap(aqua ? 0 : 1),
            aqua ? router : v3,
            zeroForOne ? token0 : token1,
            zeroForOne ? token1 : token0,
            input,
            1,
            ExecutorPoolKey(token0, token1, poolFee, tickSpacing, address(hook)),
            aqua ? _signed(zeroForOne, input) : bytes("")
        );
    }

    function _trade(bool aquaFirst) private returns (MarketRebalancer.Trade memory trade) {
        manager.initialize(key, uint160(uint256(marketSqrt) * (aquaFirst ? 110 : 90) / 100));
        // Obtain the first leg's exact output by executing it in a revertible fork snapshot.
        // The executor then enforces the second leg uses only that newly acquired amount.
        trade = MarketRebalancer.Trade(
            keccak256("cycle"),
            block.timestamp + 60,
            block.number + 2,
            1,
            _leg(aquaFirst, true, amount),
            _leg(!aquaFirst, false, 1)
        );
        // The market quote is an actual PoolManager/UniversalRouter or V3 swap in the harness below.
        uint256 snapshot = vm.snapshotState();
        ForkLegProbe probe = new ForkLegProbe(router, rebalancer.permit2(), rebalancer.extendedV4Encoding());
        deal(token0, address(probe), amount);
        uint256 output = probe.swap(trade.first);
        vm.revertToState(snapshot);
        trade.second = _leg(!aquaFirst, false, output);
    }

    function testFork_AquaThenExternalProfits() public {
        _assertCycle(true);
    }

    function testFork_ExternalThenAquaProfits() public {
        _assertCycle(false);
    }

    function _assertCycle(bool aquaFirst) private {
        MarketRebalancer.Trade memory trade = _trade(aquaFirst);
        uint256 beforeBalance = IERC20(token0).balanceOf(address(rebalancer));
        uint256 gasBefore = gasleft();
        uint256 profit = rebalancer.execute(trade);
        uint256 usedGas = gasBefore - gasleft();
        assertGt(profit, 0);
        assertEq(IERC20(token0).balanceOf(address(rebalancer)), beforeBalance + profit);
        assertEq(vault0.sharedIdle(), IERC20(token0).balanceOf(address(vault0)));
        assertEq(vault1.sharedIdle(), IERC20(token1).balanceOf(address(vault1)));
        assertEq(IERC20(token0).allowance(address(rebalancer), rebalancer.permit2()), 0);
        assertEq(IERC20(token1).allowance(address(rebalancer), rebalancer.permit2()), 0);
        assertTrue(hook.usedNonces(1));
        emit log_named_uint("executionGas", usedGas);
        emit log_named_uint("profitRaw", profit);
    }

    function testFork_ImpossibleProfitRevertsBothLegsAndNonce() public {
        MarketRebalancer.Trade memory trade = _trade(true);
        trade.minProfit = type(uint128).max;
        uint256 beforeBalance = IERC20(token0).balanceOf(address(rebalancer));
        vm.expectRevert(ICompilerRebalancer.Unprofitable.selector);
        rebalancer.execute(trade);
        assertEq(IERC20(token0).balanceOf(address(rebalancer)), beforeBalance);
        assertFalse(rebalancer.used(trade.id));
        assertFalse(hook.usedNonces(1));
    }
}

import {IV3Pool, IUniversalRouter, IPermit2} from "./generated/CompilerRebalancer.sol";

/// @dev Test-only single-leg probe. Never deployed by the rebalancer or included in production sources.
contract ForkLegProbe {
    address router;
    address permit2;
    address token;
    address pool;
    bool extended;

    constructor(address r, address p, bool e) {
        router = r;
        permit2 = p;
        extended = e;
    }

    function swap(MarketRebalancer.Leg memory leg) external returns (uint256) {
        uint256 beforeBalance = IERC20(leg.tokenOut).balanceOf(address(this));
        if (MarketRebalancer.Venue.unwrap(leg.venue) == 0) {
            IERC20(leg.tokenIn).approve(permit2, leg.amountIn);
            IPermit2(permit2).approve(leg.tokenIn, router, uint160(leg.amountIn), uint48(block.timestamp + 60));
            bytes[] memory params = new bytes[](3);
            params[0] = extended
                ? abi.encode(
                    MarketRebalancer.ExtendedExactInputSingle(
                        leg.pool, leg.tokenIn == leg.pool.currency0, uint128(leg.amountIn), 1, 0, leg.hookData
                    )
                )
                : abi.encode(
                    MarketRebalancer.ExactInputSingle(
                        leg.pool, leg.tokenIn == leg.pool.currency0, uint128(leg.amountIn), 1, leg.hookData
                    )
                );
            params[1] = abi.encode(leg.tokenIn, leg.amountIn);
            params[2] = abi.encode(leg.tokenOut, 1);
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = abi.encode(hex"060c0f", params);
            IUniversalRouter(router).execute(hex"10", inputs, block.timestamp + 60);
        } else {
            token = leg.tokenIn;
            pool = leg.target;
            bool zeroForOne = leg.tokenIn == leg.pool.currency0;
            IV3Pool(pool)
                .swap(
                    address(this),
                    zeroForOne,
                    int256(leg.amountIn),
                    zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,
                    bytes("")
                );
        }
        return IERC20(leg.tokenOut).balanceOf(address(this)) - beforeBalance;
    }

    function uniswapV3SwapCallback(int256 a, int256 b, bytes calldata) external {
        require(msg.sender == pool);
        IERC20(token).transfer(pool, uint256(a > 0 ? a : b));
    }
}
