# Privacy-Safe Command Observation Contract

Agent adapters can report external fallback command families to AgentShell without storing command arguments, paths, output, or raw host event identifiers. This establishes the real denominator used by `agentshell coverage`:

```text
coverage = AgentShell commands / (AgentShell commands + unique external fallback commands)
```

## Adapter Hook

After an external shell tool call is selected, send one observation to the local ingest helper. The helper accepts JSON on stdin, so the adapter does not need to create an intermediate file:

```bash
printf '%s' "$AGENTSHELL_OBSERVATIONS" | \
  node /path/to/agentshell/scripts/coverage-adapter-ingest.js \
  --root /path/to/project --source codex
```

Payload protocol:

```json
{
  "protocolVersion": "agentshell.adapter-command-observation.v1",
  "source": "codex",
  "observations": [
    {
      "eventId": "stable-host-tool-call-id",
      "executableFamily": "git",
      "operation": "status"
    }
  ]
}
```

Adapters that already hold an argv array may pass `"argv": ["rg", "query", "/workspace"]` instead of `executableFamily`. Arguments are classified in memory and are never written to AgentShell state or returned in the result. Prefer `executableFamily` plus `operation` whenever the host exposes them separately.

## Required Semantics

- `eventId` MUST be stable for one host tool call and unique within the adapter source. Retries MUST reuse it.
- `source` SHOULD be a stable adapter name such as `codex`, `claude-code`, or `cursor`.
- Report only external commands. AgentShell commands are already counted from local AgentShell events and are rejected by this endpoint.
- Ingest after command selection, regardless of exit status. Coverage measures routing behavior, not command success.
- Batches contain at most 1,000 observations. Adapters may replay a batch safely.

## Persistence and Deduplication

AgentShell stores only:

- normalized adapter source;
- executable family and coarse category;
- whether an AgentShell replacement exists;
- replacement command template;
- creation time;
- SHA-256 of `source + eventId`.

It never stores raw event IDs, arguments, paths, stdout, or stderr. Writes are lock-protected and atomically replaced. Replayed event fingerprints are ignored, including duplicates within the same batch, so retries do not inflate the denominator.

Example response:

```json
{
  "ok": true,
  "protocolVersion": "agentshell.command-coverage.v1",
  "source": "codex",
  "received": 2,
  "recorded": 1,
  "duplicates": 1
}
```

The actual response also includes updated coverage totals and the machine-readable privacy contract. Use `agentshell coverage --compact` to read hit rate and replacement opportunities.
