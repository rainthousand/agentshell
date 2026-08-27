import { searchAcrossRoots } from "../core/compare-search.js";
import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.compare-search.v1";

export async function compareSearch(roots, query, options = {}) {
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuery) {
    return fail("INVALID_ARGUMENT", "A non-empty search query is required", {}, [{
      command: "agentshell compare-search <query> --root <path-a> --root <path-b>",
      reason: "Provide one query and at least two explicit roots"
    }]);
  }

  const searched = await searchAcrossRoots(roots, normalizedQuery, options);
  if (!searched.ok) {
    return fail(searched.code, searched.message, searched.details, correctionActions(searched.code));
  }

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    query: normalizedQuery,
    mode: options.fixedStrings ? "literal" : "regex",
    caseSensitive: options.caseSensitive !== false,
    summary: {
      rootCount: searched.roots.length,
      rootsWithMatches: searched.roots.filter((root) => root.observedMatches > 0).length,
      observedMatches: searched.observedMatches,
      returnedMatches: searched.returnedMatches,
      omittedMatches: Math.max(0, searched.observedMatches - searched.returnedMatches),
      truncated: searched.truncated,
      limits: searched.limits
    },
    roots: searched.roots,
    privacy: {
      workspacePathsExposed: false,
      previewsMayContainSourceText: true,
      secretLikeValuesRedacted: true,
      networkUpload: false
    },
    suggestedNextActions: suggestedNextActions(searched.roots)
  };
}

function suggestedNextActions(roots) {
  return roots.flatMap((root) => root.matches.slice(0, 1).map((match) => ({
    command: `agentshell read ${shellQuote(match.file)} --lines ${match.line}:${match.line}`,
    reason: `Inspect the first aligned match from ${root.rootId} (${root.name})`
  }))).slice(0, 3);
}

function correctionActions(code) {
  if (code === "TOO_FEW_ROOTS") {
    return [{
      command: "agentshell compare-search <query> --root <path-a> --root <path-b>",
      reason: "Provide at least two explicit roots"
    }];
  }
  return [];
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
