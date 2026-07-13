import fs from "node:fs";
import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";
import { sha256 } from "../core/hash.js";

const MAX_LINES = 200;
const AROUND_CONTEXT = 40;
const PROTOCOL_VERSION = "agentshell.read.v1";

export async function readFileRange(root, file, rangeText) {
  return readFile(root, file, { lines: rangeText });
}

export async function readFileAround(root, file, query) {
  return readFile(root, file, { around: query });
}

async function readFile(root, file, options) {
  const resolved = resolveInsideWorkspace(root, file);
  if (!resolved.ok) return fail(resolved.reason, `Cannot read ${file}`);
  if (!fs.existsSync(resolved.absTarget)) return fail("FILE_NOT_FOUND", `File not found: ${file}`);
  if (!fs.statSync(resolved.absTarget).isFile()) return fail("NOT_A_FILE", `Not a file: ${file}`);

  const content = fs.readFileSync(resolved.absTarget, "utf8");
  const lines = content.split(/\r?\n/);
  const parsed = options.lines ? parseRange(options.lines) : rangeAround(lines, options.around);
  if (!parsed) {
    return options.lines
      ? fail("INVALID_RANGE", "Line range must look like A:B")
      : fail("QUERY_NOT_FOUND", `Query not found in ${file}`, {}, [{
        command: `agentshell find ${JSON.stringify(options.around)}`,
        reason: "Search the workspace for the query"
      }]);
  }

  const start = Math.max(1, parsed.start);
  const end = Math.min(lines.length, parsed.end);
  const count = end - start + 1;

  if (count < 1) return fail("INVALID_RANGE", "Line range is empty");
  if (count > MAX_LINES) {
    return fail("RANGE_TOO_LARGE", `Read range is ${count} lines; max is ${MAX_LINES}`, {
      maxLines: MAX_LINES
    }, [{
      command: `agentshell read ${file} --lines ${start}:${start + MAX_LINES - 1}`,
      reason: "Read a smaller range"
    }]);
  }

  const numbered = lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index} | ${line}`)
    .join("\n");

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    file: resolved.relative,
    hash: sha256(content),
    range: { start, end },
    matchedLine: parsed.matchedLine || null,
    totalLines: lines.length,
    content: numbered
  };
}

function parseRange(text) {
  const match = /^(\d+):(\d+)$/.exec(text || "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null;
  return { start, end };
}

function rangeAround(lines, query) {
  if (!query) return null;
  const matchedIndex = lines.findIndex((line) => line.includes(query));
  if (matchedIndex < 0) return null;
  const matchedLine = matchedIndex + 1;
  return {
    start: Math.max(1, matchedLine - AROUND_CONTEXT),
    end: Math.min(lines.length, matchedLine + AROUND_CONTEXT),
    matchedLine
  };
}
