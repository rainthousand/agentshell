import fs from "node:fs";
import path from "node:path";
import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";
import { appendOperation, newId, readOperations, snapshotFilePath } from "../core/store.js";

export async function undo(root, operationId) {
  const operations = readOperations(root);
  const target = operationId
    ? operations.find((operation) => operation.id === operationId)
    : [...operations].reverse().find((operation) => operation.type === "change" && operation.ok);

  if (!target) return fail("OPERATION_NOT_FOUND", "No change operation found to undo");
  if (target.type !== "change" || !target.snapshotId) {
    return fail("OPERATION_NOT_UNDOABLE", `Operation is not undoable: ${target.id}`);
  }

  const restoredFiles = [];
  for (const file of target.changedFiles || []) {
    const resolved = resolveInsideWorkspace(root, file);
    if (!resolved.ok) return fail(resolved.reason, `Cannot restore ${file}`);

    const snapshotPath = snapshotFilePath(root, target.snapshotId, file);
    if (!fs.existsSync(snapshotPath)) {
      return fail("SNAPSHOT_NOT_FOUND", `Snapshot file not found for ${file}`);
    }

    fs.mkdirSync(path.dirname(resolved.absTarget), { recursive: true });
    fs.writeFileSync(resolved.absTarget, fs.readFileSync(snapshotPath));
    restoredFiles.push(file);
  }

  const undoOperationId = newId("op");
  appendOperation(root, {
    id: undoOperationId,
    type: "undo",
    ok: true,
    revertedOperation: target.id,
    restoredFiles
  });

  return {
    ok: true,
    operationId: undoOperationId,
    revertedOperation: target.id,
    restoredFiles
  };
}
