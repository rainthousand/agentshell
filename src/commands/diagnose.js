import fs from "node:fs";
import path from "node:path";
import { verify } from "./verify.js";
import { readFileAround, readFileRange } from "./read.js";
import { find } from "./find.js";
import { sha256 } from "../core/hash.js";
import { createRun, ensureState, newId, readLog } from "../core/store.js";
import { createProfile } from "../core/profile.js";

const PROTOCOL_VERSION = "agentshell.diagnose.v1";

export async function diagnose(root, type, options = {}) {
  if (type !== "test") {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "Only `agentshell diagnose test` is supported",
        suggestedNextActions: []
      }
    };
  }

  const profile = options.profile ? createProfile() : null;
  const verification = profile
    ? await profile.measure("verify-test", () => verify(root, "test", { run: false }))
    : await verify(root, "test", { run: false });
  const focusedReads = [];
  const symbolMatches = [];
  const implementationReads = [];
  const deterministicFixPlan = verification.ok ? null : (
    profile
      ? profile.measureSync("deterministic-fix-plan", () => deterministicFixPlanFromVerification(root, verification))
      : deterministicFixPlanFromVerification(root, verification)
  );
  let symbols = [];

  if (!deterministicFixPlan) {
    await maybeMeasure(profile, "focused-reads", async () => {
      const mainQuery = queryFromError(verification.summary?.mainError);
      for (const file of verification.relatedFiles || []) {
        const read = await readFileAround(root, file, mainQuery);
        if (read.ok) {
          focusedReads.push(read);
        } else {
          const fallback = await readFileRange(root, file, "1:120");
          if (fallback.ok) focusedReads.push(fallback);
        }
      }
    });

    await maybeMeasure(profile, "implementation-import-reads", async () => {
      for (const file of verification.relatedFiles || []) {
        for (const imported of localImports(root, file)) {
          if (implementationReads.some((read) => read.file === imported)) continue;
          const read = await readFileRange(root, imported, "1:120");
          if (read.ok) implementationReads.push(read);
        }
      }
    });

    const hasImplementationTarget = implementationReads.length > 0;
    if (!options.compact || !hasImplementationTarget) {
      symbols = profile
        ? profile.measureSync("symbol-extract", () => extractSymbols(focusedReads.map((read) => read.content).join("\n")))
        : extractSymbols(focusedReads.map((read) => read.content).join("\n"));
      await maybeMeasure(profile, "symbol-search", async () => {
        for (const symbol of symbols.slice(0, 3)) {
          const search = await find(root, symbol);
          if (search.ok) {
            symbolMatches.push({
              symbol,
              total: search.total,
              matches: search.matches.slice(0, 5).map((match) => ({
                file: match.file,
                line: match.line
              }))
            });
            const implementation = search.matches.find((match) => (
              !match.file.endsWith("package.json") &&
              !match.file.includes(".test.") &&
              !match.file.includes("/test/") &&
              !match.file.includes("test/")
            ));
            if (implementation) {
              const read = await readFileAround(root, implementation.file, symbol);
              if (read.ok) implementationReads.push(read);
            }
          }
        }
      });
    }
  }

  const fixPlan = deterministicFixPlan || (profile
    ? profile.measureSync("fix-plan", () => buildFixPlan(root, verification, focusedReads, implementationReads, symbols))
    : buildFixPlan(root, verification, focusedReads, implementationReads, symbols));
  const changeTemplate = profile
    ? profile.measureSync("change-template", () => writeChangeTemplate(root, fixPlan))
    : writeChangeTemplate(root, fixPlan);
  const run = profile ? profile.measureSync("run-state", () => createRun(root, {
    type: "diagnose",
    ok: true,
    verificationOk: verification.ok,
    summary: verification.summary,
    logRef: verification.logRef,
    fixPlan,
    changeTemplate
  })) : createRun(root, {
    type: "diagnose",
    ok: true,
    verificationOk: verification.ok,
    summary: verification.summary,
    logRef: verification.logRef,
    fixPlan,
    changeTemplate
  });

  const result = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    runId: run.id,
    type,
    status: verification.ok ? "passed" : "failed",
    compact: options.compact === true,
    verificationOk: verification.ok,
    verification: compactVerification(verification),
    fixPlan,
    changeTemplate,
    focusedReads: options.compact ? focusedReads.map(compactRead) : focusedReads,
    symbols: options.compact ? [] : symbols,
    symbolMatches: options.compact || implementationReads.length > 0 ? [] : symbolMatches,
    implementationReads: options.compact ? implementationReads.map(compactRead) : implementationReads,
    suggestedNextActions: verification.ok ? [] : [{
      command: `agentshell log get ${verification.logRef} --tail 120`,
      reason: "Inspect raw logs only if the diagnosis is insufficient"
    }]
  };
  if (profile) {
    result.profile = profile.report({
      subprocessMs: verification.durationMs || 0,
      note: "verify-test includes the test subprocess. Other phases are AgentShell JS/IO work inside the already-started Node.js process."
    });
  }
  return result;
}

async function maybeMeasure(profile, name, fn) {
  if (profile) return profile.measure(name, fn);
  return fn();
}

function buildFixPlan(root, verification, focusedReads, implementationReads, symbols) {
  if (verification.ok) {
    return {
      confidence: "none",
      target: null,
      nextCommand: null
    };
  }

  const typeScriptDiagnosticFix = typeScriptDiagnosticFixFromVerification(root, verification);
  if (typeScriptDiagnosticFix) {
    return typeScriptDiagnosticFix;
  }

  const importPathFix = importPathFixFromVerification(root, verification);
  if (importPathFix) {
    return importPathFix;
  }
  const unsupportedImportPathFix = unsupportedImportPathFixFromVerification(root, verification);
  if (unsupportedImportPathFix) {
    return unsupportedImportPathFix;
  }
  if (hasUnresolvedLocalImport(root, verification)) {
    return {
      confidence: "low",
      target: null,
      nextCommand: `agentshell log get ${verification.logRef} --tail 120`
    };
  }

  const implementation = implementationReads[0];
  if (!implementation) {
    return {
      confidence: "low",
      target: null,
      nextCommand: `agentshell log get ${verification.logRef} --tail 120`
    };
  }

  const expectedProperty = expectedPropertyFromError(verification.summary?.mainError);
  const missingExport = missingNamedExportFromVerification(root, verification);
  const primarySymbol = symbols.find((symbol) => !["log"].includes(symbol)) || null;
  const intent = missingExport
    ? `Export \`${missingExport}\` from ${implementation.file}.`
    : expectedProperty
    ? `Ensure ${primarySymbol || "the implementation"} returns or exposes \`${expectedProperty}\`.`
    : `Update ${primarySymbol || "the implementation"} to satisfy the failing assertion.`;

  return {
    confidence: missingExport || expectedProperty || primarySymbol ? "medium" : "low",
    target: {
      file: implementation.file,
      expectedHash: implementation.hash,
      range: missingExport ? implementation.range : inferEditRange(implementation) || implementation.range,
      symbol: missingExport || primarySymbol,
      intent
    },
    nextCommand: "agentshell change <change.json>"
  };
}

function deterministicFixPlanFromVerification(root, verification) {
  return typeScriptDiagnosticFixFromVerification(root, verification)
    || importPathFixFromVerification(root, verification)
    || unsupportedImportPathFixFromVerification(root, verification)
    || (hasUnresolvedLocalImport(root, verification)
      ? {
          confidence: "low",
          target: null,
          nextCommand: `agentshell log get ${verification.logRef} --tail 120`
        }
      : null);
}

function writeChangeTemplate(root, fixPlan) {
  if (!fixPlan.target) return null;

  const templateId = newId("change");
  const dir = ensureState(root);
  const file = path.join(dir, "change-templates", `${templateId}.json`);
  const spec = {
    reason: fixPlan.target.intent,
    edits: [{
      file: fixPlan.target.file,
      expectedHash: fixPlan.target.expectedHash,
      range: fixPlan.target.range,
      replacement: ""
    }]
  };
  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);

  return {
    path: displayPath(root, file),
    replacementRequired: true
  };
}

function displayPath(root, file) {
  const relative = path.relative(root, file);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return file;
}

function compactRead(read) {
  return {
    ok: read.ok,
    file: read.file,
    hash: read.hash,
    range: read.range,
    matchedLine: read.matchedLine,
    totalLines: read.totalLines
  };
}

function compactVerification(verification) {
  return {
    operationId: verification.operationId,
    protocolVersion: verification.protocolVersion,
    type: verification.type,
    exitCode: verification.exitCode,
    durationMs: verification.durationMs,
    cacheHit: verification.cacheHit === true,
    cacheKey: verification.cacheKey || null,
    summary: verification.summary,
    relatedFiles: verification.relatedFiles,
    logRef: verification.logRef
  };
}

function queryFromError(error) {
  if (!error) return "";
  const quoted = /['"]([^'"]{4,})['"]/.exec(error);
  if (quoted) return quoted[1];
  const assertion = /AssertionError.*?:\s*(.+)$/.exec(error);
  if (assertion) return assertion[1];
  return error;
}

function localImports(root, file) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(file)) return [];

  const content = fs.readFileSync(absolute, "utf8");
  const imports = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"`]+\s+from\s+)?['"`](\.{1,2}\/[^'"`]+)['"`]/g,
    /\brequire\(['"`](\.{1,2}\/[^'"`]+)['"`]\)/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const resolved = resolveImport(root, path.dirname(file), match[1]);
      if (resolved && !isTestFile(resolved)) imports.add(resolved);
    }
  }

  return [...imports].sort();
}

function resolveImport(root, fromDir, specifier) {
  const base = path.normalize(path.join(fromDir, specifier));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.js"),
    path.join(base, "index.ts")
  ];

  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (isInside(root, absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return path.relative(root, absolute);
    }
  }

  return null;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTestFile(file) {
  return /(?:^|\/)(?:test|tests)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function expectedPropertyFromError(error) {
  if (!error) return null;
  const property = /\bExpected\s+[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\b/.exec(error);
  if (property && property[1] !== "js") return property[1];
  return null;
}

function missingNamedExportFromVerification(root, verification) {
  const text = [
    verification.summary?.mainError || "",
    logText(root, verification.logRef)
  ].join("\n");
  const match = /does not provide an export named ['"`]([A-Za-z_$][\w$]*)['"`]/.exec(text);
  return match?.[1] || null;
}

function typeScriptDiagnosticFixFromVerification(root, verification) {
  const text = [
    verification.summary?.mainError || "",
    logText(root, verification.logRef)
  ].join("\n");
  const diagnostics = uniqueTypeScriptDiagnostics(root, text);
  if (diagnostics.length === 0) return null;
  if (diagnostics.length !== 1) {
    return {
      confidence: "low",
      target: null,
      nextCommand: `agentshell log get ${verification.logRef} --tail 120`
    };
  }

  const diagnostic = diagnostics[0];
  const absolute = path.join(root, diagnostic.file);
  const source = fs.readFileSync(absolute, "utf8");
  const lines = source.split(/\r?\n/);
  const missingProperty = typeScriptMissingProperty(diagnostic.message);
  const primitiveLiteralMismatch = missingProperty ? null : typeScriptPrimitiveLiteralMismatch(diagnostic.message);
  const literalMismatch = missingProperty || primitiveLiteralMismatch ? null : typeScriptLiteralMismatch(diagnostic.message);
  const propertySuggestion = missingProperty || primitiveLiteralMismatch || literalMismatch ? null : typeScriptPropertySuggestion(diagnostic.message);
  const range = missingProperty
    ? typeScriptObjectLiteralRange(lines, diagnostic.line) || diagnosticLineRange(diagnostic.line, lines.length)
    : diagnosticLineRange(diagnostic.line, lines.length);
  if (!range) {
    return {
      confidence: "low",
      target: null,
      nextCommand: `agentshell log get ${verification.logRef} --tail 120`
    };
  }

  const propertyType = missingProperty
    ? simpleTypeScriptPropertyType(source, missingProperty.property, missingProperty.typeName)
    : null;
  const propertyIntent = missingProperty
    ? ` Add missing TypeScript property \`${missingProperty.property}\`${propertyType ? ` with a ${propertyType} value` : ""}.`
    : "";
  const literalIntent = literalMismatch
    ? ` Replace unique TypeScript ${literalMismatch.actualType} literal with a ${literalMismatch.expectedType} literal.`
    : "";
  const primitiveLiteralIntent = primitiveLiteralMismatch
    ? ` Replace unique TypeScript primitive literal \`${primitiveLiteralMismatch.actualLiteral}\` with \`${primitiveLiteralMismatch.expectedLiteral}\`.`
    : "";
  const propertySuggestionIntent = propertySuggestion
    ? ` Replace TypeScript property \`${propertySuggestion.from}\` with suggested property \`${propertySuggestion.to}\`.`
    : "";

  return {
    confidence: "medium",
    target: {
      file: diagnostic.file,
      expectedHash: hashForFile(absolute),
      range,
      symbol: missingProperty?.property || propertySuggestion?.from || null,
      intent: `Address TypeScript ${diagnostic.code} at ${diagnostic.file}:${diagnostic.line}:${diagnostic.column}.${propertyIntent}${primitiveLiteralIntent}${literalIntent}${propertySuggestionIntent}`
    },
    nextCommand: "agentshell change <change.json>"
  };
}

function uniqueTypeScriptDiagnostics(root, text) {
  const diagnostics = [];
  const seen = new Set();
  const pattern = /(?:^|\n)\s*((?:file:\/\/)?(?:\.{0,2}\/)?[A-Za-z0-9._/-]+\.tsx?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*([^\n]+)/g;
  for (const match of text.matchAll(pattern)) {
    const file = relativeExistingDiagnosticFile(root, match[1]);
    if (!file) continue;
    const diagnostic = {
      file,
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5].trim()
    };
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

function relativeExistingDiagnosticFile(root, file) {
  const stripped = stripFileUrl(file).replace(/^\.\//, "");
  const relative = path.isAbsolute(stripped) ? path.relative(root, stripped) : stripped;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(path.join(root, relative))) return null;
  return relative;
}

function typeScriptMissingProperty(message) {
  const match = /Property ['"`]([A-Za-z_$][\w$]*)['"`] is missing in type [\s\S]+ but required in type ['"`]?([A-Za-z_$][\w$]*)['"`]?/.exec(message);
  if (!match) return null;
  return {
    property: match[1],
    typeName: match[2]
  };
}

function typeScriptLiteralMismatch(message) {
  const match = /Type ['"`](string|number|boolean)['"`] is not assignable to type ['"`](string|number|boolean)['"`]/.exec(message);
  if (!match || match[1] === match[2]) return null;
  return {
    actualType: match[1],
    expectedType: match[2]
  };
}

function typeScriptPrimitiveLiteralMismatch(message) {
  const match = /(?:Argument of type|Type) ['`]([^'`]+)['`] is not assignable to (?:parameter of )?type ['`]([^'`]+)['`]/.exec(message);
  if (!match || match[1] === match[2]) return null;
  const actual = primitiveTypeScriptLiteral(match[1]);
  const expected = primitiveTypeScriptLiteral(match[2]);
  if (!actual || !expected || actual.kind !== expected.kind) return null;
  return {
    actualLiteral: actual.literal,
    expectedLiteral: expected.literal
  };
}

function primitiveTypeScriptLiteral(value) {
  if (/^"(?:\\[\s\S]|[^"\\])*"$/.test(value)) {
    return {
      kind: "string",
      literal: value
    };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return {
      kind: "number",
      literal: value
    };
  }
  if (value === "true" || value === "false") {
    return {
      kind: "boolean",
      literal: value
    };
  }
  return null;
}

function typeScriptPropertySuggestion(message) {
  const match = /Property ['"`]([A-Za-z_$][\w$]*)['"`] does not exist on type [\s\S]+ Did you mean ['"`]([A-Za-z_$][\w$]*)['"`]\?/.exec(message);
  if (!match || match[1] === match[2]) return null;
  return {
    from: match[1],
    to: match[2]
  };
}

function simpleTypeScriptPropertyType(source, property, typeName) {
  const typePattern = new RegExp(`\\b(?:interface|type)\\s+${escapeRegExp(typeName)}\\b[\\s\\S]*?\\{([\\s\\S]*?)\\}`, "m");
  const typeMatch = typePattern.exec(source);
  if (!typeMatch) return null;
  const propertyPattern = new RegExp(`\\b${escapeRegExp(property)}\\??\\s*:\\s*(string|number|boolean)\\b`);
  return propertyPattern.exec(typeMatch[1])?.[1] || null;
}

function typeScriptObjectLiteralRange(lines, oneBasedLine) {
  const index = oneBasedLine - 1;
  if (index < 0 || index >= lines.length) return null;
  if (/\{[\s\S]*\}/.test(lines[index])) {
    return {
      start: oneBasedLine,
      end: oneBasedLine
    };
  }

  let start = -1;
  for (let cursor = index; cursor >= Math.max(0, index - 5); cursor -= 1) {
    if (/\{/.test(lines[cursor])) {
      start = cursor;
      break;
    }
  }
  if (start < 0) return null;

  let depth = 0;
  for (let cursor = start; cursor < lines.length; cursor += 1) {
    depth += countOccurrences(lines[cursor], "{");
    depth -= countOccurrences(lines[cursor], "}");
    if (depth <= 0) {
      return {
        start: start + 1,
        end: cursor + 1
      };
    }
  }
  return null;
}

function diagnosticLineRange(line, totalLines) {
  if (line < 1 || line > totalLines) return null;
  return {
    start: line,
    end: line
  };
}

function importPathFixFromVerification(root, verification) {
  const text = [
    verification.summary?.mainError || "",
    logText(root, verification.logRef)
  ].join("\n");
  if (!/\b(?:ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find module)\b/i.test(text)) return null;

  const missing = missingModuleFromText(text);
  if (!missing) return null;

  const importer = missing.importer ? relativeExistingFile(root, missing.importer) : null;
  if (!importer) return null;

  const importerPath = path.join(root, importer);
  const source = fs.readFileSync(importerPath, "utf8");
  const lines = source.split(/\r?\n/);
  const importMatch = findImportPathLine(root, importer, lines, missing.module);
  if (!importMatch) return null;

  const missingPath = absoluteMissingModuleForImporter(root, importer, missing.module);
  if (!missingPath) return null;

  const candidate = uniqueNearbyModuleCandidate(root, missingPath);
  if (!candidate) return null;

  const replacement = replacementSpecifier(importMatch.specifier, missingPath, candidate);
  if (!replacement) return null;

  return {
    confidence: "medium",
    target: {
      file: importer,
      expectedHash: hashForFile(importerPath),
      range: {
        start: importMatch.line,
        end: importMatch.line
      },
      symbol: null,
      intent: `Replace unresolved import path \`${importMatch.specifier}\` with \`${replacement}\`.`
    },
    nextCommand: "agentshell change <change.json>"
  };
}

function unsupportedImportPathFixFromVerification(root, verification) {
  const text = [
    verification.summary?.mainError || "",
    logText(root, verification.logRef)
  ].join("\n");
  if (!/\b(?:ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find module)\b/i.test(text)) return null;

  const missing = missingModuleFromText(text);
  if (!missing) return null;

  const importer = missing.importer ? relativeExistingFile(root, missing.importer) : null;
  if (!importer) return null;

  const importerPath = path.join(root, importer);
  const source = fs.readFileSync(importerPath, "utf8");
  const lines = source.split(/\r?\n/);
  const importMatch = findImportPathLine(root, importer, lines, missing.module);
  if (!importMatch) return null;

  return {
    confidence: "low",
    target: {
      file: importer,
      expectedHash: hashForFile(importerPath),
      range: {
        start: importMatch.line,
        end: importMatch.line
      },
      symbol: null,
      intent: `Resolve unsupported unresolved import path \`${importMatch.specifier}\` manually.`
    },
    nextCommand: "agentshell change <change.json>"
  };
}

function hasUnresolvedLocalImport(root, verification) {
  const text = [
    verification.summary?.mainError || "",
    logText(root, verification.logRef)
  ].join("\n");
  if (!/\b(?:ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find module)\b/i.test(text)) return false;
  const missing = missingModuleFromText(text);
  if (!missing?.module) return false;
  const stripped = stripFileUrl(missing.module);
  if (stripped.startsWith(".")) return true;
  if (!path.isAbsolute(stripped)) return false;
  const relative = path.relative(root, stripped);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function missingModuleFromText(text) {
  const patterns = [
    /Cannot find module ['"`]([^'"`]+)['"`] imported from (?:\n)?['"`]?([^'"`\n]+)['"`]?/i,
    /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module ['"`]([^'"`]+)['"`] imported from (?:\n)?['"`]?([^'"`\n]+)['"`]?/i,
    /Error \[ERR_UNSUPPORTED_DIR_IMPORT\]: Directory import ['"`]([^'"`]+)['"`] is not supported resolving ES modules imported from (?:\n)?['"`]?([^'"`\n]+)['"`]?/i,
    /Cannot find module ['"`]([^'"`]+)['"`][\s\S]*?Require stack:\s*(?:\r?\n)-\s*([^\r\n]+)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return {
        module: stripFileUrl(match[1]),
        importer: stripFileUrl(match[2])
      };
    }
  }
  return null;
}

function relativeExistingFile(root, file) {
  const stripped = stripFileUrl(file);
  if (!path.isAbsolute(stripped)) return null;
  const relative = path.relative(root, stripped);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(path.join(root, relative))) return null;
  return relative;
}

function findImportPathLine(root, importer, lines, missingModule) {
  const importerDir = path.dirname(path.join(root, importer));
  const strippedMissingModule = stripFileUrl(missingModule);
  const missingPath = path.normalize(strippedMissingModule.startsWith(".")
    ? path.resolve(importerDir, strippedMissingModule)
    : strippedMissingModule);
  const importPattern = /\b(?:import|export)\b[^'"`]*\bfrom\s*(['"`])([^'"`]+)\1|\bimport\s*\(\s*(['"`])([^'"`]+)\3\s*\)|\brequire\s*\(\s*(['"`])([^'"`]+)\5\s*\)/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = importPattern.exec(lines[index]);
    const specifier = match?.[2] || match?.[4] || match?.[6];
    if (!specifier || !specifier.startsWith(".")) continue;
    const resolved = path.normalize(path.resolve(importerDir, specifier));
    if (specifier === strippedMissingModule || resolved === missingPath) {
      return {
        line: index + 1,
        specifier
      };
    }
  }
  return null;
}

function absoluteMissingModuleForImporter(root, importer, missingModule) {
  const stripped = stripFileUrl(missingModule);
  if (path.isAbsolute(stripped)) return stripped;
  if (!stripped.startsWith(".")) return null;
  return path.resolve(path.dirname(path.join(root, importer)), stripped);
}

function uniqueNearbyModuleCandidate(root, missingModule) {
  const missingPath = stripFileUrl(missingModule);
  if (!path.isAbsolute(missingPath)) return null;
  const relative = path.relative(root, missingPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const absoluteMissing = path.join(root, relative);
  const dir = path.dirname(absoluteMissing);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

  const missingBase = path.basename(missingPath);
  const missingExt = path.extname(missingBase);
  const missingStem = missingExt ? missingBase.slice(0, -missingExt.length) : missingBase;
  const candidates = [];

  const fileCandidates = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(?:js|jsx|ts|tsx|mjs|cjs|json)$/.test(name))
    .map((name) => ({
      name,
      ext: path.extname(name),
      stem: path.basename(name, path.extname(name))
    }));
  const exactStemFileCandidates = fileCandidates.filter((candidate) => !missingExt && candidate.stem === missingStem);

  candidates.push(...fileCandidates
    .filter((candidate) => {
      if (!missingExt) {
        if (exactStemFileCandidates.length > 0) return candidate.stem === missingStem;
        return editDistance(candidate.stem, missingStem) <= 2;
      }
      if (missingExt && candidate.stem === missingStem && candidate.ext !== missingExt) return true;
      if (missingExt && candidate.ext === missingExt && editDistance(candidate.stem, missingStem) <= 2) return true;
      return editDistance(candidate.name, missingBase) <= 2;
    })
    .map((candidate) => path.join(dir, candidate.name)));

  if (!missingExt && fs.existsSync(absoluteMissing) && fs.statSync(absoluteMissing).isDirectory()) {
    candidates.push(...fs.readdirSync(absoluteMissing, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^index\.(?:js|jsx|ts|tsx|mjs|cjs|json)$/.test(name))
      .map((name) => path.join(absoluteMissing, name)));
  }

  if (candidates.length !== 1) return null;
  return candidates[0];
}

function replacementSpecifier(specifier, missingModule, candidate) {
  const missingPath = stripFileUrl(missingModule);
  const missingDir = path.dirname(missingPath);
  const relativeCandidate = path.relative(missingDir, candidate);
  if (relativeCandidate.startsWith("..") || path.isAbsolute(relativeCandidate)) return null;
  return `${specifier.slice(0, specifier.length - path.basename(specifier).length)}${relativeCandidate}`;
}

function hashForFile(file) {
  const content = fs.readFileSync(file, "utf8");
  return sha256(content);
}

function stripFileUrl(value) {
  return value.replace(/^file:\/\//, "");
}

function editDistance(left, right) {
  if (Math.abs(left.length - right.length) > 2) return 3;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logText(root, logRef) {
  if (!logRef) return "";
  try {
    const log = readLog(root, logRef);
    return `${log.stdout || ""}\n${log.stderr || ""}`;
  } catch {
    return "";
  }
}

function inferEditRange(read) {
  const lines = parseNumberedContent(read.content);
  const returnObjectStart = lines.findIndex((line) => /\breturn\s+\{/.test(line.text));
  if (returnObjectStart >= 0) {
    return inferReturnBlockRange(lines, returnObjectStart, /\};?\s*$/, /^\s*\};?\s*$/);
  }

  const returnArrayStart = lines.findIndex((line) => /\breturn\s+\[/.test(line.text));
  if (returnArrayStart >= 0) {
    return inferReturnBlockRange(lines, returnArrayStart, /\]\s*;?\s*$/, /^\s*\]\s*;?\s*$/);
  }
  return null;
}

function inferReturnBlockRange(lines, startIndex, inlineEndPattern, closingLinePattern) {
  if (inlineEndPattern.test(lines[startIndex].text)) {
    return {
      start: lines[startIndex].number,
      end: lines[startIndex].number
    };
  }

  for (let index = startIndex; index < lines.length; index += 1) {
    if (closingLinePattern.test(lines[index].text)) {
      return {
        start: lines[startIndex].number,
        end: lines[index].number
      };
    }
  }
  return null;
}

function parseNumberedContent(content) {
  return content.split("\n").map((line) => {
    const match = /^(\d+)\s+\|\s?(.*)$/.exec(line);
    if (!match) return null;
    return {
      number: Number(match[1]),
      text: match[2]
    };
  }).filter(Boolean);
}

function extractSymbols(text) {
  const symbols = new Set();
  for (const match of text.matchAll(/\bimport\s+\{\s*([A-Za-z_$][\w$]*)/g)) {
    symbols.add(match[1]);
  }
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const symbol = match[1];
    if (!["assert", "console", "for", "if", "while", "switch", "ok", "equal", "deepEqual", "log"].includes(symbol)) {
      symbols.add(symbol);
    }
  }
  return [...symbols];
}
