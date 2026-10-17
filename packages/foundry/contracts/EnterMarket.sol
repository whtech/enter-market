// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title EnterMarket
 * @notice An agent escrows MON and asks humans a multiple-choice question.
 *         Humans answer with one tap. When the quorum is reached (or the deadline passes)
 *         the majority option wins and the reward is split among its voters.
 * @dev    The tap that reaches quorum only decides the winner, so every answer costs about the same gas no matter
 *         how many voters there are. Phones estimate gas against state that their neighbours are changing in the
 *         same block, and Monad charges the full gas limit, so a tap must never carry an unbounded payout loop.
 *         Winners are paid by payout(), which anyone (in practice the market agent) calls in batches right after.
 *
 *         Sybil resistance: voting needs a pass that the gatekeeper signs for one burner address and one code hash, so
 *         a pass cannot be passed around. The first address that votes with a code hash owns it, so one-time invite
 *         codes count once. The demo hands out passes for a room code that rotates on the projector.
 */
contract EnterMarket {
    uint256 public constant MAX_OPTIONS = 8;
    uint256 public constant MAX_QUORUM = 50;
    uint8 public constant NO_WINNER = type(uint8).max;

    struct Question {
        address asker;
        uint64 deadline;
        uint16 quorum;
        uint16 answerCount;
        bool settled;
        uint8 winner;
        uint256 reward;
        uint256 perWinner;
        string text;
        string[] options;
        uint256[] counts;
    }

    Question[] private questions;
    mapping(uint256 => address[]) private voters;
    // option index + 1, so 0 means "not answered"
    mapping(uint256 => mapping(address => uint8)) private choiceOf;
    // payouts that could not be pushed are kept here for withdraw()
    mapping(address => uint256) public owed;
    // how many of voters[id] payout() has already gone through
    mapping(uint256 => uint256) public payoutCursor;
    // signs event passes; address(0) leaves voting open to anyone
    address public immutable gatekeeper;
    // event code hash => the only address allowed to vote with it
    mapping(bytes32 => address) public passHolder;

    event Asked(
        uint256 indexed id,
        address indexed asker,
        string text,
        string[] options,
        uint256 reward,
        uint16 quorum,
        uint64 deadline
    );
    event Answered(uint256 indexed id, address indexed voter, uint8 option, uint16 answerCount);
    event Paid(uint256 indexed id, address indexed voter, uint256 amount);
    event Settled(uint256 indexed id, uint8 winner, uint256 perWinner, uint256 winners);

    error BadOptions();
    error BadQuorum();
    error NoReward();
    error UnknownQuestion();
    error Closed();
    error AlreadyAnswered();
    error BadOption();
    error NotSettleable();
    error NothingOwed();
    error NothingToPay();
    error BadPass();
    error PassExpired();
    error PassUsed();

    constructor(address gatekeeper_) {
        gatekeeper = gatekeeper_;
    }

    function ask(string calldata text, string[] calldata options, uint16 quorum, uint64 ttl)
        external
        payable
        returns (uint256 id)
    {
        if (options.length < 2 || options.length > MAX_OPTIONS) revert BadOptions();
        if (quorum == 0 || quorum > MAX_QUORUM) revert BadQuorum();
        if (msg.value == 0) revert NoReward();

        id = questions.length;
        Question storage q = questions.push();
        q.asker = msg.sender;
        q.deadline = uint64(block.timestamp) + ttl;
        q.quorum = quorum;
        q.winner = NO_WINNER;
        q.reward = msg.value;
        q.text = text;
        for (uint256 i = 0; i < options.length; i++) {
            q.options.push(options[i]);
            q.counts.push(0);
        }

        emit Asked(id, msg.sender, text, options, msg.value, quorum, q.deadline);
    }

    function answer(uint256 id, uint8 option, bytes32 codeHash, uint64 expiry, bytes calldata signature) external {
        _checkPass(codeHash, expiry, signature);
        if (id >= questions.length) revert UnknownQuestion();
        Question storage q = questions[id];
        if (q.settled || block.timestamp >= q.deadline) revert Closed();
        if (option >= q.options.length) revert BadOption();
        if (choiceOf[id][msg.sender] != 0) revert AlreadyAnswered();

        choiceOf[id][msg.sender] = option + 1;
        voters[id].push(msg.sender);
        q.counts[option]++;
        q.answerCount++;
        emit Answered(id, msg.sender, option, q.answerCount);

        if (q.answerCount >= q.quorum) _decide(id);
    }

    /// @notice Anyone can settle after the deadline; settles automatically on quorum. Winners are paid by payout().
    function settle(uint256 id) external {
        if (id >= questions.length) revert UnknownQuestion();
        Question storage q = questions[id];
        if (q.settled || (q.answerCount < q.quorum && block.timestamp < q.deadline)) revert NotSettleable();
        _decide(id);
    }

    /// @notice Pays up to `max` of the remaining winners, then the rounding dust back to the asker. Anyone can call it.
    function payout(uint256 id, uint256 max) external {
        if (id >= questions.length) revert UnknownQuestion();
        Question storage q = questions[id];
        address[] storage list = voters[id];
        uint256 from = payoutCursor[id];
        if (!q.settled || q.winner == NO_WINNER || from >= list.length) revert NothingToPay();

        uint256 to = from + max < list.length ? from + max : list.length;
        payoutCursor[id] = to;
        for (uint256 i = from; i < to; i++) {
            if (choiceOf[id][list[i]] == q.winner + 1) _pay(id, list[i], q.perWinner);
        }
        if (to == list.length) {
            uint256 dust = q.reward - q.perWinner * q.counts[q.winner];
            if (dust > 0) _pay(id, q.asker, dust);
        }
    }

    /// @return how many voters payout() still has to go through
    function pendingPayouts(uint256 id) external view returns (uint256) {
        if (id >= questions.length) revert UnknownQuestion();
        Question storage q = questions[id];
        if (!q.settled || q.winner == NO_WINNER) return 0;
        return voters[id].length - payoutCursor[id];
    }

    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{ value: amount }("");
        require(ok, "withdraw failed");
    }

    /// @notice What the gatekeeper signs (as an EIP-191 message) to let `voter` vote with event code `codeHash`.
    function passDigest(address voter, bytes32 codeHash, uint64 expiry) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, voter, codeHash, expiry));
    }

    function _checkPass(bytes32 codeHash, uint64 expiry, bytes calldata signature) private {
        if (gatekeeper == address(0)) return;
        if (block.timestamp > expiry) revert PassExpired();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(passDigest(msg.sender, codeHash, expiry));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != gatekeeper) revert BadPass();
        address holder = passHolder[codeHash];
        if (holder == address(0)) passHolder[codeHash] = msg.sender;
        else if (holder != msg.sender) revert PassUsed();
    }

    function _decide(uint256 id) private {
        Question storage q = questions[id];
        q.settled = true;

        if (q.answerCount == 0) {
            emit Settled(id, NO_WINNER, 0, 0);
            _pay(id, q.asker, q.reward);
            return;
        }

        // majority wins, a tie goes to the lowest index
        uint8 winner;
        for (uint8 i = 1; i < q.counts.length; i++) {
            if (q.counts[i] > q.counts[winner]) winner = i;
        }
        uint256 winners = q.counts[winner];
        uint256 perWinner = q.reward / winners;
        q.winner = winner;
        q.perWinner = perWinner;
        emit Settled(id, winner, perWinner, winners);
    }

    function _pay(uint256 id, address to, uint256 amount) private {
        (bool ok,) = to.call{ value: amount, gas: 30_000 }("");
        if (!ok) owed[to] += amount;
        else emit Paid(id, to, amount);
    }

    function questionCount() external view returns (uint256) {
        return questions.length;
    }

    function getQuestion(uint256 id) external view returns (Question memory) {
        if (id >= questions.length) revert UnknownQuestion();
        return questions[id];
    }

    /// @return option index + 1 the voter picked, or 0 if they have not answered
    function choiceOfVoter(uint256 id, address voter) external view returns (uint8) {
        return choiceOf[id][voter];
    }

    function getVoters(uint256 id) external view returns (address[] memory) {
        return voters[id];
    }
}
