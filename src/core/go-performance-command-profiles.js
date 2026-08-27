const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_FUNCTIONS = 12;
const MAX_HOT_FUNCTIONS = 10;
const MAX_ERRORS = 8;
const MAX_LINE_CHARS = 240;

export const GO_PERFORMANCE_COMMAND_PROFILES = Object.freeze([
  Object.freeze({
    id: "go-tool-cover",
    category: "go-performance",
    prefix: Object.freeze(["go", "tool", "cover"]),
    defaults: Object.freeze([]),
    successExitCodes: Object.freeze([0]),
    next: "go tool cover -func=coverage.out",
    summaryKind: "coverage",
    risk: Object.freeze({ level: "low", mutatesWorkspace: false, network: false, interactive: false })
  }),
  Object.freeze({
    id: "go-tool-pprof",
    category: "go-performance",
    prefix: Object.freeze(["go", "tool", "pprof"]),
    // `go tool pprof profile.pb.gz` opens an interactive prompt. Text mode is
    // mandatory for unattended agents, and nodecount bounds native output too.
    defaults: Object.freeze(["-top", `-nodecount=${MAX_HOT_FUNCTIONS}`]),
    successExitCodes: Object.freeze([0]),
    next: "go tool pprof -top -nodecount=10 <binary> <profile>",
    summaryKind: "hot-functions",
    risk: Object.freeze({ level: "low", mutatesWorkspace: false, network: false, interactive: false })
  })
]);

export function summarizeGoPerformanceCommand(profileId, output, { exitCode } = {}) {
  const profile = GO_PERFORMANCE_COMMAND_PROFILES.find((entry) => entry.id === profileId);
  if (!profile) return null;

  const capture = boundedCapture(output);
  const normalizedExitCode = Number.isInteger(exitCode) ? exitCode : null;
  const parsedFailures = extractFailures(capture.text);
  const successful = normalizedExitCode === null
    ? null
    : profile.successExitCodes.includes(normalizedExitCode);
  const status = successful === null ? "unknown" : successful ? "passed" : "failed";
  if (successful === false && parsedFailures.failures.length === 0) {
    const fallback = lastMeaningfulLine(capture.text);
    if (fallback) {
      parsedFailures.failures.push({ message: fallback, code: null, location: null });
      parsedFailures.detected += 1;
    }
  }
  const parsed = profile.summaryKind === "coverage"
    ? summarizeCoverage(capture.text)
    : summarizePprof(capture.text);

  return {
    profileId: profile.id,
    category: profile.category,
    summaryKind: profile.summaryKind,
    status,
    exitCode: normalizedExitCode,
    mainError: parsedFailures.failures[0]?.message || null,
    failures: parsedFailures.failures,
    locations: parsedFailures.locations,
    counts: {
      detectedFailures: parsedFailures.detected,
      returnedFailures: parsedFailures.failures.length,
      returnedLocations: parsedFailures.locations.length,
      ...parsed.counts
    },
    truncated: capture.truncated || parsed.truncated || parsedFailures.truncated,
    details: parsed.details,
    next: profile.next
  };
}

function summarizeCoverage(text) {
  const functions = [];
  let totalPercent = null;
  let detectedFunctions = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const total = line.match(/^total:\s+\([^)]*\)\s+([\d.]+)%$/i);
    if (total) {
      totalPercent = Number(total[1]);
      continue;
    }

    const fn = line.match(/^(.+?):(\d+):\s+(.+?)\s+([\d.]+)%$/);
    if (!fn) continue;
    detectedFunctions += 1;
    if (functions.length < MAX_FUNCTIONS) {
      functions.push({
        file: limit(fn[1], MAX_LINE_CHARS),
        line: Number(fn[2]),
        function: limit(fn[3], MAX_LINE_CHARS),
        percent: Number(fn[4])
      });
    }
  }

  return {
    details: { coverage: { totalPercent, functions }, hotFunctions: [] },
    counts: { detectedFunctions, returnedFunctions: functions.length, detectedHotFunctions: 0, returnedHotFunctions: 0 },
    truncated: detectedFunctions > functions.length
  };
}

function summarizePprof(text) {
  const hotFunctions = [];
  let detectedHotFunctions = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const row = line.match(/^(\S+)\s+([\d.]+)%\s+([\d.]+)%\s+(\S+)\s+([\d.]+)%\s+(.+)$/);
    if (!row || /^flat$/i.test(row[1])) continue;
    detectedHotFunctions += 1;
    if (hotFunctions.length < MAX_HOT_FUNCTIONS) {
      hotFunctions.push({
        flat: row[1],
        flatPercent: Number(row[2]),
        cumulativePercent: Number(row[3]),
        cumulative: row[4],
        cumulativeSharePercent: Number(row[5]),
        function: limit(row[6], MAX_LINE_CHARS)
      });
    }
  }

  return {
    details: { coverage: null, hotFunctions },
    counts: { detectedFunctions: 0, returnedFunctions: 0, detectedHotFunctions, returnedHotFunctions: hotFunctions.length },
    truncated: detectedHotFunctions > hotFunctions.length
  };
}

function extractFailures(text) {
  const failures = [];
  const locations = [];
  let detected = 0;
  const seen = new Set();
  const pattern = /(?:^|\b)(?:error|fatal|failed|cannot|can't|no such file|unknown option|usage:)/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !pattern.test(line)) continue;
    detected += 1;
    const value = limit(line, MAX_LINE_CHARS);
    if (!seen.has(value) && failures.length < MAX_ERRORS) {
      seen.add(value);
      const location = parseLocation(line);
      failures.push({ message: value, code: errorCode(line), location });
      if (location && locations.length < MAX_ERRORS) locations.push(location);
    }
  }
  return { failures, locations, detected, truncated: detected > failures.length };
}

function parseLocation(line) {
  const match = line.match(/(?:^|\s)([^\s:]+):(\d+)(?::(\d+))?/);
  return match ? {
    file: limit(match[1], MAX_LINE_CHARS),
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  } : null;
}

function errorCode(line) {
  const match = line.match(/\b(?:error|fatal|failed)\b/i);
  return match ? match[0].toLowerCase() : null;
}

function lastMeaningfulLine(text) {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line && line !== "...[output truncated]...") return limit(line, MAX_LINE_CHARS);
  }
  return null;
}

function boundedCapture(output) {
  const text = typeof output === "string"
    ? output
    : `${output?.stdout || ""}\n${output?.stderr || ""}`;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_CAPTURE_BYTES) return { text, truncated: false };

  const half = Math.floor(MAX_CAPTURE_BYTES / 2);
  return {
    text: `${bytes.subarray(0, half).toString("utf8")}\n...[output truncated]...\n${bytes.subarray(bytes.length - half).toString("utf8")}`,
    truncated: true
  };
}

function limit(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
