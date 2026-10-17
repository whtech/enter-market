// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/EnterMarket.sol";

contract Rejecter {
    function vote(EnterMarket m, uint256 id, uint8 option) external {
        m.answer(id, option, 0, 0, "");
    }
}

contract EnterMarketTest is Test {
    EnterMarket market;
    address agent = makeAddr("agent");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        market = new EnterMarket(address(0));
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
        market.answer(id, 1, 0, 0, "");
        vm.prank(bob);
        market.answer(id, 1, 0, 0, "");
        vm.prank(carol);
        market.answer(id, 0, 0, 0, "");

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
        market.answer(id, 0, 0, 0, "");
        vm.expectRevert(EnterMarket.AlreadyAnswered.selector);
        market.answer(id, 1, 0, 0, "");
        vm.stopPrank();
    }

    function testDeadlineSettleAndTieGoesToLowestIndex() public {
        uint256 id = _ask(10);
        vm.prank(alice);
        market.answer(id, 2, 0, 0, "");
        vm.prank(bob);
        market.answer(id, 1, 0, 0, "");

        vm.expectRevert(EnterMarket.NotSettleable.selector);
        market.settle(id);

        vm.warp(block.timestamp + 61);
        vm.prank(carol);
        vm.expectRevert(EnterMarket.Closed.selector);
        market.answer(id, 0, 0, 0, "");

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
        market.answer(id, 0, 0, 0, "");
        vm.prank(bob);
        market.answer(id, 0, 0, 0, "");
        vm.prank(carol);
        market.answer(id, 0, 0, 0, "");
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
            market.answer(id, uint8(i % 3 == 2 ? 1 : 0), 0, 0, "");
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
            market.answer(id, 0, 0, 0, "");
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
        market.answer(id, 0, 0, 0, "");
        vm.expectRevert(EnterMarket.NothingToPay.selector);
        market.payout(id, 50);
    }

    // --- event passes ---

    uint256 constant GATE_KEY = 0xA11CE;

    function _gated() internal returns (EnterMarket gated, uint256 id) {
        gated = new EnterMarket(vm.addr(GATE_KEY));
        string[] memory options = new string[](2);
        options[0] = "A";
        options[1] = "B";
        vm.prank(agent);
        id = gated.ask{ value: 0.2 ether }("Gated?", options, 3, 60);
    }

    function _pass(EnterMarket m, address voter, bytes32 codeHash, uint64 expiry, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", m.passDigest(voter, codeHash, expiry))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function testGatedVoteNeedsAValidPass() public {
        (EnterMarket m, uint256 id) = _gated();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 code = keccak256("room-code-1");

        vm.prank(alice);
        vm.expectRevert(EnterMarket.BadPass.selector);
        m.answer(id, 0, code, expiry, "");

        bytes memory forged = _pass(m, alice, code, expiry, 0xBAD);
        vm.prank(alice);
        vm.expectRevert(EnterMarket.BadPass.selector);
        m.answer(id, 0, code, expiry, forged);

        bytes memory pass = _pass(m, alice, code, expiry, GATE_KEY);
        vm.prank(alice);
        m.answer(id, 0, code, expiry, pass);
        assertEq(m.passHolder(code), alice);
    }

    function testEventCodeIsOneTime() public {
        (EnterMarket m, uint256 id) = _gated();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 code = keccak256("room-code-1");
        bytes memory alicePass = _pass(m, alice, code, expiry, GATE_KEY);
        bytes memory bobPass = _pass(m, bob, code, expiry, GATE_KEY);
        vm.prank(alice);
        m.answer(id, 0, code, expiry, alicePass);

        // the gatekeeper signed the same code for a second burner: the chain only honours the first one
        vm.prank(bob);
        vm.expectRevert(EnterMarket.PassUsed.selector);
        m.answer(id, 0, code, expiry, bobPass);

        // a pass signed for alice is useless to anyone else
        vm.prank(carol);
        vm.expectRevert(EnterMarket.BadPass.selector);
        m.answer(id, 0, code, expiry, alicePass);
    }

    function testPassWorksForEveryQuestionOfTheEvent() public {
        (EnterMarket m, uint256 first) = _gated();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 code = keccak256("room-code-1");
        bytes memory pass = _pass(m, alice, code, expiry, GATE_KEY);
        vm.prank(alice);
        m.answer(first, 0, code, expiry, pass);

        string[] memory options = new string[](2);
        options[0] = "A";
        options[1] = "B";
        vm.prank(agent);
        uint256 second = m.ask{ value: 0.1 ether }("Again?", options, 3, 60);
        vm.prank(alice);
        m.answer(second, 1, code, expiry, pass);
        assertEq(m.choiceOfVoter(second, alice), 2);
    }

    function testExpiredPassReverts() public {
        (EnterMarket m, uint256 id) = _gated();
        uint64 expiry = uint64(block.timestamp + 30);
        bytes32 code = keccak256("room-code-1");
        bytes memory pass = _pass(m, alice, code, expiry, GATE_KEY);
        vm.warp(block.timestamp + 31);
        vm.prank(alice);
        vm.expectRevert(EnterMarket.PassExpired.selector);
        m.answer(id, 0, code, expiry, pass);
    }
}
