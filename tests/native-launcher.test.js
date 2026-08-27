import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const launcher = path.join(process.cwd(), "bin", "agentshell");

test("plugin launcher runs the source CLI during development", () => {
  const result = spawnSync(launcher, ["--version"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.0\.0/);
});

test("plugin launcher verifies a native release before first execution", () => {
  const source = fs.readFileSync(launcher, "utf8");
  assert.match(source, /^#!\/bin\/sh/u);
  assert.match(source, /agentshell-darwin-arm64\.sha256/u);
  assert.match(source, /shasum -a 256/u);
  assert.match(source, /EXPECTED.*ACTUAL/su);
  assert.match(source, /releases\/latest\/download/u);
  assert.ok(source.indexOf('chmod 0755 "$TMP_DIR/agentshell"') > source.indexOf('"$EXPECTED" != "$ACTUAL"'));
  assert.ok(source.indexOf('exec "$TARGET"') > source.indexOf('mv "$TMP_DIR/agentshell" "$TARGET"'));
});
