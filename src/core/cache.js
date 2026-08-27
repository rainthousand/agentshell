import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ensureState } from "./store.js";

const CACHE_VERSION = 2;
const MAX_ENTRIES = 20;
const MAX_GO_CACHE_FILES = 2000;
const MAX_PROJECT_CACHE_FILES = 5000;
const GO_INPUT_EXTENSIONS = new Set([
  ".go",
  ".c",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".cc",
  ".cpp",
  ".cxx",
  ".f",
  ".for",
  ".f90",
  ".m",
  ".mm",
  ".s",
  ".swig",
  ".swigcxx",
  ".syso"
]);
const GO_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".agentshell",
  ".cache",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage"
]);
const PROJECT_IGNORED_DIRECTORIES = new Set([
  ...GO_IGNORED_DIRECTORIES,
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vite",
  ".venv",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "target",
  "tmp",
  "temp",
  "artifacts",
  "reports"
]);
const PROJECT_INPUT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".gradle", ".h", ".hpp", ".html",
  ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".mjs", ".cjs", ".py",
  ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".vue", ".xml",
  ".yaml", ".yml"
]);
const LOCK_FILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
];

export function findTestResultCache(root, { type, command, packagePath }) {
  const context = createTestResultCacheContext(root, { type, command, packagePath });
  return findTestResultCacheFromContext(context);
}

export function createTestResultCacheContext(root, {
  type,
  command,
  packagePath,
  project = null,
  readCacheFile = true
}) {
  const identity = cacheIdentity(root, { type, command, packagePath });
  const cache = readCacheFile
    ? readCache(root)
    : { version: CACHE_VERSION, entries: [] };
  const entries = cache.entries
    .filter((entry) => entry.version === CACHE_VERSION && entry.identityKey === identity.identityKey)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    root,
    type,
    command,
    packagePath,
    project,
    identity,
    cache,
    entries
  };
}

export function findTestResultCacheFromContext(context) {
  let reason = context.entries.length === 0 ? "no-compatible-entry" : "inputs-changed";
  const fingerprints = new Map();
  const inputFor = (relatedFiles = []) => {
    const usesWholeProjectFingerprint = context.project?.kind !== "go" &&
      path.basename(context.packagePath) !== "go.mod";
    const normalized = usesWholeProjectFingerprint
      ? []
      : [...new Set(relatedFiles)].sort();
    const key = JSON.stringify(normalized);
    if (!fingerprints.has(key)) {
      fingerprints.set(key, fingerprintCacheInput(context, normalized));
    }
    return fingerprints.get(key);
  };
  const baseline = inputFor();
  let currentInputDigest = baseline.inputDigest;
  let currentInputFileCount = baseline.fileCount;
  let currentCacheKey = baseline.cacheKey || context.identity.identityKey;
  if (!baseline.ok) reason = baseline.reason;
  for (const entry of context.entries) {
    const root = context.root;
    if (!hasLog(root, entry.logRef)) {
      reason = "source-log-missing";
      continue;
    }
    const fingerprint = inputFor(entry.relatedFiles || []);
    if (!fingerprint.ok) {
      reason = fingerprint.reason || "input-read-failed";
      continue;
    }
    currentInputDigest = fingerprint.inputDigest;
    currentInputFileCount = fingerprint.fileCount;
    const cacheKey = fingerprint.cacheKey;
    currentCacheKey = cacheKey;
    if (cacheKey === entry.cacheKey) {
      return {
        cacheHit: true,
        cacheKey,
        entry,
        createdAt: entry.createdAt,
        inputDigest: fingerprint.inputDigest,
        inputFileCount: fingerprint.fileCount,
        reason: "inputs-unchanged"
      };
    }
  }

  return {
    cacheHit: false,
    cacheKey: currentCacheKey,
    identity: context.identity,
    createdAt: null,
    inputDigest: currentInputDigest,
    inputFileCount: currentInputFileCount,
    reason
  };
}

export function currentTestResultCacheInput(context, relatedFiles = []) {
  return fingerprintCacheInput(context, relatedFiles);
}

function fingerprintCacheInput(context, relatedFiles = []) {
  const files = collectFingerprintFiles(
    context.root,
    context.packagePath,
    relatedFiles,
    context.project
  );
  if (files.length <= 1) {
    return {
      ok: false,
      inputDigest: null,
      fileCount: files.length,
      cacheKey: null,
      reason: "input-set-unavailable"
    };
  }
  const fingerprint = fingerprintFromFiles(context.root, files);
  return {
    ok: fingerprint.ok,
    inputDigest: fingerprint.inputDigest,
    fileCount: fingerprint.files.length,
    cacheKey: fingerprint.ok ? buildCacheKey(context.identity, fingerprint.files) : null,
    reason: fingerprint.reason
  };
}

export function findRelatedTestFilesCache(root, { type, command, packagePath }) {
  const context = createTestResultCacheContext(root, { type, command, packagePath });
  return findRelatedTestFilesCacheFromContext(context);
}

export function findRelatedTestFilesCacheFromContext(context) {
  for (const entry of context.entries) {
    const root = context.root;
    if (!hasLog(root, entry.logRef)) continue;
    const relatedTestFiles = (entry.relatedFiles || [])
      .filter((file) => isRelatedTestFile(file))
      .filter((file) => {
        const absolute = path.join(root, file);
        return isInside(root, absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile();
      });
    if (relatedTestFiles.length > 0) {
      return {
        cacheHit: true,
        relatedTestFiles,
        sourceLogRef: entry.logRef
      };
    }
  }

  return {
    cacheHit: false,
    relatedTestFiles: []
  };
}

export function writeTestResultCache(root, { type, command, packagePath, result, summary, relatedFiles, logRef }) {
  const context = createTestResultCacheContext(root, { type, command, packagePath });
  return writeTestResultCacheFromContext(context, { result, summary, relatedFiles, logRef });
}

export function writeTestResultCacheFromContext(context, { result, summary, relatedFiles, logRef }) {
  const { root, type, command, packagePath } = context;
  if (result.exitCode === 0 || relatedFiles.length === 0) {
    return null;
  }

  const files = collectFingerprintFiles(root, packagePath, relatedFiles, context.project);
  if (files.length <= 1) return null;

  const fingerprint = fingerprintFromFiles(root, files);
  if (!fingerprint.ok) return null;

  const cacheKey = buildCacheKey(context.identity, fingerprint.files);
  const cache = context.cache;
  const entry = {
    version: CACHE_VERSION,
    identityKey: context.identity.identityKey,
    cacheKey,
    createdAt: new Date().toISOString(),
    type,
    command,
    exitCode: result.exitCode,
    summary,
    relatedFiles,
    logRef,
    rawOutputChars: `${result.stdout}\n${result.stderr}`.length,
    files: fingerprint.files.map((file) => file.path),
    inputDigest: fingerprint.inputDigest
  };

  cache.entries = [
    entry,
    ...cache.entries.filter((candidate) => candidate.cacheKey !== cacheKey)
  ].slice(0, MAX_ENTRIES);
  context.entries = [
    entry,
    ...context.entries.filter((candidate) => candidate.cacheKey !== cacheKey)
  ].slice(0, MAX_ENTRIES);
  writeCache(root, cache);
  return {
    cacheKey,
    createdAt: entry.createdAt,
    inputDigest: entry.inputDigest,
    inputFileCount: entry.files.length,
    reason: "stored-failure-result"
  };
}

export function explainTestResultCache(root, options) {
  const context = createTestResultCacheContext(root, options);
  const lookup = findTestResultCacheFromContext(context);
  return {
    ok: true,
    protocolVersion: "agentshell.verify-cache.v1",
    action: "explain",
    cacheHit: lookup.cacheHit,
    cacheKey: lookup.cacheKey,
    cacheCreatedAt: lookup.createdAt || null,
    cacheInputDigest: lookup.inputDigest || null,
    cacheInputFileCount: lookup.inputFileCount || 0,
    cacheReason: lookup.reason,
    entryCount: context.entries.length,
    identity: context.identity,
    suggestedNextActions: lookup.cacheHit ? [{
      command: "agentshell verify test --no-cache --compact",
      reason: "Force a fresh verification when cached evidence should not be reused"
    }] : []
  };
}

export function clearTestResultCache(root, options = {}) {
  const cache = readCache(root);
  const before = cache.entries.length;
  let removedEntries = before;

  if (options.type && options.command && options.packagePath) {
    const identity = cacheIdentity(root, options);
    cache.entries = cache.entries.filter((entry) => entry.identityKey !== identity.identityKey);
    removedEntries = before - cache.entries.length;
  } else {
    cache.entries = [];
  }

  writeCache(root, cache);
  return {
    ok: true,
    protocolVersion: "agentshell.verify-cache.v1",
    action: "clear",
    removedEntries,
    remainingEntries: cache.entries.length,
    cacheFile: path.relative(root, cachePath(root)).split(path.sep).join("/"),
    suggestedNextActions: [{
      command: "agentshell verify test --compact",
      reason: "Create fresh verification evidence"
    }]
  };
}

function isRelatedTestFile(file) {
  return /(?:^|\/)(?:test|tests)\//.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /_test\.go$/.test(file);
}

function cacheIdentity(root, { type, command, packagePath }) {
  const packageRelative = relativePath(root, packagePath);
  const identity = {
    version: CACHE_VERSION,
    type,
    command,
    packageFile: packageRelative
  };
  return {
    ...identity,
    identityKey: digest(identity)
  };
}

function collectFingerprintFiles(root, packagePath, relatedFiles, project = null) {
  const files = new Set([
    relativePath(root, packagePath),
    ...LOCK_FILES.filter((file) => fs.existsSync(path.join(root, file))),
    ...relatedFiles
  ]);

  if (project?.manifest === "go.work") {
    for (const module of project.modules.filter((candidate) => candidate.valid)) {
      const goFiles = goModuleFingerprintFiles(root, module.root);
      if (!goFiles) return [];
      for (const file of goFiles) files.add(file);
      for (const manifest of ["go.mod", "go.sum"]) {
        const absolute = path.join(module.root, manifest);
        if (fs.existsSync(absolute)) files.add(relativePath(root, absolute));
      }
      if (files.size > MAX_GO_CACHE_FILES) return [];
    }
  } else if (path.basename(packagePath) === "go.mod") {
    const goFiles = goModuleFingerprintFiles(root, root);
    if (!goFiles) return [];
    for (const file of goFiles) files.add(file);
    if (fs.existsSync(path.join(root, "go.sum"))) files.add("go.sum");
  } else {
    const projectFiles = projectFingerprintFiles(root);
    if (!projectFiles) return [];
    for (const file of projectFiles) files.add(file);
  }

  for (const file of relatedFiles) {
    for (const imported of localImports(root, file)) {
      files.add(imported);
    }
    for (const sibling of siblingGoFiles(root, file)) {
      files.add(sibling);
    }
  }

  return [...files].sort();
}

function projectFingerprintFiles(root) {
  try {
    const files = new Set();
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!PROJECT_IGNORED_DIRECTORIES.has(entry.name)) pending.push(absolute);
          continue;
        }
        if (!entry.isFile() || !isProjectInputFile(entry.name)) continue;
        files.add(relativePath(root, absolute));
        if (files.size > MAX_PROJECT_CACHE_FILES) return null;
      }
    }
    return [...files].sort();
  } catch {
    return null;
  }
}

function isProjectInputFile(name) {
  if (PROJECT_INPUT_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
  return /^(?:Dockerfile|Makefile|Procfile|Jenkinsfile|mvnw|gradlew)$/.test(name) ||
    /^(?:\.env(?:\..+)?|\.npmrc|\.nvmrc|\.tool-versions)$/.test(name);
}

function goModuleFingerprintFiles(root, moduleRoot) {
  try {
    const files = new Set();
    const embeddedPackageDirectories = new Set();
    const pending = [{ directory: moduleRoot, inTestdata: false }];
    while (pending.length > 0) {
      const { directory, inTestdata } = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (GO_IGNORED_DIRECTORIES.has(entry.name)) continue;
          if (absolute !== moduleRoot && fs.existsSync(path.join(absolute, "go.mod"))) continue;
          pending.push({
            directory: absolute,
            inTestdata: inTestdata || entry.name === "testdata"
          });
          continue;
        }
        if (!entry.isFile()) continue;

        const extension = path.extname(entry.name).toLowerCase();
        if (inTestdata || GO_INPUT_EXTENSIONS.has(extension)) {
          files.add(relativePath(root, absolute));
        }
        if (extension === ".go" && hasGoEmbedDirective(absolute)) {
          embeddedPackageDirectories.add(directory);
        }
        if (files.size > MAX_GO_CACHE_FILES) return null;
      }
    }

    for (const directory of embeddedPackageDirectories) {
      if (!collectEmbeddedPackageFiles(root, directory, files)) return null;
    }
    return [...files].sort();
  } catch {
    return null;
  }
}

function hasGoEmbedDirective(file) {
  return /^\s*\/\/go:embed(?:\s|$)/m.test(fs.readFileSync(file, "utf8"));
}

function collectEmbeddedPackageFiles(root, packageDirectory, files) {
  const pending = [packageDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (GO_IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (absolute !== packageDirectory && fs.existsSync(path.join(absolute, "go.mod"))) continue;
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.add(relativePath(root, absolute));
        if (files.size > MAX_GO_CACHE_FILES) return false;
      }
    }
  }
  return true;
}

function siblingGoFiles(root, file) {
  if (!file.endsWith(".go")) return [];
  const directory = path.dirname(path.join(root, file));
  if (directory !== root && !isInside(root, directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go"))
    .map((entry) => relativePath(root, path.join(directory, entry.name)))
    .sort();
}

function fingerprintFromFiles(root, files) {
  const fingerprint = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!isInside(root, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return { ok: false, files: [], inputDigest: null, reason: "input-missing-or-outside-workspace" };
    }
    fingerprint.push({
      path: file,
      hash: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
    });
  }
  const sorted = fingerprint.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    files: sorted,
    inputDigest: digest(sorted),
    reason: "fingerprinted"
  };
}

function localImports(root, file) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(file)) return [];

  const content = fs.readFileSync(absolute, "utf8");
  const imports = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /\brequire\(['"](\.{1,2}\/[^'"]+)['"]\)/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const resolved = resolveImport(root, path.dirname(file), match[1]);
      if (resolved) imports.add(resolved);
    }
  }

  return [...imports].sort();
}

function resolveImport(root, fromDir, specifier) {
  const base = path.normalize(path.join(fromDir, specifier));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.js"),
    path.join(base, "index.ts")
  ];

  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (isInside(root, absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return relativePath(root, absolute);
    }
  }
  return null;
}

function readCache(root) {
  const file = cachePath(root);
  if (!fs.existsSync(file)) return { version: CACHE_VERSION, entries: [] };
  try {
    const cache = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: CACHE_VERSION,
      entries: Array.isArray(cache.entries) ? cache.entries : []
    };
  } catch {
    return { version: CACHE_VERSION, entries: [] };
  }
}

function writeCache(root, cache) {
  const file = cachePath(root);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function cachePath(root) {
  return path.join(ensureState(root), "test-result-cache.json");
}

function hasLog(root, logRef) {
  if (!logRef) return false;
  const dir = ensureState(root);
  return fs.existsSync(path.join(dir, "logs", `${logRef}.stdout.log`)) &&
    fs.existsSync(path.join(dir, "logs", `${logRef}.stderr.log`));
}

function buildCacheKey(identity, files) {
  return digest({
    version: CACHE_VERSION,
    type: identity.type,
    command: identity.command,
    packageFile: identity.packageFile,
    files
  });
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16)}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
