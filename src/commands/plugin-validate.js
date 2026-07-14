import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginStatus } from "./plugin-status.js";
import { fail } from "../core/output.js";
import { createProfile } from "../core/profile.js";
import { buildStrategyCoverageMatrix } from "../../scripts/strategy-coverage-matrix.js";

export const PLUGIN_VALIDATE_PROTOCOL_VERSION = "agentshell.plugin-validate.v1";

export async function pluginValidate(root, options = {}) {
  const profile = options.profile ? createProfile() : null;
  const resolvedRoot = path.resolve(root);
  const checkedAt = new Date().toISOString();
  const checks = [];
  const sourceOnly = options.sourceOnly === true;
  const home = path.resolve(options.home || os.homedir());
  const marketplace = path.resolve(options.marketplace || path.join(home, ".agents", "plugins", "marketplace.json"));
  const cacheRoot = path.resolve(options.cacheRoot || path.join(home, ".codex", "plugins", "cache", "personal", "agentshell"));
  const paths = {
    root: resolvedRoot,
    manifest: path.join(resolvedRoot, ".codex-plugin", "plugin.json"),
    packageJson: path.join(resolvedRoot, "package.json"),
    marketplace,
    cacheRoot
  };

  const { manifest, packageJson } = profile ? profile.measureSync("source-json", () => ({
    manifest: readJsonCheck(checks, "source plugin manifest is readable", paths.manifest),
    packageJson: readJsonCheck(checks, "package.json is readable", paths.packageJson)
  })) : {
    manifest: readJsonCheck(checks, "source plugin manifest is readable", paths.manifest),
    packageJson: readJsonCheck(checks, "package.json is readable", paths.packageJson)
  };
  const plugin = {
    name: manifest?.name || null,
    version: manifest?.version || null,
    authorName: authorNameFromManifest(manifest),
    developerName: stringOrNull(manifest?.interface?.developerName)
  };
  paths.cachePath = plugin.version ? path.join(cacheRoot, plugin.version) : null;

  addCheck(checks, {
    name: "plugin manifest identity is complete",
    category: "source",
    ok: Boolean(plugin.name && plugin.version && plugin.authorName && plugin.developerName),
    details: plugin,
    suggestedNextActions: [
      "Fill `.codex-plugin/plugin.json` name, version, author.name, and interface.developerName.",
      "Run `npm run plugin:cachebust` after changing plugin metadata."
    ]
  });

  addCheck(checks, {
    name: "package exposes plugin validation scripts",
    category: "source",
    ok: packageJson?.scripts?.["plugin:validate"] === "node src/cli.js plugin validate --compact"
      && packageJson?.scripts?.["plugin:validate:source"] === "node src/cli.js plugin validate --source-only --compact"
      && packageJson?.scripts?.["plugin:smoke"] === "node scripts/plugin-smoke.js"
      && packageJson?.scripts?.["plugin:release-local"] === "node scripts/plugin-release-local.js"
      && packageJson?.scripts?.["strategy:coverage"] === "node scripts/strategy-coverage-matrix.js",
    details: {
      validate: packageJson?.scripts?.["plugin:validate"],
      validateSource: packageJson?.scripts?.["plugin:validate:source"],
      smoke: packageJson?.scripts?.["plugin:smoke"],
      releaseLocal: packageJson?.scripts?.["plugin:release-local"],
      strategyCoverage: packageJson?.scripts?.["strategy:coverage"]
    },
    suggestedNextActions: [
      "Restore the plugin validation, smoke, and release-local npm scripts."
    ]
  });

  maybeMeasureSync(profile, "source-files", () => {
    for (const file of [
      "bin/agentshell",
      "bin/agentshell-mcp",
      "scripts/plugin-smoke.js",
      "scripts/plugin-release-local.js",
      "scripts/install-codex-plugin.js",
      "scripts/strategy-coverage-matrix.js",
      "skills/agentshell/SKILL.md",
      "schemas/plugin-status.schema.json",
      "schemas/plugin-release-local.schema.json",
      "schemas/plugin-smoke.schema.json",
      "schemas/plugin-validate.schema.json",
      "schemas/strategy-coverage-matrix.schema.json"
    ]) {
      addFileCheck(checks, resolvedRoot, file);
    }

    for (const file of ["bin/agentshell", "bin/agentshell-mcp"]) {
      addExecutableCheck(checks, resolvedRoot, file);
    }
  });

  maybeMeasureSync(profile, "schema-checks", () => addSchemaRegistryChecks(checks, resolvedRoot));
  maybeMeasureSync(profile, "strategy-coverage", () => addStrategyCoverageChecks(checks, resolvedRoot));
  maybeMeasureSync(profile, "docs-checks", () => addDocumentationChecks(checks, resolvedRoot));

  let statusResult = null;
  if (!sourceOnly) {
    statusResult = profile ? profile.measureSync("plugin-status", () => pluginStatus(resolvedRoot, {
      home,
      marketplace,
      cacheRoot
    })) : pluginStatus(resolvedRoot, {
      home,
      marketplace,
      cacheRoot
    });
    addCheck(checks, {
      name: "installed plugin status is ready",
      category: "installed",
      ok: statusResult.ok,
      details: {
        status: statusResult.ok ? "ready" : "blocked",
        summary: statusResult.summary,
        cachePath: statusResult.paths?.cachePath || null
      },
      suggestedNextActions: statusResult.suggestedNextActions?.length
        ? statusResult.suggestedNextActions
        : ["Run `npm run plugin:release-local` after source validation passes."]
    });
    maybeMeasureSync(profile, "installed-payload", () => addInstalledPayloadChecks(checks, statusResult.paths?.cachePath));
  }

  const summary = profile
    ? profile.measureSync("summarize", () => summarizeChecks(checks))
    : summarizeChecks(checks);
  const result = {
    ok: summary.failed === 0,
    protocolVersion: PLUGIN_VALIDATE_PROTOCOL_VERSION,
    compact: options.compact === true ? true : undefined,
    mode: sourceOnly ? "source-only" : "installed",
    checkedAt,
    status: compactStatus(summary),
    plugin,
    paths,
    summary,
    checks,
    pluginStatus: statusResult ? {
      ok: statusResult.ok,
      protocolVersion: statusResult.protocolVersion,
      summary: statusResult.summary,
      cachePath: statusResult.paths?.cachePath || null
    } : null,
    nextAction: compactNextAction(checks),
    suggestedNextActions: collectSuggestedNextActions(checks)
  };

  if (options.compact) {
    const compactResult = {
      ok: result.ok,
      protocolVersion: result.protocolVersion,
      compact: true,
      mode: result.mode,
      checkedAt: result.checkedAt,
      status: result.status,
      plugin: result.plugin,
      summary: result.summary,
      cachePath: result.paths.cachePath,
      pluginStatus: result.pluginStatus,
      nextAction: result.nextAction,
      suggestedNextActions: result.suggestedNextActions
    };
    if (profile) compactResult.profile = profile.report({
      note: "Measured inside the already-started Node.js process. Full cold-start wall time is measured by benchmark:cold-start."
    });
    return compactResult;
  }

  delete result.compact;
  if (profile) result.profile = profile.report({
    note: "Measured inside the already-started Node.js process. Full cold-start wall time is measured by benchmark:cold-start."
  });
  return result;
}

export function parsePluginValidateOptions(argv) {
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
    if (arg === "--source-only") {
      options.sourceOnly = true;
      continue;
    }
    if (arg === "--profile") {
      options.profile = true;
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown plugin validate argument: ${arg}`);
  }
  return { ok: true, value: options };
}

function maybeMeasureSync(profile, name, fn) {
  if (profile) return profile.measureSync(name, fn);
  return fn();
}

function addSchemaRegistryChecks(checks, root) {
  const schemaCommand = path.join(root, "src", "commands", "schema.js");
  const source = readText(schemaCommand);
  addCheck(checks, {
    name: "schema registry exposes plugin validation contracts",
    category: "schema",
    ok: Boolean(
      source
        && source.includes('"plugin-status"')
        && source.includes('"plugin-release-local"')
        && source.includes('"plugin-smoke"')
        && source.includes('"plugin-validate"')
        && source.includes('"strategy-coverage-matrix"')
    ),
    details: { file: schemaCommand },
    suggestedNextActions: [
      "Add `plugin-validate` and self-maintenance schemas to `src/commands/schema.js` and keep plugin schemas registered together."
    ]
  });

  const schema = readJson(path.join(root, "schemas", "plugin-validate.schema.json"));
  addCheck(checks, {
    name: "plugin validate schema exposes protocol",
    category: "schema",
    ok: schema?.oneOf?.[0]?.properties?.protocolVersion?.const === PLUGIN_VALIDATE_PROTOCOL_VERSION
      && schema?.oneOf?.[1]?.properties?.protocolVersion?.const === PLUGIN_VALIDATE_PROTOCOL_VERSION,
    details: {
      protocolVersion: schema?.oneOf?.[0]?.properties?.protocolVersion?.const || null
    },
    suggestedNextActions: [
      "Update `schemas/plugin-validate.schema.json` to expose `agentshell.plugin-validate.v1`."
    ]
  });
}

function addStrategyCoverageChecks(checks, root) {
  let matrix = null;
  try {
    matrix = buildStrategyCoverageMatrix(root);
  } catch (error) {
    addCheck(checks, {
      name: "strategy coverage matrix is readable",
      category: "strategy",
      ok: false,
      error: error.message,
      details: { script: "scripts/strategy-coverage-matrix.js" },
      suggestedNextActions: [
        "Run `node scripts/strategy-coverage-matrix.js` and fix the matrix generator or schema enum."
      ]
    });
    return;
  }

  const missing = matrix.summary?.missing || {};
  addCheck(checks, {
    name: "all change-suggest strategies have unit tests",
    category: "strategy",
    ok: (missing.unitTests || []).length === 0,
    details: {
      totalStrategies: matrix.summary?.totalStrategies || 0,
      missing: missing.unitTests || []
    },
    suggestedNextActions: [
      "Add focused tests in `tests/change-suggest.test.js` for strategies missing unit-test coverage."
    ]
  });
  addCheck(checks, {
    name: "all change-suggest strategies are documented",
    category: "strategy",
    ok: (missing.docs || []).length === 0,
    details: {
      totalStrategies: matrix.summary?.totalStrategies || 0,
      missing: missing.docs || []
    },
    suggestedNextActions: [
      "Update README/docs/skill/manual text for strategies missing documentation coverage."
    ]
  });
  addCheck(checks, {
    name: "change-suggest benchmark coverage is tracked",
    category: "strategy",
    severity: "warning",
    ok: (missing.benchmarkCases || []).length === 0,
    details: {
      covered: matrix.summary?.covered?.benchmarkCases || 0,
      totalStrategies: matrix.summary?.totalStrategies || 0,
      missing: missing.benchmarkCases || []
    },
    suggestedNextActions: [
      "Add benchmark cases for missing strategies when they become priority repair paths."
    ]
  });
  addCheck(checks, {
    name: "change-suggest real-project fixture coverage is tracked",
    category: "strategy",
    severity: "warning",
    ok: (missing.realProjectFixtures || []).length === 0,
    details: {
      covered: matrix.summary?.covered?.realProjectFixtures || 0,
      totalStrategies: matrix.summary?.totalStrategies || 0,
      missing: missing.realProjectFixtures || []
    },
    suggestedNextActions: [
      "Add real-project fixtures for missing strategies when evaluating broader strategy generalization."
    ]
  });
}

function addDocumentationChecks(checks, root) {
  const protocol = readText(path.join(root, "docs", "protocol.md"));
  const versioning = readText(path.join(root, "docs", "protocol-versioning.md"));
  const flow = readText(path.join(root, "docs", "codex-plugin-flow.md"));
  const notes = readText(path.join(root, "docs", "release-notes-v0.25.md"));
  addCheck(checks, {
    name: "docs mention plugin validate protocol",
    category: "docs",
    ok: [protocol, versioning, flow, notes].every((text) => text?.includes(PLUGIN_VALIDATE_PROTOCOL_VERSION)),
    details: {
      protocol: Boolean(protocol?.includes(PLUGIN_VALIDATE_PROTOCOL_VERSION)),
      versioning: Boolean(versioning?.includes(PLUGIN_VALIDATE_PROTOCOL_VERSION)),
      flow: Boolean(flow?.includes(PLUGIN_VALIDATE_PROTOCOL_VERSION)),
      releaseNotes: Boolean(notes?.includes(PLUGIN_VALIDATE_PROTOCOL_VERSION))
    },
    suggestedNextActions: [
      "Update protocol docs, plugin flow docs, and release notes with `agentshell.plugin-validate.v1`."
    ]
  });
}

function addInstalledPayloadChecks(checks, cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) {
    addCheck(checks, {
      name: "installed plugin cache is inspectable",
      category: "installed",
      ok: false,
      details: { cachePath: cachePath || null },
      suggestedNextActions: [
        "Run `npm run plugin:release-local` to install and smoke-test the current plugin."
      ]
    });
    return;
  }

  const excluded = [".agentshell", ".git", "artifacts", "node_modules"];
  const present = excluded.filter((name) => fs.existsSync(path.join(cachePath, name)));
  addCheck(checks, {
    name: "installed plugin cache excludes runtime state",
    category: "installed",
    ok: present.length === 0,
    details: { cachePath, excluded, present },
    suggestedNextActions: [
      "Update `scripts/install-codex-plugin.js` so generated runtime state is excluded from plugin installs."
    ]
  });

  for (const file of ["bin/agentshell", "bin/agentshell-mcp"]) {
    addExecutableCheck(checks, cachePath, file, "installed");
  }
}

function addFileCheck(checks, root, file) {
  const target = path.join(root, file);
  addCheck(checks, {
    name: `${file} exists`,
    category: "source",
    ok: fs.existsSync(target),
    details: { path: target },
    suggestedNextActions: [
      `Restore \`${file}\` before publishing the plugin.`
    ]
  });
}

function addExecutableCheck(checks, root, file, category = "source") {
  const target = path.join(root, file);
  let mode = null;
  try {
    mode = fs.statSync(target).mode;
  } catch {
    // The paired existence check reports the missing file.
  }
  addCheck(checks, {
    name: `${category} ${file} is executable`,
    category,
    ok: typeof mode === "number" && (mode & 0o111) !== 0,
    details: { path: target },
    suggestedNextActions: [
      `Restore executable permissions for \`${file}\`.`
    ]
  });
}

function readJsonCheck(checks, name, file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    addCheck(checks, {
      name,
      category: "source",
      ok: false,
      error: error.message,
      details: { path: file },
      suggestedNextActions: [
        `Restore or fix \`${path.relative(process.cwd(), file)}\`.`
      ]
    });
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function addCheck(checks, check) {
  checks.push({
    severity: "error",
    ...check,
    suggestedNextActions: check.ok ? [] : check.suggestedNextActions
  });
}

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((entry) => entry.ok).length,
    failed: checks.filter((entry) => !entry.ok && entry.severity === "error").length,
    warnings: checks.filter((entry) => !entry.ok && entry.severity === "warning").length
  };
}

function compactStatus(summary) {
  if (summary.failed > 0) return "blocked";
  if (summary.warnings > 0) return "warning";
  return "ready";
}

function compactNextAction(checks) {
  const check = checks.find((entry) => !entry.ok && entry.suggestedNextActions?.length);
  if (!check) return null;
  const action = check.suggestedNextActions[0];
  const match = action.match(/`([^`]+)`/);
  return {
    command: match?.[1] || null,
    reason: check.name,
    text: action
  };
}

function collectSuggestedNextActions(checks) {
  return [...new Set(checks.flatMap((check) => check.ok ? [] : check.suggestedNextActions || []))];
}

function authorNameFromManifest(manifest) {
  if (typeof manifest?.author === "string") return stringOrNull(manifest.author);
  return stringOrNull(manifest?.author?.name);
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
