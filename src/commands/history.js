import { readOperations } from "../core/store.js";

const PROTOCOL_VERSION = "agentshell.history.v1";

export async function history(root) {
  const operations = readOperations(root);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    operations: operations.slice(-50).reverse()
  };
}
