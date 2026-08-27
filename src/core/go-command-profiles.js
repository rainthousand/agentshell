import {
  GO_QUERY_COMMAND_PROFILES,
  summarizeGoQueryCommand
} from "./go-query-command-profiles.js";
import {
  GO_PERFORMANCE_COMMAND_PROFILES,
  summarizeGoPerformanceCommand
} from "./go-performance-command-profiles.js";
import {
  GO_QUALITY_COMMAND_PROFILES,
  summarizeGoQualityCommand
} from "./go-quality-command-profiles.js";
import {
  GO_DEV_COMMAND_PROFILES,
  summarizeGoDevCommand
} from "./go-dev-command-profiles.js";

const GROUPS = [
  [GO_QUERY_COMMAND_PROFILES, summarizeGoQueryCommand],
  [GO_PERFORMANCE_COMMAND_PROFILES, summarizeGoPerformanceCommand],
  [GO_QUALITY_COMMAND_PROFILES, summarizeGoQualityCommand],
  [GO_DEV_COMMAND_PROFILES, summarizeGoDevCommand]
];

const PROFILE_ENTRIES = GROUPS.flatMap(([profiles, summarize]) => (
  profiles.map((profile) => [normalizeProfile(profile), summarize])
));

export const GO_COMMAND_PROFILES = Object.freeze(PROFILE_ENTRIES.map(([profile]) => profile));

export function classifyGoCommandProfile(command) {
  const argv = Array.isArray(command) ? command.map(String).filter(Boolean) : [];
  if (argv.length === 0) return null;
  const profile = GO_COMMAND_PROFILES.find((candidate) => matchesPrefix(argv, candidate.prefix));
  return profile ? { ...profile, risk: commandRisk(profile, argv) } : null;
}

export function summarizeGoCommandProfile(profileOrId, output, options = {}) {
  const id = typeof profileOrId === "string" ? profileOrId : profileOrId?.id || profileOrId?.profileId;
  const entry = PROFILE_ENTRIES.find(([profile]) => profile.id === id);
  if (!entry) return null;
  const [profile, summarize] = entry;
  const result = summarize(profile.id, output, options) || {};
  const failures = boundedFailures(result.failures);
  const locations = boundedLocations([
    ...(Array.isArray(result.locations) ? result.locations : []),
    ...failures.map((failure) => failure.location).filter(Boolean)
  ]);
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  const successful = exitCode === null ? null : profile.successExitCodes.includes(exitCode);
  const status = normalizeStatus(result.status, successful, failures);

  return {
    profileId: profile.id,
    category: profile.category,
    status,
    exitCode,
    mainError: limitText(result.mainError || failures[0]?.message || null, 240),
    failures,
    locations,
    counts: {
      detectedFailures: nonNegativeInteger(result.counts?.detectedFailures, failures.length),
      returnedFailures: failures.length,
      returnedLocations: locations.length
    },
    truncated: Boolean(result.truncated)
      || (result.failures?.length || 0) > failures.length
      || (result.locations?.length || 0) > locations.length,
    summaryKind: profile.summaryKind,
    details: result.details && typeof result.details === "object" ? result.details : null,
    suggestedNextActions: [{
      command: profile.next,
      reason: failures.length > 0
        ? "Inspect or rerun the smallest reported Go scope"
        : "Continue with the bounded Go command profile"
    }]
  };
}

function normalizeProfile(profile) {
  if (!profile?.id || !Array.isArray(profile.prefix) || profile.prefix.length === 0) {
    throw new Error("Go command profiles require id and prefix");
  }
  const defaults = normalizeDefaults(profile.defaults);
  if (profile.id === "go-tool-pprof") {
    const presentation = defaults.find((entry) => entry.args.includes("-top"));
    if (presentation) {
      presentation.flags = [
        "-top", "-text", "-http", "-web", "-svg", "-pdf", "-png", "-gif",
        "-list", "-weblist", "-peek", "-raw", "-traces", "-tree", "-callgrind",
        "-comments", "-disasm", "-dot", "-proto"
      ];
    }
  }
  return Object.freeze({
    id: String(profile.id),
    category: String(profile.category || "go-tooling"),
    prefix: profile.prefix.map(String),
    defaults,
    successExitCodes: Array.isArray(profile.successExitCodes) && profile.successExitCodes.length > 0
      ? profile.successExitCodes.filter(Number.isInteger)
      : [0],
    next: String(profile.next || `${profile.prefix.join(" ")} <args...>`),
    summaryKind: String(profile.summaryKind || "go-tool"),
    risk: normalizeRisk(profile.risk)
  });
}

function normalizeDefaults(defaults) {
  if (!Array.isArray(defaults)) return [];
  if (defaults.every((entry) => typeof entry === "string")) {
    return groupFlatDefaults(defaults).map((args) => ({
      args,
      flags: defaultFlags(args),
      position: "after-prefix"
    }));
  }
  return defaults.flatMap((entry) => {
    const args = Array.isArray(entry) ? entry.map(String) : entry?.args?.map(String);
    if (!args?.length) return [];
    const flags = Array.isArray(entry?.flags) && entry.flags.length > 0
      ? entry.flags.map(String)
      : defaultFlags(args);
    return [{ args, flags, position: entry?.position === "append" ? "append" : "after-prefix" }];
  });
}

function groupFlatDefaults(values) {
  const groups = [];
  for (let index = 0; index < values.length; index += 1) {
    const args = [String(values[index])];
    if (String(values[index]).startsWith("-") && values[index + 1] && !String(values[index + 1]).startsWith("-")) {
      args.push(String(values[index + 1]));
      index += 1;
    }
    groups.push(args);
  }
  return groups;
}

function defaultFlags(args) {
  return [String(args[0]).split("=")[0]];
}

function normalizeRisk(risk = {}) {
  return Object.freeze({
    level: String(risk.level || "read-only"),
    mutatesWorkspace: risk.mutatesWorkspace === true,
    network: risk.network === true,
    interactive: risk.interactive === true
  });
}

function commandRisk(profile, argv) {
  const risk = { ...profile.risk };
  if (profile.id === "go-env" && argv.some((arg) => arg === "-w" || arg === "-u")) {
    risk.level = "high";
  }
  if (profile.id === "go-tool-pprof" && argv.some((arg) => arg === "-http" || arg.startsWith("-http="))) {
    risk.level = "medium";
    risk.interactive = true;
  }
  if (profile.id === "go-tool-cover" && argv.some((arg) => arg === "-html" || arg.startsWith("-html="))
    && !argv.some((arg) => arg === "-o" || arg.startsWith("-o="))) {
    risk.level = "medium";
    risk.interactive = true;
  }
  return Object.freeze(risk);
}

function matchesPrefix(argv, prefix) {
  return prefix.every((part, index) => {
    const value = index === 0 ? basename(argv[index]) : argv[index];
    return value === part;
  });
}

function basename(value) {
  return String(value || "").split(/[\\/]/).at(-1);
}

function boundedFailures(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const message = limitText(value?.message, 240);
    if (!message) continue;
    const location = normalizeLocation(value.location);
    const key = `${message}\0${location?.file || ""}\0${location?.line || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ message, code: value?.code ? limitText(value.code, 80) : null, location });
    if (result.length === 8) break;
  }
  return result;
}

function boundedLocations(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const location = normalizeLocation(value);
    if (!location) continue;
    const key = `${location.file}\0${location.line || ""}\0${location.column || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(location);
    if (result.length === 8) break;
  }
  return result;
}

function normalizeLocation(value) {
  if (!value?.file) return null;
  return {
    file: String(value.file).replace(/^\.\//u, ""),
    line: positiveInteger(value.line),
    column: positiveInteger(value.column)
  };
}

function normalizeStatus(value, successful, failures) {
  if (["passed", "failed", "changed", "unknown"].includes(value)) return value;
  if (successful === false || failures.length > 0) return "failed";
  if (successful === true) return "passed";
  return "unknown";
}

function limitText(value, maximum) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
