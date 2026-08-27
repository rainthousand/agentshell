import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearActiveRun,
  readActiveRun,
  readEvents,
  readLog,
  readOperations,
  readRuns
} from "../src/core/store.js";
import { metrics } from "../src/commands/metrics.js";

test("state readers and metrics do not create runtime directories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-readonly-store-"));

  assert.equal(readActiveRun(root), null);
  assert.equal(clearActiveRun(root), null);
  assert.deepEqual(readRuns(root), []);
  assert.deepEqual(readEvents(root), []);
  assert.deepEqual(readOperations(root), []);
  assert.deepEqual(readLog(root, "missing"), { stdout: null, stderr: null });
  const report = await metrics(root, { compact: true });
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(path.join(root, ".agentshell")), false);
});
