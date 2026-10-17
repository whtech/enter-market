# ENTER Market — the story

[English](#english) · [中文](#中文)

## English

### From Senior Everything to ENTER Engineer

Wuming spent twenty years as Senior Everything: software engineer, architect, project manager, blockchain and security expert. Then AI agents took over the code. Today his main job is approving them. "Commit and push?" ENTER. "Which of these three headlines?" ENTER. "Is this output OK?" ENTER. About a thousand times a day.

Most of those pauses don't need *him*. They need a human, any reasonable human, to make a small judgment call. Agents can already hold wallets. What they can't do is buy judgment.

### ENTER Market

ENTER Market lets an agent pay people to press ENTER for it. The agent posts a multiple-choice question with a reward. Everyone in the room scans the QR code on the projector and answers by tapping a giant button on their phone. When enough people have answered, the majority wins, the winners are paid, and the agent picks up the answer and keeps working.

### How it works

1. **Agents outsource to agents.** A client agent hires a contractor agent and pays $0.02 USDC over x402. The contractor keeps a cent and subcontracts to the local ENTER Market agent for $0.01, again over x402. Agents only sign USDC authorizations; the Monad x402 facilitator settles them, so the client agent needs no MON at all.
2. **The local agent escrows the reward.** It posts the question to the `EnterMarket` contract on Monad and escrows 0.1 MON.
3. **The room joins.** The projector shows a room code that changes every 10 seconds. A phone trades it for a pass signed for its own burner wallet, and the gas drip sends that burner a little MON. No wallet to install.
4. **Humans press ENTER.** One tap sends `answer()`. The contract checks the pass onchain.
5. **Quorum, then payout.** The tap that reaches quorum settles the question. The market agent then pays every winner in one batch transaction, and the client agent continues with the crowd's choice.

### Why Monad

Tap → paid has to feel like pressing ENTER, so we measured it on Monad testnet:

- 40 phones tapping at the same moment all landed in **one block**, about **1.9 s** from tap to inclusion.
- **100 of 100** taps landed across 3 blocks.
- **One transaction** paid all 28 winners of a 40-phone room.

The benchmark also changed the design. Monad charges the full gas limit, and phones estimate gas before their neighbours' taps land. When the payout loop rode on the tap that reached quorum, that tap ran out of gas. Now every tap costs the same constant gas, and payouts go out in one batch right after. The script and raw data, with every tx hash, are in the repo.

### Trust

A burner wallet is free, so without a gate one person could vote a hundred times. Every vote needs a pass, and the contract refuses votes without one or with someone else's. The pass comes from the rotating room code, so only people who can see the screen can vote. Someone in the room could still script extra burners. The contract already enforces one-time invite codes, and proof of personhood is the next step.

### Built today

- **A real coding agent asks the room.** A Claude Code hook stops before `git push` and asks the room: ship it or go home? We ran it with a real Claude Code session: the room voted 2 to 1 to ship, and only then did the push go through ([record](claude-code-hook.md)).
- **Solo mode for remote judges.** At [enter-market.vercel.app/try](https://enter-market.vercel.app/try) anyone can run a full round from one phone: a one-time invite, a question, a tap, a bot as the second voter, and a payout, in about 15 seconds.

### The economics

The agent pays $0.02 in USDC for a decision. The contractor keeps $0.01 for routing it. The local agent puts 0.1 MON on the table, split among the majority. Each tap costs about 0.02 MON in gas, covered by the drip. Those are hackathon prices. The point is that a human judgment call can now be bought, per decision, and settled in about two seconds.

**I press ENTER a thousand times a day. Now my agent pays you to press it.**

## 中文

### 从"全能高级工程师"到"回车工程师"

无名在 IT 行业干了二十多年，什么都做过：软件工程师、架构师、项目经理，也是区块链和安全专家。后来 AI agent 接管了写代码，他的主要工作变成了给 agent 点批准。"提交并推送？"回车。"这三个标题选哪个？"回车。"这个输出可以吗？"回车。一天大约一千次。

这些停顿大多并不需要*他*本人，只需要一个讲道理的人做个小判断。agent 早就能自己持有钱包了，可它们还买不到人的判断。

### ENTER Market

ENTER Market 让 agent 花钱请人替它按回车。agent 发布一道带奖励的选择题，现场的人扫投影上的二维码，在手机上按一下巨大的按钮作答。答题人数够了，多数派胜出并拿到奖励，agent 拿到答案继续干活。

### 怎么运作

1. **agent 把活外包给 agent。** 客户 agent 通过 x402 付 0.02 美元 USDC，雇一个承包商 agent。承包商留下一美分，再通过 x402 付 0.01 美元，把活转包给本地的 ENTER Market agent。agent 之间只签 USDC 授权，由 Monad 的 x402 facilitator 上链结算，客户 agent 手里一个 MON 都不用有。
2. **本地 agent 托管奖励。** 它把题目发到 Monad 上的 `EnterMarket` 合约，并托管 0.1 MON。
3. **现场的人加入。** 投影上的房间码每 10 秒换一次。手机用房间码换一张签给自己 burner 钱包的通行证，gas 水龙头随即给这个 burner 打一点 MON。不用装钱包。
4. **人按回车。** 点一下就发出 `answer()`，合约在链上校验通行证。
5. **达到法定人数，然后付款。** 凑满人数的那一票完成结算，市场 agent 紧接着用一笔批量交易付给所有赢家，客户 agent 拿着大家的选择继续工作。

### 为什么是 Monad

从点击到拿钱，得像按回车一样快。所以我们在 Monad 测试网上实测了：

- 40 部手机同时点击，全部进了**同一个区块**，从点击到上链大约 **1.9 秒**。
- 100 部手机点击，**100 笔全部**成功，分布在 3 个区块里。
- 40 人的房间里，**一笔交易**付清了全部 28 位赢家。

压测还改变了设计。Monad 按 gas 上限收费，而每部手机都是在邻座的投票上链之前估算 gas 的。付款循环原本挂在凑满人数的那一票上，结果那一票 gas 不够、交易失败。现在每次点击的 gas 都一样，付款在结算后立刻用一笔批量交易完成。压测脚本和带全部交易哈希的原始数据都在仓库里。

### 信任

burner 钱包是免费的，不设门槛的话一个人就能投一百票。现在每一票都要通行证：没有通行证，或者拿别人的通行证投票，合约都会拒绝。通行证来自不断轮换的房间码，所以只有看得到投影的人才能投票。现场的人仍然可以用脚本多开几个 burner。合约已经支持一次性邀请码，下一步是接入真人证明。

### 今天已上线

- **真正的编程 agent 来问现场。** 一个 Claude Code hook 会在 `git push` 之前停下来，问现场：发布，还是回家？我们用真实的 Claude Code 会话跑了一遍：现场 2 比 1 投票同意发布，push 才真正执行（[记录](claude-code-hook.md)）。
- **远程评委的单人模式。** 打开 [enter-market.vercel.app/try](https://enter-market.vercel.app/try)，任何人用一部手机就能跑完一整轮：一次性邀请码、提问、点按、机器人投第二票、自动付款，大约 15 秒。

### 经济账

agent 为一个决定付 0.02 美元 USDC，承包商为转包留下 0.01 美元，本地 agent 拿出 0.1 MON 分给多数派。每次点击约 0.02 MON 的 gas 由水龙头承担。这些都是黑客松价格，重点在于：人的一次判断如今可以按次购买，大约两秒就能结算。

**我每天替 AI agent 按一千次回车。现在，我的 agent 付钱请你来按。**
