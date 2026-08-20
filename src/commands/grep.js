import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.grep.v1";
const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_MATCHES_PER_FILE = 3;
const DEFAULT_CONTEXT_CHARS = 160;
const DEFAULT_CONTEXT_LINES = 0;
const MAX_CONTEXT_LINES = 20;
const IGNORED_DIRS = [
  ".agentshell",
  ".cache",
  ".git",
  ".gradle",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv"
];
const TEXT_EXTENSIONS = /\.(c|cc|cjs|cpp|css|cts|go|h|hpp|html|java|js|jsx|json|md|mdx|mjs|mts|py|pyi|rs|rst|sh|sql|ts|tsx|toml|txt|yaml|yml)$/i;
const TYPE_ALIASES = new Map([
  ["py", "python"], ["python", "python"],
  ["go", "go"], ["golang", "go"],
  ["ts", "typescript"], ["tsx", "typescript"], ["typescript", "typescript"],
  ["js", "javascript"], ["jsx", "javascript"], ["javascript", "javascript"],
  ["java", "java"]
]);
const TYPE_EXTENSIONS = {
  python: new Set([".py", ".pyi"]),
  go: new Set([".go"]),
  typescript: new Set([".ts", ".tsx", ".mts", ".cts"]),
  javascript: new Set([".js", ".jsx", ".mjs", ".cjs"]),
  java: new Set([".java"])
};
const CATEGORY_ORDER = new Map([
  ["source", 0],
  ["test", 1],
  ["docs", 2],
  ["config", 3],
  ["other", 4]
]);

export async function grep(root, query, options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return invalidArgument();
  }

  const limits = {
    maxMatches: positiveInteger(options.maxMatches, DEFAULT_MAX_MATCHES),
    maxMatchesPerFile: positiveInteger(options.maxMatchesPerFile, DEFAULT_MAX_MATCHES_PER_FILE),
    contextChars: positiveInteger(options.contextChars, DEFAULT_CONTEXT_CHARS),
    contextLines: boundedNonNegativeInteger(options.context, DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES)
  };
  const type = normalizeType(options.type);
  if (options.type && !type) return invalidType(options.type);

  const rg = spawnSync("rg", rgArgs(normalizedQuery, type), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8
  });

  const rawMatches = rg.error && rg.error.code === "ENOENT"
    ? fallbackMatches(root, normalizedQuery, type)
    : parseRgMatches(rg.stdout);
  const matches = addLineContext(root, rawMatches, limits.contextLines, limits.contextChars);

  return buildResponse(normalizedQuery, matches, limits, {
    compact: options.compact === undefined ? true : Boolean(options.compact),
    usedFallback: rg.error?.code === "ENOENT",
    filesWithMatches: Boolean(options.filesWithMatches),
    type
  });
}

function rgArgs(query, type) {
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never"
  ];
  for (const extension of TYPE_EXTENSIONS[type] || []) {
    args.push("--glob", `*${extension}`);
  }
  for (const dir of IGNORED_DIRS) {
    args.push("--glob", `!${dir}/**`);
    args.push("--glob", `!**/${dir}/**`);
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

function fallbackMatches(root, query, type) {
  const matches = [];
  walk(root, (file) => {
    if (!matchesType(file, type)) return;
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
  const orderedMatches = [...matches].sort(compareMatches);

  for (const match of orderedMatches) {
    if (!filesByName.has(match.file)) {
      filesByName.set(match.file, {
        file: match.file,
        category: categorizeFile(match.file),
        matches: 0,
        returned: 0,
        omitted: 0,
        truncated: false
      });
    }

    const fileSummary = filesByName.get(match.file);
    fileSummary.matches += 1;

    const canReturn = !options.filesWithMatches && results.length < limits.maxMatches && fileSummary.returned < limits.maxMatchesPerFile;
    if (!canReturn) {
      if (options.filesWithMatches) continue;
      fileSummary.omitted += 1;
      fileSummary.truncated = true;
      omittedMatches += 1;
      continue;
    }

    fileSummary.returned += 1;
    results.push({
      file: match.file,
      category: fileSummary.category,
      line: match.line,
      column: match.column,
      text: clipLine(match.text, limits.contextChars),
      context: clipAroundColumn(match.text, match.column, limits.contextChars),
      before: match.before || [],
      after: match.after || []
    });
  }

  const allFiles = Array.from(filesByName.values());
  const files = options.filesWithMatches ? allFiles.slice(0, limits.maxMatches) : allFiles;
  const omittedFiles = allFiles.length - files.length;
  if (options.filesWithMatches && omittedFiles > 0) {
    omittedMatches = allFiles.slice(limits.maxMatches).reduce((total, file) => total + file.matches, 0);
  }
  const truncated = omittedMatches > 0 || omittedFiles > 0;
  const groups = groupFiles(allFiles);
  const suggestedNextActions = results.slice(0, 3).map((result) => ({
    command: `agentshell read ${shellQuote(result.file)} --lines ${result.line}:${result.line}`,
    reason: `Inspect match in ${result.file}:${result.line}`
  }));

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact,
    query,
    mode: options.filesWithMatches ? "files" : "matches",
    type: options.type,
    summary: {
      fileCount: allFiles.length,
      returnedFileCount: files.length,
      omittedFileCount: omittedFiles,
      totalMatches: matches.length,
      returnedMatches: results.length,
      omittedMatches,
      ignoredDirs: IGNORED_DIRS,
      limits,
      engine: options.usedFallback ? "node-fallback" : "rg"
    },
    groups,
    files,
    results,
    truncated: {
      value: truncated,
      omittedMatches,
      omittedFiles,
      reason: options.filesWithMatches && omittedFiles > 0
        ? "file summary limit reached"
        : truncated ? "match limits reached" : null
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

function normalizeType(value) {
  if (value === undefined || value === null || value === "") return null;
  return TYPE_ALIASES.get(String(value).trim().toLowerCase()) || null;
}

function matchesType(file, type) {
  if (!type) return true;
  return TYPE_EXTENSIONS[type].has(path.extname(file).toLowerCase());
}

function addLineContext(root, matches, count, contextChars) {
  if (!count) return matches;
  const cache = new Map();
  return matches.map((match) => {
    let lines = cache.get(match.file);
    if (!lines) {
      try {
        lines = fs.readFileSync(path.join(root, match.file), "utf8").split(/\r?\n/);
      } catch {
        lines = [];
      }
      cache.set(match.file, lines);
    }
    const index = match.line - 1;
    return {
      ...match,
      before: lines.slice(Math.max(0, index - count), index).map((text, offset) => ({
        line: Math.max(0, index - count) + offset + 1,
        text: clipLine(text, contextChars)
      })),
      after: lines.slice(index + 1, index + count + 1).map((text, offset) => ({
        line: index + offset + 2,
        text: clipLine(text, contextChars)
      }))
    };
  });
}

function categorizeFile(file) {
  const normalized = `/${file.toLowerCase()}`;
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)/.test(normalized) || /(?:\.|_)(test|spec)\.[^/]+$/.test(normalized)) return "test";
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(normalized) || /\.(md|mdx|rst|txt)$/.test(normalized)) return "docs";
  if (/(^|\/)(config|configs|\.github)(\/|$)/.test(normalized) || /(?:^|\/)(package\.json|go\.mod|pyproject\.toml|pom\.xml)$/.test(normalized)) return "config";
  if (/(^|\/)(src|lib|app|cmd|internal|pkg)(\/|$)/.test(normalized)) return "source";
  return "other";
}

function groupFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const current = groups.get(file.category) || { category: file.category, fileCount: 0, matches: 0, returned: 0 };
    current.fileCount += 1;
    current.matches += file.matches;
    current.returned += file.returned;
    groups.set(file.category, current);
  }
  return Array.from(groups.values()).sort((left, right) => CATEGORY_ORDER.get(left.category) - CATEGORY_ORDER.get(right.category));
}

function compareMatches(left, right) {
  const categoryDifference = CATEGORY_ORDER.get(categorizeFile(left.file)) - CATEGORY_ORDER.get(categorizeFile(right.file));
  if (categoryDifference !== 0) return categoryDifference;
  const fileDifference = left.file.localeCompare(right.file);
  if (fileDifference !== 0) return fileDifference;
  return left.line - right.line || left.column - right.column;
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

function boundedNonNegativeInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, maximum) : fallback;
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

function invalidType(type) {
  return {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: `Unsupported grep type: ${type}`,
      details: { supportedTypes: Object.keys(TYPE_EXTENSIONS) }
    }
  };
}
