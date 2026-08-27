import assert from "node:assert/strict";
import test from "node:test";

import { benchmarkRuntime } from "../scripts/runtime-benchmark.js";

test("runtime benchmark separates warm metadata reads from CLI cold start", async () => {
  const report = await benchmarkRuntime({ samples: 5, runtimeDir: `/tmp/agentshell-runtime-benchmark-test-${process.pid}` });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.runtime-benchmark.v1");
  assert.equal(report.samples, 5);
  assert.ok(report.direct.medianMs >= 0);
  assert.ok(report.daemon.medianMs >= 0);
  assert.match(report.scope, /excludes CLI cold start/);
});
