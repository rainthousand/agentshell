import fs from "node:fs";
import path from "node:path";
import { fail } from "../core/output.js";
import { findUp } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.package-deps.v1";
const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
const LARGE_DEPENDENCY_COUNT = 50;

const FRAMEWORKS = [
  { name: "React", ecosystem: "node", packages: ["react"] },
  { name: "Next.js", ecosystem: "node", packages: ["next"] },
  { name: "Vite", ecosystem: "node", packages: ["vite"] },
  { name: "Express", ecosystem: "node", packages: ["express"] },
  { name: "Jest", ecosystem: "node", packages: ["jest"] },
  { name: "Vitest", ecosystem: "node", packages: ["vitest"] },
  { name: "TypeScript", ecosystem: "node", packages: ["typescript"] }
];

export async function packageDeps(root, options = {}) {
  const projectRoot = path.resolve(root);
  const packageJsonPath = findUp(projectRoot, ["package.json"]);
  const goModPath = findUp(projectRoot, ["go.mod"]);
  const hasPackageJson = Boolean(packageJsonPath);
  const hasGoMod = Boolean(goModPath);

  if (!hasPackageJson && !hasGoMod) {
    return fail("MANIFEST_NOT_FOUND", "No supported package manifest found", {
      checked: ["package.json", "go.mod"]
    }, [{
      command: "agentshell tree --compact",
      reason: "Inspect the project shape and locate a supported manifest"
    }]);
  }

  const node = hasPackageJson ? readPackageJson(path.dirname(packageJsonPath), packageJsonPath) : null;
  if (node?.ok === false) return node;
  const go = hasGoMod ? readGoMod(path.dirname(goModPath), goModPath) : null;

  const dependencies = buildDependencies(node, go);
  const frameworks = detectFrameworks(node, go);
  const runtimes = detectRuntimes(node, go);
  const summary = summarize(node, go, dependencies, frameworks, runtimes);
  const risks = detectRisks(node, go, summary);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: Boolean(options.compact),
    ecosystem: detectEcosystem(node, go),
    summary,
    dependencies,
    frameworks,
    runtimes,
    risks,
    suggestedNextActions: suggestedNextActions(node, go, risks)
  };
}

function readPackageJson(root, packageJsonPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    return fail("MANIFEST_PARSE_ERROR", "package.json could not be parsed", {
      manifest: "package.json",
      error: error.message
    });
  }

  const lockfiles = NODE_LOCKFILES.filter((name) => fs.existsSync(path.join(root, name)));
  return {
    ecosystem: "node",
    manifest: "package.json",
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    engines: manifest.engines && typeof manifest.engines === "object" ? manifest.engines : {},
    dependencies: manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {},
    devDependencies: manifest.devDependencies && typeof manifest.devDependencies === "object" ? manifest.devDependencies : {},
    peerDependencies: manifest.peerDependencies && typeof manifest.peerDependencies === "object" ? manifest.peerDependencies : {},
    optionalDependencies: manifest.optionalDependencies && typeof manifest.optionalDependencies === "object" ? manifest.optionalDependencies : {},
    lockfiles
  };
}

function readGoMod(root, goModPath) {
  const text = fs.readFileSync(goModPath, "utf8");
  return {
    ecosystem: "go",
    manifest: "go.mod",
    module: parseGoModule(text),
    goVersion: parseGoVersion(text),
    dependencies: parseGoRequires(text),
    lockfiles: fs.existsSync(path.join(root, "go.sum")) ? ["go.sum"] : []
  };
}

function buildDependencies(node, go) {
  return {
    production: node ? dependencyEntries(node.dependencies, "production") : [],
    development: node ? dependencyEntries(node.devDependencies, "development") : [],
    peer: node ? dependencyEntries(node.peerDependencies, "peer") : [],
    optional: node ? dependencyEntries(node.optionalDependencies, "optional") : [],
    go: go ? go.dependencies : []
  };
}

function dependencyEntries(dependencies, type) {
  return Object.entries(dependencies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({
      name,
      version: String(version),
      type
    }));
}

function detectFrameworks(node, go) {
  const dependencies = new Map();
  if (node) {
    for (const [name, version] of Object.entries({
      ...node.dependencies,
      ...node.devDependencies,
      ...node.peerDependencies,
      ...node.optionalDependencies
    })) {
      dependencies.set(name, String(version));
    }
  }

  const frameworks = [];
  for (const candidate of FRAMEWORKS) {
    const matchedPackage = candidate.packages.find((pkg) => dependencies.has(pkg));
    if (matchedPackage) {
      frameworks.push({
        name: candidate.name,
        ecosystem: candidate.ecosystem,
        package: matchedPackage,
        version: dependencies.get(matchedPackage)
      });
    }
  }

  if (go) {
    frameworks.push({
      name: "Go module",
      ecosystem: "go",
      package: go.module,
      version: go.goVersion
    });
  }

  return frameworks;
}

function detectRuntimes(node, go) {
  const runtimes = [];
  if (node) {
    runtimes.push({
      name: "node",
      version: typeof node.engines.node === "string" ? node.engines.node : null,
      source: "package.json"
    });
    const typescriptVersion = node.devDependencies.typescript || node.dependencies.typescript;
    if (typescriptVersion) {
      runtimes.push({
        name: "typescript",
        version: String(typescriptVersion),
        source: "package.json"
      });
    }
  }
  if (go) {
    runtimes.push({
      name: "go",
      version: go.goVersion,
      source: "go.mod"
    });
  }
  return runtimes;
}

function summarize(node, go, dependencies, frameworks, runtimes) {
  const nodeDependencyCount = dependencies.production.length
    + dependencies.development.length
    + dependencies.peer.length
    + dependencies.optional.length;
  const goDependencyCount = dependencies.go.length;

  return {
    manifests: [
      ...(node ? [node.manifest] : []),
      ...(go ? [go.manifest] : [])
    ],
    dependencyCount: nodeDependencyCount + goDependencyCount,
    nodeDependencyCount,
    goDependencyCount,
    productionCount: dependencies.production.length,
    developmentCount: dependencies.development.length,
    peerCount: dependencies.peer.length,
    optionalCount: dependencies.optional.length,
    frameworkCount: frameworks.length,
    runtimeCount: runtimes.length,
    lockfiles: [
      ...(node ? node.lockfiles : []),
      ...(go ? go.lockfiles : [])
    ]
  };
}

function detectRisks(node, go, summary) {
  const risks = [];
  if (summary.dependencyCount >= LARGE_DEPENDENCY_COUNT) {
    risks.push({
      type: "large-dependency-count",
      severity: "medium",
      message: "Direct dependency count is high; dependency summaries should stay manifest-only unless a tree is explicitly needed",
      count: summary.dependencyCount
    });
  }
  if (node && summary.nodeDependencyCount > 0 && node.lockfiles.length === 0) {
    risks.push({
      type: "lockfile-missing",
      severity: "medium",
      message: "Node dependencies exist but no common lockfile was found",
      count: summary.nodeDependencyCount
    });
  }
  if (node && node.lockfiles.length > 0) {
    risks.push({
      type: "lockfile-present",
      severity: "low",
      message: "Node lockfile is present; inspect it only when dependency versions changed",
      files: node.lockfiles
    });
  }
  if (go && go.lockfiles.length === 0 && go.dependencies.length > 0) {
    risks.push({
      type: "lockfile-missing",
      severity: "medium",
      message: "Go dependencies exist but go.sum was not found",
      count: go.dependencies.length
    });
  }
  if (go && go.lockfiles.length > 0) {
    risks.push({
      type: "lockfile-present",
      severity: "low",
      message: "go.sum is present; inspect it only when module versions changed",
      files: go.lockfiles
    });
  }
  return risks;
}

function suggestedNextActions(node, go, risks) {
  const actions = [];
  if (node) {
    actions.push({
      command: "agentshell package scripts --compact",
      reason: "Inspect available npm scripts without reading the whole manifest"
    });
  }
  if (go) {
    actions.push({
      command: "agentshell verify modules --compact",
      reason: "Check Go module integrity without mutating go.mod or go.sum"
    });
  }
  if (risks.some((risk) => risk.type === "lockfile-missing")) {
    actions.push({
      command: "agentshell git status --compact",
      reason: "Check whether lockfiles are intentionally absent or just untracked"
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell understand --compact",
      reason: "Collect a broader project summary"
    });
  }
  return actions;
}

function detectEcosystem(node, go) {
  if (node && go) return "mixed";
  if (node) return "node";
  return "go";
}

function parseGoModule(text) {
  const line = text.split(/\r?\n/).find((entry) => stripped(entry).startsWith("module "));
  return line ? stripped(line).slice("module ".length).trim() : null;
}

function parseGoVersion(text) {
  const line = text.split(/\r?\n/).find((entry) => stripped(entry).startsWith("go "));
  return line ? stripped(line).slice("go ".length).trim() : null;
}

function parseGoRequires(text) {
  const dependencies = [];
  const lines = text.split(/\r?\n/);
  let inRequireBlock = false;

  for (const rawLine of lines) {
    const line = stripped(rawLine);
    const requireLine = rawLine.trim();
    if (!line) continue;

    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ")") {
      inRequireBlock = false;
      continue;
    }
    if (line.startsWith("require ")) {
      addGoRequire(dependencies, requireLine.slice("require ".length));
      continue;
    }
    if (inRequireBlock) {
      addGoRequire(dependencies, requireLine);
    }
  }

  return dependencies.sort((left, right) => left.name.localeCompare(right.name));
}

function addGoRequire(dependencies, line) {
  const indirect = line.includes("// indirect");
  const cleanLine = stripped(line).replace(/\s*\/\/\s*indirect\s*$/, "").trim();
  const parts = cleanLine.split(/\s+/);
  if (parts.length < 2) return;
  dependencies.push({
    name: parts[0],
    version: parts[1],
    type: indirect ? "indirect" : "direct",
    indirect
  });
}

function stripped(line) {
  return line.replace(/\s*\/\/.*$/, "").trim();
}
