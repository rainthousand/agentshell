import fs from "node:fs";
import path from "node:path";

import { findUp } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.config-list.v1";
const DEFAULT_COMPACT_LIMIT = 60;

const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".next",
  ".parcel-cache",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
  "temp",
  "vendor"
]);

const CATEGORY_PRIORITY = {
  package: 0,
  language: 1,
  build: 2,
  quality: 3,
  go: 4,
  python: 5,
  java: 6,
  automation: 7,
  container: 8,
  ci: 9,
  agent: 10
};

export async function configList(root, options = {}) {
  const projectRoot = resolveProjectRoot(root);
  const compact = options.compact === true;
  const maxConfigs = compact ? positiveInteger(options.maxConfigs, DEFAULT_COMPACT_LIMIT) : Number.POSITIVE_INFINITY;
  const scan = discoverConfigs(projectRoot, maxConfigs);
  const summary = summarize(scan);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    summary,
    configs: scan.configs,
    suggestedNextActions: suggestedNextActions(summary)
  };
}

export const listConfigs = configList;

function resolveProjectRoot(root) {
  const marker = findUp(root, [
    "package.json",
    "go.work",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "pytest.ini",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "Makefile",
    "Dockerfile",
    "AGENTS.md",
    "agentshell.config.json"
  ]);
  return marker ? path.dirname(marker) : path.resolve(root);
}

function discoverConfigs(projectRoot, maxConfigs) {
  const state = {
    totalConfigs: 0,
    configs: [],
    truncated: false,
    categories: {},
    risks: {}
  };

  scanDirectory(projectRoot, "", state, maxConfigs);
  state.configs.sort(compareConfig);
  return state;
}

function scanDirectory(directory, relativeDirectory, state, maxConfigs) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    state.truncated = true;
    return;
  }

  entries.sort((left, right) => entryPriority(relativeDirectory, left) - entryPriority(relativeDirectory, right) || left.name.localeCompare(right.name));

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      scanDirectory(path.join(directory, entry.name), relativePath, state, maxConfigs);
      continue;
    }

    if (!entry.isFile()) continue;
    const match = classifyConfig(relativePath);
    if (!match) continue;

    state.totalConfigs += 1;
    state.categories[match.category] = (state.categories[match.category] || 0) + 1;
    state.risks[match.risk] = (state.risks[match.risk] || 0) + 1;

    if (state.configs.length >= maxConfigs) {
      state.truncated = true;
      continue;
    }

    state.configs.push({
      path: relativePath,
      type: match.type,
      category: match.category,
      risk: match.risk,
      readCommand: `agentshell read ${quotePath(relativePath)} --lines 1:80`
    });
  }
}

function classifyConfig(relativePath) {
  const basename = path.posix.basename(relativePath);
  const dirname = path.posix.dirname(relativePath);
  const lowerPath = relativePath.toLowerCase();
  const lowerName = basename.toLowerCase();

  if (basename === "package.json") return config("package-json", "package", "medium");
  if (/^tsconfig(?:\.[^.]+)?\.json$/i.test(basename)) return config("tsconfig", "language", "medium");
  if (/^jsconfig(?:\.[^.]+)?\.json$/i.test(basename)) return config("jsconfig", "language", "medium");

  if (isViteConfig(basename)) return config("vite", "build", "medium");
  if (isWebpackConfig(basename)) return config("webpack", "build", "medium");
  if (isRollupConfig(basename)) return config("rollup", "build", "medium");

  if (isEslintConfig(basename)) return config("eslint", "quality", "low");
  if (isPrettierConfig(basename)) return config("prettier", "quality", "low");
  if (lowerName === "biome.json" || lowerName === "biome.jsonc") return config("biome", "quality", "low");

  if (basename === "go.mod") return config("go-mod", "go", "medium");
  if (basename === "go.work") return config("go-work", "go", "medium");

  if (basename === "pyproject.toml") return config("pyproject", "python", "medium");
  if (/^requirements.*\.txt$/i.test(basename)) return config("requirements", "python", "medium");
  if (basename === "setup.py") return config("setup-py", "python", "high");
  if (basename === "setup.cfg") return config("setup-cfg", "python", "medium");
  if (basename === "tox.ini") return config("tox", "python", "medium");
  if (basename === "pytest.ini") return config("pytest", "python", "low");
  if (basename === "poetry.lock") return config("poetry-lock", "python", "low");
  if (basename === "Pipfile") return config("pipfile", "python", "medium");

  if (basename === "pom.xml") return config("maven", "java", "medium");
  if (basename === "build.gradle" || basename === "build.gradle.kts") return config("gradle-build", "java", "medium");
  if (basename === "settings.gradle" || basename === "settings.gradle.kts") return config("gradle-settings", "java", "medium");
  if (basename === "gradle.properties") return config("gradle-properties", "java", "medium");
  if (basename === "mvnw" || basename === "gradlew") return config("build-wrapper", "java", "high");

  if (basename === "Makefile" || basename === "makefile" || basename === "GNUmakefile") return config("makefile", "automation", "medium");
  if (/^Dockerfile(?:\..+)?$/.test(basename)) return config("dockerfile", "container", "high");
  if (/^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/i.test(basename)) return config("compose", "container", "high");

  if (dirname === ".github/workflows" && /\.ya?ml$/i.test(basename)) return config("github-actions", "ci", "high");
  if (isCiConfig(relativePath, lowerPath, basename)) return config("ci", "ci", "high");

  if (isAgentConfig(relativePath, lowerPath, basename)) return config("agent-config", "agent", "medium");

  return null;
}

function config(type, category, risk) {
  return { type, category, risk };
}

function isViteConfig(basename) {
  return /^vite\.config\.[cm]?[jt]s$/i.test(basename) || /^vitest\.config\.[cm]?[jt]s$/i.test(basename);
}

function isWebpackConfig(basename) {
  return /^webpack(?:\.[^.]+)?\.config\.[cm]?js$/i.test(basename) || /^webpack\.config\.[cm]?js$/i.test(basename);
}

function isRollupConfig(basename) {
  return /^rollup\.config\.[cm]?[jt]s$/i.test(basename);
}

function isEslintConfig(basename) {
  return /^eslint\.config\.[cm]?[jt]s$/i.test(basename) || /^\.eslintrc(?:\.(?:json|ya?ml|[cm]?js))?$/i.test(basename);
}

function isPrettierConfig(basename) {
  return /^prettier\.config\.[cm]?js$/i.test(basename) || /^\.prettierrc(?:\.(?:json|json5|ya?ml|toml|[cm]?js))?$/i.test(basename);
}

function isCiConfig(relativePath, lowerPath, basename) {
  return lowerPath === ".gitlab-ci.yml"
    || lowerPath === ".gitlab-ci.yaml"
    || lowerPath === ".travis.yml"
    || lowerPath === "appveyor.yml"
    || lowerPath === "appveyor.yaml"
    || lowerPath === "azure-pipelines.yml"
    || lowerPath === "azure-pipelines.yaml"
    || lowerPath === "bitbucket-pipelines.yml"
    || lowerPath === "bitbucket-pipelines.yaml"
    || relativePath === "Jenkinsfile"
    || lowerPath === ".circleci/config.yml"
    || lowerPath === ".circleci/config.yaml"
    || lowerPath === ".buildkite/pipeline.yml"
    || lowerPath === ".buildkite/pipeline.yaml"
    || (lowerPath.startsWith(".ci/") && /\.ya?ml$/i.test(basename));
}

function isAgentConfig(relativePath, lowerPath, basename) {
  return relativePath === "AGENTS.md"
    || relativePath === "CODEX.md"
    || lowerPath === ".codex/config.toml"
    || lowerPath === ".codex/skills.toml"
    || lowerPath === ".codex-plugin/plugin.json"
    || lowerPath === ".agentshell/config.json"
    || lowerPath === ".agentshell/project.json"
    || /^agentshell\.config\.(?:json|jsonc|ya?ml|toml)$/i.test(basename)
    || /^codex\.config\.(?:json|jsonc|ya?ml|toml)$/i.test(basename);
}

function summarize(scan) {
  return {
    totalConfigs: scan.totalConfigs,
    returnedConfigs: scan.configs.length,
    truncated: scan.truncated || scan.configs.length < scan.totalConfigs,
    categories: scan.categories,
    risks: scan.risks,
    hasNode: Boolean(scan.categories.package || scan.categories.language || scan.configs.some((entry) => entry.type === "package-json")),
    hasGo: Boolean(scan.categories.go),
    hasPython: Boolean(scan.categories.python),
    hasJava: Boolean(scan.categories.java),
    hasCi: Boolean(scan.categories.ci),
    hasContainers: Boolean(scan.categories.container),
    hasAgentConfig: Boolean(scan.categories.agent)
  };
}

function suggestedNextActions(summary) {
  const actions = [];
  if (summary.hasNode) {
    actions.push({
      command: "agentshell package scripts --compact",
      reason: "Inspect Node package scripts after locating package and JavaScript/TypeScript config entrypoints"
    });
  }
  if (summary.hasGo) {
    actions.push({
      command: "agentshell verify test --compact",
      reason: "Run compact Go test verification when Go module or workspace config is present"
    });
  }
  if (summary.hasPython || summary.hasJava) {
    actions.push({
      command: "agentshell test list --compact",
      reason: "Inspect Python or Java test entrypoints after locating project config"
    });
  }
  if (summary.hasCi || summary.hasContainers) {
    actions.push({
      command: "agentshell files changed --compact",
      reason: "Review changed CI or container config before running broader verification"
    });
  }
  if (summary.truncated) {
    actions.push({
      command: "agentshell config list",
      reason: "Compact config output was truncated; request the full list only if needed"
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell tree --compact",
      reason: "No common project config entrypoints were detected; inspect the project layout next"
    });
  }
  return actions;
}

function compareConfig(left, right) {
  return (CATEGORY_PRIORITY[left.category] ?? 99) - (CATEGORY_PRIORITY[right.category] ?? 99)
    || pathDepth(left.path) - pathDepth(right.path)
    || left.path.localeCompare(right.path);
}

function pathDepth(filePath) {
  return filePath.split("/").length - 1;
}

function entryPriority(relativeDirectory, entry) {
  const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
  const match = classifyConfig(relativePath);
  if (match) return CATEGORY_PRIORITY[match.category] ?? 50;
  if (entry.isDirectory() && entry.name.startsWith(".")) return 20;
  if (entry.isDirectory()) return 30;
  return 40;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function quotePath(filePath) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(filePath)) return filePath;
  return `'${filePath.replaceAll("'", "'\\''")}'`;
}
