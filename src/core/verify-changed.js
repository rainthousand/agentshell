import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_CHANGED_FILES = 500;
const MAX_PLAN_STEPS = 16;
const MAX_GRAPH_PACKAGES = 2000;
const MAX_GRAPH_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TARGET_PACKAGES = 100;
const DOC_FILE = /(?:^|\/)(?:docs?\/|README(?:\.|$)|CHANGELOG(?:\.|$)|LICENSE(?:\.|$))|\.(?:md|mdx|rst|txt)$/i;

export const VERIFY_CHANGED_PROTOCOL = "agentshell.verify-changed.v1";

export function readChangedFiles(root, options = {}) {
  if (Array.isArray(options.changedFiles)) {
    const files = normalizeFiles(options.changedFiles);
    return boundedChangedFiles(files, options.changedFilesTotal ?? files.length);
  }

  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    shell: false
  });
  if (result.status !== 0) {
    return {
      ok: false,
      code: "GIT_STATUS_FAILED",
      message: compactText(result.stderr || result.error?.message || "Unable to read Git changed files", 300)
    };
  }
  return boundedChangedFiles(parsePorcelainZ(result.stdout), undefined);
}

export function planChangedVerification(root, options = {}) {
  const changed = readChangedFiles(root, options);
  if (!changed.ok) return changed;

  const ecosystems = detectEcosystems(root);
  const classification = classifyChanges(changed.files, ecosystems, changed.truncated);
  const dependencyState = { requested: options.includeDependents === true, expanded: false, fallback: false };
  let plans = [];
  for (const ecosystem of ecosystems) {
    if (!classification.active.has(ecosystem.kind) && !classification.fullFallback) continue;
    plans.push(...planForEcosystem(root, ecosystem, changed, classification, options, dependencyState));
  }

  if (plans.length > MAX_PLAN_STEPS) {
    classification.fullFallback = true;
    dependencyState.expanded = false;
    dependencyState.fallback = dependencyState.fallback || dependencyState.requested;
    classification.reasons.push("Affected verification plan exceeded the output bound; require full verification");
    plans = ecosystems.flatMap((ecosystem) => planForEcosystem(
      root,
      ecosystem,
      changed,
      classification,
      { ...options, includeDependents: false },
      dependencyState
    ));
  }

  if (classification.fullFallback && ecosystems.length === 0 && changed.files.length > 0) {
    plans.push(step("test", "unknown", "full", ["agentshell", "verify", "test", "--compact"],
      "Changed files could not be mapped to a supported project manifest; require full project verification", true));
  }

  const boundedPlan = dedupeSteps(plans).slice(0, MAX_PLAN_STEPS);
  const fallback = classification.fullFallback || boundedPlan.some((entry) => entry.fallback);
  return {
    ok: true,
    protocolVersion: VERIFY_CHANGED_PROTOCOL,
    includeDependents: dependencyState.requested,
    changedFiles: changed.files,
    changedFilesTotal: changed.total,
    changedFilesTruncated: changed.truncated,
    ecosystems: ecosystems.map((entry) => entry.kind),
    plan: boundedPlan,
    summary: {
      clean: changed.total === 0,
      changedFileCount: changed.total,
      returnedChangedFileCount: changed.files.length,
      planStepCount: boundedPlan.length,
      fullFallback: fallback,
      planTruncated: plans.length > boundedPlan.length,
      dependentsExpanded: dependencyState.expanded,
      dependencyFallback: dependencyState.fallback
    },
    reasons: classification.reasons.slice(0, 8)
  };
}

function planForEcosystem(root, ecosystem, changed, classification, options, dependencyState) {
  if (ecosystem.kind === "node") return planNode(root, ecosystem, changed, classification, options, dependencyState);
  if (ecosystem.kind === "go") return planGo(root, ecosystem, changed, classification, options, dependencyState);
  if (ecosystem.kind === "python") return planPython(root, ecosystem, classification);
  return planJava(root, ecosystem, classification);
}

function planNode(root, ecosystem, changed, classification, options, dependencyState) {
  const result = [];
  const scripts = ecosystem.scripts;
  if (options.includeDependents === true && !classification.fullFallback) {
    const focused = nodeDependentPlan(root, ecosystem, changed.files);
    if (focused.ok) {
      dependencyState.expanded = dependencyState.expanded || focused.expanded;
      return focused.plan;
    }
    dependencyState.fallback = true;
    classification.reasons.push(`Node dependency graph was not reliable (${focused.reason}); require full Node verification`);
  }
  const formatScript = ["format:check", "check:format"].find((name) => scripts[name]);
  if (formatScript) result.push(step("format", "node", "full", packageScript(ecosystem.manager, formatScript), "Use the configured non-mutating format check"));
  else if (scripts.lint) result.push(step("format", "node", "full", packageScript(ecosystem.manager, "lint"), "Use the configured lint check as the available source-quality gate"));
  if (scripts.build) result.push(step("build", "node", "full", packageScript(ecosystem.manager, "build"), "Node source or project inputs changed"));
  if (scripts.test) result.push(step("test", "node", "full", packageScript(ecosystem.manager, "test"), "Test-runner file mapping is not assumed; run the complete configured test script", true));
  else result.push(step("test", "node", "full", ["agentshell", "verify", "test", "--compact"], "No test script was found; require AgentShell full-test discovery", true));
  return markFallback(result, classification.fullFallback);
}

function planGo(root, ecosystem, changed, classification, options, dependencyState) {
  const goFiles = changed.files.filter((file) => file.endsWith(".go") && fs.existsSync(path.join(root, file)));
  const uncertain = classification.fullFallback || changed.truncated || changed.files.some(isGoControlFile);
  let packages = uncertain ? ["./..."] : goPackages(goFiles);
  let packageFallback = false;
  if (!uncertain && packages.length > MAX_TARGET_PACKAGES) {
    packages = ["./..."];
    packageFallback = true;
    classification.reasons.push("Changed Go package set exceeds the safe bound; require ./... verification");
  }
  let dependencyFallback = false;
  if (options.includeDependents === true && !uncertain && !packageFallback && packages.length > 0) {
    const expanded = expandGoDependents(root, packages, options);
    if (expanded.ok) {
      packages = expanded.packages;
      dependencyState.expanded = dependencyState.expanded || expanded.expanded;
    } else {
      packages = ["./..."];
      dependencyFallback = true;
      dependencyState.fallback = true;
      classification.reasons.push(`Go dependency graph was not reliable (${expanded.reason}); require ./... verification`);
    }
  }
  const targetPackages = packages.length > 0 ? packages : ["./..."];
  const fallback = uncertain || packageFallback || dependencyFallback || packages.length === 0;
  const result = [];
  for (let index = 0; index < goFiles.length; index += 100) {
    result.push(step("format", "go", "changed-files", ["gofmt", "-d", ...goFiles.slice(index, index + 100)], "Check formatting of changed Go files without modifying them"));
  }
  result.push(step("build", "go", fallback ? "full" : "packages", ["go", "test", "-run", "^$", ...targetPackages], fallback ? "Go package mapping is uncertain; compile all packages" : "Compile affected Go packages and their tests", fallback));
  result.push(step("test", "go", fallback ? "full" : "packages", ["go", "test", ...targetPackages], fallback ? "Go package mapping is uncertain; test all packages" : "Test affected Go packages", fallback));
  return result;
}

function planPython(root, ecosystem, classification) {
  const result = [];
  const config = readSmallFiles(root, ["pyproject.toml", "setup.cfg"]);
  if (/\[tool\.ruff(?:\.|\])|\[ruff\]/.test(config)) {
    result.push(step("format", "python", "full", ["python", "-m", "ruff", "format", "--check", "."], "Use configured Ruff formatting check"));
  } else if (/\[tool\.black\]|\[black\]/.test(config)) {
    result.push(step("format", "python", "full", ["python", "-m", "black", "--check", "."], "Use configured Black formatting check"));
  }
  result.push(step("build", "python", "full", ["python", "-m", "compileall", "-q", "."], "Compile the full Python tree because import dependencies are dynamic", true));
  result.push(step("test", "python", "full", ["python", "-m", "pytest"], "Source-to-test mapping is not assumed; run the full Python test suite", true));
  return markFallback(result, classification.fullFallback);
}

function planJava(root, ecosystem, classification) {
  const result = [];
  const fallback = true;
  if (ecosystem.tool === "maven") {
    const executable = fs.existsSync(path.join(root, "mvnw")) ? "./mvnw" : "mvn";
    const config = readSmallFiles(root, ["pom.xml"]);
    if (/spotless/i.test(config)) result.push(step("format", "java", "full", [executable, "-q", "spotless:check"], "Use configured Spotless formatting check"));
    result.push(step("build", "java", "full", [executable, "-q", "-DskipTests", "compile"], "Compile the complete Maven project because module dependencies may cross packages", fallback));
    result.push(step("test", "java", "full", [executable, "-q", "test"], "Run the complete Maven test suite", fallback));
  } else {
    const executable = fs.existsSync(path.join(root, "gradlew")) ? "./gradlew" : "gradle";
    const config = readSmallFiles(root, ["build.gradle", "build.gradle.kts"]);
    if (/spotless/i.test(config)) result.push(step("format", "java", "full", [executable, "spotlessCheck", "--console=plain"], "Use configured Spotless formatting check"));
    result.push(step("build", "java", "full", [executable, "classes", "--console=plain"], "Build the complete Gradle project because module dependencies may cross packages", fallback));
    result.push(step("test", "java", "full", [executable, "test", "--console=plain"], "Run the complete Gradle test suite", fallback));
  }
  return markFallback(result, classification.fullFallback);
}

function detectEcosystems(root) {
  const ecosystems = [];
  const packagePath = path.join(root, "package.json");
  if (fs.existsSync(packagePath)) {
    let value = {};
    try { value = JSON.parse(fs.readFileSync(packagePath, "utf8")); } catch { /* handled by conservative scripts fallback */ }
    ecosystems.push({ kind: "node", manager: detectNodeManager(root), scripts: value.scripts || {} });
  }
  if (fs.existsSync(path.join(root, "go.mod")) || fs.existsSync(path.join(root, "go.work"))) ecosystems.push({ kind: "go" });
  if (["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pytest.ini"].some((name) => fs.existsSync(path.join(root, name)))) ecosystems.push({ kind: "python" });
  if (fs.existsSync(path.join(root, "pom.xml"))) ecosystems.push({ kind: "java", tool: "maven" });
  else if (["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((name) => fs.existsSync(path.join(root, name)))) ecosystems.push({ kind: "java", tool: "gradle" });
  return ecosystems;
}

function classifyChanges(files, ecosystems, truncated) {
  const active = new Set();
  const reasons = [];
  let fullFallback = Boolean(truncated);
  if (truncated) reasons.push("Changed-file input was truncated; require full verification for every detected ecosystem");
  for (const file of files) {
    if (DOC_FILE.test(file)) continue;
    const kinds = kindsForFile(file);
    if (kinds.length === 0) {
      fullFallback = true;
      reasons.push(`Unmapped changed file requires full verification: ${file}`);
    }
    for (const kind of kinds) active.add(kind);
  }
  const available = new Set(ecosystems.map((entry) => entry.kind));
  const unavailable = [...active].filter((kind) => !available.has(kind));
  if (unavailable.length > 0) {
    fullFallback = true;
    reasons.push(`Changed files map to ${unavailable.join(", ")} but no matching root manifest was found; require full project verification`);
  }
  if (fullFallback) for (const entry of ecosystems) active.add(entry.kind);
  return { active, fullFallback, reasons };
}

function kindsForFile(file) {
  const name = path.posix.basename(file.toLowerCase());
  const kinds = [];
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|css|scss|vue|svelte)$/.test(file) || ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].includes(name)) kinds.push("node");
  if (/\.go$/.test(file) || ["go.mod", "go.sum", "go.work"].includes(name)) kinds.push("go");
  if (/\.pyi?$/.test(file) || /^requirements.*\.txt$/.test(name) || ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"].includes(name)) kinds.push("python");
  if (/\.(?:java|kt|kts|gradle)$/.test(file) || ["pom.xml", "gradlew", "mvnw", "settings.gradle"].includes(name)) kinds.push("java");
  return [...new Set(kinds)];
}

function goPackages(files) {
  return [...new Set(files.map((file) => {
    const directory = path.posix.dirname(file);
    return directory === "." ? "." : `./${directory}`;
  }))].sort();
}

function expandGoDependents(root, changedPackages, options) {
  const runner = options.spawnSync || spawnSync;
  let result;
  try {
    result = runner("go", ["list", "-json", "./..."], {
      cwd: root,
      encoding: "utf8",
      env: safeGoDiscoveryEnvironment(options.env),
      maxBuffer: MAX_GRAPH_OUTPUT_BYTES,
      timeout: 10_000,
      shell: false
    });
  } catch {
    return { ok: false, reason: "go list failed" };
  }
  if (result.status !== 0 || result.error) return { ok: false, reason: "go list failed" };
  if (Buffer.byteLength(String(result.stdout || ""), "utf8") > MAX_GRAPH_OUTPUT_BYTES) {
    return { ok: false, reason: "go list output exceeded the safe bound" };
  }
  let records;
  try { records = parseJsonStream(result.stdout, MAX_GRAPH_PACKAGES); } catch { return { ok: false, reason: "go list returned invalid or excessive JSON" }; }
  if (records.length === 0 || records.length > MAX_GRAPH_PACKAGES) return { ok: false, reason: "package graph is empty or too large" };

  const byImport = new Map();
  const byPattern = new Map();
  for (const record of records) {
    if (!record || typeof record.ImportPath !== "string" || typeof record.Dir !== "string" || record.Incomplete || record.Error || record.DepsErrors?.length) {
      return { ok: false, reason: "package graph is incomplete" };
    }
    const relative = path.relative(root, record.Dir).replaceAll("\\", "/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) return { ok: false, reason: "package graph leaves the workspace" };
    const pattern = relative === "" ? "." : `./${relative}`;
    if (byImport.has(record.ImportPath) || byPattern.has(pattern)) return { ok: false, reason: "package graph is ambiguous" };
    const imports = dependencyImports(record);
    if (!imports) return { ok: false, reason: "package graph contains invalid dependencies" };
    const node = { importPath: record.ImportPath, pattern, imports };
    byImport.set(node.importPath, node);
    byPattern.set(pattern, node);
  }
  const seeds = changedPackages.map((pattern) => byPattern.get(pattern));
  if (seeds.some((entry) => !entry)) return { ok: false, reason: "changed package was not found in graph" };

  const selected = new Set(seeds.map((entry) => entry.importPath));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of byImport.values()) {
      if (!selected.has(node.importPath) && node.imports.some((dependency) => selected.has(dependency))) {
        selected.add(node.importPath);
        changed = true;
      }
    }
  }
  const packages = [...selected].map((name) => byImport.get(name).pattern).sort();
  if (packages.length > MAX_TARGET_PACKAGES) return { ok: false, reason: "affected package set exceeds the safe bound" };
  return { ok: true, packages, expanded: packages.length > changedPackages.length };
}

function safeGoDiscoveryEnvironment(environment) {
  const env = {
    ...(environment || process.env),
    GOENV: "off",
    GOFLAGS: "-mod=readonly",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOTOOLCHAIN: "local"
  };
  delete env.GOWORK;
  return env;
}

function parseJsonStream(value, maxRecords) {
  const records = [];
  const text = String(value || "");
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{") { if (depth === 0) start = index; depth += 1; }
    else if (character === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("invalid JSON stream");
      if (depth === 0 && start >= 0) {
        records.push(JSON.parse(text.slice(start, index + 1)));
        if (records.length > maxRecords) throw new Error("too many JSON records");
      }
    }
  }
  if (depth !== 0 || quoted) throw new Error("incomplete JSON stream");
  return records;
}

function dependencyImports(record) {
  const values = [];
  for (const key of ["Imports", "TestImports", "XTestImports", "Deps"]) {
    if (record[key] === undefined) continue;
    if (!Array.isArray(record[key]) || record[key].some((value) => typeof value !== "string")) return null;
    values.push(...record[key]);
  }
  return [...new Set(values)];
}

function nodeDependentPlan(root, ecosystem, changedFiles) {
  const rootManifest = readJsonFile(path.join(root, "package.json"));
  const workspacePatterns = Array.isArray(rootManifest?.workspaces) ? rootManifest.workspaces : rootManifest?.workspaces?.packages;
  if (!Array.isArray(workspacePatterns) || workspacePatterns.length === 0) return { ok: false, reason: "no supported workspace declaration" };
  if (changedFiles.some((file) => !file.includes("/") || /(^|\/)(?:package\.json|[^/]*lock[^/]*)$/.test(file))) {
    return { ok: false, reason: "root or dependency control files changed" };
  }
  const directories = expandWorkspacePatterns(root, workspacePatterns);
  if (!directories.ok) return directories;
  const packages = [];
  for (const directory of directories.values) {
    const manifest = readJsonFile(path.join(root, directory, "package.json"));
    if (!manifest || typeof manifest.name !== "string" || !manifest.name) return { ok: false, reason: "workspace manifest is missing or unnamed" };
    packages.push({ directory, name: manifest.name, scripts: manifest.scripts || {}, dependencies: dependencyNames(manifest) });
  }
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  if (byName.size !== packages.length || packages.length > MAX_GRAPH_PACKAGES) return { ok: false, reason: "workspace graph is ambiguous or too large" };
  const seeds = packages.filter((entry) => changedFiles.some((file) => file === entry.directory || file.startsWith(`${entry.directory}/`)));
  if (seeds.length === 0) return { ok: false, reason: "changed files do not map to a workspace" };
  const selected = new Set(seeds.map((entry) => entry.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of packages) {
      if (!selected.has(entry.name) && entry.dependencies.some((name) => selected.has(name))) {
        selected.add(entry.name);
        changed = true;
      }
    }
  }
  const targets = [...selected].map((name) => byName.get(name));
  if (targets.length > MAX_TARGET_PACKAGES || targets.some((entry) => !entry.scripts.test)) return { ok: false, reason: "affected workspaces lack bounded test scripts" };
  const plan = [];
  const formatScript = ["format:check", "check:format"].find((name) => ecosystem.scripts[name]);
  if (formatScript) plan.push(step("format", "node", "full", packageScript(ecosystem.manager, formatScript), "Keep the configured root formatting gate for affected workspaces"));
  else if (ecosystem.scripts.lint) plan.push(step("format", "node", "full", packageScript(ecosystem.manager, "lint"), "Keep the configured root lint gate for affected workspaces"));
  for (const target of targets) {
    if (target.scripts.build) plan.push(step("build", "node", "packages", workspaceScript(ecosystem.manager, target.name, "build"), `Build affected workspace ${target.name}`));
    plan.push(step("test", "node", "packages", workspaceScript(ecosystem.manager, target.name, "test"), `Test affected workspace ${target.name}`));
  }
  if (plan.length > MAX_PLAN_STEPS) return { ok: false, reason: "affected workspace plan exceeds the safe bound" };
  return { ok: true, plan, expanded: targets.length > seeds.length };
}

function expandWorkspacePatterns(root, patterns) {
  const values = new Set();
  for (const rawPattern of patterns) {
    const pattern = String(rawPattern).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!pattern || pattern.startsWith("../") || path.posix.isAbsolute(pattern) || pattern.includes("**") || (pattern.match(/\*/g) || []).length > 1) {
      return { ok: false, reason: "workspace pattern is unsupported" };
    }
    if (pattern.includes("*")) {
      const [parent, suffix] = pattern.split("*");
      if (suffix) return { ok: false, reason: "workspace pattern is unsupported" };
      const parentPath = path.join(root, parent);
      let entries;
      try { entries = fs.readdirSync(parentPath, { withFileTypes: true }); } catch { return { ok: false, reason: "workspace directory cannot be read" }; }
      for (const entry of entries) if (entry.isDirectory()) values.add(path.posix.join(parent, entry.name).replace(/\/$/, ""));
    } else values.add(pattern);
  }
  for (const directory of values) {
    try {
      const real = fs.realpathSync(path.join(root, directory));
      const relative = path.relative(fs.realpathSync(root), real);
      if (relative.startsWith("../") || path.isAbsolute(relative)) return { ok: false, reason: "workspace member leaves the project" };
    } catch { return { ok: false, reason: "workspace member cannot be resolved" }; }
  }
  return values.size > 0 ? { ok: true, values: [...values].sort() } : { ok: false, reason: "workspace declaration resolved no packages" };
}

function readJsonFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

function dependencyNames(manifest) {
  return [...new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => Object.keys(manifest[key] || {})))];
}

function workspaceScript(manager, workspace, script) {
  if (manager === "pnpm") return ["pnpm", "--filter", workspace, "run", script];
  if (manager === "yarn") return ["yarn", "workspace", workspace, script];
  if (manager === "bun") return ["bun", "--filter", workspace, "run", script];
  return ["npm", "run", script, "--workspace", workspace];
}

function isGoControlFile(file) {
  return /(^|\/)(go\.(?:mod|sum|work)|vendor\/|tools\.go$)/.test(file);
}

function packageScript(manager, name) {
  if (manager === "yarn") return ["yarn", name];
  if (manager === "pnpm") return ["pnpm", "run", name];
  if (manager === "bun") return ["bun", "run", name];
  return ["npm", "run", name];
}

function detectNodeManager(root) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  return "npm";
}

function step(kind, ecosystem, scope, argv, reason, fallback = false) {
  return { kind, ecosystem, scope, argv, reason: compactText(reason, 240), fallback: Boolean(fallback) };
}

function markFallback(steps, fallback) {
  if (!fallback) return steps;
  return steps.map((entry) => ({ ...entry, scope: "full", fallback: true }));
}

function dedupeSteps(steps) {
  const seen = new Set();
  return steps.filter((entry) => {
    const key = JSON.stringify(entry.argv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePorcelainZ(output) {
  const records = String(output || "").split("\0");
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    files.push(record.slice(3));
    if (/[RC]/.test(status) && records[index + 1]) index += 1;
  }
  return normalizeFiles(files);
}

function normalizeFiles(files) {
  return [...new Set(files.map((file) => String(file).replaceAll("\\", "/").replace(/^\.\//, "")).filter((file) => file && !file.startsWith("../") && !path.posix.isAbsolute(file)))].sort();
}

function boundedChangedFiles(files, reportedTotal) {
  const total = Math.max(files.length, Number.isInteger(reportedTotal) ? reportedTotal : files.length);
  return { ok: true, files: files.slice(0, MAX_CHANGED_FILES), total, truncated: total > MAX_CHANGED_FILES || files.length > MAX_CHANGED_FILES };
}

function readSmallFiles(root, names) {
  return names.map((name) => {
    try { return fs.readFileSync(path.join(root, name), "utf8").slice(0, 128 * 1024); } catch { return ""; }
  }).join("\n");
}

function compactText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}
