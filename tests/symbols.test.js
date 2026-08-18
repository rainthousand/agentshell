import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { symbols } from "../src/commands/symbols.js";

test("symbols returns a compact TypeScript symbol summary without source bodies", async () => {
  const root = makeFixture({
    "src/example.ts": [
      "export function makeThing(input: string) {",
      "  return input.toUpperCase();",
      "}",
      "function helper() { return 1; }",
      "export class Widget {",
      "  render() { return null; }",
      "}",
      "export interface WidgetProps { name: string }",
      "type LocalAlias = string | number;",
      "export enum Mode { Fast, Slow }",
      "export const VALUE = 42;",
      "export default function main() {",
      "  return makeThing('x');",
      "}"
    ].join("\n")
  });

  const result = await symbols(root, "src/example.ts", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.symbols.v1");
  assert.equal(result.compact, true);
  assert.equal(result.file, "src/example.ts");
  assert.equal(result.language, "typescript");
  assert.equal(result.summary.totalSymbols, 8);
  assert.equal(result.summary.exportedSymbols, 6);
  assert.equal(result.summary.truncated, false);
  assert.deepEqual(
    result.symbols.map((entry) => [entry.kind, entry.name, entry.exported]),
    [
      ["function", "makeThing", true],
      ["function", "helper", false],
      ["class", "Widget", true],
      ["interface", "WidgetProps", true],
      ["type", "LocalAlias", false],
      ["enum", "Mode", true],
      ["const", "VALUE", true],
      ["default", "main", true]
    ]
  );
  assert.ok(result.symbols.every((entry) => !entry.signature.includes("return input")));
  assert.ok(result.suggestedNextActions[0].command.includes("agentshell read src/example.ts --lines 1:1"));
});

test("symbols returns Go funcs, methods, types, consts, vars, and exported markers", async () => {
  const root = makeFixture({
    "pkg/example.go": [
      "package pkg",
      "",
      "const Pi = 3.14",
      "var localCounter int",
      "type Service struct{}",
      "type localType string",
      "func NewService() *Service { return &Service{} }",
      "func helper() {}",
      "func (s *Service) Serve(ctx context.Context) error { return nil }",
      "func (s *Service) private() {}",
      "const (",
      "  Grouped = 1",
      "  groupedLocal = 2",
      ")"
    ].join("\n")
  });

  const result = await symbols(root, "pkg/example.go", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.language, "go");
  assert.equal(result.summary.totalSymbols, 10);
  assert.equal(result.summary.countsByKind.func, 2);
  assert.equal(result.summary.countsByKind.method, 2);
  assert.equal(result.summary.countsByKind.const, 3);
  assert.equal(result.symbols.find((entry) => entry.name === "NewService").exported, true);
  assert.equal(result.symbols.find((entry) => entry.name === "helper").exported, false);
  assert.equal(result.symbols.find((entry) => entry.name === "Serve").receiver, "s *Service");
  assert.equal(result.symbols.find((entry) => entry.name === "groupedLocal").exported, false);
});

test("symbols defaults compact output to 80 symbols and reports truncation", async () => {
  const declarations = Array.from({ length: 85 }, (_, index) => `export const value${index} = ${index};`);
  const root = makeFixture({
    "src/many.ts": declarations.join("\n")
  });

  const result = await symbols(root, "src/many.ts", {});

  assert.equal(result.ok, true);
  assert.equal(result.compact, true);
  assert.equal(result.symbols.length, 80);
  assert.equal(result.summary.totalSymbols, 85);
  assert.equal(result.summary.returnedSymbols, 80);
  assert.equal(result.summary.omittedSymbols, 5);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.truncated.value, true);
  assert.equal(result.truncated.omittedSymbols, 5);
});

test("symbols handles missing input, outside paths, missing files, and unsupported files", async () => {
  const root = makeFixture({
    "README.md": "# docs\n"
  });

  assert.equal((await symbols(root)).error.code, "INVALID_ARGUMENT");
  assert.equal((await symbols(root, "../outside.ts")).error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal((await symbols(root, "src/missing.ts")).error.code, "FILE_NOT_FOUND");
  assert.equal((await symbols(root, "README.md")).error.code, "UNSUPPORTED_LANGUAGE");
});

test("symbols exposes a parseable JSON schema contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/symbols.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Symbols Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.symbols.v1");
  assert.ok(schema.oneOf[0].required.includes("suggestedNextActions"));
  assert.ok(schema.oneOf[0].required.includes("symbols"));
  assert.ok(schema.$defs.symbol.required.includes("exported"));
  assert.ok(schema.$defs.symbol.properties.kind.enum.includes("method"));
});

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-symbols-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}
