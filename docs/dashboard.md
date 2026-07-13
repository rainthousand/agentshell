# AgentShell Dashboard

Start the local value dashboard from the project being measured:

```bash
agentshell dashboard
```

AgentShell maintains one user-level Dashboard process. Repeated launches reuse a
healthy matching instance; a stale version or different workspace is replaced.

```bash
agentshell dashboard --status
agentshell dashboard --stop
```

On macOS the command opens a native AppKit floating panel with no browser chrome.
It stays above normal windows by default, joins all Spaces, can be resized, and
remains available from the `AS` menu-bar item after it is closed. The native shell
is built from `desktop/macos/AgentShellDashboard.swift` and embeds the same local
Dashboard through a non-persistent `WKWebView`.

The command binds only to `127.0.0.1`, chooses port 4317 or the next available
port, and keeps running until interrupted. Use `--browser` for the browser surface,
`--no-open` for a side-by-side Codex workflow, or `--port 0` in automation.
Non-macOS systems currently fall back to the browser surface.

## Measurement Labels

Measured values come from AgentShell's own local task state:

- command execution time;
- workflow elapsed time;
- task and command counts;
- final verification status.

Estimated values use the documented four-characters-per-token proxy:

- AgentShell output tokens;
- raw verification output tokens;
- context avoided versus raw verification output.

The Dashboard does not claim access to Codex model tokens, Codex thinking time,
or commands executed outside AgentShell. Estimated time saved stays unavailable
until a matched workflow baseline exists.

## Privacy

- The server is read-only and listens on the IPv4 loopback address only.
- The browser receives aggregate metrics, not source files or command output.
- No network upload or analytics endpoint is present.
- Responses disable caching and include a restrictive Content Security Policy.
- The native WebView rejects navigation outside `http://127.0.0.1`.

## Evidence And Windows

New verification events are attributed to raw operations by `operationId`. Older
records remain visible but are labeled as legacy fallback. Token values use the
documented chars/4 estimate; time saved only counts validated cache hits against
their measured uncached baseline.

```bash
agentshell metrics --compact --since 24h
agentshell metrics export --out metrics-evidence.json --since 7d
agentshell metrics reset --confirm
```

Reset starts a fresh measurement window without deleting history or logs.
