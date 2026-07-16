import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("help returns command list as JSON", () => {
  const result = spawnSync("node", ["src/cli.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.ok(output.commands.includes("agentshell --version"));
  assert.ok(output.commands.includes("agentshell understand [--compact]"));
  assert.ok(output.commands.includes("agentshell doctor"));
  assert.ok(output.commands.includes("agentshell plugin status [--compact] [--home <home>] [--marketplace <path>] [--cache-root <path>]"));
  assert.ok(output.commands.includes("agentshell plugin validate [--compact] [--source-only] [--profile] [--home <home>] [--marketplace <path>] [--cache-root <path>]"));
  assert.ok(output.commands.includes("agentshell trial status [--project <path>]"));
  assert.ok(output.commands.includes("agentshell trial export [--verify] [--project <path>] [--out <file>] [--id <label>] [--fixture <label>] [--rating 1-5]"));
  assert.ok(output.commands.includes("agentshell support export --out <bundle.json|bundle.zip> [--format json|zip] [--dry-run]"));
  assert.ok(output.commands.includes("agentshell dashboard [--port N] [--menubar|--window|--browser] [--daemon] [--no-open|--status|--stop]"));
  assert.ok(output.commands.includes("agentshell manual [--full|--topic <repair|plugin|benchmark|profile|onboarding|log-triage|reference>]"));
  assert.ok(output.commands.includes("agentshell start [--compact] [--profile]"));
  assert.ok(output.commands.includes("agentshell entry [--compact] [--profile]"));
  assert.ok(output.commands.includes("agentshell fix test [--fast|--safe|--dry-run] [--compact] [--profile]"));
});

test("support export dry-run is available from the product CLI", () => {
  const result = spawnSync("node", ["src/cli.js", "support", "export", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.support-bundle.v1");
  assert.equal(output.privacy.userPathsIncluded, false);
  assert.equal(output.artifact.written, false);
});

test("setup codex exposes explicit stable and beta release channels", () => {
  const beta = spawnSync("node", ["src/cli.js", "setup", "codex", "update", "--channel", "beta", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(beta.status, 0, beta.stderr);
  const output = JSON.parse(beta.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.channel, "beta");
  assert.equal(output.release.status, "would-resolve");

  const conflict = spawnSync("node", ["src/cli.js", "setup", "codex", "update", "--channel", "stable", "--source", ".", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stdout).error.code, "INVALID_ARGUMENT");
});

test("version returns a machine-readable product version", () => {
  const result = spawnSync("node", ["src/cli.js", "--version"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.protocolVersion, "agentshell.version.v1");
  assert.equal(output.version, "1.0.0");
});

test("dashboard accepts only one explicit surface", () => {
  const result = spawnSync("node", ["src/cli.js", "dashboard", "--menubar", "--browser"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(output.error.message, /Choose one dashboard surface/);
});

test("understand returns a versioned workspace summary", () => {
  const result = spawnSync("node", ["src/cli.js", "understand"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.understand.v1");
  assert.equal(output.workspace.name, "agentshell");
  assert.equal(Object.hasOwn(output, "compact"), false);
  assert.ok(Array.isArray(output.suggestedNextActions));
  assert.ok(Array.isArray(output.git.changedFiles));
});

test("understand --compact returns first-pass decision context with less output", () => {
  const full = spawnSync("node", ["src/cli.js", "understand"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const compact = spawnSync("node", ["src/cli.js", "understand", "--compact"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(full.status, 0);
  assert.equal(compact.status, 0);
  const output = JSON.parse(compact.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.understand.v1");
  assert.equal(output.compact, true);
  assert.equal(output.workspace.name, "agentshell");
  assert.equal(Object.hasOwn(output.workspace, "root"), false);
  assert.equal(Object.hasOwn(output.git, "changedFiles"), false);
  assert.equal(Object.hasOwn(output, "suggestedNextActions"), false);
  assert.equal(output.nextAction, "agentshell verify test");
  assert.ok(compact.stdout.length < full.stdout.length);
});

test("read returns a hashed line range", () => {
  const result = spawnSync("node", ["src/cli.js", "read", "package.json", "--lines", "1:5"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.read.v1");
  assert.equal(output.file, "package.json");
  assert.match(output.hash, /^sha256:/);
  assert.match(output.content, /1 \| {/);
});

test("read --around returns context near a query", () => {
  const result = spawnSync("node", ["src/cli.js", "read", "src/commands/read.js", "--around", "rangeAround"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.read.v1");
  assert.equal(output.file, "src/commands/read.js");
  assert.ok(output.matchedLine > 0);
  assert.match(output.content, /rangeAround/);
});

test("find returns versioned matches", () => {
  const result = spawnSync("node", ["src/cli.js", "find", "protocolVersion"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.find.v1");
  assert.equal(output.query, "protocolVersion");
  assert.ok(output.matches.length > 0);
});

test("node src/cli.js manual returns compact routing by default", () => {
  const result = spawnSync("node", ["src/cli.js", "manual"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const full = spawnSync("node", ["src/cli.js", "manual", "--full"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.equal(full.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.manual.v1");
  assert.equal(output.compact, true);
  assert.equal(output.name, "AgentShell");
  assert.equal(output.version, "1.0.0");
  assert.equal(output.firstPass.command, "agentshell start --compact");
  assert.ok(output.primaryCommands.some((entry) => entry.command === "agentshell fix test --fast --compact"));
  assert.ok(output.topics.some((entry) => entry.command === "agentshell manual --topic repair"));
  assert.equal(output.full, "agentshell manual --full");
  assert.equal(Object.hasOwn(output, "commandMap"), false);
  assert.ok(result.stdout.length < full.stdout.length);
});

test("node src/cli.js manual --full preserves complete command map", () => {
  const result = spawnSync("node", ["src/cli.js", "manual", "--full"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.manual.v1");
  assert.equal(output.compact, false);
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell start --compact OR agentshell entry --compact"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell doctor"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell read <file> --around <query>"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell log get <logRef> --tail N"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell metrics --compact [--limit N] [--scope workspace|global]"));
  assert.ok(output.commandMap.some((entry) => entry.command.includes("agentshell change suggest --dry-run --compact")));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell benchmark test"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell diagnose test [--compact]"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell fix test [--fast|--safe|--dry-run] [--compact] [--profile]"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell run next"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell run status --compact"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell run clear"));
  assert.ok(output.commandMap.some((entry) => entry.command === "agentshell schema list"));
  assert.ok(output.rules.some((rule) => rule.includes("expectedHash")));
});

test("node src/cli.js manual --topic returns focused topic payloads", () => {
  const repair = spawnSync("node", ["src/cli.js", "manual", "--topic", "repair"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const plugin = spawnSync("node", ["src/cli.js", "manual", "--topic=plugin"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const invalid = spawnSync("node", ["src/cli.js", "manual", "--topic", "missing"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(repair.status, 0);
  assert.equal(plugin.status, 0);
  assert.equal(invalid.status, 2);
  const repairOutput = JSON.parse(repair.stdout);
  const pluginOutput = JSON.parse(plugin.stdout);
  const invalidOutput = JSON.parse(invalid.stdout);
  assert.equal(repairOutput.topic, "repair");
  assert.ok(repairOutput.workflow.includes("agentshell fix test --fast --compact"));
  assert.equal(pluginOutput.topic, "plugin");
  assert.ok(pluginOutput.workflow.includes("agentshell plugin validate --compact"));
  const onboarding = spawnSync("node", ["src/cli.js", "manual", "--topic", "onboarding"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const logTriage = spawnSync("node", ["src/cli.js", "manual", "--topic", "log-triage"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(onboarding.status, 0);
  assert.equal(logTriage.status, 0);
  assert.equal(JSON.parse(onboarding.stdout).topic, "onboarding");
  assert.equal(JSON.parse(logTriage.stdout).topic, "log-triage");
  assert.equal(invalidOutput.ok, false);
  assert.equal(invalidOutput.error.code, "INVALID_ARGUMENT");
  assert.ok(invalidOutput.error.details.availableTopics.includes("repair"));
});

test("start and entry return doctor, compact understand, and run next", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-start-"));
  const cli = path.join(process.cwd(), "src", "cli.js");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "start-smoke", scripts: { test: "node --test" } }, null, 2)}\n`
  );

  const start = spawnSync("node", [cli, "start"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(start.status, 0);
  const output = JSON.parse(start.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.start.v1");
  assert.equal(output.steps.doctor, "agentshell doctor");
  assert.equal(output.steps.understand, "agentshell understand --compact");
  assert.equal(output.steps.next, "agentshell run next");
  assert.equal(output.doctor.protocolVersion, "agentshell.doctor.v1");
  assert.equal(output.understand.protocolVersion, "agentshell.understand.v1");
  assert.equal(output.understand.compact, true);
  assert.equal(output.understand.workspace.name, "start-smoke");
  assert.equal(output.next.protocolVersion, "agentshell.run-next.v1");
  assert.equal(output.summary.workspace.name, "start-smoke");
  assert.equal(output.summary.nextCommand, output.next.command);
  assert.ok(output.suggestedNextActions.some((action) => action.command === output.next.command));

  const entry = spawnSync("node", [cli, "entry"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(entry.status, 0);
  const entryOutput = JSON.parse(entry.stdout);
  assert.equal(entryOutput.protocolVersion, "agentshell.start.v1");
  assert.deepEqual(entryOutput.steps, output.steps);
  assert.equal(entryOutput.doctor.protocolVersion, output.doctor.protocolVersion);
  assert.equal(entryOutput.understand.compact, true);
  assert.equal(entryOutput.next.protocolVersion, output.next.protocolVersion);

  const compact = spawnSync("node", [cli, "start", "--compact"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(compact.status, 0);
  const compactOutput = JSON.parse(compact.stdout);
  assert.equal(compactOutput.ok, true);
  assert.equal(compactOutput.protocolVersion, "agentshell.start.v1");
  assert.equal(compactOutput.compact, true);
  assert.deepEqual(compactOutput.steps, output.steps);
  assert.equal(compactOutput.summary.workspace.name, "start-smoke");
  assert.equal(Object.hasOwn(compactOutput.summary.workspace, "root"), false);
  assert.equal(compactOutput.summary.nextCommand, output.next.command);
  assert.equal(Object.hasOwn(compactOutput, "doctor"), false);
  assert.equal(Object.hasOwn(compactOutput, "understand"), false);
  assert.equal(Object.hasOwn(compactOutput, "next"), false);
  assert.ok(compact.stdout.length < start.stdout.length);

  const profiled = spawnSync("node", [cli, "start", "--compact", "--profile"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(profiled.status, 0);
  const profiledOutput = JSON.parse(profiled.stdout);
  assert.equal(profiledOutput.profile.totalMs >= 0, true);
  assert.ok(profiledOutput.profile.phases.some((phase) => phase.name === "doctor"));
  assert.ok(profiledOutput.profile.phases.some((phase) => phase.name === "understand-compact"));
});

test("doctor reports local AgentShell readiness", () => {
  const result = spawnSync("node", ["src/cli.js", "doctor"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.doctor.v1");
  assert.ok(["ready", "warning", "blocked"].includes(output.status));
  assert.equal(output.workspace.name, "agentshell");
  assert.equal(output.runtime.node.ok, true);
  assert.equal(output.package.found, true);
  assert.equal(output.package.scripts.test, "node --test tests/*.test.js");
  assert.equal(output.state.writable, true);
  assert.equal(typeof output.activeRun.present, "boolean");
  assert.ok(["in_progress", "failing", "passed", null].includes(output.activeRun.status));
  assert.ok(output.checks.some((check) => check.name === "state-dir" && check.ok));
  assert.ok(output.checks.some((check) => check.name === "active-run" && check.ok));
  assert.ok(output.suggestedNextActions.some((action) => action.command === "agentshell verify test"));
});

test("plugin status reports local plugin install consistency", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-status-"));
  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  const version = "0.24.0+codex.fixture";
  const cli = path.join(process.cwd(), "src", "cli.js");
  writePluginManifest(repo, version);
  writeMarketplace(home);
  writePluginManifest(path.join(cacheRoot, version), version);

  const result = spawnSync("node", [
    cli,
    "plugin",
    "status",
    "--home",
    home,
    "--cache-root",
    cacheRoot
  ], {
    cwd: repo,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.plugin-status.v1");
  assert.equal(output.plugin.name, "agentshell");
  assert.equal(output.plugin.version, version);
  assert.equal(output.plugin.authorName, "Alvin");
  assert.equal(output.plugin.developerName, "AgentShell Labs");
  assert.equal(output.summary.failed, 0);
  assert.equal(output.summary.warnings, 0);
  assert.equal(output.paths.cachePath, path.join(cacheRoot, version));
  assert.deepEqual(output.suggestedNextActions, []);

  const compact = spawnSync("node", [
    cli,
    "plugin",
    "status",
    "--compact",
    "--home",
    home,
    "--cache-root",
    cacheRoot
  ], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(compact.status, 0, compact.stderr);
  const compactOutput = JSON.parse(compact.stdout);
  assert.equal(compactOutput.ok, true);
  assert.equal(compactOutput.protocolVersion, "agentshell.plugin-status.v1");
  assert.equal(compactOutput.compact, true);
  assert.equal(compactOutput.status, "ready");
  assert.equal(compactOutput.plugin.version, version);
  assert.equal(compactOutput.plugin.authorName, "Alvin");
  assert.equal(compactOutput.plugin.developerName, "AgentShell Labs");
  assert.equal(compactOutput.cachePath, path.join(cacheRoot, version));
  assert.equal(compactOutput.nextAction, null);
  assert.equal(Object.hasOwn(compactOutput, "checks"), false);
  assert.equal(Object.hasOwn(compactOutput, "paths"), false);

  const missingCacheHome = path.join(base, "missing-cache-home");
  writeMarketplace(missingCacheHome);
  const missingCache = spawnSync("node", [
    cli,
    "plugin",
    "status",
    "--compact",
    "--home",
    missingCacheHome,
    "--cache-root",
    path.join(missingCacheHome, ".codex", "plugins", "cache", "personal", "agentshell")
  ], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(missingCache.status, 1, missingCache.stderr);
  const missingCacheOutput = JSON.parse(missingCache.stdout);
  assert.equal(missingCacheOutput.ok, false);
  assert.equal(missingCacheOutput.status, "blocked");
  assert.equal(missingCacheOutput.nextAction.command, "codex plugin add agentshell@personal");
  assert.equal(missingCacheOutput.nextAction.reason, "codex plugin cache has manifest version directory");

  const metadataMismatchHome = path.join(base, "metadata-mismatch-home");
  const metadataMismatchCacheRoot = path.join(
    metadataMismatchHome,
    ".codex",
    "plugins",
    "cache",
    "personal",
    "agentshell"
  );
  writeMarketplace(metadataMismatchHome);
  writePluginManifest(path.join(metadataMismatchCacheRoot, version), version, {
    authorName: "Someone Else",
    developerName: "Different Labs"
  });
  const metadataMismatch = spawnSync("node", [
    cli,
    "plugin",
    "status",
    "--home",
    metadataMismatchHome,
    "--cache-root",
    metadataMismatchCacheRoot
  ], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(metadataMismatch.status, 1, metadataMismatch.stderr);
  const metadataMismatchOutput = JSON.parse(metadataMismatch.stdout);
  assert.equal(metadataMismatchOutput.ok, false);
  assert.equal(metadataMismatchOutput.summary.failed, 1);
  const mismatchCheck = metadataMismatchOutput.checks.find(
    (check) => check.name === "codex plugin cache manifest matches source manifest"
  );
  assert.equal(mismatchCheck.ok, false);
  assert.equal(mismatchCheck.details.sourceAuthorName, "Alvin");
  assert.equal(mismatchCheck.details.sourceDeveloperName, "AgentShell Labs");
  assert.equal(mismatchCheck.details.cacheAuthorName, "Someone Else");
  assert.equal(mismatchCheck.details.cacheDeveloperName, "Different Labs");
  assert.ok(
    metadataMismatchOutput.suggestedNextActions.includes(
      "Run `codex plugin add agentshell@personal` so Codex caches the current marketplace copy."
    )
  );
});

test("plugin validate reports source and installed plugin health", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-validate-"));
  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  const version = "0.24.0+codex.validate";
  const cli = path.join(process.cwd(), "src", "cli.js");
  writePluginValidateFixture(repo, version);
  writeMarketplace(home);
  writePluginManifest(path.join(cacheRoot, version), version);
  fs.mkdirSync(path.join(cacheRoot, version, "bin"), { recursive: true });
  for (const bin of ["agentshell", "agentshell-mcp"]) {
    const file = path.join(cacheRoot, version, "bin", bin);
    fs.writeFileSync(file, "#!/usr/bin/env node\n");
    fs.chmodSync(file, 0o755);
  }

  const sourceOnly = spawnSync("node", [
    cli,
    "plugin",
    "validate",
    "--source-only",
    "--compact",
    "--home",
    home,
    "--cache-root",
    cacheRoot
  ], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(sourceOnly.status, 0, sourceOnly.stderr);
  const sourceOutput = JSON.parse(sourceOnly.stdout);
  assert.equal(sourceOutput.ok, true);
  assert.equal(sourceOutput.protocolVersion, "agentshell.plugin-validate.v1");
  assert.equal(sourceOutput.mode, "source-only");
  assert.equal(sourceOutput.pluginStatus, null);
  assert.equal(sourceOutput.summary.failed, 0);

  const installed = spawnSync("node", [
    cli,
    "plugin",
    "validate",
    "--compact",
    "--home",
    home,
    "--cache-root",
    cacheRoot
  ], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(installed.status, 0, installed.stderr);
  const installedOutput = JSON.parse(installed.stdout);
  assert.equal(installedOutput.ok, true);
  assert.equal(installedOutput.mode, "installed");
  assert.equal(installedOutput.pluginStatus.ok, true);
  assert.equal(installedOutput.pluginStatus.protocolVersion, "agentshell.plugin-status.v1");
  assert.equal(installedOutput.cachePath, path.join(cacheRoot, version));
  assert.equal(installedOutput.nextAction, null);

  const profiled = spawnSync("node", [
    cli,
    "plugin",
    "validate",
    "--compact",
    "--profile",
    "--home",
    home,
    "--cache-root",
    cacheRoot
  ], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(profiled.status, 0, profiled.stderr);
  const profiledOutput = JSON.parse(profiled.stdout);
  assert.equal(profiledOutput.protocolVersion, "agentshell.plugin-validate.v1");
  assert.equal(profiledOutput.profile.totalMs >= 0, true);
  assert.ok(profiledOutput.profile.phases.some((phase) => phase.name === "plugin-status"));

  fs.mkdirSync(path.join(cacheRoot, version, "artifacts"), { recursive: true });
  const drift = spawnSync("node", [
    cli,
    "plugin",
    "validate",
    "--compact",
    "--home",
    home,
    "--cache-root",
    cacheRoot
  ], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(drift.status, 1, drift.stderr);
  const driftOutput = JSON.parse(drift.stdout);
  assert.equal(driftOutput.ok, false);
  assert.equal(driftOutput.status, "blocked");
  assert.equal(driftOutput.nextAction.reason, "installed plugin cache excludes runtime state");
});

test("history and log get return versioned success responses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-cli-smoke-"));
  const cli = path.join(process.cwd(), "src", "cli.js");
  const logRef = "log_cli_smoke";
  fs.mkdirSync(path.join(dir, ".agentshell", "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agentshell", "logs", `${logRef}.stdout.log`), "alpha\nbeta\n");
  fs.writeFileSync(path.join(dir, ".agentshell", "logs", `${logRef}.stderr.log`), "gamma\n");

  const history = spawnSync("node", [cli, "history"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(history.status, 0);
  const historyOutput = JSON.parse(history.stdout);
  assert.equal(historyOutput.ok, true);
  assert.equal(historyOutput.protocolVersion, "agentshell.history.v1");
  assert.ok(Array.isArray(historyOutput.operations));

  const log = spawnSync("node", [cli, "log", "get", logRef, "--tail", "2"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(log.status, 0);
  const logOutput = JSON.parse(log.stdout);
  assert.equal(logOutput.ok, true);
  assert.equal(logOutput.protocolVersion, "agentshell.log.v1");
  assert.equal(logOutput.logRef, logRef);
  assert.match(logOutput.combined, /beta/);
});

test("schema list and schema get expose JSON contracts", () => {
  const list = spawnSync("node", ["src/cli.js", "schema", "list"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(list.status, 0);
  const listOutput = JSON.parse(list.stdout);
  assert.equal(listOutput.ok, true);
  assert.equal(listOutput.protocolVersion, "agentshell.schema-list.v1");
  assert.ok(listOutput.schemas.some((entry) => entry.name === "start"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "understand"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "verify"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "doctor"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "diagnose"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "plugin-validate"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "plugin-release-local"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "plugin-smoke"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "product-readiness"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "manual"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "change-fill"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "change-suggest"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "fix"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "benchmark-suite"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "strategy-coverage-matrix"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "strategy-intake"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "codex-plugin-trial"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "cold-start-benchmark"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "real-project-eval"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "real-project-candidates"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "run"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "run-next"));
  assert.ok(listOutput.schemas.some((entry) => entry.name === "run-clear"));

  const get = spawnSync("node", ["src/cli.js", "schema", "get", "verify"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(get.status, 0);
  const schema = JSON.parse(get.stdout);
  assert.equal(schema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(schema.title, "AgentShell Verify Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.verify.v1");

  const manual = spawnSync("node", ["src/cli.js", "schema", "get", "manual"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(manual.status, 0);
  const manualSchema = JSON.parse(manual.stdout);
  assert.equal(manualSchema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(manualSchema.oneOf[0].properties.protocolVersion.const, "agentshell.manual.v1");
  assert.equal(manualSchema.oneOf[0].properties.compact.const, true);
  assert.equal(manualSchema.oneOf[1].properties.topic.enum.includes("repair"), true);
  assert.equal(manualSchema.oneOf[2].properties.compact.const, false);

  const start = spawnSync("node", ["src/cli.js", "schema", "get", "start"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(start.status, 0);
  const startSchema = JSON.parse(start.stdout);
  assert.equal(startSchema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(startSchema.oneOf[0].properties.protocolVersion.const, "agentshell.start.v1");
  assert.equal(startSchema.oneOf[0].properties.understand.$ref, "#/$defs/compactUnderstand");
  assert.ok(startSchema.oneOf[0].required.includes("summary"));

  const doctor = spawnSync("node", ["src/cli.js", "schema", "get", "doctor"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(doctor.status, 0);
  const doctorSchema = JSON.parse(doctor.stdout);
  assert.equal(doctorSchema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(doctorSchema.oneOf[0].properties.protocolVersion.const, "agentshell.doctor.v1");
  assert.ok(doctorSchema.oneOf[0].required.includes("activeRun"));
  assert.equal(doctorSchema.$defs.activeRun.additionalProperties, false);
  assert.ok(doctorSchema.$defs.check.properties.name.enum.includes("active-run"));

  const read = spawnSync("node", ["src/cli.js", "schema", "get", "read"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(read.status, 0);
  const readSchema = JSON.parse(read.stdout);
  assert.equal(readSchema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(readSchema.oneOf[0].properties.protocolVersion.const, "agentshell.read.v1");

  const understand = spawnSync("node", ["src/cli.js", "schema", "get", "understand"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(understand.status, 0);
  const understandSchema = JSON.parse(understand.stdout);
  assert.equal(understandSchema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(understandSchema.oneOf[0].properties.protocolVersion.const, "agentshell.understand.v1");
  assert.equal(understandSchema.oneOf[1].properties.compact.const, true);
  assert.ok(understandSchema.oneOf[1].required.includes("nextAction"));

  const diagnose = spawnSync("node", ["src/cli.js", "schema", "get", "diagnose"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(diagnose.status, 0);
  const diagnoseSchema = JSON.parse(diagnose.stdout);
  assert.equal(diagnoseSchema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(diagnoseSchema.oneOf[0].properties.protocolVersion.const, "agentshell.diagnose.v1");
  assert.equal(diagnoseSchema.oneOf[0].properties.verification.properties.protocolVersion.const, "agentshell.verify.v1");

  const common = spawnSync("node", ["src/cli.js", "schema", "get", "common"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(common.status, 0);
  const commonSchema = JSON.parse(common.stdout);
  assert.ok(commonSchema.$defs.protocolVersion);
  assert.ok(commonSchema.$defs.profile);
  assert.equal(commonSchema.$defs.profile.properties.phases.items.additionalProperties, false);
  assert.ok(commonSchema.$defs.errorCode.enum.includes("HASH_MISMATCH"));
  assert.ok(commonSchema.$defs.unsupportedReason.enum.includes("unsupported-pattern"));
  assert.ok(commonSchema.$defs.unsupportedResult);

  const run = spawnSync("node", ["src/cli.js", "schema", "get", "run"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(run.status, 0);
  const runSchema = JSON.parse(run.stdout);
  assert.equal(runSchema.properties.protocolVersion.const, "agentshell.run-status.v1");
  assert.ok(runSchema.required.includes("protocolVersion"));
  assert.ok(runSchema.required.includes("compact"));
  assert.equal(runSchema.$defs.run.additionalProperties, false);
  assert.equal(runSchema.$defs.summary.additionalProperties, false);
  assert.equal(runSchema.$defs.commandStat.additionalProperties, false);

  const runNext = spawnSync("node", ["src/cli.js", "schema", "get", "run-next"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(runNext.status, 0);
  const runNextSchema = JSON.parse(runNext.stdout);
  assert.equal(runNextSchema.oneOf[0].properties.protocolVersion.const, "agentshell.run-next.v1");

  const runClear = spawnSync("node", ["src/cli.js", "schema", "get", "run-clear"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(runClear.status, 0);
  const runClearSchema = JSON.parse(runClear.stdout);
  assert.equal(runClearSchema.oneOf[0].properties.protocolVersion.const, "agentshell.run-clear.v1");

  const benchmark = spawnSync("node", ["src/cli.js", "schema", "get", "benchmark"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(benchmark.status, 0);
  const benchmarkSchema = JSON.parse(benchmark.stdout);
  assert.equal(benchmarkSchema.oneOf[0].properties.protocolVersion.const, "agentshell.benchmark.v1");
  assert.ok(benchmarkSchema.oneOf[0].required.includes("protocolVersion"));
  assert.equal(benchmarkSchema.$defs.measurement.additionalProperties, false);
  assert.equal(benchmarkSchema.$defs.agentshellMeasurement.additionalProperties, false);

  const coldStart = spawnSync("node", ["src/cli.js", "schema", "get", "cold-start-benchmark"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(coldStart.status, 0);
  const coldStartSchema = JSON.parse(coldStart.stdout);
  assert.equal(coldStartSchema.properties.protocolVersion.const, "agentshell.cold-start-benchmark.v1");
  assert.equal(coldStartSchema.$defs.command.additionalProperties, false);
  assert.ok(coldStartSchema.$defs.command.properties.id.enum.includes("plugin-validate-compact"));

  const metrics = spawnSync("node", ["src/cli.js", "schema", "get", "metrics"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(metrics.status, 0);
  const metricsSchema = JSON.parse(metrics.stdout);
  assert.equal(metricsSchema.properties.protocolVersion.const, "agentshell.metrics.v2");
  assert.equal(metricsSchema.properties.dashboard.$ref, "#/$defs/dashboard");
  assert.ok(metricsSchema.required.includes("protocolVersion"));
  assert.deepEqual(metricsSchema.properties.byCommand.propertyNames, { type: "string", minLength: 1 });
  assert.equal(metricsSchema.$defs.event.additionalProperties, false);
  assert.equal(metricsSchema.$defs.latestRun.additionalProperties, false);
  assert.ok(metricsSchema.$defs.latestRun.required.includes("runId"));

  const pluginStatus = spawnSync("node", ["src/cli.js", "schema", "get", "plugin-status"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(pluginStatus.status, 0);
  const pluginStatusSchema = JSON.parse(pluginStatus.stdout);
  assert.equal(pluginStatusSchema.oneOf[0].properties.protocolVersion.enum[0], "agentshell.plugin-status.v1");
  assert.equal(pluginStatusSchema.oneOf[0].properties.summary.additionalProperties, false);
  assert.deepEqual(pluginStatusSchema.oneOf[0].properties.plugin.required, [
    "name",
    "version",
    "authorName",
    "developerName"
  ]);
  assert.equal(pluginStatusSchema.oneOf[1].properties.compact.const, true);
  assert.ok(pluginStatusSchema.oneOf[1].properties.plugin.properties.developerName);

  const pluginReleaseLocal = spawnSync("node", ["src/cli.js", "schema", "get", "plugin-release-local"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(pluginReleaseLocal.status, 0);
  const pluginReleaseLocalSchema = JSON.parse(pluginReleaseLocal.stdout);
  assert.equal(pluginReleaseLocalSchema.title, "AgentShell Plugin Release Local Report");
  assert.equal(pluginReleaseLocalSchema.oneOf[0].properties.protocolVersion.const, "agentshell.plugin-release-local.v1");
  assert.equal(pluginReleaseLocalSchema.oneOf[1].properties.compact.const, true);
  assert.equal(pluginReleaseLocalSchema.$defs.compactStep.additionalProperties, false);

  const pluginValidate = spawnSync("node", ["src/cli.js", "schema", "get", "plugin-validate"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(pluginValidate.status, 0);
  const pluginValidateSchema = JSON.parse(pluginValidate.stdout);
  assert.equal(pluginValidateSchema.title, "AgentShell Plugin Validate Response");
  assert.equal(pluginValidateSchema.oneOf[0].properties.protocolVersion.const, "agentshell.plugin-validate.v1");
  assert.equal(pluginValidateSchema.oneOf[1].properties.compact.const, true);
  assert.equal(pluginValidateSchema.$defs.pluginStatusSummary.properties.protocolVersion.const, "agentshell.plugin-status.v1");

  const pluginSmoke = spawnSync("node", ["src/cli.js", "schema", "get", "plugin-smoke"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(pluginSmoke.status, 0);
  const pluginSmokeSchema = JSON.parse(pluginSmoke.stdout);
  assert.equal(pluginSmokeSchema.title, "AgentShell Plugin Smoke Report");
  assert.equal(pluginSmokeSchema.oneOf[0].properties.protocolVersion.const, "agentshell.plugin-smoke.v1");
  assert.equal(pluginSmokeSchema.oneOf[0].properties.summary.$ref, "#/$defs/summary");
  assert.equal(pluginSmokeSchema.$defs.check.additionalProperties, false);
});

test("new schema contracts expose policy and evaluation report shapes", () => {
  const fix = spawnSync("node", ["src/cli.js", "schema", "get", "fix"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(fix.status, 0);
  const fixSchema = JSON.parse(fix.stdout);
  assert.deepEqual(fixSchema.properties.policy.enum, ["fast", "safe"]);

  const benchmarkSuite = spawnSync("node", ["src/cli.js", "schema", "get", "benchmark-suite"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(benchmarkSuite.status, 0);
  const benchmarkSuiteSchema = JSON.parse(benchmarkSuite.stdout);
  assert.equal(benchmarkSuiteSchema.title, "AgentShell Benchmark Suite Report");
  assert.deepEqual(benchmarkSuiteSchema.properties.cases.propertyNames, {
    type: "string",
    pattern: "^[a-z0-9][a-z0-9-]*$"
  });
  assert.equal(benchmarkSuiteSchema.$defs.row.additionalProperties, false);
  assert.deepEqual(benchmarkSuiteSchema.$defs.row.properties.name.enum, ["raw", "split", "fix"]);

  const realProjectEval = spawnSync("node", ["src/cli.js", "schema", "get", "real-project-eval"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(realProjectEval.status, 0);
  const realProjectEvalSchema = JSON.parse(realProjectEval.stdout);
  assert.equal(realProjectEvalSchema.title, "AgentShell Real Project Eval Report");
  assert.ok(realProjectEvalSchema.required.includes("mode"));
  assert.deepEqual(realProjectEvalSchema.properties.mode.enum, ["full", "fix-first"]);
  assert.ok(realProjectEvalSchema.required.includes("concurrency"));
  assert.ok(realProjectEvalSchema.required.includes("armConcurrency"));
  assert.equal(realProjectEvalSchema.properties.concurrency.minimum, 1);
  assert.equal(realProjectEvalSchema.properties.armConcurrency.minimum, 1);
  assert.equal(realProjectEvalSchema.$defs.project.additionalProperties, false);
  assert.ok(realProjectEvalSchema.$defs.project.properties.effectiveArmConcurrency);
  assert.ok(realProjectEvalSchema.$defs.project.properties.skippedArms);
  assert.ok(realProjectEvalSchema.$defs.project.properties.classification);
  assert.ok(realProjectEvalSchema.$defs.skippedArm);
  assert.ok(realProjectEvalSchema.$defs.summary.properties.skippedArms);
  assert.ok(realProjectEvalSchema.$defs.summary.properties.failureClasses);
  assert.ok(realProjectEvalSchema.$defs.summary.properties.unsupported);
  assert.ok(realProjectEvalSchema.$defs.summary.properties.evaluation);
  assert.ok(realProjectEvalSchema.$defs.evaluation.properties.safety.enum.includes("checked"));
  assert.ok(realProjectEvalSchema.$defs.evaluation.properties.generalization.enum.includes("covered"));
  assert.equal(realProjectEvalSchema.$defs.summary.properties.arms.additionalProperties, false);
  assert.deepEqual(Object.keys(realProjectEvalSchema.$defs.summary.properties.arms.properties).sort(), [
    "fix",
    "raw",
    "split"
  ]);
  assert.equal(
    realProjectEvalSchema.$defs.artifactSummary.properties.projects.items.properties.artifacts.additionalProperties,
    false
  );
  assert.ok(realProjectEvalSchema.$defs.project.properties.allowedStrategies.items.enum.includes("fix"));
});

function writePluginManifest(root, version, metadata = {}) {
  const authorName = metadata.authorName || "Alvin";
  const developerName = metadata.developerName || "AgentShell Labs";
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: "agentshell",
    version,
    author: {
      name: authorName
    },
    interface: {
      developerName
    },
    skills: "./skills/"
  }, null, 2)}\n`);
}

function writePluginValidateFixture(root, version) {
  writePluginManifest(root, version, {
    authorName: "Alvin",
    developerName: "AgentShell Labs"
  });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "agentshell",
    version: "0.24.0",
    type: "module",
    scripts: {
      "plugin:validate": "node src/cli.js plugin validate --compact",
      "plugin:validate:source": "node src/cli.js plugin validate --source-only --compact",
      "plugin:smoke": "node scripts/plugin-smoke.js",
      "plugin:release-local": "node scripts/plugin-release-local.js",
      "strategy:coverage": "node scripts/strategy-coverage-matrix.js"
    }
  }, null, 2)}\n`);
  for (const file of [
    "scripts/plugin-smoke.js",
    "scripts/plugin-release-local.js",
    "scripts/install-codex-plugin.js",
    "scripts/strategy-coverage-matrix.js",
    "skills/agentshell/SKILL.md",
    "schemas/plugin-status.schema.json",
    "schemas/plugin-release-local.schema.json",
    "schemas/plugin-smoke.schema.json",
    "schemas/strategy-coverage-matrix.schema.json"
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "placeholder\n");
  }
  const validateSchema = path.join(root, "schemas", "plugin-validate.schema.json");
  fs.writeFileSync(validateSchema, `${JSON.stringify({
    oneOf: [
      { properties: { protocolVersion: { const: "agentshell.plugin-validate.v1" } } },
      { properties: { protocolVersion: { const: "agentshell.plugin-validate.v1" } } }
    ]
  })}\n`);
  const schemaCommand = path.join(root, "src", "commands", "schema.js");
  fs.mkdirSync(path.dirname(schemaCommand), { recursive: true });
  fs.writeFileSync(
    schemaCommand,
    'const SCHEMAS = ["plugin-status", "plugin-validate", "plugin-release-local", "plugin-smoke", "strategy-coverage-matrix"];\n'
  );
  writeMinimalStrategyCoverageFixture(root);
  for (const doc of [
    "docs/protocol.md",
    "docs/protocol-versioning.md",
    "docs/codex-plugin-flow.md",
    "docs/release-notes-v0.25.md"
  ]) {
    const target = path.join(root, doc);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "agentshell.plugin-validate.v1\n");
  }
  for (const bin of ["bin/agentshell", "bin/agentshell-mcp"]) {
    const target = path.join(root, bin);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/usr/bin/env node\n");
    fs.chmodSync(target, 0o755);
  }
}

function writeMinimalStrategyCoverageFixture(root) {
  const changeSuggestSchema = path.join(root, "schemas", "change-suggest.schema.json");
  fs.mkdirSync(path.dirname(changeSuggestSchema), { recursive: true });
  fs.writeFileSync(changeSuggestSchema, `${JSON.stringify({
    properties: {
      strategy: {
        enum: ["missing-object-property", "unknown"]
      }
    }
  }, null, 2)}\n`);

  const matrixSchema = path.join(root, "schemas", "strategy-coverage-matrix.schema.json");
  fs.writeFileSync(matrixSchema, `${JSON.stringify({
    $defs: {
      strategy: {
        enum: ["missing-object-property"]
      }
    }
  }, null, 2)}\n`);

  const unitTest = path.join(root, "tests", "change-suggest.test.js");
  fs.mkdirSync(path.dirname(unitTest), { recursive: true });
  fs.writeFileSync(unitTest, "missing-object-property\n");

  const readme = path.join(root, "README.md");
  fs.writeFileSync(readme, "missing-object-property\n");

  const skill = path.join(root, "skills", "agentshell", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "missing-object-property\n");

  const manual = path.join(root, "src", "commands", "manual.js");
  fs.writeFileSync(manual, "missing-object-property\n");

  const docs = path.join(root, "docs", "strategy.md");
  fs.mkdirSync(path.dirname(docs), { recursive: true });
  fs.writeFileSync(docs, "missing-object-property\n");

  const benchmark = path.join(root, "examples", "benchmark-cases", "missing-property", "README.md");
  fs.mkdirSync(path.dirname(benchmark), { recursive: true });
  fs.writeFileSync(benchmark, "missing-object-property\n");

  const realProject = path.join(root, "examples", "real-projects", "missing-property", "README.md");
  fs.mkdirSync(path.dirname(realProject), { recursive: true });
  fs.writeFileSync(realProject, "missing-object-property\n");

  const manifest = path.join(root, "examples", "real-projects.json");
  fs.writeFileSync(manifest, `${JSON.stringify({
    projects: [{
      id: "missing-property-real-project",
      repoPath: "examples/real-projects/missing-property",
      expectedFailureClass: "missing-object-property"
    }]
  }, null, 2)}\n`);
}

function writeMarketplace(home) {
  const file = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    name: "personal",
    plugins: [
      {
        name: "agentshell",
        source: {
          source: "local",
          path: "./plugins/agentshell"
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL"
        }
      }
    ]
  }, null, 2)}\n`);
}
