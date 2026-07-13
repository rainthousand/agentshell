#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.beta-funnel.v1";
const MINIMUM_SUCCESSFUL_EXPORTS = 3;
const MINIMUM_ACTIVATION_RATE = 80;
const MINIMUM_EXPORT_RATE = 80;

export function buildBetaFunnel(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("At least one beta evidence input is required");
  }

  const attempts = inputs.map((input, index) => classifyBetaEvidence(input, index));
  const counts = countStages(attempts);
  counts.distinctSuccessfulExports = distinctSuccessfulExports(inputs, attempts);
  const rates = {
    cliAvailable: percent(counts.cliAvailable, counts.attempted),
    activation: percent(counts.activated, counts.attempted),
    verification: percent(counts.verified, counts.attempted),
    export: percent(counts.exported, counts.attempted)
  };
  const failureReasons = attempts.reduce((countsByReason, attempt) => {
    if (attempt.failureReason) countsByReason[attempt.failureReason] = (countsByReason[attempt.failureReason] || 0) + 1;
    return countsByReason;
  }, {});
  const checks = {
    successfulExternalExports: gateCheck(counts.distinctSuccessfulExports, MINIMUM_SUCCESSFUL_EXPORTS, "minimum"),
    activationRate: gateCheck(rates.activation, MINIMUM_ACTIVATION_RATE, "minimum-percent"),
    exportRate: gateCheck(rates.export, MINIMUM_EXPORT_RATE, "minimum-percent")
  };
  const ready = Object.values(checks).every((check) => check.ok);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date(options.now || Date.now()).toISOString(),
    summary: {
      counts,
      rates,
      failureReasons
    },
    gate: {
      version: "v1",
      status: ready ? "ready" : "collecting",
      ready,
      checks
    },
    attempts,
    privacy: {
      aggregateOnly: true,
      omitted: ["inputPaths", "rawLogs", "commands", "stdout", "stderr", "userPaths"]
    }
  };
}

export function classifyBetaEvidence(input, index = 0) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Malformed beta evidence at index ${index}`);
  }

  const facts = evidenceFacts(input);
  if (!facts.recognized) throw new Error(`Unrecognized beta evidence at index ${index}`);

  const stages = {
    attempted: true,
    cliAvailable: facts.cliAvailable,
    activated: facts.activated,
    verified: facts.verified,
    exported: facts.exported
  };
  return {
    id: `attempt-${index + 1}`,
    inputType: facts.inputType,
    stages,
    failureReason: failureReasonFor(input, stages)
  };
}

function evidenceFacts(input) {
  if (input.ok === false && isObject(input.error)) return failureEnvelopeFacts(input);

  if (input.protocolVersion === "agentshell.trial-export.v1" && input.ok === true) {
    const eventCount = number(input.summary?.eventCount);
    const verified = input.summary?.finalVerificationOk === true;
    return facts("trial-export", true, eventCount > 0, verified, verified && input.summary?.evidenceReady === true);
  }

  if (Array.isArray(input.events) || Array.isArray(input.commands)) {
    const eventCount = Array.isArray(input.events) ? input.events.length : input.commands.length;
    const verified = input.finalVerification?.ok === true;
    return facts("evidence-bundle", true, eventCount > 0, verified, verified && eventCount > 0);
  }

  if (input.protocolVersion === "agentshell.adapter-trial-collect.v1") {
    const activated = number(input.summary?.agentShellCommands) > 0
      || arrayLength(input.trial?.commands) > 0;
    const verified = input.trial?.finalVerification?.ok === true
      || input.scoreReport?.finalVerification?.ok === true;
    return facts("adapter-collector", true, activated, verified, input.ok === true && activated && verified);
  }

  if (Array.isArray(input.trials)
    && typeof input.protocolVersion === "string"
    && input.protocolVersion.includes("trial")) {
    const completeTrials = input.trials.filter((trial) => trial?.evidence?.complete !== false);
    const activated = input.trials.some((trial) => number(trial?.metrics?.agentShellCommandCount) > 0);
    const verified = input.trials.some((trial) => trial?.finalVerification?.ok === true);
    const complete = input.trials.length > 0 && completeTrials.length === input.trials.length;
    return facts("trial-collector", true, activated, verified, input.ok === true && complete && verified);
  }

  return { recognized: false };
}

function failureEnvelopeFacts(input) {
  const code = String(input.error.code || "UNKNOWN_FAILURE").toUpperCase();
  const details = isObject(input.error.details) ? input.error.details : {};
  const cliAvailable = !["CLI_NOT_FOUND", "COMMAND_NOT_FOUND", "AGENTSHELL_NOT_FOUND"].includes(code);
  const activated = number(details.eventCount) > 0
    || details.activated === true
    || details.pluginActive === true;
  const verified = details.finalVerificationOk === true
    || details.verificationOk === true
    || details.runStatus === "passed";
  return facts("failure-envelope", cliAvailable, activated, verified, false);
}

function facts(inputType, cliAvailable, activated, verified, exported) {
  return { recognized: true, inputType, cliAvailable, activated, verified, exported };
}

function failureReasonFor(input, stages) {
  if (stages.exported) return null;
  const code = input.error?.code ? String(input.error.code).toUpperCase() : null;
  const details = isObject(input.error?.details) ? input.error.details : {};

  if (!stages.cliAvailable) return "cli-unavailable";
  if (!stages.activated) {
    if (details.diagnosis === "wrong-directory") return "wrong-directory";
    if (details.eventCount === 0 || details.runStatus === "missing" || code === "TRIAL_NOT_READY") {
      return "no-agentshell-events";
    }
    return "activation-missing";
  }
  if (!stages.verified) {
    if (code === "TRIAL_VERIFICATION_FAILED" || details.runStatus === "failing") return "verification-failed";
    return "verification-missing";
  }
  return "export-missing";
}

function countStages(attempts) {
  const counts = { attempted: attempts.length, cliAvailable: 0, activated: 0, verified: 0, exported: 0 };
  for (const attempt of attempts) {
    for (const stage of ["cliAvailable", "activated", "verified", "exported"]) {
      if (attempt.stages[stage]) counts[stage] += 1;
    }
  }
  return counts;
}

function distinctSuccessfulExports(inputs, attempts) {
  const identities = new Set();
  for (let index = 0; index < attempts.length; index += 1) {
    if (!attempts[index].stages.exported) continue;
    const identity = inputs[index]?.summary?.trialId
      || inputs[index]?.id
      || inputs[index]?.trial?.id;
    if (typeof identity === "string" && identity.trim()) identities.add(identity.trim());
  }
  return identities.size;
}

function percent(value, total) {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}

function gateCheck(actual, required, unit) {
  return { ok: actual >= required, actual, required, unit };
}

function number(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function renderBetaFunnelMarkdown(report) {
  const { counts, rates, failureReasons } = report.summary;
  const lines = [
    "# AgentShell External Beta Funnel",
    "",
    `Gate: **${report.gate.status}**`,
    "",
    "## Funnel",
    "",
    "| Stage | Count | Rate |",
    "|---|---:|---:|",
    `| Attempted | ${counts.attempted} | 100% |`,
    `| CLI available | ${counts.cliAvailable} | ${rates.cliAvailable}% |`,
    `| Activated | ${counts.activated} | ${rates.activation}% |`,
    `| Verified | ${counts.verified} | ${rates.verification}% |`,
    `| Exported | ${counts.exported} | ${rates.export}% |`,
    "",
    "## V1 Gate",
    "",
    ...Object.entries(report.gate.checks).map(([name, check]) => (
      `- ${name}: ${check.ok ? "pass" : "collecting"} (${check.actual}/${check.required}${check.unit.includes("percent") ? "%" : ""})`
    )),
    "",
    "## Failure Reasons",
    "",
    ...(Object.keys(failureReasons).length === 0
      ? ["- None"]
      : Object.entries(failureReasons).map(([reason, count]) => `- ${reason}: ${count}`)),
    "",
    "Report contains aggregate stages only; input paths, commands, and raw logs are omitted."
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(args) {
  const options = { inputs: [], report: null, markdown: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--input") {
      options.inputs.push(resolveRequired(args[++index], "--input"));
    } else if (arg.startsWith("--input=")) {
      options.inputs.push(resolveRequired(arg.slice("--input=".length), "--input"));
    } else if (arg === "--report") {
      options.report = resolveRequired(args[++index], "--report");
    } else if (arg.startsWith("--report=")) {
      options.report = resolveRequired(arg.slice("--report=".length), "--report");
    } else if (arg === "--markdown") {
      options.markdown = resolveRequired(args[++index], "--markdown");
    } else if (arg.startsWith("--markdown=")) {
      options.markdown = resolveRequired(arg.slice("--markdown=".length), "--markdown");
    } else {
      throw new Error("Unknown beta funnel argument");
    }
  }
  if (options.inputs.length === 0 && !options.help) throw new Error("At least one --input is required");
  return options;
}

function resolveRequired(value, flag) {
  if (!value) throw new Error(`${flag} requires a path`);
  return path.resolve(process.cwd(), value);
}

function readInput(file, index) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Malformed JSON in beta evidence input ${index + 1}`);
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function usage() {
  return "node scripts/beta-funnel.js --input evidence.json [--input failure.json ...] [--report report.json] [--markdown report.md]";
}

if (process.argv[1] === import.meta.filename) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, usage: usage() }));
    } else {
      const report = buildBetaFunnel(options.inputs.map(readInput));
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (options.report) writeFile(options.report, json);
      if (options.markdown) writeFile(options.markdown, renderBetaFunnelMarkdown(report));
      console.log(json.trimEnd());
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      protocolVersion: PROTOCOL_VERSION,
      error: { code: "BETA_FUNNEL_INPUT_INVALID", message: error.message }
    }, null, 2));
    process.exitCode = 1;
  }
}
