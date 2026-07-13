import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_MANIFEST = path.join(".codex-plugin", "plugin.json");

export function resolvePackageRoot(options = {}) {
  const env = options.env || process.env;
  const explicit = options.packageRoot || env.AGENTSHELL_PACKAGE_ROOT;
  if (explicit) {
    const root = validPackageRoot(explicit);
    if (root) return root;
    throw new Error(`Invalid AgentShell package root: ${path.resolve(explicit)}`);
  }

  const sourceRoot = path.resolve(options.sourceRoot || path.join(import.meta.dirname, "..", ".."));
  const executablePath = path.resolve(options.executablePath || process.execPath);
  const executableDir = path.dirname(executablePath);
  const directCandidates = [
    options.root,
    sourceRoot,
    executableDir,
    path.dirname(executableDir),
    path.join(executableDir, "agentshell"),
    path.join(executableDir, "resources", "agentshell"),
    path.join(path.dirname(executableDir), "Resources", "agentshell")
  ];
  for (const candidate of directCandidates) {
    const root = validPackageRoot(candidate);
    if (root) return root;
  }

  const installed = installedCandidates(options)
    .map((candidate) => ({ root: validPackageRoot(candidate), modifiedAt: modifiedAt(candidate) }))
    .filter((candidate) => candidate.root)
    .sort(compareInstalledCandidates);
  if (installed[0]) return installed[0].root;

  throw new Error("AgentShell package root was not found. Set AGENTSHELL_PACKAGE_ROOT to the installed plugin directory.");
}

function installedCandidates(options) {
  if (Array.isArray(options.installedCandidates)) return options.installedCandidates;
  const home = path.resolve(options.homeDir || os.homedir());
  const codexHome = path.resolve(options.codexHome || path.join(home, ".codex"));
  const roots = [
    path.join(codexHome, "plugins", "cache", "personal", "agentshell"),
    path.join(home, ".agents", "plugins", "marketplaces", "personal", "plugins", "agentshell")
  ];
  const candidates = [];
  for (const root of roots) {
    if (validPackageRoot(root)) candidates.push(root);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(path.join(root, entry.name));
      }
    } catch {}
  }
  return candidates;
}

function validPackageRoot(candidate) {
  if (!candidate) return null;
  const root = path.resolve(candidate);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, PLUGIN_MANIFEST), "utf8"));
    return manifest?.name === "agentshell" ? root : null;
  } catch {
    return null;
  }
}

function modifiedAt(candidate) {
  try { return fs.statSync(path.join(candidate, PLUGIN_MANIFEST)).mtimeMs; } catch { return 0; }
}

function compareInstalledCandidates(left, right) {
  if (right.modifiedAt !== left.modifiedAt) return right.modifiedAt - left.modifiedAt;
  return right.root.localeCompare(left.root, "en", { numeric: true });
}
