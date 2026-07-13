import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { gitInfo } from "../core/git.js";
import { detectPackageManager, getPackageInfo, scriptCommand } from "../core/package-json.js";
import { ensureState, readActiveRun, stateDir } from "../core/store.js";
import { summarizeRun } from "./run-status.js";

const PROTOCOL_VERSION = "agentshell.doctor.v1";
const REQUIRED_NODE_MAJOR = 20;

export async function doctor(root) {
  const packageInfo = getPackageInfo(root);
  const workspaceRoot = packageInfo?.root || root;
  const packageManager = packageInfo ? detectPackageManager(packageInfo.root) : null;
  const git = gitInfo(workspaceRoot);
  const state = checkState(workspaceRoot);
  const activeRun = checkActiveRun(workspaceRoot);
  const node = checkNode();
  const scripts = packageInfo?.scripts || {};
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
      ok: Boolean(packageInfo),
      severity: packageInfo ? "info" : "warning",
      message: packageInfo ? `package.json found for ${packageInfo.name}` : "No package.json found"
    },
    {
      name: "test-script",
      ok: Boolean(scripts.test),
      severity: scripts.test ? "info" : "warning",
      message: scripts.test ? `test script available: ${scriptCommand(packageManager, "test")}` : "No npm-style test script found"
    },
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
      name: packageInfo?.name || path.basename(workspaceRoot)
    },
    runtime: {
      node
    },
    package: {
      found: Boolean(packageInfo),
      manager: packageManager,
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
    suggestedNextActions: suggestedNextActions({ packageInfo, packageManager, scripts, state, activeRun, git, summary })
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

function suggestedNextActions({ packageInfo, packageManager, scripts, state, activeRun, git, summary }) {
  const actions = [];
  if (summary.errorCount > 0) {
    actions.push({
      command: "agentshell doctor",
      reason: "Fix blocking environment checks, then rerun doctor"
    });
  }
  if (!packageInfo) {
    actions.push({
      command: "agentshell understand",
      reason: "Inspect the workspace structure before using package-aware commands"
    });
  } else if (scripts.test) {
    actions.push({
      command: "agentshell verify test",
      reason: `Run the configured test script via ${scriptCommand(packageManager, "test")}`
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
