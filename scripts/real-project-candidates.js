#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const options = parseArgs(process.argv.slice(2));
const report = evaluateCandidates(loadCandidates(options), options);

if (options.report) writeJsonFile(options.report, report);
if (options.manifestDraft) writeJsonFile(options.manifestDraft, report.manifestDraft);
if (options.markdown) writeTextFile(options.markdown, renderMarkdownReport(report));
console.log(JSON.stringify(report, null, 2));

function parseArgs(args) {
  const repos = [];
  let candidates = null;
  let report = null;
  let manifestDraft = null;
  let markdown = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repos.push(requireValue(args[index + 1], "--repo"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      repos.push(requireValue(arg.slice("--repo=".length), "--repo"));
      continue;
    }
    if (arg === "--candidates") {
      candidates = requireValue(args[index + 1], "--candidates");
      index += 1;
      continue;
    }
    if (arg.startsWith("--candidates=")) {
      candidates = requireValue(arg.slice("--candidates=".length), "--candidates");
      continue;
    }
    if (arg === "--report") {
      report = path.resolve(process.cwd(), requireValue(args[index + 1], "--report"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--report=")) {
      report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
      continue;
    }
    if (arg === "--manifest-draft") {
      manifestDraft = path.resolve(process.cwd(), requireValue(args[index + 1], "--manifest-draft"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--manifest-draft=")) {
      manifestDraft = path.resolve(process.cwd(), requireValue(arg.slice("--manifest-draft=".length), "--manifest-draft"));
      continue;
    }
    if (arg === "--markdown") {
      markdown = path.resolve(process.cwd(), requireValue(args[index + 1], "--markdown"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--markdown=")) {
      markdown = path.resolve(process.cwd(), requireValue(arg.slice("--markdown=".length), "--markdown"));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(JSON.stringify({
        ok: true,
        usage: "node scripts/real-project-candidates.js --repo <path-or-url> [--repo <path-or-url>...] [--candidates candidates.json] [--report report.json] [--manifest-draft manifest.json] [--markdown report.md]"
      }));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { repos, candidates, report, manifestDraft, markdown };
}

function requireValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function loadCandidates(options) {
  const loaded = [];
  for (const repo of options.repos) loaded.push(normalizeCandidate(repo));
  if (options.candidates) {
    const source = path.resolve(process.cwd(), options.candidates);
    const data = JSON.parse(fs.readFileSync(source, "utf8"));
    const candidates = Array.isArray(data) ? data : data.candidates;
    if (!Array.isArray(candidates)) throw new Error("Candidates file must be an array or contain a candidates array");
    for (const candidate of candidates) loaded.push(normalizeCandidate(candidate));
  }
  if (loaded.length === 0) throw new Error("Provide at least one --repo or --candidates entry");
  return loaded;
}

function normalizeCandidate(candidate) {
  if (typeof candidate === "string") {
    return {
      input: candidate,
      source: candidate
    };
  }
  if (!candidate || typeof candidate !== "object") throw new Error("Candidate entries must be strings or objects");
  const source = candidate.repoPath || candidate.url || candidate.source || candidate.input;
  if (!source) throw new Error("Candidate object requires repoPath, url, source, or input");
  return {
    input: source,
    source,
    id: candidate.id,
    name: candidate.name,
    expectedFailureClass: candidate.expectedFailureClass,
    allowedStrategies: candidate.allowedStrategies,
    notes: candidate.notes
  };
}

function evaluateCandidates(candidates) {
  const projects = candidates.map(evaluateCandidate);
  const manifestDraft = {
    version: 1,
    projects: projects.map((project) => project.manifestEntry)
  };
  return {
    ok: true,
    protocolVersion: "agentshell.real-project-candidates.v1",
    generatedAt: new Date().toISOString(),
    projects,
    summary: summarize(projects),
    manifestDraft
  };
}

function evaluateCandidate(candidate) {
  const sourceType = classifySource(candidate.source);
  const resolvedPath = sourceType === "local"
    ? resolveLocalPath(candidate.source)
    : null;
  const exists = resolvedPath ? fs.existsSync(resolvedPath) : false;
  const packageJsonPath = exists ? path.join(resolvedPath, "package.json") : null;
  const packageJson = packageJsonPath && fs.existsSync(packageJsonPath)
    ? readPackageJson(packageJsonPath)
    : null;
  const files = exists ? summarizeFiles(resolvedPath) : emptyFileSummary();
  const packageManager = detectPackageManager(resolvedPath, packageJson);
  const packageManagerSpec = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : null;
  const nodeEngine = typeof packageJson?.engines?.node === "string" ? packageJson.engines.node : null;
  const dependencySummary = summarizeDependencies(packageJson);
  const workspaceSummary = summarizeWorkspace(resolvedPath, packageJson);
  const scripts = packageJson?.scripts || {};
  const testCommand = inferTestCommand(scripts, packageManager);
  const setupCommand = inferSetupCommand(packageManager, resolvedPath);
  const setupLinks = inferSetupLinks(resolvedPath);
  const manifestSetupCommand = setupLinks.length > 0 ? null : setupCommand;
  const language = inferLanguage(files, packageJson);
  const recommendedUse = recommendUse({ sourceType, exists, packageJson, testCommand, files, language });
  const blockers = blockersFor({ sourceType, exists, packageJson, testCommand });
  const warnings = warningsFor({ sourceType, exists, setupCommand, packageManager, nodeEngine, dependencySummary, workspaceSummary, files });
  const candidateScore = scoreCandidate({ sourceType, exists, packageJson, packageManagerSpec, nodeEngine, dependencySummary, workspaceSummary, testCommand, files, blockers, warnings });
  const priority = priorityFor({ candidateScore, blockers, warnings });
  const nextAction = nextActionFor({ sourceType, exists, testCommand, id: candidate.id || candidateId(candidate.source, packageJson), priority });
  const id = candidate.id || candidateId(candidate.source, packageJson);
  const name = candidate.name || packageJson?.name || id;
  const manifestEntry = {
    id,
    name,
    repoPath: sourceType === "local" ? path.relative(root, resolvedPath) || "." : candidate.source,
    setupCommand: manifestSetupCommand,
    setupLinks,
    testCommand,
    skip: sourceType !== "local" || !exists || !testCommand,
    skipReason: skipReasonFor({ sourceType, exists, testCommand }),
    expectedFailureClass: candidate.expectedFailureClass || "unknown",
    allowedStrategies: Array.isArray(candidate.allowedStrategies) ? candidate.allowedStrategies : ["raw", "split", "fix"],
    metrics: ["tokens", "durationMs", "success", "safety", "generalization"]
  };

  return {
    id,
    name,
    source: candidate.source,
    sourceType,
    checkoutRequired: sourceType !== "local",
    repoPath: resolvedPath,
    exists,
    packageManager,
    packageManagerSpec,
    nodeEngine,
    dependencySummary,
    workspaceSummary,
    language,
    scripts: Object.keys(scripts).sort(),
    testCommand,
    setupCommand,
    setupLinks,
    fileSummary: files,
    candidateScore,
    priority,
    nextAction,
    recommendedUse,
    blockers,
    warnings,
    notes: candidate.notes || null,
    manifestEntry
  };
}

function priorityFor({ candidateScore, blockers, warnings }) {
  if (blockers.length > 0) return "blocked";
  if (candidateScore >= 80 && !warnings.includes("workspace-monorepo") && !warnings.includes("large-repo")) return "high";
  if (candidateScore >= 60) return "medium";
  return "low";
}

function nextActionFor({ sourceType, exists, testCommand, id, priority }) {
  if (sourceType !== "local") return "Checkout or import this repository locally before evaluation.";
  if (!exists) return "Fix repoPath or import the repository into a local candidate directory.";
  if (!testCommand) return "Add or identify a deterministic test command before evaluation.";
  if (priority === "high") return `Add ${id} to examples/real-projects.json and run npm run eval:real-projects.`;
  return "Review warnings, then decide whether to add this candidate to the real-project manifest.";
}

function classifySource(source) {
  if (/^https?:\/\//i.test(source)) return "remote";
  if (fs.existsSync(resolveLocalPath(source))) return "local";
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return "remote";
  return "local";
}

function resolveLocalPath(source) {
  if (path.isAbsolute(source)) return source;
  const cwdPath = path.resolve(process.cwd(), source);
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.resolve(root, source);
}

function readPackageJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function summarizeFiles(repoPath) {
  const summary = {
    total: 0,
    js: 0,
    ts: 0,
    jsx: 0,
    tsx: 0,
    test: 0,
    snapshots: 0,
    packageJson: fs.existsSync(path.join(repoPath, "package.json"))
  };
  walk(repoPath, (file) => {
    summary.total += 1;
    const relative = path.relative(repoPath, file);
    const extension = path.extname(file);
    if (extension === ".js" || extension === ".mjs" || extension === ".cjs") summary.js += 1;
    if (extension === ".ts") summary.ts += 1;
    if (extension === ".jsx") summary.jsx += 1;
    if (extension === ".tsx") summary.tsx += 1;
    if (/\b(test|spec)\b|__tests__/.test(relative)) summary.test += 1;
    if (extension === ".snap") summary.snapshots += 1;
  });
  return summary;
}

function emptyFileSummary() {
  return {
    total: 0,
    js: 0,
    ts: 0,
    jsx: 0,
    tsx: 0,
    test: 0,
    snapshots: 0,
    packageJson: false
  };
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".agentshell", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, visit);
      continue;
    }
    if (entry.isFile()) visit(fullPath);
  }
}

function detectPackageManager(repoPath, packageJson) {
  if (!repoPath) return null;
  if (packageJson?.packageManager) return packageJson.packageManager.split("@")[0];
  if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repoPath, "package-lock.json"))) return "npm";
  return packageJson ? "npm" : null;
}

function summarizeDependencies(packageJson) {
  const dependencies = countObjectKeys(packageJson?.dependencies);
  const devDependencies = countObjectKeys(packageJson?.devDependencies);
  const peerDependencies = countObjectKeys(packageJson?.peerDependencies);
  return {
    dependencies,
    devDependencies,
    peerDependencies,
    total: dependencies + devDependencies + peerDependencies
  };
}

function countObjectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function summarizeWorkspace(repoPath, packageJson) {
  const packageJsonWorkspaces = Boolean(packageJsonWorkspacePatterns(packageJson).length);
  const pnpmWorkspaceYaml = Boolean(repoPath && fs.existsSync(path.join(repoPath, "pnpm-workspace.yaml")));
  const lernaJson = Boolean(repoPath && fs.existsSync(path.join(repoPath, "lerna.json")));
  const turboJson = Boolean(repoPath && fs.existsSync(path.join(repoPath, "turbo.json")));
  const nxJson = Boolean(repoPath && fs.existsSync(path.join(repoPath, "nx.json")));
  const indicators = [];
  if (packageJsonWorkspaces) indicators.push("package-json-workspaces");
  if (pnpmWorkspaceYaml) indicators.push("pnpm-workspace-yaml");
  if (lernaJson) indicators.push("lerna-json");
  if (turboJson) indicators.push("turbo-json");
  if (nxJson) indicators.push("nx-json");
  return {
    detected: indicators.length > 0,
    packageJsonWorkspaces,
    pnpmWorkspaceYaml,
    lernaJson,
    turboJson,
    nxJson,
    packageJsonWorkspaceCount: packageJsonWorkspacePatterns(packageJson).length,
    indicators
  };
}

function packageJsonWorkspacePatterns(packageJson) {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((entry) => typeof entry === "string");
  if (workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter((entry) => typeof entry === "string");
  }
  return [];
}

function inferTestCommand(scripts, packageManager) {
  for (const name of ["test", "test:unit", "check", "typecheck"]) {
    if (typeof scripts[name] === "string") return packageScriptCommand(name, packageManager);
  }
  return null;
}

function packageScriptCommand(name, packageManager) {
  const runner = packageManager === "pnpm" || packageManager === "yarn" ? packageManager : "npm";
  if (name === "test") return `${runner} test`;
  return runner === "npm" ? `npm run ${name}` : `${runner} ${name}`;
}

function inferSetupCommand(packageManager, repoPath) {
  if (!packageManager || !repoPath) return null;
  if (packageManager === "pnpm") return "pnpm install --offline";
  if (packageManager === "yarn") return "yarn install --offline";
  if (fs.existsSync(path.join(repoPath, "package-lock.json"))) return "npm ci --offline";
  return "npm install --offline";
}

function inferSetupLinks(repoPath) {
  if (!repoPath) return [];
  const nodeModulesPath = path.join(repoPath, "node_modules");
  if (!fs.existsSync(nodeModulesPath) || !fs.statSync(nodeModulesPath).isDirectory()) return [];
  return [{
    source: "node_modules",
    target: "node_modules"
  }];
}

function inferLanguage(files, packageJson) {
  if (files.ts + files.tsx > 0) return "typescript";
  if (files.js + files.jsx > 0 || packageJson) return "javascript";
  return "unknown";
}

function recommendUse({ sourceType, exists, packageJson, testCommand, files, language }) {
  if (sourceType !== "local") return "checkout-before-eval";
  if (!exists) return "missing-local-checkout";
  if (!packageJson) return "needs-package-metadata";
  if (!testCommand) return "needs-test-command";
  if (language === "typescript") return "typescript-diagnostic-eval";
  if (files.snapshots > 0) return "snapshot-or-output-eval";
  if (files.test > 0) return "javascript-failure-pattern-eval";
  return "baseline-or-manual-eval";
}

function blockersFor({ sourceType, exists, packageJson, testCommand }) {
  const blockers = [];
  if (sourceType !== "local") blockers.push("checkout-required");
  if (sourceType === "local" && !exists) blockers.push("repo-path-not-found");
  if (exists && !packageJson) blockers.push("missing-package-json");
  if (exists && packageJson && !testCommand) blockers.push("missing-test-script");
  return blockers;
}

function warningsFor({ sourceType, exists, setupCommand, packageManager, nodeEngine, dependencySummary, workspaceSummary, files }) {
  const warnings = [];
  if (sourceType !== "local") warnings.push("not-downloaded-by-design");
  if (exists && setupCommand?.includes("install")) warnings.push("setup-may-need-warm-package-cache");
  if (exists && !packageManager) warnings.push("unknown-package-manager");
  if (exists && !nodeEngine) warnings.push("missing-node-engine");
  if (workspaceSummary.detected) warnings.push("workspace-monorepo");
  if (dependencySummary.total > 80) warnings.push("large-dependency-surface");
  if (files.total > 2000) warnings.push("large-repo");
  if (files.test === 0 && exists) warnings.push("no-obvious-test-files");
  return warnings;
}

function scoreCandidate({ sourceType, exists, packageJson, packageManagerSpec, nodeEngine, dependencySummary, workspaceSummary, testCommand, files, blockers, warnings }) {
  let score = 20;
  if (sourceType === "local") score += 10;
  if (exists) score += 20;
  if (packageJson) score += 15;
  if (packageManagerSpec) score += 3;
  if (nodeEngine) score += 3;
  if (testCommand) score += 20;
  if (files.test > 0) score += 10;
  if (files.total > 0 && files.total <= 500) score += 5;
  if (dependencySummary.total > 0 && dependencySummary.total <= 40) score += 2;
  if (workspaceSummary.detected) score -= 5;
  if (dependencySummary.total > 80) score -= 5;
  score -= blockers.length * 15;
  score -= warnings.filter((warning) => warning !== "setup-may-need-warm-package-cache").length * 5;
  return Math.max(0, Math.min(100, score));
}

function skipReasonFor({ sourceType, exists, testCommand }) {
  if (sourceType !== "local") return "checkout-required";
  if (!exists) return "repo-path-not-found";
  if (!testCommand) return "missing-test-command";
  return null;
}

function candidateId(source, packageJson) {
  if (packageJson?.name) return safeId(packageJson.name);
  const withoutGit = source.replace(/\.git$/i, "");
  const parts = withoutGit.split(/[\\/]/).filter(Boolean);
  return safeId(parts.slice(-2).join("-") || "candidate");
}

function safeId(value) {
  return value
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "candidate";
}

function summarize(projects) {
  const topCandidates = projects
    .filter((project) => project.priority === "high" || project.priority === "medium")
    .sort((left, right) => right.candidateScore - left.candidateScore)
    .slice(0, 3)
    .map((project) => project.id);
  return {
    total: projects.length,
    local: projects.filter((project) => project.sourceType === "local").length,
    remote: projects.filter((project) => project.sourceType === "remote").length,
    checkoutRequired: projects.filter((project) => project.checkoutRequired).length,
    runnableDrafts: projects.filter((project) => project.manifestEntry.skip !== true).length,
    blocked: projects.filter((project) => project.blockers.length > 0).length,
    highPriority: projects.filter((project) => project.priority === "high").length,
    mediumPriority: projects.filter((project) => project.priority === "medium").length,
    lowPriority: projects.filter((project) => project.priority === "low").length,
    averageScore: Math.round(projects.reduce((total, project) => total + project.candidateScore, 0) / projects.length),
    topCandidates
  };
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

function renderMarkdownReport(report) {
  const summary = report.summary;
  const lines = [
    "# Real Project Candidate Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Total candidates: ${summary.total}`,
    `- Local candidates: ${summary.local}`,
    `- Remote candidates: ${summary.remote}`,
    `- Checkout required: ${summary.checkoutRequired}`,
    `- Runnable manifest drafts: ${summary.runnableDrafts}`,
    `- Blocked candidates: ${summary.blocked}`,
    `- High priority: ${summary.highPriority}`,
    `- Medium priority: ${summary.mediumPriority}`,
    `- Low priority: ${summary.lowPriority}`,
    `- Average score: ${summary.averageScore}`,
    `- Top candidates: ${summary.topCandidates.join(", ") || "none"}`,
    "",
    "## Candidates",
    "",
    "| ID | Name | Source | Type | Score | Priority | Use | Test command | Blockers | Warnings |",
    "|---|---|---|---|---:|---|---|---|---|---|",
    ...report.projects.map((project) => [
      tableCell(project.id),
      tableCell(project.name),
      tableCell(project.source),
      tableCell(project.sourceType),
      String(project.candidateScore),
      tableCell(project.priority),
      tableCell(project.recommendedUse),
      tableCell(project.testCommand || "-"),
      tableCell(project.blockers.join(", ") || "-"),
      tableCell(project.warnings.join(", ") || "-")
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |")),
    "",
    "## Blockers And Warnings",
    ""
  ];

  const projectsWithNotes = report.projects.filter((project) => project.blockers.length > 0 || project.warnings.length > 0);
  if (projectsWithNotes.length === 0) {
    lines.push("- None.");
  } else {
    for (const project of projectsWithNotes) {
      const notes = [];
      if (project.blockers.length > 0) notes.push(`blockers: ${project.blockers.join(", ")}`);
      if (project.warnings.length > 0) notes.push(`warnings: ${project.warnings.join(", ")}`);
      lines.push(`- ${project.id}: ${notes.join("; ")}`);
    }
  }

  lines.push(
    "",
    "## Manifest Draft",
    "",
    `Manifest draft contains ${report.manifestDraft.projects.length} project entries. Review skipped entries, expected failure classes, allowed strategies, setup links, setup commands, and test commands before pinning candidates in examples/real-projects.json.`,
    "",
    "Runnable draft entries:",
    ""
  );

  const runnable = report.manifestDraft.projects.filter((project) => project.skip !== true);
  if (runnable.length === 0) {
    lines.push("- None yet.");
  } else {
    for (const project of runnable) lines.push(`- ${project.id}: ${project.testCommand}`);
  }

  return `${lines.join("\n")}\n`;
}

function tableCell(value) {
  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}
