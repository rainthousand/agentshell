import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { HELP_COMMANDS, SCHEMA_NAMES } from "../src/core/command-registry.js";

test("command registry keeps unique help and schema entries", () => {
  assert.equal(new Set(HELP_COMMANDS).size, HELP_COMMANDS.length);
  assert.equal(new Set(SCHEMA_NAMES).size, SCHEMA_NAMES.length);
  assert.ok(HELP_COMMANDS.every((entry) => entry.startsWith("agentshell ")));
});

test("every registered schema exists", () => {
  for (const name of SCHEMA_NAMES) {
    assert.equal(fs.existsSync(path.join(process.cwd(), "schemas", `${name}.schema.json`)), true, name);
  }
});
