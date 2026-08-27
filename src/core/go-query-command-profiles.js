const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_ITEMS = 20;
const MAX_ERRORS = 8;
const MAX_TEXT_CHARS = 240;

export const GO_QUERY_COMMAND_PROFILES = Object.freeze([
  defineProfile("go-run", "execution", ["go", "run"], "process", {
    risk: risk("high", true, false, true),
    riskNote: "The target program can perform arbitrary side effects.",
    next: "go run <explicit-package-or-files>"
  }),
  defineProfile("go-list", "query", ["go", "list"], "package", {
    risk: risk("low", false, true, false),
    riskNote: "May access the network and populate the local Go build or module cache.",
    next: "go list <explicit-package-pattern>"
  }),
  defineProfile("go-env", "query", ["go", "env"], "environment", {
    risk: risk("low", false, false, false),
    riskNote: "Values can contain local paths or private configuration.",
    next: "go env <explicit-variable>"
  }),
  defineProfile("go-get", "dependency", ["go", "get"], "module", {
    risk: risk("high", true, true, false),
    riskNote: "Can access the network and modify go.mod or go.sum.",
    next: "git diff -- go.mod go.sum"
  }),
  defineProfile("go-install", "tooling", ["go", "install"], "module", {
    risk: risk("medium", false, true, false),
    riskNote: "Can access the network and write binaries to GOBIN or GOPATH/bin.",
    next: "go version -m <installed-binary>"
  }),
  defineProfile("go-mod-download", "dependency", ["go", "mod", "download"], "module", {
    risk: risk("high", true, true, false),
    riskNote: "Can access the network, populate the module cache, and update go.sum.",
    next: "git diff -- go.sum"
  }),
  defineProfile("go-mod-graph", "dependency-query", ["go", "mod", "graph"], "module-graph", {
    risk: risk("low", false, true, false),
    riskNote: "Does not intentionally edit the workspace; missing modules may be resolved by Go.",
    next: "go mod graph"
  }),
  defineProfile("go-mod-why", "dependency-query", ["go", "mod", "why"], "module-reason", {
    risk: risk("low", false, true, false),
    riskNote: "Does not intentionally edit the workspace; Go may resolve missing modules.",
    next: "go mod why <module-or-package>"
  })
]);

export function summarizeGoQueryCommand(profileId, output, options = {}) {
  const profile = GO_QUERY_COMMAND_PROFILES.find((entry) => entry.id === profileId);
  if (!profile) return null;

  const capture = boundedCapture(output);
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  const lines = capture.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failures = collectFailures(lines);
  const locations = uniqueLocations(failures.map((failure) => failure.location).filter(Boolean));
  const parsed = parseSummary(profile, capture.text, lines, options);

  return {
    profileId: profile.id,
    category: profile.category,
    summaryKind: profile.summaryKind,
    status: exitCode === null ? "unknown" : exitCode === 0 ? "passed" : "failed",
    exitCode,
    mainError: failures[0]?.message || null,
    failures: failures.slice(0, MAX_ERRORS),
    locations: locations.slice(0, MAX_ERRORS),
    risk: profile.risk,
    counts: {
      packages: parsed.packages.length,
      modules: parsed.modules.length,
      environmentKeys: parsed.environmentKeys.length,
      failures: failures.length,
      locations: locations.length
    },
    truncated: capture.truncated || parsed.packages.length > MAX_ITEMS ||
      parsed.modules.length > MAX_ITEMS || parsed.environmentKeys.length > MAX_ITEMS ||
      failures.length > MAX_ERRORS || locations.length > MAX_ERRORS,
    details: {
      packages: parsed.packages.slice(0, MAX_ITEMS),
      modules: parsed.modules.slice(0, MAX_ITEMS),
      environmentKeys: parsed.environmentKeys.slice(0, MAX_ITEMS)
    },
    suggestedNextActions: [{
      command: profile.next,
      reason: exitCode && failures.length ? "Inspect the smallest failing scope" : "Continue with an explicit bounded target"
    }]
  };
}

function defineProfile(id, category, prefix, summaryKind, options) {
  return Object.freeze({
    id,
    category,
    prefix: Object.freeze([...prefix]),
    defaults: Object.freeze([]),
    successExitCodes: Object.freeze([0]),
    next: options.next,
    summaryKind,
    risk: options.risk,
    riskNote: options.riskNote,
    outputLimitBytes: MAX_CAPTURE_BYTES
  });
}

function risk(level, mutatesWorkspace, network, interactive) {
  return Object.freeze({ level, mutatesWorkspace, network, interactive });
}

function parseSummary(profile, text, lines, options) {
  const result = { packages: [], modules: [], environmentKeys: [] };
  if (profile.id === "go-list") result.packages = parsePackages(text, lines);
  if (profile.id === "go-env") {
    result.environmentKeys = unique([
      ...parseEnvironmentKeys(text, lines),
      ...requestedEnvironmentKeys(options.argv)
    ]);
  }
  if (["go-get", "go-install", "go-mod-download"].includes(profile.id)) {
    result.modules = parseModuleChanges(text, lines);
  }
  if (profile.id === "go-mod-graph") result.modules = parseModuleGraph(lines);
  if (profile.id === "go-mod-why") {
    result.packages = unique(lines.filter((line) => line.startsWith("# ")).map((line) => line.slice(2)));
    result.modules = unique(lines.filter(isModuleToken).map(firstToken));
  }
  return result;
}

function requestedEnvironmentKeys(argv) {
  if (!Array.isArray(argv)) return [];
  const offset = argv.findIndex((value, index) => index > 0 && value === "env");
  if (offset < 0) return [];
  return argv.slice(offset + 1)
    .filter((value) => /^[A-Z][A-Z0-9_]*$/.test(String(value)))
    .map(String);
}

function parsePackages(text, lines) {
  const packages = [];
  for (const value of parseJsonObjects(text)) {
    if (typeof value?.ImportPath === "string") packages.push(value.ImportPath);
  }
  if (packages.length === 0) {
    for (const line of lines) {
      const token = firstToken(line);
      if (isPackageToken(token) && !looksLikeError(line)) packages.push(token);
    }
  }
  return unique(packages.map(sanitizeIdentifier).filter(Boolean));
}

function parseEnvironmentKeys(text, lines) {
  const keys = [];
  for (const value of parseJsonObjects(text)) {
    if (!value || Array.isArray(value) || typeof value !== "object") continue;
    keys.push(...Object.keys(value));
  }
  for (const line of lines) {
    const match = /^(?:set\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.push(match[1]);
    else if (/^[A-Z][A-Z0-9_]*$/.test(line)) keys.push(line);
  }
  return unique(keys);
}

function parseModuleChanges(text, lines) {
  const modules = [];
  for (const value of parseJsonObjects(text)) {
    if (typeof value?.Path === "string") modules.push(joinModuleVersion(value.Path, value.Version));
  }
  for (const line of lines) {
    const change = /^(?:go:\s+)?(?:downloading|added|upgraded|downgraded|removed)\s+(\S+)(?:\s+(\S+))?/i.exec(line);
    if (change) modules.push(joinModuleVersion(change[1], change[2]));
  }
  return unique(modules.map(sanitizeIdentifier).filter(Boolean));
}

function parseModuleGraph(lines) {
  const modules = [];
  for (const line of lines) {
    const [from, to] = line.split(/\s+/, 2);
    if (isModuleToken(from)) modules.push(sanitizeIdentifier(from));
    if (isModuleToken(to)) modules.push(sanitizeIdentifier(to));
  }
  return unique(modules.filter(Boolean));
}

function collectFailures(lines) {
  const failures = [];
  for (const line of lines) {
    if (!looksLikeError(line)) continue;
    const location = parseLocation(line);
    const sanitized = sanitizeText(line);
    if (sanitized) failures.push({
      message: sanitized,
      code: classifyError(line),
      location
    });
  }
  return uniqueFailures(failures);
}

function parseLocation(line) {
  const match = /((?:[A-Za-z]:)?[^\s:]+\.go):(\d+)(?::(\d+))?/.exec(line);
  if (!match) return null;
  const file = sanitizeLocationFile(match[1]);
  if (!file) return null;
  return { file, line: Number(match[2]), column: match[3] ? Number(match[3]) : null };
}

function sanitizeLocationFile(file) {
  const normalized = String(file).replaceAll("\\", "/");
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) return normalized.split("/").at(-1).slice(0, MAX_TEXT_CHARS);
  if (normalized.includes("..")) return normalized.split("/").at(-1).slice(0, MAX_TEXT_CHARS);
  return normalized.slice(0, MAX_TEXT_CHARS);
}

function classifyError(line) {
  if (/panic/i.test(line)) return "panic";
  if (/unknown revision|no required module|malformed module|go\.mod/i.test(line)) return "module";
  if (/\.go:\d+/.test(line)) return "compile";
  return "command";
}

function looksLikeError(line) {
  return /(?:^|\b)(?:error|fatal|panic|failed|cannot|undefined|malformed|invalid|unknown revision|no required module)(?:\b|:)/i.test(line);
}

function boundedCapture(output) {
  const raw = typeof output === "string"
    ? output
    : `${output?.stdout || ""}\n${output?.stderr || ""}`;
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length <= MAX_CAPTURE_BYTES) return { text: raw, truncated: false };
  const half = Math.floor(MAX_CAPTURE_BYTES / 2);
  return {
    text: `${bytes.subarray(0, half).toString("utf8")}\n... output truncated ...\n${bytes.subarray(-half).toString("utf8")}`,
    truncated: true
  };
}

function parseJsonObjects(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    const values = [];
    for (const line of text.split(/\r?\n/)) {
      try { values.push(JSON.parse(line)); } catch { /* Native text output is expected. */ }
    }
    return values;
  }
}

function sanitizeText(value) {
  return String(value)
    .replace(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/)[^\s:'"]+/g, "<path>")
    .replace(/(token|password|secret|authorization)=?\s*[^\s]+/gi, "$1=<redacted>")
    .slice(0, MAX_TEXT_CHARS);
}

function sanitizeIdentifier(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("\\") || text.startsWith("/") || text.includes("..")) return null;
  return text.slice(0, MAX_TEXT_CHARS);
}

function isPackageToken(value) {
  return Boolean(value) && !value.startsWith("-") && /^[\w.~@/+:-]+$/.test(value);
}

function isModuleToken(value) {
  return isPackageToken(firstToken(value)) && /[\/.]v?\d|@v?\d|\.[a-z]{2,}\//i.test(firstToken(value));
}

function firstToken(value) {
  return String(value || "").split(/\s+/, 1)[0];
}

function joinModuleVersion(module, version) {
  if (!version || String(module).includes("@")) return module;
  return `${module}@${version}`;
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueFailures(failures) {
  const seen = new Set();
  return failures.filter((failure) => {
    const key = `${failure.message}\0${failure.code}\0${JSON.stringify(failure.location)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueLocations(locations) {
  const seen = new Set();
  return locations.filter((location) => {
    const key = `${location.file}:${location.line}:${location.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
