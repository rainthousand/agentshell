#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { pluginStatus } from "../src/commands/plugin-status.js";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPT_PROTOCOL_VERSION = "agentshell.plugin-doctor-local.v1";

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(formatHelp(args.format));
    process.exit(0);
  }

  const report = pluginStatus(args.root, {
    home: args.home,
    marketplace: args.marketplace,
    cacheRoot: args.cacheRoot,
    protocolVersion: SCRIPT_PROTOCOL_VERSION
  });
  const enrichedReport = enrichReport(report);
  console.log(formatReport(enrichedReport, args.format));
  if (!enrichedReport.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {
    root,
    home: os.homedir(),
    format: "json"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      parsed.root = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--home") {
      parsed.home = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--marketplace") {
      parsed.marketplace = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--cache-root") {
      parsed.cacheRoot = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      parsed.format = "markdown";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.root = path.resolve(parsed.root);
  parsed.home = path.resolve(parsed.home);
  if (parsed.marketplace) parsed.marketplace = path.resolve(parsed.marketplace);
  if (parsed.cacheRoot) parsed.cacheRoot = path.resolve(parsed.cacheRoot);
  return parsed;
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return value;
}

function formatReport(report, format = "json") {
  return format === "markdown"
    ? formatMarkdownReport(report)
    : JSON.stringify(report, null, 2);
}

function enrichReport(report) {
  return {
    ...report,
    primaryNextAction: primaryNextActionFor(report)
  };
}

function primaryNextActionFor(report) {
  if (report.ok && report.summary?.warnings === 0) return null;
  const actions = report.suggestedNextActions || [];
  const installAction = actions.find((action) => action.includes("npm run plugin:install-local"));
  const codexAddAction = actions.find((action) => action.includes("codex plugin add agentshell@personal"));
  return installAction || codexAddAction || actions[0] || null;
}

function formatMarkdownReport(report) {
  const lines = [
    "# Agentshell Plugin Doctor Local",
    "",
    `Status: ${report.ok ? "PASS" : "FAIL"}`,
    `Plugin: \`${report.plugin.name || "unknown"}@${report.plugin.version || "unknown"}\``,
    `Manifest: \`${report.paths.manifest}\``,
    `Marketplace: \`${report.paths.marketplace}\``,
    `Cache: \`${report.paths.cachePath || "unknown"}\``,
    `Checks: ${report.summary.passed}/${report.summary.total} passed`
  ];

  if (report.summary.failed > 0) lines.push(`Failed: ${report.summary.failed}`);
  if (report.summary.warnings > 0) lines.push(`Warnings: ${report.summary.warnings}`);
  if (report.primaryNextAction) lines.push(`Primary next action: ${report.primaryNextAction}`);

  lines.push("", "## Checks", "");
  for (const check of report.checks) {
    const marker = check.ok ? "[x]" : check.severity === "warning" ? "[!]" : "[ ]";
    lines.push(`- ${marker} ${check.name}`);
    if (!check.ok && check.error) lines.push(`  Error: ${check.error}`);
    for (const action of check.suggestedNextActions || []) {
      lines.push(`  Suggested: ${action}`);
    }
  }

  return lines.join("\n");
}

function formatHelp(format = "json") {
  const help = {
    ok: true,
    usage: "node scripts/plugin-doctor-local.js [--root <repo>] [--home <home>] [--marketplace <path>] [--cache-root <path>] [--markdown]",
    output: "Default output is JSON. Add --markdown for a readable report."
  };
  return format === "markdown"
    ? [
        "# Agentshell Plugin Doctor Local",
        "",
        `Usage: \`${help.usage}\``,
        "",
        help.output
      ].join("\n")
    : JSON.stringify(help);
}
