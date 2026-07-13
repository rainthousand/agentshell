# Adapter Trial Suite

Use adapter trial suites to compare multiple host runs or multiple project fixtures in one report.

The suite runner does not invent a separate score. It reads `trial` inputs or `collect` inputs, uses the existing adapter trial scorecard, and aggregates the results by host and interpretation.

## Manifest

Start from:

```bash
examples/adapter-trial-suite.sample.json
```

Each entry can be:

- `kind: "trial"`: score an existing `agentshell.adapter-trial.v1` input.
- `kind: "collect"`: first normalize a command transcript with the collector, then score the embedded trial.

```json
{
  "name": "adapter-trial-suite-sample",
  "trials": [
    {
      "id": "codex-scored-sample",
      "kind": "trial",
      "path": "adapter-trial.sample.json"
    },
    {
      "id": "codex-collected-sample",
      "kind": "collect",
      "path": "adapter-trial-collect.sample.json"
    }
  ]
}
```

Relative paths are resolved from the manifest file directory.

## Generate Reports

```bash
npm run --silent adapter:trial:suite -- --manifest examples/adapter-trial-suite.sample.json
npm run --silent adapter:trial:suite -- --manifest suite.json --report artifacts/adapter-trial-suite.batch1.json --markdown artifacts/adapter-trial-suite.batch1.md
```

The JSON report uses `agentshell.adapter-trial-suite.v1` and includes:

- total trial count;
- average score;
- strong/usable/weak counts;
- host-level aggregates;
- total output tokens;
- total duration;
- AgentShell command count;
- noisy raw command count.

## Product Use

Use this when comparing Codex, Claude Code, Cursor, Windsurf, or `AGENTS.md` adapters on the same fixture set. A strong product signal is:

- high average score;
- most runs in `strong`;
- AgentShell called early;
- low noisy raw command count;
- stable output tokens across repeated runs.

See [Adapter Trial Suite Playbook](trial-suite-playbook.md) for naming conventions, PM metrics, and engineering debugging metrics.
