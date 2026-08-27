import test from "node:test";
import assert from "node:assert/strict";

import {
  GO_QUERY_COMMAND_PROFILES,
  summarizeGoQueryCommand
} from "../src/core/go-query-command-profiles.js";

test("describes all Go query and dependency commands without semantic defaults", () => {
  assert.deepEqual(GO_QUERY_COMMAND_PROFILES.map((profile) => profile.id), [
    "go-run", "go-list", "go-env", "go-get", "go-install",
    "go-mod-download", "go-mod-graph", "go-mod-why"
  ]);
  assert.equal(GO_QUERY_COMMAND_PROFILES.every((profile) => profile.prefix[0] === "go"), true);
  assert.equal(GO_QUERY_COMMAND_PROFILES.every((profile) => profile.defaults.length === 0), true);
  assert.equal(GO_QUERY_COMMAND_PROFILES.every((profile) => profile.outputLimitBytes === 256 * 1024), true);
  assert.deepEqual(GO_QUERY_COMMAND_PROFILES.find((profile) => profile.id === "go-get").risk, {
    level: "high", mutatesWorkspace: true, network: true, interactive: false
  });
  assert.deepEqual(GO_QUERY_COMMAND_PROFILES.find((profile) => profile.id === "go-install").risk, {
    level: "medium", mutatesWorkspace: false, network: true, interactive: false
  });
  assert.equal(GO_QUERY_COMMAND_PROFILES.find((profile) => profile.id === "go-run").risk.interactive, true);
});

test("summarizes package output from text and JSON", () => {
  const text = summarizeGoQueryCommand("go-list", "example.com/app/cmd\nexample.com/app/internal/store\n", { exitCode: 0 });
  assert.deepEqual(text.details.packages, ["example.com/app/cmd", "example.com/app/internal/store"]);
  assert.equal(text.status, "passed");

  const json = summarizeGoQueryCommand("go-list", [
    JSON.stringify({ ImportPath: "example.com/app/api", Dir: "/private/example/app/api" }),
    JSON.stringify({ ImportPath: "example.com/app/worker", Root: "/private/example/app" })
  ].join("\n"), { exitCode: 0 });
  assert.deepEqual(json.details.packages, ["example.com/app/api", "example.com/app/worker"]);
  assert.doesNotMatch(JSON.stringify(json), /\/Users\/alvin/);
});

test("summarizes module changes and module graph with bounded identifiers", () => {
  const download = summarizeGoQueryCommand("go-mod-download", [
    JSON.stringify({ Path: "golang.org/x/text", Version: "v0.17.0", Dir: "/private/example/go/pkg/mod/private" }),
    "go: downloading example.com/team/lib v1.2.3"
  ].join("\n"), { exitCode: 0 });
  assert.deepEqual(download.details.modules, ["golang.org/x/text@v0.17.0", "example.com/team/lib@v1.2.3"]);
  assert.doesNotMatch(JSON.stringify(download), /pkg\/mod\/private/);

  const graph = summarizeGoQueryCommand("go-mod-graph", [
    "example.com/app example.com/lib@v1.2.0",
    "example.com/app golang.org/x/sync@v0.8.0"
  ].join("\n"), { exitCode: 0 });
  assert.deepEqual(graph.details.modules, [
    "example.com/app", "example.com/lib@v1.2.0", "golang.org/x/sync@v0.8.0"
  ]);
});

test("summarizes errors, redacts local paths and caps error output", () => {
  const lines = Array.from({ length: 12 }, (_, index) =>
    `src/pkg${index}/main.go:${index + 1}:2: error: cannot load /private/example/repo/pkg${index}: token=top-secret-${index}`
  );
  const result = summarizeGoQueryCommand("go-run", lines.join("\n"), { exitCode: 1 });

  assert.equal(result.status, "failed");
  assert.equal(result.failures.length, 8);
  assert.equal(result.locations.length, 8);
  assert.equal(result.counts.failures, 12);
  assert.equal(result.truncated, true);
  assert.match(result.mainError, /<path>/);
  assert.match(result.failures[0].message, /token=<redacted>/i);
  assert.deepEqual(result.failures[0].location, { file: "src/pkg0/main.go", line: 1, column: 2 });
  assert.equal(result.failures[0].code, "compile");
  assert.doesNotMatch(JSON.stringify(result), /alvin|top-secret/);
});

test("go env exposes keys but never values", () => {
  const result = summarizeGoQueryCommand("go-env", JSON.stringify({
    GOPATH: "/private/example/go",
    GOPRIVATE: "corp.example.com",
    GOOS: "darwin"
  }), { exitCode: 0 });

  assert.deepEqual(result.details.environmentKeys, ["GOPATH", "GOPRIVATE", "GOOS"]);
  assert.doesNotMatch(JSON.stringify(result), /Users|corp\.example\.com|darwin/);
});

test("go env preserves an explicitly requested safe key when native output is value-only", () => {
  const result = summarizeGoQueryCommand("go-env", "/private/customer/go.mod\n", {
    exitCode: 0,
    argv: ["go", "env", "GOMOD"]
  });
  assert.deepEqual(result.details.environmentKeys, ["GOMOD"]);
  assert.equal(JSON.stringify(result).includes("/private/customer"), false);
});

test("returns null for an unknown profile and unknown status without an exit code", () => {
  assert.equal(summarizeGoQueryCommand("not-go", "output", { exitCode: 0 }), null);
  assert.equal(summarizeGoQueryCommand("go-mod-why", "# example.com/lib\nexample.com/app\nexample.com/lib", {}).status, "unknown");
});
