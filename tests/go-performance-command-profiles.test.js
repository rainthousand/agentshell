import test from "node:test";
import assert from "node:assert/strict";

import {
  GO_PERFORMANCE_COMMAND_PROFILES,
  summarizeGoPerformanceCommand
} from "../src/core/go-performance-command-profiles.js";

test("exports bounded cover and non-interactive pprof profiles", () => {
  assert.equal(GO_PERFORMANCE_COMMAND_PROFILES.length, 2);
  for (const profile of GO_PERFORMANCE_COMMAND_PROFILES) {
    assert.deepEqual(Object.keys(profile), [
      "id", "category", "prefix", "defaults", "successExitCodes", "next", "summaryKind", "risk"
    ]);
    assert.deepEqual(profile.risk, {
      level: "low", mutatesWorkspace: false, network: false, interactive: false
    });
  }

  const pprof = GO_PERFORMANCE_COMMAND_PROFILES.find((profile) => profile.id === "go-tool-pprof");
  assert.deepEqual(pprof.prefix, ["go", "tool", "pprof"]);
  assert.ok(pprof.defaults.includes("-top"));
  assert.ok(pprof.defaults.some((value) => value.startsWith("-nodecount=")));
  assert.doesNotMatch(pprof.defaults.join(" "), /-http|interactive/i);
});

test("summarizes go tool cover totals and bounded function coverage", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    `example.com/app/file${index}.go:${index + 10}: Function${index} ${index}.5%`
  );
  const result = summarizeGoPerformanceCommand(
    "go-tool-cover",
    `${rows.join("\n")}\ntotal: (statements) 82.4%\n`,
    { exitCode: 0 }
  );

  assert.equal(result.status, "passed");
  assert.equal(result.details.coverage.totalPercent, 82.4);
  assert.equal(result.details.coverage.functions.length, 12);
  assert.deepEqual(result.details.coverage.functions[0], {
    file: "example.com/app/file0.go",
    line: 10,
    function: "Function0",
    percent: 0.5
  });
  assert.equal(result.counts.detectedFunctions, 20);
  assert.equal(result.truncated, true);
});

test("extracts the hottest functions from pprof text output", () => {
  const output = `
Showing nodes accounting for 1.80s, 90% of 2s total
      flat  flat%   sum%        cum   cum%
     0.80s 40.00% 40.00%      1.20s 60.00%  runtime.scanobject
     0.50s 25.00% 65.00%      0.50s 25.00%  crypto/sha256.block
     0.30s 15.00% 80.00%      0.80s 40.00%  main.processBatch
`;
  const result = summarizeGoPerformanceCommand("go-tool-pprof", output, { exitCode: 0 });

  assert.equal(result.status, "passed");
  assert.equal(result.details.hotFunctions.length, 3);
  assert.deepEqual(result.details.hotFunctions[0], {
    flat: "0.80s",
    flatPercent: 40,
    cumulativePercent: 40,
    cumulative: "1.20s",
    cumulativeSharePercent: 60,
    function: "runtime.scanobject"
  });
  assert.equal(result.details.coverage, null);
});

test("reports bounded failures without leaking unlimited command output", () => {
  const output = Array.from({ length: 30 }, (_, index) =>
    `error: profile ${index} cannot be opened because ${"x".repeat(300)}`
  ).join("\n");
  const result = summarizeGoPerformanceCommand("go-tool-pprof", output, { exitCode: 1 });

  assert.equal(result.status, "failed");
  assert.equal(result.failures.length, 8);
  assert.equal(result.mainError, result.failures[0].message);
  assert.ok(result.failures.every((failure) => failure.message.length <= 240));
  assert.ok(result.failures.every((failure) => Object.hasOwn(failure, "code") && Object.hasOwn(failure, "location")));
  assert.equal(result.truncated, true);
});

test("bounds oversized input and keeps both ends available for diagnostics", () => {
  const noise = "noise\n".repeat(60000);
  const result = summarizeGoPerformanceCommand("go-tool-cover", {
    stdout: `error: first failure\n${noise}`,
    stderr: "fatal: last failure\n"
  }, { exitCode: 1 });

  assert.equal(result.status, "failed");
  assert.equal(result.truncated, true);
  assert.ok(result.failures.some((failure) => failure.message.includes("first failure")));
  assert.ok(result.failures.some((failure) => failure.message.includes("last failure")));
});

test("unknown profiles and missing exit status stay explicit", () => {
  assert.equal(summarizeGoPerformanceCommand("unknown", "output", { exitCode: 0 }), null);
  const result = summarizeGoPerformanceCommand("go-tool-cover", "total: (statements) 100.0%");
  assert.equal(result.status, "unknown");
  assert.equal(result.exitCode, null);
});

test("normalizes error locations to the shared failure contract", () => {
  const result = summarizeGoPerformanceCommand(
    "go-tool-cover",
    "src/worker.go:42:7: error: malformed coverage profile",
    { exitCode: 1 }
  );

  assert.deepEqual(result.failures[0], {
    message: "src/worker.go:42:7: error: malformed coverage profile",
    code: "error",
    location: { file: "src/worker.go", line: 42, column: 7 }
  });
  assert.deepEqual(result.locations, [{ file: "src/worker.go", line: 42, column: 7 }]);
});

test("uses bounded native output as the fallback error on unexplained failure", () => {
  const result = summarizeGoPerformanceCommand(
    "go-tool-pprof",
    `profile could not be decoded ${"x".repeat(300)}`,
    { exitCode: 2 }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failures.length, 1);
  assert.equal(result.mainError, result.failures[0].message);
  assert.equal(result.mainError.length, 240);
});
