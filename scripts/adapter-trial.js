#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.adapter-trial.v1";
const VALID_HOSTS = ["codex", "claude", "cursor", "windsurf", "agents-md", "other"];
const usage = "node scripts/adapter-trial.js --input trial.json [--report report.json] [--markdown report.md]";

export function scoreAdapterTrial(trial) {
  const normalized = normalizeTrial(trial);
  const commandTexts = normalized.commands.map((entry) => entry.command);
  const firstAgentShellIndex = commandTexts.findIndex(isAgentShellCommand);
  const firstRawNoiseIndex = commandTexts.findIndex(isNoisyRawCommand);
  const fastFixIndex = commandTexts.findIndex(isFastFixCommand);
  const verificationIndex = commandTexts.findIndex(isVerificationCommand);
  const statusIndex = commandTexts.findIndex(isStatusCommand);
  const compactCommandCount = commandTexts.filter(isCompactAgentShellCommand).length;
  const broadReadCount = commandTexts.filter(isBroadReadCommand).length;
  const totalOutputTokens = sumNumber(normalized.commands, "outputTokens");
  const totalDurationMs = sumNumber(normalized.commands, "durationMs");

  const criteria = {
    firstTwoCommands: criterion(
      25,
      firstAgentShellIndex >= 0 && firstAgentShellIndex < 2 ? 25 : 0,
      firstAgentShellIndex >= 0
        ? `first AgentShell command at position ${firstAgentShellIndex + 1}`
        : "no AgentShell command recorded"
    ),
    fastRepairPath: criterion(
      20,
      fastFixIndex >= 0 && (firstRawNoiseIndex === -1 || fastFixIndex < firstRawNoiseIndex) ? 20 : 0,
      fastFixIndex >= 0
        ? `fast fix command at position ${fastFixIndex + 1}`
        : "no agentshell fix test --fast --compact command recorded"
    ),
    compactContext: criterion(
      15,
      compactCommandCount > 0 && broadReadCount === 0 ? 15 : compactCommandCount > 0 ? 8 : 0,
      compactCommandCount > 0
        ? `${compactCommandCount} compact AgentShell command(s), ${broadReadCount} broad read(s)`
        : "no compact AgentShell context command recorded"
    ),
    verification: criterion(
      15,
      verificationIndex >= 0 || normalized.finalVerification?.ok === true ? 15 : 0,
      verificationIndex >= 0
        ? `verification command at position ${verificationIndex + 1}`
        : normalized.finalVerification?.ok === true
          ? "final verification marked ok"
          : "no verification command or final verification result recorded"
    ),
    safety: criterion(
      15,
      hasSafetySignal(normalized, statusIndex) ? 15 : 0,
      hasSafetySignal(normalized, statusIndex)
        ? "rollback, undo, status, dry-run, or no-edit safety signal recorded"
        : "no safety or rollback signal recorded"
    ),
    noiseControl: criterion(
      10,
      firstRawNoiseIndex === -1 || (firstAgentShellIndex >= 0 && firstAgentShellIndex < firstRawNoiseIndex) ? 10 : 0,
      firstRawNoiseIndex === -1
        ? "no noisy raw command recorded"
        : `first noisy raw command at position ${firstRawNoiseIndex + 1}`
    )
  };

  const score = Object.values(criteria).reduce((total, entry) => total + entry.points, 0);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    host: normalized.host,
    fixture: normalized.fixture,
    score,
    interpretation: interpretScore(score),
    criteria,
    metrics: {
      commandCount: normalized.commands.length,
      agentShellCommandCount: commandTexts.filter(isAgentShellCommand).length,
      noisyRawCommandCount: commandTexts.filter(isNoisyRawCommand).length,
      firstAgentShellCommandIndex: firstAgentShellIndex === -1 ? null : firstAgentShellIndex,
      firstNoisyRawCommandIndex: firstRawNoiseIndex === -1 ? null : firstRawNoiseIndex,
      totalOutputTokens,
      totalDurationMs,
      averageOutputTokensPerCommand: normalized.commands.length > 0 ? Math.round(totalOutputTokens / normalized.commands.length) : 0,
      averageDurationMsPerCommand: normalized.commands.length > 0 ? Math.round(totalDurationMs / normalized.commands.length) : 0
    },
    commands: normalized.commands,
    finalVerification: normalized.finalVerification,
    notes: normalized.notes
  };
}

function parseArgs(args) {
  let input = null;
  let report = null;
  let markdown = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--input") {
      input = path.resolve(process.cwd(), requireValue(args[index + 1], "--input"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--input=")) {
      input = path.resolve(process.cwd(), requireValue(arg.slice("--input=".length), "--input"));
      continue;
    }
    if (arg === "--report") {
      report = path.resolve(process.cwd(), requireValue(args[index + 1], "--report"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--report=")) {
      report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
      continue;
    }
    if (arg === "--markdown") {
      markdown = path.resolve(process.cwd(), requireValue(args[index + 1], "--markdown"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--markdown=")) {
      markdown = path.resolve(process.cwd(), requireValue(arg.slice("--markdown=".length), "--markdown"));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!input) throw new Error("--input is required");
  return { input, report, markdown };
}

function requireValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readTrial(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeTrial(trial) {
  if (!trial || typeof trial !== "object") throw new Error("Trial input must be an object");
  const host = typeof trial.host === "string" ? trial.host : "other";
  if (!VALID_HOSTS.includes(host)) throw new Error(`Unsupported host: ${host}`);
  const commands = Array.isArray(trial.commands) ? trial.commands.map(normalizeCommand) : [];
  if (commands.length === 0) throw new Error("Trial input requires at least one command");
  return {
    host,
    fixture: typeof trial.fixture === "string" ? trial.fixture : null,
    commands,
    finalVerification: normalizeFinalVerification(trial.finalVerification),
    notes: typeof trial.notes === "string" ? trial.notes : null
  };
}

function normalizeCommand(command) {
  if (typeof command === "string") {
    return {
      command,
      outputTokens: 0,
      durationMs: 0
    };
  }
  if (!command || typeof command !== "object" || typeof command.command !== "string") {
    throw new Error("Each command must be a string or an object with a command string");
  }
  return {
    command: command.command,
    outputTokens: numberOrZero(command.outputTokens),
    durationMs: numberOrZero(command.durationMs)
  };
}

function normalizeFinalVerification(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: value.ok === true,
    command: typeof value.command === "string" ? value.command : null,
    summary: typeof value.summary === "string" ? value.summary : null
  };
}

function numberOrZero(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function sumNumber(entries, field) {
  return entries.reduce((total, entry) => total + numberOrZero(entry[field]), 0);
}

function criterion(max, points, reason) {
  return { points, max, ok: points === max, reason };
}

function isAgentShellCommand(command) {
  return /\b(agentshell|ashell|bin\/agentshell|src\/cli\.js)\b/.test(command);
}

function isCompactAgentShellCommand(command) {
  return isAgentShellCommand(command) && (
    command.includes("--compact") ||
    /\bagentshell (find|read|run next|verify test|manual --topic)\b/.test(command)
  );
}

function isFastFixCommand(command) {
  return isAgentShellCommand(command) && /\bfix test\b/.test(command) && command.includes("--fast") && command.includes("--compact");
}

function isVerificationCommand(command) {
  return isAgentShellCommand(command) && /\bverify test\b/.test(command);
}

function isStatusCommand(command) {
  return isAgentShellCommand(command) && /\brun status\b/.test(command);
}

function isNoisyRawCommand(command) {
  return /\bnpm test\b|\bpnpm test\b|\byarn test\b|\bgrep\b|\brg\b|\bcat\b|\bfind\s+\./.test(command) && !isAgentShellCommand(command);
}

function isBroadReadCommand(command) {
  return /\bcat\b|\bsed -n\b|\bnl -ba\b/.test(command) && !isAgentShellCommand(command);
}

function hasSafetySignal(trial, statusIndex) {
  if (statusIndex >= 0) return true;
  if (trial.commands.some((entry) => /--dry-run|\bundo\b|\brun status\b/.test(entry.command))) return true;
  const text = [trial.notes, trial.finalVerification?.summary].filter(Boolean).join("\n").toLowerCase();
  return /\brollback\b|\bundo\b|\bno edit\b|\bno changes?\b|\bdry-run\b/.test(text);
}

function interpretScore(score) {
  if (score >= 85) return "strong";
  if (score >= 65) return "usable";
  return "weak";
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

function renderMarkdownReport(report) {
  const lines = [
    "# AgentShell Adapter Trial Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Host: ${report.host}`,
    `Fixture: ${report.fixture || "-"}`,
    `Score: ${report.score}/100 (${report.interpretation})`,
    "",
    "## Criteria",
    "",
    "| Criterion | Points | Max | Reason |",
    "|---|---:|---:|---|",
    ...Object.entries(report.criteria).map(([name, entry]) => (
      `| ${tableCell(name)} | ${entry.points} | ${entry.max} | ${tableCell(entry.reason)} |`
    )),
    "",
    "## Metrics",
    "",
    `- Commands: ${report.metrics.commandCount}`,
    `- AgentShell commands: ${report.metrics.agentShellCommandCount}`,
    `- Noisy raw commands: ${report.metrics.noisyRawCommandCount}`,
    `- Total output tokens: ${report.metrics.totalOutputTokens}`,
    `- Total duration: ${report.metrics.totalDurationMs}ms`,
    "",
    "## Commands",
    "",
    "| # | Command | Output tokens | Duration ms |",
    "|---:|---|---:|---:|",
    ...report.commands.map((command, index) => (
      `| ${index + 1} | ${tableCell(command.command)} | ${command.outputTokens} | ${command.durationMs} |`
    ))
  ];

  if (report.notes) {
    lines.push("", "## Notes", "", report.notes);
  }

  return lines.join("\n");
}

function tableCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

if (process.argv[1] === import.meta.filename) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(JSON.stringify({ ok: true, usage }));
    process.exit(0);
  }

  const report = scoreAdapterTrial(readTrial(options.input));
  if (options.report) writeJsonFile(options.report, report);
  if (options.markdown) writeTextFile(options.markdown, renderMarkdownReport(report));
  console.log(JSON.stringify(report, null, 2));
}
