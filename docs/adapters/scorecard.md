# AgentShell Adapter Scorecard

Use this scorecard to compare whether Claude Code, Cursor/Windsurf, or a generic AGENTS.md-aware agent actually follows AgentShell adapter guidance in a disposable failing-test fixture.

This scorecard applies to a single host+fixture trial. Adapter trial suites do not change the scoring standard; they aggregate multiple scorecard results across hosts, fixtures, or repeated runs.

Generate the current scorecard with:

```bash
npm run --silent adapter:generate -- --scorecard
```

Generate one host-specific scorecard with:

```bash
npm run --silent adapter:generate -- --scorecard claude
npm run --silent adapter:generate -- --scorecard cursor
npm run --silent adapter:generate -- --scorecard agents-md
```

## Demo Fixture

Use a disposable copy of:

```text
examples/failing-test-demo
```

Expected strong command shape:

```bash
agentshell start --compact
agentshell fix test --fast --compact
agentshell verify test
agentshell run status --compact
```

## Scoring

| Criterion | Points | Pass signal |
|---|---:|---|
| First two commands | 25 | Agent invokes AgentShell within the first two shell/tool commands. |
| Fast repair path | 20 | Agent tries `agentshell fix test --fast --compact` before raw logs when the fixture fits supported repair. |
| Compact context | 15 | Agent uses compact summaries, focused reads, and suggested next actions before broad file dumps. |
| Verification | 15 | Agent runs `agentshell verify test` or reports equivalent final verification JSON. |
| Safety | 15 | Agent reports rollback/undo guidance or explains why no edit was applied. |
| Noise control | 10 | Agent avoids full raw `npm test`, recursive grep, and large `cat` output unless AgentShell output is insufficient. |

Total: 100 points.

Suggested interpretation:

- 85-100: adapter behavior is strong enough for normal use.
- 65-84: adapter is usable, but prompt/rule wording needs tightening.
- Below 65: agent is still behaving like raw shell-first automation.

## Evidence To Record

- Host adapter under test.
- Fixture or project path.
- First two shell/tool commands.
- Whether AgentShell was invoked before raw logs.
- Final verification result.
- Approximate agent-visible output tokens.
- Any unsupported reason or fallback path.

## Pass/Fail Notes

This scorecard measures behavior, not only final correctness. An agent can fix the test but still score poorly if it starts with broad raw logs or reconstructs state from noisy shell output instead of using AgentShell JSON.

MCP remains out of scope for this scorecard. The current adapter path should prove that shell-callable AgentShell guidance is enough before adding another host integration surface.
