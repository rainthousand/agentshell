import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseVerifyGoArgs, verifyGo } from "../src/commands/verify-go.js";
import { planGoFocusedVerify } from "../src/core/go-focused-verify.js";
import { readLog } from "../src/core/store.js";

test("planner builds literal Go argv for focused packages, selectors, tags, count, timeout, and Mockey", () => {
  const plan = planGoFocusedVerify({
    packages: ["./internal/api", "./pkg/..."],
    run: "^Test(Create|Update)$",
    tags: ["integration", "linux"],
    count: 1,
    timeout: "1m30s",
    mockey: true
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.value.argv, [
    "go", "test", "-json",
    "-run=^Test(Create|Update)$",
    "-tags=integration,linux",
    "-count=1",
    "-timeout=1m30s",
    "-gcflags=all=-N -l",
    "./internal/api", "./pkg/..."
  ]);
});

test("planner rejects option injection and malformed structured values", () => {
  assert.equal(planGoFocusedVerify({ packages: ["-exec=touch"] }).error.code, "GO_VERIFY_PACKAGE_INVALID");
  assert.equal(planGoFocusedVerify({ packages: ["./pkg with-space"] }).error.code, "GO_VERIFY_PACKAGE_INVALID");
  assert.equal(planGoFocusedVerify({ run: "TestA\ntouch marker" }).error.code, "GO_VERIFY_RUN_INVALID");
  assert.equal(planGoFocusedVerify({ tags: ["tag,other"] }).error.code, "GO_VERIFY_TAG_INVALID");
  assert.equal(planGoFocusedVerify({ count: -1 }).error.code, "GO_VERIFY_COUNT_INVALID");
  assert.equal(planGoFocusedVerify({ timeout: "10m" }).error.code, "GO_VERIFY_TIMEOUT_INVALID");
  assert.equal(planGoFocusedVerify({ mockey: "yes" }).error.code, "GO_VERIFY_PRESET_INVALID");
});

test("planner only accepts package patterns inside the current module", () => {
  const root = goProject();
  const accepted = planGoFocusedVerify({
    packages: ["./...", "./unit/...", "example.test", "example.test/unit"]
  }, { root });

  assert.equal(accepted.ok, true);
  for (const candidate of [
    "../../outside/...",
    "./unit/../../../outside",
    "/tmp/external",
    "C:\\external",
    "file:///tmp/external",
    "https://example.test/external",
    "other.example/module"
  ]) {
    assert.equal(
      planGoFocusedVerify({ packages: [candidate] }, { root }).error.code,
      "GO_VERIFY_PACKAGE_INVALID",
      candidate
    );
  }
});

test("planner only trusts go.work modules located inside the workspace root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-verify-go-work-"));
  const inside = path.join(root, "inside");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-verify-go-outside-"));
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, "go.mod"), "module example.test/inside\n\ngo 1.22\n");
  fs.writeFileSync(path.join(outside, "go.mod"), "module example.test/outside\n\ngo 1.22\n");
  fs.writeFileSync(path.join(root, "go.work"), `go 1.22\n\nuse (\n  ./inside\n  ${outside}\n)\n`);

  assert.equal(planGoFocusedVerify({ packages: ["example.test/inside/..."] }, { root }).ok, true);
  assert.equal(
    planGoFocusedVerify({ packages: ["example.test/outside/..."] }, { root }).error.code,
    "GO_VERIFY_PACKAGE_INVALID"
  );
});

test("focused verifier rejects an external package before starting go", async () => {
  const root = goProject();
  const bin = path.join(root, "bin");
  const marker = path.join(root, "go-started");
  fs.mkdirSync(bin);
  const fakeGo = path.join(bin, "go");
  fs.writeFileSync(fakeGo, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  fs.chmodSync(fakeGo, 0o755);

  const result = await verifyGo(root, {
    packages: ["../../outside/..."],
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GO_VERIFY_PACKAGE_INVALID");
  assert.equal(fs.existsSync(marker), false);
});

test("command parser accepts repeatable structured selectors and rejects unknown flags", () => {
  const parsed = parseVerifyGoArgs([
    "--packages", "./api,./store",
    "--package", "./worker",
    "--run", "^TestAPI$",
    "--tags", "integration,linux",
    "--count", "2",
    "--timeout", "30s",
    "--mockey",
    "--compact"
  ]);

  assert.deepEqual(parsed, {
    ok: true,
    value: {
      packages: ["./api", "./store", "./worker"],
      tags: ["integration", "linux"],
      run: "^TestAPI$",
      count: 2,
      timeout: "30s",
      mockey: true
    }
  });
  assert.equal(parseVerifyGoArgs(["--shell", "touch marker"]).error.code, "INVALID_ARGUMENT");
  assert.equal(parseVerifyGoArgs(["--count", "1.5"]).error.code, "INVALID_ARGUMENT");
  assert.equal(parseVerifyGoArgs(["--packages", ",,"]).error.code, "INVALID_ARGUMENT");
});

test("focused verifier executes without a shell and returns compact Go failure evidence", async () => {
  const root = goProject();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fakeGo = path.join(bin, "go");
  fs.writeFileSync(fakeGo, [
    "#!/bin/sh",
    "printf '%s\\n' \"$@\" > \"$ARG_CAPTURE\"",
    "printf '%s\\n' '{\"Action\":\"output\",\"Package\":\"example.test/unit\",\"Test\":\"TestBroken\",\"Output\":\"    unit_test.go:12: expected 1, got 2\\n\"}'",
    "printf '%s\\n' '{\"Action\":\"fail\",\"Package\":\"example.test/unit\",\"Test\":\"TestBroken\"}'",
    "exit 1",
    ""
  ].join("\n"));
  fs.chmodSync(fakeGo, 0o755);
  const capture = path.join(root, "args.txt");

  const result = await verifyGo(root, {
    packages: ["./unit"],
    run: "^TestBroken$; touch should-not-run",
    tags: ["unit"],
    count: 1,
    timeout: "30s",
    mockey: true,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ARG_CAPTURE: capture }
  });

  assert.equal(result.ok, false);
  assert.equal(result.command.shellInterpolation, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.summary.status, "failed");
  assert.equal(result.summary.failedTests, 1);
  assert.deepEqual(result.summary.failedTestNames, ["TestBroken"]);
  assert.match(result.summary.mainError, /unit_test\.go:12/);
  assert.ok((result.summary.preview || "").length <= 900);
  assert.deepEqual(fs.readFileSync(capture, "utf8").trim().split("\n"), result.command.args);
  assert.equal(fs.existsSync(path.join(root, "should-not-run")), false);
  assert.match(readLog(root, result.logRef).stdout, /TestBroken/);
});

test("focused verifier reports a bounded process timeout", async () => {
  const root = goProject();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fakeGo = path.join(bin, "go");
  fs.writeFileSync(fakeGo, "#!/bin/sh\necho 'panic: test timed out after 1ms' >&2\nexit 1\n");
  fs.chmodSync(fakeGo, 0o755);

  const result = await verifyGo(root, {
    packages: ["./..."],
    timeout: "1ms",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.ok, false);
  assert.ok([1, 124].includes(result.exitCode));
  assert.equal(result.timedOut, true);
  assert.equal(result.summary.status, "timeout");
  assert.ok(result.suggestedNextActions.some((action) => /narrow/.test(action.reason)));
});

test("schema captures compact bounded response limits", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/verify-go.schema.json", "utf8"));
  const success = schema.oneOf[0];
  assert.equal(success.properties.protocolVersion.const, "agentshell.verify-go.v1");
  assert.equal(success.properties.command.properties.shellInterpolation.const, false);
  assert.equal(success.properties.summary.properties.preview.maxLength, 900);
  assert.equal(success.properties.summary.properties.failedTestNames.maxItems, 8);
});

function goProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-verify-go-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test\n\ngo 1.22\n");
  fs.mkdirSync(path.join(root, "unit"));
  fs.writeFileSync(path.join(root, "unit", "unit_test.go"), "package unit\n");
  return root;
}
