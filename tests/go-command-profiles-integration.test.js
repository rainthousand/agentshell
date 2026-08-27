import test from "node:test";
import assert from "node:assert/strict";

import {
  GO_COMMAND_PROFILES,
  classifyGoCommandProfile,
  summarizeGoCommandProfile
} from "../src/core/go-command-profiles.js";
import {
  applyHighNoiseSafeDefaults,
  classifyHighNoiseCommand,
  listHighNoiseProfiles,
  summarizeHighNoiseOutput
} from "../src/core/high-noise-profiles.js";

const EXPECTED = [
  ["go-run", ["go", "run", "."]],
  ["go-list", ["go", "list", "./..."]],
  ["go-env", ["go", "env", "GOMOD"]],
  ["go-get", ["go", "get", "example.com/mod@latest"]],
  ["go-install", ["go", "install", "example.com/tool@latest"]],
  ["go-mod-download", ["go", "mod", "download"]],
  ["go-mod-graph", ["go", "mod", "graph"]],
  ["go-mod-why", ["go", "mod", "why", "example.com/mod"]],
  ["go-tool-cover", ["go", "tool", "cover", "-func=coverage.out"]],
  ["go-tool-pprof", ["go", "tool", "pprof", "cpu.pprof"]],
  ["govulncheck", ["govulncheck", "./..."]],
  ["staticcheck", ["staticcheck", "./..."]],
  ["golangci-lint-run", ["golangci-lint", "run"]],
  ["dlv", ["dlv", "test", "."]],
  ["mockgen", ["mockgen", "example.com/api", "Client"]],
  ["wire", ["wire", "./..."]]
];

test("all Go command profiles are exposed through generic exec classification", () => {
  assert.equal(GO_COMMAND_PROFILES.length, EXPECTED.length);
  for (const [id, argv] of EXPECTED) {
    assert.equal(classifyGoCommandProfile(argv)?.id, id, id);
    assert.equal(classifyHighNoiseCommand(argv)?.id, id, id);
  }
  assert.equal(new Set(listHighNoiseProfiles().map((profile) => profile.id)).size, listHighNoiseProfiles().length);
});

test("Go defaults are inserted before operands and remain idempotent", () => {
  const pprof = applyHighNoiseSafeDefaults(["go", "tool", "pprof", "cpu.pprof"]);
  assert.deepEqual(pprof.argv, ["go", "tool", "pprof", "-top", "-nodecount=10", "cpu.pprof"]);
  assert.deepEqual(applyHighNoiseSafeDefaults(pprof.argv, pprof.profile).argv, pprof.argv);

  const staticcheck = applyHighNoiseSafeDefaults(["staticcheck", "./..."]);
  assert.deepEqual(staticcheck.argv, ["staticcheck", "-f", "text", "./..."]);

  const explicitPprof = applyHighNoiseSafeDefaults(["go", "tool", "pprof", "-http=:0", "cpu.pprof"]);
  assert.equal(explicitPprof.argv.includes("-top"), false);
  assert.equal(explicitPprof.profile.risk.interactive, true);
});

test("risk classification follows mutating and interactive Go variants", () => {
  assert.equal(classifyGoCommandProfile(["go", "env", "GOMOD"]).risk.level, "low");
  assert.equal(classifyGoCommandProfile(["go", "env", "-w", "GOPROXY=direct"]).risk.level, "high");
  assert.equal(classifyGoCommandProfile(["go", "get", "example.com/mod"]).risk.mutatesWorkspace, true);
  assert.equal(classifyGoCommandProfile(["mockgen", "example.com/api", "Client"]).risk.mutatesWorkspace, true);
});

test("specialized Go summaries normalize into the shared bounded contract", () => {
  const quality = summarizeHighNoiseOutput(
    "staticcheck",
    "internal/app.go:12:4: unused value (SA4006)",
    { exitCode: 1 }
  );
  assert.equal(quality.profileId, "staticcheck");
  assert.equal(quality.status, "failed");
  assert.equal(quality.failures[0].code, "SA4006");
  assert.deepEqual(quality.locations[0], { file: "internal/app.go", line: 12, column: 4 });
  assert.equal(quality.failures.length <= 8, true);

  const direct = summarizeGoCommandProfile("go-env", "GOMOD=/private/repo/go.mod\nGOPATH=/private/home/go", { exitCode: 0 });
  assert.equal(direct.status, "passed");
  assert.equal(JSON.stringify(direct).includes("/private/repo"), false);
});
