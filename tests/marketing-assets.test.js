import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);

test("social preview matches GitHub dimensions and size limit", () => {
  const file = new URL("docs/images/social-preview.png", root);
  const bytes = fs.readFileSync(file);

  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(bytes.readUInt32BE(16), 1280);
  assert.equal(bytes.readUInt32BE(20), 640);
  assert.ok(bytes.length < 1_000_000, `social preview is ${bytes.length} bytes`);
});

test("benchmark GIF and launch sources preserve scoped claims", () => {
  const gif = fs.readFileSync(new URL("docs/images/agentshell-benchmark.gif", root));
  const readme = fs.readFileSync(new URL("README.md", root), "utf8");
  const launchKit = fs.readFileSync(new URL("docs/launch-kit.md", root), "utf8");

  assert.match(gif.subarray(0, 6).toString("ascii"), /^GIF8[79]a$/);
  assert.ok(gif.length > 100_000, "benchmark GIF is unexpectedly small");
  assert.match(readme, /docs\/images\/agentshell-benchmark\.gif/);
  assert.match(readme, /94% less scoped terminal-output context/);
  assert.match(launchKit, /3,713 to 212 estimated tokens/);
  assert.match(launchKit, /not total Codex token usage/);
});
