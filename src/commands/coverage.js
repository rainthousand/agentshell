import {
  commandCoverage,
  ingestExternalCommandObservations,
  observeExternalCommand,
  resetCommandCoverage
} from "../core/command-coverage.js";

export function coverage(root, action = "status", options = {}) {
  if (action === "status") return commandCoverage(root, options);
  if (action === "observe") return observeExternalCommand(root, options.command, { source: options.source });
  if (action === "ingest") return ingestExternalCommandObservations(root, options.payload, { source: options.source });
  if (action === "reset") return resetCommandCoverage(root);
  return {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: "Usage: agentshell coverage [status] [--compact] [--limit N] | coverage observe [--source adapter] -- <command...> | coverage ingest --input <payload.json> [--source adapter] | coverage reset --confirm",
      suggestedNextActions: []
    }
  };
}
