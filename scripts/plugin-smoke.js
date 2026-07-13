#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const PLUGIN_SMOKE_PROTOCOL_VERSION = "agentshell.plugin-smoke.v1";
const PLUGIN_VALIDATE_PROTOCOL_VERSION = "agentshell.plugin-validate.v1";
const MANUAL_TOPICS = ["repair", "plugin", "benchmark", "profile", "onboarding", "log-triage", "reference"];
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(formatHelp(args.format));
  process.exit(0);
}

const installedPath = path.resolve(args.path || defaultInstalledPath());
const smokeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-smoke-"));
const checks = [];

check("installed path exists", () => {
  assert(fs.existsSync(installedPath), `Missing installed path: ${installedPath}`);
});

check("installed plugin manifest identity is stable", () => {
  const manifest = readJson(path.join(installedPath, ".codex-plugin", "plugin.json"));
  assert(manifest.author?.name === "Alvin", `installed manifest author.name ${manifest.author?.name} !== Alvin`);
  assert(manifest.interface?.developerName === "Alvin", `installed manifest interface.developerName ${manifest.interface?.developerName} !== Alvin`);
});

check("release payload excludes runtime state", () => {
  for (const name of [".agentshell", ".git", "artifacts", "node_modules"]) {
    assert(!fs.existsSync(path.join(installedPath, name)), `installed plugin includes ${name}`);
  }
});

check("bin/agentshell manual version matches package version", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  const manual = runAgentShell(["manual"]);
  const fullManual = runAgentShell(["manual", "--full"]);
  const repairManual = runAgentShell(["manual", "--topic", "repair"]);
  assert(manual.status === 0, `agentshell manual failed: ${manual.output}`);
  assert(fullManual.status === 0, `agentshell manual --full failed: ${fullManual.output}`);
  assert(repairManual.status === 0, `agentshell manual --topic repair failed: ${repairManual.output}`);
  const output = parseJson(manual.output, "manual output");
  const fullOutput = parseJson(fullManual.output, "manual --full output");
  const repairOutput = parseJson(repairManual.output, "manual --topic repair output");
  assert(output.protocolVersion === "agentshell.manual.v1", "manual output does not expose protocolVersion");
  assert(output.version === packageJson.version, `manual version ${output.version} !== package version ${packageJson.version}`);
  assert(output.compact === true, "manual default is not compact");
  assert(output.firstPass?.command === "agentshell start --compact", "manual compact first pass is not start --compact");
  assert(output.topics?.some((entry) => entry.command === "agentshell manual --topic repair"), "manual compact does not expose repair topic");
  assert(output.full === "agentshell manual --full", "manual compact does not point to --full");
  assert(!Object.hasOwn(output, "commandMap"), "manual compact still exposes full commandMap");
  assert(fullOutput.compact === false, "manual --full is not marked non-compact");
  assert(
    fullOutput.commandMap?.some((entry) => entry.command === "agentshell doctor"),
    "manual --full does not expose doctor"
  );
  assert(
    fullOutput.commandMap?.some((entry) => entry.command === "agentshell fix test [--fast|--safe|--dry-run] [--compact] [--profile]"),
    "manual --full does not expose fix policy modes"
  );
  assert(repairOutput.topic === "repair", "manual --topic repair did not return repair topic");
  assert(
    repairOutput.workflow?.includes("agentshell fix test --fast --compact"),
    "manual --topic repair does not expose fast compact fix"
  );
});

check("package exposes cache benchmark script", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  assert(packageJson.scripts?.["benchmark:cache"] === "node scripts/cache-benchmark.js", "package.json does not expose benchmark:cache");
  assert(packageJson.scripts?.["benchmark:cold-start"] === "node scripts/cold-start-benchmark.js", "package.json does not expose benchmark:cold-start");
  assert(fs.existsSync(path.join(installedPath, "scripts", "cache-benchmark.js")), "scripts/cache-benchmark.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "cold-start-benchmark.js")), "scripts/cold-start-benchmark.js is missing");
});

check("package exposes real-project candidate importer", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  assert(packageJson.scripts?.["eval:real-project-candidates"] === "node scripts/real-project-candidates.js", "package.json does not expose eval:real-project-candidates");
  assert(fs.existsSync(path.join(installedPath, "scripts", "real-project-candidates.js")), "scripts/real-project-candidates.js is missing");
});

check("package exposes adapter package scripts", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  assert(packageJson.scripts?.["adapter:package:claude"] === "node scripts/adapter-generate.js --package claude", "package.json does not expose adapter:package:claude");
  assert(packageJson.scripts?.["adapter:package:cursor"] === "node scripts/adapter-generate.js --package cursor", "package.json does not expose adapter:package:cursor");
  const source = fs.readFileSync(path.join(installedPath, "scripts", "adapter-generate.js"), "utf8");
  assert(source.includes("--package <claude|cursor> <out-dir>"), "adapter generator does not expose package mode usage");
});

check("package exposes adapter trial scoring", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  assert(packageJson.scripts?.["adapter:trial"] === "node scripts/adapter-trial.js", "package.json does not expose adapter:trial");
  assert(packageJson.scripts?.["adapter:trial:collect"] === "node scripts/adapter-trial-collect.js", "package.json does not expose adapter:trial:collect");
  assert(packageJson.scripts?.["adapter:trial:suite"] === "node scripts/adapter-trial-suite.js", "package.json does not expose adapter:trial:suite");
  assert(fs.existsSync(path.join(installedPath, "scripts", "adapter-trial.js")), "scripts/adapter-trial.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "adapter-trial-collect.js")), "scripts/adapter-trial-collect.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "adapter-trial-suite.js")), "scripts/adapter-trial-suite.js is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "adapter-trial.schema.json")), "schemas/adapter-trial.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "adapter-trial-collect.schema.json")), "schemas/adapter-trial-collect.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "adapter-trial-suite.schema.json")), "schemas/adapter-trial-suite.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "docs", "adapters", "trial-runs.md")), "docs/adapters/trial-runs.md is missing");
  assert(fs.existsSync(path.join(installedPath, "docs", "adapters", "trial-collector.md")), "docs/adapters/trial-collector.md is missing");
  assert(fs.existsSync(path.join(installedPath, "docs", "adapters", "trial-suite.md")), "docs/adapters/trial-suite.md is missing");
  assert(fs.existsSync(path.join(installedPath, "examples", "adapter-trial.sample.json")), "examples/adapter-trial.sample.json is missing");
  assert(fs.existsSync(path.join(installedPath, "examples", "adapter-trial-collect.sample.json")), "examples/adapter-trial-collect.sample.json is missing");
  assert(fs.existsSync(path.join(installedPath, "examples", "adapter-trial-suite.sample.json")), "examples/adapter-trial-suite.sample.json is missing");
});

check("package exposes core evidence gate protocols", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  assert(packageJson.scripts?.["codex:plugin:trial"] === "node scripts/codex-plugin-trial.js", "package.json does not expose codex:plugin:trial");
  assert(packageJson.scripts?.["codex:plugin:collect"] === "node scripts/codex-plugin-trial-collect.js", "package.json does not expose codex:plugin:collect");
  assert(packageJson.scripts?.["codex:plugin:template"] === "node scripts/codex-plugin-trial-template.js", "package.json does not expose codex:plugin:template");
  assert(packageJson.scripts?.["codex:plugin:plan"] === "node scripts/codex-plugin-trial-plan.js", "package.json does not expose codex:plugin:plan");
  assert(packageJson.scripts?.["codex:plugin:suite"] === "node scripts/codex-plugin-trial-suite.js", "package.json does not expose codex:plugin:suite");
  assert(packageJson.scripts?.["strategy:intake"] === "node scripts/strategy-intake.js", "package.json does not expose strategy:intake");
  assert(fs.existsSync(path.join(installedPath, "scripts", "codex-plugin-trial.js")), "scripts/codex-plugin-trial.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "codex-plugin-trial-collect.js")), "scripts/codex-plugin-trial-collect.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "codex-plugin-trial-template.js")), "scripts/codex-plugin-trial-template.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "codex-plugin-trial-plan.js")), "scripts/codex-plugin-trial-plan.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "codex-plugin-trial-suite.js")), "scripts/codex-plugin-trial-suite.js is missing");
  assert(fs.existsSync(path.join(installedPath, "scripts", "strategy-intake.js")), "scripts/strategy-intake.js is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "codex-plugin-trial.schema.json")), "schemas/codex-plugin-trial.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "codex-plugin-trial-template.schema.json")), "schemas/codex-plugin-trial-template.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "codex-plugin-trial-plan.schema.json")), "schemas/codex-plugin-trial-plan.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "codex-plugin-trial-suite.schema.json")), "schemas/codex-plugin-trial-suite.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "strategy-intake.schema.json")), "schemas/strategy-intake.schema.json is missing");
  assert(fs.existsSync(path.join(installedPath, "examples", "codex-plugin-effect.sample.json")), "examples/codex-plugin-effect.sample.json is missing");
  assert(fs.existsSync(path.join(installedPath, "examples", "codex-plugin-new-thread.sample.json")), "examples/codex-plugin-new-thread.sample.json is missing");
  assert(fs.existsSync(path.join(installedPath, "examples", "codex-plugin-suite.sample.json")), "examples/codex-plugin-suite.sample.json is missing");
  assert(fs.existsSync(path.join(installedPath, "examples", "strategy-intake.sample.json")), "examples/strategy-intake.sample.json is missing");
});

check("package exposes strategy coverage matrix", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  assert(packageJson.scripts?.["strategy:coverage"] === "node scripts/strategy-coverage-matrix.js", "package.json does not expose strategy:coverage");
  assert(fs.existsSync(path.join(installedPath, "scripts", "strategy-coverage-matrix.js")), "scripts/strategy-coverage-matrix.js is missing");
  assert(fs.existsSync(path.join(installedPath, "schemas", "strategy-coverage-matrix.schema.json")), "schemas/strategy-coverage-matrix.schema.json is missing");
});

check("package exposes MCP stdio entrypoint", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  assert(packageJson.bin?.["agentshell-mcp"] === "./bin/agentshell-mcp", "package.json does not expose agentshell-mcp bin");
  assert(fs.existsSync(path.join(installedPath, "bin", "agentshell-mcp")), "bin/agentshell-mcp is missing");
  assert(fs.existsSync(path.join(installedPath, "src", "mcp", "server.js")), "src/mcp/server.js is missing");
  const initialize = runAgentShellMcp({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {}
  });
  assert(initialize.status === 0, `agentshell-mcp initialize failed: ${initialize.output}`);
  const output = parseJson(initialize.output, "MCP initialize output");
  assert(output.result?.serverInfo?.name === "agentshell-mcp", "MCP initialize did not return serverInfo");
});

check("schema get change-suggest has tightened preview", () => {
  const result = runAgentShell(["schema", "get", "change-suggest"]);
  assert(result.status === 0, `schema get failed: ${result.output}`);
  const schema = parseJson(result.output, "change-suggest schema");
  const preview = schema.properties?.preview;
  const range = preview?.properties?.range;
  assert(schema.required?.includes("preview"), "top-level required does not include preview");
  assert(preview?.additionalProperties === false, "preview allows additional properties");
  assert(arrayEquals(preview?.required, ["file", "range", "fill"]), "preview required fields are not file/range/fill");
  assert(range?.additionalProperties === false, "preview.range allows additional properties");
  assert(arrayEquals(range?.required, ["start", "end"]), "preview.range required fields are not start/end");
  assert(schema.properties?.strategy?.enum?.includes("deep-equal-array-elements"), "change-suggest schema does not expose array element strategy");
  assert(schema.properties?.strategy?.enum?.includes("deep-equal-array-removal"), "change-suggest schema does not expose array removal strategy");
  assert(schema.properties?.strategy?.enum?.includes("deep-equal-extra-property-removal"), "change-suggest schema does not expose extra property removal strategy");
  assert(schema.properties?.strategy?.enum?.includes("deep-equal-array-primitive-replacement"), "change-suggest schema does not expose array primitive replacement strategy");
  assert(schema.properties?.strategy?.enum?.includes("array-length"), "change-suggest schema does not expose array length strategy");
  assert(schema.properties?.strategy?.enum?.includes("join-separator-literal"), "change-suggest schema does not expose join separator strategy");
  assert(schema.properties?.strategy?.enum?.includes("string-case-transform"), "change-suggest schema does not expose string case transform strategy");
  assert(schema.$defs?.appliedChange?.additionalProperties === false, "change-suggest appliedChange schema is not tightened");
});

check("schema get strategy-coverage-matrix exposes self-maintenance protocol", () => {
  const result = runAgentShell(["schema", "get", "strategy-coverage-matrix"]);
  assert(result.status === 0, `schema get strategy-coverage-matrix failed: ${result.output}`);
  const schema = parseJson(result.output, "strategy coverage matrix schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.strategy-coverage-matrix.v1", "strategy coverage matrix schema does not expose protocolVersion");
  assert(schema.$defs?.strategy?.enum?.includes("deep-equal-extra-property-removal"), "strategy coverage schema does not expose extra property removal");
  assert(schema.$defs?.strategy?.enum?.includes("deep-equal-array-primitive-replacement"), "strategy coverage schema does not expose array primitive replacement");
});

check("schema get strategy-intake exposes sample triage protocol", () => {
  const result = runAgentShell(["schema", "get", "strategy-intake"]);
  assert(result.status === 0, `schema get strategy-intake failed: ${result.output}`);
  const schema = parseJson(result.output, "strategy intake schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.strategy-intake.v1", "strategy-intake schema does not expose protocolVersion");
  assert(schema.$defs?.failureClass?.enum?.includes("import-path"), "strategy-intake schema does not expose import-path failure class");
  assert(schema.$defs?.priority?.enum?.includes("needs-reproduction"), "strategy-intake schema does not expose needs-reproduction priority");
  assert(schema.$defs?.sample?.additionalProperties === false, "strategy-intake sample schema is not closed");
});

check("schema get codex-plugin-trial exposes plugin effect protocol", () => {
  const result = runAgentShell(["schema", "get", "codex-plugin-trial"]);
  assert(result.status === 0, `schema get codex-plugin-trial failed: ${result.output}`);
  const schema = parseJson(result.output, "codex plugin trial schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.codex-plugin-trial.v1", "codex-plugin-trial schema does not expose protocolVersion");
  assert(schema.properties?.purpose, "codex-plugin-trial schema does not expose purpose");
  assert(schema.properties?.recommendation, "codex-plugin-trial schema does not expose recommendation");
  assert(schema.$defs?.metrics?.properties?.agentShellCommandCount, "codex-plugin-trial schema does not expose AgentShell command count metric");
});

check("schema get dashboard exposes local read-only UI protocol", () => {
  const result = runAgentShell(["schema", "get", "dashboard"]);
  assert(result.status === 0, `schema get dashboard failed: ${result.output}`);
  const schema = parseJson(result.output, "dashboard schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.dashboard.v1", "dashboard schema does not expose protocolVersion");
  assert(schema.properties?.host?.const === "127.0.0.1", "dashboard schema does not lock the loopback host");
  assert(schema.properties?.readOnly?.const === true, "dashboard schema does not declare read-only mode");
  assert(schema.properties?.surface?.enum?.includes("desktop-window"), "dashboard schema does not expose native desktop surface");
});

check("installed plugin bundles the native macOS dashboard app", () => {
  if (process.platform !== "darwin") return;
  const executable = path.join(installedPath, "desktop", "macos", "dist", "AgentShell Dashboard.app", "Contents", "MacOS", "AgentShellDashboard");
  assert(fs.existsSync(executable), "native dashboard executable is missing");
  assert((fs.statSync(executable).mode & 0o111) !== 0, "native dashboard executable is not executable");
});

check("schema get trial-export exposes redacted beta evidence protocol", () => {
  const result = runAgentShell(["schema", "get", "trial-export"]);
  assert(result.status === 0, `schema get trial-export failed: ${result.output}`);
  const schema = parseJson(result.output, "trial export schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.trial-export.v1", "trial-export schema does not expose protocolVersion");
  assert(schema.properties?.privacy?.properties?.redacted?.const === true, "trial-export schema does not require redaction");
});

check("schema get codex-plugin-trial-template exposes capture form protocol", () => {
  const result = runAgentShell(["schema", "get", "codex-plugin-trial-template"]);
  assert(result.status === 0, `schema get codex-plugin-trial-template failed: ${result.output}`);
  const schema = parseJson(result.output, "codex plugin trial template schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.codex-plugin-trial-template.v1", "codex-plugin-trial-template schema does not expose protocolVersion");
  assert(schema.properties?.jsonTemplate?.$ref === "#/$defs/runLogTemplate", "codex-plugin-trial-template schema does not expose jsonTemplate");
  assert(schema.$defs?.runLogTemplate?.properties?.host?.const === "codex", "codex-plugin-trial-template schema does not lock host to codex");
  assert(schema.$defs?.event?.properties?.durationMs?.minimum === 0, "codex-plugin-trial-template schema does not expose non-negative duration");
});

check("schema get codex-plugin-trial-plan exposes multi-run planning protocol", () => {
  const result = runAgentShell(["schema", "get", "codex-plugin-trial-plan"]);
  assert(result.status === 0, `schema get codex-plugin-trial-plan failed: ${result.output}`);
  const schema = parseJson(result.output, "codex plugin trial plan schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.codex-plugin-trial-plan.v1", "codex-plugin-trial-plan schema does not expose protocolVersion");
  assert(schema.properties?.suiteManifest?.$ref === "#/$defs/suiteManifest", "codex-plugin-trial-plan schema does not expose suiteManifest");
  assert(schema.properties?.runCount?.maximum === 10, "codex-plugin-trial-plan schema does not bound runCount");
  assert(schema.$defs?.run?.required?.includes("jsonPath"), "codex-plugin-trial-plan schema does not expose run jsonPath");
});

check("schema get codex-plugin-trial-suite exposes real-run aggregate protocol", () => {
  const result = runAgentShell(["schema", "get", "codex-plugin-trial-suite"]);
  assert(result.status === 0, `schema get codex-plugin-trial-suite failed: ${result.output}`);
  const schema = parseJson(result.output, "codex plugin trial suite schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.codex-plugin-trial-suite.v1", "codex-plugin-trial-suite schema does not expose protocolVersion");
  assert(schema.properties?.summary?.$ref === "#/$defs/summary", "codex-plugin-trial-suite schema does not expose summary");
  assert(schema.$defs?.summary?.properties?.strongRate?.maximum === 100, "codex-plugin-trial-suite schema does not expose bounded strongRate");
  assert(schema.$defs?.trialResult?.properties?.host?.const === "codex", "codex-plugin-trial-suite schema does not lock host to codex");
});

check("schema get verify exposes cache fields", () => {
  const result = runAgentShell(["schema", "get", "verify"]);
  assert(result.status === 0, `schema get verify failed: ${result.output}`);
  const schema = parseJson(result.output, "verify schema");
  const success = schema.oneOf?.[0];
  assert(success?.properties?.protocolVersion?.const === "agentshell.verify.v1", "verify schema does not expose protocolVersion");
  assert(success?.properties?.cacheHit?.type === "boolean", "verify schema does not expose cacheHit");
  assert(success?.properties?.cacheKey?.type === "string", "verify schema does not expose cacheKey");
  assert(success?.properties?.verificationMode?.enum?.includes("related-test-file"), "verify schema does not expose related-test-file mode");
  assert(success?.properties?.relatedTestFileVerification, "verify schema does not expose relatedTestFileVerification");
});

check("schema get plugin-release-local exposes release protocol", () => {
  const result = runAgentShell(["schema", "get", "plugin-release-local"]);
  assert(result.status === 0, `schema get plugin-release-local failed: ${result.output}`);
  const schema = parseJson(result.output, "plugin-release-local schema");
  assert(schema.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.plugin-release-local.v1", "plugin-release-local schema does not expose protocolVersion");
  assert(schema.oneOf?.[1]?.properties?.compact?.const === true, "plugin-release-local schema does not expose compact report shape");
  assert(schema.oneOf?.[0]?.required?.includes("plugin"), "plugin-release-local full report does not require plugin summary");
  assert(schema.oneOf?.[1]?.required?.includes("plugin"), "plugin-release-local compact report does not require plugin summary");
  assert(schema.$defs?.pluginSummary?.required?.includes("authorName"), "plugin-release-local plugin summary does not require authorName");
  assert(schema.$defs?.pluginSummary?.required?.includes("developerName"), "plugin-release-local plugin summary does not require developerName");
  assert(schema.$defs?.compactStep?.additionalProperties === false, "plugin-release-local compact step schema is not tightened");
});

check("schema get plugin-smoke exposes smoke protocol", () => {
  const result = runAgentShell(["schema", "get", "plugin-smoke"]);
  assert(result.status === 0, `schema get plugin-smoke failed: ${result.output}`);
  const schema = parseJson(result.output, "plugin-smoke schema");
  assert(schema.oneOf?.[0]?.properties?.protocolVersion?.const === PLUGIN_SMOKE_PROTOCOL_VERSION, "plugin-smoke schema does not expose protocolVersion");
  assert(schema.oneOf?.[0]?.required?.includes("installedPath"), "plugin-smoke schema does not require installedPath");
  assert(schema.oneOf?.[0]?.properties?.summary?.$ref === "#/$defs/summary", "plugin-smoke schema does not expose summary");
  assert(schema.$defs?.check?.additionalProperties === false, "plugin-smoke check schema is not tightened");
});

check("schema get manual exposes compact topic and full variants", () => {
  const result = runAgentShell(["schema", "get", "manual"]);
  assert(result.status === 0, `schema get manual failed: ${result.output}`);
  const schema = parseJson(result.output, "manual schema");
  assert(schema.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.manual.v1", "manual schema does not expose protocolVersion");
  assert(schema.oneOf?.[0]?.properties?.compact?.const === true, "manual schema does not expose compact default variant");
  assert(schema.oneOf?.[1]?.properties?.topic?.enum?.includes("repair"), "manual schema does not expose repair topic");
  assert(schema.oneOf?.[2]?.properties?.compact?.const === false, "manual schema does not expose full variant");
});

check("schema get cold-start-benchmark exposes performance protocol", () => {
  const result = runAgentShell(["schema", "get", "cold-start-benchmark"]);
  assert(result.status === 0, `schema get cold-start-benchmark failed: ${result.output}`);
  const schema = parseJson(result.output, "cold-start-benchmark schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.cold-start-benchmark.v1", "cold-start benchmark schema does not expose protocolVersion");
  assert(schema.$defs?.command?.properties?.id?.enum?.includes("plugin-validate-compact"), "cold-start benchmark schema does not expose plugin validate row");
  assert(schema.$defs?.commandSummary?.properties?.averageProcessOverheadMs, "cold-start benchmark schema does not expose process overhead");
});

check("schema get plugin-validate exposes validation protocol", () => {
  const result = runAgentShell(["schema", "get", "plugin-validate"]);
  assert(result.status === 0, `schema get plugin-validate failed: ${result.output}`);
  const schema = parseJson(result.output, "plugin-validate schema");
  assert(schema.oneOf?.[0]?.properties?.protocolVersion?.const === PLUGIN_VALIDATE_PROTOCOL_VERSION, "plugin-validate full schema does not expose protocolVersion");
  assert(schema.oneOf?.[1]?.properties?.protocolVersion?.const === PLUGIN_VALIDATE_PROTOCOL_VERSION, "plugin-validate compact schema does not expose protocolVersion");
  assert(schema.oneOf?.[1]?.properties?.compact?.const === true, "plugin-validate schema does not expose compact shape");
  assert(schema.$defs?.pluginStatusSummary?.properties?.protocolVersion?.const === "agentshell.plugin-status.v1", "plugin-validate schema does not expose embedded plugin-status protocol");
});

check("installed plugin status contract exposes developer metadata", () => {
  const manifest = readJson(path.join(installedPath, ".codex-plugin", "plugin.json"));
  const schemaResult = runAgentShell(["schema", "get", "plugin-status"]);
  assert(schemaResult.status === 0, `schema get plugin-status failed: ${schemaResult.output}`);
  const schema = parseJson(schemaResult.output, "plugin-status schema");
  const fullPlugin = schema.oneOf?.[0]?.properties?.plugin;
  const compactPlugin = schema.oneOf?.[1]?.properties?.plugin;
  assert(schema.oneOf?.[0]?.properties?.protocolVersion?.enum?.includes("agentshell.plugin-status.v1"), "plugin-status schema does not expose protocolVersion");
  assert(fullPlugin?.required?.includes("authorName"), "plugin-status schema full plugin does not require authorName");
  assert(fullPlugin?.required?.includes("developerName"), "plugin-status schema full plugin does not require developerName");
  assert(fullPlugin?.properties?.authorName?.type?.includes("string"), "plugin-status schema full plugin does not expose authorName");
  assert(fullPlugin?.properties?.developerName?.type?.includes("string"), "plugin-status schema full plugin does not expose developerName");
  assert(compactPlugin?.required?.includes("authorName"), "plugin-status schema compact plugin does not require authorName");
  assert(compactPlugin?.required?.includes("developerName"), "plugin-status schema compact plugin does not require developerName");
  assert(compactPlugin?.properties?.authorName?.type?.includes("string"), "plugin-status schema compact plugin does not expose authorName");
  assert(compactPlugin?.properties?.developerName?.type?.includes("string"), "plugin-status schema compact plugin does not expose developerName");

  const statusEnv = preparePluginStatusFixture(manifest);
  const statusResult = runAgentShellFrom([
    "plugin",
    "status",
    "--compact",
    "--marketplace",
    statusEnv.marketplace,
    "--cache-root",
    statusEnv.cacheRoot
  ], statusEnv.sourceRoot);
  assert(statusResult.status === 0, `installed plugin status failed: ${statusResult.output}`);
  const status = parseJson(statusResult.output, "plugin status output");
  assert(status.protocolVersion === "agentshell.plugin-status.v1", "plugin status output does not expose protocolVersion");
  assert(status.plugin?.authorName === "Alvin", `plugin status authorName ${status.plugin?.authorName} !== Alvin`);
  assert(status.plugin?.developerName === "Alvin", `plugin status developerName ${status.plugin?.developerName} !== Alvin`);
});

check("installed package exposes primary protocol versions", () => {
  const doctor = runAgentShell(["doctor"]);
  assert(doctor.status === 0, `doctor failed: ${doctor.output}`);
  const doctorOutput = parseJson(doctor.output, "doctor output");
  assert(doctorOutput.protocolVersion === "agentshell.doctor.v1", "doctor output does not expose protocolVersion");
  assert(doctorOutput.state?.writable === true, "doctor did not confirm writable state");

  const doctorSchemaResult = runAgentShell(["schema", "get", "doctor"]);
  assert(doctorSchemaResult.status === 0, `schema get doctor failed: ${doctorSchemaResult.output}`);
  const doctorSchema = parseJson(doctorSchemaResult.output, "doctor schema");
  assert(doctorSchema.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.doctor.v1", "doctor schema does not expose protocolVersion");

  const read = runAgentShell(["schema", "get", "read"]);
  assert(read.status === 0, `schema get read failed: ${read.output}`);
  const readSchema = parseJson(read.output, "read schema");
  assert(readSchema.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.read.v1", "read schema does not expose protocolVersion");

  const runNext = runAgentShell(["schema", "get", "run-next"]);
  assert(runNext.status === 0, `schema get run-next failed: ${runNext.output}`);
  const runNextSchema = parseJson(runNext.output, "run-next schema");
  assert(runNextSchema.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.run-next.v1", "run-next schema does not expose protocolVersion");

  const runClear = runAgentShell(["schema", "get", "run-clear"]);
  assert(runClear.status === 0, `schema get run-clear failed: ${runClear.output}`);
  const runClearSchema = parseJson(runClear.output, "run-clear schema");
  assert(runClearSchema.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.run-clear.v1", "run-clear schema does not expose protocolVersion");

  const runStatus = runAgentShell(["schema", "get", "run"]);
  assert(runStatus.status === 0, `schema get run failed: ${runStatus.output}`);
  const runStatusSchema = parseJson(runStatus.output, "run schema");
  assert(runStatusSchema.properties?.protocolVersion?.const === "agentshell.run-status.v1", "run schema does not expose run-status protocolVersion");

  const benchmark = runAgentShell(["schema", "get", "benchmark"]);
  assert(benchmark.status === 0, `schema get benchmark failed: ${benchmark.output}`);
  const benchmarkSchema = parseJson(benchmark.output, "benchmark schema");
  assert(benchmarkSchema.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.benchmark.v1", "benchmark schema does not expose protocolVersion");

  const metrics = runAgentShell(["schema", "get", "metrics"]);
  assert(metrics.status === 0, `schema get metrics failed: ${metrics.output}`);
  const metricsSchema = parseJson(metrics.output, "metrics schema");
  assert(metricsSchema.properties?.protocolVersion?.const === "agentshell.metrics.v2", "metrics schema does not expose protocolVersion");
  assert(metricsSchema.properties?.dashboard?.$ref === "#/$defs/dashboard", "metrics schema does not expose dashboard metrics");

  const findSource = fs.readFileSync(path.join(installedPath, "src", "commands", "find.js"), "utf8");
  const understandSource = fs.readFileSync(path.join(installedPath, "src", "commands", "understand.js"), "utf8");
  assert(findSource.includes("agentshell.find.v1"), "find command does not expose protocolVersion");
  assert(understandSource.includes("agentshell.understand.v1"), "understand command does not expose protocolVersion");
});

check("installed package exposes lower-use runtime protocol versions", () => {
  const history = runAgentShell(["history"]);
  assert(history.status === 0, `history failed: ${history.output}`);
  const historyOutput = parseJson(history.output, "history output");
  assert(historyOutput.protocolVersion === "agentshell.history.v1", "history output does not expose protocolVersion");

  const schemaList = runAgentShell(["schema", "list"]);
  assert(schemaList.status === 0, `schema list failed: ${schemaList.output}`);
  const schemaListOutput = parseJson(schemaList.output, "schema list output");
  assert(schemaListOutput.protocolVersion === "agentshell.schema-list.v1", "schema list output does not expose protocolVersion");

  const schemaGet = runAgentShell(["schema", "get", "verify"]);
  assert(schemaGet.status === 0, `schema get verify failed: ${schemaGet.output}`);
  const schemaGetOutput = parseJson(schemaGet.output, "schema get output");
  assert(schemaGetOutput.protocolVersion === "agentshell.schema-get.v1", "schema get output does not expose protocolVersion");
  assert(schemaGetOutput.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.verify.v1", "schema get verify lost verify protocolVersion");

  const logRef = "log_plugin_smoke";
  fs.mkdirSync(path.join(smokeWorkspace, ".agentshell", "logs"), { recursive: true });
  fs.writeFileSync(path.join(smokeWorkspace, ".agentshell", "logs", `${logRef}.stdout.log`), "plugin smoke stdout\n");
  fs.writeFileSync(path.join(smokeWorkspace, ".agentshell", "logs", `${logRef}.stderr.log`), "plugin smoke stderr\n");
  const log = runAgentShell(["log", "get", logRef, "--tail", "2"]);
  assert(log.status === 0, `log get failed: ${log.output}`);
  const logOutput = parseJson(log.output, "log output");
  assert(logOutput.protocolVersion === "agentshell.log.v1", "log output does not expose protocolVersion");
});

check("schema get diagnose exposes compact protocol refs", () => {
  const result = runAgentShell(["schema", "get", "diagnose"]);
  assert(result.status === 0, `schema get diagnose failed: ${result.output}`);
  const schema = parseJson(result.output, "diagnose schema");
  const success = schema.oneOf?.[0];
  const verification = success?.properties?.verification;
  const readRef = schema.$defs?.readRef;
  assert(success?.properties?.protocolVersion?.const === "agentshell.diagnose.v1", "diagnose schema does not expose protocolVersion");
  assert(verification?.properties?.protocolVersion?.const === "agentshell.verify.v1", "diagnose verification schema does not expose verify protocolVersion");
  assert(readRef?.properties?.content?.type === "string", "diagnose read ref schema does not allow verbose content");
  assert(success?.properties?.implementationReads?.items?.$ref === "#/$defs/readRef", "diagnose implementationReads does not use compact read refs");
});

check("schema get real-project-eval exposes arm summaries", () => {
  const result = runAgentShell(["schema", "get", "real-project-eval"]);
  assert(result.status === 0, `schema get real-project-eval failed: ${result.output}`);
  const schema = parseJson(result.output, "real-project-eval schema");
  assert(schema.required?.includes("runs"), "real-project-eval schema does not require top-level runs");
  assert(schema.required?.includes("mode"), "real-project-eval schema does not require top-level mode");
  assert(schema.properties?.mode?.enum?.includes("fix-first"), "real-project-eval schema does not expose fix-first mode");
  assert(schema.required?.includes("concurrency"), "real-project-eval schema does not require top-level concurrency");
  assert(schema.required?.includes("armConcurrency"), "real-project-eval schema does not require top-level armConcurrency");
  assert(schema.properties?.runs?.minimum === 1, "real-project-eval schema does not expose positive run count");
  assert(schema.properties?.concurrency?.minimum === 1, "real-project-eval schema does not expose positive concurrency");
  assert(schema.properties?.armConcurrency?.minimum === 1, "real-project-eval schema does not expose positive armConcurrency");
  assert(schema.$defs?.project?.properties?.arms, "real-project-eval schema does not expose project arms");
  assert(schema.$defs?.project?.properties?.effectiveArmConcurrency, "real-project-eval schema does not expose effective arm concurrency");
  assert(schema.$defs?.project?.properties?.skippedArms, "real-project-eval schema does not expose skipped arms");
  assert(schema.$defs?.project?.properties?.classification, "real-project-eval schema does not expose project classification");
  assert(schema.$defs?.summary?.properties?.skippedArms, "real-project-eval schema does not expose summary skipped arms");
  assert(schema.$defs?.summary?.properties?.arms, "real-project-eval schema does not expose summary arms");
  assert(schema.$defs?.summary?.properties?.failureClasses, "real-project-eval schema does not expose failure class summary");
  assert(schema.$defs?.summary?.properties?.unsupported, "real-project-eval schema does not expose unsupported summary");
  assert(schema.$defs?.summary?.properties?.evaluation, "real-project-eval schema does not expose evaluation summary");
  assert(schema.$defs?.evaluation?.properties?.safety?.enum?.includes("checked"), "real-project-eval schema does not expose checked safety bucket");
  assert(schema.$defs?.evaluation?.properties?.generalization?.enum?.includes("covered"), "real-project-eval schema does not expose covered generalization bucket");
  assert(schema.$defs?.classification?.properties?.unsupportedReasons, "real-project-eval schema does not expose unsupported reasons");
  assert(schema.$defs?.arm?.properties?.runResults, "real-project-eval schema does not expose per-arm run results");
  assert(schema.$defs?.armSummary?.properties?.successRuns, "real-project-eval schema does not expose summary successRuns");
  assert(schema.$defs?.artifactSummary, "real-project-eval schema does not expose summary artifact contract");
  assert(schema.$defs?.artifactArm, "real-project-eval schema does not expose arm artifact contract");
});

check("schema get real-project-candidates exposes manifest drafts", () => {
  const result = runAgentShell(["schema", "get", "real-project-candidates"]);
  assert(result.status === 0, `schema get real-project-candidates failed: ${result.output}`);
  const schema = parseJson(result.output, "real-project-candidates schema");
  assert(schema.properties?.protocolVersion?.const === "agentshell.real-project-candidates.v1", "candidate schema does not expose protocolVersion");
  assert(schema.properties?.manifestDraft, "candidate schema does not expose manifestDraft");
  assert(schema.$defs?.project?.properties?.nodeEngine?.type?.includes("string"), "candidate schema does not expose nodeEngine");
  assert(schema.$defs?.project?.properties?.dependencySummary?.$ref === "#/$defs/dependencySummary", "candidate schema does not expose dependencySummary");
  assert(schema.$defs?.project?.properties?.workspaceSummary?.$ref === "#/$defs/workspaceSummary", "candidate schema does not expose workspaceSummary");
  assert(schema.$defs?.manifestProject?.properties?.allowedStrategies?.items?.enum?.includes("fix"), "candidate manifest draft does not expose fix strategy");
});

check("skill text includes PATH fallback", () => {
  const skill = fs.readFileSync(path.join(installedPath, "skills", "agentshell", "SKILL.md"), "utf8");
  assert(skill.includes("not on PATH"), "skill does not mention PATH fallback");
  assert(skill.includes("bin/agentshell manual"), "skill does not mention bin/agentshell manual fallback");
  assert(skill.includes("agentshell doctor"), "skill does not mention doctor readiness checks");
  assert(skill.includes("agentshell run clear"), "skill does not mention clearing stale run state");
});

check("skill text recommends compact start or entry first pass", () => {
  const skill = fs.readFileSync(path.join(installedPath, "skills", "agentshell", "SKILL.md"), "utf8");
  assert(skill.includes("agentshell start --compact"), "skill does not recommend agentshell start --compact");
  assert(skill.includes("agentshell entry --compact"), "skill does not recommend agentshell entry --compact");
  assert(
    !recommendsOldFirstPass(skill),
    "skill still recommends doctor -> understand -> fix/diagnose/verify as the first pass"
  );
});

check("agent-facing docs follow compact manual topic flow", () => {
  const files = [
    path.join("skills", "agentshell", "SKILL.md"),
    path.join("docs", "agent", "codex.md"),
    path.join("docs", "adapters", "README.md")
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(installedPath, file), "utf8");
    assertManualFlowText(file, text);
  }
});

check("docs include demo-v0.24.md", () => {
  assert(fs.existsSync(path.join(installedPath, "docs", "demo-v0.24.md")), "docs/demo-v0.24.md is missing");
});

check("docs include benchmark artifact guidance", () => {
  const docs = fs.readFileSync(path.join(installedPath, "docs", "benchmark-suite.md"), "utf8");
  assert(docs.includes("--report <path>"), "benchmark docs do not mention JSON artifact reports");
  assert(docs.includes("--markdown <path>"), "benchmark docs do not mention Markdown artifact reports");
});

check("docs include performance analysis guidance", () => {
  const performancePath = path.join(installedPath, "docs", "performance-analysis.md");
  assert(fs.existsSync(performancePath), "docs/performance-analysis.md is missing");
  const performance = fs.readFileSync(performancePath, "utf8");
  assert(performance.includes("npm run benchmark:cold-start"), "performance analysis does not mention cold-start benchmark");
  assert(performance.includes("profile.totalMs"), "performance analysis does not explain profile totals");
  assert(performance.includes("JavaScript is not the primary speed bottleneck"), "performance analysis does not state the current JS bottleneck hypothesis");
});

check("README surfaces current real-project evidence", () => {
  const readme = fs.readFileSync(path.join(installedPath, "README.md"), "utf8");
  assert(readme.includes("checked-in repair fixture suite"), "README does not surface the current checked-in repair fixture evidence");
  assert(readme.includes("51/51") && readme.includes("262"), "README does not include current repeated repair fixture evidence");
  assert(readme.includes("22,112") && readme.includes("4,459"), "README does not include current checked-in full-vs-fix-first token evidence");
  assert(readme.includes("three local healthy real-project snapshots"), "README does not preserve the healthy real-project smoke evidence");
  assert(readme.includes("9/9") && readme.includes("194"), "README does not include current repeated fix-first evidence");
  assert(!readme.includes("On two prepared real-project snapshots"), "README still references stale two-project evidence");
  assert(!readme.includes("7,369") && !readme.includes("40.3s") && !readme.includes("9.4s"), "README still references stale batch4 real-project numbers");
});

check("docs include real-project evidence", () => {
  const evidencePath = path.join(installedPath, "docs", "real-project-evidence.md");
  assert(fs.existsSync(evidencePath), "docs/real-project-evidence.md is missing");
  const evidence = fs.readFileSync(evidencePath, "utf8");
  assert(evidence.includes("18/18") && evidence.includes("51/51"), "real-project evidence does not include checked-in repair fixture success counts");
  assert(evidence.includes("79.8%"), "real-project evidence does not include checked-in fixture fix-first token reduction");
  assert(evidence.includes("96.3%"), "real-project evidence does not include batch 5 fix-first token reduction");
  assert(evidence.includes("Across all nine repeated fix-first runs"), "real-project evidence does not include batch 7 repeated-run stability");
  assert(evidence.includes("healthy project smoke runs"), "real-project evidence does not explain the healthy-project caveat");
  assert(
    evidence.includes("artifacts/") && evidence.includes("source checkout") && evidence.includes("excluded from plugin installs"),
    "real-project evidence does not explain that JSON artifacts are source-checkout only"
  );
});

check("benchmark evidence points at current real-project evidence", () => {
  const benchmarkEvidence = fs.readFileSync(path.join(installedPath, "docs", "benchmark-evidence.md"), "utf8");
  assert(benchmarkEvidence.includes("real-project-evidence.md"), "benchmark evidence does not link the current real-project evidence page");
  assert(benchmarkEvidence.includes("51/51") && benchmarkEvidence.includes("repair runs"), "benchmark evidence does not summarize current checked-in repeated repair evidence");
  assert(benchmarkEvidence.includes("22,112") && benchmarkEvidence.includes("4,459"), "benchmark evidence does not summarize current checked-in token reduction");
  assert(benchmarkEvidence.includes("9/9 runs") && benchmarkEvidence.includes("194"), "benchmark evidence does not preserve batch7 repeated stability");
  assert(benchmarkEvidence.includes("Historical Full vs Fix-First"), "benchmark evidence does not label older real-project evidence as historical");
});

check("release notes match current protocol and verification state", () => {
  const notes = fs.readFileSync(path.join(installedPath, "docs", "release-notes-v0.24.md"), "utf8");
  assert(notes.includes("Related-test-file verification"), "release notes do not mention related-test-file verification");
  assert(notes.includes("agentshell.plugin-release-local.v1"), "release notes do not mention plugin-release-local protocol");
  assert(notes.includes("agentshell.plugin-smoke.v1"), "release notes do not mention plugin-smoke protocol");
  assert(notes.includes("agentshell.plugin-validate.v1"), "release notes do not mention plugin-validate protocol");
  assert(notes.includes("agentshell.cold-start-benchmark.v1"), "release notes do not mention cold-start benchmark protocol");
  assert(notes.includes("typescript-property-suggestion"), "release notes do not mention TypeScript property suggestion strategy");
  assert(notes.includes("Batch 5 real-project evidence"), "release notes do not mention batch 5 real-project evidence");
  assert(notes.includes("96.3% reduction"), "release notes do not include current fix-first real-project token reduction");
  assert(notes.includes("Batch 7 repeats the fix-first path"), "release notes do not mention batch 7 repeated fix-first evidence");
  assert(notes.includes("All nine fix-first runs passed"), "release notes do not include batch 7 repeated-run success");
  assert(notes.includes("51/51") && notes.includes("repair runs"), "release notes do not include checked-in repeated repair evidence");
  assert(notes.includes("22,112") && notes.includes("4,459"), "release notes do not include checked-in fixture token evidence");
  assert(!notes.includes("Protocol versioning is defined for `fix`, `verify`, `diagnose`, `understand`, `find`, `read`, and `run next`, but not yet rolled across every command."), "release notes still contain stale protocol rollout limitation");
  assert(!notes.includes("Add related-test-file verification before full test commands."), "release notes still list completed related-test verification as a next step");
  assert(!notes.includes("Continue protocol versioning across remaining primary runtime commands."), "release notes still list completed primary runtime protocol rollout as a next step");
  assert(!notes.includes("Run the offline real-project evaluation manifest against pinned local repositories."), "release notes still list completed real-project evaluation run as a next step");
});

check("real project eval manifest is bundled", () => {
  const manifestPath = path.join(installedPath, "examples", "real-projects.json");
  assert(fs.existsSync(manifestPath), "examples/real-projects.json is missing");
  const manifest = readJson(manifestPath);
  assert(Array.isArray(manifest.projects) && manifest.projects.length >= 5, "real project manifest does not include sample projects");
  assert(
    manifest.projects.some((project) => project.allowedStrategies?.includes("raw")),
    "real project manifest does not include raw/split/fix strategies"
  );
  assert(
    manifest.projects.some((project) => project.id === "healthy-node-baseline" && project.skipRepairArms === true),
    "real project manifest does not include the healthy baseline fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "import-path-typo-real-project" && project.expectedFailureClass === "import-path"),
    "real project manifest does not include the import-path fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "typescript-diagnostic-real-project" && project.expectedFailureClass === "typescript-missing-property"),
    "real project manifest does not include the TypeScript diagnostic fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "typescript-property-suggestion-real-project" && project.expectedFailureClass === "typescript-property-suggestion"),
    "real project manifest does not include the TypeScript property suggestion fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "typescript-primitive-literal-real-project" && project.expectedFailureClass === "typescript-primitive-literal-mismatch"),
    "real project manifest does not include the TypeScript primitive literal fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "literal-replacement-real-project" && project.expectedFailureClass === "literal-replacement"),
    "real project manifest does not include the literal replacement fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "deep-equal-array-elements-real-project" && project.expectedFailureClass === "deep-equal-array-elements"),
    "real project manifest does not include the deep equal array elements fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "deep-equal-array-removal-real-project" && project.expectedFailureClass === "deep-equal-array-removal"),
    "real project manifest does not include the deep equal array removal fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "array-length-real-project" && project.expectedFailureClass === "array-length"),
    "real project manifest does not include the array length fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "string-case-transform-real-project" && project.expectedFailureClass === "string-case-transform"),
    "real project manifest does not include the string case transform fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "truthy-return-real-project" && project.expectedFailureClass === "truthy-return"),
    "real project manifest does not include the truthy return fixture"
  );
  assert(
    manifest.projects.some((project) => project.id === "missing-named-export-real-project" && project.expectedFailureClass === "missing-named-export"),
    "real project manifest does not include the missing named export fixture"
  );
  for (const file of [
    "package.json",
    path.join("src", "user.ts"),
    path.join("test", "typecheck.cjs")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "typescript-property-suggestion", file)),
      `TypeScript property suggestion fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "user.ts"),
    path.join("test", "typecheck.cjs")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "typescript-primitive-literal", file)),
      `TypeScript primitive literal fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "status.js"),
    path.join("test", "status.test.js")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "literal-replacement", file)),
      `literal replacement fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "tags.js"),
    path.join("test", "tags.test.js")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "deep-equal-array-elements", file)),
      `deep equal array elements fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "tags.js"),
    path.join("test", "tags.test.js")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "deep-equal-array-removal", file)),
      `deep equal array removal fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "items.js"),
    path.join("test", "items.test.js")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "array-length", file)),
      `array length fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "format.js"),
    path.join("test", "format.test.js")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "string-case-transform", file)),
      `string case transform fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "ready.js"),
    path.join("test", "ready.test.js")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "truthy-return", file)),
      `truthy return fixture is missing ${file}`
    );
  }
  for (const file of [
    "package.json",
    path.join("src", "status.js"),
    path.join("test", "status.test.js")
  ]) {
    assert(
      fs.existsSync(path.join(installedPath, "examples", "real-projects", "missing-named-export", file)),
      `missing named export fixture is missing ${file}`
    );
  }
});

check("real project eval runner supports repeated runs", () => {
  const runnerPath = path.join(installedPath, "scripts", "real-project-eval.js");
  assert(fs.existsSync(runnerPath), "scripts/real-project-eval.js is missing");
  const source = fs.readFileSync(runnerPath, "utf8");
  assert(source.includes("--runs"), "real-project-eval runner does not parse --runs");
  assert(source.includes("--mode"), "real-project-eval runner does not parse --mode");
  assert(source.includes("fix-first"), "real-project-eval runner does not expose fix-first mode");
  assert(source.includes("--concurrency"), "real-project-eval runner does not parse --concurrency");
  assert(source.includes("--arm-concurrency"), "real-project-eval runner does not parse --arm-concurrency");
  assert(source.includes("successRuns"), "real-project-eval runner does not aggregate successRuns");
  assert(source.includes("runResults"), "real-project-eval runner does not expose per-run results");
});

const report = {
  ok: checks.every((entry) => entry.ok),
  protocolVersion: PLUGIN_SMOKE_PROTOCOL_VERSION,
  installedPath,
  summary: summarizeChecks(checks),
  checks
};

console.log(formatReport(report, args.format));
if (!report.ok) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = { format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--path") {
      parsed.path = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      parsed.format = "markdown";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function formatHelp(format = "json") {
  const help = {
    ok: true,
    usage: "node scripts/plugin-smoke.js [--path <installedPath>] [--markdown]"
  };
  return format === "markdown"
    ? [
        "# Agentshell Plugin Smoke",
        "",
        `Usage: \`${help.usage}\``,
        "",
        "- Default output is compact JSON for automation.",
        "- Add `--markdown` for a readable smoke summary."
      ].join("\n")
    : JSON.stringify(help);
}

function formatReport(report, format = "json") {
  return format === "markdown"
    ? formatMarkdownReport(report)
    : formatJsonReport(report);
}

function formatJsonReport(report) {
  return JSON.stringify(report);
}

function formatMarkdownReport(report) {
  const summary = report.summary || summarizeChecks(report.checks || []);
  const lines = [
    "# Agentshell Plugin Smoke",
    "",
    `Status: ${report.ok ? "PASS" : "FAIL"}`,
    `Installed path: \`${report.installedPath}\``,
    `Checks: ${summary.passed}/${summary.total} passed`
  ];

  if (summary.failed > 0) {
    lines.push(`Failed: ${summary.failed}`);
  }

  lines.push("", "## Checks", "");

  for (const check of report.checks || []) {
    lines.push(`- ${check.ok ? "[x]" : "[ ]"} ${check.name}`);
    if (!check.ok && check.error) {
      lines.push(`  Error: ${check.error}`);
    }
  }

  return lines.join("\n");
}

function summarizeChecks(checks) {
  const total = checks.length;
  const passed = checks.filter((entry) => entry.ok).length;
  return {
    total,
    passed,
    failed: total - passed
  };
}

function defaultInstalledPath() {
  const manifest = readJson(path.join(root, ".codex-plugin", "plugin.json"));
  return path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "agentshell", manifest.version);
}

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

function runAgentShell(commandArgs) {
  return runAgentShellFrom(commandArgs, smokeWorkspace);
}

function runAgentShellFrom(commandArgs, cwd) {
  const bin = path.join(installedPath, "bin", "agentshell");
  const result = spawnSync(process.execPath, [bin, ...commandArgs], {
    cwd,
    encoding: "utf8"
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim()
  };
}

function runAgentShellMcp(message) {
  const bin = path.join(installedPath, "bin", "agentshell-mcp");
  const result = spawnSync(process.execPath, [bin], {
    cwd: smokeWorkspace,
    encoding: "utf8",
    input: `${JSON.stringify(message)}\n`
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim()
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function preparePluginStatusFixture(manifest) {
  const sourceRoot = path.join(smokeWorkspace, "plugin-status-source");
  const home = path.join(smokeWorkspace, "plugin-status-home");
  const marketplace = path.join(home, ".agents", "plugins", "marketplace.json");
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  const sourceManifest = path.join(sourceRoot, ".codex-plugin", "plugin.json");
  const cacheManifest = path.join(cacheRoot, manifest.version, ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(sourceManifest), { recursive: true });
  fs.mkdirSync(path.dirname(marketplace), { recursive: true });
  fs.mkdirSync(path.dirname(cacheManifest), { recursive: true });
  fs.writeFileSync(sourceManifest, `${JSON.stringify(manifest)}\n`);
  fs.writeFileSync(marketplace, `${JSON.stringify({
    plugins: [
      {
        name: manifest.name || "agentshell",
        source: { source: "local", path: "./plugins/agentshell" },
        policy: { installation: "AVAILABLE" }
      }
    ]
  })}\n`);
  fs.writeFileSync(cacheManifest, `${JSON.stringify(manifest)}\n`);
  return { sourceRoot, marketplace, cacheRoot };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse ${label} as JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function arrayEquals(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value, index) => actual[index] === value);
}

function recommendsOldFirstPass(text) {
  const oldPath = /doctor\s*(?:->|→)\s*understand(?:\s+--compact)?\s*(?:->|→)\s*fix\s*\/\s*diagnose\s*\/\s*verify/i;
  return oldPath.test(text);
}

function assertManualFlowText(label, text) {
  assert(text.includes("agentshell manual"), `${label} does not mention agentshell manual`);
  for (const topic of MANUAL_TOPICS) {
    assert(hasManualTopic(text, topic), `${label} does not mention agentshell manual --topic ${topic}`);
  }
  assert(text.includes("agentshell manual --full"), `${label} does not mention agentshell manual --full`);
  assert(text.includes("agentshell start --compact"), `${label} does not mention agentshell start --compact`);
  assert(
    !recommendsOldFirstPass(text),
    `${label} still recommends doctor -> understand -> fix/diagnose/verify as the first pass`
  );
}

function hasManualTopic(text, topic) {
  return text.includes(`agentshell manual --topic ${topic}`)
    || text.includes("agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference");
}
