import fs from "node:fs";
import path from "node:path";
import { fail } from "../core/output.js";
import { findUp } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.package-deps.v1";
const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
const PYTHON_MANIFESTS = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.cfg", "setup.py", "Pipfile"];
const PYTHON_LOCKFILES = ["poetry.lock", "Pipfile.lock", "uv.lock"];
const JAVA_MANIFESTS = ["pom.xml", "build.gradle", "build.gradle.kts"];
const JAVA_LOCKFILES = ["gradle.lockfile", "dependencies.lock"];
const LARGE_DEPENDENCY_COUNT = 50;

const FRAMEWORKS = [
  { name: "React", ecosystem: "node", packages: ["react"] },
  { name: "Next.js", ecosystem: "node", packages: ["next"] },
  { name: "Vite", ecosystem: "node", packages: ["vite"] },
  { name: "Express", ecosystem: "node", packages: ["express"] },
  { name: "Jest", ecosystem: "node", packages: ["jest"] },
  { name: "Vitest", ecosystem: "node", packages: ["vitest"] },
  { name: "TypeScript", ecosystem: "node", packages: ["typescript"] },
  { name: "Django", ecosystem: "python", packages: ["django"] },
  { name: "FastAPI", ecosystem: "python", packages: ["fastapi"] },
  { name: "Flask", ecosystem: "python", packages: ["flask"] },
  { name: "Pytest", ecosystem: "python", packages: ["pytest"] },
  { name: "Spring", ecosystem: "java", packages: ["spring-boot-starter", "spring-boot-starter-web"] },
  { name: "JUnit", ecosystem: "java", packages: ["junit", "junit-jupiter", "junit-jupiter-api"] }
];

export async function packageDeps(root, options = {}) {
  const projectRoot = path.resolve(root);
  const packageJsonPath = findUp(projectRoot, ["package.json"]);
  const goModPath = findUp(projectRoot, ["go.mod"]);
  const pythonManifestPath = findUp(projectRoot, PYTHON_MANIFESTS);
  const javaManifestPath = findUp(projectRoot, JAVA_MANIFESTS);
  const hasPackageJson = Boolean(packageJsonPath);
  const hasGoMod = Boolean(goModPath);
  const hasPythonManifest = Boolean(pythonManifestPath);
  const hasJavaManifest = Boolean(javaManifestPath);

  if (!hasPackageJson && !hasGoMod && !hasPythonManifest && !hasJavaManifest) {
    return fail("MANIFEST_NOT_FOUND", "No supported package manifest found", {
      checked: ["package.json", "go.mod", ...PYTHON_MANIFESTS, ...JAVA_MANIFESTS]
    }, [{
      command: "agentshell tree --compact",
      reason: "Inspect the project shape and locate a supported manifest"
    }]);
  }

  const node = hasPackageJson ? readPackageJson(path.dirname(packageJsonPath), packageJsonPath) : null;
  if (node?.ok === false) return node;
  const go = hasGoMod ? readGoMod(path.dirname(goModPath), goModPath) : null;
  const python = hasPythonManifest ? readPythonManifest(path.dirname(pythonManifestPath), pythonManifestPath) : null;
  const java = hasJavaManifest ? readJavaManifest(path.dirname(javaManifestPath), javaManifestPath) : null;

  const dependencies = buildDependencies(node, go, python, java);
  const frameworks = detectFrameworks(node, go, python, java);
  const runtimes = detectRuntimes(node, go, python, java);
  const summary = summarize(node, go, python, java, dependencies, frameworks, runtimes);
  const risks = detectRisks(node, go, python, java, summary);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: Boolean(options.compact),
    ecosystem: detectEcosystem(node, go, python, java),
    summary,
    dependencies,
    frameworks,
    runtimes,
    risks,
    suggestedNextActions: suggestedNextActions(node, go, python, java, risks)
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

function readPythonManifest(root, manifestPath) {
  const manifest = path.basename(manifestPath);
  const text = fs.readFileSync(manifestPath, "utf8");
  return {
    ecosystem: "python",
    manifest,
    dependencies: parsePythonDependencies(manifest, text),
    lockfiles: PYTHON_LOCKFILES.filter((name) => fs.existsSync(path.join(root, name)))
  };
}

function readJavaManifest(root, manifestPath) {
  const manifest = path.basename(manifestPath);
  const text = fs.readFileSync(manifestPath, "utf8");
  return {
    ecosystem: "java",
    manifest,
    dependencies: parseJavaDependencies(manifest, text),
    lockfiles: JAVA_LOCKFILES.filter((name) => fs.existsSync(path.join(root, name))),
    toolingFiles: ["mvnw", "gradlew"].filter((name) => fs.existsSync(path.join(root, name)))
  };
}

function buildDependencies(node, go, python, java) {
  return {
    production: node ? dependencyEntries(node.dependencies, "production") : [],
    development: node ? dependencyEntries(node.devDependencies, "development") : [],
    peer: node ? dependencyEntries(node.peerDependencies, "peer") : [],
    optional: node ? dependencyEntries(node.optionalDependencies, "optional") : [],
    go: go ? go.dependencies : [],
    python: python ? python.dependencies : [],
    java: java ? java.dependencies : []
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

function detectFrameworks(node, go, python, java) {
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
  if (python) {
    for (const entry of python.dependencies) dependencies.set(entry.name.toLowerCase(), entry.version);
  }
  if (java) {
    for (const entry of java.dependencies) {
      dependencies.set(entry.artifact.toLowerCase(), entry.version);
      dependencies.set(`${entry.group}:${entry.artifact}`.toLowerCase(), entry.version);
    }
  }
  for (const candidate of FRAMEWORKS.filter((entry) => entry.ecosystem !== "node")) {
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

  return frameworks;
}

function detectRuntimes(node, go, python, java) {
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
  if (python) {
    runtimes.push({
      name: "python",
      version: null,
      source: python.manifest
    });
  }
  if (java) {
    runtimes.push({
      name: java.manifest === "pom.xml" ? "maven" : "gradle",
      version: null,
      source: java.manifest
    });
    runtimes.push({
      name: "java",
      version: null,
      source: java.manifest
    });
  }
  return runtimes;
}

function summarize(node, go, python, java, dependencies, frameworks, runtimes) {
  const nodeDependencyCount = dependencies.production.length
    + dependencies.development.length
    + dependencies.peer.length
    + dependencies.optional.length;
  const goDependencyCount = dependencies.go.length;
  const pythonDependencyCount = dependencies.python.length;
  const javaDependencyCount = dependencies.java.length;

  return {
    manifests: [
      ...(node ? [node.manifest] : []),
      ...(go ? [go.manifest] : []),
      ...(python ? [python.manifest] : []),
      ...(java ? [java.manifest] : [])
    ],
    dependencyCount: nodeDependencyCount + goDependencyCount + pythonDependencyCount + javaDependencyCount,
    nodeDependencyCount,
    goDependencyCount,
    pythonDependencyCount,
    javaDependencyCount,
    productionCount: dependencies.production.length,
    developmentCount: dependencies.development.length,
    peerCount: dependencies.peer.length,
    optionalCount: dependencies.optional.length,
    frameworkCount: frameworks.length,
    runtimeCount: runtimes.length,
    lockfiles: [
      ...(node ? node.lockfiles : []),
      ...(go ? go.lockfiles : []),
      ...(python ? python.lockfiles : []),
      ...(java ? java.lockfiles : [])
    ],
    toolingFiles: [
      ...(java ? java.toolingFiles : [])
    ]
  };
}

function detectRisks(node, go, python, java, summary) {
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
  if (python && summary.pythonDependencyCount > 0 && python.lockfiles.length === 0) {
    risks.push({
      type: "lockfile-missing",
      severity: "low",
      message: "Python dependencies exist but no common lockfile was found",
      count: summary.pythonDependencyCount
    });
  }
  if (java && java.lockfiles.length > 0) {
    risks.push({
      type: "lockfile-present",
      severity: "low",
      message: "Java dependency lockfile is present; inspect it only when dependency versions changed",
      files: java.lockfiles
    });
  }
  return risks;
}

function suggestedNextActions(node, go, python, java, risks) {
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
  if (python) {
    actions.push({
      command: "python -m pip check",
      reason: "Check installed Python dependency consistency when the environment is available"
    });
  }
  if (java) {
    actions.push({
      command: java.manifest === "pom.xml" ? "./mvnw test" : "./gradlew test",
      reason: "Run the project test task when the wrapper is available"
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

function detectEcosystem(node, go, python, java) {
  const ecosystems = [node, go, python, java].filter(Boolean);
  if (ecosystems.length > 1) return "mixed";
  if (node) return "node";
  if (go) return "go";
  if (python) return "python";
  if (java) return "java";
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

function parsePythonDependencies(manifest, text) {
  if (manifest.startsWith("requirements")) return parseRequirements(text);
  if (manifest === "pyproject.toml") return parsePyproject(text);
  if (manifest === "setup.cfg") return parseSetupCfg(text);
  if (manifest === "Pipfile") return parsePipfile(text);
  if (manifest === "setup.py") return parseSetupPy(text);
  return [];
}

function parseRequirements(text) {
  return text.split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("-") && !line.startsWith("#"))
    .map((line) => toPythonDependency(line, "production"))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parsePyproject(text) {
  const dependencies = [];
  let section = "";
  let inArray = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      inArray = null;
      continue;
    }
    if (section === "project" && line.startsWith("dependencies")) {
      inArray = "production";
      addInlineTomlDeps(dependencies, line, "production");
      if (line.includes("]")) inArray = null;
      continue;
    }
    if (section.startsWith("project.optional-dependencies")) {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*\[/);
      if (match) inArray = "optional";
      addInlineTomlDeps(dependencies, line, "optional");
      if (line.includes("]")) inArray = null;
      continue;
    }
    if (inArray) addQuotedDeps(dependencies, line, inArray);
  }
  return sortUniquePythonDependencies(dependencies);
}

function addInlineTomlDeps(dependencies, line, type) {
  addQuotedDeps(dependencies, line, type);
}

function addQuotedDeps(dependencies, line, type) {
  for (const match of line.matchAll(/["']([^"']+)["']/g)) {
    const dependency = toPythonDependency(match[1], type);
    if (dependency) dependencies.push(dependency);
  }
}

function parseSetupCfg(text) {
  const dependencies = [];
  let inInstallRequires = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[/.test(line)) {
      inInstallRequires = false;
      continue;
    }
    if (line.startsWith("install_requires")) {
      inInstallRequires = true;
      continue;
    }
    if (inInstallRequires) {
      const dependency = toPythonDependency(line, "production");
      if (dependency) dependencies.push(dependency);
    }
  }
  return sortUniquePythonDependencies(dependencies);
}

function parseSetupPy(text) {
  const dependencies = [];
  const installRequires = text.match(/install_requires\s*=\s*\[([\s\S]*?)\]/m);
  if (installRequires) addQuotedDeps(dependencies, installRequires[1], "production");
  return sortUniquePythonDependencies(dependencies);
}

function parsePipfile(text) {
  const dependencies = [];
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== "packages" && section !== "dev-packages") continue;
    const match = line.match(/^["']?([^"'\s=]+)["']?\s*=/);
    if (match) {
      dependencies.push({
        name: normalizePythonName(match[1]),
        version: line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") || null,
        type: section === "dev-packages" ? "development" : "production"
      });
    }
  }
  return sortUniquePythonDependencies(dependencies);
}

function toPythonDependency(specifier, type) {
  const clean = specifier.trim().replace(/;.*$/, "");
  if (!clean) return null;
  const match = clean.match(/^([A-Za-z0-9_.-]+)/);
  if (!match) return null;
  return {
    name: normalizePythonName(match[1]),
    version: clean.slice(match[1].length).trim() || null,
    type
  };
}

function normalizePythonName(name) {
  return name.toLowerCase().replace(/_/g, "-");
}

function sortUniquePythonDependencies(dependencies) {
  const seen = new Set();
  return dependencies
    .filter((entry) => {
      const key = `${entry.type}:${entry.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parseJavaDependencies(manifest, text) {
  if (manifest === "pom.xml") return parsePomDependencies(text);
  return parseGradleDependencies(text);
}

function parsePomDependencies(text) {
  const dependencies = [];
  for (const match of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = match[1];
    const group = xmlTag(block, "groupId");
    const artifact = xmlTag(block, "artifactId");
    if (!group || !artifact) continue;
    dependencies.push({
      group,
      artifact,
      version: xmlTag(block, "version"),
      scope: xmlTag(block, "scope") || "compile",
      type: "maven"
    });
  }
  return dependencies.sort((left, right) => `${left.group}:${left.artifact}`.localeCompare(`${right.group}:${right.artifact}`));
}

function xmlTag(text, tag) {
  const match = text.match(new RegExp(`<${tag}>([^<]+)<\\/${tag}>`));
  return match ? match[1].trim() : null;
}

function parseGradleDependencies(text) {
  const dependencies = [];
  const pattern = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*(?:\(?\s*)["']([^:"']+):([^:"']+):([^"']+)["']/g;
  for (const match of text.matchAll(pattern)) {
    dependencies.push({
      group: match[1],
      artifact: match[2],
      version: match[3],
      scope: match[0].split(/\s+/)[0].replace("(", ""),
      type: "gradle"
    });
  }
  return dependencies.sort((left, right) => `${left.group}:${left.artifact}`.localeCompare(`${right.group}:${right.artifact}`));
}

function stripped(line) {
  return line.replace(/\s*\/\/.*$/, "").trim();
}
