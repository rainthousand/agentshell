import {
  GO_COMMAND_PROFILES,
  classifyGoCommandProfile,
  summarizeGoCommandProfile
} from "./go-command-profiles.js";

const MAX_CAPTURE_BYTES = 512 * 1024;
const MAX_FAILURES = 8;
const MAX_LOCATIONS = 8;
const MAX_MESSAGE_CHARS = 240;

const PROFILE_DEFINITIONS = [
  profile("docker-logs", "container-logs", matchPrefix("docker", "logs"), {
    defaults: [{ args: ["--tail", "200"], flags: ["--tail", "-n"] }],
    next: "docker logs --tail 200 <container>"
  }),
  profile("docker-compose-logs", "container-logs", (argv) =>
    hasPrefix(argv, "docker", "compose", "logs") || hasPrefix(argv, "docker-compose", "logs"), {
    defaults: [
      { args: ["--tail", "200"], flags: ["--tail", "-n"] },
      { args: ["--no-color"], flags: ["--no-color"] }
    ],
    next: "docker compose logs --tail 200 --no-color <service>"
  }),
  profile("kubectl-logs", "kubernetes-logs", matchKubectl("logs"), {
    defaults: [
      { args: ["--tail=200"], flags: ["--tail"] },
      { args: ["--request-timeout=15s"], flags: ["--request-timeout"] }
    ],
    next: "kubectl logs --tail=200 <pod>"
  }),
  profile("kubectl-describe", "kubernetes-resource", matchKubectl("describe"), {
    defaults: [{ args: ["--request-timeout=15s"], flags: ["--request-timeout"] }],
    next: "kubectl describe <resource> <name>"
  }),
  profile("kubectl-get", "kubernetes-resource", matchKubectl("get"), {
    defaults: [{ args: ["--request-timeout=15s"], flags: ["--request-timeout"] }],
    next: "kubectl get <resource> <name> -o yaml"
  }),
  profile("make", "build", (argv) => /^(?:g?make)$/.test(basename(argv[0])), {
    defaults: [{ args: ["--no-print-directory"], flags: ["--no-print-directory"] }],
    next: "make <failed-target>"
  }),
  profile("cargo-test", "test", matchPrefix("cargo", "test"), {
    defaults: [
      { args: ["--color", "never"], flags: ["--color"] },
      { args: ["--message-format", "short"], flags: ["--message-format"] }
    ],
    next: "cargo test <failed-test> -- --exact"
  }),
  profile("dotnet-test", "test", matchPrefix("dotnet", "test"), {
    defaults: [
      { args: ["--nologo"], flags: ["--nologo"] },
      { args: ["--verbosity", "minimal"], flags: ["--verbosity", "-v"] }
    ],
    next: "dotnet test --filter FullyQualifiedName=<failed-test>"
  }),
  profile("terraform-plan", "infrastructure-plan", matchPrefix("terraform", "plan"), {
    defaults: [
      { args: ["-no-color"], flags: ["-no-color"] },
      { args: ["-input=false"], flags: ["-input"] },
      { args: ["-detailed-exitcode"], flags: ["-detailed-exitcode"] }
    ],
    successExitCodes: [0, 2],
    next: "terraform plan -no-color -input=false -detailed-exitcode"
  }),
  profile("terraform-validate", "infrastructure-validation", matchPrefix("terraform", "validate"), {
    defaults: [
      { args: ["-no-color"], flags: ["-no-color"] },
      { args: ["-json"], flags: ["-json"] }
    ],
    next: "terraform validate -json"
  }),
  profile("maven", "build", (argv) => ["mvn", "mvnw"].includes(basename(argv[0])), {
    defaults: [
      { args: ["--no-transfer-progress"], flags: ["--no-transfer-progress", "-ntp"] },
      { args: ["-Dstyle.color=never"], flags: ["-Dstyle.color"] }
    ],
    next: "mvn --no-transfer-progress -Dstyle.color=never -DskipTests=false test"
  }),
  profile("gradle", "build", (argv) => ["gradle", "gradlew"].includes(basename(argv[0])), {
    defaults: [
      { args: ["--console=plain"], flags: ["--console"] },
      { args: ["--warning-mode=summary"], flags: ["--warning-mode"] }
    ],
    next: "./gradlew <failed-task> --console=plain --stacktrace"
  }),
  profile("ruff", "python-quality", (argv) => basename(argv[0]) === "ruff", {
    defaults: [{ args: ["--output-format", "concise"], flags: ["--output-format"] }],
    next: "ruff check <reported-file>"
  }),
  profile("mypy", "python-quality", (argv) => basename(argv[0]) === "mypy", {
    defaults: [
      { args: ["--no-pretty"], flags: ["--pretty", "--no-pretty"] },
      { args: ["--no-color-output"], flags: ["--color-output", "--no-color-output"] },
      { args: ["--show-error-codes"], flags: ["--show-error-codes", "--hide-error-codes"] }
    ],
    next: "mypy <reported-file>"
  }),
  ...GO_COMMAND_PROFILES.map(goProfile)
];

export function classifyHighNoiseCommand(command) {
  const argv = normalizeArgv(command);
  if (argv.length === 0) return null;
  const definition = PROFILE_DEFINITIONS.find((candidate) => candidate.matches(argv));
  return definition ? publicProfile(definition) : null;
}

export function applyHighNoiseSafeDefaults(command, suppliedProfile = null) {
  const argv = normalizeArgv(command);
  const selected = resolveDefinition(suppliedProfile) || PROFILE_DEFINITIONS.find((entry) => entry.matches(argv));
  if (!selected) return { matched: false, profile: null, argv, appliedDefaults: [] };

  const nextArgv = [...argv];
  const appliedDefaults = [];
  let insertionOffset = selected.prefixLength || 0;
  for (const entry of selected.defaults) {
    if (entry.flags.some((flag) => hasFlag(nextArgv, flag))) continue;
    if (entry.position === "after-prefix") {
      nextArgv.splice(insertionOffset, 0, ...entry.args);
      insertionOffset += entry.args.length;
    } else {
      nextArgv.push(...entry.args);
    }
    appliedDefaults.push([...entry.args]);
  }
  return {
    matched: true,
    profile: publicProfile(selected, argv),
    argv: nextArgv,
    appliedDefaults
  };
}

export function summarizeHighNoiseOutput(profileOrCommand, output, options = {}) {
  const definition = resolveDefinition(profileOrCommand) ||
    PROFILE_DEFINITIONS.find((entry) => entry.matches(normalizeArgv(profileOrCommand)));
  if (!definition) return null;

  if (definition.goProfile) {
    return summarizeGoCommandProfile(definition.id, normalizedOutput(output), options);
  }

  const capture = boundedCapture(output);
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  const parsed = definition.id.startsWith("terraform-")
    ? parseTerraform(capture.text)
    : parseLines(definition.id, capture.text);
  const failures = rankFailures(dedupeFailures(parsed.failures)).slice(0, MAX_FAILURES);
  const locations = dedupeLocations([
    ...failures.map((failure) => failure.location),
    ...parsed.locations
  ].filter(Boolean)).slice(0, MAX_LOCATIONS);
  const successful = exitCode === null ? null : definition.successExitCodes.includes(exitCode);
  const status = statusFor(definition.id, successful, exitCode, failures, capture.text);

  if (failures.length === 0 && successful === false) {
    const fallback = lastMeaningfulLine(capture.text);
    if (fallback) failures.push({ message: limitText(fallback), code: null, location: null });
  }

  return {
    profileId: definition.id,
    category: definition.category,
    status,
    exitCode,
    mainError: failures[0]?.message || null,
    failures,
    locations,
    counts: {
      detectedFailures: parsed.failures.length,
      returnedFailures: failures.length,
      returnedLocations: locations.length
    },
    truncated: capture.truncated || parsed.failures.length > MAX_FAILURES || parsed.locations.length > MAX_LOCATIONS,
    summaryKind: null,
    details: null,
    suggestedNextActions: [{
      command: definition.next,
      reason: failures.length > 0 ? "Re-run the smallest failing scope" : "Inspect this command with bounded native output"
    }]
  };
}

export function listHighNoiseProfiles() {
  return PROFILE_DEFINITIONS.map(publicProfile);
}

function profile(id, category, matches, options) {
  return {
    id,
    category,
    matches,
    defaults: options.defaults || [],
    successExitCodes: options.successExitCodes || [0],
    next: options.next,
    risk: options.risk || defaultRisk(),
    family: options.family || "general"
  };
}

function goProfile(value) {
  return {
    id: value.id,
    category: value.category,
    matches: (argv) => classifyGoCommandProfile(argv)?.id === value.id,
    defaults: value.defaults,
    successExitCodes: value.successExitCodes,
    next: value.next,
    risk: value.risk,
    prefixLength: value.prefix.length,
    goProfile: true,
    family: "go"
  };
}

function publicProfile(definition, argv = null) {
  const dynamic = definition.goProfile && argv ? classifyGoCommandProfile(argv) : null;
  return {
    id: definition.id,
    category: definition.category,
    safeDefaults: definition.defaults.map((entry) => [...entry.args]),
    successExitCodes: [...definition.successExitCodes],
    nativeNextAction: definition.next,
    risk: dynamic?.risk || definition.risk || defaultRisk(),
    family: definition.family || "general"
  };
}

function defaultRisk() {
  return { level: "low", mutatesWorkspace: false, network: false, interactive: false };
}

function resolveDefinition(value) {
  const id = typeof value === "string" && !/\s/.test(value)
    ? value
    : value?.id || value?.profileId;
  return id ? PROFILE_DEFINITIONS.find((entry) => entry.id === id) : null;
}

function matchPrefix(...prefix) {
  return (argv) => hasPrefix(argv, ...prefix);
}

function matchKubectl(action) {
  return (argv) => {
    const executable = basename(argv[0]);
    if (!["kubectl", "oc"].includes(executable)) return false;
    return argv.slice(1).some((arg) => arg === action);
  };
}

function hasPrefix(argv, ...prefix) {
  return prefix.every((part, index) => basename(argv[index]) === part);
}

function basename(value) {
  return String(value || "").split(/[\\/]/).at(-1);
}

function normalizeArgv(command) {
  if (Array.isArray(command)) return command.map(String).filter(Boolean);
  if (typeof command !== "string") return [];
  return splitCommand(command);
}

function splitCommand(command) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function hasFlag(argv, flag) {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function normalizedOutput(output) {
  if (typeof output !== "object" || output === null || Buffer.isBuffer(output)) return output;
  return [output.stdout, output.stderr].filter(Boolean).map(String).join("\n");
}

function boundedCapture(output) {
  const stdout = typeof output === "object" && output !== null ? output.stdout : output;
  const stderr = typeof output === "object" && output !== null ? output.stderr : "";
  const raw = [stdout, stderr].filter(Boolean).map(String).join("\n");
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= MAX_CAPTURE_BYTES) return { text: clean(raw), truncated: false };

  const budget = Math.floor(MAX_CAPTURE_BYTES / 2);
  const buffer = Buffer.from(raw, "utf8");
  return {
    text: clean(`${buffer.subarray(0, budget).toString("utf8")}\n[output omitted]\n${buffer.subarray(-budget).toString("utf8")}`),
    truncated: true
  };
}

function parseLines(profileId, text) {
  const failures = [];
  const locations = [];
  const lines = text.split(/\r?\n/);
  let pending = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripPrefix(lines[index]).trim();
    if (!line) continue;
    const location = parseLocation(line, profileId);
    if (location) locations.push(location);

    const parsed = failureForLine(profileId, line, lines[index + 1]);
    if (parsed) {
      failures.push(parsed);
      pending = parsed;
      continue;
    }
    if (pending && !pending.location && location) pending.location = location;
  }
  return { failures, locations };
}

function failureForLine(profileId, line, nextLine = "") {
  const located = parseLocatedFailure(line, profileId);
  if (located) return located;

  const patterns = {
    "docker-logs": /\b(?:ERROR|FATAL|PANIC|panic:|exception:)\s*(.+)/i,
    "docker-compose-logs": /\b(?:ERROR|FATAL|PANIC|panic:|exception:)\s*(.+)/i,
    "kubectl-logs": /\b(?:ERROR|FATAL|PANIC|panic:|exception:)\s*(.+)/i,
    "kubectl-describe": /(?:Error from server[^:]*:|\b(?:Failed|BackOff|CrashLoopBackOff|ErrImagePull|ImagePullBackOff)\b)\s*(.*)/i,
    "kubectl-get": /(?:Error from server[^:]*:|^error:)\s*(.*)/i,
    make: /(?:^|\s)(?:make(?:\[\d+\])?: \*\*\*|fatal error:|undefined reference to)\s*(.+)/i,
    "cargo-test": /^(?:error(?:\[([^\]]+)\])?:|test\s+(.+?)\s+\.\.\.\s+FAILED|thread '.+' panicked at)\s*(.*)/i,
    "dotnet-test": /^(?:Failed\s+(.+?)(?:\s+\[|$)|Error Message:\s*(.+)|error\s+([A-Z]+\d+):\s*(.+))/i,
    maven: /^\[ERROR\]\s*(.+)/,
    gradle: /^(?:Execution failed for task|FAILURE:|> Task .+ FAILED|\* What went wrong:)(.*)/i,
    ruff: null,
    mypy: null
  };
  const match = patterns[profileId]?.exec(line);
  if (!match) return null;
  const message = match.slice(1).filter(Boolean).at(-1) || line;
  const next = /\* What went wrong:/i.test(line) && nextLine ? `${line} ${nextLine.trim()}` : message;
  return { message: limitText(next), code: match[1] && /^E\d+$/.test(match[1]) ? match[1] : null, location: null };
}

function parseLocatedFailure(line, profileId) {
  let match;
  if (profileId === "ruff") {
    match = line.match(/^(.+?\.py):(\d+):(\d+):\s*([A-Z]+\d+)\s+(.+)$/);
    if (match) return failure(limitText(match[5]), match[4], match[1], match[2], match[3]);
  }
  if (profileId === "mypy") {
    match = line.match(/^(.+?\.py):(\d+)(?::(\d+))?:\s*error:\s*(.+?)(?:\s+\[([^\]]+)\])?$/i);
    if (match) return failure(limitText(match[4]), match[5] || null, match[1], match[2], match[3]);
  }
  if (profileId === "dotnet-test") {
    match = line.match(/^(.+?\.(?:cs|fs|vb))\((\d+),(\d+)\):\s*error\s+([A-Z]+\d+):\s*(.+?)(?:\s+\[.+\])?$/i);
    if (match) return failure(limitText(match[5]), match[4], match[1], match[2], match[3]);
  }
  if (profileId === "maven") {
    match = line.match(/^\[ERROR\]\s+(.+?):\[(\d+),(\d+)\]\s+(.+)$/);
    if (match) return failure(limitText(match[4]), null, match[1], match[2], match[3]);
  }
  if (["make", "gradle", "cargo-test"].includes(profileId)) {
    match = line.match(/^(?:-->\s*)?(.+?\.(?:rs|c|cc|cpp|h|hpp|java|kt|kts|groovy))(?::|\()\s*(\d+)(?:[:,](\d+))?\)?:\s*(?:(?:fatal\s+)?error(?:\[[^\]]+\])?:\s*)?(.+)?$/i);
    if (match && /error|undefined|cannot|failed|expected/i.test(line)) {
      return failure(limitText(match[4] || line), codeFrom(line), match[1], match[2], match[3]);
    }
  }
  return null;
}

function parseLocation(line, profileId) {
  let match = line.match(/(?:-->|\bat)\s+(.+?):(\d+):(\d+)/);
  if (match) return location(match[1], match[2], match[3]);
  match = line.match(/\bon\s+(.+?\.tf)\s+line\s+(\d+)/i);
  if (match) return location(match[1], match[2], null);
  if (profileId === "dotnet-test") {
    match = line.match(/\bin\s+(.+?):line\s+(\d+)/i);
    if (match) return location(match[1], match[2], null);
  }
  return null;
}

function parseTerraform(text) {
  const json = parseTerraformJson(text);
  if (json) return json;
  const failures = [];
  const locations = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const error = line.match(/^Error:\s*(.+)/i);
    const loc = parseLocation(line, "terraform");
    if (loc) locations.push(loc);
    if (error) {
      const lookaheadLocation = lines.slice(index + 1, index + 5)
        .map((candidate) => parseLocation(candidate, "terraform"))
        .find(Boolean) || null;
      failures.push(failure(limitText(error[1]), null, lookaheadLocation?.file, lookaheadLocation?.line, lookaheadLocation?.column));
    }
  }
  return { failures, locations };
}

function parseTerraformJson(text) {
  try {
    const value = JSON.parse(text);
    const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
    const errors = diagnostics.filter((entry) => entry?.severity === "error");
    return {
      failures: errors.map((entry) => ({
        message: limitText([entry.summary, entry.detail].filter(Boolean).join(": ")),
        code: null,
        location: entry.range?.filename ? location(entry.range.filename, entry.range.start?.line, entry.range.start?.column) : null
      })),
      locations: diagnostics.flatMap((entry) => entry.range?.filename
        ? [location(entry.range.filename, entry.range.start?.line, entry.range.start?.column)]
        : [])
    };
  } catch {
    return null;
  }
}

function statusFor(profileId, successful, exitCode, failures, text) {
  if (successful === false || failures.length > 0) return "failed";
  if (profileId === "terraform-plan" && exitCode === 2) return "changed";
  if (successful === true) return "passed";
  if (/\b(?:FAILED|FAILURE|Error:|\[ERROR\])\b/i.test(text)) return "failed";
  return "unknown";
}

function failure(message, code, file, line, column) {
  return {
    message,
    code: code || null,
    location: file ? location(file, line, column) : null
  };
}

function location(file, line, column) {
  return {
    file: String(file).replace(/^\.\//, ""),
    line: positiveInteger(line),
    column: positiveInteger(column)
  };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function dedupeFailures(failures) {
  const seen = new Set();
  return failures.filter((entry) => {
    const key = [entry.message, entry.code, entry.location?.file, entry.location?.line].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankFailures(failures) {
  return failures
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => failureRank(right.entry) - failureRank(left.entry) || left.index - right.index)
    .map(({ entry }) => entry);
}

function failureRank(entry) {
  if (entry.location && entry.code) return 4;
  if (entry.location) return 3;
  if (entry.code) return 2;
  return 1;
}

function dedupeLocations(locations) {
  const seen = new Set();
  return locations.filter((entry) => {
    const key = [entry.file, entry.line, entry.column].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripPrefix(line) {
  return String(line || "")
    .replace(/^\S+\s+\|\s+/, "");
}

function clean(text) {
  return String(text || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function codeFrom(line) {
  return line.match(/error\[([^\]]+)\]/i)?.[1] || null;
}

function lastMeaningfulLine(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || null;
}

function limitText(value) {
  const text = String(value || "Unknown failure").replace(/\s+/g, " ").trim();
  return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd()}…`;
}
