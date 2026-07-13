import fs from "node:fs";
import path from "node:path";

const DENY_PARTS = new Set([".git", "node_modules", ".agentshell"]);

export function resolveInsideWorkspace(root, target) {
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(absRoot, target);
  const relative = path.relative(absRoot, absTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "FILE_OUTSIDE_WORKSPACE" };
  }

  const parts = relative.split(path.sep);
  if (parts.some((part) => DENY_PARTS.has(part))) {
    return { ok: false, reason: "DENIED_PATH" };
  }

  return { ok: true, absRoot, absTarget, relative };
}

export function findUp(start, names) {
  let current = path.resolve(start);
  while (true) {
    for (const name of names) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
