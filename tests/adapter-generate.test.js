import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cases = [
  {
    target: "claude",
    title: "# AgentShell Adapter for Claude Code",
    marker: "Claude Code can use AgentShell"
  },
  {
    target: "cursor",
    title: "# AgentShell Adapter for Cursor and Windsurf",
    marker: "Cursor and Windsurf can use AgentShell"
  },
  {
    target: "agents-md",
    title: "# Generic AGENTS.md Adapter",
    marker: "## Drop-In Section"
  }
];

for (const { target, title, marker } of cases) {
  test(`adapter generator outputs ${target} template`, () => {
    const result = spawnSync("node", ["scripts/adapter-generate.js", target], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith(title));
    assert.match(result.stdout, /agentshell manual --topic repair/);
    assert.match(result.stdout, /agentshell fix test --fast --compact/);
    assert.match(result.stdout, /17\/17/);
    assert.match(result.stdout, /262 tokens\/repair/);
    assert.match(result.stdout, /22,112->4,459/);
    assert.match(result.stdout, new RegExp(marker.replaceAll(".", "\\.")));
    assert.equal(result.stderr, "");
  });
}

const packageCases = [
  {
    target: "claude",
    files: [
      "README.md",
      join(".claude", "skills", "agentshell", "SKILL.md")
    ],
    markerFile: join(".claude", "skills", "agentshell", "SKILL.md"),
    markers: [
      "name: agentshell",
      "agentshell manual --topic repair",
      "agentshell fix test --fast --compact",
      "17/17",
      "262 tokens/repair",
      "22,112->4,459"
    ]
  },
  {
    target: "cursor",
    files: [
      "README.md",
      join(".cursor", "rules", "agentshell.mdc"),
      join(".windsurf", "rules", "agentshell.md")
    ],
    markerFile: join(".cursor", "rules", "agentshell.mdc"),
    markers: [
      "alwaysApply: true",
      "agentshell manual --topic repair",
      "agentshell fix test --fast --compact",
      "Treat AgentShell JSON as the source of truth",
      "17/17",
      "262 tokens/repair",
      "22,112->4,459"
    ]
  }
];

for (const { target, files, markerFile, markers } of packageCases) {
  test(`adapter generator writes ${target} package`, () => {
    const outDir = mkdtempSync(join(tmpdir(), `agentshell-${target}-adapter-`));
    const result = spawnSync(
      "node",
      ["scripts/adapter-generate.js", "--package", target, outDir],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");

    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.target, target);
    assert.deepEqual(summary.files, files);

    for (const file of files) {
      assert.equal(existsSync(join(outDir, file)), true, file);
    }

    const generated = readFileSync(join(outDir, markerFile), "utf8");
    for (const marker of markers) {
      assert.match(generated, new RegExp(marker.replaceAll(".", "\\.")));
    }
  });
}

test("adapter package mode rejects missing output directory", () => {
  const result = spawnSync("node", ["scripts/adapter-generate.js", "--package", "claude"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--package <claude\|cursor> <out-dir>/);
});

test("adapter generator outputs benchmark prompts for every adapter", () => {
  const result = spawnSync("node", ["scripts/adapter-generate.js", "--benchmark-prompts"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^# AgentShell Adapter Benchmark Prompts/);
  assert.match(result.stdout, /## Claude Code/);
  assert.match(result.stdout, /## Cursor\/Windsurf/);
  assert.match(result.stdout, /## Generic AGENTS\.md/);
  assert.match(result.stdout, /invokes AgentShell within the first two shell commands/);
  assert.match(result.stdout, /agentshell manual --topic repair/);
  assert.match(result.stdout, /agentshell fix test --fast --compact/);
  assert.match(result.stdout, /17\/17/);
  assert.match(result.stdout, /262 tokens\/repair/);
  assert.match(result.stdout, /22,112->4,459/);
  assert.match(result.stdout, /noisy raw shell inspection/);
});

test("adapter generator filters benchmark prompts by target", () => {
  const result = spawnSync(
    "node",
    ["scripts/adapter-generate.js", "--benchmark-prompts", "cursor"],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /## Cursor\/Windsurf/);
  assert.match(result.stdout, /agentshell change suggest --dry-run --compact/);
  assert.doesNotMatch(result.stdout, /## Claude Code/);
  assert.doesNotMatch(result.stdout, /## Generic AGENTS\.md/);
});

test("adapter benchmark prompt mode rejects unknown targets", () => {
  const result = spawnSync(
    "node",
    ["scripts/adapter-generate.js", "--benchmark-prompts", "unknown"],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--benchmark-prompts \[claude\|cursor\|agents-md\]/);
  assert.equal(result.stdout, "");
});

test("adapter generator outputs scorecard for every adapter", () => {
  const result = spawnSync("node", ["scripts/adapter-generate.js", "--scorecard"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^# AgentShell Adapter Scorecard/);
  assert.match(result.stdout, /First two commands/);
  assert.match(result.stdout, /Fast repair path/);
  assert.match(result.stdout, /Noise control/);
  assert.match(result.stdout, /examples\/failing-test-demo/);
  assert.match(result.stdout, /agentshell start --compact/);
  assert.match(result.stdout, /agentshell fix test --fast --compact/);
  assert.match(result.stdout, /## Claude Code/);
  assert.match(result.stdout, /## Cursor\/Windsurf/);
  assert.match(result.stdout, /## Generic AGENTS\.md/);
});

test("adapter generator filters scorecard by target", () => {
  const result = spawnSync("node", ["scripts/adapter-generate.js", "--scorecard", "agents-md"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /## Generic AGENTS\.md/);
  assert.doesNotMatch(result.stdout, /## Claude Code/);
  assert.doesNotMatch(result.stdout, /## Cursor\/Windsurf/);
});

test("adapter scorecard mode rejects unknown targets", () => {
  const result = spawnSync("node", ["scripts/adapter-generate.js", "--scorecard", "unknown"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--scorecard \[claude\|cursor\|agents-md\]/);
  assert.equal(result.stdout, "");
});

test("adapter packages mention benchmark prompt generation", () => {
  const outDir = mkdtempSync(join(tmpdir(), "agentshell-claude-adapter-"));
  const result = spawnSync(
    "node",
    ["scripts/adapter-generate.js", "--package", "claude", outDir],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr);

  const readme = readFileSync(join(outDir, "README.md"), "utf8");
  assert.match(readme, /--benchmark-prompts claude/);
  assert.match(readme, /--scorecard claude/);
  assert.match(readme, /examples\/failing-test-demo/);
  assert.match(readme, /agentshell fix test --fast --compact/);
});
