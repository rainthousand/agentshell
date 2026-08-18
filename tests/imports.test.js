import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { imports, parseImportsOptions, summarizeImports } from "../src/commands/imports.js";

test("imports summarizes TypeScript import and export dependencies without source text", async () => {
  const root = makeFixture({
    "src/sample.ts": [
      "import React, { useMemo, type ReactNode as Node } from 'react';",
      "import type { Readable } from 'node:stream';",
      "import './setup';",
      "export { thing as renamed } from '../thing';",
      "export type { Shape } from './types';",
      "const hidden = 'do not leak';"
    ].join("\n")
  });

  const result = await imports(root, "src/sample.ts", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.imports.v1");
  assert.equal(result.compact, true);
  assert.equal(result.file, "src/sample.ts");
  assert.equal(result.language, "typescript");
  assert.equal(result.summary.importCount, 5);
  assert.equal(result.summary.returnedImports, 5);
  assert.equal(result.summary.omittedImports, 0);
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.byKind.type, 2);
  assert.equal(result.summary.byKind["side-effect"], 1);
  assert.equal(result.summary.builtinCount, 1);
  assert.equal(result.summary.externalCount, 1);
  assert.equal(result.summary.relativeCount, 3);
  assert.ok(result.imports.some((entry) => entry.source === "react" && entry.external));
  assert.ok(result.imports.some((entry) => entry.source === "node:stream" && entry.builtin));
  assert.ok(result.imports.some((entry) => entry.source === "./setup" && entry.type.kind === "side-effect"));
  assert.ok(result.imports.some((entry) => entry.source === "./types" && entry.type.kind === "type"));
  assert.ok(!JSON.stringify(result).includes("do not leak"));
});

test("imports summarizes JavaScript require and dynamic import dependencies", async () => {
  const root = makeFixture({
    "index.cjs": [
      "const fs = require('node:fs');",
      "const pkg = require('left-pad');",
      "async function load() { return import('./lazy.js'); }"
    ].join("\n")
  });

  const result = await imports(root, "index.cjs", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.language, "javascript");
  assert.equal(result.summary.importCount, 3);
  assert.equal(result.summary.byKind.runtime, 2);
  assert.equal(result.summary.byKind.dynamic, 1);
  assert.ok(result.imports.some((entry) => entry.source === "node:fs" && entry.builtin));
  assert.ok(result.imports.some((entry) => entry.source === "left-pad" && entry.external));
  assert.ok(result.imports.some((entry) => entry.source === "./lazy.js" && entry.relative && entry.type.kind === "dynamic"));
});

test("imports summarizes Go single and block imports", async () => {
  const root = makeFixture({
    "main.go": [
      "package main",
      "import \"fmt\"",
      "import (",
      "  \"strings\"",
      "  jsoniter \"github.com/json-iterator/go\"",
      "  _ \"example.com/project/register\"",
      ")",
      "func main() { fmt.Println(strings.TrimSpace(\" ok \")) }"
    ].join("\n")
  });

  const result = await imports(root, "main.go", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.language, "go");
  assert.equal(result.summary.importCount, 4);
  assert.equal(result.summary.byKind.go, 3);
  assert.equal(result.summary.byKind["side-effect"], 1);
  assert.equal(result.summary.builtinCount, 2);
  assert.equal(result.summary.externalCount, 2);
  assert.ok(result.imports.some((entry) => entry.source === "github.com/json-iterator/go" && entry.specifiers.includes("jsoniter")));
  assert.ok(result.imports.some((entry) => entry.source === "example.com/project/register" && entry.type.kind === "side-effect"));
});

test("imports reports missing arg, outside root, missing path, and unsupported file errors", async () => {
  const root = makeFixture({
    "README.md": "# nope\n"
  });

  const missingArg = parseImportsOptions(undefined, { compact: true });
  const outsideRoot = await imports(root, "../outside.js", { compact: true });
  const missingPath = await imports(root, "missing.js", { compact: true });
  const unsupported = await imports(root, "README.md", { compact: true });

  assert.equal(missingArg.ok, false);
  assert.equal(missingArg.error.code, "INVALID_ARGUMENT");
  assert.equal(outsideRoot.ok, false);
  assert.equal(outsideRoot.error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(missingPath.ok, false);
  assert.equal(missingPath.error.code, "FILE_NOT_FOUND");
  assert.deepEqual(missingPath.error.details, { path: "missing.js", exists: false });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "UNSUPPORTED_FILE");
});

test("imports truncates compact output while preserving total import summary", async () => {
  const lines = [];
  for (let index = 0; index < 45; index += 1) {
    lines.push(`import value${index} from './dep-${index}.js';`);
  }
  const root = makeFixture({
    "src/many.ts": lines.join("\n")
  });

  const compact = await imports(root, "src/many.ts", { compact: true });
  const full = await imports(root, "src/many.ts", { compact: false });

  assert.equal(compact.ok, true);
  assert.equal(compact.summary.importCount, 45);
  assert.equal(compact.summary.returnedImports, 25);
  assert.equal(compact.summary.omittedImports, 20);
  assert.equal(compact.summary.truncated, true);
  assert.equal(compact.imports.length, 25);
  assert.equal(full.summary.returnedImports, 45);
  assert.equal(full.summary.truncated, false);
});

test("imports schema exposes the compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/imports.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Imports Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.imports.v1");
  assert.ok(schema.oneOf[0].required.includes("summary"));
  assert.ok(schema.oneOf[0].required.includes("imports"));
  assert.ok(schema.$defs.summary.required.includes("returnedImports"));
  assert.ok(schema.$defs.summary.required.includes("truncated"));
  assert.deepEqual(schema.$defs.importEntry.properties.type.properties.kind.enum, ["runtime", "type", "side-effect", "dynamic", "go"]);
});

test("summarizeImports returns an empty list for unsupported languages", () => {
  assert.deepEqual(summarizeImports("import nope from 'x';", "markdown"), []);
});

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-imports-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}
