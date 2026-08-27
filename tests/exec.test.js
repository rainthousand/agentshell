import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execCommand, parseExecCommandArgs } from "../src/commands/exec.js";
import { readLog } from "../src/core/store.js";

test("exec runs literal arguments without shell interpolation", async () => {
  const root = tempProject();
  const marker = path.join(root, "must-not-exist");
  const literal = `$HOME; touch ${marker}`;
  const result = await execCommand(root, ["--", process.execPath, "-e", "console.log(process.argv[1])", literal]);

  assert.equal(result.ok, true);
  assert.equal(result.command.shellInterpolation, false);
  assert.equal(result.command.argumentCount, 3);
  assert.match(result.summary.preview, /\$HOME; touch/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(JSON.stringify(result.command).includes(marker), false);
});

test("exec returns bounded file-line failure evidence and structured actions", async () => {
  const root = tempProject();
  const source = path.join(root, "src", "broken.js");
  fs.mkdirSync(path.dirname(source));
  fs.writeFileSync(source, "throw new Error('broken');\n");
  const script = `console.error('TypeError: broken\\n    at run (${source}:1:7)'); process.exit(9)`;
  const result = await execCommand(root, ["--", process.execPath, "-e", script]);

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 9);
  assert.equal(result.summary.status, "failed");
  assert.equal(result.evidence[0].file, "src/broken.js");
  assert.equal(result.evidence[0].line, 1);
  assert.match(result.suggestedNextActions[0].command, /agentshell read src\/broken\.js --lines 1:1/);
  assert.match(result.suggestedNextActions.at(-1).command, new RegExp(result.logRef));
});

test("exec caps captured output and stores only the bounded log", async () => {
  const root = tempProject();
  const result = await execCommand(
    root,
    ["--", process.execPath, "-e", "process.stdout.write('x'.repeat(20000)); process.stderr.write('y'.repeat(20000))"],
    { maxOutputBytes: 1024 }
  );
  const log = readLog(root, result.logRef);

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.summary.outputLimitBytes, 1024);
  assert.ok(result.summary.observedBytes >= 40000);
  assert.ok(Buffer.byteLength(log.stdout + log.stderr, "utf8") <= 1024);
  assert.ok((result.summary.preview || "").length <= 900);
});

test("exec terminates a timed-out process and returns a narrower next action", async () => {
  const root = tempProject();
  const result = await execCommand(
    root,
    ["--", process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 40 }
  );

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.summary.status, "timeout");
  assert.ok(result.suggestedNextActions.some((action) => action.reason.includes("timeout")));
});

test("exec redacts common secrets from compact output and local logs", async () => {
  const root = tempProject();
  const script = "console.log('authorization: Bearer abc123'); console.error('API_KEY=super-secret')";
  const result = await execCommand(root, ["--", process.execPath, "-e", script]);
  const serialized = JSON.stringify({ result, log: readLog(root, result.logRef) });

  assert.equal(result.privacy.commandArgumentsReturned, false);
  assert.equal(result.privacy.environmentReturned, false);
  assert.equal(result.privacy.rawOutputInline, false);
  assert.equal(result.privacy.commonSecretsRedacted, true);
  assert.equal(serialized.includes("abc123"), false);
  assert.equal(serialized.includes("super-secret"), false);
  assert.match(serialized, /REDACTED/);
});

test("exec reports missing executable and invalid separators without throwing", async () => {
  const root = tempProject();
  const invalid = parseExecCommandArgs([process.execPath, "-v"]);
  const missing = await execCommand(root, ["--", `missing-executable-${Date.now()}`]);

  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_ARGUMENT");
  assert.equal(missing.ok, false);
  assert.equal(missing.exitCode, 127);
  assert.ok(missing.summary.headline.includes("exit code 127"));
});

test("exec applies a matching high-noise profile and accepts its semantic success code", async () => {
  const root = tempProject();
  const terraform = path.join(root, "terraform");
  fs.writeFileSync(terraform, "#!/usr/bin/env node\nconsole.log('Plan: 1 to add, 0 to change, 0 to destroy');\nprocess.exit(2);\n");
  fs.chmodSync(terraform, 0o755);

  const result = await execCommand(root, ["--", terraform, "plan"]);

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 2);
  assert.equal(result.profile.id, "terraform-plan");
  assert.deepEqual(result.profile.appliedDefaults, [["-no-color"], ["-input=false"], ["-detailed-exitcode"]]);
  assert.equal(result.highNoiseSummary.status, "changed");
});

test("exec returns structured Go details without inlining environment values", async () => {
  const root = tempProject();
  const go = path.join(root, "go");
  fs.writeFileSync(go, "#!/usr/bin/env node\nconsole.log('GOMOD=/private/customer/go.mod');\n");
  fs.chmodSync(go, 0o755);

  const result = await execCommand(root, ["--", go, "env", "GOMOD"]);

  assert.equal(result.ok, true);
  assert.equal(result.profile.id, "go-env");
  assert.equal(result.profile.family, "go");
  assert.equal(result.summary.preview, null);
  assert.deepEqual(result.highNoiseSummary.details.environmentKeys, ["GOMOD"]);
  assert.equal(JSON.stringify(result.highNoiseSummary).includes("/private/customer"), false);
});

test("exec schema defines bounded compact and privacy contracts", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/exec.schema.json", "utf8"));
  const success = schema.oneOf[0];

  assert.equal(success.properties.protocolVersion.const, "agentshell.exec.v1");
  assert.equal(success.properties.summary.properties.preview.maxLength, 900);
  assert.equal(success.properties.evidence.maxItems, 5);
  assert.equal(schema.$defs.privacy.properties.shellInterpolation.const, false);
  assert.equal(schema.$defs.privacy.properties.commandArgumentsReturned.const, false);
  assert.deepEqual(schema.$defs.risk.required, ["level", "mutatesWorkspace", "network", "interactive"]);
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-exec-"));
}
