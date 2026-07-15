#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { understand } from "./commands/understand.js";
import { find } from "./commands/find.js";
import { readFileAround, readFileRange } from "./commands/read.js";
import { verify } from "./commands/verify.js";
import { change, fillChange, suggestChange } from "./commands/change.js";
import { undo } from "./commands/undo.js";
import { history } from "./commands/history.js";
import { manual } from "./commands/manual.js";
import { getLog } from "./commands/log.js";
import { exportMetrics, metrics, resetMetrics } from "./commands/metrics.js";
import { benchmark } from "./commands/benchmark.js";
import { schema } from "./commands/schema.js";
import { diagnose } from "./commands/diagnose.js";
import { fix } from "./commands/fix.js";
import { runStatus } from "./commands/run-status.js";
import { doctor } from "./commands/doctor.js";
import { start } from "./commands/start.js";
import { pluginStatus } from "./commands/plugin-status.js";
import { parsePluginValidateOptions, pluginValidate } from "./commands/plugin-validate.js";
import { exportTrial, trialStatus } from "./commands/trial-export.js";
import { dashboardStatus, startDashboard, stopDashboard } from "./commands/dashboard.js";
import { setupCodex } from "./commands/setup-codex.js";
import { fail, printJson } from "./core/output.js";
import { appendEvent, appendRunCommandStats } from "./core/store.js";
import { registerWorkspace } from "./core/workspace-registry.js";
import { resolvePackageRoot } from "./core/package-root.js";
import { writeDashboardSnapshot } from "./core/dashboard-snapshot.js";

const args = process.argv.slice(2);
const command = args[0];
const commandStartedAt = process.hrtime.bigint();
let dashboardSnapshotRoot = null;

async function main() {
  if (command === "--version" || command === "-v" || command === "version") {
    printJson({
      ok: true,
      protocolVersion: "agentshell.version.v1",
      name: "agentshell",
      version: "0.25.1"
    });
    return;
  }
  if (!command || command === "--help" || command === "-h") {
    printJson({
      ok: true,
      name: "agentshell",
      version: "0.25.1",
      commands: [
        "agentshell --version",
        "agentshell manual [--full|--topic <repair|plugin|benchmark|profile|onboarding|log-triage|reference>]",
        "agentshell start [--compact] [--profile]",
        "agentshell entry [--compact] [--profile]",
        "agentshell doctor",
        "agentshell plugin status [--compact] [--home <home>] [--marketplace <path>] [--cache-root <path>]",
        "agentshell plugin validate [--compact] [--source-only] [--profile] [--home <home>] [--marketplace <path>] [--cache-root <path>]",
        "agentshell trial status [--project <path>]",
        "agentshell trial export [--verify] [--project <path>] [--out <file>] [--id <label>] [--fixture <label>] [--rating 1-5]",
        "agentshell dashboard [--port N] [--menubar|--window|--browser] [--daemon] [--no-open|--status|--stop]",
        "agentshell setup codex [install|update|uninstall|doctor] [--source <package>] [--home <path>] [--dry-run]",
        "agentshell understand [--compact]",
        "agentshell find <query>",
        "agentshell read <file> --lines A:B",
        "agentshell read <file> --around <query>",
        "agentshell verify test [--tail N]",
        "agentshell change suggest [--dry-run] [--apply] [--compact]",
        "agentshell change fill <template.json> <fill.json> [--apply]",
        "agentshell change <change.json>",
        "agentshell undo [operationId]",
        "agentshell history",
        "agentshell log get <logRef> --tail N",
        "agentshell metrics [--compact] [--limit N] [--since 24h|7d|all] [--scope workspace|global]",
        "agentshell metrics export --out <file> [--since 24h|7d|all] [--scope workspace|global]",
        "agentshell metrics reset --confirm",
        "agentshell benchmark test",
        "agentshell diagnose test [--compact] [--profile]",
        "agentshell fix test [--fast|--safe|--dry-run] [--compact] [--profile]",
        "agentshell run next",
        "agentshell run status [--compact]",
        "agentshell run latest [--compact]",
        "agentshell run clear",
        "agentshell schema list",
        "agentshell schema get <name>"
      ]
    });
    return;
  }

  if (command === "setup") {
    if (args[1] !== "codex") {
      printJson(fail("INVALID_ARGUMENT", "Usage: agentshell setup codex [install|update|uninstall|doctor] [--source <package>] [--home <path>] [--dry-run]"));
      process.exitCode = 2;
      return;
    }
    const action = args[2] && !args[2].startsWith("--") ? args[2] : "install";
    const sourceFlag = args.indexOf("--source");
    const homeFlag = args.indexOf("--home");
    let source;
    let home;
    try {
      if (sourceFlag >= 0 && (!args[sourceFlag + 1] || args[sourceFlag + 1].startsWith("--"))) throw new Error("--source requires a path");
      if (homeFlag >= 0 && (!args[homeFlag + 1] || args[homeFlag + 1].startsWith("--"))) throw new Error("--home requires a path");
      source = sourceFlag >= 0 ? path.resolve(args[sourceFlag + 1]) : resolvePackageRoot();
      home = homeFlag >= 0 ? path.resolve(args[homeFlag + 1]) : undefined;
    } catch (error) {
      printJson(fail("PACKAGE_ROOT_NOT_FOUND", error.message));
      process.exitCode = 1;
      return;
    }
    const result = await setupCodex(action, { source, home, dryRun: args.includes("--dry-run") });
    printJson(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "manual") {
    const options = parseManualOptions(args.slice(1));
    if (!options.ok) {
      emit(options);
      process.exitCode = 2;
      return;
    }
    const result = await manual(options.value);
    emit(result);
    process.exitCode = result.ok ? 0 : 2;
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
    emit(await doctor(process.cwd()));
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

  if (command === "find") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      emit(fail("INVALID_ARGUMENT", "Missing search query"));
      process.exitCode = 2;
      return;
    }
    emit(await find(process.cwd(), query));
    return;
  }

  if (command === "read") {
    const file = args[1];
    const linesFlag = args.indexOf("--lines");
    const aroundFlag = args.indexOf("--around");
    const lines = linesFlag >= 0 ? args[linesFlag + 1] : undefined;
    const around = aroundFlag >= 0 ? args.slice(aroundFlag + 1).join(" ").trim() : undefined;
    if (!file || (!lines && !around)) {
      emit(fail("INVALID_ARGUMENT", "Usage: agentshell read <file> --lines A:B OR agentshell read <file> --around <query>"));
      process.exitCode = 2;
      return;
    }
    emit(lines
      ? await readFileRange(process.cwd(), file, lines)
      : await readFileAround(process.cwd(), file, around));
    return;
  }

  if (command === "verify") {
    const type = args[1];
    if (type !== "test") {
      emit(fail("INVALID_ARGUMENT", "Only `agentshell verify test` is supported"));
      process.exitCode = 2;
      return;
    }
    const tailFlag = args.indexOf("--tail");
    const tail = tailFlag >= 0 ? args[tailFlag + 1] : undefined;
    const result = await verify(process.cwd(), type, { tail });
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "log") {
    const subcommand = args[1];
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
  if (!dashboardSnapshotRoot) return;
  try {
    const report = await metrics(dashboardSnapshotRoot, { compact: true, scope: "workspace" });
    writeDashboardSnapshot(dashboardSnapshotRoot, report);
  } catch {
    // Dashboard telemetry must never change command behavior.
  }
});

function emit(result) {
  const outputChars = printJson(result);
  if (command === "metrics") return;
  try {
    const event = {
      command: command || "help",
      args,
      ok: result.ok === true,
      outputChars,
      estimatedTokens: Math.ceil(outputChars / 4),
      durationMs: Number(process.hrtime.bigint() - commandStartedAt) / 1e6
    };
    const operationIds = operationIdsFor(result);
    if (operationIds.length > 0) event.operationIds = operationIds;
    appendEvent(process.cwd(), event);
    if (shouldRegisterWorkspace(process.cwd())) {
      registerWorkspace(process.cwd());
      dashboardSnapshotRoot = process.cwd();
    }
    if (result.runId && command !== "run") {
      appendRunCommandStats(process.cwd(), result.runId, event);
    }
  } catch {
    // Telemetry must never break the command the agent actually asked for.
  }
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

function parseManualOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--topic") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return fail("INVALID_ARGUMENT", "Missing value for --topic");
      }
      options.topic = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--topic=")) {
      options.topic = arg.slice("--topic=".length);
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown manual argument: ${arg}`);
  }
  if (options.full && options.topic) {
    return fail("INVALID_ARGUMENT", "Choose either --full or --topic, not both");
  }
  return { ok: true, value: options };
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
