# External Beta Playbook

This beta takes one normal Codex task and one final export command. No source code or raw command logs are included in the exported file.

## Run a trial

1. Install AgentShell, then quit and reopen Codex.
2. Open a real project in Codex. Do not open your home folder (`$HOME`) as the project.
3. Ask Codex to complete a normal coding task. AgentShell should activate automatically; no setup command is required.
4. After Codex finishes and the project's final checks pass, open the terminal in that project and run:

   ```bash
   agentshell trial export --verify --rating 1-5
   ```

   Replace `1-5` with your rating, for example `--rating 5`. The command verifies the project again and writes an `agentshell-trial-*.json` file to your Desktop.
5. Open the JSON once to review it, then send that Desktop file to the beta coordinator. Do not send the project, screenshots, or terminal logs.

## When export does not work

Run this command from the project folder:

```bash
agentshell trial status
```

Follow its suggested action, complete a task with a passing final check, and retry the export command. If it still fails, send the JSON error printed by `trial status`; do not send raw source or logs.

## Acceptance gates

The external beta is accepted only when all gates pass:

- Evidence comes from at least 3 distinct external users and 3 real projects.
- Every accepted trial has a successful verified export (`finalVerification.ok: true`).
- At least 80% of trial attempts activate AgentShell.
- At least 80% of trial attempts produce a valid export.
- Shared evidence contains no raw source, stdout/stderr, full logs, absolute paths, usernames, hostnames, or environment variables.
