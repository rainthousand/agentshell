#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const PROTOCOL_VERSION = "agentshell.product-readiness.v1";

const BLOCKING = "blocking";
const WARNING = "warning";

const REQUIRED_FILES = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/quickstart.md",
  "docs/support.md",
  "docs/compatibility.md",
  "docs/release-notes-v1.0.md",
  "docs/product-status-pm.html",
  "docs/product-boundary.md",
  "docs/codex-plugin-flow.md",
  "docs/codex-beta-evidence.md",
  "docs/external-beta-playbook.md",
  "docs/standalone.md",
  "docs/dashboard.md",
  "docs/protocol.md",
  "docs/workflows/README.md",
  "docs/workflows/onboarding.md",
  "docs/workflows/log-triage.md",
  "docs/adapters/README.md",
  "docs/adapters/trial-suite.md",
  "docs/adapters/trial-suite-playbook.md",
  "skills/agentshell/SKILL.md",
  "scripts/plugin-smoke.js",
  "scripts/plugin-activation-smoke.js",
  "scripts/plugin-release-local.js",
  "scripts/share-package.js",
  "scripts/install-agent-policy.js",
  "scripts/adapter-trial.js",
  "scripts/adapter-trial-collect.js",
  "scripts/adapter-trial-suite.js",
  "scripts/codex-plugin-trial.js",
  "scripts/codex-plugin-trial-collect.js",
  "scripts/codex-plugin-trial-template.js",
  "scripts/codex-plugin-trial-plan.js",
  "scripts/codex-plugin-trial-suite.js",
  "scripts/beta-funnel.js",
  "scripts/performance-summary.js",
  "src/core/workspace-registry.js",
  "src/core/package-root.js",
  "src/core/dashboard-service.js",
  "src/core/support-bundle.js",
  "src/commands/setup-codex.js",
  "src/commands/dashboard.js",
  "src/dashboard/index.html",
  "src/dashboard/styles.css",
  "src/dashboard/app.js",
  "desktop/macos/AgentShellDashboard.swift",
  "desktop/macos/AgentShellCLI.entitlements",
  "desktop/macos/dist/AgentShell Dashboard.app/Contents/MacOS/AgentShellDashboard",
  "scripts/build-dashboard-app.js",
  "scripts/build-standalone.js",
  "scripts/prepare-test-standalone.js",
  "scripts/plugin-lifecycle.js",
  "scripts/security-scan.js",
  "scripts/product-readiness.js",
  "scripts/product-readiness-cli.js",
  "scripts/release-gate.js",
  "scripts/release-artifacts.js",
  "scripts/package-lifecycle-smoke.js",
  "scripts/v1-clean-machine-smoke.js",
  "scripts/support-bundle.js",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "CHANGELOG.md",
  "LICENSE",
  "scripts/strategy-intake.js",
  "examples/failing-test-demo/package.json",
  "examples/noisy-test-demo/package.json",
  "examples/adapter-trial-suite.sample.json",
  "examples/codex-plugin-effect.sample.json",
  "examples/codex-plugin-new-thread.sample.json",
  "examples/codex-plugin-suite.sample.json",
  "examples/strategy-intake.sample.json",
  "examples/beta-failure.sample.json",
  "examples/beta-success.sample.json",
  "schemas/manual.schema.json",
  "schemas/plugin-validate.schema.json",
  "schemas/plugin-smoke.schema.json",
  "schemas/adapter-trial-suite.schema.json",
  "schemas/codex-plugin-trial.schema.json",
  "schemas/codex-plugin-trial-template.schema.json",
  "schemas/codex-plugin-trial-plan.schema.json",
  "schemas/codex-plugin-trial-suite.schema.json",
  "schemas/trial-export.schema.json",
  "schemas/trial-status.schema.json",
  "schemas/beta-funnel.schema.json",
  "schemas/dashboard.schema.json",
  "schemas/strategy-intake.schema.json",
  "schemas/product-readiness.schema.json"
];

const REQUIRED_PACKAGE_SCRIPTS = [
  "plugin:validate",
  "plugin:validate:source",
  "plugin:smoke",
  "plugin:activation-smoke",
  "plugin:release-local",
  "install:codex",
  "update:codex",
  "uninstall:codex",
  "doctor:codex",
  "install:agent-policy",
  "security:scan",
  "release:gate",
  "release:artifacts",
  "v1:smoke",
  "support:bundle",
  "package:lifecycle:smoke",
  "adapter:trial",
  "adapter:trial:collect",
  "adapter:trial:suite",
  "product:readiness",
  "product:readiness:heavy",
  "performance:summary",
  "dashboard",
  "dashboard:build-app",
  "build:standalone",
  "share:package",
  "codex:plugin:trial",
  "codex:plugin:collect",
  "codex:plugin:template",
  "codex:plugin:plan",
  "codex:plugin:suite",
  "codex:plugin:export",
  "beta:funnel",
  "strategy:intake",
  "eval:real-project-candidates",
  "eval:real-projects"
];

const HEAVY_COMMANDS = [
  { id: "release-artifacts", name: "Release package lifecycle", command: ["npm", "run", "release:artifacts"] },
  { id: "plugin-activation-smoke", name: "Plugin activation smoke", command: ["npm", "run", "plugin:activation-smoke"] },
  { id: "benchmark-suite-ci", name: "Benchmark suite CI thresholds", command: ["npm", "run", "benchmark:suite:ci"] },
  { id: "benchmark-cache", name: "Cache benchmark", command: ["npm", "run", "benchmark:cache"] },
  { id: "benchmark-cold-start", name: "Cold-start benchmark", command: ["npm", "run", "benchmark:cold-start"] },
  { id: "strategy-coverage", name: "Strategy coverage", command: ["npm", "run", "strategy:coverage"] },
  { id: "codex-plugin-trial", name: "Codex plugin effect trial", command: ["npm", "run", "codex:plugin:trial"] },
  { id: "strategy-intake", name: "Strategy intake sample", command: ["npm", "run", "strategy:intake", "--", "--input", "examples/strategy-intake.sample.json"] }
];

const REQUIRED_MANUAL_TOPICS = [
  "repair",
  "plugin",
  "benchmark",
  "profile",
  "onboarding",
  "log-triage",
  "reference"
];

const REQUIRED_SCHEMA_NAMES = [
  "manual",
  "plugin-validate",
  "plugin-smoke",
  "adapter-trial",
  "adapter-trial-collect",
  "adapter-trial-suite",
  "codex-plugin-trial",
  "codex-plugin-trial-template",
  "codex-plugin-trial-plan",
  "codex-plugin-trial-suite",
  "trial-export",
  "trial-status",
  "beta-funnel",
  "dashboard",
  "strategy-intake",
  "product-readiness"
];

export function buildProductReadinessReport(projectRoot = root, options = {}) {
  const checks = [
    checkRequiredFiles(projectRoot),
    checkPackageScripts(projectRoot),
    checkSchemaRegistry(projectRoot),
    checkManualTopics(projectRoot),
    checkAgentFacingGuidance(projectRoot),
    checkReadmeEntryPoints(projectRoot),
    checkSharePackage(projectRoot),
    checkProductBoundary(projectRoot),
    checkEvidenceDocs(projectRoot),
    checkDeferredMcp(projectRoot)
  ];
  if (options.heavy) {
    checks.push(...checkHeavyCommands(projectRoot, options));
  }

  return {
    ok: checks.every((check) => check.status === "pass" || check.severity === WARNING),
    protocolVersion: PROTOCOL_VERSION,
    mode: options.heavy ? (options.dryRun ? "heavy-dry-run" : "heavy") : "standard",
    generatedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === "fail" && check.severity === BLOCKING)
      ? "blocked"
      : "ready",
    summary: summarize(checks),
    checks
  };
}

function checkSharePackage(projectRoot) {
  const packageJson = readJson(projectRoot, "package.json");
  const docs = [
    "README.md",
    "docs/quickstart.md",
    "docs/codex-plugin-flow.md"
  ];
  const missingDocs = docs.filter((file) => !readText(projectRoot, file).includes("share:package"));
  return check({
    id: "share-package",
    name: "Share package is available for real-user handoff",
    severity: BLOCKING,
    status: packageJson.scripts?.["share:package"] === "node scripts/share-package.js" && missingDocs.length === 0
      ? "pass"
      : "fail",
    details: {
      script: packageJson.scripts?.["share:package"] || null,
      missingDocs
    }
  });
}

function checkHeavyCommands(projectRoot, options) {
  return HEAVY_COMMANDS.map((entry) => {
    if (options.dryRun) {
      return check({
        id: entry.id,
        name: entry.name,
        severity: BLOCKING,
        status: "pass",
        details: {
          dryRun: true,
          command: entry.command.join(" ")
        }
      });
    }
    const started = Date.now();
    const result = spawnSync(entry.command[0], entry.command.slice(1), {
      cwd: projectRoot,
      encoding: "utf8"
    });
    return check({
      id: entry.id,
      name: entry.name,
      severity: BLOCKING,
      status: result.status === 0 ? "pass" : "fail",
      details: {
        command: entry.command.join(" "),
        status: result.status,
        durationMs: Date.now() - started,
        stdout: trim(result.stdout),
        stderr: trim(result.stderr),
        error: result.error?.message
      }
    });
  });
}

function checkRequiredFiles(projectRoot) {
  const missing = REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(projectRoot, file)));
  return check({
    id: "required-files",
    name: "Required product files exist",
    severity: BLOCKING,
    status: missing.length === 0 ? "pass" : "fail",
    details: {
      required: REQUIRED_FILES,
      missing
    }
  });
}

function checkPackageScripts(projectRoot) {
  const packageJson = readJson(projectRoot, "package.json");
  const missing = REQUIRED_PACKAGE_SCRIPTS.filter((script) => !packageJson.scripts?.[script]);
  return check({
    id: "package-scripts",
    name: "Package scripts expose product gates",
    severity: BLOCKING,
    status: missing.length === 0 ? "pass" : "fail",
    details: {
      required: REQUIRED_PACKAGE_SCRIPTS,
      missing
    }
  });
}

function checkSchemaRegistry(projectRoot) {
  const source = readText(projectRoot, "src/commands/schema.js");
  const missing = REQUIRED_SCHEMA_NAMES.filter((name) => !source.includes(`"${name}"`));
  return check({
    id: "schema-registry",
    name: "Schema registry exposes integration contracts",
    severity: BLOCKING,
    status: missing.length === 0 ? "pass" : "fail",
    details: {
      required: REQUIRED_SCHEMA_NAMES,
      missing
    }
  });
}

function checkManualTopics(projectRoot) {
  const schema = readJson(projectRoot, "schemas/manual.schema.json");
  const topicEnums = new Set([
    ...(schema.oneOf?.[1]?.properties?.topic?.enum ?? []),
    ...(schema.$defs?.topicEntry?.properties?.name?.enum ?? [])
  ]);
  const source = readText(projectRoot, "src/commands/manual.js");
  const missingFromSchema = REQUIRED_MANUAL_TOPICS.filter((topic) => !topicEnums.has(topic));
  const missingFromSource = REQUIRED_MANUAL_TOPICS.filter((topic) => !source.includes(`"${topic}"`));
  return check({
    id: "manual-topics",
    name: "Manual exposes focused agent workflows",
    severity: BLOCKING,
    status: missingFromSchema.length === 0 && missingFromSource.length === 0 ? "pass" : "fail",
    details: {
      required: REQUIRED_MANUAL_TOPICS,
      missingFromSchema,
      missingFromSource
    }
  });
}

function checkAgentFacingGuidance(projectRoot) {
  const files = [
    "skills/agentshell/SKILL.md",
    "docs/agent/codex.md",
    "docs/adapters/README.md"
  ];
  const requiredText = [
    "agentshell start --compact",
    "agentshell manual --topic repair",
    "agentshell manual --topic onboarding",
    "agentshell manual --topic log-triage",
    "agentshell manual --full"
  ];
  const missing = [];
  for (const file of files) {
    const text = readText(projectRoot, file);
    for (const needle of requiredText) {
      if (!text.includes(needle) && !text.includes("agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference")) {
        missing.push({ file, text: needle });
      }
    }
  }
  return check({
    id: "agent-facing-guidance",
    name: "Agent-facing docs prefer compact AgentShell workflows",
    severity: BLOCKING,
    status: missing.length === 0 ? "pass" : "fail",
    details: { missing }
  });
}

function checkReadmeEntryPoints(projectRoot) {
  const readme = readText(projectRoot, "README.md");
  const requiredText = [
    "docs/quickstart.md",
    "docs/product-status-pm.html",
    "Codex Plugin Flow",
    "Adapter Guides",
    "agentshell fix test --fast --compact",
    "agentshell manual --topic onboarding",
    "agentshell manual --topic log-triage"
  ];
  const missing = requiredText.filter((needle) => !readme.includes(needle));
  return check({
    id: "readme-entry-points",
    name: "README gives PM and developer entry points",
    severity: BLOCKING,
    status: missing.length === 0 ? "pass" : "fail",
    details: {
      requiredText,
      missing
    }
  });
}

function checkProductBoundary(projectRoot) {
  const boundary = readText(projectRoot, "docs/product-boundary.md");
  const readme = readText(projectRoot, "README.md");
  const requiredText = [
    "In Scope",
    "Out Of Scope",
    "Fallback To Shell",
    "v0.25",
    "v1.0",
    "MCP remains low-priority"
  ];
  const missing = requiredText.filter((needle) => !boundary.includes(needle));
  if (!readme.includes("docs/product-boundary.md")) missing.push("README link to docs/product-boundary.md");
  return check({
    id: "product-boundary",
    name: "Product boundary and freeze criteria are documented",
    severity: BLOCKING,
    status: missing.length === 0 ? "pass" : "fail",
    details: { missing }
  });
}

function checkEvidenceDocs(projectRoot) {
  const productStatus = readText(projectRoot, "docs/product-status-pm.html");
  const quickstart = readText(projectRoot, "docs/quickstart.md");
  const missing = [];
  for (const needle of ["token", "speed", "adapter:trial:suite", "Product status"]) {
    if (!productStatus.toLowerCase().includes(needle.toLowerCase()) && !quickstart.toLowerCase().includes(needle.toLowerCase())) {
      missing.push(needle);
    }
  }
  return check({
    id: "evidence-docs",
    name: "Product evidence docs cover measurable outcomes",
    severity: WARNING,
    status: missing.length === 0 ? "pass" : "fail",
    details: { missing }
  });
}

function checkDeferredMcp(projectRoot) {
  const mcp = readText(projectRoot, "docs/mcp-interface.md");
  const adapters = readText(projectRoot, "docs/adapters/README.md");
  const hasDeferredLanguage = /low-priority|later|deferred/i.test(mcp) || /low-priority|later|deferred/i.test(adapters);
  return check({
    id: "deferred-mcp",
    name: "MCP remains deferred behind local CLI/plugin flow",
    severity: WARNING,
    status: hasDeferredLanguage ? "pass" : "fail",
    details: {
      expected: "Docs should keep MCP behind the local CLI/plugin path for this phase."
    }
  });
}

function summarize(checks) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === "pass").length,
    failed: checks.filter((check) => check.status === "fail").length,
    blockingFailed: checks.filter((check) => check.status === "fail" && check.severity === BLOCKING).length,
    warningsFailed: checks.filter((check) => check.status === "fail" && check.severity === WARNING).length
  };
}

function check(entry) {
  return {
    id: entry.id,
    name: entry.name,
    severity: entry.severity,
    status: entry.status,
    details: entry.details
  };
}

function readJson(projectRoot, relativePath) {
  return JSON.parse(readText(projectRoot, relativePath));
}

function readText(projectRoot, relativePath) {
  const file = path.join(projectRoot, relativePath);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

export function renderProductReadinessMarkdown(report) {
  const lines = [
    `# AgentShell Product Readiness`,
    "",
    `Status: \`${report.status}\``,
    `Mode: \`${report.mode}\``,
    "",
    `Summary: ${report.summary.passed}/${report.summary.total} checks passed, ${report.summary.blockingFailed} blocking failures, ${report.summary.warningsFailed} warning failures.`,
    "",
    "| Check | Severity | Status |",
    "|---|---|---|"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.name} | ${check.severity} | ${check.status} |`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    markdown: argv.includes("--markdown"),
    heavy: argv.includes("--heavy"),
    dryRun: argv.includes("--dry-run")
  };
}

export function runProductReadinessCli(argv = process.argv.slice(2), io = {}) {
  const options = parseArgs(argv);
  const write = io.write || ((value) => process.stdout.write(value));
  if (options.help) {
    write(`${JSON.stringify({
      ok: true,
      usage: "node scripts/product-readiness-cli.js [--markdown] [--heavy] [--dry-run]"
    }, null, 2)}\n`);
    return 0;
  }

  const report = buildProductReadinessReport(root, options);
  write(options.markdown
    ? renderProductReadinessMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

function trim(text = "") {
  return String(text).trim().slice(0, 2000);
}
