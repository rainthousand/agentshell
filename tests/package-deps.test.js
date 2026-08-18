import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { packageDeps } from "../src/commands/package-deps.js";

test("package deps summarizes Node manifests without expanding dependency trees", async () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), {
    name: "node-fixture",
    version: "1.0.0",
    engines: {
      node: ">=20"
    },
    dependencies: {
      express: "^4.18.0",
      next: "14.0.0",
      react: "^18.2.0"
    },
    devDependencies: {
      typescript: "^5.5.0",
      vitest: "^2.0.0"
    },
    peerDependencies: {
      "@types/react": "^18.0.0"
    },
    optionalDependencies: {
      sharp: "^0.33.0"
    }
  });
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const result = await packageDeps(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.package-deps.v1");
  assert.equal(result.compact, true);
  assert.equal(result.ecosystem, "node");
  assert.deepEqual(result.summary.manifests, ["package.json"]);
  assert.equal(result.summary.dependencyCount, 7);
  assert.equal(result.summary.nodeDependencyCount, 7);
  assert.equal(result.summary.goDependencyCount, 0);
  assert.equal(result.summary.productionCount, 3);
  assert.equal(result.summary.developmentCount, 2);
  assert.equal(result.summary.peerCount, 1);
  assert.equal(result.summary.optionalCount, 1);
  assert.deepEqual(result.summary.lockfiles, ["pnpm-lock.yaml"]);
  assert.deepEqual(result.dependencies.production.map((entry) => entry.name), ["express", "next", "react"]);
  assert.ok(result.frameworks.some((entry) => entry.name === "React" && entry.package === "react"));
  assert.ok(result.frameworks.some((entry) => entry.name === "Next.js"));
  assert.ok(result.frameworks.some((entry) => entry.name === "Express"));
  assert.ok(result.frameworks.some((entry) => entry.name === "Vitest"));
  assert.ok(result.frameworks.some((entry) => entry.name === "TypeScript"));
  assert.ok(result.runtimes.some((entry) => entry.name === "node" && entry.version === ">=20"));
  assert.ok(result.runtimes.some((entry) => entry.name === "typescript" && entry.version === "^5.5.0"));
  assert.ok(result.risks.some((entry) => entry.type === "lockfile-present" && entry.files.includes("pnpm-lock.yaml")));
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell package scripts --compact"));
});

test("package deps summarizes Go modules and indirect requires", async () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), [
    "module example.com/agentshell-fixture",
    "",
    "go 1.22",
    "",
    "require github.com/spf13/cobra v1.8.1",
    "",
    "require (",
    "  golang.org/x/mod v0.20.0",
    "  golang.org/x/sys v0.24.0 // indirect",
    ")",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "go.sum"), "github.com/spf13/cobra v1.8.1 h1:fixture\n");

  const result = await packageDeps(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.ecosystem, "go");
  assert.deepEqual(result.summary.manifests, ["go.mod"]);
  assert.equal(result.summary.dependencyCount, 3);
  assert.equal(result.summary.goDependencyCount, 3);
  assert.deepEqual(result.summary.lockfiles, ["go.sum"]);
  assert.ok(result.frameworks.some((entry) => entry.name === "Go module" && entry.package === "example.com/agentshell-fixture"));
  assert.ok(result.runtimes.some((entry) => entry.name === "go" && entry.version === "1.22"));
  assert.deepEqual(result.dependencies.go.map((entry) => [entry.name, entry.version, entry.indirect]), [
    ["github.com/spf13/cobra", "v1.8.1", false],
    ["golang.org/x/mod", "v0.20.0", false],
    ["golang.org/x/sys", "v0.24.0", true]
  ]);
  assert.ok(result.risks.some((entry) => entry.type === "lockfile-present" && entry.files.includes("go.sum")));
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell verify modules --compact"));
});

test("package deps handles mixed projects and dependency-count risks", async () => {
  const root = tempProject();
  const dependencies = {};
  for (let index = 0; index < 51; index += 1) {
    dependencies[`pkg-${index}`] = `^1.0.${index}`;
  }
  writeJson(path.join(root, "package.json"), {
    dependencies
  });
  fs.writeFileSync(path.join(root, "go.mod"), [
    "module example.com/mixed",
    "go 1.21",
    "require github.com/google/uuid v1.6.0",
    ""
  ].join("\n"));

  const result = await packageDeps(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.ecosystem, "mixed");
  assert.equal(result.summary.dependencyCount, 52);
  assert.ok(result.risks.some((entry) => entry.type === "large-dependency-count"));
  assert.ok(result.risks.some((entry) => entry.type === "lockfile-missing" && entry.count === 51));
  assert.ok(result.risks.some((entry) => entry.type === "lockfile-missing" && entry.count === 1));
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell git status --compact"));
});

test("package deps finds the nearest supported manifest from nested directories", async () => {
  const root = tempProject();
  const nested = path.join(root, "src", "feature");
  fs.mkdirSync(nested, { recursive: true });
  writeJson(path.join(root, "package.json"), {
    dependencies: {
      vite: "^5.0.0"
    }
  });
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");

  const result = await packageDeps(nested, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.ecosystem, "node");
  assert.equal(result.summary.dependencyCount, 1);
  assert.deepEqual(result.summary.lockfiles, ["package-lock.json"]);
  assert.ok(result.frameworks.some((entry) => entry.name === "Vite"));
});

test("package deps returns MANIFEST_NOT_FOUND without supported manifests", async () => {
  const root = tempProject();

  const result = await packageDeps(root, { compact: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MANIFEST_NOT_FOUND");
  assert.deepEqual(result.error.details.checked, ["package.json", "go.mod"]);
  assert.equal(result.error.suggestedNextActions[0].command, "agentshell tree --compact");
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-package-deps-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
