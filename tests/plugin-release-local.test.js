import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedCommands = [
  "npm run plugin:cachebust",
  "npm run plugin:validate:source",
  "npm run plugin:install-local",
  "npm link",
  "codex plugin add agentshell@personal",
  "npm run plugin:doctor-local",
  "npm run plugin:smoke",
  "npm run plugin:smoke:markdown"
];

test("plugin release local exposes compact JSON usage", () => {
  const result = spawnSync("node", ["scripts/plugin-release-local.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.usage, "node scripts/plugin-release-local.js [--dry-run] [--skip-codex-add] [--compact] [--report <path>]");
  assert.deepEqual(output.steps, expectedCommands);
});

test("plugin release local dry run reports release chain in order", () => {
  const result = spawnSync("node", ["scripts/plugin-release-local.js", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.plugin-release-local.v1");
  assert.equal(output.dryRun, true);
  assert.equal(output.skipCodexAdd, false);
  assert.deepEqual(output.steps.map((step) => step.command), expectedCommands);
  assert.deepEqual(output.steps.map((step) => step.status), Array(expectedCommands.length).fill("dry-run"));
  assert.equal(output.steps.every((step) => step.ok), true);
});

test("plugin release local writes JSON artifact reports", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentshell-release-local-report-"));
  const reportPath = join(dir, "nested", "release.json");
  const result = spawnSync("node", ["scripts/plugin-release-local.js", "--dry-run", "--report", reportPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(reportPath), true);
  const stdoutReport = JSON.parse(result.stdout);
  const fileReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(fileReport, stdoutReport);
  assert.equal(fileReport.dryRun, true);
  assert.equal(fileReport.protocolVersion, "agentshell.plugin-release-local.v1");
  assert.deepEqual(fileReport.steps.map((step) => step.command), expectedCommands);
});

test("plugin release local compact output omits noisy step logs but report stays full", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentshell-release-local-compact-"));
  const reportPath = join(dir, "release.json");
  const result = spawnSync("node", [
    "scripts/plugin-release-local.js",
    "--dry-run",
    "--compact",
    "--report",
    reportPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const fileReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.plugin-release-local.v1");
  assert.equal(output.compact, true);
  assert.equal(output.status, "ready");
  assert.equal(typeof output.durationMs, "number");
  assert.equal(output.plugin, null);
  assert.equal(output.failedStep, null);
  assert.equal(output.summary.total, expectedCommands.length);
  assert.equal(output.summary.failed, 0);
  assert.equal(output.steps.length, expectedCommands.length);
  assert.equal(Object.hasOwn(output.steps[0], "command"), false);
  assert.equal(Object.hasOwn(output.steps[0], "stdout"), false);
  assert.equal(Object.hasOwn(output.steps[0], "stderr"), false);
  assert.equal(Object.hasOwn(fileReport.steps[0], "command"), true);
  assert.equal(fileReport.protocolVersion, "agentshell.plugin-release-local.v1");
  assert.equal(fileReport.plugin, null);
  assert.equal(Object.hasOwn(fileReport.steps[0], "status"), true);
  assert.equal(Object.hasOwn(fileReport.steps[0], "stdout"), false);
});

test("plugin release local compact report extracts plugin metadata from doctor output", () => {
  const binDir = mkdtempSync(join(tmpdir(), "agentshell-release-local-bin-"));
  const logDir = mkdtempSync(join(tmpdir(), "agentshell-release-local-log-"));
  writeFileSync(join(binDir, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "${join(logDir, "npm-args.log")}"
case "$*" in
  "run plugin:doctor-local")
    printf '%s\\n' '> agentshell@0.24.0 plugin:doctor-local'
    printf '%s\\n' '> node scripts/plugin-doctor-local.js'
    printf '\\n'
    printf '%s\\n' '{"ok":true,"plugin":{"name":"agentshell","version":"0.24.0+codex.fixture","authorName":"Alvin","developerName":"Alvin"}}'
    ;;
esac
exit 0
`);
  chmodSync(join(binDir, "npm"), 0o755);

  const result = spawnSync(process.execPath, ["scripts/plugin-release-local.js", "--skip-codex-add", "--compact"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.dryRun, false);
  assert.equal(output.skipCodexAdd, true);
  assert.equal(output.steps[4].status, "skipped");
  assert.equal(output.steps[4].reason, "--skip-codex-add");
  assert.equal(output.steps.every((step) => step.ok), true);
  assert.deepEqual(output.plugin, {
    name: "agentshell",
    version: "0.24.0+codex.fixture",
    authorName: "Alvin",
    developerName: "Alvin"
  });
});

test("plugin release local can skip codex add outside dry run", () => {
  const binDir = mkdtempSync(join(tmpdir(), "agentshell-release-local-bin-"));
  writeFileSync(join(binDir, "npm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "npm"), 0o755);

  const result = spawnSync(process.execPath, ["scripts/plugin-release-local.js", "--skip-codex-add"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.dryRun, false);
  assert.equal(output.skipCodexAdd, true);
  assert.deepEqual(output.steps.map((step) => step.command), expectedCommands);
  assert.equal(output.steps[4].command, "codex plugin add agentshell@personal");
  assert.equal(output.steps[4].status, "skipped");
  assert.equal(output.steps[4].reason, "--skip-codex-add");
  assert.equal(output.steps.every((step) => step.ok), true);
  assert.equal(output.plugin, null);
});

test("package exposes plugin release local script", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["plugin:release-local"], "node scripts/plugin-release-local.js");
});

test("plugin release local rejects unknown arguments", () => {
  const result = spawnSync("node", ["scripts/plugin-release-local.js", "--wat"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --wat/);
  assert.equal(result.stdout, "");
});

test("plugin release local schema exposes compact plugin metadata summary", () => {
  const schema = JSON.parse(readFileSync("schemas/plugin-release-local.schema.json", "utf8"));
  assert.deepEqual(schema.$defs.pluginSummary.required, ["name", "version", "authorName", "developerName"]);
  assert.equal(schema.oneOf[0].properties.plugin.oneOf[0].$ref, "#/$defs/pluginSummary");
  assert.equal(schema.oneOf[1].properties.plugin.oneOf[0].$ref, "#/$defs/pluginSummary");
  assert.ok(schema.oneOf[1].required.includes("plugin"));
});
