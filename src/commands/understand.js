import fs from "node:fs";
import path from "node:path";
import { gitInfo } from "../core/git.js";
import { getProjectInfo, projectCommand } from "../core/project.js";

const PROTOCOL_VERSION = "agentshell.understand.v1";

export async function understand(root, options = {}) {
  const project = options.project || getProjectInfo(root);
  const workspaceRoot = project?.root || root;
  const scripts = {};

  for (const name of ["test", "lint", "build", "dev"]) {
    const command = projectCommand(project, name);
    if (command) scripts[name] = command;
  }

  const languages = detectLanguages(workspaceRoot);
  const frameworks = detectFrameworks(project?.dependencies || {});
  const git = gitInfo(workspaceRoot);
  const suggestedNextActions = [];

  if (scripts.test) {
    suggestedNextActions.push({
      command: "agentshell verify test",
      reason: "Project has a test script"
    });
  }

  const output = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    workspace: {
      root: workspaceRoot,
      name: project?.name || path.basename(workspaceRoot)
    },
    stack: {
      languages,
      packageManager: project?.manager || null,
      frameworks
    },
    scripts,
    git,
    suggestedNextActions
  };

  return options.compact ? compactUnderstand(output) : output;
}

function compactUnderstand(output) {
  return {
    ok: output.ok,
    protocolVersion: output.protocolVersion,
    compact: true,
    workspace: {
      name: output.workspace.name
    },
    stack: output.stack,
    scripts: output.scripts,
    git: {
      available: output.git.available,
      branch: output.git.branch,
      dirty: output.git.dirty,
      changedFilesTotal: output.git.changedFilesTotal || output.git.changedFiles.length
    },
    nextAction: output.suggestedNextActions[0]?.command || null
  };
}

function detectLanguages(root) {
  const names = new Set(fs.readdirSync(root));
  const languages = [];
  if (names.has("package.json") || names.has("tsconfig.json")) languages.push("javascript");
  if (names.has("tsconfig.json")) languages.push("typescript");
  if (names.has("Cargo.toml")) languages.push("rust");
  if (names.has("pyproject.toml") || names.has("requirements.txt")) languages.push("python");
  if (names.has("go.mod")) languages.push("go");
  return languages;
}

function detectFrameworks(deps) {
  const frameworks = [];
  for (const name of ["next", "react", "vue", "svelte", "vite", "express", "fastify"]) {
    if (deps[name]) frameworks.push(name);
  }
  return frameworks;
}
