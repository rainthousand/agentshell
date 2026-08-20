import fs from "node:fs";
import path from "node:path";

import { detectPackageManager, scriptCommand } from "../core/package-json.js";
import { findUp, readJson } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.test-list.v1";
const DEFAULT_COMPACT_FILE_LIMIT = 40;
const TEST_SCRIPT_NAME = /(^|[-_:])(test|spec|e2e|unit)($|[-_:])/i;
const TEST_FILE_NAME = /(^|\.)(test|spec)\.[cm]?[jt]sx?$/i;
const GO_TEST_FILE_NAME = /_test\.go$/;
const PYTHON_TEST_FILE_NAME = /^(?:test_.*|.*_test)\.py$/i;
const JAVA_TEST_FILE_NAME = /(?:Test|Tests|IT)\.java$/;
const TEST_DIRECTORIES = new Set(["tests", "__tests__"]);
const IGNORED_DIRECTORIES = new Set([
  ".agentshell",
  ".cache",
  ".git",
  ".next",
  ".parcel-cache",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
  "temp",
  "vendor"
]);

export async function testList(root, options = {}) {
  const projectRoot = resolveProjectRoot(root);
  const compact = options.compact === true;
  const maxFiles = compact ? positiveInteger(options.maxFiles, DEFAULT_COMPACT_FILE_LIMIT) : Number.POSITIVE_INFINITY;

  const allScripts = discoverNodeScripts(projectRoot);
  const scan = discoverTestFiles(projectRoot, maxFiles);
  const packages = discoverPackages(projectRoot);
  const summary = summarize(allScripts, scan, packages);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    summary,
    scripts: allScripts,
    files: scan.files,
    packages,
    suggestedNextActions: suggestedNextActions(summary, allScripts, packages)
  };
}

export const listTests = testList;

function resolveProjectRoot(root) {
  const manifest = findUp(root, [
    "package.json",
    "go.work",
    "go.mod",
    "pyproject.toml",
    "pytest.ini",
    "tox.ini",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts"
  ]);
  return manifest ? path.dirname(manifest) : path.resolve(root);
}

function discoverNodeScripts(projectRoot) {
  const packagePath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packagePath)) return [];

  const manifest = readJson(packagePath);
  const rawScripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const packageManager = detectPackageManager(projectRoot);

  return Object.entries(rawScripts)
    .filter(([name, command]) => typeof command === "string" && TEST_SCRIPT_NAME.test(name))
    .sort(([left], [right]) => scriptPriority(left) - scriptPriority(right) || left.localeCompare(right))
    .map(([name, command]) => ({
      name,
      command,
      category: scriptCategory(name),
      packageManager,
      runCommand: scriptCommand(packageManager, name)
    }));
}

function discoverTestFiles(projectRoot, maxFiles) {
  const state = {
    totalFiles: 0,
    nodeFileCount: 0,
    goFileCount: 0,
    pythonFileCount: 0,
    javaFileCount: 0,
    files: [],
    truncated: false
  };

  scanDirectory(projectRoot, "", state, maxFiles);
  return state;
}

function scanDirectory(directory, relativeDirectory, state, maxFiles) {
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
      scanDirectory(path.join(directory, entry.name), relativePath, state, maxFiles);
      continue;
    }

    if (!entry.isFile()) continue;
    const match = classifyTestFile(relativePath);
    if (!match) continue;

    state.totalFiles += 1;
    if (match.language === "go") {
      state.goFileCount += 1;
    } else if (match.language === "python") {
      state.pythonFileCount += 1;
    } else if (match.language === "java") {
      state.javaFileCount += 1;
    } else {
      state.nodeFileCount += 1;
    }
    if (state.files.length >= maxFiles) {
      state.truncated = true;
      continue;
    }

    state.files.push({
      path: relativePath,
      language: match.language,
      kind: match.kind
    });
  }
}

function classifyTestFile(relativePath) {
  const parts = relativePath.split("/");
  const basename = parts.at(-1);
  if (GO_TEST_FILE_NAME.test(basename)) {
    return { language: "go", kind: "go-test" };
  }

  if (isPythonTestConfig(basename)) {
    return { language: "python", kind: "python-config" };
  }

  if (PYTHON_TEST_FILE_NAME.test(basename)) {
    return { language: "python", kind: "python-pattern" };
  }

  if (parts.some((part) => part === "tests") && /\.py$/i.test(basename)) {
    return { language: "python", kind: "python-directory" };
  }

  if (/^src\/test\/java\/.+\.java$/.test(relativePath)) {
    return { language: "java", kind: "java-standard" };
  }

  if (JAVA_TEST_FILE_NAME.test(basename)) {
    return { language: "java", kind: "java-pattern" };
  }

  if (TEST_FILE_NAME.test(basename)) {
    return { language: nodeLanguage(basename), kind: "node-pattern" };
  }

  if (parts.some((part) => TEST_DIRECTORIES.has(part)) && nodeTestExtension(basename)) {
    return { language: nodeLanguage(basename), kind: "node-directory" };
  }

  return null;
}

function discoverPackages(projectRoot) {
  const packages = [];
  const packagePath = path.join(projectRoot, "package.json");
  if (fs.existsSync(packagePath)) {
    const manifest = readJson(packagePath);
    packages.push({
      type: "node",
      name: manifest.name || path.basename(projectRoot),
      path: "package.json",
      packageManager: detectPackageManager(projectRoot)
    });
  }

  const goWorkPath = path.join(projectRoot, "go.work");
  if (fs.existsSync(goWorkPath)) {
    const modules = parseGoWorkUses(fs.readFileSync(goWorkPath, "utf8"))
      .map((modulePath) => path.posix.normalize(modulePath.replaceAll(path.sep, "/")))
      .filter((modulePath) => modulePath !== ".." && !modulePath.startsWith("../"));

    packages.push({
      type: "go-workspace",
      name: "go.work",
      path: "go.work",
      modules
    });

    for (const modulePath of modules) {
      const absoluteModulePath = path.join(projectRoot, modulePath);
      const goModPath = path.join(absoluteModulePath, "go.mod");
      if (!fs.existsSync(goModPath)) continue;
      packages.push({
        type: "go",
        name: parseGoModuleName(fs.readFileSync(goModPath, "utf8")) || path.basename(absoluteModulePath),
        path: modulePath === "." ? "go.mod" : `${modulePath}/go.mod`
      });
    }
  } else {
    const goModPath = path.join(projectRoot, "go.mod");
    if (fs.existsSync(goModPath)) {
      packages.push({
        type: "go",
        name: parseGoModuleName(fs.readFileSync(goModPath, "utf8")) || path.basename(projectRoot),
        path: "go.mod"
      });
    }
  }

  const pythonPackage = discoverPythonPackage(projectRoot);
  if (pythonPackage) packages.push(pythonPackage);

  const javaPackage = discoverJavaPackage(projectRoot);
  if (javaPackage) packages.push(javaPackage);

  const mavenPackage = discoverMavenPackage(projectRoot);
  if (mavenPackage) packages.push(mavenPackage);

  const gradlePackage = discoverGradlePackage(projectRoot);
  if (gradlePackage) packages.push(gradlePackage);

  return packages;
}

function summarize(scripts, scan, packages) {
  const nodePackageCount = packages.filter((entry) => entry.type === "node").length;
  const goPackageCount = packages.filter((entry) => entry.type === "go").length;
  const goWorkspaceCount = packages.filter((entry) => entry.type === "go-workspace").length;
  const pythonPackageCount = packages.filter((entry) => entry.type === "python").length;
  const javaPackageCount = packages.filter((entry) => ["java", "maven", "gradle"].includes(entry.type)).length;

  return {
    totalScripts: scripts.length,
    totalFiles: scan.totalFiles,
    returnedFiles: scan.files.length,
    truncated: scan.truncated,
    packageCount: packages.length,
    nodePackageCount,
    goPackageCount,
    goWorkspaceCount,
    pythonPackageCount,
    javaPackageCount,
    nodeFileCount: scan.nodeFileCount,
    goFileCount: scan.goFileCount,
    pythonFileCount: scan.pythonFileCount,
    javaFileCount: scan.javaFileCount,
    hasTests: scripts.length > 0
      || scan.totalFiles > 0
      || goPackageCount > 0
      || pythonPackageCount > 0
      || javaPackageCount > 0
  };
}

function suggestedNextActions(summary, scripts, packages) {
  const actions = [];
  const firstScript = scripts[0];
  if (firstScript) {
    actions.push({
      command: firstScript.runCommand,
      reason: "Run the first detected Node test script when ready"
    });
  }

  if (packages.some((entry) => entry.type === "go")) {
    actions.push({
      command: "go test ./...",
      reason: "Run Go tests from the detected module or workspace when ready"
    });
  }

  if (packages.some((entry) => entry.type === "python")) {
    actions.push({
      command: "python -m pytest",
      reason: "Run Python tests from the detected Python project or test configuration when ready"
    });
  }

  if (packages.some((entry) => entry.type === "maven")) {
    actions.push({
      command: "mvn test",
      reason: "Run Java tests from the detected Maven project when ready"
    });
  } else if (packages.some((entry) => entry.type === "gradle")) {
    actions.push({
      command: "gradle test",
      reason: "Run Java tests from the detected Gradle project when ready"
    });
  } else if (packages.some((entry) => entry.type === "java")) {
    actions.push({
      command: "agentshell tree --compact",
      reason: "Java test files were detected without a Maven or Gradle entrypoint; inspect layout before running tests"
    });
  }

  if (summary.truncated) {
    actions.push({
      command: "agentshell test list",
      reason: "Compact file output was truncated; request the full discovered file list only if needed"
    });
  }

  if (actions.length === 0) {
    actions.push({
      command: "agentshell tree --compact",
      reason: "No common test entry points were detected; inspect project layout next"
    });
  }

  return actions;
}

function scriptCategory(name) {
  const normalized = name.toLowerCase();
  if (/(^|[-_:])e2e($|[-_:])/.test(normalized)) return "e2e";
  if (/(^|[-_:])unit($|[-_:])/.test(normalized)) return "unit";
  if (/(^|[-_:])spec($|[-_:])/.test(normalized)) return "spec";
  return "test";
}

function scriptPriority(name) {
  return {
    test: 0,
    unit: 1,
    spec: 2,
    e2e: 3
  }[scriptCategory(name)] ?? 4;
}

function entryPriority(relativeDirectory, entry) {
  const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
  if (entry.isFile() && relativePath === "package.json") return 0;
  if (entry.isFile() && (relativePath === "go.mod" || relativePath === "go.work")) return 1;
  if (entry.isFile() && isProjectMarker(relativePath)) return 1;
  if (entry.isDirectory() && TEST_DIRECTORIES.has(entry.name)) return 2;
  if (entry.isFile() && classifyTestFile(relativePath)) return 3;
  if (entry.isDirectory()) return 4;
  return 5;
}

function parseGoModuleName(contents) {
  const match = /^\s*module\s+(\S+)/m.exec(contents);
  return match ? match[1] : null;
}

function parseGoWorkUses(contents) {
  const uses = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.replace(/\/\/.*$/, "").trim();
    if (!trimmed || trimmed === "use" || trimmed === "use (" || trimmed === ")") continue;
    const match = /^use\s+(.+)$/.exec(trimmed);
    const value = match ? match[1].trim() : trimmed;
    if (value && !value.includes(" ")) uses.push(value);
  }
  return uses.length > 0 ? uses : ["."];
}

function nodeLanguage(file) {
  return /\.tsx?$/i.test(file) ? "typescript" : "javascript";
}

function nodeTestExtension(file) {
  return /\.[cm]?[jt]sx?$/i.test(file);
}

function isPythonTestConfig(basename) {
  return ["pyproject.toml", "setup.cfg", "tox.ini", "pytest.ini"].includes(basename);
}

function discoverPythonPackage(projectRoot) {
  const markers = [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "pytest.ini",
    "poetry.lock",
    "Pipfile"
  ];
  const marker = markers.find((file) => fs.existsSync(path.join(projectRoot, file)))
    || fs.readdirSync(projectRoot).find((file) => /^requirements.*\.txt$/i.test(file));
  if (!marker) return null;
  return {
    type: "python",
    name: path.basename(projectRoot),
    path: marker
  };
}

function discoverJavaPackage(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, "src", "main", "java"))
    && !fs.existsSync(path.join(projectRoot, "src", "test", "java"))) {
    return null;
  }
  return {
    type: "java",
    name: path.basename(projectRoot),
    path: "src"
  };
}

function discoverMavenPackage(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, "pom.xml"))) return null;
  return {
    type: "maven",
    name: path.basename(projectRoot),
    path: "pom.xml"
  };
}

function discoverGradlePackage(projectRoot) {
  const markers = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
  const marker = markers.find((file) => fs.existsSync(path.join(projectRoot, file)));
  if (!marker) return null;
  return {
    type: "gradle",
    name: path.basename(projectRoot),
    path: marker
  };
}

function isProjectMarker(relativePath) {
  return [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "pytest.ini",
    "poetry.lock",
    "Pipfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts"
  ].includes(relativePath)
    || /^requirements.*\.txt$/i.test(relativePath);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
