import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REGISTRY_VERSION = 1;

export function registryPath(options = {}) {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  return path.join(homeDir, ".agentshell", "workspaces.json");
}

export function registerWorkspace(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const entries = readRegistryEntries(options);
  const id = workspaceId(resolvedRoot);
  const now = new Date().toISOString();
  const existing = entries.find((entry) => entry.root === resolvedRoot);
  const entry = {
    id,
    root: resolvedRoot,
    name: workspaceName(resolvedRoot),
    lastSeenAt: now
  };

  if (existing) {
    Object.assign(existing, entry);
  } else {
    entries.push(entry);
  }

  writeRegistry(entries, options);
  return entry;
}

export function readRegisteredWorkspaces(options = {}) {
  const entries = readRegistryEntries(options);
  return entries.filter((entry) => (
    (options.includeMissing === true || isDirectory(entry.root))
    && entry.root !== path.parse(entry.root).root
    && (options.excludeTemporary !== true || !isTemporaryRoot(entry.root))
  ));
}

function isTemporaryRoot(root) {
  const candidate = canonicalPath(root);
  return [...new Set([os.tmpdir(), "/tmp", "/var/tmp"].map(canonicalPath))].some((temporary) => (
    candidate === temporary || candidate.startsWith(`${temporary}${path.sep}`)
  ));
}

function canonicalPath(value) {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

function readRegistryEntries(options) {
  const file = registryPath(options);
  if (!fs.existsSync(file)) return [];

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }

  const source = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
  const entries = [];
  const seenRoots = new Set();
  let changed = parsed?.version !== REGISTRY_VERSION || !Array.isArray(parsed?.workspaces);

  for (const candidate of source) {
    const entry = normalizeEntry(candidate);
    if (!entry || seenRoots.has(entry.root)) {
      changed = true;
      continue;
    }
    seenRoots.add(entry.root);
    entries.push(entry);
    if (!sameEntry(candidate, entry)) changed = true;
  }

  if (changed) {
    try {
      writeRegistry(entries, options);
    } catch {
      // A read remains useful even when a damaged registry cannot be repaired.
    }
  }
  return entries;
}

function normalizeEntry(candidate) {
  if (!candidate || typeof candidate !== "object" || typeof candidate.root !== "string") return null;
  if (!path.isAbsolute(candidate.root)) return null;

  const root = path.resolve(candidate.root);
  if (!candidate.lastSeenAt || Number.isNaN(Date.parse(candidate.lastSeenAt))) return null;
  return {
    id: workspaceId(root),
    root,
    name: workspaceName(root),
    lastSeenAt: candidate.lastSeenAt
  };
}

function sameEntry(candidate, normalized) {
  return candidate.id === normalized.id
    && candidate.root === normalized.root
    && candidate.name === normalized.name
    && candidate.lastSeenAt === normalized.lastSeenAt;
}

function writeRegistry(entries, options) {
  const file = registryPath(options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const temporary = path.join(dir, `.workspaces.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const body = `${JSON.stringify({ version: REGISTRY_VERSION, workspaces: entries }, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The successful rename removes the temporary path.
    }
  }
}

function workspaceId(root) {
  return `ws_${crypto.createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

function workspaceName(root) {
  return path.basename(root) || root;
}

function isDirectory(root) {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}
