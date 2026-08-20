import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.imports.v1";
const MAX_TEXT_BYTES = 1024 * 1024;
const DEFAULT_COMPACT_IMPORT_LIMIT = 25;
const MAX_IMPORTS = 100;
const MAX_SPECIFIERS = 40;

const LANGUAGE_BY_EXTENSION = new Map([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".go", "go"],
  [".py", "python"],
  [".java", "java"]
]);

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, ""))
]);

export async function imports(root, file, options = {}) {
  const parsed = parseImportsOptions(file, options);
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
  if (stat.size > MAX_TEXT_BYTES) {
    return fail("UNSUPPORTED_FILE", `File is too large to summarize imports: ${resolved.relative}`, {
      path: resolved.relative,
      sizeBytes: stat.size,
      maxBytes: MAX_TEXT_BYTES
    });
  }

  const extension = path.extname(resolved.relative).toLowerCase();
  const language = languageFor(extension);
  if (!language) {
    return fail("UNSUPPORTED_FILE", `Unsupported import summary file type: ${resolved.relative}`, {
      path: resolved.relative,
      extension
    });
  }

  const text = fs.readFileSync(resolved.absTarget, "utf8");
  const allEntries = summarizeImports(text, language);
  const limit = parsed.value.compact ? DEFAULT_COMPACT_IMPORT_LIMIT : MAX_IMPORTS;
  const entries = allEntries.slice(0, limit);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: parsed.value.compact,
    file: resolved.relative,
    language,
    summary: buildSummary(allEntries, entries),
    imports: entries,
    suggestedNextActions: buildSuggestedNextActions(resolved.relative, entries)
  };
}

export function parseImportsOptions(file, options = {}) {
  if (!file || String(file).startsWith("--")) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell imports <file> --compact");
  }
  return {
    ok: true,
    value: {
      path: String(file),
      compact: options.compact === undefined ? true : Boolean(options.compact)
    }
  };
}

export function summarizeImports(text, language) {
  if (language === "javascript" || language === "typescript") return summarizeJsTsImports(text);
  if (language === "go") return summarizeGoImports(text);
  if (language === "python") return summarizePythonImports(text);
  if (language === "java") return summarizeJavaImports(text);
  return [];
}

function summarizeJsTsImports(text, language = "javascript") {
  const source = stripJsComments(text);
  const entries = [];

  for (const match of source.matchAll(/^\s*import\s+(type\s+)?(?:(.*?)\s+from\s+)?["']([^"']+)["'];?/gm)) {
    const importType = match[1] ? "type" : match[2] ? "runtime" : "side-effect";
    entries.push(classifyImport({
      source: match[3],
      type: { kind: importType },
      specifiers: match[2] ? parseJsSpecifiers(match[2]) : []
    }, language));
  }

  for (const match of source.matchAll(/^\s*export\s+(type\s+)?(?:\*|{([^}]*)})\s+from\s+["']([^"']+)["'];?/gm)) {
    entries.push(classifyImport({
      source: match[3],
      type: { kind: match[1] ? "type" : "runtime" },
      specifiers: match[2] ? parseJsSpecifiers(`{${match[2]}}`) : ["*"]
    }, language));
  }

  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    entries.push(classifyImport({
      source: match[1],
      type: { kind: "runtime" },
      specifiers: []
    }, language));
  }

  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    entries.push(classifyImport({
      source: match[1],
      type: { kind: "dynamic" },
      specifiers: []
    }, language));
  }

  return dedupeImports(entries);
}

function summarizeGoImports(text) {
  const source = stripGoComments(text);
  const entries = [];

  for (const match of source.matchAll(/^\s*import\s+(?:(\.|_|[A-Za-z_]\w*)\s+)?["`]([^"`]+)["`]/gm)) {
    entries.push(goImportEntry(match[2], match[1] || null));
  }

  for (const block of source.matchAll(/^\s*import\s*\(([\s\S]*?)^\s*\)/gm)) {
    for (const line of block[1].split(/\r?\n/)) {
      const match = line.match(/^\s*(?:(\.|_|[A-Za-z_]\w*)\s+)?["`]([^"`]+)["`]/);
      if (match) entries.push(goImportEntry(match[2], match[1] || null));
    }
  }

  return dedupeImports(entries);
}

function goImportEntry(source, alias) {
  return classifyImport({
    source,
    type: { kind: alias === "_" ? "side-effect" : "go" },
    specifiers: alias ? [alias] : []
  }, "go");
}

function summarizePythonImports(text) {
  const source = stripPythonComments(text);
  const entries = [];

  for (const match of source.matchAll(/^\s*import\s+(.+)$/gm)) {
    for (const part of match[1].split(",")) {
      const item = part.trim();
      const aliasMatch = /^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(item);
      if (!aliasMatch) continue;
      entries.push(classifyImport({
        source: aliasMatch[1],
        type: { kind: "python" },
        specifiers: aliasMatch[2] ? [aliasMatch[2]] : []
      }, "python"));
    }
  }

  for (const match of source.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/gm)) {
    const sourceName = match[1];
    const specifiers = parsePythonSpecifiers(match[2]);
    entries.push(classifyImport({
      source: sourceName,
      type: { kind: "python" },
      specifiers
    }, "python"));
  }

  return dedupeImports(entries);
}

function summarizeJavaImports(text) {
  const source = stripJavaComments(text);
  const entries = [];

  for (const match of source.matchAll(/^\s*import\s+(static\s+)?([A-Za-z_][\w]*(?:\.[A-Za-z_*][\w*]*)*)\s*;/gm)) {
    entries.push(classifyImport({
      source: match[2],
      type: { kind: match[1] ? "static" : "java" },
      specifiers: []
    }, "java"));
  }

  return dedupeImports(entries);
}

function classifyImport(entry, language) {
  const relative = entry.source.startsWith(".") || entry.source.startsWith("/");
  const builtin = language === "go"
    ? isGoBuiltin(entry.source)
    : language === "python"
      ? isPythonBuiltin(entry.source)
      : language === "java"
        ? isJavaBuiltin(entry.source)
        : isNodeBuiltin(entry.source);
  return {
    ...entry,
    count: entry.specifiers.length,
    builtin,
    external: !relative && !builtin,
    relative
  };
}

function parsePythonSpecifiers(clause) {
  const specifiers = clause
    .replace(/[()]/g, "")
    .split(",")
    .map((part) => cleanSpecifier(part))
    .filter(Boolean);
  return [...new Set(specifiers)].slice(0, MAX_SPECIFIERS);
}

function buildSummary(allEntries, entries) {
  const byKind = {};
  for (const entry of allEntries) {
    byKind[entry.type.kind] = (byKind[entry.type.kind] || 0) + 1;
  }
  return {
    importCount: allEntries.length,
    returnedImports: entries.length,
    omittedImports: Math.max(0, allEntries.length - entries.length),
    truncated: entries.length < allEntries.length,
    sourceCount: new Set(allEntries.map((entry) => entry.source)).size,
    specifierCount: allEntries.reduce((total, entry) => total + entry.count, 0),
    builtinCount: allEntries.filter((entry) => entry.builtin).length,
    externalCount: allEntries.filter((entry) => entry.external).length,
    relativeCount: allEntries.filter((entry) => entry.relative).length,
    byKind
  };
}

function buildSuggestedNextActions(file, entries) {
  const actions = [{
    command: `agentshell read ${shellQuote(file)} --lines 1:120`,
    reason: `Inspect import context in ${file}`
  }];
  const relative = entries.find((entry) => entry.relative);
  if (relative) {
    actions.push({
      command: `agentshell grep ${shellQuote(relative.source)} --compact`,
      reason: `Find other references to ${relative.source}`
    });
  }
  return actions;
}

function parseJsSpecifiers(clause) {
  const specifiers = [];
  for (const part of splitImportClause(clause)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      for (const named of trimmed.slice(1, -1).split(",")) pushSpecifier(specifiers, cleanSpecifier(named));
    } else if (trimmed.startsWith("* as ")) {
      pushSpecifier(specifiers, `*:${trimmed.slice(5).trim()}`);
    } else {
      pushSpecifier(specifiers, trimmed.replace(/^type\s+/, ""));
    }
  }
  return specifiers.slice(0, MAX_SPECIFIERS);
}

function splitImportClause(clause) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of clause) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function cleanSpecifier(specifier) {
  return specifier
    .trim()
    .replace(/^type\s+/, "")
    .replace(/\s+as\s+/i, ":")
    .trim();
}

function pushSpecifier(specifiers, specifier) {
  if (specifier && !specifiers.includes(specifier)) specifiers.push(specifier);
}

function dedupeImports(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = `${entry.source}\0${entry.type.kind}\0${entry.specifiers.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function stripGoComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function stripPythonComments(text) {
  return text.replace(/^\s*#.*$/gm, "");
}

function stripJavaComments(text) {
  return stripGoComments(text);
}

function isNodeBuiltin(source) {
  return NODE_BUILTINS.has(source) || NODE_BUILTINS.has(source.replace(/^node:/, ""));
}

function isGoBuiltin(source) {
  return !source.startsWith(".") && !source.split("/")[0].includes(".");
}

function isPythonBuiltin(source) {
  if (source.startsWith(".")) return false;
  const root = source.split(".")[0];
  return [
    "abc", "argparse", "asyncio", "collections", "contextlib", "dataclasses", "datetime",
    "functools", "itertools", "json", "logging", "math", "os", "pathlib", "re", "sys",
    "typing", "unittest"
  ].includes(root);
}

function isJavaBuiltin(source) {
  return /^(java|javax)\./.test(source);
}

function languageFor(extension) {
  return LANGUAGE_BY_EXTENSION.get(extension) || null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
