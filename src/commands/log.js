import { fail } from "../core/output.js";
import { readLog } from "../core/store.js";

const DEFAULT_TAIL = 120;
const MAX_TAIL = 500;
const PROTOCOL_VERSION = "agentshell.log.v1";

export async function getLog(root, logRef, options = {}) {
  if (!logRef) return fail("INVALID_ARGUMENT", "Usage: agentshell log get <logRef> --tail N");

  const logs = readLog(root, logRef);
  if (logs.stdout === null && logs.stderr === null) {
    return fail("LOG_NOT_FOUND", `Log not found: ${logRef}`);
  }

  const tail = Math.min(MAX_TAIL, Math.max(1, Number(options.tail || DEFAULT_TAIL)));
  const stdout = tailLines(logs.stdout || "", tail);
  const stderr = tailLines(logs.stderr || "", tail);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    logRef,
    tail,
    stdout,
    stderr,
    combined: tailLines(`${logs.stdout || ""}\n${logs.stderr || ""}`, tail)
  };
}

function tailLines(text, count) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join("\n");
}
