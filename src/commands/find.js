import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_MATCHES = 20;
const PROTOCOL_VERSION = "agentshell.find.v1";

export async function find(root, query) {
  const rg = spawnSync("rg", [
    "--json",
    "--line-number",
    "--no-heading",
    "--glob",
    "!.agentshell/**",
    "--glob",
    "!node_modules/**",
    query,
    "."
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8
  });

  if (rg.error && rg.error.code === "ENOENT") {
    return fallbackFind(root, query);
  }

  const matches = [];
  for (const line of rg.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "match") continue;
      matches.push({
        file: event.data.path.text.replace(/^\.\//, ""),
        line: event.data.line_number,
        preview: event.data.lines.text.trimEnd()
      });
      if (matches.length >= MAX_MATCHES) break;
    } catch {
      // Ignore malformed rg JSON lines.
    }
  }

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    query,
    matches,
    total: matches.length,
    truncated: matches.length >= MAX_MATCHES
  };
}

function fallbackFind(root, query) {
  const matches = [];
  walk(root, (file) => {
    if (matches.length >= MAX_MATCHES) return;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(query)) {
        matches.push({
          file: path.relative(root, file),
          line: i + 1,
          preview: lines[i]
        });
        if (matches.length >= MAX_MATCHES) return;
      }
    }
  });

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    query,
    matches,
    total: matches.length,
    truncated: matches.length >= MAX_MATCHES
  };
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agentshell") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    if (entry.isFile() && isTextLike(entry.name)) onFile(full);
  }
}

function isTextLike(name) {
  return /\.(js|jsx|ts|tsx|json|md|css|html|rs|py|go|toml|yaml|yml)$/.test(name);
}
