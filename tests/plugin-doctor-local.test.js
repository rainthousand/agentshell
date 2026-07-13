import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("plugin doctor local exposes compact JSON usage", () => {
  const result = spawnSync("node", ["scripts/plugin-doctor-local.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(
    output.usage,
    "node scripts/plugin-doctor-local.js [--root <repo>] [--home <home>] [--marketplace <path>] [--cache-root <path>] [--markdown]"
  );
});

test("plugin doctor local passes with dry local fixture paths", () => {
  const fixture = createFixture();
  writePluginManifest(fixture.root, "0.24.0+codex.fixture");
  writeMarketplace(fixture.home);
  writePluginManifest(join(fixture.cacheRoot, "0.24.0+codex.fixture"), "0.24.0+codex.fixture");

  const result = runDoctor(fixture);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.plugin.name, "agentshell");
  assert.equal(output.plugin.version, "0.24.0+codex.fixture");
  assert.equal(output.plugin.authorName, "Alvin");
  assert.equal(output.plugin.developerName, "AgentShell Labs");
  assert.equal(output.paths.marketplace, join(fixture.home, ".agents", "plugins", "marketplace.json"));
  assert.equal(output.paths.cachePath, join(fixture.cacheRoot, "0.24.0+codex.fixture"));
  assert.equal(output.summary.failed, 0);
  assert.equal(output.summary.warnings, 0);
  assert.equal(output.primaryNextAction, null);
  assert.deepEqual(output.suggestedNextActions, []);
});

test("plugin doctor local reports cache mismatch with suggested next actions", () => {
  const fixture = createFixture();
  writePluginManifest(fixture.root, "0.24.0+codex.source");
  writeMarketplace(fixture.home);
  writePluginManifest(join(fixture.cacheRoot, "0.24.0+codex.source"), "0.24.0+codex.cache");

  const result = runDoctor(fixture);

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.summary.failed, 1);
  assert(
    output.checks.some((check) => check.name === "codex plugin cache manifest matches source manifest" && !check.ok)
  );
  assert(
    output.suggestedNextActions.includes("Run `codex plugin add agentshell@personal` so Codex caches the current marketplace copy.")
  );
  assert.equal(
    output.primaryNextAction,
    "Run `codex plugin add agentshell@personal` so Codex caches the current marketplace copy."
  );
});

test("plugin doctor local points missing marketplace failures at install-local", () => {
  const fixture = createFixture();
  writePluginManifest(fixture.root, "0.24.0+codex.fixture");

  const result = runDoctor(fixture);

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(
    output.primaryNextAction,
    "Run `npm run plugin:install-local` to create or update the personal marketplace."
  );
  assert(
    output.suggestedNextActions.includes("Run `npm run plugin:install-local` to create or update the personal marketplace.")
  );
});

test("plugin doctor local reports cache developer metadata mismatch with suggested next actions", () => {
  const fixture = createFixture();
  writePluginManifest(fixture.root, "0.24.0+codex.source");
  writeMarketplace(fixture.home);
  writePluginManifest(join(fixture.cacheRoot, "0.24.0+codex.source"), "0.24.0+codex.source", {
    authorName: "Someone Else",
    developerName: "Different Labs"
  });

  const result = runDoctor(fixture);

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.summary.failed, 1);
  const mismatchCheck = output.checks.find(
    (check) => check.name === "codex plugin cache manifest matches source manifest"
  );
  assert.equal(mismatchCheck.ok, false);
  assert.equal(mismatchCheck.details.sourceAuthorName, "Alvin");
  assert.equal(mismatchCheck.details.sourceDeveloperName, "AgentShell Labs");
  assert.equal(mismatchCheck.details.cacheAuthorName, "Someone Else");
  assert.equal(mismatchCheck.details.cacheDeveloperName, "Different Labs");
  assert(
    output.suggestedNextActions.includes("Run `codex plugin add agentshell@personal` so Codex caches the current marketplace copy.")
  );
});

test("plugin doctor local keeps marketplace availability as warning", () => {
  const fixture = createFixture();
  writePluginManifest(fixture.root, "0.24.0+codex.fixture");
  writeMarketplace(fixture.home, { installation: "BLOCKED" });
  writePluginManifest(join(fixture.cacheRoot, "0.24.0+codex.fixture"), "0.24.0+codex.fixture");

  const result = runDoctor(fixture);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.summary.failed, 0);
  assert.equal(output.summary.warnings, 1);
  assert(
    output.suggestedNextActions.includes("Set the marketplace entry policy installation to `AVAILABLE`.")
  );
});

test("plugin doctor local exposes markdown summary output", () => {
  const fixture = createFixture();
  writePluginManifest(fixture.root, "0.24.0+codex.fixture");

  const result = runDoctor(fixture, ["--markdown"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^# Agentshell Plugin Doctor Local/m);
  assert.match(result.stdout, /^Status: FAIL$/m);
  assert.match(result.stdout, /^Marketplace: `/m);
  assert.match(result.stdout, /^Primary next action: Run `npm run plugin:install-local`/m);
  assert.match(result.stdout, /Suggested: Run `npm run plugin:install-local`/);
});

test("package exposes plugin doctor local script", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["plugin:doctor-local"], "node scripts/plugin-doctor-local.js");
});

function runDoctor(fixture, extraArgs = []) {
  return spawnSync("node", [
    "scripts/plugin-doctor-local.js",
    "--root",
    fixture.root,
    "--home",
    fixture.home,
    "--cache-root",
    fixture.cacheRoot,
    ...extraArgs
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function createFixture() {
  const base = mkdirTemp("agentshell-plugin-doctor-local-");
  return {
    root: join(base, "repo"),
    home: join(base, "home"),
    cacheRoot: join(base, "home", ".codex", "plugins", "cache", "personal", "agentshell")
  };
}

function writePluginManifest(root, version, metadata = {}) {
  const authorName = metadata.authorName || "Alvin";
  const developerName = metadata.developerName || "AgentShell Labs";
  mkdirSync(join(root, ".codex-plugin"), { recursive: true });
  writeFileSync(join(root, ".codex-plugin", "plugin.json"), `${JSON.stringify({
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

function writeMarketplace(home, policy = { installation: "AVAILABLE" }) {
  const file = join(home, ".agents", "plugins", "marketplace.json");
  mkdirSync(join(home, ".agents", "plugins"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    name: "personal",
    plugins: [
      {
        name: "agentshell",
        source: {
          source: "local",
          path: "./plugins/agentshell"
        },
        policy
      }
    ]
  }, null, 2)}\n`);
}

function mkdirTemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
