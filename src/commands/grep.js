import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.grep.v1";
const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_MATCHES_PER_FILE = 3;
const DEFAULT_CONTEXT_CHARS = 160;
const IGNORED_DIRS = [
  ".agentshell",
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules"
];
const TEXT_EXTENSIONS = /\.(c|cc|cpp|css|go|h|hpp|html|java|js|jsx|json|md|mjs|py|rs|sh|sql|ts|tsx|toml|txt|yaml|yml)$/i;

export async function grep(root, query, options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return invalidArgument();
  }

  const limits = {
    maxMatches: positiveInteger(options.maxMatches, DEFAULT_MAX_MATCHES),
    maxMatchesPerFile: positiveInteger(options.maxMatchesPerFile, DEFAULT_MAX_MATCHES_PER_FILE),
    contextChars: positiveInteger(options.contextChars, DEFAULT_CONTEXT_CHARS)
  };

  const rg = spawnSync("rg", rgArgs(normalizedQuery), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8
  });

  const matches = rg.error && rg.error.code === "ENOENT"
    ? fallbackMatches(root, normalizedQuery)
    : parseRgMatches(rg.stdout);

  return buildResponse(normalizedQuery, matches, limits, {
    compact: options.compact === undefined ? true : Boolean(options.compact),
    usedFallback: rg.error?.code === "ENOENT"
  });
}

function rgArgs(query) {
  const args = [
    "--json",
    "--line-number",
    "--column",
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
      const lineText = event.data.lines?.text || "";
      const submatch = event.data.submatches?.[0];
      matches.push({
        file: normalizeFile(event.data.path?.text || ""),
        line: event.data.line_number,
        column: typeof submatch?.start === "number" ? submatch.start + 1 : 1,
        text: lineText.trimEnd()
      });
    } catch {
      // Ignore malformed rg JSON events. A partial result is still useful.
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
      const column = lines[index].indexOf(query);
      if (column >= 0) {
        matches.push({
          file: normalizeFile(path.relative(root, file)),
          line: index + 1,
          column: column + 1,
          text: lines[index]
        });
      }
    }
  });
  return matches;
}

function buildResponse(query, matches, limits, options) {
  const filesByName = new Map();
  const results = [];
  let omittedMatches = 0;

  for (const match of matches) {
    if (!filesByName.has(match.file)) {
      filesByName.set(match.file, {
        file: match.file,
        matches: 0,
        returned: 0,
        omitted: 0,
        truncated: false
      });
    }

    const fileSummary = filesByName.get(match.file);
    fileSummary.matches += 1;

    const canReturn = results.length < limits.maxMatches && fileSummary.returned < limits.maxMatchesPerFile;
    if (!canReturn) {
      fileSummary.omitted += 1;
      fileSummary.truncated = true;
      omittedMatches += 1;
      continue;
    }

    fileSummary.returned += 1;
    results.push({
      file: match.file,
      line: match.line,
      column: match.column,
      text: clipLine(match.text, limits.contextChars),
      context: clipAroundColumn(match.text, match.column, limits.contextChars)
    });
  }

  const truncated = omittedMatches > 0;
  const files = Array.from(filesByName.values());
  const suggestedNextActions = results.slice(0, 3).map((result) => ({
    command: `agentshell read ${shellQuote(result.file)} --lines ${result.line}:${result.line}`,
    reason: `Inspect match in ${result.file}:${result.line}`
  }));

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact,
    query,
    summary: {
      fileCount: files.length,
      totalMatches: matches.length,
      returnedMatches: results.length,
      omittedMatches,
      ignoredDirs: IGNORED_DIRS,
      limits,
      engine: options.usedFallback ? "node-fallback" : "rg"
    },
    files,
    results,
    truncated: {
      value: truncated,
      omittedMatches,
      reason: truncated ? "match limits reached" : null
    },
    suggestedNextActions
  };
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

function clipLine(line, limit) {
  const text = String(line || "").trimEnd();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function clipAroundColumn(line, column, limit) {
  const text = String(line || "").trimEnd();
  if (text.length <= limit) return text;
  const center = Math.max(0, Number(column || 1) - 1);
  const start = Math.max(0, center - Math.floor(limit / 2));
  const end = Math.min(text.length, start + limit);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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
      message: "Usage: agentshell grep <query> [--compact]"
    }
  };
}
