const PROTOCOL_VERSION = "agentshell.manual.v1";

const TOPICS = ["repair", "plugin", "benchmark", "profile", "onboarding", "log-triage", "reference"];

export async function manual(options = {}) {
  if (options.topic) return topicManual(options.topic);
  if (options.full) return fullManual();
  return compactManual();
}

function compactManual() {
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: true,
    name: "AgentShell",
    version: "0.25.3",
    purpose: "Structured local execution for AI coding agents with compact JSON output, task-level run status, hash-checked edits, and undo.",
    firstPass: {
      command: "agentshell start --compact",
      fallback: "node src/cli.js start --compact",
      reason: "Cheapest combined readiness, compact workspace shape, and next-action summary."
    },
    primaryCommands: [
      {
        need: "Repair supported failing tests",
        command: "agentshell fix test --fast --compact",
        fallback: "agentshell diagnose test --compact"
      },
      {
        need: "Preview before changing files",
        command: "agentshell fix test --safe --compact"
      },
      {
        need: "Verify tests with compact logs",
        command: "agentshell verify test"
      },
      {
        need: "Inspect task state",
        command: "agentshell run status --compact"
      },
      {
        need: "Read focused file context",
        command: "agentshell read <file> --around <query>"
      },
      {
        need: "Validate local Codex plugin",
        command: "agentshell plugin validate --compact"
      }
    ],
    topics: TOPICS.map((topic) => ({
      name: topic,
      command: `agentshell manual --topic ${topic}`
    })),
    full: "agentshell manual --full",
    rules: [
      "Treat AgentShell JSON as the source of truth.",
      "Prefer compact summaries and log refs before raw logs.",
      "Use expectedHash from agentshell read before hash-checked edits.",
      "Fall back to normal shell commands only when AgentShell does not support the needed action."
    ]
  };
}

function topicManual(topic) {
  const topicPayloads = {
    repair: {
      workflow: [
        "agentshell start --compact",
        "agentshell fix test --fast --compact",
        "agentshell fix test --safe --compact",
        "agentshell diagnose test --compact",
        "agentshell change suggest --dry-run --compact",
        "agentshell change suggest --apply --compact",
        "agentshell verify test",
        "agentshell run status --compact"
      ],
      rules: [
        "Use fix test --fast --compact first for supported failures.",
        "Use --safe or --dry-run when preview-first behavior is required.",
        "Fetch logs with agentshell log get only when compact diagnosis is insufficient."
      ]
    },
    plugin: {
      workflow: [
        "agentshell plugin validate --compact",
        "agentshell plugin validate --source-only --compact",
        "agentshell plugin status --compact",
        "agentshell trial export --rating 1-5",
        "npm run plugin:smoke",
        "npm run plugin:release-local -- --compact"
      ],
      rules: [
        "Use source-only validate before installing a freshly cachebusted version.",
        "Run smoke after plugin-facing changes.",
        "Use trial export after a verified real-user task to create a redacted evidence file.",
        "Refresh local plugin publication only after meaningful plugin-facing changes."
      ]
    },
    benchmark: {
      workflow: [
        "agentshell benchmark test",
        "agentshell dashboard",
        "npm run benchmark:suite",
        "npm run benchmark:cache",
        "npm run benchmark:cold-start",
        "agentshell metrics --compact --scope global"
      ],
      rules: [
        "Use estimatedTokens as a rough chars/4 output-cost proxy.",
        "Use cold-start benchmark to separate process startup from in-process work.",
        "Use benchmark:suite for raw/split/fix comparison."
      ]
    },
    profile: {
      workflow: [
        "agentshell start --compact --profile",
        "agentshell plugin validate --compact --profile",
        "agentshell diagnose test --compact --profile",
        "agentshell fix test --fast --compact --profile",
        "npm run benchmark:cold-start"
      ],
      rules: [
        "profile.totalMs measures inside an already-started CLI process.",
        "Cold-start wallTimeMs includes process startup, module loading, execution, JSON serialization, and stdout capture.",
        "If profile.subprocessMs dominates, optimize the underlying test/tool path before blaming JavaScript."
      ]
    },
    onboarding: {
      workflow: [
        "agentshell start --compact",
        "agentshell manual",
        "agentshell manual --topic repair",
        "agentshell doctor",
        "agentshell understand --compact",
        "agentshell run next",
        "agentshell run status --compact"
      ],
      rules: [
        "Use start --compact as the first command in a new checkout.",
        "Read manual topic pages before broad shell exploration when command behavior is unclear.",
        "Use run next and run status --compact to avoid stale task state."
      ]
    },
    "log-triage": {
      workflow: [
        "agentshell verify test",
        "agentshell verify test --tail N",
        "agentshell diagnose test --compact",
        "agentshell log get <logRef> --tail N",
        "agentshell read <file> --around <query>",
        "agentshell run status --compact"
      ],
      rules: [
        "Prefer verify summaries and logRef before raw terminal logs.",
        "Fetch only a bounded log tail when compact output is insufficient.",
        "Use focused reads near the failing symbol or assertion before broad file dumps."
      ]
    },
    reference: {
      workflow: [
        "agentshell schema list",
        "agentshell schema get <name>",
        "agentshell history",
        "agentshell log get <logRef> --tail N",
        "agentshell undo [operationId]",
        "agentshell manual --full"
      ],
      rules: [
        "Use schema get for integration contracts.",
        "Use history and undo for AgentShell-managed edits.",
        "Use manual --full only when the compact manual and topic pages are insufficient."
      ]
    }
  };

  const payload = topicPayloads[topic];
  if (!payload) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: `Unknown manual topic: ${topic}`,
        details: { availableTopics: TOPICS },
        suggestedNextActions: TOPICS.map((name) => ({
          command: `agentshell manual --topic ${name}`,
          reason: `Read the ${name} topic`
        }))
      }
    };
  }

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: true,
    name: "AgentShell",
    version: "0.25.3",
    topic,
    ...payload,
    full: "agentshell manual --full"
  };
}

function fullManual() {
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: false,
    name: "AgentShell",
    version: "0.25.3",
    purpose: "Structured local execution for AI coding agents with compact JSON output, task-level run status, hash-checked edits, and undo.",
    commandMap: [
      {
        need: "Start a compact first-pass workspace check",
        command: "agentshell start --compact OR agentshell entry --compact"
      },
      {
        need: "Understand the workspace",
        command: "agentshell understand"
      },
      {
        need: "Check AgentShell readiness",
        command: "agentshell doctor"
      },
      {
        need: "Check local Codex plugin install consistency",
        command: "agentshell plugin status --compact"
      },
      {
        need: "Run one-command local plugin validation",
        command: "agentshell plugin validate --compact"
      },
      {
        need: "Export a redacted real-user trial log",
        command: "agentshell trial export [--rating 1-5]"
      },
      {
        need: "Profile command-local AgentShell phases",
        command: "agentshell start --compact --profile OR agentshell plugin validate --compact --profile OR agentshell diagnose test --compact --profile"
      },
      {
        need: "Open the local value dashboard",
        command: "agentshell dashboard"
      },
      {
        need: "Search code",
        command: "agentshell find <query>"
      },
      {
        need: "Read a bounded file range",
        command: "agentshell read <file> --lines A:B"
      },
      {
        need: "Read near a symbol or text",
        command: "agentshell read <file> --around <query>"
      },
      {
        need: "Run tests with summary",
        command: "agentshell verify test [--tail N]"
      },
      {
        need: "Read stored verification logs",
        command: "agentshell log get <logRef> --tail N"
      },
      {
        need: "Apply hash-checked edits",
        command: "agentshell change <change.json>"
      },
      {
        need: "Generate a suggested fill for the active change template",
        command: "agentshell change suggest --dry-run --compact OR agentshell change suggest --apply --compact"
      },
      {
        need: "Fill a generated change template",
        command: "agentshell change fill <template.json> <fill.json> [--apply]"
      },
      {
        need: "Inspect AgentShell operations",
        command: "agentshell history"
      },
      {
        need: "Inspect the next recommended run action",
        command: "agentshell run next"
      },
      {
        need: "Inspect latest AgentShell run summary",
        command: "agentshell run status --compact"
      },
      {
        need: "Inspect most recent full AgentShell run snapshot",
        command: "agentshell run latest --compact"
      },
      {
        need: "Clear stale active AgentShell run state",
        command: "agentshell run clear"
      },
      {
        need: "Revert an AgentShell edit",
        command: "agentshell undo [operationId]"
      },
      {
        need: "Inspect compact context cost metrics",
        command: "agentshell metrics --compact [--limit N] [--scope workspace|global]"
      },
      {
        need: "Compare raw test output with compact AgentShell output",
        command: "agentshell benchmark test"
      },
      {
        need: "Measure CLI cold-start wall time",
        command: "npm run benchmark:cold-start"
      },
      {
        need: "Run compact test diagnosis with focused file context",
        command: "agentshell diagnose test [--compact]"
      },
      {
        need: "Diagnose, preview or apply a safe suggested fix, and verify when applied",
        command: "agentshell fix test [--fast|--safe|--dry-run] [--compact] [--profile]"
      },
      {
        need: "Inspect JSON output schemas",
        command: "agentshell schema list"
      }
    ],
    rules: [
      "Prefer AgentShell commands over ad hoc shell output when the needed action is supported.",
      "Use agentshell start --compact or agentshell entry --compact for the cheapest first pass; use agentshell start when full doctor, understand, and run-next payloads are needed.",
      "Use agentshell doctor to quickly check runtime, test-script, state-directory, and git readiness.",
      "Use agentshell plugin status --compact to check source manifest, personal marketplace, and Codex plugin cache consistency cheaply; use full plugin status when check details are needed.",
      "Use agentshell plugin validate --compact for a one-command plugin health gate, and agentshell plugin validate --source-only --compact before installing a freshly cachebusted version.",
      "Use --profile on start, plugin validate, diagnose, and fix when you need phase timings inside the already-started CLI process.",
      "Use agentshell read to get the current file hash before agentshell change.",
      "Do not invent expectedHash values.",
      "If change returns HASH_MISMATCH, re-read the file and rebuild the change JSON.",
      "Use verify output summary and suggestedNextActions before reading raw logs.",
      "Use logRef with agentshell log get only when the verification summary is insufficient.",
      "Use agentshell metrics --compact to measure recent AgentShell output cost.",
      "Use agentshell run next when you only need the next recommended command.",
      "Use agentshell run clear when an old active run is no longer relevant and run next should return to idle.",
      "Use agentshell change suggest --dry-run --compact to preview an automatic suggestion, then agentshell change suggest --apply --compact when the active diagnosis has a clear generated template; it currently supports missing object properties, flat deepEqual missing properties, simple deepEqual array additions, simple deepEqual array tail removals, simple deepEqual extra property removals, simple deepEqual array primitive replacements, small returned-array length shortfalls, simple wrong literals, empty join separator repairs, simple truthy-return assertions, missing named exports, unique local import path repairs, and narrow TypeScript missing-property diagnostics.",
      "Use agentshell run status --compact after diagnose/change/verify to inspect pass/fail state, command count, estimated token cost, rollback command, and next best action.",
      "Use agentshell benchmark test to produce a one-command raw-vs-compact comparison.",
      "Use npm run benchmark:cold-start to compare external CLI wall time with internal profile totals before deciding that Node.js or JavaScript is the bottleneck.",
      "Use agentshell fix test --fast --compact for the fastest supported diagnose/suggest/apply/verify loop; agentshell fix test --compact keeps the same default fast behavior.",
      "Use agentshell fix test --safe --compact or agentshell fix test --dry-run --compact to preview the same automatic fix without changing source files.",
      "Use agentshell diagnose test when reducing command round trips matters.",
      "Use agentshell diagnose test --compact when token cost matters; it returns compact read refs with hashes/ranges, fixPlan, and a changeTemplate while omitting inline file content and verbose symbol lists.",
      "Deterministic TypeScript and import-path diagnostics use a shorter diagnose path that skips generic reads and symbol search when a clear fix target is already available.",
      "Use agentshell change fill <template.json> <fill.json> --apply to fill and apply a generated template in one command.",
      "Use agentshell schema get <name> when you need a stable output contract."
    ],
    workflow: [
      "Run agentshell start --compact when entering a new checkout and you want readiness, workspace shape, and the shortest next action in the smallest response.",
      "Run agentshell doctor when entering a new checkout or when AgentShell behavior looks environment-dependent.",
      "Run agentshell understand.",
      "Run agentshell fix test --fast --compact first when the goal is to repair a supported failing test quickly; agentshell fix test --compact is the compatible default.",
      "Use agentshell fix test --safe --compact or agentshell fix test --dry-run --compact when you want a one-command preview before applying.",
      "Run agentshell diagnose test --compact for the common failing-test loop.",
      "Use diagnose.fixPlan.target to choose the first target file, range, expectedHash, and repair intent.",
      "Use diagnose.changeTemplate.path when you want to fill an existing change spec instead of building one from scratch.",
      "Run agentshell change fill <template.json> <fill.json> --apply when a template is available.",
      "Run agentshell change suggest --dry-run --compact to preview the suggested replacement, then agentshell change suggest --apply --compact when it is sufficient.",
      "Read suggested related files with agentshell read --around or --lines only if the diagnosis is insufficient.",
      "Use agentshell log get <logRef> only if more verification output is needed.",
      "Create a change JSON using the hash returned by read.",
      "Run agentshell change <change.json>.",
      "Run agentshell verify test again.",
      "Run agentshell run next when you need the shortest next-action check.",
      "Run agentshell run status --compact to inspect the active task run summary.",
      "Run agentshell run clear when you intentionally want to discard stale active run state while keeping run history.",
      "Run agentshell undo if the edit was wrong."
    ]
  };
}
