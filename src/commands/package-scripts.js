import path from "node:path";

import { fail } from "../core/output.js";
import { detectPackageManager } from "../core/package-json.js";
import { findUp, readJson } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.package-scripts.v1";
const DEFAULT_COMPACT_LIMIT = 20;

const CATEGORY_RULES = [
  ["typecheck", /(^|[-_:])(typecheck|type-check|types|tsc)($|[-_:])/i],
  ["test", /(^|[-_:])(test|spec|unit|integration|e2e)($|[-_:])/i],
  ["build", /(^|[-_:])(build|compile|bundle|pack)($|[-_:])/i],
  ["lint", /(^|[-_:])(lint|eslint|stylelint)($|[-_:])/i],
  ["format", /(^|[-_:])(format|fmt|prettier)($|[-_:])/i],
  ["dev", /(^|[-_:])(dev|start|serve|watch|preview)($|[-_:])/i]
];

const COMMAND_CATEGORY_RULES = [
  ["typecheck", /\b(tsc|vue-tsc|svelte-check|tsgo)\b/i],
  ["test", /\b(jest|vitest|mocha|ava|node\s+--test|playwright|cypress)\b/i],
  ["build", /\b(vite|webpack|rollup|esbuild|tsup|next|nuxt|astro)\s+build\b|\bnpm\s+run\s+build\b/i],
  ["lint", /\b(eslint|stylelint|biome\s+lint|oxlint)\b/i],
  ["format", /\b(prettier|biome\s+format|dprint)\b/i],
  ["dev", /\b(vite|next|nuxt|astro|webpack-dev-server)\s+(dev|start|serve)|\b(nodemon|tsx\s+watch)\b/i]
];

const LONG_RUNNING_NAME = /(^|[-_:])(dev|start|serve|watch|preview)($|[-_:])/i;
const LONG_RUNNING_COMMAND = /\b(--watch|watch|dev|serve|preview|nodemon|webpack-dev-server)\b/i;
const RISKY_NAME = /(^|[-_:])(deploy|release|publish|clean|reset|remove|delete|destroy|migrate|seed|prune)($|[-_:])/i;
const RISKY_COMMAND = /\b(rm\s+-rf|rimraf|del-cli|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|changeset\s+publish|vercel\s+deploy|firebase\s+deploy|terraform\s+(apply|destroy)|prisma\s+migrate|knex\s+migrate)\b/i;

export async function packageScripts(root, options = {}) {
  const packagePath = findUp(root, ["package.json"]);
  if (!packagePath) {
    return fail("PACKAGE_JSON_NOT_FOUND", "No package.json found from the current directory", {
      root: path.resolve(root)
    }, [{
      command: "agentshell tree --compact",
      reason: "Inspect the project structure and locate the supported manifest"
    }]);
  }

  const packageRoot = path.dirname(packagePath);
  const manifest = readJson(packagePath);
  const rawScripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const allScripts = Object.entries(rawScripts)
    .filter(([, command]) => typeof command === "string")
    .sort(([left], [right]) => categoryPriority(scriptCategory(left, rawScripts[left])) - categoryPriority(scriptCategory(right, rawScripts[right])) || left.localeCompare(right))
    .map(([name, command]) => scriptSummary(name, command));
  const limit = options.compact === true ? DEFAULT_COMPACT_LIMIT : allScripts.length;
  const scripts = allScripts.slice(0, limit);

  const summary = summarize(allScripts, scripts);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === true,
    packageManager: detectPackageManager(packageRoot),
    package: {
      name: manifest.name || path.basename(packageRoot),
      version: manifest.version || null,
      private: manifest.private === true,
      path: packagePath
    },
    summary,
    scripts,
    suggestedNextActions: suggestedNextActions(summary, scripts)
  };
}

function scriptSummary(name, command) {
  const category = scriptCategory(name, command);
  return {
    name,
    command,
    category,
    risky: RISKY_NAME.test(name) || RISKY_COMMAND.test(command),
    longRunning: LONG_RUNNING_NAME.test(name) || LONG_RUNNING_COMMAND.test(command)
  };
}

function scriptCategory(name, command) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(name)) return category;
  }
  for (const [category, pattern] of COMMAND_CATEGORY_RULES) {
    if (pattern.test(command)) return category;
  }
  return "other";
}

function summarize(allScripts, scripts) {
  return {
    totalScripts: allScripts.length,
    returnedScripts: scripts.length,
    truncated: scripts.length < allScripts.length,
    hasTest: allScripts.some((script) => script.category === "test"),
    hasBuild: allScripts.some((script) => script.category === "build"),
    hasLint: allScripts.some((script) => script.category === "lint"),
    hasTypecheck: allScripts.some((script) => script.category === "typecheck"),
    hasDev: allScripts.some((script) => script.category === "dev"),
    hasFormat: allScripts.some((script) => script.category === "format"),
    riskyCount: allScripts.filter((script) => script.risky).length,
    longRunningCount: allScripts.filter((script) => script.longRunning).length
  };
}

function suggestedNextActions(summary, scripts) {
  const actions = [];
  if (summary.hasTest) {
    actions.push({
      command: "agentshell verify test --compact",
      reason: "Run the detected test script with compact AgentShell output"
    });
  }
  if (summary.hasTypecheck) {
    const typecheck = scripts.find((script) => script.category === "typecheck");
    actions.push({
      command: `npm run ${typecheck.name}`,
      reason: "Validate static type errors before broader verification; use raw npm until AgentShell adds script execution"
    });
  }
  if (summary.hasBuild) {
    const build = scripts.find((script) => script.category === "build");
    actions.push({
      command: `npm run ${build.name}`,
      reason: "Check whether the project still builds; use raw npm until AgentShell adds script execution"
    });
  }
  if (summary.truncated) {
    actions.push({
      command: "agentshell package scripts",
      reason: "Compact output was truncated; request the full script list only if needed"
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell tree --compact",
      reason: "No common package scripts were detected; inspect project layout next"
    });
  }
  return actions;
}

function categoryPriority(category) {
  return {
    test: 0,
    typecheck: 1,
    lint: 2,
    build: 3,
    dev: 4,
    format: 5,
    other: 6
  }[category] ?? 6;
}
