#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.codex-plugin-trial-template.v1";
const DEFAULT_ID = "codex-new-thread-run";
const DEFAULT_FIXTURE = "examples/failing-test-demo";
const usage = "node scripts/codex-plugin-trial-template.js [--id run-id] [--fixture path] [--report report.json] [--json run-log.json] [--markdown form.md]";

export function buildCodexPluginTrialTemplate(options = {}) {
  const id = safeText(options.id, DEFAULT_ID);
  const fixture = safeText(options.fixture, DEFAULT_FIXTURE);
  const jsonTemplate = buildRunLogTemplate({ id, fixture });
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    id,
    fixture,
    jsonTemplate,
    markdown: renderMarkdownForm(jsonTemplate),
    nextActions: [
      "Open a fresh Codex thread with the AgentShell plugin installed.",
      "Ask Codex to solve the target fixture and copy each AgentShell command, compact stdout, and duration into the JSON template.",
      "Run npm run codex:plugin:collect -- --input <filled-run-log.json> --report artifacts/codex-plugin-real-run.json --markdown artifacts/codex-plugin-real-run.md"
    ]
  };
}

function buildRunLogTemplate({ id, fixture }) {
  return {
    id,
    host: "codex",
    fixture,
    source: "manual-new-thread-transcript",
    events: [
      {
        type: "command",
        command: "agentshell start --compact",
        stdout: "PASTE_COMPACT_JSON_STDOUT_HERE",
        durationMs: 0
      },
      {
        type: "command",
        command: "agentshell fix test --fast --compact",
        stdout: "PASTE_COMPACT_JSON_STDOUT_HERE",
        durationMs: 0
      },
      {
        type: "command",
        command: "agentshell run status --compact",
        stdout: "PASTE_COMPACT_JSON_STDOUT_HERE",
        durationMs: 0
      }
    ],
    finalVerification: {
      ok: true,
      command: "agentshell fix test --fast --compact",
      summary: "REPLACE_WITH_FINAL_VERIFICATION_SUMMARY"
    },
    notes: "Replace placeholders with the observed commands, compact stdout, and durations from a fresh Codex thread."
  };
}

function renderMarkdownForm(template) {
  return [
    "# Codex Plugin Real-Run Capture Form",
    "",
    `Run ID: \`${template.id}\``,
    `Fixture: \`${template.fixture}\``,
    "",
    "## Fresh Thread Checklist",
    "",
    "- [ ] Open a fresh Codex thread after installing the latest AgentShell plugin.",
    "- [ ] Ask Codex to use AgentShell first for the target fixture.",
    "- [ ] Record every command Codex ran before the final answer.",
    "- [ ] Paste compact JSON stdout snippets, not full raw terminal logs, unless Codex used raw commands.",
    "- [ ] Record approximate command duration in milliseconds when available.",
    "- [ ] Confirm the final verification outcome and rollback/safety signal.",
    "",
    "## Expected Strong Path",
    "",
    "1. `agentshell start --compact`",
    "2. `agentshell fix test --fast --compact`",
    "3. `agentshell run status --compact`",
    "",
    "## Fillable Run Log JSON",
    "",
    "```json",
    JSON.stringify(template, null, 2),
    "```",
    "",
    "## Score The Filled Log",
    "",
    "```bash",
    "npm run codex:plugin:collect -- --input filled-run-log.json --report artifacts/codex-plugin-real-run.json --markdown artifacts/codex-plugin-real-run.md",
    "```",
    ""
  ].join("\n");
}

function safeText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseArgs(args) {
  const parsed = {
    help: false,
    id: DEFAULT_ID,
    fixture: DEFAULT_FIXTURE,
    report: null,
    json: null,
    markdown: null
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--id") {
      parsed.id = requireValue(args[index + 1], "--id");
      index += 1;
    } else if (arg.startsWith("--id=")) {
      parsed.id = requireValue(arg.slice("--id=".length), "--id");
    } else if (arg === "--fixture") {
      parsed.fixture = requireValue(args[index + 1], "--fixture");
      index += 1;
    } else if (arg.startsWith("--fixture=")) {
      parsed.fixture = requireValue(arg.slice("--fixture=".length), "--fixture");
    } else if (arg === "--report") {
      parsed.report = path.resolve(process.cwd(), requireValue(args[index + 1], "--report"));
      index += 1;
    } else if (arg.startsWith("--report=")) {
      parsed.report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
    } else if (arg === "--json") {
      parsed.json = path.resolve(process.cwd(), requireValue(args[index + 1], "--json"));
      index += 1;
    } else if (arg.startsWith("--json=")) {
      parsed.json = path.resolve(process.cwd(), requireValue(arg.slice("--json=".length), "--json"));
    } else if (arg === "--markdown") {
      parsed.markdown = path.resolve(process.cwd(), requireValue(args[index + 1], "--markdown"));
      index += 1;
    } else if (arg.startsWith("--markdown=")) {
      parsed.markdown = path.resolve(process.cwd(), requireValue(arg.slice("--markdown=".length), "--markdown"));
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

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

if (process.argv[1] === import.meta.filename) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(JSON.stringify({ ok: true, usage }, null, 2));
    process.exit(0);
  }
  const report = buildCodexPluginTrialTemplate(options);
  if (options.report) writeFile(options.report, JSON.stringify(report, null, 2));
  if (options.json) writeFile(options.json, JSON.stringify(report.jsonTemplate, null, 2));
  if (options.markdown) writeFile(options.markdown, report.markdown);
  console.log(JSON.stringify(report, null, 2));
}
