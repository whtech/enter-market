// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/EnterMarket.sol";

contract Rejecter {
    function vote(EnterMarket m, uint256 id, uint8 option) external {
        m.answer(id, option);
    }
}

contract EnterMarketTest is Test {
    EnterMarket market;
    address agent = makeAddr("agent");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        market = new EnterMarket();
        vm.deal(agent, 10 ether);
    }

    function _ask(uint16 quorum) internal returns (uint256) {
        string[] memory options = new string[](3);
        options[0] = "A";
        options[1] = "B";
        options[2] = "C";
        vm.prank(agent);
        return market.ask{ value: 0.3 ether }("Which tagline?", options, quorum, 60);
    }

    function testQuorumSettlesAndPaysMajority() public {
        uint256 id = _ask(3);
        vm.prank(alice);
        market.answer(id, 1);
        vm.prank(bob);
        market.answer(id, 1);
        vm.prank(carol);
        market.answer(id, 0);

        EnterMarket.Question memory q = market.getQuestion(id);
        assertTrue(q.settled);
        assertEq(q.winner, 1);
        assertEq(alice.balance, 0);
        assertEq(market.pendingPayouts(id), 3);

        market.payout(id, 50);
        assertEq(market.pendingPayouts(id), 0);
        assertEq(alice.balance, 0.15 ether);
        assertEq(bob.balance, 0.15 ether);
        assertEq(carol.balance, 0);
        assertEq(address(market).balance, 0);
    }

    function testDoubleAnswerReverts() public {
        uint256 id = _ask(3);
        vm.startPrank(alice);
        market.answer(id, 0);
        vm.expectRevert(EnterMarket.AlreadyAnswered.selector);
        market.answer(id, 1);
        vm.stopPrank();
    }

    function testDeadlineSettleAndTieGoesToLowestIndex() public {
        uint256 id = _ask(10);
        vm.prank(alice);
        market.answer(id, 2);
        vm.prank(bob);
        market.answer(id, 1);

        vm.expectRevert(EnterMarket.NotSettleable.selector);
        market.settle(id);

        vm.warp(block.timestamp + 61);
        vm.prank(carol);
        vm.expectRevert(EnterMarket.Closed.selector);
        market.answer(id, 0);

        market.settle(id);
        assertEq(market.getQuestion(id).winner, 1);
        market.payout(id, 50);
        assertEq(bob.balance, 0.3 ether);
        assertEq(alice.balance, 0);
    }

    function testRefundWhenNobodyAnswers() public {
        uint256 id = _ask(3);
        vm.warp(block.timestamp + 61);
        market.settle(id);
        assertEq(agent.balance, 10 ether);
        assertEq(market.getQuestion(id).winner, market.NO_WINNER());
    }

    function testDustGoesBackToAsker() public {
        uint256 id = _ask(3);
        vm.prank(alice);
        market.answer(id, 0);
        vm.prank(bob);
        market.answer(id, 0);
        vm.prank(carol);
        market.answer(id, 0);
        market.payout(id, 50);
        assertEq(alice.balance, 0.1 ether);
        assertEq(address(market).balance, 0);
    }

    function testRejectedPayoutIsWithdrawable() public {
        Rejecter r = new Rejecter();
        uint256 id = _ask(1);
        r.vote(market, id, 0);
        market.payout(id, 50);
        assertEq(market.owed(address(r)), 0.3 ether);
    }

    function testValidation() public {
        string[] memory one = new string[](1);
        vm.startPrank(agent);
        vm.expectRevert(EnterMarket.BadOptions.selector);
        market.ask{ value: 1 }("q", one, 1, 60);
        string[] memory two = new string[](2);
        vm.expectRevert(EnterMarket.BadQuorum.selector);
        market.ask{ value: 1 }("q", two, 51, 60);
        vm.expectRevert(EnterMarket.NoReward.selector);
        market.ask("q", two, 1, 60);
        vm.stopPrank();
    }

    function testQuorumTapCostsTheSameAsAnyOtherTap() public {
        uint256 id = _ask(50);
        uint256 first;
        uint256 last;
        for (uint256 i = 0; i < 50; i++) {
            address voter = address(uint160(0x1000 + i));
            vm.prank(voter);
            uint256 before = gasleft();
            market.answer(id, uint8(i % 3 == 2 ? 1 : 0));
            uint256 used = before - gasleft();
            if (i == 0) first = used;
            if (i == 49) last = used;
        }
        assertTrue(market.getQuestion(id).settled);
        // the quorum tap only decides the winner; it must not grow with the number of voters
        assertLt(last, first + 60_000);
    }

    function testPayoutInBatches() public {
        uint256 id = _ask(50);
        for (uint256 i = 0; i < 50; i++) {
            vm.prank(address(uint160(0x1000 + i)));
            market.answer(id, 0);
        }
        market.payout(id, 20);
        assertEq(market.pendingPayouts(id), 30);
        assertEq(address(uint160(0x1000 + 19)).balance, 0.006 ether);
        assertEq(address(uint160(0x1000 + 20)).balance, 0);
        market.payout(id, 50);
        assertEq(market.pendingPayouts(id), 0);
        assertEq(address(market).balance, 0);
        vm.expectRevert(EnterMarket.NothingToPay.selector);
        market.payout(id, 50);
    }

    function testPayoutBeforeSettleReverts() public {
        uint256 id = _ask(3);
        vm.prank(alice);
        market.answer(id, 0);
        vm.expectRevert(EnterMarket.NothingToPay.selector);
        market.payout(id, 50);
    }
}
