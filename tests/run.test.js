import assert from "node:assert/strict";
import test from "node:test";

import { runShell } from "../src/core/run.js";

test("runShell does not leak AgentShell package discovery into project commands", async () => {
  const previous = process.env.AGENTSHELL_PACKAGE_ROOT;
  process.env.AGENTSHELL_PACKAGE_ROOT = "/internal/agentshell/package";
  try {
    const script = "process.stdout.write(process.env.AGENTSHELL_PACKAGE_ROOT || 'unset')";
    const result = await runShell(`${shellQuote(process.execPath)} -e ${shellQuote(script)}`, process.cwd());

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "unset");
  } finally {
    if (previous === undefined) delete process.env.AGENTSHELL_PACKAGE_ROOT;
    else process.env.AGENTSHELL_PACKAGE_ROOT = previous;
  }
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
