import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export function stateDir(root) {
  return path.join(root, ".agentshell");
}

export function ensureState(root) {
  const primary = stateDir(root);
  try {
    prepareStateDir(primary);
    return primary;
  } catch {
    const fallback = fallbackStateDir(root);
    prepareStateDir(fallback);
    return fallback;
  }
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function appendOperation(root, operation) {
  const dir = ensureState(root);
  const line = JSON.stringify({
    ...operation,
    createdAt: new Date().toISOString()
  });
  fs.appendFileSync(path.join(dir, "history.jsonl"), `${line}\n`);
}

export function appendEvent(root, event) {
  const dir = ensureState(root);
  const line = JSON.stringify({
    ...event,
    createdAt: new Date().toISOString()
  });
  fs.appendFileSync(path.join(dir, "events.jsonl"), `${line}\n`);
}

export function createRun(root, node) {
  const run = {
    id: newId("run"),
    status: "in_progress",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [withTimestamp(node)],
    commandStats: []
  };
  run.status = statusFor(run);
  writeActiveRun(root, run);
  appendRunSnapshot(root, run);
  return run;
}

export function readActiveRun(root) {
  const file = path.join(ensureState(root), "active-run.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function clearActiveRun(root) {
  const file = path.join(ensureState(root), "active-run.json");
  if (!fs.existsSync(file)) return null;
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.unlinkSync(file);
  return run;
}

export function readRuns(root) {
  const file = path.join(ensureState(root), "runs.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function appendRunNode(root, runId, node) {
  const run = readActiveRun(root);
  if (!run || run.id !== runId) return null;
  run.nodes.push(withTimestamp(node));
  run.updatedAt = new Date().toISOString();
  run.status = statusFor(run);
  writeActiveRun(root, run);
  appendRunSnapshot(root, run);
  return run;
}

export function appendRunCommandStats(root, runId, stats) {
  const run = readActiveRun(root);
  if (!run || run.id !== runId) return null;
  run.commandStats.push(withTimestamp(stats));
  run.updatedAt = new Date().toISOString();
  run.status = statusFor(run);
  writeActiveRun(root, run);
  appendRunSnapshot(root, run);
  return run;
}

export function readEvents(root) {
  const file = path.join(ensureState(root), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readOperations(root) {
  const file = path.join(ensureState(root), "history.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function snapshotRoot(root, snapshotId) {
  return path.join(ensureState(root), "snapshots", snapshotId);
}

export function snapshotFilePath(root, snapshotId, relativeFile) {
  return path.join(snapshotRoot(root, snapshotId), relativeFile);
}

export function logPath(root, logRef, stream) {
  return path.join(ensureState(root), "logs", `${logRef}.${stream}.log`);
}

export function writeLog(root, logRef, stdout, stderr) {
  ensureState(root);
  fs.writeFileSync(logPath(root, logRef, "stdout"), stdout);
  fs.writeFileSync(logPath(root, logRef, "stderr"), stderr);
}

export function readLog(root, logRef) {
  const stdoutPath = logPath(root, logRef, "stdout");
  const stderrPath = logPath(root, logRef, "stderr");
  return {
    stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : null,
    stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8") : null
  };
}

function prepareStateDir(dir) {
  fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "change-templates"), { recursive: true });
}

function writeActiveRun(root, run) {
  fs.writeFileSync(path.join(ensureState(root), "active-run.json"), `${JSON.stringify(run, null, 2)}\n`);
}

function appendRunSnapshot(root, run) {
  fs.appendFileSync(path.join(ensureState(root), "runs.jsonl"), `${JSON.stringify(run)}\n`);
}

function withTimestamp(value) {
  return {
    ...value,
    createdAt: new Date().toISOString()
  };
}

function statusFor(run) {
  const verifyNodes = run.nodes.filter((node) => node.type === "verify");
  if (verifyNodes.some((node) => node.ok === true)) return "passed";
  if (run.nodes.some((node) => node.type === "diagnose" && node.verificationOk === false)) return "failing";
  return "in_progress";
}

function fallbackStateDir(root) {
  const key = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "agentshell-state", key);
}
