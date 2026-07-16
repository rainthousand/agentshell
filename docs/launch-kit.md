# AgentShell V1.0 Launch Kit

This file contains ready-to-publish launch copy in English and Chinese. Replace
only the bracketed fields before posting.

## Launch constants

- Product: **AgentShell**
- One-line definition: an agent-native local CLI and Codex plugin that turns
  noisy terminal workflows into compact, actionable JSON.
- Repository: <https://github.com/rainthousand/agentshell>
- Release: <https://github.com/rainthousand/agentshell/releases/tag/v1.0.0>
- Install:

  ```bash
  codex plugin marketplace add rainthousand/agentshell --ref main
  codex plugin add agentshell@agentshell
  ```

- Primary benchmark claim: on the checked-in `examples/noisy-test-demo`, raw
  `npm test` output was 14,851 characters, or 3,713 estimated tokens using
  `ceil(chars / 4)`. Default `agentshell verify test` output was 848 characters,
  or 212 estimated tokens: about 94% less output context in this scoped test.
- Reliability claim: the checked-in repair fixture evaluation passed 51/51
  repeated repair runs. This is fixture evidence, not a universal repair rate.
- Never describe either number as total Codex tokens, OpenAI billing usage, model
  tokens, thinking time, or a universal performance result.

## X / Twitter

### English short post

I built AgentShell because coding agents should not have to reread a wall of
terminal output just to find one failing assertion.

It is a local CLI + Codex plugin that returns compact, actionable JSON for
inspection, diagnosis, conservative fixes, verification, and rollback.

In our checked-in noisy-test demo, output context fell from 3,713 to 212 estimated
tokens, about 94%. The repair fixtures passed 51/51 repeated runs.

Open source: https://github.com/rainthousand/agentshell

Numbers are scoped fixture results, not total Codex token usage.

### 中文短帖

我做了 AgentShell：一个面向 coding agent 的本地 CLI + Codex 插件，把嘈杂的
终端输出变成紧凑、可执行的 JSON，支持项目检查、失败诊断、保守修复、验证和
回滚。

在仓库内置的 noisy-test demo 中，输出上下文从 3,713 降到 212 个估算 token，
约减少 94%；内置修复 fixtures 的 51/51 次重复运行通过。

开源地址：https://github.com/rainthousand/agentshell

以上是限定场景的 fixture 结果，不是 Codex 总 token 用量。

### English thread

**1/6**

Coding agents are often forced to consume terminal output designed for humans:
repeated stack traces, progress logs, and thousands of characters around the one
line that matters.

I built AgentShell to make that interface agent-native.

**2/6**

AgentShell is a local CLI and Codex plugin. It provides compact, versioned JSON
for project inspection, bounded reads, search, failing-test diagnosis,
conservative patch suggestions, hash-checked edits, verification, and rollback.

**3/6**

The default workflow is intentionally small:

```bash
agentshell start --compact
agentshell fix test --fast --compact
agentshell verify test --compact
```

An agent gets a summary and a next action, then asks for detailed logs only when
it actually needs them.

**4/6**

Scoped benchmark: on the checked-in noisy-test demo, raw `npm test` emitted
14,851 characters (3,713 estimated tokens). `agentshell verify test` emitted 848
characters (212 estimated tokens), about 94% less output context.

Token estimates use `ceil(chars / 4)`.

**5/6**

The checked-in repair fixture evaluation also passed 51/51 repeated repair runs.

That is evidence for those fixtures and supported repair shapes. It is not a
claim that AgentShell fixes 100% of real-world failures.

**6/6**

AgentShell runs locally and is open source. V1.0 includes the Codex plugin,
standalone Apple silicon CLI, checksums, and release audit report.

Repo: https://github.com/rainthousand/agentshell
Release: https://github.com/rainthousand/agentshell/releases/tag/v1.0.0

The benchmark measures output context, not total Codex tokens or model thinking
time.

### 中文 thread

**1/6**

Coding agent 经常要读取为人类设计的终端输出：重复的堆栈、进度日志，以及包围
着关键报错行的几千字符。

我做 AgentShell，是想把这层接口真正变成 agent-native。

**2/6**

AgentShell 是本地 CLI + Codex 插件，为项目检查、限定范围读取、搜索、测试失败
诊断、保守补丁、哈希校验编辑、验证与回滚提供紧凑、带版本的 JSON。

**3/6**

默认工作流很短：

```bash
agentshell start --compact
agentshell fix test --fast --compact
agentshell verify test --compact
```

Agent 先拿摘要和下一步建议，只有确实需要时才继续读取详细日志。

**4/6**

限定范围 benchmark：在仓库内置 noisy-test demo 上，原始 `npm test` 输出
14,851 字符（3,713 个估算 token）；`agentshell verify test` 输出 848 字符
（212 个估算 token），输出上下文约减少 94%。

Token 按 `ceil(chars / 4)` 估算。

**5/6**

仓库内置修复 fixture 评估的 51/51 次重复修复运行也全部通过。

这证明的是这些 fixtures 和当前支持的修复类型，不代表 AgentShell 能修复 100%
的真实世界故障。

**6/6**

AgentShell 本地运行并已开源。V1.0 包含 Codex 插件、Apple silicon 独立 CLI、
校验和与 release audit report。

仓库：https://github.com/rainthousand/agentshell
发布页：https://github.com/rainthousand/agentshell/releases/tag/v1.0.0

Benchmark 衡量的是输出上下文，不是 Codex 总 token 或模型思考时间。

## Show HN

### Title

Show HN: AgentShell – Compact, structured terminal workflows for coding agents

### English body

Hi HN,

I built AgentShell, an open-source local CLI and Codex plugin for coding-agent
workflows.

The problem I kept seeing was simple: coding agents consume terminal output that
was designed for humans. A failing test can produce thousands of characters,
even when the next useful action depends on a few lines. That spends context and
makes the workflow bounce between broad reads, shell commands, and repeated test
runs.

AgentShell puts a compact, versioned JSON interface in front of that workflow. It
can inspect a project, search, read bounded ranges, diagnose supported test
failures, preview or apply conservative hash-checked changes, verify the result,
and report rollback guidance. Unsupported failures remain structured refusals so
the agent can choose the next command instead of receiving a risky generic edit.

A typical start is:

```bash
agentshell start --compact
agentshell fix test --fast --compact
agentshell verify test --compact
```

For one scoped result, the checked-in noisy-test demo produced 14,851 characters
from raw `npm test`, estimated as 3,713 tokens with `ceil(chars / 4)`. Default
`agentshell verify test` produced 848 characters, estimated as 212 tokens: about
94% less output context. Separately, the checked-in repair fixture evaluation
passed 51/51 repeated repair runs.

Those are fixture-specific engineering results. They do not measure total Codex
session tokens or model thinking time, and 51/51 is not a universal repair-rate
claim.

AgentShell runs locally. The V1.0 release includes a Codex plugin and standalone
Apple silicon CLI; maintainers building from source need Node.js 20+. I would
especially value feedback on the JSON contracts, refusal boundaries, and which
diagnostics are worth supporting next.

Repo: https://github.com/rainthousand/agentshell

### 中文参考正文

大家好，我做了 AgentShell，一个面向 coding-agent 工作流的开源本地 CLI 和
Codex 插件。

它解决的问题很直接：coding agent 读取的终端输出原本是为人设计的。一次测试
失败可能输出几千字符，但决定下一步所需的信息只有几行。这会消耗上下文，也让
工作流在大范围读取、shell 命令和重复测试之间来回切换。

AgentShell 在这层工作流前提供紧凑、带版本的 JSON 接口，可进行项目检查、
搜索、限定行读取、支持范围内的测试失败诊断、保守补丁预览或哈希校验应用、
结果验证与回滚提示。遇到不支持的失败类型时，它会返回结构化拒绝，而不是尝试
高风险的通用修改。

典型起点：

```bash
agentshell start --compact
agentshell fix test --fast --compact
agentshell verify test --compact
```

一个限定范围的结果：仓库内置 noisy-test demo 的原始 `npm test` 输出为 14,851
字符，按 `ceil(chars / 4)` 估算为 3,713 token；默认 `agentshell verify test`
输出为 848 字符、212 个估算 token，输出上下文约减少 94%。另一项内置修复
fixture 评估中，51/51 次重复修复运行通过。

这些是特定 fixture 的工程结果，不衡量 Codex 会话总 token 或模型思考时间；
51/51 也不是通用修复率。

AgentShell 完全本地运行。V1.0 提供 Codex 插件和 Apple silicon 独立 CLI；从
源码构建需要 Node.js 20+。尤其欢迎大家反馈 JSON contract、拒绝边界，以及最
值得继续支持的诊断类型。

仓库：https://github.com/rainthousand/agentshell

## Reddit: problem-first post

### Suggested title

I was tired of coding agents spending context on thousands of characters of test
output, so I built a compact local interface

### English body

The recurring problem was not that the agent could not run tests. It was that
every run dumped human-oriented terminal output back into the agent's context.
Most of that output was irrelevant to the next action, but the agent still had to
process it, then run more commands to recover structure.

I built AgentShell to test a different interface: keep the underlying tools, but
return compact, versioned JSON with the failure summary, relevant files, bounded
read references, safe next actions, verification state, and rollback guidance.
Detailed logs stay available through a `logRef` when they are actually needed.

It is a local CLI and Codex plugin, and the common path looks like this:

```bash
agentshell start --compact
agentshell fix test --fast --compact
agentshell verify test --compact
```

In the checked-in noisy-test demo, raw `npm test` emitted 14,851 characters,
estimated as 3,713 tokens. Default compact verification emitted 848 characters,
estimated as 212 tokens, which is about 94% less output context for that test.
The checked-in repair fixture evaluation separately passed 51/51 repeated repair
runs.

Important caveat: these are scoped fixture results. The estimates use
`ceil(chars / 4)` and are not total Codex session tokens or billing data. The
51/51 result is not a promise that every repository or failure can be repaired.

The project is open source and local-first:
https://github.com/rainthousand/agentshell

I am looking for blunt feedback from people using coding agents on real projects:
Where does terminal noise hurt most, and which failure types should a conservative
repair tool support or explicitly refuse?

### 中文标题

受够了 coding agent 把上下文花在几千字符的测试输出上，我做了一个紧凑的本地
接口

### 中文正文

反复遇到的问题并不是 agent 不会跑测试，而是每次运行都会把面向人类的终端
输出全部塞回上下文。大部分内容和下一步无关，但 agent 仍要处理，再执行更多
命令把信息重新结构化。

我做了 AgentShell 来验证另一种接口：底层工具照常使用，但返回紧凑、带版本的
JSON，其中包含失败摘要、相关文件、限定读取引用、安全的下一步、验证状态和回滚
提示。只有真正需要时，agent 才通过 `logRef` 获取详细日志。

它是本地 CLI + Codex 插件，常用路径如下：

```bash
agentshell start --compact
agentshell fix test --fast --compact
agentshell verify test --compact
```

在仓库内置 noisy-test demo 中，原始 `npm test` 输出 14,851 字符，估算为 3,713
token；默认紧凑验证输出 848 字符，估算为 212 token，在该测试中输出上下文约
减少 94%。另一项内置修复 fixture 评估的 51/51 次重复修复运行通过。

重要限定：这些是特定 fixture 的结果。Token 使用 `ceil(chars / 4)` 估算，不是
Codex 会话总 token 或计费数据；51/51 也不承诺能修复所有仓库或故障。

项目开源并坚持 local-first：
https://github.com/rainthousand/agentshell

想听听正在真实项目里使用 coding agent 的朋友直说：终端噪声最影响你的环节是
什么？一个保守修复工具应该继续支持、或明确拒绝哪些失败类型？

## Product Hunt

### Tagline

Compact, actionable terminal workflows for coding agents

### 中文 tagline

把 coding agent 的终端工作流变成紧凑、可执行的 JSON

### English description

AgentShell is an open-source local CLI and Codex plugin that helps coding agents
inspect projects, diagnose supported test failures, apply conservative
hash-checked fixes, verify results, and retain rollback guidance without consuming
full terminal logs by default. On its checked-in noisy-test demo, compact
verification reduced output context from 3,713 to 212 estimated tokens, about
94%; its checked-in repair fixtures passed 51/51 repeated runs. These are scoped
fixture results, not total Codex token usage or a universal repair rate.

### 中文 description

AgentShell 是开源的本地 CLI + Codex 插件，让 coding agent 能够检查项目、诊断
支持范围内的测试失败、应用保守且经过哈希校验的修复、验证结果并保留回滚提示，
同时默认不读取完整终端日志。在仓库内置 noisy-test demo 中，紧凑验证将输出
上下文从 3,713 个估算 token 降至 212，约减少 94%；内置修复 fixtures 的 51/51
次重复运行通过。这些是限定场景的 fixture 结果，不是 Codex 总 token 用量或通用
修复率。

### Maker comment

Hi Product Hunt,

I built AgentShell after watching coding agents repeatedly consume long terminal
logs to recover a handful of useful facts. The design is summary-first: return a
small structured result, preserve detailed logs behind references, make edits
hash-checked, and keep verification and rollback visible.

V1.0 is local-first and open source. I would love feedback on three things: which
terminal workflows create the most wasted context, whether the JSON responses are
easy for agents to act on, and where the repair boundary should stay deliberately
conservative.

Our published numbers are intentionally scoped. The 3,713 to 212 comparison is
estimated output context on one checked-in noisy-test demo, and 51/51 refers to
repeated runs on checked-in repair fixtures. We do not claim access to total Codex
tokens or model thinking time.

### 中文 Maker comment

大家好，我做 AgentShell，是因为看到 coding agent 一次次读取很长的终端日志，
最后只从中提取几个有用事实。它采用 summary-first 设计：先返回小而结构化的
结果，详细日志保留在引用后面；编辑经过哈希校验；验证与回滚始终可见。

V1.0 坚持本地运行并已开源。最希望收到三方面反馈：哪些终端工作流最浪费上下
文、JSON 响应是否便于 agent 直接行动，以及修复边界应该在哪些地方保持克制。

所有公开数字都有明确范围：3,713 到 212 是一个仓库内置 noisy-test demo 的估算
输出上下文对比；51/51 指仓库内置修复 fixtures 的重复运行。我们不声称能够读取
Codex 总 token 或模型思考时间。

## 30-person targeted invitation

The goal is feedback, not amplification. Build a list of 30 people who are
plausibly close to the problem, send each message individually, and stop after
one follow-up.

### List composition

| Segment | Count | Who to invite | Ask |
| --- | ---: | --- | --- |
| Coding-agent power users | 10 | People publicly sharing Codex or agent workflows | Try one real repository and report where the compact output is insufficient |
| Tool and plugin builders | 8 | Maintainers of CLIs, agent tools, or developer plugins | Review the JSON contract, integration shape, and refusal behavior |
| Test and DX engineers | 6 | People working on test runners, CI output, or developer experience | Challenge the benchmark setup and identify noisy workflows |
| Open-source maintainers | 6 | Maintainers who regularly triage contributor or CI failures | Assess install clarity, trust signals, and conservative repair boundaries |

Personalize one sentence with a real reference to the recipient's work. Do not
manufacture familiarity, ask for a repost, or send the benchmark claim without
its fixture scope.

### English initial DM: user

Hi [Name] — I saw your [specific post/project] about [specific detail]. I have
just released AgentShell, a local CLI + Codex plugin that turns noisy terminal
workflows into compact JSON for coding agents.

Would you be open to trying it on one non-sensitive repository and telling me the
first place the summary is missing something you need? The scoped noisy-test demo
went from 3,713 to 212 estimated output tokens, about 94% less output context, but
I care more about where it breaks down in real use.

Repo: https://github.com/rainthousand/agentshell

No need to post about it; candid private feedback is the ask.

### 中文首轮私信：用户

[名字] 你好，看到你在 [具体帖子/项目] 里提到 [具体细节]。我刚发布了
AgentShell，一个把 coding agent 的嘈杂终端工作流变成紧凑 JSON 的本地 CLI +
Codex 插件。

想邀请你在一个非敏感仓库上试一下，并告诉我第一个“摘要信息不够用”的地方。
仓库内置 noisy-test demo 的估算输出 token 从 3,713 降到 212，输出上下文约减少
94%，但我更关心它在真实使用中从哪里开始失效。

仓库：https://github.com/rainthousand/agentshell

不需要帮忙转发，直接、私下的反馈就是我最想要的。

### English initial DM: builder or maintainer

Hi [Name] — your work on [project/topic] made me think you might have a useful
opinion on a tool I just released.

AgentShell is an open-source local CLI + Codex plugin that gives coding agents
compact, versioned JSON for inspection, diagnosis, conservative hash-checked
edits, verification, and rollback. Would you be willing to skim the interface and
tell me which contract or refusal boundary you would distrust first?

The checked-in repair fixture evaluation passed 51/51 repeated runs, but that is
fixture evidence, not a universal repair-rate claim.

Repo: https://github.com/rainthousand/agentshell

### 中文首轮私信：构建者或维护者

[名字] 你好，你在 [项目/主题] 上的工作让我觉得，你可能会对我刚发布的工具有
很有价值的判断。

AgentShell 是开源本地 CLI + Codex 插件，为 coding agent 提供用于项目检查、
诊断、保守哈希校验编辑、验证和回滚的紧凑、带版本 JSON。想请你快速看一下这套
接口，并告诉我：你最先会不信任哪个 contract 或拒绝边界？

内置修复 fixture 评估的 51/51 次重复运行通过，但这只是 fixture 证据，不是通用
修复率。

仓库：https://github.com/rainthousand/agentshell

### English follow-up, once only

Hi [Name] — one quiet follow-up in case this landed at a bad time. Even a
one-line answer to “what would stop you from trying this?” would be useful. No
pressure, and I will leave it here after this message.

### 中文跟进，仅一次

[名字] 你好，轻轻跟进一次，可能上条消息到得不是时候。哪怕只回答一句“什么会
让你不愿意尝试这个工具”，也会很有帮助。没有压力，这条之后我就不再打扰了。

### Feedback capture

Track only what helps improve the product:

| Person | Segment | Personalization basis | Sent | Replied | Tried | Main objection | Follow-up sent | Permission to quote |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Name] | [Segment] | [Public work referenced] | [Date] | [Yes/No] | [Yes/No] | [Short note] | [Date/No] | [Yes/No] |

Do not quote private replies publicly without explicit permission.

## FAQ

### What is AgentShell?

AgentShell is an agent-native local CLI and Codex plugin. It turns common coding
workflows into compact, versioned JSON so an agent can inspect a project, read
bounded ranges, diagnose supported failures, make conservative hash-checked
changes, verify the result, and retain rollback guidance.

AgentShell 是面向 agent 的本地 CLI 和 Codex 插件。它把常见 coding 工作流变成
紧凑、带版本的 JSON，让 agent 可以检查项目、限定范围读取、诊断支持的故障、
执行保守且经过哈希校验的修改、验证结果并保留回滚提示。

### Does it replace the shell or test runner?

No. It orchestrates existing project commands and returns structured summaries.
Detailed logs remain available when the summary is insufficient.

不会。它调用项目已有命令并返回结构化摘要；摘要不够时，详细日志仍可读取。

### What does “3,713 to 212, about 94%” mean?

It is one reproducible, scoped comparison on the checked-in
`examples/noisy-test-demo`. Raw `npm test` produced 14,851 characters, estimated
as 3,713 tokens. Default `agentshell verify test` produced 848 characters,
estimated as 212 tokens. The estimator is `ceil(chars / 4)`. It measures output
context for those commands, not the total token usage of a Codex session.

这是仓库内置 `examples/noisy-test-demo` 上可复现的限定范围对比。原始 `npm test`
输出 14,851 字符，估算为 3,713 token；默认 `agentshell verify test` 输出 848
字符，估算为 212 token。估算公式为 `ceil(chars / 4)`。它衡量的是这些命令的
输出上下文，不是 Codex 会话总 token 用量。

### What does 51/51 mean?

The checked-in repair fixture evaluation passed 51 out of 51 repeated repair
runs. It supports confidence in those fixtures and supported repair shapes. It
does not mean AgentShell repairs every failure, every repository, or 100% of
real-world cases.

仓库内置修复 fixture 评估的 51/51 次重复修复运行通过。它为这些 fixtures 和支持
的修复类型提供证据，但不表示 AgentShell 可以修复所有故障、所有仓库或 100% 的
真实场景。

### Does AgentShell know how many Codex tokens I used?

No. AgentShell does not claim access to Codex model-token accounting, total Codex
session usage, OpenAI billing data, or model thinking time. Its token figures are
character-based estimates of observed command output.

不知道。AgentShell 不声称能够访问 Codex 模型 token 统计、Codex 会话总用量、
OpenAI 计费数据或模型思考时间。它的 token 数字是根据可观察命令输出字符数得到的
估算值。

### Is it local? Does it upload source code?

The CLI runs locally. The optional Dashboard is read-only, listens on IPv4
loopback, and receives aggregate metrics rather than source files or command
output. Review the repository and release artifacts for the exact current
implementation before making environment-specific security decisions.

CLI 在本地运行。可选 Dashboard 为只读、仅监听 IPv4 loopback，接收聚合指标而
不是源文件或命令输出。针对具体环境做安全决策前，请审阅仓库和 release artifacts
中的当前实现。

### What failures can it repair?

AgentShell supports a deliberately bounded set of conservative JavaScript and
TypeScript repair shapes. Unsupported or ambiguous cases should produce a
structured refusal and next-action guidance rather than a speculative edit. See
the README for the current supported list.

AgentShell 支持一组有意限定范围的保守 JavaScript 与 TypeScript 修复类型。不支持
或存在歧义的情况应返回结构化拒绝和下一步提示，而不是进行猜测性编辑。当前支持
列表以 README 为准。

### What platforms does V1.0 support?

The public V1.0 release includes the Codex plugin and a standalone Apple silicon
CLI. Maintainers building from source need Node.js 20+. Do not imply Windows,
Linux native distribution, Intel Mac binaries, App Store distribution, or Apple
notarization unless the current release documentation explicitly adds them.

公开 V1.0 包含 Codex 插件和 Apple silicon 独立 CLI；从源码构建的维护者需要
Node.js 20+。除非当前 release 文档明确更新，否则不要暗示支持 Windows/Linux
原生分发、Intel Mac 二进制、App Store 分发或 Apple notarization。

## Claim guardrails

### Approved claims

- “On the checked-in noisy-test demo, default compact verification reduced output
  context from 3,713 to 212 estimated tokens, about 94%.”
- “The estimates use `ceil(chars / 4)` on observed command-output characters.”
- “The checked-in repair fixture evaluation passed 51/51 repeated repair runs.”
- “AgentShell is a local CLI and Codex plugin.”
- “AgentShell returns compact, versioned JSON and keeps detailed logs available by
  reference.”
- “Supported repairs are conservative and bounded; unsupported cases can return a
  structured refusal.”
- “在仓库内置 noisy-test demo 中，默认紧凑验证将输出上下文从 3,713 个估算
  token 降到 212，约减少 94%。”
- “仓库内置修复 fixture 评估的 51/51 次重复运行通过。”

### Claims that require immediate qualification

| Avoid this shorthand | Use this instead |
| --- | --- |
| “AgentShell saves 94% of tokens.” | “On the checked-in noisy-test demo, it reduced observed output context by about 94%, from 3,713 to 212 estimated tokens.” |
| “It used only 212 tokens.” | “The compact command output was estimated at 212 tokens using `ceil(chars / 4)`.” |
| “AgentShell has a 100% success rate.” | “The checked-in repair fixture evaluation passed 51/51 repeated runs.” |
| “It makes Codex 94% cheaper.” | “We did not measure billing cost or total Codex session usage.” |
| “It makes coding agents 17x faster.” | Do not make a speed multiplier claim from the output-context benchmark. |
| “It knows how much context Codex saved.” | “It estimates observed tool-output context avoided within AgentShell-attributed commands.” |
| “It never sends data anywhere.” | Describe the exact local CLI and Dashboard behavior documented for the current release; avoid an absolute claim about every surrounding tool or user configuration. |
| “It fixes TypeScript automatically.” | “It can conservatively repair a bounded set of supported JavaScript and TypeScript failure shapes.” |

### Prohibited claims

Do not claim or imply that AgentShell:

- measures or reduces **total Codex tokens**;
- can access **Codex model tokens**, hidden reasoning, or **thinking time**;
- reports OpenAI billing usage or guarantees cost savings;
- has a universal 94% reduction across repositories, commands, machines, or
  workflows;
- has a 100% real-world repair success rate because 51/51 fixture runs passed;
- guarantees faster completion, higher model accuracy, or a specific productivity
  multiplier;
- supports platforms, distribution channels, signing, notarization, repair types,
  or integrations not listed in the current V1.0 documentation.

禁止声称或暗示 AgentShell：

- 衡量或减少 **Codex 总 token**；
- 能访问 **Codex 模型 token**、隐藏推理或**思考时间**；
- 能读取 OpenAI 计费数据或保证节省成本；
- 在所有仓库、命令、机器或工作流中都能减少 94%；
- 因 fixture 运行 51/51 通过，就拥有 100% 的真实场景修复率；
- 保证更快完成、提高模型准确率或达到某个生产力倍数；
- 支持当前 V1.0 文档没有列出的系统平台、分发渠道、签名、公证、修复类型或
  集成。

### Standard answer when challenged on the numbers

> The 3,713 to 212 figure is a reproducible output-context comparison on one
> checked-in noisy-test demo. Both values are estimates from command-output
> characters using `ceil(chars / 4)`, so we describe the result as about 94% less
> output context in that scoped test. Separately, 51/51 refers to repeated runs on
> checked-in repair fixtures. Neither figure represents total Codex tokens,
> thinking time, billing usage, or a universal real-world success rate.

> 3,713 到 212 是一个仓库内置 noisy-test demo 上可复现的输出上下文对比。两个
> 数字都通过命令输出字符数按 `ceil(chars / 4)` 估算，因此我们只表述为“在该限定
> 测试中，输出上下文约减少 94%”。51/51 则是另一项仓库内置修复 fixtures 的重复
> 运行结果。两者都不代表 Codex 总 token、思考时间、计费用量或通用真实场景成功
> 率。

## Final preflight

Before publishing any item in this kit:

1. Replace every bracketed placeholder and verify the recipient-specific detail.
2. Keep “estimated tokens,” “output context,” and the fixture scope attached to
   the 3,713 to 212 claim.
3. Keep “checked-in repair fixtures” and “repeated runs” attached to 51/51.
4. Do not add total-Codex-token, thinking-time, billing, cost, universal speed, or
   universal repair-rate claims.
5. Re-run the documented benchmark and fixture evaluation if the implementation
   or release artifacts have changed since the cited evidence was recorded.
