const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_FAILURES = 12;
const MAX_LOCATIONS = 12;
const MAX_MESSAGE_CHARS = 240;
const MAX_FILE_CHARS = 320;
const MAX_CODE_CHARS = 80;

export const GO_QUALITY_COMMAND_PROFILES = Object.freeze([
  defineProfile({
    id: "govulncheck",
    category: "go-security",
    prefix: ["govulncheck"],
    // JSON has been supported by released govulncheck versions for years and
    // avoids relying on the wording of its human-oriented report.
    defaults: ["-format=json"],
    successExitCodes: [0],
    next: "govulncheck -format=json ./...",
    summaryKind: "vulnerabilities",
    risk: risk("medium", false, true, false)
  }),
  defineProfile({
    id: "staticcheck",
    category: "go-quality",
    prefix: ["staticcheck"],
    // Text is supported across old and current staticcheck releases.
    defaults: ["-f", "text"],
    successExitCodes: [0],
    next: "staticcheck <reported-package>",
    summaryKind: "diagnostics",
    risk: risk("low", false, false, false)
  }),
  defineProfile({
    id: "golangci-lint-run",
    category: "go-quality",
    prefix: ["golangci-lint", "run"],
    // Output flags changed between golangci-lint major versions. Its default
    // line output is stable enough to parse, so adding no flag is safest.
    defaults: [],
    successExitCodes: [0],
    next: "golangci-lint run <reported-package>",
    summaryKind: "issues",
    risk: risk("low", false, false, false)
  })
]);

export function summarizeGoQualityCommand(profileId, output, { exitCode } = {}) {
  const profile = GO_QUALITY_COMMAND_PROFILES.find((entry) => entry.id === profileId);
  if (!profile) return null;

  const capture = boundedCapture(output);
  const parsed = profile.id === "govulncheck"
    ? parseGovulncheck(capture.text)
    : parseDiagnostics(capture.text, profile.id);
  const allFailures = dedupeFailures(parsed.failures);
  const failures = allFailures.slice(0, MAX_FAILURES);
  const allLocations = dedupeLocations([
    ...allFailures.map((failure) => failure.location).filter(Boolean),
    ...parsed.locations
  ]);
  const locations = allLocations.slice(0, MAX_LOCATIONS);
  const normalizedExitCode = Number.isInteger(exitCode) ? exitCode : null;
  const successful = normalizedExitCode === null
    ? null
    : profile.successExitCodes.includes(normalizedExitCode);
  const status = allFailures.length > 0
    ? "findings"
    : successful === null
      ? "unknown"
      : successful
        ? "passed"
        : "failed";

  if (failures.length === 0 && successful === false) {
    const fallback = lastMeaningfulLine(capture.text);
    if (fallback) failures.push(failure(fallback, null, null));
  }

  return {
    profileId: profile.id,
    category: profile.category,
    summaryKind: profile.summaryKind,
    status,
    exitCode: normalizedExitCode,
    mainError: failures[0]?.message || null,
    failures,
    locations,
    counts: {
      vulnerabilities: profile.id === "govulncheck" ? allFailures.length : 0,
      diagnostics: profile.id === "staticcheck" ? allFailures.length : 0,
      issues: profile.id === "golangci-lint-run" ? allFailures.length : 0,
      detectedFailures: allFailures.length,
      returnedFailures: failures.length,
      detectedLocations: allLocations.length,
      returnedLocations: locations.length
    },
    truncated: capture.truncated ||
      allFailures.length > MAX_FAILURES ||
      allLocations.length > MAX_LOCATIONS ||
      parsed.truncated,
    risk: profile.risk,
    suggestedNextActions: [{
      command: profile.next,
      reason: allFailures.length > 0
        ? "Re-run the smallest reported Go scope"
        : "Run the quality check against an explicit bounded target"
    }]
  };
}

function defineProfile(value) {
  return Object.freeze({
    ...value,
    prefix: Object.freeze([...value.prefix]),
    defaults: Object.freeze([...value.defaults]),
    successExitCodes: Object.freeze([...value.successExitCodes]),
    risk: Object.freeze({ ...value.risk })
  });
}

function risk(level, mutatesWorkspace, network, interactive) {
  return { level, mutatesWorkspace, network, interactive };
}

function parseGovulncheck(text) {
  const failures = [];
  const locations = [];
  const osv = new Map();
  const findings = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.osv?.id) {
        osv.set(String(event.osv.id), limit(event.osv.summary || event.osv.details || event.osv.id));
      }
      if (event?.finding) findings.push(event.finding);
    } catch {
      // Older versions and explicit text mode are parsed below.
    }
  }

  for (const finding of findings) {
    const code = nullableCode(finding.osv || finding.id);
    const trace = Array.isArray(finding.trace) ? finding.trace : [];
    const location = trace.map((frame) => locationFromPosition(frame?.position)).find(Boolean) || null;
    const symbol = trace.map((frame) => frame?.function || frame?.functionName).find(Boolean);
    const message = osv.get(code) || symbol || code || "Go vulnerability detected";
    failures.push(failure(message, code, location));
    if (location) locations.push(location);
  }

  if (findings.length === 0) parseGovulncheckText(text, failures, locations);
  return { failures, locations, truncated: false };
}

function parseGovulncheckText(text, failures, locations) {
  let currentCode = null;
  let currentMessage = null;
  let currentLocation = null;

  const flush = () => {
    if (!currentCode) return;
    failures.push(failure(currentMessage || currentCode, currentCode, currentLocation));
    if (currentLocation) locations.push(currentLocation);
    currentCode = null;
    currentMessage = null;
    currentLocation = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^(?:Vulnerability(?:\s+#\d+)?:?\s*)?(GO-\d{4}-\d+)\b[:\s-]*(.*)$/i);
    if (heading) {
      flush();
      currentCode = heading[1].toUpperCase();
      currentMessage = heading[2] || null;
      continue;
    }
    if (!currentCode) continue;
    const location = parseLocation(line);
    if (location && !currentLocation) currentLocation = location;
    if (!currentMessage && line && !/^(?:Found in|Fixed in|More info|Trace):/i.test(line)) {
      currentMessage = line;
    }
  }
  flush();
}

function parseDiagnostics(text, profileId) {
  const failures = [];
  const locations = [];
  let detected = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;
    const match = line.match(/^(.+?\.go):(\d+)(?::(\d+))?:\s*(.+)$/);
    if (!match) continue;
    detected += 1;
    const location = makeLocation(match[1], match[2], match[3]);
    let message = match[4].trim();
    let code = null;
    const suffix = message.match(/\s+\(([^()]+)\)\s*$/);
    if (suffix) {
      code = suffix[1].trim();
      message = message.slice(0, suffix.index).trim();
    } else if (profileId === "staticcheck") {
      const staticcheckCode = message.match(/\b((?:SA|S|ST|QF|U)\d{4})\b/);
      if (staticcheckCode) code = staticcheckCode[1];
    }
    failures.push(failure(message, code, location));
    locations.push(location);
  }
  return { failures, locations, truncated: detected > MAX_FAILURES };
}

function boundedCapture(value) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  if (source.length <= MAX_CAPTURE_BYTES) return { text: source.toString("utf8"), truncated: false };
  return { text: source.subarray(0, MAX_CAPTURE_BYTES).toString("utf8"), truncated: true };
}

function locationFromPosition(position) {
  if (!position || typeof position !== "object") return null;
  const file = position.filename || position.file;
  if (!file) return null;
  return makeLocation(file, position.line, position.column);
}

function parseLocation(value) {
  const match = stripAnsi(value).match(/(?:^|\s|at\s)([^\s:]+\.go):(\d+)(?::(\d+))?/);
  return match ? makeLocation(match[1], match[2], match[3]) : null;
}

function makeLocation(file, line, column) {
  return {
    file: limit(String(file), MAX_FILE_CHARS),
    line: positiveInteger(line),
    column: positiveInteger(column)
  };
}

function failure(message, code, location) {
  return {
    message: limit(stripAnsi(String(message || "Unknown Go quality finding")).trim()),
    code: nullableCode(code),
    location
  };
}

function dedupeFailures(values) {
  const seen = new Set();
  return values.filter((entry) => {
    const loc = entry.location;
    const key = [entry.code, loc?.file, loc?.line, loc?.column, entry.message].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeLocations(values) {
  const seen = new Set();
  return values.filter((entry) => {
    const key = `${entry.file}\0${entry.line}\0${entry.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nullableCode(value) {
  if (value === undefined || value === null || value === "") return null;
  return limit(String(value), MAX_CODE_CHARS);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function lastMeaningfulLine(text) {
  const lines = text.split(/\r?\n/).map((line) => stripAnsi(line).trim()).filter(Boolean);
  return lines.length > 0 ? limit(lines.at(-1)) : null;
}

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function limit(value, maximum = MAX_MESSAGE_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}
