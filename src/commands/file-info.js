import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.file-info.v1";
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ITEMS = 20;

const LANGUAGE_BY_EXTENSION = new Map([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".go", "go"],
  [".json", "json"],
  [".md", "markdown"],
  [".css", "css"],
  [".html", "html"]
]);

export async function fileInfo(root, file, options = {}) {
  const parsed = parseFileInfoOptions(file, options);
  if (!parsed.ok) return parsed;

  const resolved = resolveInsideWorkspace(root, parsed.value.path);
  if (!resolved.ok) return fail(resolved.reason, `Cannot inspect ${parsed.value.path}`);
  if (!fs.existsSync(resolved.absTarget)) {
    return fail("FILE_NOT_FOUND", `File not found: ${parsed.value.path}`, {
      path: resolved.relative,
      exists: false
    });
  }

  const stat = fs.statSync(resolved.absTarget);
  if (!stat.isFile()) return fail("NOT_A_FILE", `Not a file: ${parsed.value.path}`);

  const buffer = fs.readFileSync(resolved.absTarget);
  const extension = path.extname(resolved.relative).toLowerCase();
  const language = languageFor(extension);
  const binary = isBinary(buffer);
  const generated = isGeneratedPath(resolved.relative);
  const text = !binary && buffer.length <= MAX_TEXT_BYTES ? buffer.toString("utf8") : null;

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: Boolean(parsed.value.compact),
    path: resolved.relative,
    exists: true,
    sizeBytes: stat.size,
    lineCount: text === null ? null : countLines(text),
    language,
    extension,
    generated,
    binary,
    hash: hashBuffer(buffer),
    git: gitInfo(root, resolved.relative),
    code: summarizeCode(text, language, generated)
  };
}

export function parseFileInfoOptions(file, options = {}) {
  if (!file || String(file).startsWith("--")) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell file info <path> --compact");
  }
  return {
    ok: true,
    value: {
      path: String(file),
      compact: options.compact === undefined ? true : Boolean(options.compact)
    }
  };
}

export function summarizeCode(text, language, generated = false) {
  if (!text || generated) return null;
  if (language === "javascript" || language === "typescript") return summarizeJsTs(text);
  if (language === "go") return summarizeGo(text);
  return null;
}

function summarizeJsTs(text) {
  const symbols = [];
  const exports = [];

  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    pushUnique(symbols, { kind: "function", name: match[1] });
  }
  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/gm)) {
    pushUnique(symbols, { kind: "type", name: match[1] });
  }
  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    pushUnique(symbols, { kind: "variable", name: match[1] });
  }
  for (const match of text.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    pushUnique(exports, match[1]);
  }
  for (const match of text.matchAll(/^\s*export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    pushUnique(exports, match[1]);
  }
  for (const match of text.matchAll(/^\s*export\s*\{([^}]+)\}/gm)) {
    for (const name of match[1].split(",")) {
      pushUnique(exports, cleanExportName(name));
    }
  }

  return {
    symbols: symbols.slice(0, MAX_ITEMS),
    exports: exports.filter(Boolean).slice(0, MAX_ITEMS),
    importCount: (text.match(/^\s*import\s.+from\s+["'][^"']+["'];?\s*$/gm) || []).length
      + (text.match(/^\s*import\s+["'][^"']+["'];?\s*$/gm) || []).length
  };
}

function summarizeGo(text) {
  const symbols = [];
  const exports = [];

  for (const match of text.matchAll(/^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/gm)) {
    const name = match[1];
    pushUnique(symbols, { kind: "function", name });
    if (isExportedGoName(name)) pushUnique(exports, name);
  }
  for (const match of text.matchAll(/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|func|\w+)/gm)) {
    const name = match[1];
    pushUnique(symbols, { kind: "type", name });
    if (isExportedGoName(name)) pushUnique(exports, name);
  }
  for (const match of text.matchAll(/^\s*(?:const|var)\s+([A-Za-z_]\w*)\b/gm)) {
    const name = match[1];
    pushUnique(symbols, { kind: "variable", name });
    if (isExportedGoName(name)) pushUnique(exports, name);
  }

  return {
    symbols: symbols.slice(0, MAX_ITEMS),
    exports: exports.slice(0, MAX_ITEMS),
    importCount: countGoImports(text)
  };
}

function gitInfo(root, relativePath) {
  const tracked = runGit(root, ["ls-files", "--error-unmatch", "--", relativePath]);
  const isTracked = tracked.status === 0;
  const log = runGit(root, [
    "log",
    "-1",
    "--date=relative",
    "--pretty=format:%h%x1f%s%x1f%cr",
    "--",
    relativePath
  ]);

  return {
    tracked: isTracked,
    lastCommit: log.status === 0 && log.stdout.trim() ? parseLastCommit(log.stdout) : null
  };
}

function parseLastCommit(output) {
  const [shortHash, subject, relativeAge] = output.trim().split("\x1f");
  return {
    shortHash: shortHash || "",
    subject: subject || "",
    relativeAge: relativeAge || null
  };
}

function runGit(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
}

function languageFor(extension) {
  return LANGUAGE_BY_EXTENSION.get(extension) || (extension ? extension.slice(1) : null);
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.endsWith("\n") ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length;
}

function isBinary(buffer) {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}

function isGeneratedPath(filePath) {
  return /(^|\/)(dist|build|coverage|vendor|generated)\//.test(filePath)
    || /(^|\/).*\.generated\.[^.]+$/.test(filePath)
    || /(^|\/).*\.min\.(js|css)$/.test(filePath)
    || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$/.test(filePath);
}

function hashBuffer(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function pushUnique(items, item) {
  const key = typeof item === "string" ? item : `${item.kind}:${item.name}`;
  if (items.some((existing) => (typeof existing === "string" ? existing : `${existing.kind}:${existing.name}`) === key)) return;
  items.push(item);
}

function cleanExportName(value) {
  const parts = value.trim().split(/\s+as\s+/u);
  return (parts[1] || parts[0] || "").trim();
}

function isExportedGoName(name) {
  return /^[A-Z]/.test(name);
}

function countGoImports(text) {
  const block = text.match(/^\s*import\s*\(([\s\S]*?)^\s*\)/m);
  if (block) {
    return block[1].split(/\r?\n/).filter((line) => /"[^"]+"/.test(line)).length;
  }
  return (text.match(/^\s*import\s+(?:[._\w]+\s+)?"[^"]+"/gm) || []).length;
}
