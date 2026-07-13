# AgentShell v0.24 Demo

Goal: show that Codex can diagnose, patch, verify, inspect run status, and undo a failing test with compact JSON commands.

## Failing Test Flow

```bash
cd examples/failing-test-demo
node ../../src/cli.js understand
node ../../src/cli.js fix test --dry-run --compact
node ../../src/cli.js fix test --compact
node ../../src/cli.js diagnose test --compact
node ../../src/cli.js change suggest --dry-run --compact
node ../../src/cli.js change suggest --apply --compact
node ../../src/cli.js run next
node ../../src/cli.js run status --compact
node ../../src/cli.js benchmark test
cd ../..
npm run benchmark:first-round
npm run benchmark:first-round -- --report artifacts/first-round.json --markdown artifacts/first-round.md
npm run benchmark:suite
npm run adapter:generate -- agents-md
cd examples/failing-test-demo
node ../../src/cli.js schema get verify
# Only if the summary is insufficient:
# node ../../src/cli.js log get <logRef> --tail 120
# or:
# node ../../src/cli.js verify test --tail 40
node ../../src/cli.js find createUser
node ../../src/cli.js read src/user.js --around createUser
node ../../src/cli.js read test/user.test.js --around "Expected user.id"
```

## Safe Edit Flow

1. Use the `hash` from `agentshell read`.
2. Create a change file:

```json
{
  "reason": "Return a generated id from createUser",
  "edits": [
    {
      "file": "src/user.js",
      "expectedHash": "sha256:...",
      "range": {
        "start": 2,
        "end": 5
      },
      "replacement": "  return {\n    id: `user_${input.email}`,\n    name: input.name,\n    email: input.email\n  };"
    }
  ]
}
```

3. Apply and verify:

```bash
node ../../src/cli.js change /tmp/agentshell-demo-change.json
node ../../src/cli.js verify test
node ../../src/cli.js run next
node ../../src/cli.js run status --compact
node ../../src/cli.js history
node ../../src/cli.js metrics --compact
```

4. Restore the demo to failing state:

```bash
node ../../src/cli.js undo
```

## What To Measure

- Number of commands.
- Raw output characters versus AgentShell JSON output.
- Time to identify `src/user.js` and `test/user.test.js`.
- Time from first verification failure to passing test.
- Whether `agentshell fix test --dry-run --compact` previews the one-command repair without changing source files.
- Whether `agentshell fix test --compact` can diagnose, apply, verify, and report rollback guidance in one command.
- Whether `agentshell change suggest --dry-run --compact` previews a conservative generated suggestion.
- Whether `agentshell change suggest --apply --compact` can apply that suggestion.
- Whether the benchmark suite includes missing properties, flat deepEqual missing properties, simple array additions/removals, wrong literals, truthy returns, and missing exports.
- Whether `npm run benchmark:first-round -- --runs 3` shows first-pass command, wall-time, stdout character, and estimated-token reduction for split `doctor`/`understand --compact`/`run next` versus `start --compact` when available.
- Whether `npm run benchmark:first-round -- --report artifacts/first-round.json --markdown artifacts/first-round.md` writes JSON and Markdown artifacts while default stdout remains JSON. Bare `--markdown` still prints the Markdown summary to stdout.
- Whether adapter templates can be generated for Codex-style `AGENTS.md`, Claude Code, and Cursor/Windsurf.
- Whether `agentshell run next` returns the correct shortest next action.
- Whether `agentshell run status --compact` reports a passed run with rollback guidance.
- Whether the final edit can be undone.
