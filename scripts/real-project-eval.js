#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const defaultManifestCandidates = [
  path.join(root, "examples", "real-projects.json"),
  path.join(root, "docs", "real-project-eval.example.json")
];

const options = parseArgs(process.argv.slice(2));
const manifest = loadManifest(options.manifest);
const report = await runManifest(manifest, options);

if (options.report) writeJsonFile(options.report, report);
console.log(JSON.stringify(report, null, 2));

function parseArgs(args) {
  let manifest = null;
  let report = null;
  let artifactsDir = null;
  let runs = 1;
  let concurrency = 1;
  let armConcurrency = 1;
  let mode = "full";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--manifest") {
      manifest = args[index + 1];
      index += 1;
      if (!manifest) throw new Error("--manifest requires a path");
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      manifest = arg.slice("--manifest=".length);
      if (!manifest) throw new Error("--manifest requires a path");
      continue;
    }
    if (arg === "--report") {
      report = args[index + 1];
      index += 1;
      if (!report) throw new Error("--report requires a path");
      continue;
    }
    if (arg.startsWith("--report=")) {
      report = arg.slice("--report=".length);
      if (!report) throw new Error("--report requires a path");
      continue;
    }
    if (arg === "--artifacts-dir") {
      artifactsDir = args[index + 1];
      index += 1;
      if (!artifactsDir) throw new Error("--artifacts-dir requires a path");
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      artifactsDir = arg.slice("--artifacts-dir=".length);
      if (!artifactsDir) throw new Error("--artifacts-dir requires a path");
      continue;
    }
    if (arg === "--runs") {
      runs = parseRuns(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--runs=")) {
      runs = parseRuns(arg.slice("--runs=".length));
      continue;
    }
    if (arg === "--concurrency") {
      concurrency = parseConcurrency(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      concurrency = parseConcurrency(arg.slice("--concurrency=".length));
      continue;
    }
    if (arg === "--arm-concurrency") {
      armConcurrency = parseArmConcurrency(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--arm-concurrency=")) {
      armConcurrency = parseArmConcurrency(arg.slice("--arm-concurrency=".length));
      continue;
    }
    if (arg === "--mode") {
      mode = parseMode(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      mode = parseMode(arg.slice("--mode=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    manifest,
    report: report ? path.resolve(process.cwd(), report) : null,
    artifactsDir: artifactsDir ? path.resolve(process.cwd(), artifactsDir) : null,
    runs,
    concurrency,
    armConcurrency,
    mode
  };
}

function parseRuns(value) {
  const runs = Number(value);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    throw new Error("--runs requires an integer from 1 to 20");
  }
  return runs;
}

function parseConcurrency(value) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency requires an integer from 1 to 16");
  }
  return concurrency;
}

function parseArmConcurrency(value) {
  const armConcurrency = Number(value);
  if (!Number.isInteger(armConcurrency) || armConcurrency < 1 || armConcurrency > 3) {
    throw new Error("--arm-concurrency requires an integer from 1 to 3");
  }
  return armConcurrency;
}

function parseMode(value) {
  if (value === "full" || value === "fix-first") return value;
  throw new Error("--mode requires one of: full, fix-first");
}

function loadManifest(manifestPath) {
  const source = findManifest(manifestPath);
  if (!source) return builtInExampleManifest();

  const content = fs.readFileSync(source, "utf8");
  const manifest = JSON.parse(content);
  return {
    ...manifest,
    source
  };
}

function findManifest(manifestPath) {
  if (manifestPath) return path.resolve(process.cwd(), manifestPath);
  return defaultManifestCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function builtInExampleManifest() {
  return {
    version: 1,
    source: "built-in-example",
    projects: [
      {
        id: "sample-local-project",
        name: "Sample local project",
        repoPath: "examples/real-projects/sample-local-project",
        setupCommand: null,
        testCommand: "npm test",
        expectedFailureClass: "unknown",
        allowedStrategies: ["raw", "split", "fix"],
        metrics: ["tokens", "durationMs", "success", "safety", "generalization"]
      }
    ]
  };
}

async function runManifest(manifest, options = {}) {
  const context = createArtifactContext(options.artifactsDir);
  const runOptions = {
    runs: options.runs || 1,
    concurrency: options.concurrency || 1,
    armConcurrency: options.armConcurrency || 1,
    mode: options.mode || "full"
  };
  const projects = await mapConcurrent(
    normalizeProjects(manifest),
    runOptions.concurrency,
    (project) => runProject(project, context, runOptions)
  );
  const summary = summarize(projects);
  const report = {
    ok: summary.fail === 0,
    manifest: manifest.source || null,
    runs: runOptions.runs,
    mode: runOptions.mode,
    concurrency: runOptions.concurrency,
    armConcurrency: runOptions.armConcurrency,
    projects,
    summary
  };
  if (context) {
    report.artifacts = writeSummaryArtifact(context, report);
  }
  return report;
}

function normalizeProjects(manifest) {
  if (!Array.isArray(manifest.projects)) {
    throw new Error("Manifest must contain a projects array");
  }
  return manifest.projects.map((project, index) => {
    const normalized = {
      id: project.id || `project-${index + 1}`,
      name: project.name || project.id || `Project ${index + 1}`,
      repoPath: project.repoPath || project.path || null,
      skip: project.skip === true,
      skipReason: project.skipReason || project.reason || null,
      setupCommand: project.setupCommand || null,
      setupLinks: normalizeSetupLinks(project.setupLinks),
      testCommand: project.testCommand || null,
      mutations: normalizeMutations(project.mutations),
      skipRepairArms: project.skipRepairArms === true,
      expectedFailureClass: project.expectedFailureClass || "unspecified",
      allowedStrategies: Array.isArray(project.allowedStrategies) ? project.allowedStrategies : [],
      metrics: Array.isArray(project.metrics) ? project.metrics : defaultMetrics()
    };
    return {
      ...normalized,
      arms: normalizeArms(project, normalized)
    };
  });
}

function normalizeArms(project, normalized) {
  const configured = project.arms;
  const allowed = normalized.allowedStrategies;
  const repairAllowedByStrategy = allowed.length === 0
    ? new Set(["split", "fix"])
    : new Set(allowed);
  const defaults = {
    raw: { enabled: true, command: normalized.testCommand },
    split: { enabled: !normalized.skipRepairArms && repairAllowedByStrategy.has("split") },
    fix: { enabled: !normalized.skipRepairArms && repairAllowedByStrategy.has("fix") }
  };

  if (Array.isArray(configured)) {
    const selected = new Set(configured);
    return {
      raw: { ...defaults.raw, enabled: selected.has("raw") },
      split: { ...defaults.split, enabled: selected.has("split") },
      fix: { ...defaults.fix, enabled: selected.has("fix") }
    };
  }

  if (configured && typeof configured === "object") {
    return {
      raw: mergeArmConfig(defaults.raw, configured.raw),
      split: mergeArmConfig(defaults.split, configured.split),
      fix: mergeArmConfig(defaults.fix, configured.fix)
    };
  }

  return defaults;
}

function normalizeMutations(mutations) {
  if (!Array.isArray(mutations)) return [];
  return mutations.map((mutation, index) => {
    if (!mutation || typeof mutation !== "object") {
      throw new Error(`Mutation ${index + 1} must be an object`);
    }
    if (!mutation.path || typeof mutation.path !== "string") {
      throw new Error(`Mutation ${index + 1} requires a path`);
    }
    if (typeof mutation.replace !== "string") {
      throw new Error(`Mutation ${index + 1} requires a string replace value`);
    }
    if (typeof mutation.with !== "string") {
      throw new Error(`Mutation ${index + 1} requires a string with value`);
    }
    return {
      path: mutation.path,
      replace: mutation.replace,
      with: mutation.with,
      replaceAll: mutation.replaceAll === true
    };
  });
}

function normalizeSetupLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.map((link, index) => {
    if (!link || typeof link !== "object") {
      throw new Error(`Setup link ${index + 1} must be an object`);
    }
    if (!link.source || typeof link.source !== "string") {
      throw new Error(`Setup link ${index + 1} requires a source`);
    }
    if (!link.target || typeof link.target !== "string") {
      throw new Error(`Setup link ${index + 1} requires a target`);
    }
    return {
      source: link.source,
      target: link.target
    };
  });
}

function mergeArmConfig(base, value) {
  if (value === false) return { ...base, enabled: false };
  if (value === true) return { ...base, enabled: true };
  if (!value || typeof value !== "object") return base;
  return {
    ...base,
    ...value,
    enabled: value.enabled !== false
  };
}

async function mapConcurrent(items, concurrency, run) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function runProject(project, context, options) {
  const repoPath = resolveRepoPath(project.repoPath);
  const effectiveArmConcurrency = effectiveArmConcurrencyFor(project, options.armConcurrency || 1);
  const base = {
    id: project.id,
    name: project.name,
    repoPath,
    skipRepairArms: project.skipRepairArms,
    expectedFailureClass: project.expectedFailureClass,
    allowedStrategies: project.allowedStrategies,
    metrics: project.metrics,
    armsConfig: compactArmConfig(project.arms),
    effectiveArmConcurrency,
    skippedArms: [],
    evaluation: emptyEvaluation()
  };

  if (project.skip) {
    return skippedProject(base, project.skipReason || "manifest-skip");
  }

  if (!project.repoPath) {
    return skippedProject(base, "missing-repo-path");
  }

  if (!fs.existsSync(repoPath)) {
    return {
      ...base,
      status: "missing",
      availability: "missing",
      ok: true,
      reason: "repo-path-not-found",
      arms: {},
      commands: [],
      classification: classificationFromArms(project, {}, "missing", "repo-path-not-found")
    };
  }

  const enabledArmNames = Object.entries(project.arms)
    .filter(([, arm]) => arm.enabled)
    .map(([name]) => name);
  if (enabledArmNames.length === 0) {
    return skippedProject(base, "no-enabled-arms");
  }

  if (project.arms.raw?.enabled && !(project.arms.raw.command || project.testCommand)) {
    return skippedProject(base, "missing-test-command");
  }

  const arms = await runArms(project, repoPath, context, {
    ...options,
    armConcurrency: effectiveArmConcurrency
  });
  const commands = Object.values(arms).flatMap((arm) => arm.commands || []);
  const skippedArms = skippedArmsFor(project, arms, options);
  const resultBase = {
    ...base,
    skippedArms
  };
  const failedArm = Object.values(arms).find((arm) => arm.ok === false);
  if (failedArm) return failedProject(resultBase, commands, `${failedArm.name}-arm-failed`, arms);
  const failedSuccessRequirement = failedArmSuccessRequirement(project, arms);
  if (failedSuccessRequirement) return failedProject(resultBase, commands, failedSuccessRequirement, arms);

  return {
    ...resultBase,
    status: "pass",
    availability: "runnable",
    ok: true,
    arms,
    commands,
    evaluation: evaluationFromArms(arms, null, project.expectedFailureClass),
    classification: classificationFromArms(project, arms, "pass", null)
  };
}

function skippedArmsFor(project, arms, options) {
  if (options.mode !== "fix-first" || !arms.fix?.success) return [];
  return Object.entries(project.arms)
    .filter(([name, arm]) => arm.enabled && name !== "fix" && !arms[name])
    .map(([name]) => ({
      name,
      reason: "fix-succeeded"
    }));
}

function effectiveArmConcurrencyFor(project, requestedArmConcurrency) {
  if (requestedArmConcurrency <= 1) return 1;
  if (hasSharedNodeModulesSetupLink(project)) return 1;
  return requestedArmConcurrency;
}

function hasSharedNodeModulesSetupLink(project) {
  return project.setupLinks.some((link) => (
    path.normalize(link.target) === "node_modules" || path.normalize(link.source) === "node_modules"
  ));
}

function failedArmSuccessRequirement(project, arms) {
  const repairArmNames = ["split", "fix"].filter((name) => project.arms[name]?.enabled);
  const failedRepairArm = repairArmNames.find((name) => arms[name] && !arms[name].success);
  if (failedRepairArm) return `${failedRepairArm}-arm-unsuccessful`;

  if (repairArmNames.length === 0 && arms.raw && !arms.raw.success) {
    return "raw-arm-unsuccessful";
  }

  return null;
}

function compactArmConfig(arms) {
  return Object.fromEntries(
    Object.entries(arms).map(([name, arm]) => [name, {
      enabled: arm.enabled,
      command: arm.command || null
    }])
  );
}

function skippedProject(base, reason) {
  return {
    ...base,
    status: "skipped",
    availability: "skipped",
    ok: true,
    reason,
    arms: {},
    commands: [],
    classification: classificationFromArms({ expectedFailureClass: base.expectedFailureClass }, {}, "skipped", reason)
  };
}

async function runArms(project, repoPath, context, options) {
  const tasks = armTasks(project, repoPath, context, options);
  if (options.mode === "fix-first") {
    return runFixFirstArms(tasks, options);
  }
  return runArmTasks(tasks, options.armConcurrency || 1);
}

function armTasks(project, repoPath, context, options) {
  const tasks = [];
  if (project.arms.raw?.enabled) {
    tasks.push({
      name: "raw",
      run: () => runRepeatedArm(project, repoPath, "raw", context, options, async (cwd) => [
        await runCommand("raw:test", project.arms.raw.command || project.testCommand, cwd)
      ])
    });
  }
  if (project.arms.split?.enabled) {
    tasks.push({
      name: "split",
      run: () => runRepeatedArm(project, repoPath, "split", context, options, async (cwd) => [
        await runAgentShell("split:diagnose", ["diagnose", "test", "--compact"], cwd),
        await runAgentShell("split:change-suggest", ["change", "suggest", "--apply", "--compact"], cwd),
        await runAgentShell("split:verify", ["verify", "test"], cwd)
      ])
    });
  }
  if (project.arms.fix?.enabled) {
    tasks.push({
      name: "fix",
      run: () => runRepeatedArm(project, repoPath, "fix", context, options, async (cwd) => [
        await runAgentShell("fix:test", ["fix", "test", "--fast", "--compact"], cwd)
      ])
    });
  }
  return tasks;
}

async function runFixFirstArms(tasks, options) {
  const fixTask = tasks.find((task) => task.name === "fix");
  if (!fixTask) return runArmTasks(tasks, options.armConcurrency || 1);

  const arms = {};
  arms.fix = await fixTask.run();
  if (arms.fix.success) return arms;

  const remainingTasks = tasks.filter((task) => task.name !== "fix");
  return {
    ...await runArmTasks(remainingTasks, options.armConcurrency || 1),
    fix: arms.fix
  };
}

async function runArmTasks(tasks, concurrency) {
  const arms = {};
  const results = await mapConcurrent(tasks, concurrency, (task) => task.run());
  for (let index = 0; index < tasks.length; index += 1) {
    arms[tasks[index].name] = results[index];
  }
  return arms;
}

async function runRepeatedArm(project, repoPath, name, context, options, run) {
  const runs = [];
  const totalRuns = options.runs || 1;
  for (let runIndex = 1; runIndex <= totalRuns; runIndex += 1) {
    runs.push(await runIsolatedArm(project, repoPath, name, runIndex, totalRuns, run));
  }
  return writeArmArtifact(context, project, repeatedArmResult(name, runs));
}

async function runIsolatedArm(project, repoPath, name, runIndex, totalRuns, run) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const copyPath = path.join(tempRoot, project.id);
  try {
    copyRepo(repoPath, copyPath);
    const commands = [];
    if (project.mutations.length > 0) {
      commands.push(applyMutations(`${name}:mutate`, project.mutations, copyPath));
      if (commands.at(-1).status !== 0) {
        return singleRunResult(runIndex, totalRuns, armResult(name, commands, false, false, "mutation-failed"));
      }
    }
    if (project.setupLinks.length > 0) {
      commands.push(applySetupLinks(`${name}:setup-link`, project.setupLinks, repoPath, copyPath));
      if (commands.at(-1).status !== 0) {
        return singleRunResult(runIndex, totalRuns, armResult(name, commands, false, false, "setup-link-failed"));
      }
    }
    if (project.setupCommand) {
      commands.push(await runCommand(`${name}:setup`, project.setupCommand, copyPath));
      if (commands.at(-1).status !== 0) {
        return singleRunResult(runIndex, totalRuns, armResult(name, commands, false, false, "setup-failed"));
      }
    }
    commands.push(...await run(copyPath));
    const last = commands.at(-1);
    const success = last ? last.status === 0 : true;
    return singleRunResult(runIndex, totalRuns, armResult(name, commands, true, success));
  } catch (error) {
    const message = String(error.message || error);
    return singleRunResult(runIndex, totalRuns, armResult(name, [{
      name: `${name}:copy`,
      command: "copy temporary repo",
      status: 1,
      durationMs: 0,
      chars: message.length,
      tokens: estimateTokens(message.length)
    }], false, false, "copy-failed"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function applyMutations(name, mutations, cwd) {
  const started = Date.now();
  try {
    const applied = [];
    for (const mutation of mutations) {
      const target = resolveMutationPath(cwd, mutation.path);
      const before = fs.readFileSync(target, "utf8");
      const occurrences = countOccurrences(before, mutation.replace);
      if (occurrences === 0) {
        throw new Error(`replace text not found in ${mutation.path}`);
      }
      const after = mutation.replaceAll
        ? before.replaceAll(mutation.replace, mutation.with)
        : before.replace(mutation.replace, mutation.with);
      fs.writeFileSync(target, after);
      applied.push({
        path: mutation.path,
        replacements: mutation.replaceAll ? occurrences : 1
      });
    }
    return mutationCommandResult(name, "apply manifest mutations", 0, Date.now() - started, JSON.stringify({ applied }));
  } catch (error) {
    return mutationCommandResult(name, "apply manifest mutations", 1, Date.now() - started, String(error.message || error));
  }
}

function resolveMutationPath(cwd, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`mutation path must be relative: ${relativePath}`);
  }
  const target = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`mutation path escapes repo: ${relativePath}`);
  }
  return target;
}

function countOccurrences(value, search) {
  if (search.length === 0) return 0;
  let count = 0;
  let index = value.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(search, index + search.length);
  }
  return count;
}

function mutationCommandResult(name, command, status, durationMs, output) {
  const commandResult = {
    name,
    command,
    status,
    durationMs,
    chars: output.length,
    tokens: estimateTokens(output.length)
  };
  Object.defineProperty(commandResult, "output", {
    enumerable: false,
    value: compactCommandOutput(output, "")
  });
  return commandResult;
}

function applySetupLinks(name, links, sourceRoot, cwd) {
  const started = Date.now();
  try {
    const applied = [];
    for (const link of links) {
      const source = resolveSetupLinkSource(sourceRoot, link.source);
      const target = resolveSetupLinkTarget(cwd, link.target);
      if (!fs.existsSync(source)) {
        throw new Error(`setup link source not found: ${link.source}`);
      }
      if (fs.existsSync(target)) {
        throw new Error(`setup link target already exists: ${link.target}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const stat = fs.statSync(source);
      fs.symlinkSync(source, target, stat.isDirectory() ? "dir" : "file");
      applied.push({
        source: link.source,
        target: link.target,
        kind: stat.isDirectory() ? "dir" : "file"
      });
    }
    return mutationCommandResult(name, "apply setup links", 0, Date.now() - started, JSON.stringify({ applied }));
  } catch (error) {
    return mutationCommandResult(name, "apply setup links", 1, Date.now() - started, String(error.message || error));
  }
}

function resolveSetupLinkSource(sourceRoot, sourcePath) {
  if (path.isAbsolute(sourcePath)) return sourcePath;
  return path.resolve(sourceRoot, sourcePath);
}

function resolveSetupLinkTarget(cwd, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`setup link target must be relative: ${relativePath}`);
  }
  const target = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`setup link target escapes repo: ${relativePath}`);
  }
  return target;
}

function copyRepo(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (item) => {
      const name = path.basename(item);
      return ![".git", ".agentshell", "artifacts", "coverage", "dist", "node_modules"].includes(name);
    }
  });
}

function resolveRepoPath(repoPath) {
  if (!repoPath) return null;
  if (path.isAbsolute(repoPath)) return repoPath;
  return path.resolve(root, repoPath);
}

function runAgentShell(name, args, cwd) {
  const cli = path.join(root, "src", "cli.js");
  return runCommand(name, ["node", cli, ...args].map(shellQuote).join(" "), cwd);
}

function runCommand(name, command, cwd) {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, {
      cwd,
      shell: true,
      env: realProjectEvalEnv()
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += String(error.message || error);
    });
    child.on("close", (status) => {
      const output = `${stdout}${stderr}`;
      const commandResult = {
        name,
        command,
        status,
        durationMs: Date.now() - started,
        chars: output.length,
        tokens: estimateTokens(output.length)
      };
      Object.defineProperty(commandResult, "output", {
        enumerable: false,
        value: compactCommandOutput(stdout, stderr)
      });
      resolve(commandResult);
    });
  });
}

function realProjectEvalEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_")) delete env[key];
  }
  return {
    ...env,
    AGENTSHELL_REAL_PROJECT_EVAL: "1",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function armResult(name, commands, ok, success, reason = null) {
  const result = {
    name,
    ok,
    success,
    tokens: commands.reduce((total, command) => total + command.tokens, 0),
    durationMs: commands.reduce((total, command) => total + command.durationMs, 0),
    commands
  };
  if (reason) result.reason = reason;
  return result;
}

function singleRunResult(runIndex, totalRuns, result) {
  if (totalRuns === 1) return result;
  return {
    run: runIndex,
    ...result
  };
}

function repeatedArmResult(name, runs) {
  if (runs.length === 1) return runs[0];
  const commands = runs.flatMap((run) => run.commands || []);
  const successRuns = runs.filter((run) => run.success).length;
  const ok = runs.every((run) => run.ok);
  const success = successRuns === runs.length;
  const tokens = runs.reduce((total, run) => total + (run.tokens || 0), 0);
  const durationMs = runs.reduce((total, run) => total + (run.durationMs || 0), 0);
  const result = {
    name,
    ok,
    success,
    runs: runs.length,
    successRuns,
    failureRuns: runs.length - successRuns,
    successRate: successRuns / runs.length,
    tokens,
    durationMs,
    averageTokens: Math.round(tokens / runs.length),
    averageDurationMs: Math.round(durationMs / runs.length),
    commands,
    runResults: runs
  };
  const failed = runs.find((run) => run.reason);
  if (failed) result.reason = failed.reason;
  return result;
}

function failedProject(base, commands, reason, arms = {}) {
  return {
    ...base,
    status: "fail",
    availability: "runnable",
    ok: false,
    reason,
    arms,
    commands,
    evaluation: evaluationFromArms(arms, false, base.expectedFailureClass),
    classification: classificationFromArms({ expectedFailureClass: base.expectedFailureClass }, arms, "fail", reason)
  };
}

function summarize(projects) {
  const summary = {
    total: projects.length,
    pass: 0,
    fail: 0,
    skipped: 0,
    missing: 0,
    runnable: 0,
    arms: {},
    skippedArms: {
      total: 0,
      raw: 0,
      split: 0,
      fix: 0
    },
    failureClasses: {},
    unsupported: {
      totalProjects: 0,
      totalArms: 0,
      reasons: {},
      projects: []
    },
    evaluation: {
      safety: {},
      generalization: {}
    }
  };
  for (const project of projects) {
    if (project.status === "pass") summary.pass += 1;
    else if (project.status === "fail") summary.fail += 1;
    else if (project.status === "missing") summary.missing += 1;
    else if (project.status === "skipped") summary.skipped += 1;
    if (project.availability === "runnable") summary.runnable += 1;
    for (const [name, arm] of Object.entries(project.arms || {})) {
      if (!summary.arms[name]) {
        summary.arms[name] = { total: 0, success: 0, tokens: 0, durationMs: 0, runs: 0, successRuns: 0 };
      }
      summary.arms[name].total += 1;
      if (arm.success) summary.arms[name].success += 1;
      summary.arms[name].tokens += arm.tokens || 0;
      summary.arms[name].durationMs += arm.durationMs || 0;
      summary.arms[name].runs += arm.runs || 1;
      summary.arms[name].successRuns += arm.successRuns ?? (arm.success ? 1 : 0);
    }
    for (const skippedArm of project.skippedArms || []) {
      summary.skippedArms.total += 1;
      if (Object.hasOwn(summary.skippedArms, skippedArm.name)) {
        summary.skippedArms[skippedArm.name] += 1;
      }
    }
    addFailureClassSummary(summary.failureClasses, project);
    addUnsupportedSummary(summary.unsupported, project);
    addEvaluationSummary(summary.evaluation, project.evaluation);
  }
  return summary;
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function defaultMetrics() {
  return ["tokens", "durationMs", "success", "safety", "generalization"];
}

function emptyEvaluation() {
  return {
    tokens: null,
    durationMs: null,
    success: null,
    safety: null,
    generalization: null
  };
}

function evaluationFromCommands(commands, success) {
  const classification = classificationFromCommands(commands);
  return {
    tokens: commands.reduce((total, command) => total + command.tokens, 0),
    durationMs: commands.reduce((total, command) => total + command.durationMs, 0),
    success,
    safety: safetyAssessment(commands, success),
    generalization: classification.unsupportedReasons.length > 0 ? "unsupported" : "unknown"
  };
}

function evaluationFromArms(arms, success = null, expectedFailureClass = "unspecified") {
  const commands = Object.values(arms).flatMap((arm) => arm.commands || []);
  const armValues = Object.values(arms);
  const projectSuccess = success ?? successFromArms(arms, armValues);
  const evaluation = evaluationFromCommands(commands, projectSuccess);
  if (Object.keys(arms).length === 0) return evaluation;
  evaluation.safety = safetyAssessmentForArms(arms, projectSuccess);
  evaluation.generalization = generalizationAssessment(arms, projectSuccess, expectedFailureClass);
  return evaluation;
}

function successFromArms(arms, armValues) {
  const repairArms = ["split", "fix"].filter((name) => arms[name]).map((name) => arms[name]);
  if (repairArms.length > 0) return repairArms.every((arm) => arm.success);
  return armValues.length > 0 && armValues.every((arm) => arm.success);
}

function classificationFromArms(project, arms, status, reason) {
  const raw = arms.raw || null;
  const repairValues = Object.entries(arms)
    .filter(([name]) => name === "split" || name === "fix")
    .map(([, arm]) => arm);
  const classification = classificationFromCommands(
    Object.values(arms).flatMap((arm) => arm.commands || [])
  );
  return {
    expectedFailureClass: project.expectedFailureClass || "unspecified",
    status,
    reason: reason || null,
    rawFailureObserved: raw ? raw.success === false : null,
    repairAttempted: repairValues.length > 0,
    repairSucceeded: repairValues.length > 0 ? repairValues.every((arm) => arm.success) : null,
    unsupportedReasons: classification.unsupportedReasons,
    suggestedNextActions: classification.suggestedNextActions
  };
}

function classificationFromCommands(commands) {
  const unsupportedReasons = [];
  const suggestedNextActions = [];
  for (const command of commands) {
    const parsed = parseCommandJson(command);
    const unsupportedReason = parsed?.error?.details?.unsupportedReason;
    if (unsupportedReason && !unsupportedReasons.includes(unsupportedReason)) {
      unsupportedReasons.push(unsupportedReason);
    }
    for (const action of parsed?.error?.suggestedNextActions || parsed?.suggestedNextActions || []) {
      if (!action?.command) continue;
      if (!suggestedNextActions.some((existing) => existing.command === action.command)) {
        suggestedNextActions.push({
          command: action.command,
          reason: action.reason || "Suggested next action"
        });
      }
    }
  }
  return { unsupportedReasons, suggestedNextActions };
}

function parseCommandJson(command) {
  const text = command.output?.stdout?.text;
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safetyAssessmentForArms(arms, success) {
  const repairArms = Object.entries(arms)
    .filter(([name]) => name === "split" || name === "fix")
    .map(([, arm]) => arm);
  if (repairArms.length === 0) return success ? "not-applicable" : "unknown";
  if (!success) return "failed";
  return repairArms.every((arm) => arm.success) ? "checked" : "pending";
}

function safetyAssessment(commands, success) {
  if (!commands.some((command) => command.name.includes("fix") || command.name.includes("change"))) {
    return success ? "not-applicable" : "unknown";
  }
  if (!success) return "failed";
  return commands.some((command) => commandHasRollbackEvidence(command)) ? "checked" : "pending";
}

function commandHasRollbackEvidence(command) {
  const parsed = parseCommandJson(command);
  return Boolean(
    parsed?.rollbackCommand ||
    parsed?.applied?.operationId ||
    parsed?.suggestion?.applied?.operationId
  );
}

function generalizationAssessment(arms, success, expectedFailureClass) {
  const classification = classificationFromCommands(
    Object.values(arms).flatMap((arm) => arm.commands || [])
  );
  if (classification.unsupportedReasons.length > 0) return "unsupported";
  if (expectedFailureClass === "none") return "not-applicable";
  const repairArmNames = ["split", "fix"].filter((name) => arms[name]);
  if (repairArmNames.length === 0) return "unknown";
  return success ? "covered" : "unknown";
}

function addFailureClassSummary(summary, project) {
  const key = project.classification?.expectedFailureClass || project.expectedFailureClass || "unspecified";
  if (!summary[key]) {
    summary[key] = {
      total: 0,
      pass: 0,
      fail: 0,
      missing: 0,
      skipped: 0,
      repairAttempted: 0,
      repairSucceeded: 0,
      unsupported: 0
    };
  }
  const entry = summary[key];
  entry.total += 1;
  if (project.status === "pass") entry.pass += 1;
  if (project.status === "fail") entry.fail += 1;
  if (project.status === "missing") entry.missing += 1;
  if (project.status === "skipped") entry.skipped += 1;
  if (project.classification?.repairAttempted) entry.repairAttempted += 1;
  if (project.classification?.repairSucceeded) entry.repairSucceeded += 1;
  if ((project.classification?.unsupportedReasons || []).length > 0) entry.unsupported += 1;
}

function addUnsupportedSummary(summary, project) {
  const reasons = project.classification?.unsupportedReasons || [];
  if (reasons.length === 0) return;
  summary.totalProjects += 1;
  summary.totalArms += Object.values(project.arms || {})
    .filter((arm) => classificationFromCommands(arm.commands || []).unsupportedReasons.length > 0)
    .length;
  for (const reason of reasons) {
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
  }
  summary.projects.push({
    id: project.id,
    expectedFailureClass: project.classification.expectedFailureClass,
    status: project.status,
    reasons,
    suggestedNextActions: project.classification.suggestedNextActions
  });
}

function addEvaluationSummary(summary, evaluation) {
  for (const key of ["safety", "generalization"]) {
    const value = evaluation?.[key];
    if (value === null || value === undefined) continue;
    summary[key][value] = (summary[key][value] || 0) + 1;
  }
}

function createArtifactContext(artifactsDir) {
  if (!artifactsDir) return null;
  fs.mkdirSync(artifactsDir, { recursive: true });
  return {
    dir: artifactsDir,
    files: []
  };
}

function writeArmArtifact(context, project, arm) {
  if (!context) return arm;
  const relativePath = path.join("projects", safePathSegment(project.id), `${safePathSegment(arm.name)}.json`);
  const artifactPath = path.join(context.dir, relativePath);
  writeJsonFile(artifactPath, {
    type: "real-project-eval-arm",
    project: {
      id: project.id,
      name: project.name,
      repoPath: resolveRepoPath(project.repoPath)
    },
    arm: {
      name: arm.name,
      ok: arm.ok,
      success: arm.success,
      runs: arm.runs || 1,
      successRuns: arm.successRuns ?? (arm.success ? 1 : 0),
      failureRuns: arm.failureRuns ?? (arm.success ? 0 : 1),
      successRate: arm.successRate ?? (arm.success ? 1 : 0),
      tokens: arm.tokens,
      durationMs: arm.durationMs,
      averageTokens: arm.averageTokens || arm.tokens,
      averageDurationMs: arm.averageDurationMs || arm.durationMs,
      reason: arm.reason || null
    },
    commands: arm.commands.map((command) => ({
      ...command,
      output: command.output || compactCommandOutput("", "")
    })),
    runs: (arm.runResults || [arm]).map((run) => ({
      run: run.run || 1,
      ok: run.ok,
      success: run.success,
      tokens: run.tokens,
      durationMs: run.durationMs,
      reason: run.reason || null,
      commands: run.commands.map((command) => ({
        ...command,
        output: command.output || compactCommandOutput("", "")
      }))
    }))
  });
  context.files.push({
    type: "arm",
    project: project.id,
    arm: arm.name,
    path: relativePath
  });
  return {
    ...arm,
    artifact: relativePath
  };
}

function writeSummaryArtifact(context, report) {
  const relativePath = "summary.json";
  writeJsonFile(path.join(context.dir, relativePath), {
    type: "real-project-eval-summary",
    ok: report.ok,
    manifest: report.manifest,
    summary: report.summary,
    projects: report.projects.map((project) => ({
      id: project.id,
      status: project.status,
      availability: project.availability,
      ok: project.ok,
      reason: project.reason || null,
      artifacts: Object.fromEntries(
        Object.entries(project.arms || {})
          .filter(([, arm]) => arm.artifact)
          .map(([name, arm]) => [name, arm.artifact])
      )
    })),
    files: context.files
  });
  return {
    directory: context.dir,
    summary: relativePath,
    files: [{ type: "summary", path: relativePath }, ...context.files]
  };
}

function compactCommandOutput(stdout, stderr) {
  return {
    stdout: compactStream(stdout),
    stderr: compactStream(stderr)
  };
}

function compactStream(value) {
  const limit = 2000;
  if (value.length <= limit) {
    return {
      chars: value.length,
      truncated: false,
      text: value
    };
  }
  const edge = Math.floor(limit / 2);
  return {
    chars: value.length,
    truncated: true,
    head: value.slice(0, edge),
    tail: value.slice(-edge)
  };
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safePathSegment(value) {
  const safe = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "artifact";
}
