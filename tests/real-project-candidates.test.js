import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("real project candidates evaluates local repos and remote URLs without checkout", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-candidates-"));
  const localRepo = path.join(tempRoot, "tiny-ts-package");
  fs.mkdirSync(path.join(localRepo, "src"), { recursive: true });
  fs.mkdirSync(path.join(localRepo, "test"), { recursive: true });
  fs.writeFileSync(path.join(localRepo, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(localRepo, "package.json"), JSON.stringify({
    name: "@scope/tiny-ts-package",
    type: "module",
    scripts: {
      test: "node test/index.test.js",
      typecheck: "tsc --noEmit"
    }
  }, null, 2));
  fs.writeFileSync(path.join(localRepo, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(localRepo, "test", "index.test.js"), "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n");

  const result = spawnSync("node", [
    "scripts/real-project-candidates.js",
    "--repo",
    localRepo,
    "--repo",
    "sindresorhus/is"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.real-project-candidates.v1");
  assert.equal(output.summary.total, 2);
  assert.equal(output.summary.local, 1);
  assert.equal(output.summary.remote, 1);
  assert.equal(output.summary.checkoutRequired, 1);
  assert.equal(output.summary.runnableDrafts, 1);
  assert.equal(output.summary.highPriority, 1);
  assert.equal(output.summary.mediumPriority, 0);
  assert.equal(output.summary.lowPriority, 0);
  assert.deepEqual(output.summary.topCandidates, ["scope-tiny-ts-package"]);

  const local = output.projects.find((project) => project.id === "scope-tiny-ts-package");
  assert.equal(local.exists, true);
  assert.equal(local.packageManager, "npm");
  assert.equal(local.packageManagerSpec, null);
  assert.equal(local.nodeEngine, null);
  assert.deepEqual(local.dependencySummary, {
    dependencies: 0,
    devDependencies: 0,
    peerDependencies: 0,
    total: 0
  });
  assert.equal(local.workspaceSummary.detected, false);
  assert.equal(local.language, "typescript");
  assert.equal(local.testCommand, "npm test");
  assert.equal(local.setupCommand, "npm ci --offline");
  assert.deepEqual(local.setupLinks, []);
  assert.equal(local.fileSummary.ts, 1);
  assert.equal(local.fileSummary.test, 1);
  assert.equal(local.recommendedUse, "typescript-diagnostic-eval");
  assert.equal(local.priority, "high");
  assert.match(local.nextAction, /Add scope-tiny-ts-package to examples\/real-projects\.json/);
  assert.equal(local.manifestEntry.skip, false);
  assert.equal(local.manifestEntry.repoPath, path.relative(process.cwd(), localRepo));
  assert.deepEqual(local.manifestEntry.setupLinks, []);
  assert.deepEqual(local.manifestEntry.allowedStrategies, ["raw", "split", "fix"]);

  const remote = output.projects.find((project) => project.source === "sindresorhus/is");
  assert.equal(remote.sourceType, "remote");
  assert.equal(remote.checkoutRequired, true);
  assert.equal(remote.packageManagerSpec, null);
  assert.equal(remote.nodeEngine, null);
  assert.deepEqual(remote.setupLinks, []);
  assert.deepEqual(remote.dependencySummary, {
    dependencies: 0,
    devDependencies: 0,
    peerDependencies: 0,
    total: 0
  });
  assert.equal(remote.workspaceSummary.detected, false);
  assert.deepEqual(remote.blockers, ["checkout-required"]);
  assert.equal(remote.manifestEntry.skip, true);
  assert.equal(remote.manifestEntry.skipReason, "checkout-required");
  assert.equal(remote.recommendedUse, "checkout-before-eval");
  assert.equal(remote.priority, "blocked");
  assert.equal(remote.nextAction, "Checkout or import this repository locally before evaluation.");
});

test("real project candidates detects local workspaces, node engines, package manager, and dependency scale", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-candidates-"));
  const localRepo = path.join(tempRoot, "workspace-package");
  fs.mkdirSync(path.join(localRepo, "packages", "app", "test"), { recursive: true });
  fs.writeFileSync(path.join(localRepo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  fs.writeFileSync(path.join(localRepo, "turbo.json"), "{}\n");
  fs.writeFileSync(path.join(localRepo, "nx.json"), "{}\n");
  fs.writeFileSync(path.join(localRepo, "package.json"), JSON.stringify({
    name: "workspace-package",
    private: true,
    packageManager: "pnpm@9.12.0",
    engines: {
      node: ">=20 <23"
    },
    workspaces: [
      "packages/*"
    ],
    scripts: {
      test: "pnpm --filter app test"
    },
    dependencies: {
      "@scope/runtime": "^1.0.0",
      "left-pad": "^1.3.0"
    },
    devDependencies: {
      typescript: "^5.0.0"
    },
    peerDependencies: {
      react: "^18.0.0"
    }
  }, null, 2));
  fs.writeFileSync(path.join(localRepo, "packages", "app", "package.json"), JSON.stringify({
    name: "app",
    scripts: {
      test: "node test/app.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(localRepo, "packages", "app", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(localRepo, "packages", "app", "test", "app.test.js"), "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n");

  const result = spawnSync("node", [
    "scripts/real-project-candidates.js",
    "--repo",
    localRepo
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const local = output.projects[0];
  assert.equal(local.id, "workspace-package");
  assert.equal(local.packageManager, "pnpm");
  assert.equal(local.packageManagerSpec, "pnpm@9.12.0");
  assert.equal(local.nodeEngine, ">=20 <23");
  assert.deepEqual(local.dependencySummary, {
    dependencies: 2,
    devDependencies: 1,
    peerDependencies: 1,
    total: 4
  });
  assert.deepEqual(local.workspaceSummary, {
    detected: true,
    packageJsonWorkspaces: true,
    pnpmWorkspaceYaml: true,
    lernaJson: false,
    turboJson: true,
    nxJson: true,
    packageJsonWorkspaceCount: 1,
    indicators: [
      "package-json-workspaces",
      "pnpm-workspace-yaml",
      "turbo-json",
      "nx-json"
    ]
  });
  assert.equal(local.testCommand, "pnpm test");
  assert.equal(local.setupCommand, "pnpm install --offline");
  assert.deepEqual(local.setupLinks, []);
  assert.equal(local.language, "typescript");
  assert.equal(local.fileSummary.packageJson, true);
  assert.equal(local.fileSummary.ts, 1);
  assert.equal(local.fileSummary.test, 1);
  assert.ok(local.warnings.includes("workspace-monorepo"));
  assert.ok(!local.warnings.includes("missing-node-engine"));
  assert.ok(local.candidateScore > 0);
  assert.equal(local.priority, "medium");
  assert.match(local.nextAction, /Review warnings/);
});

test("real project candidates reads candidate files and writes report plus manifest draft and markdown", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-candidates-"));
  const candidateFile = path.join(tempRoot, "candidates.json");
  const reportPath = path.join(tempRoot, "report.json");
  const manifestPath = path.join(tempRoot, "manifest-draft.json");
  const markdownPath = path.join(tempRoot, "report.md");
  fs.writeFileSync(candidateFile, JSON.stringify({
    candidates: [
      {
        id: "chalk",
        name: "Chalk",
        url: "https://github.com/chalk/chalk",
        expectedFailureClass: "import-path",
        allowedStrategies: ["raw"]
      }
    ]
  }, null, 2));

  const result = spawnSync("node", [
    "scripts/real-project-candidates.js",
    "--candidates",
    candidateFile,
    "--report",
    reportPath,
    "--manifest-draft",
    manifestPath,
    "--markdown",
    markdownPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(report, stdout);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.projects.length, 1);
  assert.equal(manifest.projects[0].id, "chalk");
  assert.equal(manifest.projects[0].repoPath, "https://github.com/chalk/chalk");
  assert.equal(manifest.projects[0].skip, true);
  assert.equal(manifest.projects[0].expectedFailureClass, "import-path");
  assert.deepEqual(manifest.projects[0].allowedStrategies, ["raw"]);

  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.match(markdown, /^# Real Project Candidate Report/m);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /- Total candidates: 1/);
  assert.match(markdown, /- Top candidates: none/);
  assert.match(markdown, /## Candidates/);
  assert.match(markdown, /\| chalk \| Chalk \| https:\/\/github\.com\/chalk\/chalk \| remote \|/);
  assert.match(markdown, /## Blockers And Warnings/);
  assert.match(markdown, /chalk: blockers: checkout-required; warnings: not-downloaded-by-design/);
  assert.match(markdown, /## Manifest Draft/);
  assert.match(markdown, /Review skipped entries, expected failure classes, allowed strategies, setup links, setup commands, and test commands/);
});

test("real project candidates suggests setupLinks when node_modules is prepared", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-candidates-"));
  const localRepo = path.join(tempRoot, "prepared-package");
  fs.mkdirSync(path.join(localRepo, "node_modules", "left-pad"), { recursive: true });
  fs.mkdirSync(path.join(localRepo, "test"), { recursive: true });
  fs.writeFileSync(path.join(localRepo, "package.json"), JSON.stringify({
    name: "prepared-package",
    type: "module",
    scripts: {
      test: "node test/index.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(localRepo, "test", "index.test.js"), "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n");

  const result = spawnSync("node", [
    "scripts/real-project-candidates.js",
    "--repo",
    localRepo
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const local = output.projects[0];
  assert.equal(local.setupCommand, "npm install --offline");
  assert.equal(local.manifestEntry.setupCommand, null);
  assert.deepEqual(local.setupLinks, [{
    source: "node_modules",
    target: "node_modules"
  }]);
  assert.deepEqual(local.manifestEntry.setupLinks, local.setupLinks);
});

test("real project candidates treats existing two-segment paths as local", () => {
  const result = spawnSync("node", [
    "scripts/real-project-candidates.js",
    "--repo",
    "examples/failing-test-demo"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.local, 1);
  assert.equal(output.summary.remote, 0);
  assert.equal(output.summary.checkoutRequired, 0);
  assert.equal(output.summary.runnableDrafts, 1);
  assert.equal(output.projects[0].sourceType, "local");
  assert.equal(output.projects[0].exists, true);
  assert.equal(output.projects[0].manifestEntry.skip, false);
  assert.equal(output.projects[0].manifestEntry.repoPath, "examples/failing-test-demo");
});

test("real project candidate sample documents remote registration before checkout", () => {
  const result = spawnSync("node", [
    "scripts/real-project-candidates.js",
    "--candidates",
    "examples/real-project-candidates.sample.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.total, 3);
  assert.equal(output.summary.remote, 2);
  assert.equal(output.summary.local, 1);
  assert.equal(output.summary.checkoutRequired, 2);
  assert.equal(output.summary.runnableDrafts, 1);

  const remote = output.projects.find((project) => project.id === "chalk");
  assert.equal(remote.sourceType, "remote");
  assert.equal(remote.priority, "blocked");
  assert.equal(remote.nextAction, "Checkout or import this repository locally before evaluation.");
  assert.deepEqual(remote.blockers, ["checkout-required"]);
  assert.equal(remote.manifestEntry.skip, true);
  assert.equal(remote.manifestEntry.skipReason, "checkout-required");
  assert.match(remote.notes, /Register first/);

  const local = output.projects.find((project) => project.id === "local-prepared-example");
  assert.equal(local.sourceType, "local");
  assert.equal(local.exists, true);
  assert.equal(local.manifestEntry.skip, false);
  assert.equal(local.testCommand, "npm test");
  assert.ok(output.summary.topCandidates.includes("local-prepared-example"));
});
