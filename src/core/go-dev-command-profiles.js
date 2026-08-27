const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_ITEMS = 8;
const MAX_MESSAGE_CHARS = 240;

export const GO_DEV_COMMAND_PROFILES = Object.freeze([
  commandProfile({
    id: "dlv",
    category: "go-debug",
    prefix: ["dlv"],
    interactive: true,
    mutatesWorkspace: false,
    network: true,
    riskLevel: "high",
    next: "dlv <subcommand> <explicit-target>",
    summaryKind: "debug-session"
  }),
  commandProfile({
    id: "mockgen",
    category: "go-code-generation",
    prefix: ["mockgen"],
    interactive: false,
    mutatesWorkspace: true,
    network: false,
    riskLevel: "medium",
    next: "git diff -- <generated-mock-file>",
    summaryKind: "generated-code"
  }),
  commandProfile({
    id: "wire",
    category: "go-code-generation",
    prefix: ["wire"],
    interactive: false,
    mutatesWorkspace: true,
    network: false,
    riskLevel: "medium",
    next: "git diff -- wire_gen.go",
    summaryKind: "generated-code"
  })
]);

export function summarizeGoDevCommand(profileId, output, options = {}) {
  const profile = GO_DEV_COMMAND_PROFILES.find((candidate) => candidate.id === profileId);
  if (!profile) return null;

  const capture = boundedCapture(output);
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  const parsed = profile.id === "dlv"
    ? parseDlv(capture.text)
    : parseGenerator(profile.id, capture.text);
  const detectedFailures = unique(parsed.errors).map(failureFromMessage);
  const failures = detectedFailures.slice(0, MAX_ITEMS);
  const locations = uniqueLocations(parsed.locations).slice(0, MAX_ITEMS);
  const generatedFiles = unique(parsed.generatedFiles).slice(0, MAX_ITEMS);
  const status = resolveStatus(profile, exitCode, failures, parsed.exited);

  return {
    profileId: profile.id,
    category: profile.category,
    summaryKind: profile.summaryKind,
    status,
    mainError: failures[0]?.message || null,
    failures,
    locations,
    counts: {
      detectedFailures: detectedFailures.length,
      returnedFailures: failures.length,
      detectedLocations: parsed.locations.length,
      returnedLocations: locations.length,
      detectedGeneratedFiles: parsed.generatedFiles.length,
      returnedGeneratedFiles: generatedFiles.length
    },
    truncated: capture.truncated ||
      detectedFailures.length > MAX_ITEMS ||
      parsed.locations.length > MAX_ITEMS ||
      parsed.generatedFiles.length > MAX_ITEMS,
    exitCode,
    interactive: profile.interactive,
    mutatesWorkspace: profile.mutatesWorkspace,
    risk: profile.risk,
    details: {
      listeningAddress: parsed.listeningAddress,
      processExit: parsed.processExit,
      generatedFiles
    },
    suggestedNextActions: [{
      command: profile.next,
      reason: profile.interactive
        ? "Interactive debugging requires an explicit target and bounded execution policy"
        : "Code generation can modify the workspace and should remain user-authorized"
    }]
  };
}

function commandProfile(definition) {
  return Object.freeze({
    id: definition.id,
    category: definition.category,
    prefix: Object.freeze([...definition.prefix]),
    defaults: Object.freeze([]),
    successExitCodes: Object.freeze([0]),
    next: definition.next,
    summaryKind: definition.summaryKind,
    interactive: definition.interactive,
    mutatesWorkspace: definition.mutatesWorkspace,
    risk: Object.freeze({
      level: definition.riskLevel,
      mutatesWorkspace: definition.mutatesWorkspace,
      network: definition.network,
      interactive: definition.interactive
    })
  });
}

function parseDlv(text) {
  const result = emptyParsed();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const listening = line.match(/(?:API|DAP) server listening at:\s*(\S+)/i);
    if (listening && !result.listeningAddress) result.listeningAddress = limitText(listening[1]);

    const exited = line.match(/(?:process\s+\d+\s+has\s+exited|process\s+exited|exited)\s+(?:with\s+(?:status|code)\s+)?(-?\d+)/i);
    if (exited) {
      result.exited = true;
      result.processExit = Number(exited[1]);
    }

    collectLocation(line, result.locations);
    if (isErrorLine(line)) result.errors.push(limitText(stripToolPrefix(line, "dlv")));
  }
  return result;
}

function parseGenerator(profileId, text) {
  const result = emptyParsed();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    collectLocation(line, result.locations);
    const generated = generatedFile(line);
    if (generated) result.generatedFiles.push(generated);
    if (isErrorLine(line) || (profileId === "wire" && /wire:\s+.*failed\b/i.test(line))) {
      result.errors.push(limitText(stripToolPrefix(line, profileId)));
    }
  }
  return result;
}

function emptyParsed() {
  return {
    listeningAddress: null,
    processExit: null,
    exited: false,
    generatedFiles: [],
    errors: [],
    locations: []
  };
}

function collectLocation(line, locations) {
  const match = line.match(/((?:[A-Za-z]:)?[^\s:]+\.go):(\d+)(?::(\d+))?/);
  if (!match) return;
  locations.push({
    file: limitText(match[1]),
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  });
}

function generatedFile(line) {
  const explicit = line.match(/\b(?:generated|generating|wrote|writing|output(?:\s+file)?(?:\s+to)?)\s*:?\s+([^\s"']+\.go)\b/i);
  if (explicit) return limitText(explicit[1]);
  const wire = line.match(/\bwire:\s+\S+\s+wrote\s+(\S+\.go)\b/i);
  return wire ? limitText(wire[1]) : null;
}

function isErrorLine(line) {
  return /\b(?:error|fatal|panic|failed|cannot|could not|no required module|no provider found|undefined)\b/i.test(line);
}

function stripToolPrefix(line, profileId) {
  return line.replace(new RegExp(`^${profileId}:\\s*`, "i"), "");
}

function resolveStatus(profile, exitCode, errors, exited) {
  if (exitCode === null) return errors.length > 0 ? "failed" : exited ? "exited" : "unknown";
  return profile.successExitCodes.includes(exitCode) && errors.length === 0 ? "passed" : "failed";
}

function boundedCapture(output) {
  const stdout = typeof output === "object" && output !== null ? output.stdout : output;
  const stderr = typeof output === "object" && output !== null ? output.stderr : "";
  const raw = [stdout, stderr].filter((value) => value !== undefined && value !== null && value !== "")
    .map(String).join("\n");
  const buffer = Buffer.from(raw);
  if (buffer.length <= MAX_CAPTURE_BYTES) return { text: raw, truncated: false };

  const half = Math.floor(MAX_CAPTURE_BYTES / 2);
  return {
    text: `${decodeUtf8(buffer.subarray(0, half))}\n... output truncated ...\n${decodeUtf8(buffer.subarray(buffer.length - half))}`,
    truncated: true
  };
}

function decodeUtf8(buffer) {
  return buffer.toString("utf8").replace(/^\uFFFD|\uFFFD$/g, "");
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueLocations(locations) {
  const seen = new Set();
  return locations.filter((location) => {
    const key = `${location.file}:${location.line}:${location.column ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function failureFromMessage(message) {
  return {
    message: limitText(message),
    code: errorCode(message),
    location: locationFromMessage(message)
  };
}

function errorCode(message) {
  const bracketed = message.match(/\[([A-Za-z][A-Za-z0-9_.-]{1,63})\]/);
  const assigned = message.match(/\b(?:code|error)\s*[=:]\s*([A-Za-z][A-Za-z0-9_.-]{1,63})\b/i);
  return limitText(bracketed?.[1] || assigned?.[1]) || null;
}

function locationFromMessage(message) {
  const match = message.match(/((?:[A-Za-z]:)?[^\s:]+\.go):(\d+)(?::(\d+))?/);
  return match ? {
    file: limitText(match[1]),
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  } : null;
}

function limitText(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS - 3)}...`;
}
