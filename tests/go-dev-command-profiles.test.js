import test from "node:test";
import assert from "node:assert/strict";

import {
  GO_DEV_COMMAND_PROFILES,
  summarizeGoDevCommand
} from "../src/core/go-dev-command-profiles.js";

test("exports explicit risk metadata without implicit command mutation", () => {
  assert.deepEqual(GO_DEV_COMMAND_PROFILES.map((profile) => profile.id), ["dlv", "mockgen", "wire"]);
  for (const profile of GO_DEV_COMMAND_PROFILES) {
    assert.deepEqual(Object.keys(profile), [
      "id", "category", "prefix", "defaults", "successExitCodes", "next", "summaryKind",
      "interactive", "mutatesWorkspace", "risk"
    ]);
    assert.deepEqual(profile.defaults, []);
    assert.deepEqual(profile.successExitCodes, [0]);
    assert.equal(typeof profile.interactive, "boolean");
    assert.equal(typeof profile.mutatesWorkspace, "boolean");
    assert.deepEqual(Object.keys(profile.risk), ["level", "mutatesWorkspace", "network", "interactive"]);
  }

  const dlv = GO_DEV_COMMAND_PROFILES[0];
  assert.equal(dlv.interactive, true);
  assert.equal(dlv.mutatesWorkspace, false);
  assert.deepEqual(dlv.risk, {
    level: "high",
    mutatesWorkspace: false,
    network: true,
    interactive: true
  });
  assert.equal(dlv.defaults.some((entry) => String(entry).includes("accept-multiclient")), false);
  assert.equal(GO_DEV_COMMAND_PROFILES[1].mutatesWorkspace, true);
  assert.equal(GO_DEV_COMMAND_PROFILES[2].mutatesWorkspace, true);
});

test("summarizes dlv listening and process exit without inventing execution", () => {
  const summary = summarizeGoDevCommand("dlv", [
    "API server listening at: 127.0.0.1:43219",
    "2026-08-24T12:00:00Z warning layer=rpc Listening for remote connections",
    "Process 1234 has exited with status 0"
  ].join("\n"), { exitCode: 0 });

  assert.equal(summary.status, "passed");
  assert.equal(summary.details.listeningAddress, "127.0.0.1:43219");
  assert.equal(summary.details.processExit, 0);
  assert.equal(summary.interactive, true);
  assert.equal(summary.mutatesWorkspace, false);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.mainError, null);
  assert.equal(summary.suggestedNextActions.length, 1);
});

test("extracts bounded dlv errors and source locations", () => {
  const lines = Array.from({ length: 20 }, (_, index) =>
    `dlv: internal/service_${index}.go:${index + 1}:2: error: breakpoint failure ${index}`
  );
  const summary = summarizeGoDevCommand("dlv", lines.join("\n"), { exitCode: 1 });

  assert.equal(summary.status, "failed");
  assert.equal(summary.failures.length, 8);
  assert.equal(summary.locations.length, 8);
  assert.equal(summary.counts.detectedFailures, 20);
  assert.equal(summary.truncated, true);
  assert.equal(summary.failures.every((failure) => failure.message.length <= 240), true);
  assert.deepEqual(summary.failures[0].location, {
    file: "internal/service_0.go",
    line: 1,
    column: 2
  });
  assert.equal(summary.failures.every((failure) => Object.hasOwn(failure, "code")), true);
});

test("summarizes mockgen generated files and compiler-style errors", () => {
  const summary = summarizeGoDevCommand("mockgen", {
    stdout: "generated internal/mocks/store_mock.go",
    stderr: "internal/store/store.go:14:2: error: undefined: Repository"
  }, { exitCode: 1 });

  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.details.generatedFiles, ["internal/mocks/store_mock.go"]);
  assert.deepEqual(summary.locations, [{ file: "internal/store/store.go", line: 14, column: 2 }]);
  assert.match(summary.failures[0].message, /undefined: Repository/);
  assert.equal(summary.mutatesWorkspace, true);
});

test("summarizes wire output files, failures, and locations", () => {
  const summary = summarizeGoDevCommand("wire", [
    "wire: example.com/app/internal/di: wrote /tmp/app/internal/di/wire_gen.go",
    "wire: internal/di/wire.go:23:7: no provider found for example.com/app/Store",
    "wire: generate failed"
  ].join("\n"), { exitCode: 1 });

  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.details.generatedFiles, ["/tmp/app/internal/di/wire_gen.go"]);
  assert.deepEqual(summary.locations, [{ file: "internal/di/wire.go", line: 23, column: 7 }]);
  assert.ok(summary.failures.some((failure) => /generate failed/.test(failure.message)));
});

test("captures both ends of oversized output and reports truncation", () => {
  const summary = summarizeGoDevCommand("mockgen", {
    stdout: `generated first_mock.go\n${"noise\n".repeat(60000)}`,
    stderr: "last.go:9:3: fatal: final generation error"
  }, { exitCode: 1 });

  assert.equal(summary.truncated, true);
  assert.ok(summary.details.generatedFiles.includes("first_mock.go"));
  assert.ok(summary.failures.some((failure) => failure.message.includes("final generation error")));
  assert.ok(summary.locations.some((location) => location.file === "last.go" && location.line === 9));
});

test("keeps unknown profiles and missing exit codes explicit", () => {
  assert.equal(summarizeGoDevCommand("go-run", "ok", { exitCode: 0 }), null);
  assert.equal(summarizeGoDevCommand("wire", "wire: example.com/app: wrote wire_gen.go").status, "unknown");
});
