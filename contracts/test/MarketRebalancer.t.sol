// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketRebalancer, PoolKey} from "../src/MarketRebalancer.sol";

contract Token is ERC20 {
    constructor() ERC20("Test", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract Permit {
    mapping(address => mapping(address => mapping(address => uint160))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[msg.sender][token][spender] = amount;
    }

    function pull(address owner, address token, uint160 amount) external {
        allowance[owner][token][msg.sender] -= amount;
        IERC20(token).transferFrom(owner, msg.sender, amount);
    }
}

contract Router {
    Permit permit;
    uint256 public rate = 2e18;
    bool public partialFill;

    constructor(Permit p) {
        permit = p;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function setPartial(bool p) external {
        partialFill = p;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256) external payable {
        require(keccak256(commands) == keccak256(hex"10"));
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(keccak256(actions) == keccak256(hex"060c0f"));
        MarketRebalancer.ExactInputSingle memory p = abi.decode(params[0], (MarketRebalancer.ExactInputSingle));
        address tin = p.zeroForOne ? p.poolKey.currency0 : p.poolKey.currency1;
        address tout = p.zeroForOne ? p.poolKey.currency1 : p.poolKey.currency0;
        permit.pull(msg.sender, tin, partialFill ? p.amountIn / 2 : p.amountIn);
        Token(tout).mint(msg.sender, uint256(p.amountIn) * rate / 1e18);
    }
}

contract V3 {
    address public token0;
    address public token1;
    uint256 public rate = 6e17;
    bool public overcharge;
    bool public partialFill;

    constructor(address a, address b) {
        token0 = a;
        token1 = b;
    }

    function setOvercharge(bool value) external {
        overcharge = value;
    }

    function setPartial(bool value) external {
        partialFill = value;
    }

    function swap(address recipient, bool z, int256 amount, uint160, bytes calldata) external returns (int256, int256) {
        uint256 owed = uint256(amount);
        if (overcharge) owed++;
        if (partialFill) owed /= 2;
        MarketRebalancer(msg.sender).uniswapV3SwapCallback(z ? int256(owed) : -1, z ? -1 : int256(owed), bytes(""));
        uint256 output = uint256(amount) * rate / 1e18;
        Token(z ? token1 : token0).mint(recipient, output);
        return (z ? int256(owed) : -int256(output), z ? -int256(output) : int256(owed));
    }
}

contract MarketRebalancerTest is Test {
    MarketRebalancer rebalancer;
    Token a;
    Token b;
    Permit permit;
    Router router;
    V3 v3;
    PoolKey pool;

    function setUp() public {
        Token x = new Token();
        Token y = new Token();
        (a, b) = address(x) < address(y) ? (x, y) : (y, x);
        permit = new Permit();
        router = new Router(permit);
        v3 = new V3(address(a), address(b));
        rebalancer = new MarketRebalancer(address(this), address(router), address(permit), address(a), false);
        pool = PoolKey(address(a), address(b), 3000, 60, address(a));
        rebalancer.setOperator(address(this), true);
        rebalancer.setLimits(address(a), 1_000_000 ether, 1);
        rebalancer.setAquaPool(pool, true);
        rebalancer.setV3Pool(address(v3), true);
        rebalancer.setGasPriceLimit(100 gwei);
        rebalancer.setPaused(false);
        rebalancer.setActiveUntil(uint64(block.timestamp + 1 days));
        a.mint(address(rebalancer), 1_000_000 ether);
    }

    function trade(uint256 input) internal view returns (MarketRebalancer.Trade memory t) {
        t.id = keccak256("trade");
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

    function testExpensiveGasIsRejected() public {
        vm.txGasPrice(101 gwei);
        vm.expectRevert(MarketRebalancer.GasPriceExceeded.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testProfitableCyclePreservesCapitalAndClearsApprovals() public {
        uint256 beforeBalance = a.balanceOf(address(rebalancer));
        uint256 profit = rebalancer.execute(trade(100 ether));
        assertEq(profit, 14 ether);
        assertEq(a.balanceOf(address(rebalancer)), beforeBalance + profit);
        assertEq(a.allowance(address(rebalancer), address(permit)), 0);
        assertEq(permit.allowance(address(rebalancer), address(a), address(router)), 0);
    }

    function testFuzzSuccessfulCyclesIncreaseStartingBalance(uint96 input) public {
        input = uint96(bound(input, 100, 1_000_000 ether));
        uint256 beforeBalance = a.balanceOf(address(rebalancer));
        uint256 profit = rebalancer.execute(trade(input));
        assertGt(profit, 0);
        assertEq(a.balanceOf(address(rebalancer)), beforeBalance + profit);
    }

    function testLossRollsBackBothLegsAndReplayFlag() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        t.minProfit = 100 ether;
        vm.expectRevert(MarketRebalancer.Unprofitable.selector);
        rebalancer.execute(t);
        assertFalse(rebalancer.used(t.id));
        assertEq(a.balanceOf(address(rebalancer)), 1_000_000 ether);
        assertEq(b.balanceOf(address(rebalancer)), 0);
    }

    function testRejectsSpendingOldIntermediateBalance() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        b.mint(address(rebalancer), 1000 ether);
        t.second.amountIn = 201 ether;
        vm.expectRevert(MarketRebalancer.InsufficientOutput.selector);
        rebalancer.execute(t);
        assertEq(b.balanceOf(address(rebalancer)), 1000 ether);
    }

    function testOnlyOperatorCanExecute() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        vm.prank(address(8));
        vm.expectRevert(MarketRebalancer.Unauthorized.selector);
        rebalancer.execute(t);
    }

    function testPausedRejectsExecution() public {
        rebalancer.setPaused(true);
        vm.expectRevert(MarketRebalancer.Paused.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testExpiredTimestamp() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        vm.warp(t.deadline + 1);
        vm.expectRevert(MarketRebalancer.Expired.selector);
        rebalancer.execute(t);
    }

    function testExpiredBlock() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        vm.roll(t.validUntilBlock + 1);
        vm.expectRevert(MarketRebalancer.Expired.selector);
        rebalancer.execute(t);
    }

    function testExcessiveLifetime() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        t.deadline += 121;
        vm.expectRevert(MarketRebalancer.Expired.selector);
        rebalancer.execute(t);
    }

    function testReplayRejected() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        rebalancer.execute(t);
        vm.expectRevert(MarketRebalancer.Replayed.selector);
        rebalancer.execute(t);
    }

    function testTradeSizeCap() public {
        rebalancer.setLimits(address(a), 1 ether, 1);
        vm.expectRevert(MarketRebalancer.LimitExceeded.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testOwnerProfitFloor() public {
        rebalancer.setLimits(address(a), 1000 ether, 1 ether);
        vm.expectRevert(MarketRebalancer.LimitExceeded.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testNoZeroProfitTrade() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        t.minProfit = 0;
        vm.expectRevert(MarketRebalancer.LimitExceeded.selector);
        rebalancer.execute(t);
    }

    function testRequiresExactlyOneAquaLeg() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        t.second.venue = t.first.venue;
        vm.expectRevert(MarketRebalancer.InvalidRoute.selector);
        rebalancer.execute(t);
    }

    function testUnlistedV3Rejected() public {
        rebalancer.setV3Pool(address(v3), false);
        vm.expectRevert(MarketRebalancer.InvalidRoute.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testUnlistedAquaPoolRejected() public {
        rebalancer.setAquaPool(pool, false);
        vm.expectRevert(MarketRebalancer.InvalidRoute.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testMalformedHookDataRejected() public {
        MarketRebalancer.Trade memory t = trade(100 ether);
        t.first.hookData = hex"1234";
        vm.expectRevert(MarketRebalancer.InvalidRoute.selector);
        rebalancer.execute(t);
    }

    function testPartialAquaFillRejected() public {
        router.setPartial(true);
        vm.expectRevert(MarketRebalancer.PartialFill.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testPartialV3FillRejected() public {
        v3.setPartial(true);
        vm.expectRevert(MarketRebalancer.PartialFill.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testCallbackCannotOvercharge() public {
        v3.setOvercharge(true);
        vm.expectRevert(MarketRebalancer.BadCallback.selector);
        rebalancer.execute(trade(100 ether));
    }

    function testUnsolicitedCallbackRejected() public {
        vm.prank(address(v3));
        vm.expectRevert(MarketRebalancer.BadCallback.selector);
        rebalancer.uniswapV3SwapCallback(1, -1, bytes(""));
    }

    function testOperatorCannotWithdraw() public {
        rebalancer.setOperator(address(9), true);
        vm.prank(address(9));
        vm.expectRevert();
        rebalancer.withdraw(address(a), address(9), 1);
    }

    function testOwnerCanRecoverWhilePaused() public {
        rebalancer.setPaused(true);
        rebalancer.withdraw(address(a), address(this), 5 ether);
        assertEq(a.balanceOf(address(this)), 5 ether);
    }

    function testOwnershipTransferRequiresAcceptance() public {
        rebalancer.transferOwnership(address(9));
        assertEq(rebalancer.owner(), address(this));
        vm.prank(address(9));
        rebalancer.acceptOwnership();
        assertEq(rebalancer.owner(), address(9));
    }
}
