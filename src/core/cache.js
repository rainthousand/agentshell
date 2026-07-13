import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ensureState } from "./store.js";

const CACHE_VERSION = 1;
const MAX_ENTRIES = 20;
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

export function createTestResultCacheContext(root, { type, command, packagePath }) {
  const identity = cacheIdentity(root, { type, command, packagePath });
  const cache = readCache(root);
  const entries = cache.entries
    .filter((entry) => entry.version === CACHE_VERSION && entry.identityKey === identity.identityKey)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    root,
    type,
    command,
    packagePath,
    identity,
    cache,
    entries
  };
}

export function findTestResultCacheFromContext(context) {
  for (const entry of context.entries) {
    const root = context.root;
    if (!hasLog(root, entry.logRef)) continue;
    const fingerprint = fingerprintFromFiles(root, entry.files || []);
    if (!fingerprint.ok) continue;
    const cacheKey = buildCacheKey(context.identity, fingerprint.files);
    if (cacheKey === entry.cacheKey) {
      return {
        cacheHit: true,
        cacheKey,
        entry
      };
    }
  }

  return {
    cacheHit: false,
    cacheKey: context.identity.identityKey,
    identity: context.identity
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

  const files = collectFingerprintFiles(root, packagePath, relatedFiles);
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
    files: fingerprint.files.map((file) => file.path)
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
  return { cacheKey };
}

function isRelatedTestFile(file) {
  return /(?:^|\/)(?:test|tests)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
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

function collectFingerprintFiles(root, packagePath, relatedFiles) {
  const files = new Set([
    relativePath(root, packagePath),
    ...LOCK_FILES.filter((file) => fs.existsSync(path.join(root, file))),
    ...relatedFiles
  ]);

  for (const file of relatedFiles) {
    for (const imported of localImports(root, file)) {
      files.add(imported);
    }
  }

  return [...files].sort();
}

function fingerprintFromFiles(root, files) {
  const fingerprint = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!isInside(root, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return { ok: false, files: [] };
    }
    fingerprint.push({
      path: file,
      hash: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
    });
  }
  return { ok: true, files: fingerprint.sort((a, b) => a.path.localeCompare(b.path)) };
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
  fs.writeFileSync(cachePath(root), `${JSON.stringify(cache, null, 2)}\n`);
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
