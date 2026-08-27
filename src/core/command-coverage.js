import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { ensureState, newId, readEvents, stateDir } from "./store.js";

const PROTOCOL_VERSION = "agentshell.command-coverage.v1";
const OBSERVATIONS_FILE = "command-observations.jsonl";
const MAX_OBSERVATIONS = 10_000;
const MAX_SOURCE_CHARS = 32;
const MAX_INGEST_BATCH = 1_000;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;

const DIRECT_REPLACEMENTS = Object.freeze({
  grep: ["search", "agentshell grep <query> --compact"],
  rg: ["search", "agentshell grep <query> --compact"],
  find: ["file-discovery", "agentshell find file --name <pattern> --compact"],
  fd: ["file-discovery", "agentshell find file --name <pattern> --compact"],
  cat: ["file-read", "agentshell read <file> --head 120"],
  sed: ["file-read", "agentshell read <file> --lines A:B"],
  head: ["file-read", "agentshell head <file> --compact"],
  tail: ["file-read", "agentshell tail <file> --compact"],
  ls: ["inspection", "agentshell ls --compact"],
  tree: ["inspection", "agentshell tree --compact"],
  du: ["inspection", "agentshell du --compact"],
  pwd: ["inspection", "agentshell pwd --compact"],
  which: ["inspection", "agentshell which <command> --compact"],
  ps: ["process", "agentshell ps --compact"],
  lsof: ["process", "agentshell port list --compact"]
});

export function observeExternalCommand(root, argv, options = {}) {
  const classification = classifyExternalCommand(argv);
  if (!classification.ok) return classification;
  const observation = {
    id: newId("obs"),
    createdAt: new Date().toISOString(),
    source: normalizeSource(options.source),
    executable: classification.executable,
    category: classification.category,
    supportedReplacement: classification.supportedReplacement,
    replacement: classification.replacement
  };
  if (options.eventId) observation.eventFingerprint = eventFingerprint(observation.source, options.eventId);
  const file = observationFile(root);
  const persisted = persistObservations(root, [observation]);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    recorded: persisted.added[0] || observation,
    duplicate: persisted.added.length === 0,
    privacy: observationPrivacy(),
    suggestedNextActions: classification.replacement ? [{
      command: classification.replacement,
      reason: "Use the structured AgentShell path the next time this command family appears"
    }] : []
  };
}

export function ingestExternalCommandObservations(root, payload, options = {}) {
  const normalized = normalizeIngestPayload(payload, options);
  if (!normalized.ok) return normalized;
  const observations = normalized.events.map((event) => {
    const classification = classifyExternalCommand(event.argv);
    return {
      id: newId("obs"),
      createdAt: new Date().toISOString(),
      source: normalized.source,
      executable: classification.executable,
      category: classification.category,
      supportedReplacement: classification.supportedReplacement,
      replacement: classification.replacement,
      eventFingerprint: eventFingerprint(normalized.source, event.eventId)
    };
  });
  const persisted = persistObservations(root, observations);
  const coverage = commandCoverage(root);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    source: normalized.source,
    received: observations.length,
    recorded: persisted.added.length,
    duplicates: observations.length - persisted.added.length,
    totals: coverage.totals,
    rates: coverage.rates,
    privacy: observationPrivacy(),
    suggestedNextActions: []
  };
}

export function commandCoverage(root, options = {}) {
  const limit = boundedLimit(options.limit);
  const events = (options.events || readEvents(root)).filter((event) => event.command !== "coverage");
  const observations = options.observations || readCommandObservations(root);
  const externalAvailable = observations.length > 0;
  const hits = events.length;
  const external = observations.length;
  const total = hits + external;
  const opportunities = coverageOpportunities(observations).slice(0, limit);
  const eligibleFallbacks = observations.filter((entry) => entry.supportedReplacement).length;
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === true,
    status: externalAvailable ? "available" : "partial",
    totals: {
      observedCommands: externalAvailable ? total : hits,
      agentShellHits: hits,
      externalCommands: externalAvailable ? external : null,
      eligibleFallbacks: externalAvailable ? eligibleFallbacks : null,
      unsupportedExternalCommands: externalAvailable ? external - eligibleFallbacks : null
    },
    rates: {
      commandCoveragePercent: externalAvailable && total > 0 ? percent(hits, total) : null,
      fallbackRatePercent: externalAvailable && total > 0 ? percent(external, total) : null,
      replacementOpportunityPercent: externalAvailable && external > 0 ? percent(eligibleFallbacks, external) : null
    },
    telemetry: {
      agentShellEventsAvailable: true,
      externalCommandTelemetryAvailable: externalAvailable,
      externalObservationCount: external,
      dedupeMethod: "source-event-id-sha256",
      scope: externalAvailable ? "observed-local-tool-calls" : "agentshell-events-only"
    },
    opportunities,
    privacy: observationPrivacy(),
    summary: {
      status: externalAvailable ? "measured" : "external-telemetry-unavailable",
      topOpportunity: opportunities[0]?.replacement || null
    },
    suggestedNextActions: externalAvailable ? [] : [{
      command: "agentshell coverage observe --source codex -- <command...>",
      reason: "Adapters can record privacy-safe external command families to establish a real denominator"
    }]
  };
}

export function resetCommandCoverage(root) {
  const file = observationFile(root);
  const result = withFileLock(`${file}.lock`, () => {
    const removed = readCommandObservations(root).length;
    fs.rmSync(file, { force: true });
    return { removed };
  });
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    removedObservations: result.removed,
    preservedAgentShellEvents: true
  };
}

export function readCommandObservations(root) {
  const file = path.join(stateDir(root), OBSERVATIONS_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return validObservation(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

export function classifyExternalCommand(argv) {
  const tokens = Array.isArray(argv) ? argv.map(String).filter(Boolean) : [];
  const command = executableTokens(tokens);
  if (command.length === 0) return invalid("A command is required after `--`");
  const executable = path.basename(command[0]);
  if (executable === "agentshell" || executable === "ashell") {
    return invalid("AgentShell commands are recorded automatically and must not be observed as external fallbacks");
  }
  const direct = DIRECT_REPLACEMENTS[executable];
  if (direct) return classified(executable, direct[0], direct[1]);
  if (executable === "git") return classifyGit(command.slice(1));
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) return classifyPackageManager(executable, command.slice(1));
  if (executable === "go") return classifyGo(command.slice(1));
  if (["govulncheck", "staticcheck", "dlv", "mockgen", "wire"].includes(executable)) {
    return classified(executable, `go-${goToolCategory(executable)}`, `agentshell exec --compact -- ${executable} <args...>`);
  }
  if (executable === "golangci-lint" && command[1] === "run") {
    return classified(executable, "go-quality", "agentshell exec --compact -- golangci-lint run <args...>");
  }
  if (["pytest", "py.test"].includes(executable)) return classified(executable, "test", "agentshell verify test --compact");
  if (["mvn", "mvnw", "gradle", "gradlew"].includes(executable) && command.some((token) => token === "test")) {
    return classified(executable, "test", "agentshell verify test --compact");
  }
  return {
    ok: true,
    executable,
    category: "unsupported",
    supportedReplacement: false,
    replacement: null
  };
}

function classifyGit(argv) {
  const action = argv.find((token) => !token.startsWith("-"));
  const replacements = {
    status: "agentshell git status --compact",
    diff: "agentshell git diff --compact",
    log: "agentshell git log --compact",
    branch: "agentshell git branch --compact"
  };
  return classified("git", "git", replacements[action] || null);
}

function classifyGo(argv) {
  const action = argv[0];
  const direct = {
    test: ["test", "agentshell verify test --compact"],
    build: ["build", "agentshell verify build --compact"],
    vet: ["lint", "agentshell verify lint --compact"],
    generate: ["generation", "agentshell verify generate --compact"]
  };
  if (direct[action]) return classified("go", direct[action][0], direct[action][1]);
  const supported = new Set(["run", "list", "env", "get", "install"]);
  if (supported.has(action)) {
    return classified("go", `go-${action}`, `agentshell exec --compact -- go ${action} <args...>`);
  }
  if (action === "mod" && ["download", "graph", "why"].includes(argv[1])) {
    return classified("go", "go-modules", `agentshell exec --compact -- go mod ${argv[1]} <args...>`);
  }
  if (action === "tool" && ["cover", "pprof"].includes(argv[1])) {
    return classified("go", "go-performance", `agentshell exec --compact -- go tool ${argv[1]} <args...>`);
  }
  return classified("go", "go-tooling", null);
}

function goToolCategory(executable) {
  if (executable === "govulncheck") return "security";
  if (executable === "staticcheck") return "quality";
  if (executable === "dlv") return "debug";
  return "generation";
}

function classifyPackageManager(executable, argv) {
  const normalized = argv[0] === "run" ? argv[1] : argv[0];
  if (normalized === "test") return classified(executable, "test", "agentshell verify test --compact");
  return classified(executable, "package", null);
}

function classified(executable, category, replacement) {
  return { ok: true, executable, category, supportedReplacement: Boolean(replacement), replacement };
}

function executableTokens(tokens) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[index])) index += 1;
  while (["command", "env", "sudo"].includes(tokens[index])) index += 1;
  return tokens.slice(index);
}

function coverageOpportunities(observations) {
  const grouped = new Map();
  for (const observation of observations) {
    if (!observation.supportedReplacement || !observation.replacement) continue;
    const key = `${observation.executable}\0${observation.replacement}`;
    const current = grouped.get(key) || {
      executable: observation.executable,
      category: observation.category,
      count: 0,
      replacement: observation.replacement
    };
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count || left.executable.localeCompare(right.executable));
}

function observationFile(root) {
  return path.join(ensureState(root), OBSERVATIONS_FILE);
}

function persistObservations(root, pending) {
  const state = ensureState(root);
  const file = path.join(state, OBSERVATIONS_FILE);
  const lock = `${file}.lock`;
  return withFileLock(lock, () => {
    const existing = readCommandObservations(root);
    const fingerprints = new Set(existing.map((entry) => entry.eventFingerprint).filter(Boolean));
    const added = [];
    for (const observation of pending) {
      if (observation.eventFingerprint && fingerprints.has(observation.eventFingerprint)) continue;
      if (observation.eventFingerprint) fingerprints.add(observation.eventFingerprint);
      added.push(observation);
    }
    if (added.length === 0) return { added };
    const retained = [...existing, ...added].slice(-MAX_OBSERVATIONS);
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { added };
  });
}

function validObservation(value) {
  return value && typeof value === "object" && typeof value.executable === "string"
    && typeof value.supportedReplacement === "boolean" && typeof value.createdAt === "string";
}

function normalizeIngestPayload(payload, options) {
  if (!payload || typeof payload !== "object") return invalid("Adapter observation payload must be an object");
  if (payload.protocolVersion !== "agentshell.adapter-command-observation.v1") {
    return invalid("Unsupported adapter observation protocolVersion");
  }
  if (typeof payload.source !== "string" || payload.source.length === 0) return invalid("Adapter observation payload requires a source");
  const rawSource = String(options.source || payload.source);
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/iu.test(rawSource)) {
    return invalid("Adapter observation source must be a stable 1-32 character slug");
  }
  const source = normalizeSource(rawSource);
  const events = Array.isArray(payload.observations) ? payload.observations : [];
  if (events.length === 0) return invalid("Adapter observation payload requires at least one observation");
  if (events.length > MAX_INGEST_BATCH) return invalid(`Adapter observation batch cannot exceed ${MAX_INGEST_BATCH} events`);
  const normalized = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof event.eventId !== "string" || event.eventId.length === 0 || event.eventId.length > 256) {
      return invalid("Every adapter observation requires a stable eventId");
    }
    const argv = adapterArgv(event);
    const classification = classifyExternalCommand(argv);
    if (!classification.ok) return invalid(`Invalid adapter observation: ${classification.error.message}`);
    normalized.push({ eventId: event.eventId, argv });
  }
  return { ok: true, source, events: normalized };
}

function adapterArgv(event) {
  if (Array.isArray(event.argv)) return event.argv.map(String);
  if (typeof event.executableFamily !== "string" || event.executableFamily.length === 0) return [];
  const operation = typeof event.operation === "string" && /^[a-z0-9_.-]+$/iu.test(event.operation)
    ? event.operation
    : null;
  return operation ? [event.executableFamily, operation] : [event.executableFamily];
}

function eventFingerprint(source, eventId) {
  return crypto.createHash("sha256").update(`${source}\0${String(eventId)}`).digest("hex");
}

function withFileLock(lock, callback) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

function normalizeSource(value) {
  const source = String(value || "adapter").toLowerCase().replace(/[^a-z0-9_-]/gu, "-").slice(0, MAX_SOURCE_CHARS);
  return source || "adapter";
}

function observationPrivacy() {
  return {
    localOnly: true,
    storesArguments: false,
    storesPaths: false,
    storesOutput: false,
    storesExecutableFamily: true,
    storesEventIds: false,
    storesEventFingerprints: true
  };
}

function boundedLimit(value) {
  const parsed = Number(value ?? 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 10;
}

function percent(part, whole) {
  return Math.round((part / whole) * 100);
}

function invalid(message) {
  return {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message,
      suggestedNextActions: []
    }
  };
}
