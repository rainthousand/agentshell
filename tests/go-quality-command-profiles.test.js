import test from "node:test";
import assert from "node:assert/strict";

import {
  GO_QUALITY_COMMAND_PROFILES,
  summarizeGoQualityCommand
} from "../src/core/go-quality-command-profiles.js";

test("Go quality profiles expose stable commands, defaults, and explicit risk", () => {
  assert.deepEqual(GO_QUALITY_COMMAND_PROFILES.map((profile) => profile.id), [
    "govulncheck",
    "staticcheck",
    "golangci-lint-run"
  ]);

  for (const profile of GO_QUALITY_COMMAND_PROFILES) {
    assert.equal(typeof profile.category, "string");
    assert.ok(profile.prefix.length > 0);
    assert.ok(Array.isArray(profile.defaults));
    assert.deepEqual(profile.successExitCodes, [0]);
    assert.equal(typeof profile.next, "string");
    assert.equal(typeof profile.summaryKind, "string");
    assert.deepEqual(Object.keys(profile.risk).sort(), [
      "interactive", "level", "mutatesWorkspace", "network"
    ]);
    assert.equal(profile.risk.mutatesWorkspace, false);
    assert.equal(profile.risk.interactive, false);
  }

  assert.deepEqual(GO_QUALITY_COMMAND_PROFILES[0].defaults, ["-format=json"]);
  assert.deepEqual(GO_QUALITY_COMMAND_PROFILES[1].defaults, ["-f", "text"]);
  assert.deepEqual(GO_QUALITY_COMMAND_PROFILES[2].defaults, []);
  assert.equal(GO_QUALITY_COMMAND_PROFILES[0].risk.network, true);
});

test("govulncheck summarizes JSON stream vulnerabilities with source locations", () => {
  const output = [
    JSON.stringify({ osv: { id: "GO-2024-1234", summary: "Unsafe request handling" } }),
    JSON.stringify({ finding: {
      osv: "GO-2024-1234",
      trace: [{ function: "example.com/app.Handle", position: {
        filename: "internal/http/handler.go", line: 42, column: 7
      } }]
    } }),
    JSON.stringify({ finding: {
      osv: "GO-2024-1234",
      trace: [{ function: "example.com/app.Handle", position: {
        filename: "internal/http/handler.go", line: 42, column: 7
      } }]
    } })
  ].join("\n");

  const summary = summarizeGoQualityCommand("govulncheck", output, { exitCode: 3 });
  assert.equal(summary.status, "findings");
  assert.equal(summary.mainError, "Unsafe request handling");
  assert.equal(summary.counts.vulnerabilities, 1);
  assert.deepEqual(summary.failures, [{
    message: "Unsafe request handling",
    code: "GO-2024-1234",
    location: { file: "internal/http/handler.go", line: 42, column: 7 }
  }]);
  assert.deepEqual(summary.locations, [
    { file: "internal/http/handler.go", line: 42, column: 7 }
  ]);
  assert.equal(summary.truncated, false);
});

test("govulncheck supports bounded legacy text output", () => {
  const summary = summarizeGoQualityCommand("govulncheck", [
    "Vulnerability #1: GO-2023-9999 Example vulnerability",
    "Trace:",
    "  #1: call at pkg/service.go:19:4",
    "More info: https://pkg.go.dev/vuln/GO-2023-9999"
  ].join("\n"), { exitCode: 3 });

  assert.equal(summary.counts.vulnerabilities, 1);
  assert.equal(summary.failures[0].code, "GO-2023-9999");
  assert.deepEqual(summary.failures[0].location, {
    file: "pkg/service.go", line: 19, column: 4
  });
});

test("staticcheck extracts diagnostics, codes, and line locations", () => {
  const summary = summarizeGoQualityCommand("staticcheck", [
    "pkg/cache.go:12:5: should use time.Since instead of time.Now().Sub (S1012)",
    "pkg/cache.go:12:5: should use time.Since instead of time.Now().Sub (S1012)",
    "cmd/api/main.go:8:2: ineffective assignment to err (SA4006)"
  ].join("\n"), { exitCode: 1 });

  assert.equal(summary.status, "findings");
  assert.equal(summary.counts.diagnostics, 2);
  assert.equal(summary.failures[0].code, "S1012");
  assert.deepEqual(summary.locations[1], {
    file: "cmd/api/main.go", line: 8, column: 2
  });
});

test("golangci-lint extracts common line output and linter issue counts", () => {
  const summary = summarizeGoQualityCommand("golangci-lint-run", [
    "internal/api/api.go:21:10: Error return value is not checked (errcheck)",
    "internal/api/api.go:35: declaration of var ctx shadows declaration at line 12 (govet)",
    "2 issues:"
  ].join("\n"), { exitCode: 1 });

  assert.equal(summary.counts.issues, 2);
  assert.deepEqual(summary.failures.map((entry) => entry.code), ["errcheck", "govet"]);
  assert.equal(summary.failures[1].location.column, null);
});

test("successful and failed no-finding runs have stable status and fallback error", () => {
  const passed = summarizeGoQualityCommand("staticcheck", "", { exitCode: 0 });
  assert.equal(passed.status, "passed");
  assert.equal(passed.mainError, null);

  const failed = summarizeGoQualityCommand("golangci-lint-run", "configuration is invalid", {
    exitCode: 4
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.mainError, "configuration is invalid");
  assert.deepEqual(failed.failures[0], {
    message: "configuration is invalid", code: null, location: null
  });
  assert.equal(summarizeGoQualityCommand("missing", "", { exitCode: 0 }), null);
});

test("summaries bound and deduplicate untrusted tool output", () => {
  const lines = Array.from({ length: 30 }, (_, index) =>
    `pkg/file${index}.go:${index + 1}:1: ${"x".repeat(400)} (lint${index})`
  );
  const summary = summarizeGoQualityCommand("golangci-lint-run", lines.join("\n"), {
    exitCode: 1
  });

  assert.equal(summary.failures.length, 12);
  assert.equal(summary.locations.length, 12);
  assert.equal(summary.truncated, true);
  assert.ok(summary.failures.every((entry) => entry.message.length <= 240));
  assert.ok(JSON.stringify(summary).length < 12_000);

  const oversized = summarizeGoQualityCommand(
    "staticcheck",
    `${"noise\n".repeat(60_000)}pkg/final.go:1:1: finding (S1000)`,
    { exitCode: 1 }
  );
  assert.equal(oversized.truncated, true);
});
