import fs from "node:fs";
import path from "node:path";

import { testList } from "./test-list.js";

const PROTOCOL_VERSION = "agentshell.test-command.v1";

export async function testCommand(root, options = {}) {
  const projectRoot = path.resolve(root);
  const list = await testList(projectRoot, { compact: true, maxFiles: options.maxFiles || 20 });
  const commands = recommendCommands(projectRoot, list);
  const summary = {
    commandCount: commands.length,
    primaryCommand: commands[0]?.command || null,
    hasNode: list.summary.nodePackageCount > 0,
    hasGo: list.summary.goPackageCount > 0 || list.summary.goWorkspaceCount > 0,
    hasPython: list.summary.pythonPackageCount > 0,
    hasJava: list.summary.javaPackageCount > 0,
    hasTestFiles: list.summary.totalFiles > 0
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    summary,
    commands,
    risks: risksFor(projectRoot, list, summary),
    suggestedNextActions: commands.length > 0
      ? [{ command: commands[0].command, reason: "Run the highest-confidence detected test command when ready" }]
      : [{ command: "agentshell test list --compact", reason: "No runnable test command was detected; inspect discovered test files and project packages" }]
  };
}

function recommendCommands(projectRoot, list) {
  const commands = [];
  for (const script of list.scripts || []) {
    commands.push({
      command: script.runCommand,
      ecosystem: "node",
      source: "package.json",
      confidence: script.name === "test" ? "high" : "medium",
      reason: `Detected npm-compatible ${script.name} script`
    });
  }
  if (list.packages?.some((entry) => entry.type === "go-workspace")) {
    commands.push({
      command: "go test ./...",
      ecosystem: "go",
      source: "go.work",
      confidence: "high",
      reason: "Detected Go workspace; run all local packages from the workspace root"
    });
  } else if (list.packages?.some((entry) => entry.type === "go")) {
    commands.push({
      command: "go test ./...",
      ecosystem: "go",
      source: "go.mod",
      confidence: "high",
      reason: "Detected Go module"
    });
  }
  if (list.packages?.some((entry) => entry.type === "python")) {
    commands.push({
      command: preferredPythonCommand(projectRoot),
      ecosystem: "python",
      source: "python-manifest",
      confidence: "medium",
      reason: "Detected Python tests or project config"
    });
  }
  if (list.packages?.some((entry) => entry.type === "maven")) {
    commands.push({
      command: fs.existsSync(path.join(projectRoot, "mvnw")) ? "./mvnw test" : "mvn test",
      ecosystem: "java",
      source: "pom.xml",
      confidence: "high",
      reason: "Detected Maven project"
    });
  }
  if (list.packages?.some((entry) => entry.type === "gradle")) {
    commands.push({
      command: fs.existsSync(path.join(projectRoot, "gradlew")) ? "./gradlew test" : "gradle test",
      ecosystem: "java",
      source: "build.gradle",
      confidence: "high",
      reason: "Detected Gradle project"
    });
  }
  return dedupe(commands);
}

function preferredPythonCommand(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, "tox.ini"))) return "python -m tox";
  if (fs.existsSync(path.join(projectRoot, "pytest.ini")) || fs.existsSync(path.join(projectRoot, "pyproject.toml"))) return "python -m pytest";
  return "python -m pytest";
}

function risksFor(projectRoot, list, summary) {
  const risks = [];
  if (summary.commandCount === 0 && summary.hasTestFiles) {
    risks.push({
      type: "test-files-without-command",
      severity: "medium",
      message: "Test files were detected but no common runnable test command was found"
    });
  }
  if (summary.hasPython && !fs.existsSync(path.join(projectRoot, ".venv"))) {
    risks.push({
      type: "environment-dependent",
      severity: "low",
      message: "Python command may depend on the active virtual environment"
    });
  }
  if (summary.hasJava && !fs.existsSync(path.join(projectRoot, "mvnw")) && !fs.existsSync(path.join(projectRoot, "gradlew"))) {
    risks.push({
      type: "wrapper-missing",
      severity: "low",
      message: "Java command may depend on Maven or Gradle being installed globally"
    });
  }
  if (list.summary.truncated) {
    risks.push({
      type: "discovery-truncated",
      severity: "low",
      message: "Compact test discovery was truncated"
    });
  }
  return risks;
}

function dedupe(commands) {
  const seen = new Set();
  return commands.filter((entry) => {
    if (seen.has(entry.command)) return false;
    seen.add(entry.command);
    return true;
  });
}
