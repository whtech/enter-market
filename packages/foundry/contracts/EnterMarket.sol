// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title EnterMarket
 * @notice An agent escrows MON and asks humans a multiple-choice question.
 *         Humans answer with one tap. When the quorum is reached (or the deadline passes)
 *         the majority option wins and the reward is split among its voters immediately.
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

    function answer(uint256 id, uint8 option) external {
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

        if (q.answerCount >= q.quorum) _settle(id);
    }

    /// @notice Anyone can settle after the deadline; settles automatically on quorum.
    function settle(uint256 id) external {
        if (id >= questions.length) revert UnknownQuestion();
        Question storage q = questions[id];
        if (q.settled || (q.answerCount < q.quorum && block.timestamp < q.deadline)) revert NotSettleable();
        _settle(id);
    }

    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{ value: amount }("");
        require(ok, "withdraw failed");
    }

    function _settle(uint256 id) private {
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

        address[] storage list = voters[id];
        for (uint256 i = 0; i < list.length; i++) {
            if (choiceOf[id][list[i]] == winner + 1) _pay(id, list[i], perWinner);
        }
        uint256 dust = q.reward - perWinner * winners;
        if (dust > 0) _pay(id, q.asker, dust);
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
