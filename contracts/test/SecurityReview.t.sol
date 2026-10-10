// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MarketRebalancer, PoolKey} from "../src/MarketRebalancer.sol";
import {SwapVMVenue, ISwapVMVenue} from "../src/SwapVMVenue.sol";
import {Permit, Router} from "./MarketRebalancer.t.sol";

// Adversarial fixtures, not external-price or live-profit evidence.
contract ReviewToken is ERC20 {
    address public attackFrom;
    address public attackTarget;
    bytes public attackPayload;
    bool public tried;
    bool public succeeded;
    bytes4 public rejection;
    bool private inside;

    constructor() ERC20("Security review fixture", "FIX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address from, address target, bytes calldata payload) external {
        attackFrom = from;
        attackTarget = target;
        attackPayload = payload;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && from == attackFrom && !inside) {
            inside = true;
            tried = true;
            bytes memory result;
            (succeeded, result) = attackTarget.call(attackPayload);
            if (result.length >= 4) rejection = bytes4(result);
            inside = false;
        }
    }
}

contract ReviewCallbackSidecar {
    function probe(address bot, int256 d0, int256 d1) external returns (bool ok, bytes memory result) {
        return bot.call(abi.encodeWithSelector(MarketRebalancer.uniswapV3SwapCallback.selector, d0, d1, bytes("")));
    }
}

contract ReviewV3 {
    address public token0;
    address public token1;
    uint256 public mode;
    bytes public nestedTrade;
    bool public attackSucceeded;
    bytes4 public rejection;
    ReviewCallbackSidecar public sidecar = new ReviewCallbackSidecar();

    constructor(address a, address b) {
        token0 = a;
        token1 = b;
    }

    function configure(uint256 m, bytes calldata t) external {
        mode = m;
        nestedTrade = t;
    }

    function swap(address recipient, bool z, int256 amount, uint160, bytes calldata) external returns (int256, int256) {
        uint256 owed = uint256(amount);
        int256 d0 = z ? int256(owed) : int256(-1);
        int256 d1 = z ? int256(-1) : int256(owed);
        if (mode == 1) {
            bytes memory result;
            (attackSucceeded, result) = msg.sender.call(nestedTrade);
            if (result.length >= 4) rejection = bytes4(result);
        }
        if (mode == 3) {
            bytes memory result;
            (attackSucceeded, result) = sidecar.probe(msg.sender, d0, d1);
            if (result.length >= 4) rejection = bytes4(result);
        }
        if (mode == 4) {
            MarketRebalancer(msg.sender).uniswapV3SwapCallback(d1, d0, bytes(""));
        } else {
            MarketRebalancer(msg.sender).uniswapV3SwapCallback(d0, d1, bytes(""));
        }
        if (mode == 2) MarketRebalancer(msg.sender).uniswapV3SwapCallback(d0, d1, bytes(""));
        uint256 out = owed * 6 / 10;
        ReviewToken(z ? token1 : token0).mint(recipient, out);
        return (z ? int256(owed) : -int256(out), z ? -int256(out) : int256(owed));
    }
}

contract ReviewVMRouter {
    address public immutable AQUA;
    uint256 public mode;
    bytes public observedTakerData;

    constructor(address aqua) {
        AQUA = aqua;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function hash(ISwapVMVenue.Order calldata o) external pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    function swap(ISwapVMVenue.Order calldata o, address tokenIn, address tokenOut, uint256 amount, bytes calldata data)
        external
        returns (uint256 used, uint256 out, bytes32 orderHash)
    {
        observedTakerData = data;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), mode == 4 ? amount + 1 : amount);
        uint256 minted = amount * 2;
        if (mode != 3) ReviewToken(tokenOut).mint(msg.sender, minted);
        used = mode == 1 ? amount - 1 : amount;
        out = mode == 2 ? minted + 1 : minted;
        orderHash = mode == 5 ? bytes32(uint256(1)) : keccak256(abi.encode(o));
    }
}

contract ReviewMaker {
    address public immutable aqua;
    address public immutable aquaSwapVMRouter;
    bytes32 public constant stableId = keccak256("review-only-strategy");
    bytes32 public liveHash;
    address private a;
    address private b;

    constructor(address aqua_, address router_, address a_, address b_) {
        aqua = aqua_;
        aquaSwapVMRouter = router_;
        a = a_;
        b = b_;
        ISwapVMVenue.Order memory o = ISwapVMVenue.Order(address(this), uint256(1) << 254, hex"1100");
        liveHash = keccak256(abi.encode(o));
    }

    function currentAquaHash(bytes32 id) external view returns (bytes32) {
        return id == stableId ? liveHash : bytes32(0);
    }

    function strategyClassId(bytes32 id) external pure returns (uint256) {
        return id == stableId ? 7 : 0;
    }

    function getStrategyTokens(bytes32 id) external view returns (address[] memory out) {
        require(id == stableId);
        out = new address[](2);
        out[0] = a;
        out[1] = b;
    }
}

contract SecurityReviewTest is Test {
    MarketRebalancer bot;
    ReviewToken a;
    ReviewToken b;
    Permit permit;
    Router router;
    ReviewV3 v3;
    PoolKey pool;
    address owner;
    address operator;
    address outsider;
    uint256 constant CAPITAL = 1_000_000 ether;

    function setUp() public {
        owner = makeAddr("review-owner");
        operator = makeAddr("review-operator");
        outsider = makeAddr("review-outsider");
        ReviewToken x = new ReviewToken();
        ReviewToken y = new ReviewToken();
        (a, b) = address(x) < address(y) ? (x, y) : (y, x);
        permit = new Permit();
        router = new Router(permit);
        v3 = new ReviewV3(address(a), address(b));
        bot = new MarketRebalancer(owner, address(router), address(permit), address(a), false);
        pool = PoolKey(address(a), address(b), 3000, 60, address(a));
        vm.startPrank(owner);
        bot.setOperator(operator, true);
        bot.setLimits(address(a), CAPITAL, 1);
        bot.setAquaPool(pool, true);
        bot.setV3Pool(address(v3), true);
        bot.setGasPriceLimit(100 gwei);
        bot.setPaused(false);
        vm.stopPrank();
        a.mint(address(bot), CAPITAL);
    }

    function trade(uint256 input) internal view returns (MarketRebalancer.Trade memory t) {
        t.id = keccak256(abi.encode("security-review", input));
        t.deadline = block.timestamp + 60;
        t.validUntilBlock = block.number + 2;
        t.minProfit = 1;
        t.first = MarketRebalancer.Leg(
            MarketRebalancer.Venue.Aqua0V4,
            address(router),
            address(a),
            address(b),
            input,
            input * 19 / 10,
            pool,
            abi.encode(keccak256("AQUA0_JIT_PAYLOAD"))
        );
        t.second = MarketRebalancer.Leg(
            MarketRebalancer.Venue.V3, address(v3), address(b), address(a), input * 19 / 10, input + 1, pool, bytes("")
        );
    }

    function run(MarketRebalancer.Trade memory t) internal returns (uint256) {
        vm.prank(operator);
        return bot.execute(t);
    }

    function unchanged(MarketRebalancer.Trade memory t, uint256 oldB) internal view {
        assertEq(a.balanceOf(address(bot)), CAPITAL);
        assertEq(b.balanceOf(address(bot)), oldB);
        assertFalse(bot.used(t.id));
        assertEq(a.allowance(address(bot), address(permit)), 0);
        assertEq(permit.allowance(address(bot), address(a), address(router)), 0);
        assertEq(a.balanceOf(address(router)), 0);
        assertEq(b.balanceOf(address(v3)), 0);
    }

    function testFuzzOutsiderCannotExecuteWithdrawOrGrant(address caller) public {
        vm.assume(caller != owner && caller != operator);
        MarketRebalancer.Trade memory t = trade(100 ether);
        vm.prank(caller);
        vm.expectRevert(MarketRebalancer.Unauthorized.selector);
        bot.execute(t);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        bot.withdraw(address(a), caller, 1);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        bot.setOperator(caller, true);
        unchanged(t, 0);
    }

    function testSeparateOperatorCannotUseAnyOwnerEntryPoint() public {
        bytes[] memory calls = new bytes[](12);
        calls[0] = abi.encodeWithSelector(MarketRebalancer.setOperator.selector, operator, true);
        calls[1] = abi.encodeWithSelector(MarketRebalancer.setLimits.selector, address(a), CAPITAL * 2, 1);
        calls[2] = abi.encodeWithSelector(MarketRebalancer.setGasPriceLimit.selector, 200 gwei);
        calls[3] = abi.encodeWithSelector(MarketRebalancer.setPaused.selector, true);
        calls[4] = abi.encodeWithSelector(MarketRebalancer.setAquaPool.selector, pool, false);
        calls[5] = abi.encodeWithSelector(MarketRebalancer.setV3Pool.selector, address(v3), false);
        calls[6] = abi.encodeWithSelector(SwapVMVenue.setSwapVMRouter.selector, address(router), address(a), 10, false);
        calls[7] = abi.encodeWithSelector(
            SwapVMVenue.setSwapVMStrategy.selector, address(router), address(a), bytes32(uint256(1)), false
        );
        calls[8] = abi.encodeWithSelector(Ownable.transferOwnership.selector, operator);
        calls[9] = abi.encodeWithSelector(Ownable.renounceOwnership.selector);
        calls[10] = abi.encodeWithSelector(MarketRebalancer.withdraw.selector, address(a), operator, 1);
        calls[11] = abi.encodeWithSelector(Ownable2Step.acceptOwnership.selector);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(operator);
            (bool ok, bytes memory result) = address(bot).call(calls[i]);
            assertFalse(ok, "operator accessed an owner entry point");
            assertEq(result, abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        }
        assertEq(bot.owner(), owner);
        assertEq(a.balanceOf(address(bot)), CAPITAL);
        assertFalse(bot.paused());
    }

    // This passes by demonstrating a configuration risk, not a protective property.
    function testUnifiedOwnerOperatorCanWithdrawAndRaiseLimits() public {
        vm.prank(owner);
        bot.transferOwnership(operator);
        vm.startPrank(operator);
        bot.acceptOwnership();
        bot.setLimits(address(a), CAPITAL * 100, 1);
        bot.withdraw(address(a), operator, CAPITAL);
        vm.stopPrank();
        (uint256 maxInput,) = bot.limits(address(a));
        assertEq(maxInput, CAPITAL * 100);
        assertEq(a.balanceOf(address(bot)), 0);
        assertEq(a.balanceOf(operator), CAPITAL);
        assertTrue(bot.operators(operator));
        assertEq(bot.owner(), operator);
    }

    function testPendingOwnerAndOutsiderCannotTakeControlEarly() public {
        vm.prank(owner);
        bot.transferOwnership(operator);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        bot.withdraw(address(a), operator, 1);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        bot.acceptOwnership();
        assertEq(bot.owner(), owner);
        assertEq(bot.pendingOwner(), operator);
    }

    function testRevokedOperatorCannotSubmitOldTrade() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        vm.prank(owner);
        bot.setOperator(operator, false);
        vm.expectRevert(MarketRebalancer.Unauthorized.selector);
        run(t);
        unchanged(t, 0);
    }

    function testFuzzOldIntermediateInventoryCannotCoverSecondLeg(uint96 value, uint96 old) public {
        uint256 input = bound(uint256(value), 100, CAPITAL / 10);
        uint256 oldB = bound(uint256(old), 1, CAPITAL);
        b.mint(address(bot), oldB);
        MarketRebalancer.Trade memory t = trade(input);
        t.second.amountIn = input * 2 + 1;
        vm.expectRevert(MarketRebalancer.InsufficientOutput.selector);
        run(t);
        unchanged(t, oldB);
    }

    function testRepeatedCallbackCannotChargeTwiceAndRollsBack() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        v3.configure(2, bytes(""));
        vm.expectRevert(MarketRebalancer.BadCallback.selector);
        run(t);
        unchanged(t, 0);
    }

    function testWrongTokenCallbackCannotChargeInventory() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        v3.configure(4, bytes(""));
        vm.expectRevert(MarketRebalancer.BadCallback.selector);
        run(t);
        unchanged(t, 0);
    }

    function testDifferentSenderCannotUseOpenCallbackWindow() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        v3.configure(3, bytes(""));
        assertEq(run(t), 14 ether);
        assertFalse(v3.attackSucceeded());
        assertEq(v3.rejection(), MarketRebalancer.BadCallback.selector);
        assertEq(a.balanceOf(address(bot)), CAPITAL + 14 ether);
    }

    function testReentrantVenueIsBlockedEvenWithOperatorRole() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        vm.prank(owner);
        bot.setOperator(address(v3), true);
        v3.configure(1, abi.encodeWithSelector(MarketRebalancer.execute.selector, t));
        assertEq(run(t), 14 ether);
        assertFalse(v3.attackSucceeded());
        assertEq(v3.rejection(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function testReentrantTokenIsBlockedEvenWithOperatorRole() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        vm.prank(owner);
        bot.setOperator(address(a), true);
        a.arm(address(bot), address(bot), abi.encodeWithSelector(MarketRebalancer.execute.selector, t));
        assertEq(run(t), 14 ether);
        assertTrue(a.tried());
        assertFalse(a.succeeded());
        assertEq(a.rejection(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function testFuzzFinalLossRollsBackAllBalancesAndApprovals(uint96 value) public {
        uint256 input = bound(uint256(value), 100, CAPITAL / 10);
        MarketRebalancer.Trade memory t = trade(input);
        t.minProfit = input * 2 + 1;
        vm.expectRevert(MarketRebalancer.Unprofitable.selector);
        run(t);
        unchanged(t, 0);
    }

    function vmFixture()
        internal
        returns (ReviewVMRouter vmRouter, ReviewMaker maker, MarketRebalancer.Trade memory t)
    {
        vmRouter = new ReviewVMRouter(address(a));
        maker = new ReviewMaker(address(a), address(vmRouter), address(a), address(b));
        vm.startPrank(owner);
        bot.setSwapVMRouter(address(vmRouter), address(a), 10, true);
        bot.setSwapVMStrategy(address(vmRouter), address(maker), maker.stableId(), true);
        vm.stopPrank();
        t = trade(100 ether);
        PoolKey memory empty;
        t.first.pool = empty;
        t.first.venue = MarketRebalancer.Venue.AquaSwapVM;
        t.first.target = address(vmRouter);
        ISwapVMVenue.Order memory order = ISwapVMVenue.Order(address(maker), uint256(1) << 254, hex"1100");
        t.first.hookData = abi.encode(maker.stableId(), order);
    }

    function testSwapVMDishonestReturnsMissingOutputAndOverpullCannotPass() public {
        (ReviewVMRouter vmRouter,, MarketRebalancer.Trade memory t) = vmFixture();
        for (uint256 mode = 1; mode <= 5; ++mode) {
            vmRouter.setMode(mode);
            vm.prank(operator);
            (bool ok, bytes memory result) =
                address(bot).call(abi.encodeWithSelector(MarketRebalancer.execute.selector, t));
            assertFalse(ok);
            if (mode != 4) assertEq(bytes4(result), SwapVMVenue.SwapVMFillMismatch.selector);
            unchanged(t, 0);
            assertEq(a.balanceOf(address(vmRouter)), 0);
            assertEq(a.allowance(address(bot), address(vmRouter)), 0);
        }
    }

    function testSwapVMReceiverCannotBeOverriddenAndApprovalsAreCleared() public {
        (ReviewVMRouter vmRouter,, MarketRebalancer.Trade memory t) = vmFixture();
        // Appended garbage is not parsed into router callbacks or recipient overrides.
        t.first.hookData = bytes.concat(t.first.hookData, abi.encode(outsider));
        assertEq(run(t), 14 ether);
        bytes memory expected = new bytes(20);
        for (uint256 i; i < 10; ++i) {
            expected[i * 2 + 1] = bytes1(uint8(32));
        }
        expected = bytes.concat(expected, hex"0041", abi.encode(t.first.minOut));
        assertEq(vmRouter.observedTakerData(), expected);
        assertEq(a.allowance(address(bot), address(vmRouter)), 0);
        assertEq(b.balanceOf(outsider), 0);
    }

    function testSwapVMChangedRouterCodeAndUnapprovedMakerAreRefused() public {
        (ReviewVMRouter vmRouter, ReviewMaker maker, MarketRebalancer.Trade memory t) = vmFixture();
        bytes memory original = address(vmRouter).code;
        vm.etch(address(vmRouter), hex"00");
        vm.expectRevert(SwapVMVenue.SwapVMRouteInvalid.selector);
        run(t);
        unchanged(t, 0);
        vm.etch(address(vmRouter), original);
        ISwapVMVenue.Order memory bad = ISwapVMVenue.Order(outsider, uint256(1) << 254, hex"1100");
        t.first.hookData = abi.encode(maker.stableId(), bad);
        vm.expectRevert(SwapVMVenue.SwapVMRouteInvalid.selector);
        run(t);
        unchanged(t, 0);
    }

    function testFreshDeploymentHasNoPublicTakeoverOrTradingWindow() public {
        MarketRebalancer fresh = new MarketRebalancer(owner, address(router), address(permit), address(a), false);
        assertEq(fresh.owner(), owner);
        assertTrue(fresh.paused());
        assertFalse(fresh.operators(outsider));
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        fresh.setOperator(outsider, true);
    }

    function testNativeGasFundingMustNotBeSentDirectlyToExecutor() public {
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok,) = address(bot).call{value: 1 wei}(bytes(""));
        assertFalse(ok);
        assertEq(address(bot).balance, 0);
    }
}
