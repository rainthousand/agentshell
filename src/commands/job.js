import { cancelJob, getJobStatus, readJobDelta, runJobWorker, startJob } from "../core/job-manager.js";
import { fail } from "../core/output.js";

export async function jobCommand(root, action, args = []) {
  const parsed = parseJobArgs(action, args);
  if (!parsed.ok) return parsed;
  if (action === "start") return startJob(root, parsed.value.argv, parsed.value.options);
  if (action === "status") return getJobStatus(root, parsed.value.jobId);
  if (action === "delta") return readJobDelta(root, parsed.value.jobId, parsed.value.cursor, parsed.value.options);
  if (action === "cancel") return cancelJob(root, parsed.value.jobId);
  return usageFailure("Action must be start, status, delta, or cancel");
}

export function parseJobArgs(action, args = []) {
  if (!Array.isArray(args)) return usageFailure("Arguments must be an array");
  if (action === "start") return parseStart(args);
  if (["status", "cancel"].includes(action)) {
    const values = args.filter((arg) => arg !== "--compact");
    if (values.length !== 1) return usageFailure(`job ${action} requires exactly one job ID`);
    return { ok: true, value: { jobId: values[0] } };
  }
  if (action === "delta") return parseDelta(args);
  return usageFailure("Action must be start, status, delta, or cancel");
}

function parseStart(args) {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) return usageFailure("job start requires -- followed by an executable and argv entries");
  const options = {};
  const flags = args.slice(0, separator).filter((arg) => arg !== "--compact");
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[++index];
    if (!["--timeout-ms", "--max-jobs", "--segment-bytes", "--max-segments"].includes(flag) || value == null) return usageFailure(`Unknown or incomplete job start option: ${flag}`);
    if (!/^[1-9]\d*$/u.test(value)) return usageFailure(`${flag} must be a positive integer`);
    const key = { "--timeout-ms": "timeoutMs", "--max-jobs": "maxJobs", "--segment-bytes": "segmentBytes", "--max-segments": "maxSegments" }[flag];
    options[key] = Number(value);
  }
  return { ok: true, value: { argv: args.slice(separator + 1), options } };
}

function parseDelta(args) {
  const options = {};
  let jobId = null;
  let cursor = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--compact") continue;
    if (arg === "--cursor") {
      cursor = args[++index];
      if (!cursor) return usageFailure("--cursor requires a value");
      continue;
    }
    if (arg === "--max-bytes") {
      const value = args[++index];
      if (!/^[1-9]\d*$/u.test(value || "")) return usageFailure("--max-bytes requires a positive integer");
      options.maxBytes = Number(value);
      continue;
    }
    if (!jobId) jobId = arg;
    else return usageFailure(`Unexpected job delta argument: ${arg}`);
  }
  if (!jobId) return usageFailure("job delta requires a job ID");
  return { ok: true, value: { jobId, cursor, options } };
}

function usageFailure(message) {
  return fail("INVALID_ARGUMENT", message, { shellInterpolation: false }, [{
    command: "agentshell job start [--timeout-ms N] -- <executable> [args...]",
    reason: "Pass an explicit argv vector; shell command strings are not accepted"
  }]);
}

async function workerEntry() {
  if (process.env.AGENTSHELL_JOB_WORKER !== "1" || process.argv[2] !== "__worker") return;
  const values = process.argv.slice(3);
  const rootIndex = values.indexOf("--root");
  const jobIndex = values.indexOf("--job");
  const instanceIndex = values.indexOf("--instance");
  if (rootIndex < 0 || jobIndex < 0 || instanceIndex < 0) process.exit(2);
  await runJobWorker({ root: values[rootIndex + 1], jobId: values[jobIndex + 1], instanceId: values[instanceIndex + 1] });
}

workerEntry().catch(() => { process.exitCode = 1; });
