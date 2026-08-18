import { fail } from "../core/output.js";
import { packageScripts } from "./package-scripts.js";

const PROTOCOL_VERSION = "agentshell.package-script.v1";

export async function packageScript(root, name, options = {}) {
  const requestedName = typeof name === "string" ? name.trim() : "";
  if (!requestedName) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell package script <name> [--compact]", {
      received: name ?? null
    }, [{
      command: "agentshell package scripts --compact",
      reason: "List available package scripts before selecting one"
    }]);
  }

  const scriptsResult = await packageScripts(root, { compact: false });
  if (scriptsResult.ok === false) return scriptsResult;

  const script = scriptsResult.scripts.find((entry) => entry.name === requestedName);
  if (!script) {
    return fail("PACKAGE_SCRIPT_NOT_FOUND", `Script not found in package.json: ${requestedName}`, {
      name: requestedName,
      package: scriptsResult.package,
      availableScripts: scriptsResult.scripts.map((entry) => entry.name)
    }, [{
      command: "agentshell package scripts --compact",
      reason: "Inspect available package.json scripts and choose an exact script name"
    }]);
  }

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === true,
    packageManager: scriptsResult.packageManager,
    package: scriptsResult.package,
    script,
    summary: {
      totalScripts: scriptsResult.summary.totalScripts,
      scriptFound: true,
      category: script.category,
      risky: script.risky,
      longRunning: script.longRunning
    },
    suggestedNextActions: suggestedNextActions(scriptsResult.packageManager, script)
  };
}

function suggestedNextActions(packageManager, script) {
  if (script.risky) {
    return [{
      command: "agentshell package scripts --compact",
      reason: "Review nearby scripts before running a risky package command"
    }];
  }

  const command = runCommand(packageManager, script.name);
  if (script.longRunning) {
    return [{
      command,
      reason: "Run the selected script when you are ready for a long-running process"
    }];
  }

  return [{
    command,
    reason: "Run the selected package script"
  }];
}

function runCommand(packageManager, name) {
  if (packageManager === "yarn") return `yarn ${name}`;
  if (packageManager === "pnpm") return `pnpm run ${name}`;
  if (packageManager === "bun") return `bun run ${name}`;
  return `npm run ${name}`;
}
