import { getPackageInfo, detectPackageManager, scriptCommand } from "../core/package-json.js";
import { fail } from "../core/output.js";
import { runShell } from "../core/run.js";
import { verify } from "./verify.js";

const PROTOCOL_VERSION = "agentshell.benchmark.v1";

export async function benchmark(root, type) {
  const packageInfo = getPackageInfo(root);
  if (!packageInfo) return fail("PACKAGE_NOT_FOUND", "No package.json found for benchmark");
  if (type !== "test") return fail("INVALID_ARGUMENT", "Only `agentshell benchmark test` is supported");
  if (!packageInfo.scripts.test) return fail("SCRIPT_NOT_FOUND", "No test script found in package.json");

  const packageManager = detectPackageManager(packageInfo.root);
  const command = scriptCommand(packageManager, "test");
  const raw = await runShell(command, packageInfo.root);
  const rawOutput = `${raw.stdout}${raw.stderr}`;
  const compact = await verify(packageInfo.root, "test", { run: false });
  const compactOutput = `${JSON.stringify(compact, null, 2)}\n`;
  const reductionPercent = rawOutput.length > 0
    ? Math.round((1 - compactOutput.length / rawOutput.length) * 100)
    : 0;

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    type,
    command,
    raw: {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      chars: rawOutput.length,
      estimatedTokens: estimateTokens(rawOutput.length)
    },
    agentshell: {
      exitCode: compact.exitCode,
      durationMs: compact.durationMs,
      chars: compactOutput.length,
      estimatedTokens: estimateTokens(compactOutput.length),
      logRef: compact.logRef,
      summary: compact.summary,
      relatedFiles: compact.relatedFiles
    },
    reduction: {
      charsSaved: Math.max(0, rawOutput.length - compactOutput.length),
      percentSaved: Math.max(0, reductionPercent)
    },
    suggestedNextActions: [{
      command: `agentshell log get ${compact.logRef} --tail 120`,
      reason: "Inspect more raw output only if compact summary is insufficient"
    }]
  };
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}
