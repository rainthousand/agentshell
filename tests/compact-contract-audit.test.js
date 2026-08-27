import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { applyCompactBudget } from "../src/core/compact-budget.js";
import { HELP_COMMANDS } from "../src/core/command-registry.js";
import {
  auditCompactValue,
  REPRESENTATIVE_COMPACT_COMMANDS,
  runCompactContractAudit
} from "../scripts/compact-contract-audit.js";
import { matchesHelpCommand } from "../scripts/command-contract-audit.js";

const budget = { maxChars: 1_200, maxEstimatedTokens: 300, maxArrayItems: 3, maxStringChars: 100 };

test("compact audit reports oversized paths and contract issues", () => {
  const report = runCompactContractAudit({
    budget,
    fixtures: [
      {
        name: "healthy",
        value: compactFixture({ items: [1, 2] })
      },
      {
        name: "oversized",
        value: compactFixture({ items: [1, 2, 3, 4], detail: "x".repeat(150) })
      },
      {
        name: "not-compact",
        value: { ok: true, protocolVersion: "agentshell.fixture.v1", summary: {} }
      }
    ]
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.summary, {
    checked: 3,
    passed: 1,
    failed: 2,
    oversizedPathCount: 2,
    contractIssueCount: 1
  });
  assert.ok(report.oversizedPaths.some((entry) => entry.command === "oversized" && entry.path === "$.items"));
  assert.ok(report.oversizedPaths.some((entry) => entry.command === "oversized" && entry.path === "$.detail"));
  assert.deepEqual(report.checks[2].contractIssues, ["$.compact must be true"]);
});

test("enforced fixtures pass the compact contract audit", () => {
  const value = applyCompactBudget(compactFixture({
    items: Array.from({ length: 50 }, (_, index) => ({ index, text: "x".repeat(200) }))
  }), budget);
  const check = auditCompactValue("bounded", value, { budget });

  assert.equal(check.ok, true);
  assert.deepEqual(check.oversizedPaths, []);
  assert.deepEqual(check.contractIssues, []);
});

test("compact budget schema exposes limits, metadata, and audit paths", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/compact-budget.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Compact Output Budget Contract");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.compact-contract-audit.v1");
  assert.deepEqual(schema.$defs.compactBudget.required, [
    "version", "limits", "original", "output", "truncated", "omitted", "oversizedPaths", "oversizedPathCount"
  ]);
  assert.equal(schema.$defs.compactBudget.properties.oversizedPaths.maxItems, 20);
});

test("representative compact audit commands remain in the public command contract", () => {
  for (const command of REPRESENTATIVE_COMPACT_COMMANDS) {
    assert.equal(matchesHelpCommand(`agentshell ${command.args.join(" ")}`, HELP_COMMANDS), true, command.name);
  }
});

function compactFixture(extra = {}) {
  return {
    ok: true,
    protocolVersion: "agentshell.fixture.v1",
    compact: true,
    summary: { status: "ok" },
    ...extra
  };
}
