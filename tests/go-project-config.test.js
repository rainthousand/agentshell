import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadGoProjectConfig } from "../src/core/project-config.js";
import { getProjectInfo, projectCommand, relatedTestCommand } from "../src/core/project.js";

function goModule() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-config-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/config\n\ngo 1.22\n");
  return root;
}

function writeConfig(root, value) {
  fs.writeFileSync(path.join(root, ".agentshell.json"), JSON.stringify(value));
}

test("applies version 1 Go commands and exposes command origins", () => {
  const root = goModule();
  writeConfig(root, {
    version: 1,
    go: {
      commands: {
        test: "make test",
        lint: "golangci-lint run"
      }
    }
  });

  try {
    const project = getProjectInfo(root);
    assert.equal(projectCommand(project, "test"), "make test");
    assert.equal(projectCommand(project, "build"), "go build ./...");
    assert.equal(projectCommand(project, "lint"), "golangci-lint run");
    assert.deepEqual(project.commandSources, {
      test: { kind: "custom" },
      build: { kind: "default" },
      lint: { kind: "custom" }
    });
    assert.equal(relatedTestCommand(project, "internal/parser/parser_test.go"), null);
    assert.deepEqual(project.issues, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes named Go profiles without activating them", () => {
  const root = goModule();
  writeConfig(root, {
    version: 1,
    go: {
      profiles: {
        fast: { commands: { test: "go test -short ./..." } },
        coverage: {
          commands: {
            test: "go test -covermode=atomic ./..."
          }
        }
      }
    }
  });

  try {
    const project = getProjectInfo(root);
    assert.equal(projectCommand(project, "test"), "go test ./...");
    assert.deepEqual(project.profiles.fast, {
      commands: { test: "go test -short ./..." },
      commandSources: { test: { kind: "profile", profile: "fast" } }
    });
    assert.deepEqual(project.profiles.coverage.commandSources, {
      test: { kind: "profile", profile: "coverage" }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid Go config reports one structured issue and keeps every default command", () => {
  const cases = [
    [{ version: 2, go: { commands: { test: "make test" } } }, "unsupported-version", "version"],
    [{ version: 1, extra: true }, "unknown-root-field", null],
    [{ version: 1, go: { commands: { generate: "go generate ./..." } } }, "unsupported-command", "go.commands.generate"],
    [{ version: 1, go: { commands: { deploy: "make deploy" } } }, "unsupported-command", "go.commands.deploy"],
    [{ version: 1, go: { profiles: { fast: { commands: { build: "go build ./..." } } } } }, "unsupported-command", "go.profiles.fast.commands.build"],
    [{ version: 1, go: { commands: { test: "go test ./...\nrm -rf ." } } }, "command-control-character", "go.commands.test"],
    [{ version: 1, go: { profiles: { "bad name": { commands: { test: "go test ./..." } } } } }, "invalid-profile-name", "go.profiles.bad name"],
    [{ version: 1, go: { profiles: { race_ci: { commands: { test: "go test -race ./..." } } } } }, "unsupported-profile", "go.profiles.race_ci"]
  ];

  for (const [config, reason, field] of cases) {
    const root = goModule();
    writeConfig(root, config);
    try {
      const project = getProjectInfo(root);
      assert.deepEqual(project.commands, {
        test: "go test ./...",
        build: "go build ./...",
        lint: "go vet ./..."
      });
      assert.deepEqual(project.profiles, {});
      assert.deepEqual(project.issues, [{
        code: "AGENTSHELL_CONFIG_INVALID",
        path: ".agentshell.json",
        reason,
        field
      }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects malformed, oversized, and symbolic-link config files", () => {
  const scenarios = [
    {
      prepare(root) {
        fs.writeFileSync(path.join(root, ".agentshell.json"), "{");
      },
      reason: "invalid-json"
    },
    {
      prepare(root) {
        fs.writeFileSync(path.join(root, ".agentshell.json"), " ".repeat(64 * 1024 + 1));
      },
      reason: "config-too-large"
    },
    {
      prepare(root) {
        const target = path.join(root, "actual.json");
        fs.writeFileSync(target, JSON.stringify({ version: 1 }));
        fs.symlinkSync(target, path.join(root, ".agentshell.json"));
      },
      reason: "config-symbolic-link"
    }
  ];

  for (const scenario of scenarios) {
    const root = goModule();
    scenario.prepare(root);
    try {
      const config = loadGoProjectConfig(root);
      assert.equal(config.present, true);
      assert.equal(config.issues[0].reason, scenario.reason);
      assert.deepEqual(config.commands, {});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("workspace config customizes the workspace only and keeps module discovery issues", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-work-config-"));
  fs.mkdirSync(path.join(root, "api"));
  fs.writeFileSync(path.join(root, "api", "go.mod"), "module example.com/api\n\ngo 1.22\n");
  fs.writeFileSync(path.join(root, "go.work"), "go 1.22\n\nuse (\n ./api\n ./missing\n)\n");
  writeConfig(root, {
    version: 1,
    go: { commands: { test: "make workspace-test" } }
  });

  try {
    const project = getProjectInfo(root);
    assert.equal(projectCommand(project, "test"), "make workspace-test");
    assert.equal(projectCommand(project, "build"), "go build './api/...'");
    assert.deepEqual(project.commandSources.test, { kind: "custom" });
    assert.deepEqual(project.issues, [{
      code: "GO_WORK_USE_INVALID",
      path: "./missing",
      reason: "use-path-missing"
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Node project selection and return shape ignore .agentshell.json Go settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-node-config-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "node-config",
    scripts: { test: "node --test" }
  }));
  writeConfig(root, {
    version: 1,
    go: { commands: { test: "make go-test" } }
  });

  try {
    const project = getProjectInfo(root);
    assert.equal(project.kind, "node");
    assert.equal(projectCommand(project, "test"), "npm run test");
    assert.equal(Object.hasOwn(project, "commandSources"), false);
    assert.equal(Object.hasOwn(project, "profiles"), false);
    assert.equal(Object.hasOwn(project, "issues"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
