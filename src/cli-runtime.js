#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { fail, printJson } from "./core/output.js";
import { appendEvent, appendRunCommandStats } from "./core/store.js";
import { registerWorkspace } from "./core/workspace-registry.js";
import { resolvePackageRoot } from "./core/package-root.js";
import { writeDashboardSnapshot } from "./core/dashboard-snapshot.js";
import { createSupportBundle } from "./core/support-bundle.js";
import { enforceCompactBudget, findCompactBudgetViolations } from "./core/compact-budget.js";
import { adaptiveCoverage } from "./core/adaptive-coverage.js";
import { loadCommandFamilyModules } from "./core/command-registry.js";

const args = process.argv.slice(2);
const command = args[0];
const commandStartedAt = process.hrtime.bigint();
let dashboardSnapshotRoot = null;
let forceDashboardSnapshot = false;
const DASHBOARD_REFRESH_INTERVAL_MS = 15_000;

async function main() {
  const {
    understand, find, findFile, grep, listDirectory, pwd, du, whichCommand, ps, portList,
    killSuggest, projectTree, gitDiff, gitStatus, gitLog, gitBranch, packageScripts,
    packageDeps, packageScript, filesChanged, fileInfo, testList, testCommand,
    errorsFromLog, errorsFromCommand, imports, symbols, refs, configList, changedImpact,
    projectHealth, readFileAround, readFileHead, readFileRange, readFileTail, readBatch,
    verify, change, fillChange, suggestChange, undo, history, getLog, logDelta, execCommand,
    exportMetrics, metrics, resetMetrics, coverage, runtimeCommand, workspaceGuard,
    workspaceAudit, compareSearch, verifyGoCommand, verifyChanged, boundaryCheck,
    goLocateCommand, jobCommand, benchmark, schema, diagnose, fix, runStatus, doctor,
    start, pluginStatus, parsePluginValidateOptions, pluginValidate, exportTrial,
    trialStatus, dashboardStatus, startDashboard, stopDashboard, setupCodex
  } = await loadCommandFamilyModules(command);
  if (command === "setup") {
    if (args[1] !== "codex") {
      printJson(fail("INVALID_ARGUMENT", "Usage: agentshell setup codex [install|update|uninstall|doctor|rollback] [--channel stable|beta|--source <package>] [--home <path>] [--dry-run]"));
      process.exitCode = 2;
      return;
    }
    const action = args[2] && !args[2].startsWith("--") ? args[2] : "install";
    const sourceFlag = args.indexOf("--source");
    const channelFlag = args.indexOf("--channel");
    const homeFlag = args.indexOf("--home");
    let source;
    let channel;
    let home;
    try {
      if (sourceFlag >= 0 && (!args[sourceFlag + 1] || args[sourceFlag + 1].startsWith("--"))) throw new Error("--source requires a path");
      if (channelFlag >= 0 && (!args[channelFlag + 1] || args[channelFlag + 1].startsWith("--"))) throw new Error("--channel requires stable or beta");
      if (homeFlag >= 0 && (!args[homeFlag + 1] || args[homeFlag + 1].startsWith("--"))) throw new Error("--home requires a path");
      if (sourceFlag >= 0 && channelFlag >= 0) throw new Error("--source and --channel cannot be used together");
      source = sourceFlag >= 0 ? path.resolve(args[sourceFlag + 1]) : undefined;
      channel = channelFlag >= 0 ? args[channelFlag + 1] : undefined;
      home = homeFlag >= 0 ? path.resolve(args[homeFlag + 1]) : undefined;
    } catch (error) {
      printJson(fail("INVALID_ARGUMENT", error.message));
      process.exitCode = 2;
      return;
    }
    const result = await setupCodex(action, {
      source,
      sourceMode: source ? "local" : "remote",
      channel,
      home,
      dryRun: args.includes("--dry-run")
    });
    printJson(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "update" || command === "rollback") {
    const parsed = parseSelfMaintenanceOptions(args.slice(1));
    if (!parsed.ok) {
      printJson(parsed);
      process.exitCode = 2;
      return;
    }
    const result = await setupCodex(command, parsed.value);
    printJson(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "support") {
    if (args[1] !== "export") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell support export --out <bundle.json|bundle.zip> [--format json|zip] [--dry-run]"));
      process.exitCode = 2;
      return;
    }
    try {
      const options = parseSupportOptions(args.slice(2));
      emit(createSupportBundle({
        packageDir: resolvePackageRoot(),
        output: options.output,
        format: options.format,
        dryRun: options.dryRun
      }));
    } catch (error) {
      emit(fail(error.code || "SUPPORT_BUNDLE_FAILED", error.message));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "start" || command === "entry") {
    emit(await start(process.cwd(), {
      compact: args.includes("--compact"),
      profile: args.includes("--profile")
    }));
    return;
  }

  if (command === "doctor") {
    const [projectReport, installation] = await Promise.all([
      doctor(process.cwd()),
      setupCodex("doctor", { sourceMode: "remote" })
    ]);
    emit({ ...projectReport, installation });
    return;
  }

  if (command === "plugin") {
    const action = args[1] || "status";
    if (!["status", "validate"].includes(action)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell plugin status [--compact] [--home <home>] [--marketplace <path>] [--cache-root <path>] OR agentshell plugin validate [--compact] [--source-only] [--profile] [--home <home>] [--marketplace <path>] [--cache-root <path>]"));
      process.exitCode = 2;
      return;
    }
    const options = action === "status"
      ? parsePluginStatusOptions(args.slice(2))
      : parsePluginValidateOptions(args.slice(2));
    if (!options.ok) {
      emit(options);
      process.exitCode = 2;
      return;
    }
    const result = action === "status"
      ? pluginStatus(process.cwd(), options.value)
      : await pluginValidate(process.cwd(), options.value);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "trial") {
    const action = args[1];
    if (!["status", "export"].includes(action)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell trial status [--project <path>] OR agentshell trial export [--verify] [--project <path>] [--out <file>] [--id <label>] [--fixture <label>] [--rating 1-5]"));
      process.exitCode = 2;
      return;
    }
    const options = action === "status"
      ? parseTrialStatusOptions(args.slice(2))
      : parseTrialExportOptions(args.slice(2));
    if (!options.ok) {
      emit(options);
      process.exitCode = 2;
      return;
    }
    const projectRoot = options.value.project ? path.resolve(options.value.project) : process.cwd();
    const result = action === "status"
      ? trialStatus(projectRoot)
      : await exportTrial(projectRoot, options.value);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "dashboard") {
    const options = parseDashboardOptions(args.slice(1));
    if (!options.ok) {
      emit(options);
      process.exitCode = 2;
      return;
    }
    if (options.value.action === "status") {
      emit(await dashboardStatus());
      return;
    }
    if (options.value.action === "stop") {
      emit(await stopDashboard());
      return;
    }
    const session = await startDashboard(process.cwd(), options.value);
    emit(session.report);
    if (session.reused || !session.server) return;
    const close = () => session.close().finally(() => process.exit(0));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }

  if (command === "understand") {
    emit(await understand(process.cwd(), {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "project") {
    if (args[1] !== "health") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell project health [--compact]"));
      process.exitCode = 2;
      return;
    }
    emit(await projectHealth(process.cwd(), {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "find") {
    if (args[1] === "file") {
      const parsed = parseFindFileCliOptions(args.slice(2));
      if (!parsed.ok) {
        emit(parsed);
        process.exitCode = 2;
        return;
      }
      emit(await findFile(process.cwd(), parsed.value.name, parsed.value));
      return;
    }
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      emit(fail("INVALID_ARGUMENT", "Missing search query"));
      process.exitCode = 2;
      return;
    }
    emit(await find(process.cwd(), query));
    return;
  }

  if (command === "grep") {
    const parsed = parseGrepOptions(args.slice(1));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await grep(process.cwd(), parsed.value.query, parsed.value));
    return;
  }

  if (command === "ls") {
    const parsed = parsePathCommandOptions(args.slice(1), "ls");
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await listDirectory(process.cwd(), parsed.value.path || ".", parsed.value));
    return;
  }

  if (command === "pwd") {
    if (args.slice(1).some((value) => value !== "--compact")) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell pwd [--compact]"));
      process.exitCode = 2;
      return;
    }
    emit(await pwd(process.cwd(), { compact: args.includes("--compact") }));
    return;
  }

  if (command === "du") {
    const parsed = parsePathCommandOptions(args.slice(1), "du");
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await du(process.cwd(), parsed.value));
    return;
  }

  if (command === "which") {
    const executable = args[1];
    if (!executable || executable.startsWith("--") || args.slice(2).some((value) => value !== "--compact")) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell which <command> [--compact]"));
      process.exitCode = 2;
      return;
    }
    emit(await whichCommand(process.cwd(), executable, { compact: args.includes("--compact") }));
    return;
  }

  if (command === "ps") {
    const parsed = parseInspectionOptions(args.slice(1), "ps");
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await ps(process.cwd(), parsed.value));
    return;
  }

  if (command === "port") {
    if (args[1] !== "list") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell port list [--compact] [--port N] [--limit N]"));
      process.exitCode = 2;
      return;
    }
    const parsed = parseInspectionOptions(args.slice(2), "port");
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await portList(process.cwd(), parsed.value));
    return;
  }

  if (command === "kill") {
    if (args[1] !== "suggest") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell kill suggest [--compact] (--pid N|--port N)"));
      process.exitCode = 2;
      return;
    }
    const parsed = parseInspectionOptions(args.slice(2), "kill");
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await killSuggest(process.cwd(), parsed.value));
    return;
  }

  if (command === "tree") {
    const parsed = parseTreeOptions(args.slice(1));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await projectTree(process.cwd(), parsed.value));
    return;
  }

  if (command === "package") {
    const action = args[1];
    if (action === "scripts") {
      emit(await packageScripts(process.cwd(), {
        compact: args.includes("--compact")
      }));
      return;
    }
    if (action === "script") {
      emit(await packageScript(process.cwd(), args[2], {
        compact: args.includes("--compact")
      }));
      return;
    }
    if (action === "deps") {
      emit(await packageDeps(process.cwd(), {
        compact: args.includes("--compact")
      }));
      return;
    }
    emit(fail("INVALID_ARGUMENT", "Usage: agentshell package scripts [--compact] OR agentshell package script <name> [--compact] OR agentshell package deps [--compact]"));
    process.exitCode = 2;
    return;
  }

  if (command === "files") {
    if (args[1] !== "changed") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell files changed [--compact]"));
      process.exitCode = 2;
      return;
    }
    emit(await filesChanged(process.cwd(), {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "changed") {
    if (args[1] !== "impact") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell changed impact [--compact]"));
      process.exitCode = 2;
      return;
    }
    emit(await changedImpact(process.cwd(), {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "file") {
    if (args[1] !== "info") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell file info <path> [--compact]"));
      process.exitCode = 2;
      return;
    }
    emit(await fileInfo(process.cwd(), args[2], {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "test") {
    if (!["list", "command"].includes(args[1])) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell test list [--compact] [--max-files N] OR agentshell test command [--compact]"));
      process.exitCode = 2;
      return;
    }
    if (args[1] === "command") {
      emit(await testCommand(process.cwd(), {
        compact: args.includes("--compact")
      }));
      return;
    }
    const parsed = parseTestListOptions(args.slice(2));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await testList(process.cwd(), parsed.value));
    return;
  }

  if (command === "errors") {
    if (!["from-log", "from-command"].includes(args[1])) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell errors from-log <file> [--compact] OR agentshell errors from-command [--compact] -- <command...>"));
      process.exitCode = 2;
      return;
    }
    if (args[1] === "from-command") {
      emit(await errorsFromCommand(process.cwd(), args.slice(2).filter((value) => value !== "--compact"), {
        compact: args.includes("--compact")
      }));
      return;
    }
    emit(await errorsFromLog(process.cwd(), args[2], {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "imports") {
    emit(await imports(process.cwd(), args[1], {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "symbols") {
    const parsed = parseSymbolsOptions(args.slice(1));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await symbols(process.cwd(), parsed.value.file, parsed.value));
    return;
  }

  if (command === "refs") {
    const parsed = parseRefsOptions(args.slice(1));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await refs(process.cwd(), parsed.value.query, parsed.value));
    return;
  }

  if (command === "config") {
    if (args[1] !== "list") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell config list [--compact] [--max-configs N]"));
      process.exitCode = 2;
      return;
    }
    const parsed = parseConfigListOptions(args.slice(2));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    emit(await configList(process.cwd(), parsed.value));
    return;
  }

  if (command === "git") {
    const action = args[1];
    if (action === "status") {
      const parsed = parseGitStatusOptions(args.slice(2));
      if (!parsed.ok) {
        emit(parsed);
        process.exitCode = 2;
        return;
      }
      emit(await gitStatus(process.cwd(), parsed.value));
      return;
    }
    if (action === "diff") {
      emit(await gitDiff(process.cwd(), {
        compact: args.includes("--compact"),
        staged: args.includes("--staged")
      }));
      return;
    }
    if (action === "log") {
      const parsed = parseGitLogOptions(args.slice(2));
      if (!parsed.ok) {
        emit(parsed);
        process.exitCode = 2;
        return;
      }
      emit(await gitLog(process.cwd(), parsed.value));
      return;
    }
    if (action === "branch") {
      const parsed = parseGitBranchOptions(args.slice(2));
      if (!parsed.ok) {
        emit(parsed);
        process.exitCode = 2;
        return;
      }
      emit(await gitBranch(process.cwd(), parsed.value));
      return;
    }
    emit(fail("INVALID_ARGUMENT", "Usage: agentshell git status [--compact] [--max-files N] OR agentshell git diff [--compact] [--staged] OR agentshell git log [--compact] [--limit N] OR agentshell git branch [--compact] [--max-branches N]"));
    process.exitCode = 2;
    return;
  }

  if (command === "read") {
    if (args[1] === "batch") {
      const parsed = parseReadBatchOptions(args.slice(2));
      if (!parsed.ok) {
        emit(parsed);
        process.exitCode = 2;
        return;
      }
      const result = await readBatch(process.cwd(), parsed.value.targets, parsed.value.options);
      emit(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    const file = args[1];
    const linesFlag = args.indexOf("--lines");
    const aroundFlag = args.indexOf("--around");
    const headFlag = args.indexOf("--head");
    const tailFlag = args.indexOf("--tail");
    const lines = linesFlag >= 0 ? args[linesFlag + 1] : undefined;
    const around = aroundFlag >= 0 ? args.slice(aroundFlag + 1).join(" ").trim() : undefined;
    const head = headFlag >= 0 ? parsePositiveInteger(args[headFlag + 1]) : null;
    const tail = tailFlag >= 0 ? parsePositiveInteger(args[tailFlag + 1]) : null;
    const selectedModes = [Boolean(lines), Boolean(around), head !== null, tail !== null].filter(Boolean).length;
    if (!file || selectedModes !== 1) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell read <file> (--lines A:B|--around <query>|--head N|--tail N)"));
      process.exitCode = 2;
      return;
    }
    const result = lines
      ? await readFileRange(process.cwd(), file, lines)
      : around
        ? await readFileAround(process.cwd(), file, around)
        : head !== null
          ? await readFileHead(process.cwd(), file, head)
          : await readFileTail(process.cwd(), file, tail);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "head" || command === "tail") {
    const file = args[1];
    const linesFlag = args.indexOf("--lines");
    const count = linesFlag >= 0 ? parsePositiveInteger(args[linesFlag + 1]) : 40;
    const allowed = new Set([file, "--lines", linesFlag >= 0 ? args[linesFlag + 1] : null, "--compact"]);
    if (!file || file.startsWith("--") || !count || args.slice(1).some((value) => !allowed.has(value))) {
      emit(fail("INVALID_ARGUMENT", `Usage: agentshell ${command} <file> [--lines N] [--compact]`));
      process.exitCode = 2;
      return;
    }
    const result = command === "head"
      ? await readFileHead(process.cwd(), file, count)
      : await readFileTail(process.cwd(), file, count);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "verify") {
    const type = args[1];
    if (type === "cache") {
      const action = args[2];
      if (!["explain", "clear"].includes(action) || args.slice(3).some((value) => value !== "--compact")) {
        emit(fail("INVALID_ARGUMENT", "Usage: agentshell verify cache <explain|clear> [--compact]"));
        process.exitCode = 2;
        return;
      }
      emit(await verify(process.cwd(), "test", {
        cacheAction: action,
        compact: args.includes("--compact")
      }));
      return;
    }
    if (type === "go") {
      const result = await verifyGoCommand(process.cwd(), args.slice(2));
      emit(result);
      process.exitCode = result.ok ? 0 : (result.error?.code === "INVALID_ARGUMENT" ? 2 : 1);
      return;
    }
    if (type === "changed") {
      const parsed = parseVerifyChangedOptions(args.slice(2));
      if (!parsed.ok) {
        emit(parsed);
        process.exitCode = 2;
        return;
      }
      const result = await verifyChanged(process.cwd(), parsed.value);
      emit(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    const supportedTypes = ["test", "build", "lint", "format", "modules", "benchmark", "fuzz", "generate"];
    if (!supportedTypes.includes(type)) {
      emit(fail("INVALID_ARGUMENT", verifyUsage()));
      process.exitCode = 2;
      return;
    }
    const parsed = parseVerifyOptions(type, args.slice(2));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    const result = await verify(process.cwd(), type, parsed.value);
    if (!result.ok && result.error?.code === "GO_WORKFLOW_UNSUPPORTED") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell verify <test|build|lint|format|modules> [--tail N]", {
        reason: result.error.message
      }));
      process.exitCode = 2;
      return;
    }
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "log") {
    const subcommand = args[1];
    if (subcommand === "delta") {
      const maxBytesFlag = args.indexOf("--max-bytes");
      const result = await logDelta(process.cwd(), args[2], {
        compact: args.includes("--compact"),
        reset: args.includes("--reset"),
        maxBytes: maxBytesFlag >= 0 ? args[maxBytesFlag + 1] : undefined
      });
      emit(result);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    const logRef = args[2];
    const tailFlag = args.indexOf("--tail");
    const tail = tailFlag >= 0 ? args[tailFlag + 1] : undefined;
    if (subcommand !== "get") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell log get <logRef> --tail N"));
      process.exitCode = 2;
      return;
    }
    const result = await getLog(process.cwd(), logRef, { tail });
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "exec") {
    const timeoutFlag = args.indexOf("--timeout-ms");
    const outputFlag = args.indexOf("--max-output-bytes");
    const result = await execCommand(process.cwd(), args.slice(1), {
      timeoutMs: timeoutFlag >= 0 ? args[timeoutFlag + 1] : undefined,
      maxOutputBytes: outputFlag >= 0 ? args[outputFlag + 1] : undefined
    });
    emit(result);
    process.exitCode = result.ok ? 0 : (result.error?.code === "INVALID_ARGUMENT" ? 2 : 1);
    return;
  }

  if (command === "change") {
    if (args[1] === "suggest") {
      const result = await suggestChange(process.cwd(), {
        apply: args.includes("--apply"),
        dryRun: args.includes("--dry-run"),
        compact: args.includes("--compact")
      });
      emit(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (args[1] === "fill") {
      const templateFile = args[2];
      const fillFile = args[3];
      if (!templateFile || !fillFile) {
        emit(fail("INVALID_ARGUMENT", "Usage: agentshell change fill <template.json> <fill.json>"));
        process.exitCode = 2;
        return;
      }
      const result = await fillChange(process.cwd(), templateFile, fillFile, {
        apply: args.includes("--apply")
      });
      emit(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    const changeFile = args[1];
    if (!changeFile) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell change <change.json>"));
      process.exitCode = 2;
      return;
    }
    const result = await change(process.cwd(), changeFile);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "undo") {
    const result = await undo(process.cwd(), args[1]);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "history") {
    emit(await history(process.cwd()));
    return;
  }

  if (command === "run") {
    const action = args[1] || "status";
    if (!["next", "status", "latest", "clear"].includes(action)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell run next OR agentshell run status [--compact] OR agentshell run latest [--compact] OR agentshell run clear"));
      process.exitCode = 2;
      return;
    }
    emit(await runStatus(process.cwd(), action, {
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "coverage") {
    const action = args[1] && !args[1].startsWith("--") ? args[1] : "status";
    if (action === "candidates") {
      const limitFlag = args.indexOf("--limit");
      const limit = limitFlag >= 0 ? args[limitFlag + 1] : undefined;
      let result;
      try {
        result = adaptiveCoverage(process.cwd(), { limit });
      } catch (error) {
        result = fail("ADAPTIVE_COVERAGE_INVALID", error.message);
      }
      emit(result);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (action === "observe") {
      const separator = args.indexOf("--");
      const sourceFlag = args.indexOf("--source");
      const source = sourceFlag >= 0 ? args[sourceFlag + 1] : undefined;
      const invalidSource = sourceFlag >= 0 && (!source || source.startsWith("--"));
      const commandArgs = separator >= 0 ? args.slice(separator + 1) : [];
      const result = invalidSource || commandArgs.length === 0
        ? fail("INVALID_ARGUMENT", "Usage: agentshell coverage observe [--source adapter] -- <command...>")
        : coverage(process.cwd(), action, { source, command: commandArgs });
      emit(result);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (action === "ingest") {
      const inputFlag = args.indexOf("--input");
      const sourceFlag = args.indexOf("--source");
      const input = inputFlag >= 0 ? args[inputFlag + 1] : null;
      const source = sourceFlag >= 0 ? args[sourceFlag + 1] : undefined;
      let result;
      try {
        if (!input || input.startsWith("--")) throw new Error("--input requires a JSON file");
        const payload = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
        result = coverage(process.cwd(), action, { payload, source });
      } catch (error) {
        result = fail("ADAPTER_OBSERVATION_INVALID", error.message);
      }
      emit(result);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (action === "reset") {
      const result = args.includes("--confirm")
        ? coverage(process.cwd(), action)
        : fail("CONFIRMATION_REQUIRED", "Use `agentshell coverage reset --confirm`");
      emit(result);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (action !== "status") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell coverage [status] [--compact] [--limit N] | coverage candidates [--limit N] | coverage observe [--source adapter] -- <command...> | coverage ingest --input <payload.json> [--source adapter] | coverage reset --confirm"));
      process.exitCode = 2;
      return;
    }
    const limitFlag = args.indexOf("--limit");
    const limit = limitFlag >= 0 ? args[limitFlag + 1] : undefined;
    const result = coverage(process.cwd(), action, { compact: args.includes("--compact"), limit });
    emit(result);
    return;
  }

  if (command === "workspace") {
    const action = args[1];
    if (!["guard", "audit"].includes(action)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell workspace <guard|audit> --root <repo-a> --root <repo-b> [--compact]"));
      process.exitCode = 2;
      return;
    }
    const parsed = parseMultiRootOptions(args.slice(2), action === "guard" ? "workspace-guard" : "workspace-audit");
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    const result = action === "guard"
      ? await workspaceGuard(parsed.value.roots, parsed.value.options)
      : await workspaceAudit(parsed.value.roots, parsed.value.options);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "compare-search") {
    const query = args[1];
    const parsed = parseMultiRootOptions(args.slice(2), "compare-search");
    if (!query || query.startsWith("--") || !parsed.ok) {
      emit(parsed.ok
        ? fail("INVALID_ARGUMENT", "Usage: agentshell compare-search <query> --root <repo-a> --root <repo-b> [--fixed-strings] [--ignore-case] [--compact]")
        : parsed);
      process.exitCode = 2;
      return;
    }
    const result = await compareSearch(parsed.value.roots, query, parsed.value.options);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "boundary") {
    if (args[1] !== "check") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell boundary check (--policy <file>|--deny <prefix> [--allow <prefix>]) [--compact]"));
      process.exitCode = 2;
      return;
    }
    const parsed = parseBoundaryCheckOptions(args.slice(2));
    if (!parsed.ok) {
      emit(parsed);
      process.exitCode = 2;
      return;
    }
    const result = boundaryCheck(process.cwd(), parsed.value);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "go") {
    if (args[1] !== "locate") {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell go locate <symbol|dependency|generated> [query] [--package IMPORT] [--kind KIND] [--timeout-ms N] [--max-results N] [--compact]"));
      process.exitCode = 2;
      return;
    }
    const result = await goLocateCommand(process.cwd(), args.slice(2));
    emit(result);
    process.exitCode = result.ok ? 0 : (result.error?.code === "INVALID_ARGUMENT" ? 2 : 1);
    return;
  }

  if (command === "job") {
    const action = args[1];
    if (!["start", "status", "delta", "cancel"].includes(action)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell job <start|status|delta|cancel> [options]"));
      process.exitCode = 2;
      return;
    }
    const result = await jobCommand(process.cwd(), action, args.slice(2));
    emit(result);
    process.exitCode = result.ok ? 0 : (result.error?.code === "INVALID_ARGUMENT" ? 2 : 1);
    return;
  }

  if (command === "runtime") {
    const action = args[1] || "status";
    const runtimeDirFlag = args.indexOf("--runtime-dir");
    const runtimeDir = runtimeDirFlag >= 0 ? args[runtimeDirFlag + 1] : process.env.AGENTSHELL_RUNTIME_DIR;
    if (runtimeDirFlag >= 0 && (!runtimeDir || runtimeDir.startsWith("--"))) {
      emit(fail("INVALID_ARGUMENT", "--runtime-dir requires a path"));
      process.exitCode = 2;
      return;
    }
    if (!["start", "serve", "status", "stop", "request", "invalidate"].includes(action)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell runtime <start|status|stop|request|invalidate> [--runtime-dir PATH] [--compact]"));
      process.exitCode = 2;
      return;
    }
    if (action === "serve") {
      const session = await runtimeCommand(process.cwd(), "start", { runtimeDir, foreground: true, returnSession: true });
      emit(session.report);
      const close = () => session.close().finally(() => process.exit(0));
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      return;
    }
    const result = await runtimeCommand(process.cwd(), action, { runtimeDir });
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "metrics") {
    if (args[1] === "reset") {
      const result = args.includes("--confirm")
        ? resetMetrics(process.cwd())
        : fail("CONFIRMATION_REQUIRED", "Use `agentshell metrics reset --confirm`");
      emit(result);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (args[1] === "export") {
      const outFlag = args.indexOf("--out");
      const out = outFlag >= 0 ? args[outFlag + 1] : undefined;
      const sinceFlag = args.indexOf("--since");
      const since = sinceFlag >= 0 ? args[sinceFlag + 1] : undefined;
      const scopeFlag = args.indexOf("--scope");
      const scope = scopeFlag >= 0 ? args[scopeFlag + 1] : "workspace";
      const result = out
        ? await exportMetrics(process.cwd(), out, { since, scope })
        : fail("INVALID_ARGUMENT", "Usage: agentshell metrics export --out <file> [--since 24h|7d|all] [--scope workspace|global]");
      emit(result);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    const limitFlag = args.indexOf("--limit");
    const limit = limitFlag >= 0 ? args[limitFlag + 1] : undefined;
    const sinceFlag = args.indexOf("--since");
    const since = sinceFlag >= 0 ? args[sinceFlag + 1] : undefined;
    const scopeFlag = args.indexOf("--scope");
    const scope = scopeFlag >= 0 ? args[scopeFlag + 1] : "workspace";
    if (!["workspace", "global"].includes(scope)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell metrics [--compact] [--limit N] [--since 24h|7d|all] [--scope workspace|global]"));
      process.exitCode = 2;
      return;
    }
    emit(await metrics(process.cwd(), {
      limit,
      since,
      scope,
      compact: args.includes("--compact")
    }));
    return;
  }

  if (command === "benchmark") {
    const type = args[1];
    const result = await benchmark(process.cwd(), type);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "diagnose") {
    const type = args[1];
    const result = await diagnose(process.cwd(), type, {
      compact: args.includes("--compact"),
      profile: args.includes("--profile")
    });
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "fix") {
    const type = args[1];
    const policy = parseFixPolicy(args);
    if (!policy.ok) {
      emit(policy);
      process.exitCode = 2;
      return;
    }
    const result = await fix(process.cwd(), type, {
      dryRun: args.includes("--dry-run"),
      compact: args.includes("--compact"),
      profile: args.includes("--profile"),
      policy: policy.value
    });
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "schema") {
    emit(await schema(process.cwd(), args[1], args[2]));
    return;
  }

  emit(fail("UNKNOWN_COMMAND", `Unknown command: ${command}`));
  process.exitCode = 2;
}

main().catch((error) => {
  emit(fail("UNEXPECTED_ERROR", error.message));
  process.exitCode = 1;
}).finally(async () => {
  if (!dashboardSnapshotRoot || !dashboardRefreshDue(dashboardSnapshotRoot)) return;
  try {
    const { metrics } = await import("./commands/metrics.js");
    const report = await metrics(dashboardSnapshotRoot, { compact: true, scope: "workspace" });
    writeDashboardSnapshot(dashboardSnapshotRoot, report);
    fs.writeFileSync(dashboardRefreshMarker(dashboardSnapshotRoot), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // Dashboard telemetry must never change command behavior.
  }
});

function emit(result) {
  let emittedResult = result;
  if (result?.compact === true) {
    if (findCompactBudgetViolations(result).length > 0) {
      emittedResult = enforceCompactBudget(result);
    } else if (!Object.hasOwn(result, "summary")) {
      emittedResult = { ...result, summary: { status: result.ok === false ? "error" : "ok" } };
    }
  }
  const outputChars = printJson(emittedResult);
  if (command === "metrics") return;
  if (process.env.AGENTSHELL_DASHBOARD_GLOBAL_SERVICE === "1") return;
  if (isPluginCacheRoot(process.cwd())) return;
  try {
    const event = {
      command: command || "help",
      args: telemetryArgs(command, args),
      ok: emittedResult.ok === true,
      outputChars,
      estimatedTokens: Math.ceil(outputChars / 4),
      durationMs: Number(process.hrtime.bigint() - commandStartedAt) / 1e6
    };
    const operationIds = operationIdsFor(emittedResult);
    if (operationIds.length > 0) event.operationIds = operationIds;
    appendEvent(process.cwd(), event);
    forceDashboardSnapshot = ["start", "verify", "diagnose", "fix", "run"].includes(command);
    if (shouldRegisterWorkspace(process.cwd())) {
      registerWorkspace(process.cwd());
      dashboardSnapshotRoot = process.cwd();
    }
    if (emittedResult.runId && command !== "run") {
      appendRunCommandStats(process.cwd(), emittedResult.runId, event);
    }
  } catch {
    // Telemetry must never break the command the agent actually asked for.
  }
}

function dashboardRefreshDue(root) {
  if (forceDashboardSnapshot) return true;
  try {
    return Date.now() - fs.statSync(dashboardRefreshMarker(root)).mtimeMs >= DASHBOARD_REFRESH_INTERVAL_MS;
  } catch {
    return true;
  }
}

function dashboardRefreshMarker(root) {
  return path.join(root, ".agentshell", "dashboard-refresh");
}

function telemetryArgs(commandName, commandArgs) {
  if (commandName === "job" && commandArgs[1] === "start") {
    return ["job", "start", "--", "<argv-redacted>"];
  }
  return commandArgs;
}

function isPluginCacheRoot(root) {
  const resolved = canonicalPath(root);
  return resolved.includes(`${path.sep}.codex${path.sep}plugins${path.sep}cache${path.sep}`);
}

function shouldRegisterWorkspace(root) {
  const resolved = canonicalPath(root);
  const home = canonicalPath(os.homedir());
  return resolved !== home
    && resolved !== path.parse(resolved).root
    && !temporaryRoots().some((temporary) => (
    resolved === temporary || resolved.startsWith(`${temporary}${path.sep}`)
  ));
}

function temporaryRoots() {
  return [...new Set([os.tmpdir(), "/tmp", "/var/tmp"].map(canonicalPath))];
}

function canonicalPath(value) {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

function operationIdsFor(result) {
  return [...new Set([
    ...(Array.isArray(result?.operationIds) ? result.operationIds : []),
    ...(Array.isArray(result?.verificationOperationIds) ? result.verificationOperationIds : []),
    result?.operationId,
    result?.verification?.operationId,
    result?.finalVerification?.operationId,
    result?.diagnosis?.verification?.operationId,
    result?.relatedTestFileVerification?.operationId,
    result?.verification?.relatedTestFileVerification?.operationId
  ].filter((value) => typeof value === "string" && value))];
}

function parseFixPolicy(args) {
  const flags = [
    args.includes("--fast") ? "fast" : null,
    args.includes("--safe") ? "safe" : null
  ].filter(Boolean);
  const policyFlag = args.indexOf("--policy");
  if (policyFlag >= 0) {
    const value = args[policyFlag + 1];
    if (!value || value.startsWith("--")) {
      return fail("INVALID_ARGUMENT", "Usage: agentshell fix test [--fast|--safe|--dry-run] [--compact] [--profile]");
    }
    flags.push(value);
  }
  const unique = [...new Set(flags)];
  if (unique.length > 1) {
    return fail("INVALID_ARGUMENT", "Choose one fix policy: --fast or --safe", {
      policies: unique
    });
  }
  if (unique[0] && !["fast", "safe"].includes(unique[0])) {
    return fail("INVALID_ARGUMENT", "Fix policy must be `fast` or `safe`", {
      policy: unique[0]
    });
  }
  return { ok: true, value: unique[0] || null };
}

function parseGrepOptions(values) {
  const queryParts = [];
  const options = { compact: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") {
      options.compact = true;
      continue;
    }
    if (value === "--limit") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", grepUsage());
      options.maxMatches = parsed;
      index += 1;
      continue;
    }
    if (value === "--per-file") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", grepUsage());
      options.maxMatchesPerFile = parsed;
      index += 1;
      continue;
    }
    if (value === "--type") {
      const type = values[index + 1];
      if (!type || type.startsWith("--")) return fail("INVALID_ARGUMENT", grepUsage());
      options.type = type;
      index += 1;
      continue;
    }
    if (value === "--context") {
      const parsed = parseNonNegativeInteger(values[index + 1]);
      if (parsed === null) return fail("INVALID_ARGUMENT", grepUsage());
      options.context = parsed;
      index += 1;
      continue;
    }
    if (value === "--files-with-matches") {
      options.filesWithMatches = true;
      continue;
    }
    if (value.startsWith("--")) return fail("INVALID_ARGUMENT", `Unknown grep option: ${value}`);
    queryParts.push(value);
  }
  const query = queryParts.join(" ").trim();
  if (!query) return fail("INVALID_ARGUMENT", "Missing search query");
  return { ok: true, value: { ...options, query } };
}

function grepUsage() {
  return "Usage: agentshell grep <query> [--compact] [--limit N] [--per-file N] [--type <py|go|ts|js|java>] [--context N] [--files-with-matches]";
}

function parseFindFileCliOptions(values) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (["--name", "--path"].includes(value)) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) return fail("INVALID_ARGUMENT", "Usage: agentshell find file --name <pattern> [--path <dir>] [--limit N] [--compact]");
      options[value === "--name" ? "name" : "path"] = next;
      index += 1;
      continue;
    }
    if (value === "--limit") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell find file --name <pattern> [--path <dir>] [--limit N] [--compact]");
      options.limit = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown find file option: ${value}`);
  }
  if (!options.name) return fail("INVALID_ARGUMENT", "Usage: agentshell find file --name <pattern> [--path <dir>] [--limit N] [--compact]");
  return { ok: true, value: options };
}

function parsePathCommandOptions(values, commandName) {
  const options = { compact: values.includes("--compact") };
  let requestedPath = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--limit" || (value === "--max-depth" && commandName === "du")) {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", `Usage: agentshell ${commandName} [path] [--compact] [--limit N]${commandName === "du" ? " [--max-depth N]" : ""}`);
      options[value === "--limit" ? "limit" : "maxDepth"] = parsed;
      index += 1;
      continue;
    }
    if (value.startsWith("--") || requestedPath !== null) {
      return fail("INVALID_ARGUMENT", `Unknown ${commandName} option: ${value}`);
    }
    requestedPath = value;
  }
  options.path = requestedPath || ".";
  return { ok: true, value: options };
}

function parseInspectionOptions(values, commandName) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--all" && commandName === "ps") {
      options.all = true;
      continue;
    }
    if (["--limit", "--port", "--pid"].includes(value)) {
      const parsed = parsePositiveInteger(values[index + 1]);
      const allowed = value === "--limit" || (value === "--port" && ["port", "kill"].includes(commandName)) || (value === "--pid" && commandName === "kill");
      if (!allowed || !parsed) return fail("INVALID_ARGUMENT", inspectionUsage(commandName));
      options[value.slice(2)] = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown ${commandName} option: ${value}`);
  }
  if (commandName === "kill" && ((options.pid === undefined) === (options.port === undefined))) {
    return fail("INVALID_ARGUMENT", inspectionUsage(commandName));
  }
  return { ok: true, value: options };
}

function inspectionUsage(commandName) {
  if (commandName === "ps") return "Usage: agentshell ps [--compact] [--limit N] [--all]";
  if (commandName === "port") return "Usage: agentshell port list [--compact] [--port N] [--limit N]";
  return "Usage: agentshell kill suggest [--compact] (--pid N|--port N)";
}

function parseGitStatusOptions(values) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--max-files") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell git status [--compact] [--max-files N]");
      options.maxFiles = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown git status option: ${value}`);
  }
  return { ok: true, value: options };
}

function parseGitLogOptions(values) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--limit") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell git log [--compact] [--limit N]");
      options.limit = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown git log option: ${value}`);
  }
  return { ok: true, value: options };
}

function parseGitBranchOptions(values) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--max-branches") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell git branch [--compact] [--max-branches N]");
      options.maxBranches = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown git branch option: ${value}`);
  }
  return { ok: true, value: options };
}

function parseTestListOptions(values) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--max-files") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell test list [--compact] [--max-files N]");
      options.maxFiles = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown test list option: ${value}`);
  }
  return { ok: true, value: options };
}

function parseSymbolsOptions(values) {
  const options = { compact: values.includes("--compact") };
  const fileParts = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--max-symbols") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell symbols <file> [--compact] [--max-symbols N]");
      options.maxSymbols = parsed;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) return fail("INVALID_ARGUMENT", `Unknown symbols option: ${value}`);
    fileParts.push(value);
  }
  const file = fileParts.join(" ").trim();
  if (!file) return fail("INVALID_ARGUMENT", "Usage: agentshell symbols <file> [--compact] [--max-symbols N]");
  return { ok: true, value: { ...options, file } };
}

function parseRefsOptions(values) {
  const options = { compact: values.includes("--compact") };
  const queryParts = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--limit") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell refs <symbol> [--compact] [--limit N]");
      options.limit = parsed;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) return fail("INVALID_ARGUMENT", `Unknown refs option: ${value}`);
    queryParts.push(value);
  }
  const query = queryParts.join(" ").trim();
  if (!query) return fail("INVALID_ARGUMENT", "Usage: agentshell refs <symbol> [--compact] [--limit N]");
  return { ok: true, value: { ...options, query } };
}

function parseConfigListOptions(values) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--max-configs") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell config list [--compact] [--max-configs N]");
      options.maxConfigs = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown config list option: ${value}`);
  }
  return { ok: true, value: options };
}

function parseTreeOptions(values) {
  const options = { compact: values.includes("--compact") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--compact") continue;
    if (value === "--depth") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell tree [--compact] [--depth N] [--limit N]");
      options.depth = parsed;
      index += 1;
      continue;
    }
    if (value === "--limit") {
      const parsed = parsePositiveInteger(values[index + 1]);
      if (!parsed) return fail("INVALID_ARGUMENT", "Usage: agentshell tree [--compact] [--depth N] [--limit N]");
      options.limit = parsed;
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown tree option: ${value}`);
  }
  return { ok: true, value: options };
}

function parsePositiveInteger(value) {
  if (!value || value.startsWith("--")) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInteger(value) {
  if (value === undefined || value === null || String(value).startsWith("--")) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseSupportOptions(argv) {
  const options = { output: null, format: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "--format") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        const error = new Error(`${arg} requires a value`);
        error.code = "INVALID_ARGUMENT";
        throw error;
      }
      if (arg === "--out") options.output = path.resolve(value);
      else options.format = value;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const error = new Error(`Unknown support argument: ${arg}`);
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  if (!options.output && !options.dryRun) {
    const error = new Error("--out is required unless --dry-run is used");
    error.code = "OUTPUT_REQUIRED";
    throw error;
  }
  return options;
}

function parsePluginStatusOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--home" || arg === "--marketplace" || arg === "--cache-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return fail("INVALID_ARGUMENT", `Missing value for ${arg}`);
      }
      const key = arg === "--cache-root" ? "cacheRoot" : arg.slice(2);
      options[key] = value;
      index += 1;
      continue;
    }
    if (arg === "--compact") {
      options.compact = true;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown plugin status argument: ${arg}`);
  }
  return { ok: true, value: options };
}

function parseSelfMaintenanceOptions(argv) {
  const options = { sourceMode: "remote" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (["--source", "--channel", "--home"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return fail("INVALID_ARGUMENT", `${arg} requires a value`);
      const key = arg.slice(2);
      options[key] = key === "source" || key === "home" ? path.resolve(value) : value;
      if (key === "source") options.sourceMode = "local";
      index += 1;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown self-maintenance argument: ${arg}`);
  }
  if (options.source && options.channel) return fail("INVALID_ARGUMENT", "--source and --channel cannot be used together");
  return { ok: true, value: options };
}

function parseTrialExportOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify") {
      options.verify = true;
      continue;
    }
    if (["--out", "--id", "--fixture", "--rating", "--project"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return fail("INVALID_ARGUMENT", `Missing value for ${arg}`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=") || arg.startsWith("--id=") || arg.startsWith("--fixture=") || arg.startsWith("--rating=") || arg.startsWith("--project=")) {
      const [flag, ...parts] = arg.split("=");
      const value = parts.join("=");
      if (!value) return fail("INVALID_ARGUMENT", `Missing value for ${flag}`);
      options[flag.slice(2)] = value;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown trial export argument: ${arg}`);
  }
  if (options.rating !== undefined) {
    const rating = Number(options.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return fail("INVALID_ARGUMENT", "--rating must be an integer from 1 to 5");
    }
    options.rating = rating;
  }
  return { ok: true, value: options };
}

function parseVerifyOptions(type, argv) {
  const options = {};
  const valueFlags = new Map([
    ["--tail", "tail"],
    ["--profile", "profile"],
    ["--bench", "bench"],
    ["--fuzz", "fuzz"],
    ["--duration", "duration"],
    ["--package", "package"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--compact") {
      options.compact = true;
      continue;
    }
    if (arg === "--no-cache") {
      options.noCache = true;
      continue;
    }
    let flag = arg;
    let value;
    if (arg.includes("=")) {
      [flag, ...value] = arg.split("=");
      value = value.join("=");
    }
    const key = valueFlags.get(flag);
    if (!key) return fail("INVALID_ARGUMENT", `Unknown verify argument: ${arg}`, { usage: verifyUsage() });
    if (value === undefined) {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return fail("INVALID_ARGUMENT", `Missing value for ${flag}`, { usage: verifyUsage() });
      }
      index += 1;
    }
    if (!value) return fail("INVALID_ARGUMENT", `Missing value for ${flag}`, { usage: verifyUsage() });
    if (options[key] !== undefined) {
      return fail("INVALID_ARGUMENT", `${flag} may be specified only once`, { usage: verifyUsage() });
    }
    options[key] = value;
  }

  const allowed = {
    test: new Set(["tail", "profile", "compact", "noCache"]),
    build: new Set(["tail", "compact"]),
    lint: new Set(["tail", "compact"]),
    format: new Set(["tail", "compact"]),
    modules: new Set(["tail", "compact"]),
    generate: new Set(["tail", "compact"]),
    benchmark: new Set(["tail", "bench", "compact"]),
    fuzz: new Set(["tail", "fuzz", "duration", "package", "compact"])
  }[type];
  const unsupported = Object.keys(options).find((key) => !allowed.has(key));
  if (unsupported) {
    return fail("INVALID_ARGUMENT", `--${unsupported} is not supported by verify ${type}`, {
      usage: verifyUsage()
    });
  }
  if (options.profile && !["fast", "race", "coverage"].includes(options.profile)) {
    return fail("INVALID_ARGUMENT", "--profile must be fast, race, or coverage", {
      usage: verifyUsage()
    });
  }
  if (type === "fuzz" && (!options.fuzz || !options.package)) {
    return fail("INVALID_ARGUMENT", "verify fuzz requires --fuzz TARGET and --package PACKAGE", {
      usage: verifyUsage()
    });
  }
  return { ok: true, value: options };
}

function parseVerifyChangedOptions(argv) {
  const options = { compact: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--compact") options.compact = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--continue-on-error") options.continueOnError = true;
    else if (arg === "--include-dependents") options.includeDependents = true;
    else if (arg === "--timeout-ms") {
      const value = argv[++index];
      if (!value || value.startsWith("--") || !parsePositiveInteger(value)) {
        return fail("INVALID_ARGUMENT", "--timeout-ms requires a positive integer");
      }
      options.timeoutMs = Number(value);
    } else {
      return fail("INVALID_ARGUMENT", `Unknown verify changed argument: ${arg}`);
    }
  }
  return { ok: true, value: options };
}

function parseReadBatchOptions(argv) {
  const targets = [];
  const options = { compact: false };
  const numericFlags = new Map([
    ["--max-target-content-chars", "maxTargetContentChars"],
    ["--max-batch-content-chars", "maxBatchContentChars"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--compact") {
      options.compact = true;
      continue;
    }
    if (arg === "--target") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) return fail("INVALID_ARGUMENT", "--target requires a bounded read selector");
      targets.push(value);
      continue;
    }
    if (numericFlags.has(arg)) {
      const value = argv[++index];
      if (!value || !parsePositiveInteger(value)) return fail("INVALID_ARGUMENT", `${arg} requires a positive integer`);
      options[numericFlags.get(arg)] = Number(value);
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown read batch argument: ${arg}`);
  }
  if (targets.length === 0) return fail("INVALID_ARGUMENT", "read batch requires at least one --target");
  return { ok: true, value: { targets, options } };
}

function parseMultiRootOptions(argv, mode) {
  const roots = [];
  const options = { compact: false };
  const numericFlags = new Map([
    ["--max-roots", "maxRoots"],
    ["--timeout-ms", "timeoutMs"],
    ["--max-concurrency", "maxConcurrency"],
    ["--max-matches", "maxMatches"],
    ["--max-matches-per-root", "maxMatchesPerRoot"],
    ["--max-matches-per-file", "maxMatchesPerFile"],
    ["--preview-chars", "previewChars"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--compact") {
      options.compact = true;
      continue;
    }
    if (mode === "compare-search" && arg === "--fixed-strings") {
      options.fixedStrings = true;
      continue;
    }
    if (mode === "compare-search" && arg === "--ignore-case") {
      options.caseSensitive = false;
      continue;
    }
    if (arg === "--root") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) return fail("INVALID_ARGUMENT", "--root requires a path");
      roots.push(value);
      continue;
    }
    const key = numericFlags.get(arg);
    if (key && (mode === "compare-search"
      || ["--max-roots", "--timeout-ms"].includes(arg)
      || (mode === "workspace-audit" && arg === "--max-concurrency"))) {
      const value = argv[++index];
      if (!value || value.startsWith("--") || !parsePositiveInteger(value)) {
        return fail("INVALID_ARGUMENT", `${arg} requires a positive integer`);
      }
      options[key] = Number(value);
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown ${mode} argument: ${arg}`);
  }
  if (roots.length < 2) return fail("INVALID_ARGUMENT", `${mode} requires at least two --root values`);
  return { ok: true, value: { roots, options } };
}

function parseBoundaryCheckOptions(argv) {
  const options = { compact: false };
  const allow = [];
  const deny = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--compact") {
      options.compact = true;
      continue;
    }
    if (["--policy", "--allow", "--deny"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) return fail("INVALID_ARGUMENT", `${arg} requires a value`);
      if (arg === "--policy") options.policyFile = value;
      else if (arg === "--allow") allow.push(value);
      else deny.push(value);
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown boundary check argument: ${arg}`);
  }
  if (options.policyFile && (allow.length > 0 || deny.length > 0)) {
    return fail("INVALID_ARGUMENT", "Choose either --policy or inline --allow/--deny rules");
  }
  if (!options.policyFile && allow.length === 0 && deny.length === 0) {
    return fail("INVALID_ARGUMENT", "boundary check requires --policy, --allow, or --deny");
  }
  if (!options.policyFile) {
    options.policy = {
      name: "cli-boundary-policy",
      defaultEffect: "allow",
      rules: [
        ...allow.map((prefix, index) => ({ id: `allow-${index + 1}`, effect: "allow", prefix })),
        ...deny.map((prefix, index) => ({ id: `deny-${index + 1}`, effect: "deny", prefix }))
      ]
    };
  }
  return { ok: true, value: options };
}

function verifyUsage() {
  return "Usage: agentshell verify test [--profile fast|race|coverage] [--compact] [--tail N] [--no-cache] | " +
    "agentshell verify cache <explain|clear> [--compact] | " +
    "agentshell verify <build|lint|format|modules|generate> [--compact] [--tail N] | " +
    "agentshell verify benchmark [--bench REGEX] [--compact] [--tail N] | " +
    "agentshell verify fuzz --fuzz TARGET [--duration DURATION] --package PACKAGE [--compact] [--tail N]";
}

function parseTrialStatusOptions(argv) {
  if (argv.length === 0) return { ok: true, value: {} };
  if (argv.length === 2 && argv[0] === "--project" && argv[1] && !argv[1].startsWith("--")) {
    return { ok: true, value: { project: argv[1] } };
  }
  if (argv.length === 1 && argv[0].startsWith("--project=") && argv[0].slice("--project=".length)) {
    return { ok: true, value: { project: argv[0].slice("--project=".length) } };
  }
  return fail("INVALID_ARGUMENT", "Usage: agentshell trial status [--project <path>]");
}

function parseDashboardOptions(argv) {
  const options = { open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--daemon") {
      options.monitorParent = false;
      continue;
    }
    if (arg === "--status" || arg === "--stop") {
      const action = arg.slice(2);
      if (options.action && options.action !== action) return fail("INVALID_ARGUMENT", "Choose either --status or --stop");
      options.action = action;
      options.open = false;
      continue;
    }
    if (arg === "--menubar" || arg === "--window" || arg === "--browser") {
      const surface = arg.slice(2);
      if (options.surface && options.surface !== surface) {
        return fail("INVALID_ARGUMENT", "Choose one dashboard surface: --menubar, --window, or --browser");
      }
      options.surface = surface;
      continue;
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return fail("INVALID_ARGUMENT", "Missing value for --port");
      options.port = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
      if (!options.port) return fail("INVALID_ARGUMENT", "Missing value for --port");
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown dashboard argument: ${arg}`);
  }
  const port = options.port === undefined ? undefined : Number(options.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    return fail("INVALID_ARGUMENT", "--port must be an integer from 0 to 65535");
  }
  options.port = port;
  if (options.action && (options.surface || options.port !== undefined || options.monitorParent === false)) {
    return fail("INVALID_ARGUMENT", "--status/--stop cannot be combined with surface, port, or --daemon options");
  }
  return { ok: true, value: options };
}
