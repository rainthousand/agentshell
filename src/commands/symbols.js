import fs from "node:fs";
import path from "node:path";

import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.symbols.v1";
const DEFAULT_MAX_SYMBOLS = 80;

const JS_TS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const GO_EXTENSIONS = new Set([".go"]);

export async function symbols(root, file, options = {}) {
  if (!file) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell symbols <file> [--compact]");
  }

  const resolved = resolveInsideWorkspace(root, file);
  if (!resolved.ok) return fail(resolved.reason, `Cannot summarize symbols for ${file}`);
  if (!fs.existsSync(resolved.absTarget)) return fail("FILE_NOT_FOUND", `File not found: ${file}`);
  if (!fs.statSync(resolved.absTarget).isFile()) return fail("NOT_A_FILE", `Not a file: ${file}`);

  const language = languageForFile(resolved.relative);
  if (!language) {
    return fail("UNSUPPORTED_LANGUAGE", `Unsupported file type: ${file}`, {
      supportedExtensions: [...JS_TS_EXTENSIONS, ...GO_EXTENSIONS].sort()
    });
  }

  const content = fs.readFileSync(resolved.absTarget, "utf8");
  const allSymbols = language === "go"
    ? parseGoSymbols(content)
    : parseJsTsSymbols(content);
  const maxSymbols = compactLimit(options);
  const returnedSymbols = allSymbols.slice(0, maxSymbols);
  const omittedSymbols = Math.max(0, allSymbols.length - returnedSymbols.length);
  const truncated = omittedSymbols > 0;

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    file: resolved.relative,
    language,
    summary: {
      totalSymbols: allSymbols.length,
      returnedSymbols: returnedSymbols.length,
      omittedSymbols,
      truncated,
      countsByKind: countByKind(allSymbols),
      exportedSymbols: allSymbols.filter((symbol) => symbol.exported).length,
      limits: {
        maxSymbols
      }
    },
    symbols: returnedSymbols,
    truncated: {
      value: truncated,
      omittedSymbols,
      reason: truncated ? "symbol limit reached" : null
    },
    suggestedNextActions: returnedSymbols.slice(0, 3).map((symbol) => ({
      command: `agentshell read ${shellQuote(resolved.relative)} --lines ${symbol.line}:${symbol.line}`,
      reason: `Inspect ${symbol.kind} ${symbol.name}`
    }))
  };
}

function languageForFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (GO_EXTENSIONS.has(extension)) return "go";
  if (JS_TS_EXTENSIONS.has(extension)) return extension.includes("ts") ? "typescript" : "javascript";
  return null;
}

function compactLimit(options) {
  const number = Number(options.maxSymbols);
  return Number.isInteger(number) && number > 0 ? number : DEFAULT_MAX_SYMBOLS;
}

function parseJsTsSymbols(content) {
  const symbols = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const defaultSymbol = matchJsTsDefault(trimmed);
    if (defaultSymbol) {
      symbols.push({ ...defaultSymbol, line: index + 1, exported: true });
      continue;
    }

    const namedSymbol = matchJsTsNamed(trimmed);
    if (namedSymbol) {
      symbols.push({ ...namedSymbol, line: index + 1, exported: trimmed.startsWith("export ") });
    }
  }

  return symbols;
}

function matchJsTsDefault(line) {
  let match = /^export\s+default\s+(?:async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?/.exec(line);
  if (match) return symbol("default", match[1] || "default", line);

  match = /^export\s+default\s+(?:abstract\s+)?class(?:\s+([A-Za-z_$][\w$]*))?/.exec(line);
  if (match) return symbol("class", match[1] || "default", line);

  match = /^export\s+default\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (match) return symbol("default", match[1], line);

  return null;
}

function matchJsTsNamed(line) {
  const prefix = "(?:export\\s+)?(?:declare\\s+)?";
  const asyncPrefix = "(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?";
  const patterns = [
    [new RegExp(`^${asyncPrefix}function\\s+([A-Za-z_$][\\w$]*)`), "function"],
    [new RegExp(`^${prefix}(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)`), "class"],
    [new RegExp(`^${prefix}type\\s+([A-Za-z_$][\\w$]*)`), "type"],
    [new RegExp(`^${prefix}interface\\s+([A-Za-z_$][\\w$]*)`), "interface"],
    [new RegExp(`^${prefix}enum\\s+([A-Za-z_$][\\w$]*)`), "enum"],
    [new RegExp(`^${prefix}const\\s+([A-Za-z_$][\\w$]*)`), "const"]
  ];

  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(line);
    if (match) return symbol(kind, match[1], line);
  }

  return null;
}

function parseGoSymbols(content) {
  const symbols = [];
  const lines = content.split(/\r?\n/);
  let groupedKind = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    if (/^(?:const|var|type)\s*\($/.test(trimmed)) {
      groupedKind = trimmed.slice(0, trimmed.indexOf("(")).trim();
      continue;
    }
    if (groupedKind && trimmed === ")") {
      groupedKind = null;
      continue;
    }

    const matched = groupedKind
      ? matchGoGrouped(trimmed, groupedKind)
      : matchGoTopLevel(trimmed);
    if (matched) {
      symbols.push({
        ...matched,
        line: index + 1,
        exported: isGoExported(matched.name)
      });
    }
  }

  return symbols;
}

function matchGoTopLevel(line) {
  let match = /^func\s+(?:\(([^)]+)\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(line);
  if (match) {
    const receiver = match[1] ? compactSignature(match[1]) : null;
    return {
      kind: receiver ? "method" : "func",
      name: match[2],
      receiver,
      signature: compactSignature(line)
    };
  }

  match = /^(type|const|var)\s+([A-Za-z_]\w*)\b/.exec(line);
  if (match) return symbol(match[1], match[2], line);

  return null;
}

function matchGoGrouped(line, kind) {
  const match = /^([A-Za-z_]\w*)\b/.exec(line);
  if (!match) return null;
  return symbol(kind, match[1], line);
}

function symbol(kind, name, signature) {
  return {
    kind,
    name,
    signature: compactSignature(signature)
  };
}

function compactSignature(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\{\s*$/, "")
    .trim();
}

function isGoExported(name) {
  return /^[A-Z]/.test(name);
}

function countByKind(symbols) {
  const counts = {};
  for (const symbol of symbols) {
    counts[symbol.kind] = (counts[symbol.kind] || 0) + 1;
  }
  return counts;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
