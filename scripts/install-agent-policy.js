#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- agentshell-policy:start -->";
const END = "<!-- agentshell-policy:end -->";
const DEFAULT_TARGET = path.join(os.homedir(), ".codex", "AGENTS.md");

const POLICY = [
  START,
  "# AgentShell Default Policy",
  "",
  "For coding work, prefer AgentShell before noisy raw shell commands when the `agentshell` CLI is available.",
  "",
  "- Start fresh repositories with `agentshell start --compact`.",
  "- For supported failing tests, try `agentshell fix test --fast --compact` before split manual repair.",
  "- Use `agentshell verify test` for compact verification output.",
  "- Use `agentshell run status --compact` to inspect task state, rollback guidance, command count, and token estimates.",
  "- Use `agentshell read <file> --lines A:B` or `agentshell read <file> --around <query>` instead of reading whole large files.",
  "- Use `agentshell log get <logRef> --tail N` only when compact summaries are insufficient.",
  "- Treat AgentShell JSON as the source of truth; fall back to ordinary shell commands only when AgentShell does not support the needed action.",
  "",
  "Recommended first pass:",
  "",
  "```bash",
  "agentshell start --compact",
  "agentshell fix test --fast --compact",
  "agentshell run status --compact",
  "```",
  END
].join("\n");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    printArgumentError(error, process.argv.slice(2));
    process.exit(1);
  }

  if (args.help) {
    console.log(JSON.stringify({
      ok: true,
      usage: "node scripts/install-agent-policy.js [--target ~/.codex/AGENTS.md] [--dry-run] [--json]"
    }, null, 2));
    process.exit(0);
  }

  const report = installAgentPolicy(args.target, {
    dryRun: args.dryRun
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
}

export function installAgentPolicy(target = DEFAULT_TARGET, options = {}) {
  const resolvedTarget = path.resolve(expandHome(target));
  const before = fs.existsSync(resolvedTarget) ? fs.readFileSync(resolvedTarget, "utf8") : "";
  const after = upsertPolicy(before);
  const changed = before !== after;

  if (!options.dryRun && changed) {
    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    fs.writeFileSync(resolvedTarget, after.endsWith("\n") ? after : `${after}\n`);
  }

  return {
    ok: true,
    protocolVersion: "agentshell.agent-policy-install.v1",
    target: resolvedTarget,
    dryRun: Boolean(options.dryRun),
    status: changed ? (options.dryRun ? "would-update" : "updated") : "unchanged",
    changed
  };
}

function upsertPolicy(text) {
  const normalized = String(text || "").replace(/\s+$/u, "");
  const startIndex = normalized.indexOf(START);
  const endIndex = normalized.indexOf(END);

  if (startIndex >= 0 && endIndex > startIndex) {
    const before = normalized.slice(0, startIndex).trimEnd();
    const after = normalized.slice(endIndex + END.length).trimStart();
    return joinSections([before, POLICY, after]);
  }

  return joinSections([normalized, POLICY]);
}

function joinSections(sections) {
  return `${sections.filter((section) => section && section.trim()).join("\n\n")}\n`;
}

function parseArgs(argv) {
  const parsed = {
    target: DEFAULT_TARGET,
    dryRun: false,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--target") {
      parsed.target = requireValue(argv[index + 1], "--target");
      index += 1;
    } else if (arg.startsWith("--target=")) {
      parsed.target = requireValue(arg.slice("--target=".length), "--target");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function printHumanReport(report) {
  console.log("AgentShell Codex policy");
  console.log("=======================");
  if (report.dryRun) {
    console.log(`Preview only: ${report.status} ${report.target}`);
    console.log("No file was changed.");
    return;
  }

  if (report.status === "unchanged") {
    console.log(`Already configured: ${report.target}`);
  } else {
    console.log(`Configured: ${report.target}`);
  }
  console.log("No manual paste step is needed. New Codex coding threads can use the AgentShell policy automatically.");
}

function printArgumentError(error, argv) {
  if (argv.includes("--json")) {
    console.log(JSON.stringify({
      ok: false,
      protocolVersion: "agentshell.agent-policy-install.v1",
      dryRun: argv.includes("--dry-run"),
      error: error.message,
      nextActions: [
        "Run node scripts/install-agent-policy.js --help to see supported flags."
      ]
    }, null, 2));
    return;
  }

  console.error(`Policy install option error: ${error.message}`);
  console.error("Run `node scripts/install-agent-policy.js --help` to see supported flags.");
}
