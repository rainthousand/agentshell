import { readLog } from "../core/store.js";

export function suggestReplacement(root, original, range, diagnosis) {
  const importPathReplacement = suggestImportPathReplacement(root, original, range, diagnosis);
  if (importPathReplacement) return { strategy: "import-path", replacement: importPathReplacement };

  const typeScriptDiagnosticReplacement = suggestTypeScriptDiagnosticReplacement(root, original, range, diagnosis);
  if (typeScriptDiagnosticReplacement) return { strategy: "typescript-missing-property", replacement: typeScriptDiagnosticReplacement };

  const typeScriptPrimitiveLiteralReplacement = suggestTypeScriptPrimitiveLiteralMismatchReplacement(root, original, range, diagnosis);
  if (typeScriptPrimitiveLiteralReplacement) return { strategy: "typescript-primitive-literal-mismatch", replacement: typeScriptPrimitiveLiteralReplacement };

  const typeScriptLiteralMismatchReplacement = suggestTypeScriptLiteralMismatchReplacement(root, original, range, diagnosis);
  if (typeScriptLiteralMismatchReplacement) return { strategy: "typescript-literal-mismatch", replacement: typeScriptLiteralMismatchReplacement };

  const typeScriptPropertySuggestionReplacement = suggestTypeScriptPropertySuggestionReplacement(root, original, range, diagnosis);
  if (typeScriptPropertySuggestionReplacement) return { strategy: "typescript-property-suggestion", replacement: typeScriptPropertySuggestionReplacement };

  const exportReplacement = suggestMissingNamedExportReplacement(root, original, range, diagnosis);
  if (exportReplacement) return { strategy: "missing-named-export", replacement: exportReplacement };

  const truthyReturnReplacement = suggestTruthyReturnReplacement(root, original, range, diagnosis);
  if (truthyReturnReplacement) return { strategy: "truthy-return", replacement: truthyReturnReplacement };

  const joinSeparatorReplacement = suggestJoinSeparatorReplacement(root, original, range, diagnosis);
  if (joinSeparatorReplacement) return { strategy: "join-separator-literal", replacement: joinSeparatorReplacement };

  const stringCaseReplacement = suggestStringCaseTransformReplacement(root, original, range, diagnosis);
  if (stringCaseReplacement) return { strategy: "string-case-transform", replacement: stringCaseReplacement };

  const deepEqualArrayPrimitiveReplacement = suggestDeepEqualArrayPrimitiveReplacement(root, original, range, diagnosis);
  if (deepEqualArrayPrimitiveReplacement) return { strategy: "deep-equal-array-primitive-replacement", replacement: deepEqualArrayPrimitiveReplacement };

  const literalReplacement = suggestLiteralReplacement(root, original, range, diagnosis);
  if (literalReplacement) return { strategy: "literal-replacement", replacement: literalReplacement };

  const deepEqualMissingPropertyReplacement = suggestDeepEqualMissingPropertyReplacement(root, original, range, diagnosis);
  if (deepEqualMissingPropertyReplacement) return { strategy: "deep-equal-missing-property", replacement: deepEqualMissingPropertyReplacement };

  const deepEqualArrayElementsReplacement = suggestDeepEqualArrayElementsReplacement(root, original, range, diagnosis);
  if (deepEqualArrayElementsReplacement) return { strategy: "deep-equal-array-elements", replacement: deepEqualArrayElementsReplacement };

  const deepEqualArrayRemovalReplacement = suggestDeepEqualArrayRemovalReplacement(root, original, range, diagnosis);
  if (deepEqualArrayRemovalReplacement) return { strategy: "deep-equal-array-removal", replacement: deepEqualArrayRemovalReplacement };

  const deepEqualExtraPropertyRemovalReplacement = suggestDeepEqualExtraPropertyRemovalReplacement(root, original, range, diagnosis);
  if (deepEqualExtraPropertyRemovalReplacement) return { strategy: "deep-equal-extra-property-removal", replacement: deepEqualExtraPropertyRemovalReplacement };

  const arrayLengthReplacement = suggestArrayLengthReplacement(root, original, range, diagnosis);
  if (arrayLengthReplacement) return { strategy: "array-length", replacement: arrayLengthReplacement };

  const property = expectedProperty(diagnosis);
  if (!property) return null;

  const lines = original.split(/\r?\n/);
  if (!validRange(range, lines.length)) return null;
  const selected = lines.slice(range.start - 1, range.end);
  if (selected.some((line) => new RegExp(`\\b${escapeRegExp(property)}\\b\\s*:`).test(line))) {
    return null;
  }

  const returnObjectIndex = selected.findIndex((line) => /\breturn\s*\{/.test(line));
  if (returnObjectIndex < 0) return null;

  const indent = selected[returnObjectIndex + 1]?.match(/^\s*/)?.[0]
    || `${selected[returnObjectIndex].match(/^\s*/)?.[0] || ""}  `;
  const symbol = diagnosis.fixPlan?.target?.symbol || "value";
  const value = expectedValueForMissingProperty(root, diagnosis, property)
    || (property === "id" && symbol ? "`user_${input.email}`" : "true");

  return {
    strategy: "missing-object-property",
    replacement: addPropertyToReturnObject(selected, property, value, returnObjectIndex, indent)
  };
}

function suggestImportPathReplacement(root, original, range, diagnosis) {
  const replacement = importPathReplacementFromDiagnosis(diagnosis);
  if (!replacement) return null;

  const lines = original.split(/\r?\n/);
  if (!validRange(range, lines.length) || range.start !== range.end) return null;

  const line = lines[range.start - 1];
  if (!line.includes(replacement.from)) return null;
  const occurrences = countOccurrences(line, replacement.from);
  if (occurrences !== 1) return null;
  if (!isImportPathLine(line, replacement.from)) return null;

  return line.replace(replacement.from, replacement.to);
}

function importPathReplacementFromDiagnosis(diagnosis) {
  const intent = diagnosis.fixPlan?.target?.intent || "";
  const match = /Replace unresolved import path `([^`]+)` with `([^`]+)`\./.exec(intent);
  if (!match) return null;
  if (!match[1].startsWith(".") || !match[2].startsWith(".")) return null;
  return {
    from: match[1],
    to: match[2]
  };
}

function isImportPathLine(line, specifier) {
  const escaped = escapeRegExp(specifier);
  const patterns = [
    new RegExp(`\\b(?:import|export)\\b[^'"\\\`]*\\bfrom\\s*(['"\\\`])${escaped}\\1`),
    new RegExp(`\\bimport\\s*\\(\\s*(['"\\\`])${escaped}\\1\\s*\\)`),
    new RegExp(`\\brequire\\s*\\(\\s*(['"\\\`])${escaped}\\1\\s*\\)`)
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function suggestTypeScriptDiagnosticReplacement(root, original, range, diagnosis) {
  const missing = typeScriptMissingPropertyFromDiagnosis(diagnosis);
  if (!missing) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  if (selected.some((line) => new RegExp(`\\b${escapeRegExp(missing.property)}\\b\\s*:`).test(line))) {
    return null;
  }

  const value = typeScriptDefaultValue(missing.type);
  if (!value) return null;

  const objectLiteralStarts = selected
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => /\{/.test(line));
  if (objectLiteralStarts.length !== 1) return null;

  return addPropertyToObjectLiteral(selected, missing.property, value, objectLiteralStarts[0].index);
}

function typeScriptMissingPropertyFromDiagnosis(diagnosis) {
  const intent = diagnosis.fixPlan?.target?.intent || "";
  const match = /TypeScript TS\d+ at [^.\n]+\.[\s\S]*?Add missing TypeScript property `([A-Za-z_$][\w$]*)`(?: with a (string|number|boolean) value)?\./.exec(intent);
  if (!match) return null;
  return {
    property: match[1],
    type: match[2] || null
  };
}

function typeScriptDefaultValue(type) {
  if (type === "string") return "\"\"";
  if (type === "number") return "0";
  if (type === "boolean") return "false";
  return null;
}

function suggestTypeScriptPrimitiveLiteralMismatchReplacement(root, original, range, diagnosis) {
  const mismatch = typeScriptPrimitiveLiteralMismatchFromDiagnosis(diagnosis);
  if (!mismatch) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  const selectedText = selected.join("\n");
  const literalPairs = literalReplacementPairs(
    parseTypeScriptPrimitiveLiteral(mismatch.actualLiteral),
    parseTypeScriptPrimitiveLiteral(mismatch.expectedLiteral)
  );
  if (literalPairs.length === 0) return null;

  const candidates = literalPairs
    .map(([actualLiteral, expectedLiteral]) => ({
      actualLiteral,
      expectedLiteral,
      occurrences: countOccurrences(selectedText, actualLiteral)
    }))
    .filter((candidate) => candidate.occurrences > 0);
  const totalOccurrences = candidates.reduce((total, candidate) => total + candidate.occurrences, 0);
  if (totalOccurrences !== 1 || candidates.length !== 1) return null;
  return selectedText.replace(candidates[0].actualLiteral, candidates[0].expectedLiteral);
}

function typeScriptPrimitiveLiteralMismatchFromDiagnosis(diagnosis) {
  const intent = diagnosis.fixPlan?.target?.intent || "";
  const match = /TypeScript TS(?:2322|2345) at [^.\n]+\.[\s\S]*?Replace unique TypeScript primitive literal `([^`]+)` with `([^`]+)`\./.exec(intent);
  if (!match || match[1] === match[2]) return null;
  return {
    actualLiteral: match[1],
    expectedLiteral: match[2]
  };
}

function parseTypeScriptPrimitiveLiteral(value) {
  if (/^"(?:\\[\s\S]|[^"\\])*"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function suggestTypeScriptLiteralMismatchReplacement(root, original, range, diagnosis) {
  const mismatch = typeScriptLiteralMismatchFromDiagnosis(diagnosis);
  if (!mismatch) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  const selectedText = selected.join("\n");
  const expectedLiteral = typeScriptDefaultValue(mismatch.expectedType);
  if (!expectedLiteral) return null;

  const candidates = literalCandidatesForType(selectedText, mismatch.actualType);
  if (candidates.length !== 1) return null;
  return `${selectedText.slice(0, candidates[0].start)}${expectedLiteral}${selectedText.slice(candidates[0].end)}`;
}

function typeScriptLiteralMismatchFromDiagnosis(diagnosis) {
  const intent = diagnosis.fixPlan?.target?.intent || "";
  const match = /TypeScript TS2322 at [^.\n]+\.[\s\S]*?Replace unique TypeScript (string|number|boolean) literal with a (string|number|boolean) literal\./.exec(intent);
  if (!match || match[1] === match[2]) return null;
  return {
    actualType: match[1],
    expectedType: match[2]
  };
}

function suggestTypeScriptPropertySuggestionReplacement(root, original, range, diagnosis) {
  const suggestion = typeScriptPropertySuggestionFromDiagnosis(diagnosis);
  if (!suggestion) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  const selectedText = selected.join("\n");
  if (countOccurrences(selectedText, suggestion.from) !== 1) return null;

  const propertyPattern = new RegExp(`(^|[^\\w$])(${escapeRegExp(suggestion.from)})(?![\\w$])`, "g");
  const matches = [...selectedText.matchAll(propertyPattern)];
  if (matches.length !== 1) return null;
  return selectedText.replace(propertyPattern, `$1${suggestion.to}`);
}

function typeScriptPropertySuggestionFromDiagnosis(diagnosis) {
  const intent = diagnosis.fixPlan?.target?.intent || "";
  const match = /TypeScript TS2551 at [^.\n]+\.[\s\S]*?Replace TypeScript property `([A-Za-z_$][\w$]*)` with suggested property `([A-Za-z_$][\w$]*)`\./.exec(intent);
  if (!match || match[1] === match[2]) return null;
  return {
    from: match[1],
    to: match[2]
  };
}

function literalCandidatesForType(text, type) {
  const patterns = {
    string: /(["'`])(?:\\[\s\S]|(?!\1)[^\\\n])*\1/g,
    number: /(^|[^\w$])-?\d+(?:\.\d+)?(?![\w$])/g,
    boolean: /\b(?:true|false)\b/g
  };
  const pattern = patterns[type];
  if (!pattern) return [];
  return [...text.matchAll(pattern)].map((match) => ({
    start: type === "number" ? match.index + match[1].length : match.index,
    end: match.index + match[0].length
  }));
}

function suggestMissingNamedExportReplacement(root, original, range, diagnosis) {
  const symbol = missingNamedExportFromDiagnosis(root, diagnosis);
  if (!symbol) return null;

  const lines = original.split(/\r?\n/);
  if (!validRange(range, lines.length)) return null;
  const selectedText = lines.slice(range.start - 1, range.end).join("\n");
  if (new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${escapeRegExp(symbol)}\\b`).test(selectedText)) {
    return null;
  }

  const declaration = new RegExp(`(^|\\n)(\\s*)((?:async\\s+)?function|class|const|let|var)\\s+${escapeRegExp(symbol)}\\b`);
  const matches = [...selectedText.matchAll(new RegExp(declaration.source, "g"))];
  if (matches.length !== 1) return null;
  return selectedText.replace(declaration, `$1$2export $3 ${symbol}`);
}

function suggestLiteralReplacement(root, original, range, diagnosis) {
  const assertion = assertionValuesFromDiagnosis(root, diagnosis);
  if (!assertion) return null;

  const lines = original.split(/\r?\n/);
  if (!validRange(range, lines.length)) return null;
  const selected = lines.slice(range.start - 1, range.end);
  const selectedText = selected.join("\n");
  const literalPairs = literalReplacementPairs(assertion.actual, assertion.expected);
  if (literalPairs.length === 0) return null;

  const candidates = literalPairs
    .map(([actualLiteral, expectedLiteral]) => ({
      actualLiteral,
      expectedLiteral,
      occurrences: countOccurrences(selectedText, actualLiteral)
    }))
    .filter((candidate) => candidate.occurrences > 0);
  const totalOccurrences = candidates.reduce((total, candidate) => total + candidate.occurrences, 0);
  if (totalOccurrences !== 1 || candidates.length !== 1) return null;
  return selectedText.replace(candidates[0].actualLiteral, candidates[0].expectedLiteral);
}

function suggestJoinSeparatorReplacement(root, original, range, diagnosis) {
  const assertion = assertionValuesFromDiagnosis(root, diagnosis);
  if (!assertion || typeof assertion.actual !== "string" || typeof assertion.expected !== "string") return null;
  if (!isMissingSpaceAssertion(assertion.actual, assertion.expected)) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  const selectedText = selected.join("\n");
  const emptyJoin = /\.join\(\s*(['"`])\1\s*\)/g;
  const matches = [...selectedText.matchAll(emptyJoin)];
  if (matches.length !== 1) return null;

  const quote = matches[0][1];
  return selectedText.replace(emptyJoin, `.join(${quote} ${quote})`);
}

function suggestStringCaseTransformReplacement(root, original, range, diagnosis) {
  const assertion = assertionValuesFromDiagnosis(root, diagnosis);
  const transform = stringCaseTransform(assertion);
  if (!transform) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  const selectedText = selected.join("\n");
  const returnExpression = singleReturnExpression(selectedText);
  if (!returnExpression) return null;
  if (/[?=:]|\|\||&&|=>|\b(?:if|switch|for|while)\b/.test(returnExpression)) return null;
  if (new RegExp(`\\.${transform}\\s*\\(`).test(returnExpression)) return null;

  const expressionPattern = new RegExp(`\\breturn\\s+${escapeRegExp(returnExpression)}\\s*;?`);
  return selectedText.replace(expressionPattern, `return ${returnExpression}.${transform}();`);
}

function stringCaseTransform(assertion) {
  if (!assertion || typeof assertion.actual !== "string" || typeof assertion.expected !== "string") return null;
  if (assertion.actual.length === 0 || assertion.actual === assertion.expected) return null;
  if (assertion.actual.toLowerCase() !== assertion.expected.toLowerCase()) return null;
  if (assertion.expected === assertion.actual.toUpperCase() && assertion.expected !== assertion.actual.toLowerCase()) {
    return "toUpperCase";
  }
  if (assertion.expected === assertion.actual.toLowerCase() && assertion.expected !== assertion.actual.toUpperCase()) {
    return "toLowerCase";
  }
  return null;
}

function singleReturnExpression(text) {
  const matches = [...text.matchAll(/\breturn\s+([^;\n]+)\s*;?/g)];
  if (matches.length !== 1) return null;
  const expression = matches[0][1].trim();
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\([^()\n]*\))*$/.test(expression)) return null;
  return expression;
}

function isMissingSpaceAssertion(first, second) {
  if (first === second) return false;
  return (
    (first.includes(" ") && first.replaceAll(" ", "") === second) ||
    (second.includes(" ") && second.replaceAll(" ", "") === first)
  );
}

function suggestTruthyReturnReplacement(root, original, range, diagnosis) {
  if (!truthyAssertionFromDiagnosis(root, diagnosis)) return null;

  const lines = original.split(/\r?\n/);
  if (!validRange(range, lines.length)) return null;
  const selectedText = lines.slice(range.start - 1, range.end).join("\n");
  const falsyReturn = /\breturn\s+(false|null|undefined)\s*;?/g;
  const matches = [...selectedText.matchAll(falsyReturn)];
  if (matches.length !== 1) return null;
  return selectedText.replace(falsyReturn, "return true;");
}

function suggestDeepEqualMissingPropertyReplacement(root, original, range, diagnosis) {
  const missing = deepEqualMissingPropertyFromDiagnosis(root, diagnosis);
  if (!missing) return null;

  const lines = original.split(/\r?\n/);
  if (!validRange(range, lines.length)) return null;
  const selected = lines.slice(range.start - 1, range.end);
  if (selected.some((line) => new RegExp(`\\b${escapeRegExp(missing.property)}\\b\\s*:`).test(line))) {
    return null;
  }

  const returnObjectMatches = selected
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => /\breturn\s*\{/.test(line));
  if (returnObjectMatches.length !== 1) return null;

  const returnObjectIndex = returnObjectMatches[0].index;
  const indent = selected[returnObjectIndex + 1]?.match(/^\s*/)?.[0]
    || `${selected[returnObjectIndex].match(/^\s*/)?.[0] || ""}  `;
  return addPropertyToReturnObject(selected, missing.property, missing.value, returnObjectIndex, indent);
}

function suggestDeepEqualArrayElementsReplacement(root, original, range, diagnosis) {
  const missingElements = deepEqualMissingArrayElementsFromDiagnosis(root, diagnosis);
  if (!missingElements) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  return appendElementsToSingleReturnArray(selected, missingElements);
}

function suggestDeepEqualArrayRemovalReplacement(root, original, range, diagnosis) {
  const extraElements = deepEqualExtraArrayElementsFromDiagnosis(root, diagnosis);
  if (!extraElements) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  return removeTrailingElementsFromSingleReturnArray(selected, extraElements);
}

function suggestDeepEqualExtraPropertyRemovalReplacement(root, original, range, diagnosis) {
  const extra = deepEqualExtraPropertyFromDiagnosis(root, diagnosis);
  if (!extra) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  return removePropertyFromSingleReturnObject(selected, extra.property, extra.value);
}

function suggestDeepEqualArrayPrimitiveReplacement(root, original, range, diagnosis) {
  const replacement = deepEqualArrayPrimitiveReplacementFromDiagnosis(root, diagnosis);
  if (!replacement) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  return replaceElementInSingleReturnArray(selected, replacement.from, replacement.to);
}

function suggestArrayLengthReplacement(root, original, range, diagnosis) {
  const fillCount = arrayLengthFillCountFromDiagnosis(root, diagnosis);
  if (!fillCount) return null;

  const selected = selectedLines(original, range);
  if (!selected) return null;
  return appendElementsToSingleReturnArray(selected, Array(fillCount).fill("undefined"));
}

function assertionValuesFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  const literal = "(['\"`][\\s\\S]*?['\"`]|-?\\d+(?:\\.\\d+)?|true|false|null|undefined)";
  const diff = new RegExp(`(?:^|\\n)\\s*\\+\\s+${literal}\\s*\\n\\s*-\\s+${literal}(?:\\n|$)`, "m").exec(logText);
  if (diff) {
    return {
      actual: parseLiteral(diff[1]),
      expected: parseLiteral(diff[2])
    };
  }
  const reverseDiff = new RegExp(`(?:^|\\n)\\s*-\\s+${literal}\\s*\\n\\s*\\+\\s+${literal}(?:\\n|$)`, "m").exec(logText);
  if (reverseDiff) {
    return {
      actual: parseLiteral(reverseDiff[1]),
      expected: parseLiteral(reverseDiff[2])
    };
  }
  const strictEqual = new RegExp(`${literal}\\s+!==\\s+${literal}`).exec(logText);
  if (strictEqual) {
    return {
      actual: parseLiteral(strictEqual[1]),
      expected: parseLiteral(strictEqual[2])
    };
  }
  const actual = new RegExp(`\\bactual:\\s+${literal}`).exec(logText);
  const expected = new RegExp(`\\bexpected:\\s+${literal}`).exec(logText);
  if (actual && expected) {
    return {
      actual: parseLiteral(actual[1]),
      expected: parseLiteral(expected[1])
    };
  }
  return null;
}

function truthyAssertionFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  return /\bassert\.ok\s*\(/.test(logText) && /falsy value|actual:\s+(?:false|null|undefined)|Expected values to be strictly equal:\s*\n\s*\+\s+(?:false|null|undefined)/i.test(logText);
}

function deepEqualMissingPropertyFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  if (!/Expected values to be (?:(?:strictly|loosely) )?deep-?equal/i.test(logText)) return null;

  const literal = "(['\"`][^'\"`\\n]*['\"`]|-?\\d+(?:\\.\\d+)?|true|false|null)";
  const removedProperties = [...logText.matchAll(new RegExp(`^\\s*-\\s+([A-Za-z_$][\\w$]*):\\s+${literal},?\\s*$`, "gm"))];
  const addedProperties = [...logText.matchAll(new RegExp(`^\\s*\\+\\s+([A-Za-z_$][\\w$]*):\\s+${literal},?\\s*$`, "gm"))];
  if (removedProperties.length !== 1 || addedProperties.length !== 0) return null;

  const property = removedProperties[0][1];
  const value = literalFor(parseLiteral(removedProperties[0][2]));
  if (!value) return null;
  return { property, value };
}

function deepEqualExtraPropertyFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  if (!/Expected values to be (?:(?:strictly|loosely) )?deep-?equal/i.test(logText)) return null;

  const literal = "(['\"`][^'\"`\\n]*['\"`]|-?\\d+(?:\\.\\d+)?|true|false|null)";
  const addedProperties = [...logText.matchAll(new RegExp(`^\\s*\\+\\s+([A-Za-z_$][\\w$]*):\\s+${literal},?\\s*$`, "gm"))];
  const removedProperties = [...logText.matchAll(new RegExp(`^\\s*-\\s+([A-Za-z_$][\\w$]*):\\s+${literal},?\\s*$`, "gm"))];
  if (addedProperties.length !== 1 || removedProperties.length !== 0) return null;

  const property = addedProperties[0][1];
  const value = literalFor(parseLiteral(addedProperties[0][2]));
  if (!value) return null;
  return { property, value };
}

function deepEqualMissingArrayElementsFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  if (!/Expected values to be (?:(?:strictly|loosely) )?deep-?equal/i.test(logText)) return null;

  const literal = "(['\"`][^'\"`\\n]*['\"`]|-?\\d+(?:\\.\\d+)?|true|false|null|undefined)";
  const removedElements = [...logText.matchAll(new RegExp(`^\\s*-\\s+${literal},?\\s*$`, "gm"))];
  const addedElements = [...logText.matchAll(new RegExp(`^\\s*\\+\\s+${literal},?\\s*$`, "gm"))];
  if (removedElements.length < 1 || addedElements.length !== 0) return null;
  if (removedElements.length > 3) return null;

  const values = removedElements
    .map((match) => literalFor(parseLiteral(match[1])))
    .filter(Boolean);
  return values.length === removedElements.length ? values : null;
}

function deepEqualExtraArrayElementsFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  if (!/Expected values to be (?:(?:strictly|loosely) )?deep-?equal/i.test(logText)) return null;

  const literal = "(['\"`][^'\"`\\n]*['\"`]|-?\\d+(?:\\.\\d+)?|true|false|null|undefined)";
  const addedElements = [...logText.matchAll(new RegExp(`^\\s*\\+\\s+${literal},?\\s*$`, "gm"))];
  const removedElements = [...logText.matchAll(new RegExp(`^\\s*-\\s+${literal},?\\s*$`, "gm"))];
  if (addedElements.length < 1 || removedElements.length !== 0) return null;
  if (addedElements.length > 3) return null;

  const values = addedElements
    .map((match) => literalFor(parseLiteral(match[1])))
    .filter(Boolean);
  return values.length === addedElements.length ? values : null;
}

function deepEqualArrayPrimitiveReplacementFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  if (!/Expected values to be (?:(?:strictly|loosely) )?deep-?equal/i.test(logText)) return null;

  const literal = "(['\"`][^'\"`\\n]*['\"`]|-?\\d+(?:\\.\\d+)?|true|false|null|undefined)";
  const addedElements = [...logText.matchAll(new RegExp(`^\\s*\\+\\s+${literal},?\\s*$`, "gm"))];
  const removedElements = [...logText.matchAll(new RegExp(`^\\s*-\\s+${literal},?\\s*$`, "gm"))];
  if (addedElements.length !== 1 || removedElements.length !== 1) return null;

  const from = literalFor(parseLiteral(addedElements[0][1]));
  const to = literalFor(parseLiteral(removedElements[0][1]));
  const direct = buildPrimitiveReplacement(from, to);
  if (direct) return direct;

  const assertion = assertionValuesFromDiagnosis(root, diagnosis);
  return buildPrimitiveReplacement(literalFor(assertion?.actual), literalFor(assertion?.expected));
}

function buildPrimitiveReplacement(from, to) {
  if (!from || !to || from === to) return null;
  return { from, to };
}

function arrayLengthFillCountFromDiagnosis(root, diagnosis) {
  const assertion = assertionValuesFromDiagnosis(root, diagnosis);
  if (!assertion) return null;
  if (!Number.isInteger(assertion.actual) || !Number.isInteger(assertion.expected)) return null;
  if (assertion.actual < 0 || assertion.expected <= assertion.actual) return null;
  const fillCount = assertion.expected - assertion.actual;
  return fillCount <= 3 ? fillCount : null;
}

function missingNamedExportFromDiagnosis(root, diagnosis) {
  const logText = logTextForDiagnosis(root, diagnosis);
  const patterns = [
    /does not provide an export named ['"`]([A-Za-z_$][\w$]*)['"`]/,
    /No matching export .* for import ['"`]([A-Za-z_$][\w$]*)['"`]/i,
    /export ['"`]([A-Za-z_$][\w$]*)['"`] was not found/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(logText);
    if (match) return match[1];
  }
  return null;
}

function logTextForDiagnosis(root, diagnosis) {
  if (!diagnosis.logRef) return "";
  try {
    const log = readLog(root, diagnosis.logRef);
    return `${log.stdout || ""}\n${log.stderr || ""}`;
  } catch {
    return "";
  }
}

function parseLiteral(value) {
  const trimmed = value.trim();
  if (/^['"`][\s\S]*['"`]$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "undefined") return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function literalFor(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return null;
}

function literalReplacementPairs(actual, expected) {
  if (actual === expected) return [];
  if (typeof actual === "string" && typeof expected === "string") {
    return [
      [quoteLiteral(actual, "\""), quoteLiteral(expected, "\"")],
      [quoteLiteral(actual, "'"), quoteLiteral(expected, "'")],
      [quoteLiteral(actual, "`"), quoteLiteral(expected, "`")]
    ];
  }
  const actualLiteral = literalFor(actual);
  const expectedLiteral = literalFor(expected);
  return actualLiteral && expectedLiteral ? [[actualLiteral, expectedLiteral]] : [];
}

function quoteLiteral(value, quote) {
  const escaped = String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(quote, `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

function expectedValueForMissingProperty(root, diagnosis, property) {
  if (truthyAssertionFromDiagnosis(root, diagnosis)) return null;
  const assertion = assertionValuesFromDiagnosis(root, diagnosis);
  if (!assertion || assertion.actual !== undefined || assertion.expected === undefined) return null;
  if (property === "id" && assertion.expected === true) return null;
  return literalFor(assertion.expected);
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function expectedProperty(diagnosis) {
  const intent = diagnosis.fixPlan?.target?.intent || "";
  const backtick = /`([^`]+)`/.exec(intent);
  if (backtick) return backtick[1];
  const error = diagnosis.summary?.mainError || "";
  const property = /\b[a-zA-Z_$][\w$]*\.([a-zA-Z_$][\w$]*)\b/.exec(error);
  if (!property || property[1] === "js") return null;
  return property[1];
}

function addPropertyToReturnObject(selected, property, value, returnObjectIndex, indent) {
  const returnLine = selected[returnObjectIndex];
  if (/\breturn\s*\{[\s\S]*\}\s*;?\s*$/.test(returnLine)) {
    const replacement = [...selected];
    replacement[returnObjectIndex] = returnLine.replace(/\s*\}\s*(;?)\s*$/, (match, semicolon) => {
      const hasExistingProperties = !/\{\s*\}\s*;?\s*$/.test(returnLine);
      const separator = hasExistingProperties ? ", " : " ";
      return `${separator}${property}: ${value} }${semicolon}`;
    });
    return replacement.join("\n");
  }

  const replacement = [...selected];
  replacement.splice(returnObjectIndex + 1, 0, `${indent}${property}: ${value},`);
  return replacement.join("\n");
}

function addPropertyToObjectLiteral(selected, property, value, objectStartIndex) {
  const startLine = selected[objectStartIndex];
  if (/\{[\s\S]*\}\s*[),;]?\s*$/.test(startLine)) {
    const replacement = [...selected];
    replacement[objectStartIndex] = startLine.replace(/\s*\}(\s*[),;]?)\s*$/, (match, suffix) => {
      const hasExistingProperties = !/\{\s*\}\s*[),;]?\s*$/.test(startLine);
      const separator = hasExistingProperties ? ", " : " ";
      return `${separator}${property}: ${value} }${suffix}`;
    });
    return replacement.join("\n");
  }

  const closingIndex = selected.findIndex((line, index) => index > objectStartIndex && /^\s*\}/.test(line));
  if (closingIndex < 0) return null;
  const replacement = [...selected];
  const indent = selected[objectStartIndex + 1]?.match(/^\s*/)?.[0]
    || `${startLine.match(/^\s*/)?.[0] || ""}  `;
  const existingPropertyIndex = findLastObjectPropertyLine(selected, objectStartIndex + 1, closingIndex - 1);
  if (existingPropertyIndex >= 0 && !/,\s*$/.test(replacement[existingPropertyIndex])) {
    replacement[existingPropertyIndex] = `${replacement[existingPropertyIndex]},`;
  }
  replacement.splice(closingIndex, 0, `${indent}${property}: ${value}`);
  return replacement.join("\n");
}

function findLastObjectPropertyLine(selected, start, end) {
  for (let index = end; index >= start; index -= 1) {
    if (selected[index].trim().length > 0) return index;
  }
  return -1;
}

function removePropertyFromSingleReturnObject(selected, property, value) {
  const matches = findReturnObjectMatches(selected);
  if (matches.length !== 1) return null;

  const { start, end } = matches[0];
  if (start === end) {
    const replacement = [...selected];
    replacement[start] = removePropertyFromInlineReturnObject(selected[start], property, value);
    return replacement[start] === selected[start] ? null : replacement.join("\n");
  }

  const matchingIndexes = [];
  for (let index = start + 1; index < end; index += 1) {
    if (lineMatchesPropertyLiteral(selected[index], property, value)) matchingIndexes.push(index);
  }
  if (matchingIndexes.length !== 1) return null;

  const replacement = [...selected];
  replacement.splice(matchingIndexes[0], 1);
  const remainingPropertyIndexes = [];
  for (let index = start + 1; index < end; index += 1) {
    if (index !== matchingIndexes[0] && selected[index].trim().length > 0) remainingPropertyIndexes.push(index);
  }
  const lastRemainingOriginalIndex = remainingPropertyIndexes.at(-1);
  if (lastRemainingOriginalIndex !== undefined) {
    const adjustedIndex = lastRemainingOriginalIndex > matchingIndexes[0] ? lastRemainingOriginalIndex - 1 : lastRemainingOriginalIndex;
    replacement[adjustedIndex] = replacement[adjustedIndex].replace(/,\s*$/, "");
  }
  return replacement.join("\n");
}

function removePropertyFromInlineReturnObject(line, property, value) {
  const match = /\breturn\s*\{([\s\S]*)\}\s*(;?)\s*$/.exec(line);
  if (!match) return line;

  const parsed = parseSimpleInlineObject(match[1]);
  if (!parsed) return line;
  const matchingItems = parsed.items.filter((item) => item.key === property && item.value === value);
  if (matchingItems.length !== 1) return line;

  const kept = parsed.items
    .filter((item) => item !== matchingItems[0])
    .map((item) => item.raw.trim());
  const beforeObject = line.slice(0, line.indexOf("{", match.index) + 1);
  const space = kept.length > 0 ? ` ${kept.join(", ")} ` : " ";
  return `${beforeObject}${space}}${match[2]}`;
}

function parseSimpleInlineObject(content) {
  const items = [];
  let index = 0;
  while (index < content.length) {
    while (/\s|,/.test(content[index] || "")) index += 1;
    if (index >= content.length) break;

    const itemStart = index;
    const keyMatch = /^[A-Za-z_$][\w$]*/.exec(content.slice(index));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    index += key.length;
    while (/\s/.test(content[index] || "")) index += 1;
    if (content[index] !== ":") return null;
    index += 1;
    while (/\s/.test(content[index] || "")) index += 1;

    const valueStart = index;
    index = scanSimpleLiteral(content, index);
    if (index < 0) return null;
    const rawValue = content.slice(valueStart, index).trim();
    const value = literalFor(parseLiteral(rawValue));
    if (!value) return null;

    const raw = content.slice(itemStart, index).trim();
    items.push({ key, raw, value });
    while (/\s/.test(content[index] || "")) index += 1;
    if (index < content.length && content[index] !== ",") return null;
  }
  return { items };
}

function lineMatchesPropertyLiteral(line, property, literal) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(property)}\\s*:\\s*${escapeRegExp(literal)}\\s*,?\\s*$`);
  return pattern.test(line);
}

function appendElementsToSingleReturnArray(selected, elements) {
  const matches = findReturnArrayMatches(selected);
  if (matches.length !== 1) return null;

  const { start, end } = matches[0];
  const returnLine = selected[start];
  if (start === end) {
    const replacement = [...selected];
    replacement[start] = appendElementsToInlineArray(returnLine, elements);
    return replacement[start] === returnLine ? null : replacement.join("\n");
  }

  const closingLine = selected[end];
  const indent = selected[start + 1]?.match(/^\s*/)?.[0]
    || `${returnLine.match(/^\s*/)?.[0] || ""}  `;
  const replacement = [...selected];
  const existingElementLine = selected.slice(start + 1, end).some((line) => line.trim().length > 0);
  if (existingElementLine) {
    const lastElementIndex = findLastArrayElementLine(selected, start + 1, end - 1);
    if (lastElementIndex < 0) return null;
    if (!/,\s*$/.test(replacement[lastElementIndex])) {
      replacement[lastElementIndex] = `${replacement[lastElementIndex]},`;
    }
  }
  replacement.splice(end, 0, ...elements.map((element, index) => {
    const comma = index === elements.length - 1 ? "" : ",";
    return `${indent}${element}${comma}`;
  }));
  if (existingElementLine && !/^\s*\]/.test(closingLine)) return null;
  return replacement.join("\n");
}

function removeTrailingElementsFromSingleReturnArray(selected, elements) {
  const matches = findReturnArrayMatches(selected);
  if (matches.length !== 1) return null;

  const { start, end } = matches[0];
  if (start === end) {
    const replacement = [...selected];
    replacement[start] = removeTrailingElementsFromInlineArray(selected[start], elements);
    return replacement[start] === selected[start] ? null : replacement.join("\n");
  }

  const replacement = [...selected];
  const elementIndexes = [];
  for (let index = start + 1; index < end; index += 1) {
    if (selected[index].trim().length > 0) elementIndexes.push(index);
  }
  if (elementIndexes.length < elements.length) return null;

  const trailingIndexes = elementIndexes.slice(-elements.length);
  for (let i = 0; i < elements.length; i += 1) {
    if (!lineMatchesLiteral(trailingIndexes[i] === undefined ? "" : selected[trailingIndexes[i]], elements[i])) {
      return null;
    }
  }

  for (const index of trailingIndexes.reverse()) {
    replacement.splice(index, 1);
  }
  const previousElementIndex = findLastArrayElementLine(replacement, start + 1, start + elementIndexes.length - elements.length);
  if (previousElementIndex >= 0) {
    replacement[previousElementIndex] = replacement[previousElementIndex].replace(/,\s*$/, "");
  }
  return replacement.join("\n");
}

function replaceElementInSingleReturnArray(selected, from, to) {
  const matches = findReturnArrayMatches(selected);
  if (matches.length !== 1) return null;

  const { start, end } = matches[0];
  if (start === end) {
    const replacement = [...selected];
    replacement[start] = replaceElementInInlineReturnArray(selected[start], from, to);
    return replacement[start] === selected[start] ? null : replacement.join("\n");
  }

  const matchingIndexes = [];
  for (let index = start + 1; index < end; index += 1) {
    if (lineMatchesLiteral(selected[index], from)) matchingIndexes.push(index);
  }
  if (matchingIndexes.length !== 1) return null;

  const replacement = [...selected];
  const targetIndex = matchingIndexes[0];
  const comma = /,\s*$/.test(selected[targetIndex]) ? "," : "";
  replacement[targetIndex] = `${selected[targetIndex].match(/^\s*/)?.[0] || ""}${adaptLiteralStyle(to, selected[targetIndex].trim().replace(/,\s*$/, ""))}${comma}`;
  return replacement.join("\n");
}

function replaceElementInInlineReturnArray(line, from, to) {
  const match = /\breturn\s*\[([\s\S]*)\]\s*(;?)\s*$/.exec(line);
  if (!match) return line;

  const parsed = parseSimpleInlineArray(match[1]);
  if (!parsed) return line;
  const matchingItems = parsed.items.filter((item) => item.value === from);
  if (matchingItems.length !== 1) return line;

  const item = matchingItems[0];
  const content = `${match[1].slice(0, item.start)}${adaptLiteralStyle(to, item.raw.trim())}${match[1].slice(item.end)}`;
  const beforeArray = line.slice(0, line.indexOf("[", match.index) + 1);
  return `${beforeArray}${content}]${match[2]}`;
}

function removeTrailingElementsFromInlineArray(line, elements) {
  const match = /\breturn\s*\[([\s\S]*)\]\s*(;?)\s*$/.exec(line);
  if (!match) return line;

  const parsed = parseSimpleInlineArray(match[1]);
  if (!parsed || parsed.items.length < elements.length) return line;
  const trailing = parsed.items.slice(-elements.length);
  if (!trailing.every((item, index) => literalMatches(item.value, elements[index]))) return line;

  const kept = parsed.items.slice(0, -elements.length).map((item) => item.raw.trim());
  const beforeArray = line.slice(0, line.indexOf("[", match.index) + 1);
  return `${beforeArray}${kept.join(", ")}]${match[2]}`;
}

function parseSimpleInlineArray(content) {
  const items = [];
  let index = 0;
  while (index < content.length) {
    while (/\s|,/.test(content[index] || "")) index += 1;
    if (index >= content.length) break;
    const start = index;
    index = scanSimpleLiteral(content, index);
    if (index < 0) return null;
    const raw = content.slice(start, index).trim();
    if (!raw) return null;
    const value = literalFor(parseLiteral(raw));
    if (!value) return null;
    items.push({ raw, value, start, end: index });
    while (/\s/.test(content[index] || "")) index += 1;
    if (index < content.length && content[index] !== ",") return null;
  }
  return { items };
}

function scanSimpleLiteral(content, index) {
  const quote = content[index];
  if (quote === "\"" || quote === "'" || quote === "`") {
    index += 1;
    while (index < content.length) {
      if (content[index] === "\\") {
        index += 2;
        continue;
      }
      if (content[index] === quote) return index + 1;
      index += 1;
    }
    return -1;
  }
  const start = index;
  while (index < content.length && content[index] !== ",") index += 1;
  const raw = content.slice(start, index).trim();
  if (!/^(?:-?\d+(?:\.\d+)?|true|false|null|undefined)$/.test(raw)) return -1;
  return index;
}

function lineMatchesLiteral(line, literal) {
  return literalMatches(line.trim().replace(/,\s*$/, ""), literal);
}

function literalMatches(candidate, literal) {
  const parsed = literalFor(parseLiteral(candidate));
  return parsed === literal;
}

function appendElementsToInlineArray(line, elements) {
  const match = /\breturn\s*\[([\s\S]*)\]\s*(;?)\s*$/.exec(line);
  if (!match) return line;
  const beforeClose = match[1];
  const prefix = line.slice(0, match.index);
  const returnPrefix = line.slice(match.index, line.indexOf("[", match.index) + 1);
  const suffix = `${match[2]}`;
  const hasExistingElements = beforeClose.trim().length > 0;
  const separator = hasExistingElements ? ", " : "";
  return `${prefix}${returnPrefix}${beforeClose}${separator}${elements.join(", ")}]${suffix}`;
}

function adaptLiteralStyle(literal, existingRaw) {
  if (!/^"(?:\\[\s\S]|[^"\\])*"$/.test(literal)) return literal;
  const quote = existingRaw.trim()[0];
  if (quote !== "'" && quote !== "`") return literal;
  return quoteLiteral(parseLiteral(literal), quote);
}

function findReturnObjectMatches(selected) {
  const matches = [];
  for (let index = 0; index < selected.length; index += 1) {
    const line = selected[index];
    if (!/\breturn\s*\{/.test(line)) continue;
    if (/\}\s*;?\s*$/.test(line)) {
      matches.push({ start: index, end: index });
      continue;
    }
    for (let end = index + 1; end < selected.length; end += 1) {
      if (/^\s*\}\s*;?\s*$/.test(selected[end])) {
        matches.push({ start: index, end });
        index = end;
        break;
      }
    }
  }
  return matches;
}

function findReturnArrayMatches(selected) {
  const matches = [];
  for (let index = 0; index < selected.length; index += 1) {
    const line = selected[index];
    if (!/\breturn\s*\[/.test(line)) continue;
    if (/\]\s*;?\s*$/.test(line)) {
      matches.push({ start: index, end: index });
      continue;
    }
    for (let end = index + 1; end < selected.length; end += 1) {
      if (/^\s*\]\s*;?\s*$/.test(selected[end])) {
        matches.push({ start: index, end });
        index = end;
        break;
      }
    }
  }
  return matches;
}

function findLastArrayElementLine(selected, start, end) {
  for (let index = end; index >= start; index -= 1) {
    if (selected[index].trim().length > 0) return index;
  }
  return -1;
}

function selectedLines(original, range) {
  const lines = original.split(/\r?\n/);
  if (!validRange(range, lines.length)) return null;
  return lines.slice(range.start - 1, range.end);
}

function validRange(range, totalLines) {
  return range.start >= 1 && range.end >= range.start && range.end <= totalLines;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
