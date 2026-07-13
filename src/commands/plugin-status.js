import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";

export const PLUGIN_STATUS_PROTOCOL_VERSION = "agentshell.plugin-status.v1";

export function pluginStatus(root, options = {}) {
  const packageRoot = resolvePackageRoot({
    packageRoot: options.packageRoot,
    root,
    homeDir: options.home,
    codexHome: options.codexHome,
    env: options.env,
    executablePath: options.executablePath,
    sourceRoot: options.sourceRoot,
    installedCandidates: options.installedCandidates
  });
  const home = path.resolve(options.home || os.homedir());
  const marketplace = path.resolve(options.marketplace || path.join(home, ".agents", "plugins", "marketplace.json"));
  const cacheRoot = path.resolve(options.cacheRoot || path.join(home, ".codex", "plugins", "cache", "personal", "agentshell"));
  const checks = [];
  const paths = {
    root: packageRoot,
    manifest: path.join(packageRoot, ".codex-plugin", "plugin.json"),
    marketplace,
    cacheRoot
  };

  const manifest = readJsonCheck(checks, "plugin manifest is readable", paths.manifest, [
    "Run `npm run plugin:cachebust` if the manifest is missing or malformed.",
    "Run `npm run plugin:validate` after updating `.codex-plugin/plugin.json`."
  ]);

  const pluginName = manifest?.name || "agentshell";
  const pluginVersion = manifest?.version;
  paths.cachePath = pluginVersion ? path.join(cacheRoot, pluginVersion) : undefined;
  paths.cacheManifest = paths.cachePath ? path.join(paths.cachePath, ".codex-plugin", "plugin.json") : undefined;

  addCheck(checks, {
    name: "plugin manifest exposes name and version",
    ok: Boolean(manifest?.name && manifest?.version),
    details: { name: manifest?.name, version: manifest?.version },
    suggestedNextActions: [
      "Ensure `.codex-plugin/plugin.json` includes non-empty `name` and `version` fields.",
      "Run `npm run plugin:cachebust` to refresh the local plugin version."
    ]
  });

  const marketplaceJson = readJsonCheck(checks, "personal marketplace is readable", marketplace, [
    "Run `npm run plugin:install-local` to create or update the personal marketplace.",
    "Check that the marketplace path points to the intended fixture or user home."
  ]);
  const marketplaceEntry = Array.isArray(marketplaceJson?.plugins)
    ? marketplaceJson.plugins.find((plugin) => plugin?.name === pluginName)
    : undefined;

  addCheck(checks, {
    name: "personal marketplace contains agentshell entry",
    ok: Boolean(marketplaceEntry),
    details: {
      expectedName: pluginName,
      pluginCount: Array.isArray(marketplaceJson?.plugins) ? marketplaceJson.plugins.length : undefined
    },
    suggestedNextActions: [
      "Run `npm run plugin:install-local` to upsert `agentshell` into the personal marketplace.",
      "Confirm the marketplace path points to the active marketplace."
    ]
  });

  addCheck(checks, {
    name: "personal marketplace entry points at local agentshell plugin",
    ok: marketplaceEntry?.source?.source === "local" && marketplaceEntry?.source?.path === "./plugins/agentshell",
    details: {
      source: marketplaceEntry?.source?.source,
      path: marketplaceEntry?.source?.path
    },
    suggestedNextActions: [
      "Run `npm run plugin:install-local` to refresh the marketplace entry.",
      "Expected marketplace source is `{ source: \"local\", path: \"./plugins/agentshell\" }`."
    ]
  });

  addWarning(checks, {
    name: "personal marketplace marks plugin available",
    ok: !marketplaceEntry || marketplaceEntry?.policy?.installation === "AVAILABLE",
    details: { installation: marketplaceEntry?.policy?.installation },
    suggestedNextActions: [
      "Set the marketplace entry policy installation to `AVAILABLE`.",
      "Run `npm run plugin:install-local` to regenerate the marketplace entry."
    ]
  });

  addCheck(checks, {
    name: "codex plugin cache has manifest version directory",
    ok: Boolean(paths.cachePath && fs.existsSync(paths.cachePath)),
    details: { cachePath: paths.cachePath },
    suggestedNextActions: [
      "Run `codex plugin add agentshell@personal` after refreshing the personal marketplace.",
      "Run `npm run plugin:release-local` for the full local release chain."
    ]
  });

  const cacheManifest = paths.cacheManifest
    ? readJsonCheck(checks, "codex plugin cache manifest is readable", paths.cacheManifest, [
        "Run `codex plugin add agentshell@personal` to rebuild the Codex plugin cache.",
        "Remove stale cache directories only after confirming the active manifest version."
      ])
    : undefined;

  const sourcePluginMetadata = pluginMetadataFromManifest(manifest);
  const cachePluginMetadata = pluginMetadataFromManifest(cacheManifest);

  addCheck(checks, {
    name: "codex plugin cache manifest matches source manifest",
    ok: Boolean(
      cacheManifest &&
        manifest &&
        cacheManifest.name === manifest.name &&
        cacheManifest.version === manifest.version &&
        cachePluginMetadata.authorName === sourcePluginMetadata.authorName &&
        cachePluginMetadata.developerName === sourcePluginMetadata.developerName
    ),
    details: {
      sourceName: manifest?.name,
      sourceVersion: manifest?.version,
      sourceAuthorName: sourcePluginMetadata.authorName,
      sourceDeveloperName: sourcePluginMetadata.developerName,
      cacheName: cacheManifest?.name,
      cacheVersion: cacheManifest?.version,
      cacheAuthorName: cachePluginMetadata.authorName,
      cacheDeveloperName: cachePluginMetadata.developerName
    },
    suggestedNextActions: [
      "Run `codex plugin add agentshell@personal` so Codex caches the current marketplace copy.",
      "Start a new Codex thread after reinstalling the plugin."
    ]
  });

  const summary = summarizeChecks(checks);
  const result = {
    ok: summary.failed === 0,
    protocolVersion: options.protocolVersion || PLUGIN_STATUS_PROTOCOL_VERSION,
    checkedAt: new Date().toISOString(),
    plugin: {
      name: manifest?.name || null,
      version: manifest?.version || null,
      authorName: sourcePluginMetadata.authorName,
      developerName: sourcePluginMetadata.developerName
    },
    paths,
    summary,
    checks,
    suggestedNextActions: collectSuggestedNextActions(checks)
  };

  if (options.compact) {
    return {
      ok: result.ok,
      protocolVersion: result.protocolVersion,
      compact: true,
      checkedAt: result.checkedAt,
      status: compactStatus(result.summary),
      plugin: result.plugin,
      summary: result.summary,
      cachePath: result.paths.cachePath || null,
      nextAction: compactNextAction(checks),
      suggestedNextActions: result.suggestedNextActions
    };
  }

  return result;
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
  return {
    command: commandFromAction(action),
    reason: check.name,
    text: action
  };
}

function commandFromAction(action) {
  const match = action.match(/`([^`]+)`/);
  return match?.[1] || null;
}

function pluginMetadataFromManifest(manifest) {
  return {
    authorName: authorNameFromManifest(manifest),
    developerName: stringOrNull(manifest?.interface?.developerName)
  };
}

function authorNameFromManifest(manifest) {
  if (typeof manifest?.author === "string") return stringOrNull(manifest.author);
  return stringOrNull(manifest?.author?.name);
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readJsonCheck(checks, name, file, suggestedNextActions) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    checks.push({ name, ok: true, severity: "error", path: file });
    return value;
  } catch (error) {
    checks.push({
      name,
      ok: false,
      severity: "error",
      path: file,
      error: error.message,
      suggestedNextActions
    });
    return undefined;
  }
}

function addCheck(checks, check) {
  checks.push({
    severity: "error",
    ...check,
    suggestedNextActions: check.ok ? [] : check.suggestedNextActions
  });
}

function addWarning(checks, check) {
  checks.push({
    severity: "warning",
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

function collectSuggestedNextActions(checks) {
  const actions = [];
  for (const check of checks) {
    if (check.ok) continue;
    for (const action of check.suggestedNextActions || []) {
      if (!actions.includes(action)) actions.push(action);
    }
  }
  return actions;
}
