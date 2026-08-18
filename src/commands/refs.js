import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.refs.v1";
const DEFAULT_COMPACT_LIMIT = 40;
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 200;
const PREVIEW_CHARS = 120;
const IGNORED_DIRS = [
  ".agentshell",
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules"
];
const TEXT_EXTENSIONS = /\.(c|cc|cpp|css|go|h|hpp|html|java|js|jsx|json|md|mjs|py|rs|sh|sql|ts|tsx|toml|txt|yaml|yml)$/i;

export async function refs(root, symbol, options = {}) {
  const query = String(symbol || "").trim();
  if (!query) {
    return invalidArgument();
  }

  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const limit = boundedLimit(options.limit, compact);
  const rg = spawnSync("rg", rgArgs(query), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8
  });

  const rawMatches = rg.error?.code === "ENOENT"
    ? fallbackMatches(root, query)
    : parseRgMatches(rg.stdout);

  return buildResponse(query, rawMatches, {
    compact,
    limit,
    engine: rg.error?.code === "ENOENT" ? "node-fallback" : "rg"
  });
}

function rgArgs(query) {
  const args = [
    "--json",
    "--fixed-strings",
    "--line-number",
    "--no-heading",
    "--color",
    "never"
  ];
  for (const dir of IGNORED_DIRS) {
    args.push("--glob", `!${dir}/**`);
  }
  args.push(query, ".");
  return args;
}

function parseRgMatches(stdout) {
  const matches = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "match") continue;
      matches.push({
        file: normalizeFile(event.data.path?.text || ""),
        line: event.data.line_number,
        preview: event.data.lines?.text || ""
      });
    } catch {
      // Ignore malformed rg JSON events. A partial reference list is still useful.
    }
  }
  return matches;
}

function fallbackMatches(root, query) {
  const matches = [];
  walk(root, (file) => {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(query)) {
        matches.push({
          file: normalizeFile(path.relative(root, file)),
          line: index + 1,
          preview: lines[index]
        });
      }
    }
  });
  return matches;
}

function buildResponse(query, rawMatches, options) {
  const files = new Map();
  let returnedMatches = 0;

  for (const match of rawMatches) {
    if (!files.has(match.file)) {
      files.set(match.file, {
        file: match.file,
        lineNumbers: [],
        count: 0,
        preview: clipPreview(match.preview)
      });
    }

    const fileMatch = files.get(match.file);
    fileMatch.count += 1;

    if (returnedMatches >= options.limit) continue;
    if (!fileMatch.lineNumbers.includes(match.line)) {
      fileMatch.lineNumbers.push(match.line);
    }
    if (!fileMatch.preview) {
      fileMatch.preview = clipPreview(match.preview);
    }
    returnedMatches += 1;
  }

  const matches = Array.from(files.values())
    .filter((match) => match.lineNumbers.length > 0)
    .map((match) => ({
      ...match,
      lineNumbers: match.lineNumbers.sort((a, b) => a - b)
    }));
  const omittedMatches = Math.max(0, rawMatches.length - returnedMatches);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact,
    query,
    summary: {
      fileCount: matches.length,
      totalMatches: rawMatches.length,
      returnedMatches,
      omittedMatches,
      truncated: omittedMatches > 0,
      ignoredDirs: IGNORED_DIRS,
      limit: options.limit,
      engine: options.engine
    },
    matches,
    suggestedNextActions: matches.slice(0, 3).map((match) => ({
      command: `agentshell read ${shellQuote(match.file)} --lines ${match.lineNumbers[0]}:${match.lineNumbers[0]}`,
      reason: `Inspect references in ${match.file}`
    }))
  };
}

function walk(dir, onFile) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (IGNORED_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    if (entry.isFile() && isTextLike(entry.name)) onFile(full);
  }
}

function isTextLike(name) {
  return TEXT_EXTENSIONS.test(name);
}

function normalizeFile(file) {
  return file.replace(/^\.\//, "").split(path.sep).join("/");
}

function clipPreview(value) {
  const text = String(value || "").trim();
  if (text.length <= PREVIEW_CHARS) return text;
  return `${text.slice(0, PREVIEW_CHARS - 3)}...`;
}

function boundedLimit(value, compact) {
  const fallback = compact ? DEFAULT_COMPACT_LIMIT : DEFAULT_LIMIT;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, MAX_LIMIT);
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function invalidArgument() {
  return {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: "Usage: agentshell refs <symbol> [--compact] [--limit <n>]"
    }
  };
}
