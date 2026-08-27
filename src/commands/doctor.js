import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { gitInfo } from "../core/git.js";
import { getProjectInfo, projectCommand } from "../core/project.js";
import { ensureState, readActiveRun, stateDir } from "../core/store.js";
import { summarizeRun } from "./run-status.js";

const PROTOCOL_VERSION = "agentshell.doctor.v1";
const REQUIRED_NODE_MAJOR = 20;

export async function doctor(root, options = {}) {
  const project = options.project || getProjectInfo(root);
  const workspaceRoot = project?.root || root;
  const packageManager = project?.manager || null;
  const git = gitInfo(workspaceRoot);
  const state = checkState(workspaceRoot);
  const activeRun = checkActiveRun(workspaceRoot);
  const node = checkNode();
  const go = project?.kind === "go" ? {
    ...checkGo(),
    tools: checkGoTools()
  } : null;
  const scripts = project?.rawScripts || {};
  const testCommand = projectCommand(project, "test");
  const checks = [
    {
      name: "node",
      ok: node.ok,
      severity: node.ok ? "info" : "error",
      message: node.ok
        ? `Node ${node.version} satisfies ${node.required}`
        : `Node ${node.version} is below ${node.required}`
    },
    {
      name: "package-json",
      ok: Boolean(project),
      severity: project ? "info" : "warning",
      message: project?.kind === "go"
        ? `go.mod found for ${project.name}`
        : (project ? `package.json found for ${project.name}` : "No package.json found")
    },
    {
      name: "test-script",
      ok: Boolean(testCommand),
      severity: testCommand ? "info" : "warning",
      message: project?.kind === "go"
        ? `test command available: ${testCommand}`
        : (testCommand ? `test script available: ${testCommand}` : "No npm-style test script found")
    },
    ...(go ? [{
      name: "go",
      ok: go.available,
      severity: go.available ? "info" : "error",
      message: go.available ? `Go ${go.version} is available` : `Go executable is not available${go.error ? `: ${go.error}` : ""}`
    }] : []),
    {
      name: "state-dir",
      ok: state.writable,
      severity: state.writable ? "info" : "error",
      message: state.writable ? `AgentShell state is writable at ${state.path}` : `AgentShell state is not writable: ${state.error}`
    },
    {
      name: "active-run",
      ok: !activeRun.error,
      severity: activeRun.error ? "warning" : "info",
      message: activeRun.error
        ? `Active AgentShell run state is unreadable: ${activeRun.error}`
        : (activeRun.present ? `Active AgentShell run ${activeRun.runId} is ${activeRun.status}` : "No active AgentShell run")
    },
    {
      name: "git",
      ok: git.available,
      severity: git.available ? (git.dirty ? "warning" : "info") : "warning",
      message: git.available
        ? (git.dirty ? `Git worktree has ${git.changedFilesTotal} changed files` : "Git worktree is clean")
        : "Git metadata is not available"
    }
  ];
  const summary = summarize(checks);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    status: statusFor(summary),
    workspace: {
      root: workspaceRoot,
      name: project?.name || path.basename(workspaceRoot)
    },
    runtime: {
      node,
      ...(go ? { go } : {})
    },
    package: {
      found: Boolean(project),
      manager: packageManager,
      ...(project?.kind === "go" ? {
        kind: project.kind,
        manifest: project.manifest
      } : {}),
      scripts: {
        test: scripts.test || null,
        build: scripts.build || null,
        lint: scripts.lint || null
      }
    },
    state,
    activeRun,
    git,
    checks,
    summary,
    suggestedNextActions: suggestedNextActions({ project, testCommand, state, activeRun, git, summary })
  };
}

function checkNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  return {
    version: process.versions.node,
    required: `>=${REQUIRED_NODE_MAJOR}`,
    ok: Number.isFinite(major) && major >= REQUIRED_NODE_MAJOR
  };
}

function checkGo() {
  const result = spawnSync("go", ["version"], {
    encoding: "utf8",
    timeout: 5000
  });
  const output = String(result.stdout || result.stderr || "").trim();
  const version = output.match(/\bgo version go(\S+)/)?.[1] || null;
  const available = result.status === 0 && Boolean(version);
  return {
    available,
    version,
    error: available ? null : (result.error?.message || output || "go version failed")
  };
}

function checkGoTools() {
  return {
    golangciLint: checkOptionalTool("golangci-lint", ["version"]),
    goimports: checkOptionalTool("goimports", ["-version"])
  };
}

function checkOptionalTool(command, versionArgs) {
  const executablePath = resolveExecutable(command);
  if (!executablePath) return { available: false };

  const result = spawnSync(executablePath, versionArgs, {
    encoding: "utf8",
    timeout: 5000
  });
  const output = String(result.stdout || result.stderr || "").trim();
  return {
    available: true,
    version: output.split(/\r?\n/, 1)[0] || null,
    path: executablePath
  };
}

function resolveExecutable(command) {
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.resolve(entry, `${command}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching PATH when an entry is missing or not executable.
      }
    }
  }
  return null;
}

function checkState(root) {
  const preferredPath = stateDir(root);
  try {
    const dir = ensureState(root);
    const probe = path.join(dir, ".doctor-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return {
      path: dir,
      preferredPath,
      writable: true,
      fallbackUsed: path.resolve(dir) !== path.resolve(preferredPath),
      error: null
    };
  } catch (error) {
    return {
      path: preferredPath,
      preferredPath,
      writable: false,
      fallbackUsed: false,
      error: error.message
    };
  }
}

function checkActiveRun(root) {
  try {
    const run = readActiveRun(root);
    if (!run) {
      return {
        present: false,
        runId: null,
        status: null,
        updatedAt: null,
        commandCount: 0,
        nodeCount: 0,
        nextBestAction: null,
        rollbackCommand: null,
        error: null
      };
    }
    const summary = summarizeRun(run);
    return {
      present: true,
      runId: summary.runId,
      status: summary.status,
      updatedAt: run.updatedAt || null,
      commandCount: summary.commandCount,
      nodeCount: summary.nodeCount,
      nextBestAction: summary.nextBestAction,
      rollbackCommand: summary.rollbackCommand,
      error: null
    };
  } catch (error) {
    return {
      present: false,
      runId: null,
      status: null,
      updatedAt: null,
      commandCount: 0,
      nodeCount: 0,
      nextBestAction: null,
      rollbackCommand: null,
      error: error.message
    };
  }
}

function summarize(checks) {
  const errorCount = checks.filter((check) => check.severity === "error").length;
  const warningCount = checks.filter((check) => check.severity === "warning").length;
  return {
    errorCount,
    warningCount,
    checkCount: checks.length
  };
}

function statusFor(summary) {
  if (summary.errorCount > 0) return "blocked";
  if (summary.warningCount > 0) return "warning";
  return "ready";
}

function suggestedNextActions({ project, testCommand, state, activeRun, git, summary }) {
  const actions = [];
  if (summary.errorCount > 0) {
    actions.push({
      command: "agentshell doctor",
      reason: "Fix blocking environment checks, then rerun doctor"
    });
  }
  if (!project) {
    actions.push({
      command: "agentshell understand",
      reason: "Inspect the workspace structure before using package-aware commands"
    });
  } else if (testCommand) {
    actions.push({
      command: "agentshell verify test",
      reason: project.kind === "go"
        ? `Run the configured test command via ${testCommand}`
        : `Run the configured test script via ${testCommand}`
    });
  } else {
    actions.push({
      command: "agentshell understand",
      reason: "Find available scripts or project conventions before verification"
    });
  }
  if (state.fallbackUsed) {
    actions.push({
      command: "agentshell doctor",
      reason: "Make the workspace .agentshell directory writable to avoid fallback state"
    });
  }
  if (activeRun.present) {
    actions.push({
      command: "agentshell run status --compact",
      reason: "Inspect the active AgentShell run summary"
    });
    actions.push({
      command: "agentshell run clear",
      reason: "Clear the active AgentShell run when it is stale or no longer relevant"
    });
  }
  if (git.available && git.dirty) {
    actions.push({
      command: "git status --short",
      reason: "Review existing changes before applying AgentShell edits"
    });
  }
  return actions;
}
