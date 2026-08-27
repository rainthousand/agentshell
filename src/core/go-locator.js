import fs from "node:fs";
import path from "node:path";

import { boundedProcessOptions, runBoundedProcess } from "./bounded-process.js";
import { fail } from "./output.js";

export const GO_LOCATE_PROTOCOL_VERSION = "agentshell.go-locate.v1";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 40;
const MAX_RESULTS = 200;
const MAX_PACKAGES = 1_000;
const MAX_FILES = 2_000;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 2 * 1024 * 1024;
const MAX_FILE_READ_BYTES = 64 * 1024;
const GENERATED_HEADER_BYTES = 8 * 1024;
const MAX_QUERY_LENGTH = 512;

const GO_FILE_FIELDS = [
  "GoFiles", "CgoFiles", "TestGoFiles", "XTestGoFiles", "IgnoredGoFiles"
];

export async function runGoLocator(root, request = {}, options = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return fail("GO_LOCATE_REQUEST_INVALID", "Go locator request must be an object");
  }
  const mode = request.mode;
  if (!new Set(["symbol", "dependency", "generated"]).has(mode)) {
    return fail("GO_LOCATE_MODE_INVALID", "Mode must be symbol, dependency, or generated");
  }

  const prepared = prepareRoot(root);
  if (!prepared.ok) return prepared;
  const limits = normalizeLimits({ ...options, ...request });
  if (!limits.ok) return limits;
  const deadline = Date.now() + limits.value.timeoutMs;
  const context = {
    root: prepared.root,
    deadline,
    env: safeGoEnvironment(options.env),
    maxResults: limits.value.maxResults,
    runProcess: options.runProcess || runBoundedProcess
  };

  const cache = await readGoModCache(context);
  if (!cache.ok) return cache;
  context.goModCache = cache.value;

  if (mode === "symbol") return locateGoSymbol(prepared.root, request.query, request, context);
  if (mode === "dependency") return locateGoDependency(prepared.root, request.query, request, context);
  return locateGeneratedGo(prepared.root, request, context);
}

export async function locateGoSymbol(root, symbol, options = {}, context = {}) {
  const query = normalizeIdentifier(symbol, "symbol");
  if (!query.ok) return query;
  const packageFilter = normalizePackageFilter(options.package);
  if (!packageFilter.ok) return packageFilter;
  const preparedContext = await ensureContext(root, options, context);
  if (!preparedContext.ok) return preparedContext;

  const listed = await listPackages(preparedContext.value, true);
  if (!listed.ok) return listed;
  const packages = filterPackages(listed.packages, packageFilter.value);
  const searched = await searchSymbolFiles(packages, query.value, preparedContext.value);
  if (!searched.ok) return searched;

  return success("symbol", query.value, searched.results, {
    packageCount: packages.length,
    inspectedFiles: searched.inspectedFiles,
    inspectedBytes: searched.inspectedBytes,
    observedResults: searched.observedResults,
    truncated: searched.truncated || listed.truncated
  }, preparedContext.value, options);
}

export async function locateGoDependency(root, dependency, options = {}, context = {}) {
  const query = normalizeImportPath(dependency, "dependency");
  if (!query.ok) return query;
  const preparedContext = await ensureContext(root, options, context);
  if (!preparedContext.ok) return preparedContext;

  const listed = await listPackages(preparedContext.value, true);
  if (!listed.ok) return listed;
  const matches = [];
  for (const pkg of listed.packages) {
    const modulePath = pkg.Module?.Path || null;
    const exactPackage = pkg.ImportPath === query.value;
    const moduleMatch = modulePath === query.value;
    if (!exactPackage && !moduleMatch) continue;
    matches.push({
      kind: "dependency",
      package: safeImportPath(pkg.ImportPath),
      module: moduleIdentity(pkg.Module, pkg.ImportPath),
      source: packageSource(pkg, preparedContext.value),
      standardLibrary: !pkg.Module && !String(pkg.ImportPath || "").includes("."),
      workspace: isInside(preparedContext.value.root, safeRealpath(pkg.Dir))
    });
  }
  matches.sort(compareResults);
  const observedResults = matches.length;
  const results = matches.slice(0, preparedContext.value.maxResults);

  return success("dependency", query.value, results, {
    packageCount: listed.packages.length,
    inspectedFiles: 0,
    inspectedBytes: 0,
    observedResults,
    truncated: listed.truncated || observedResults > results.length
  }, preparedContext.value, options);
}

export async function locateGeneratedGo(root, options = {}, context = {}) {
  const kind = normalizeGeneratedKind(options.kind);
  if (!kind.ok) return kind;
  const packageFilter = normalizePackageFilter(options.package);
  if (!packageFilter.ok) return packageFilter;
  const preparedContext = await ensureContext(root, options, context);
  if (!preparedContext.ok) return preparedContext;

  const listed = await listPackages(preparedContext.value, false);
  if (!listed.ok) return listed;
  const packages = filterPackages(listed.packages, packageFilter.value)
    .filter((pkg) => isInside(preparedContext.value.root, safeRealpath(pkg.Dir)));
  const inspected = await inspectGeneratedFiles(packages, kind.value, preparedContext.value);
  if (!inspected.ok) return inspected;

  return success("generated", kind.value, inspected.results, {
    packageCount: packages.length,
    inspectedFiles: inspected.inspectedFiles,
    inspectedBytes: inspected.inspectedBytes,
    observedResults: inspected.observedResults,
    truncated: inspected.truncated || listed.truncated
  }, preparedContext.value, options);
}

async function ensureContext(root, options, context) {
  if (context.root && context.deadline && context.runProcess) return { ok: true, value: context };
  const prepared = prepareRoot(root);
  if (!prepared.ok) return prepared;
  const limits = normalizeLimits(options);
  if (!limits.ok) return limits;
  const value = {
    root: prepared.root,
    deadline: Date.now() + limits.value.timeoutMs,
    env: safeGoEnvironment(options.env),
    maxResults: limits.value.maxResults,
    runProcess: options.runProcess || runBoundedProcess
  };
  const cache = await readGoModCache(value);
  if (!cache.ok) return cache;
  value.goModCache = cache.value;
  return { ok: true, value };
}

function prepareRoot(root) {
  const resolved = safeRealpath(path.resolve(root || process.cwd()));
  if (!resolved || !fs.statSync(resolved).isDirectory()) {
    return fail("GO_LOCATE_ROOT_INVALID", "Go locator root must be an existing directory");
  }
  if (!fs.existsSync(path.join(resolved, "go.mod")) && !fs.existsSync(path.join(resolved, "go.work"))) {
    return fail("GO_PROJECT_NOT_FOUND", "Go locator requires go.mod or go.work in the workspace root");
  }
  return { ok: true, root: resolved };
}

function normalizeLimits(options) {
  const timeoutMs = strictInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 5 * 60_000);
  if (timeoutMs === null) return fail("GO_LOCATE_TIMEOUT_INVALID", "timeoutMs must be an integer between 10 and 300000");
  const maxResults = strictInteger(options.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
  if (maxResults === null) return fail("GO_LOCATE_LIMIT_INVALID", `maxResults must be an integer between 1 and ${MAX_RESULTS}`);
  return { ok: true, value: { timeoutMs, maxResults } };
}

async function readGoModCache(context) {
  const result = await runGo(context, ["go", "env", "GOMODCACHE"], 16 * 1024);
  if (!result.ok) return result;
  const candidate = result.execution.stdout.trim();
  const resolved = candidate ? safeRealpath(candidate) : null;
  return { ok: true, value: resolved };
}

async function listPackages(context, includeDependencies) {
  const argv = ["go", "list"];
  if (includeDependencies) argv.push("-deps");
  argv.push("-json", "./...");
  const result = await runGo(context, argv, MAX_METADATA_BYTES);
  if (!result.ok) return result;
  if (result.execution.truncated) {
    return fail("GO_LOCATE_METADATA_TRUNCATED", "Go package metadata exceeded the bounded output limit", {
      outputLimitBytes: result.execution.outputLimitBytes
    });
  }
  const parsed = parseGoListJson(result.execution.stdout, MAX_PACKAGES);
  if (!parsed.ok) return parsed;
  return parsed;
}

async function runGo(context, argv, maxOutputBytes) {
  const remaining = context.deadline - Date.now();
  if (remaining <= 0) return timeoutFailure();
  const limits = boundedProcessOptions({ timeoutMs: remaining, maxOutputBytes });
  const execution = await context.runProcess(argv, context.root, {
    ...limits,
    env: context.env
  });
  if (execution.timedOut) return timeoutFailure();
  if (execution.exitCode !== 0) {
    return fail("GO_LOCATE_COMMAND_FAILED", "Unable to read local Go package metadata", {
      executable: "go",
      args: argv.slice(1),
      exitCode: execution.exitCode,
      network: false,
      shellInterpolation: false
    });
  }
  return { ok: true, execution };
}

export function parseGoListJson(source, maximum = MAX_PACKAGES) {
  const packages = [];
  let index = 0;
  const text = String(source || "");
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    if (text[index] !== "{") return fail("GO_LOCATE_METADATA_INVALID", "go list returned malformed JSON metadata");
    const end = findJsonObjectEnd(text, index);
    if (end === -1) return fail("GO_LOCATE_METADATA_INVALID", "go list returned incomplete JSON metadata");
    try {
      const value = JSON.parse(text.slice(index, end + 1));
      if (value && typeof value.ImportPath === "string" && typeof value.Dir === "string") packages.push(value);
    } catch {
      return fail("GO_LOCATE_METADATA_INVALID", "go list returned malformed JSON metadata");
    }
    if (packages.length > maximum) {
      return fail("GO_LOCATE_PACKAGE_LIMIT", `Go package enumeration exceeded ${maximum} packages`, { maximum });
    }
    index = end + 1;
  }
  packages.sort((left, right) => compareText(left.ImportPath, right.ImportPath));
  return { ok: true, packages, truncated: false };
}

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

async function searchSymbolFiles(packages, symbol, context) {
  const declaration = symbolMatchers(symbol);
  const results = [];
  let observedResults = 0;
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  let truncated = false;
  const candidates = packageFiles(packages, context).slice(0, MAX_FILES);
  if (candidates.length === MAX_FILES) truncated = true;

  for (const candidate of candidates) {
    if (Date.now() >= context.deadline) return timeoutFailure();
    const readBudget = Math.min(MAX_FILE_READ_BYTES, MAX_TOTAL_READ_BYTES - inspectedBytes);
    if (readBudget <= 0) {
      truncated = true;
      break;
    }
    const content = await readBoundedFile(candidate.absolute, readBudget);
    if (!content) continue;
    inspectedFiles += 1;
    inspectedBytes += content.bytes;
    const lines = content.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = declaration.find((matcher) => matcher.regex.test(lines[index]));
      if (!match) continue;
      observedResults += 1;
      if (results.length < context.maxResults) {
        results.push({
          kind: "symbol",
          symbol,
          declaration: match.kind,
          package: safeImportPath(candidate.pkg.ImportPath),
          module: moduleIdentity(candidate.pkg.Module, candidate.pkg.ImportPath),
          source: packageSource(candidate.pkg, context),
          file: displayFile(candidate, context),
          line: index + 1
        });
      } else truncated = true;
    }
  }
  results.sort(compareResults);
  return { ok: true, results, observedResults, inspectedFiles, inspectedBytes, truncated };
}

async function inspectGeneratedFiles(packages, requestedKind, context) {
  const results = [];
  let observedResults = 0;
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  let truncated = false;
  const candidates = packageFiles(packages, context).slice(0, MAX_FILES);
  if (candidates.length === MAX_FILES) truncated = true;

  for (const candidate of candidates) {
    if (Date.now() >= context.deadline) return timeoutFailure();
    const remaining = MAX_TOTAL_READ_BYTES - inspectedBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const content = await readBoundedFile(candidate.absolute, Math.min(GENERATED_HEADER_BYTES, remaining));
    if (!content) continue;
    inspectedFiles += 1;
    inspectedBytes += content.bytes;
    const detected = classifyGeneratedGoFile(candidate.file, content.text);
    if (!detected.generated || (requestedKind !== "all" && detected.kind !== requestedKind)) continue;
    observedResults += 1;
    if (results.length < context.maxResults) {
      results.push({
        kind: "generated",
        generator: detected.kind,
        evidence: detected.evidence,
        package: safeImportPath(candidate.pkg.ImportPath),
        module: moduleIdentity(candidate.pkg.Module, candidate.pkg.ImportPath),
        source: "workspace",
        file: displayFile(candidate, context)
      });
    } else truncated = true;
  }
  results.sort(compareResults);
  return { ok: true, results, observedResults, inspectedFiles, inspectedBytes, truncated };
}

export function classifyGeneratedGoFile(file, header = "") {
  const name = path.basename(String(file || "")).toLowerCase();
  const text = String(header || "").slice(0, GENERATED_HEADER_BYTES).toLowerCase();
  if (name.endsWith("_grpc.pb.go") || /protoc-gen-go-grpc/.test(text)) return generated("grpc", "grpc marker");
  if (name.endsWith(".pb.go") || /protoc-gen-go|protocol buffer compiler/.test(text)) return generated("pb", "protobuf marker");
  if (name === "wire_gen.go" || /code generated by wire/.test(text)) return generated("wire", "wire marker");
  if (/^(mock_|mock\.).*\.go$/.test(name) || /(?:_mock|\.mock)\.go$/.test(name) || /mockgen|mockery/.test(text)) {
    return generated("mock", "mock marker");
  }
  if (/code generated .* do not edit\.?/i.test(header)) return generated("generic", "generated header");
  return { generated: false, kind: null, evidence: null };
}

function generated(kind, evidence) {
  return { generated: true, kind, evidence };
}

function packageFiles(packages, context) {
  const candidates = [];
  for (const pkg of packages) {
    const directory = safeRealpath(pkg.Dir);
    if (!directory) continue;
    for (const field of GO_FILE_FIELDS) {
      for (const file of Array.isArray(pkg[field]) ? pkg[field] : []) {
        if (!safeFileName(file)) continue;
        const absolute = safeRealpath(path.join(directory, file));
        if (!absolute || !isInside(directory, absolute)) continue;
        const workspace = isInside(context.root, absolute);
        const moduleDir = safeRealpath(pkg.Module?.Dir);
        const dependency = Boolean(moduleDir && isInside(moduleDir, absolute));
        if (!workspace && !dependency) continue;
        candidates.push({ pkg, file, absolute, directory, moduleDir, workspace });
      }
    }
  }
  return uniqueBy(candidates, (entry) => entry.absolute)
    .sort((left, right) => compareText(displayFile(left, context), displayFile(right, context)));
}

function displayFile(candidate, context) {
  if (candidate.workspace) return normalizeSlash(path.relative(context.root, candidate.absolute));
  const module = moduleIdentity(candidate.pkg.Module, candidate.pkg.ImportPath);
  const relative = candidate.moduleDir && isInside(candidate.moduleDir, candidate.absolute)
    ? normalizeSlash(path.relative(candidate.moduleDir, candidate.absolute))
    : path.basename(candidate.absolute);
  return `module:${module}/${relative}`;
}

function moduleIdentity(module, importPath) {
  if (!module?.Path) return String(importPath || "standard-library");
  const version = module.Version ? `@${sanitizeVersion(module.Version)}` : "";
  return `${safeImportPath(module.Path)}${version}`;
}

function packageSource(pkg, context) {
  const directory = safeRealpath(pkg?.Dir) || safeRealpath(pkg?.Module?.Dir);
  if (isInside(context.root, directory)) return "workspace";
  if (isInside(context.goModCache, directory)) return "module-cache";
  if (pkg?.Module) return "local-replace";
  return "standard-library";
}

function sanitizeVersion(version) {
  return String(version || "").replace(/[^A-Za-z0-9.+_-]/g, "").slice(0, 96) || "unknown";
}

function safeImportPath(value) {
  const text = String(value || "unknown");
  return /^[A-Za-z0-9._~+/-]+$/.test(text) ? text.slice(0, MAX_QUERY_LENGTH) : "redacted-module";
}

function filterPackages(packages, filter) {
  if (!filter) return packages;
  return packages.filter((pkg) => pkg.ImportPath === filter || pkg.ImportPath.startsWith(`${filter}/`));
}

function success(mode, query, results, measurements, context, options) {
  return {
    ok: true,
    protocolVersion: GO_LOCATE_PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    mode,
    query,
    summary: {
      resultCount: results.length,
      observedResults: measurements.observedResults,
      packageCount: measurements.packageCount,
      inspectedFiles: measurements.inspectedFiles,
      inspectedBytes: measurements.inspectedBytes,
      truncated: measurements.truncated
    },
    results,
    privacy: {
      workspacePathsRelative: true,
      dependencyCachePathsExposed: false,
      homePathsExposed: false,
      networkAccess: false
    },
    limits: {
      maxResults: context.maxResults,
      maxPackages: MAX_PACKAGES,
      maxFiles: MAX_FILES,
      maxReadBytes: MAX_TOTAL_READ_BYTES
    },
    suggestedNextActions: results.slice(0, 1).map((result) => mode === "dependency" ? ({
      command: `agentshell go locate symbol <name> --package ${shellSafe(result.package)}`,
      reason: "Locate a concrete declaration inside this dependency package"
    }) : ({
      command: result.file.startsWith("module:")
        ? `agentshell go locate dependency ${shellSafe(result.module.split("@")[0])}`
        : `agentshell read ${shellSafe(result.file)}${result.line ? ` --around ${result.line}` : ""}`,
      reason: "Inspect the smallest concrete result without broad filesystem search"
    }))
  };
}

function safeGoEnvironment(environment) {
  const env = {
    ...(environment || process.env),
    GOENV: "off",
    GOFLAGS: "-mod=readonly",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOTOOLCHAIN: "local"
  };
  delete env.GOWORK;
  return env;
}

function normalizeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value.length > 256) {
    return fail("GO_LOCATE_QUERY_INVALID", `${label} must be one concrete Go identifier`);
  }
  return { ok: true, value };
}

function normalizeImportPath(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_QUERY_LENGTH ||
    value.startsWith("-") || value.includes("://") || value.includes("\\") ||
    /[\0\r\n\t *?{}[\]'"`;$|&<>]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return fail("GO_LOCATE_QUERY_INVALID", `${label} must be one concrete module or package import path`);
  }
  return { ok: true, value };
}

function normalizePackageFilter(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  return normalizeImportPath(value, "package filter");
}

function normalizeGeneratedKind(value) {
  const kind = value === undefined ? "all" : value;
  if (!new Set(["all", "pb", "grpc", "mock", "wire", "generic"]).has(kind)) {
    return fail("GO_LOCATE_KIND_INVALID", "Generated kind must be all, pb, grpc, mock, wire, or generic");
  }
  return { ok: true, value: kind };
}

function symbolMatchers(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    { kind: "function", regex: new RegExp(`^\\s*func\\s+(?:\\([^\\n)]{1,240}\\)\\s*)?${escaped}\\s*(?:\\[|\\()`) },
    { kind: "type", regex: new RegExp(`^\\s*type\\s+${escaped}\\b`) },
    { kind: "variable", regex: new RegExp(`^\\s*var\\s+${escaped}\\b`) },
    { kind: "constant", regex: new RegExp(`^\\s*const\\s+${escaped}\\b`) }
  ];
}

async function readBoundedFile(file, maximum) {
  try {
    const handle = await fs.promises.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const size = Math.min(stat.size, maximum);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) return null;
      return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function timeoutFailure() {
  return fail("GO_LOCATE_TIMEOUT", "Go locator exceeded its bounded timeout", { timedOut: true });
}

function strictInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function safeRealpath(target) {
  if (!target) return null;
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isInside(root, target) {
  if (!root || !target) return false;
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeFileName(value) {
  return typeof value === "string" && value.endsWith(".go") && path.basename(value) === value && !value.includes("\0");
}

function normalizeSlash(value) {
  return String(value || "").replaceAll(path.sep, "/");
}

function shellSafe(value) {
  return /^[A-Za-z0-9_./@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function uniqueBy(values, keyOf) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareResults(left, right) {
  return compareText(
    `${left.file?.startsWith("module:") ? "1" : "0"}\0${left.file || ""}\0${left.module || ""}\0${left.package || ""}\0${left.line || 0}`,
    `${right.file?.startsWith("module:") ? "1" : "0"}\0${right.file || ""}\0${right.module || ""}\0${right.package || ""}\0${right.line || 0}`
  );
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "en");
}
