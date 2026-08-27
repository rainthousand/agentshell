export function stableOperationIds(values) {
  const seen = new Set();
  const ids = [];
  for (const value of values || []) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

export function operationIdsForRun(run) {
  return stableOperationIds([
    ...(run?.nodes || []).flatMap((node) => [
      ...(Array.isArray(node?.operationIds) ? node.operationIds : []),
      node?.operationId
    ]),
    ...(run?.commandStats || []).flatMap((stat) => stat?.operationIds || [])
  ]);
}

export function verificationOperationIdsForRun(run) {
  return stableOperationIds((run?.nodes || [])
    .filter((node) => node?.type === "diagnose" || node?.type === "verify")
    .flatMap((node) => [
      ...(Array.isArray(node?.operationIds) ? node.operationIds : []),
      node.operationId
    ]));
}

export function operationIdsForVerification(verification) {
  return stableOperationIds([
    verification?.relatedTestFileVerification?.operationId,
    verification?.operationId
  ]);
}
