import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const compatibility = fs.readFileSync(
  new URL("../docs/compatibility.md", import.meta.url),
  "utf8"
);
const skill = fs.readFileSync(
  new URL("../skills/agentshell/SKILL.md", import.meta.url),
  "utf8"
);

test("public docs expose the Go project and verification surface", () => {
  for (const text of [readme, compatibility, skill]) {
    assert.match(text, /go\.mod/);
    assert.match(text, /go\.work/);
    assert.match(text, /go test -json/);
    assert.match(text, /testdata/);
    assert.match(text, /go:embed/);
  }

  for (const command of [
    "agentshell verify build",
    "agentshell verify lint",
    "agentshell verify format",
    "agentshell verify modules"
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(command)));
    assert.match(skill, new RegExp(escapeRegExp(command)));
  }
});

test("public docs expose profiles, project overrides, and bounded Go workflows", () => {
  for (const text of [readme, compatibility, skill]) {
    assert.match(text, /\.agentshell\.json/);
    assert.match(text, /golangci-lint/);
    assert.match(text, /goimports/);
  }

  for (const command of [
    "agentshell verify test --profile fast",
    "agentshell verify test --profile race",
    "agentshell verify test --profile coverage",
    "agentshell verify benchmark --bench 'BenchmarkEncode'",
    "agentshell verify generate",
    "agentshell verify fuzz --fuzz FuzzName --duration 10s --package ./internal/parser"
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(command)));
  }

  assert.match(skill, /--profile fast\|race\|coverage/);
  assert.match(skill, /explicit target/);
  assert.match(skill, /finite duration/);
  assert.match(skill, /go generate -n/);
});

test("Go product boundaries do not promise automatic repair or MCP", () => {
  assert.match(readme, /automatic Go source\s+repair is not supported/i);
  assert.match(compatibility, /Automatic Go source repair/);
  assert.match(skill, /automatic Go source repair is not supported/);
  assert.match(skill, /Do not require MCP/);
  assert.doesNotMatch(readme, /automatic(?:ally)? (?:fix|repair).*Go source/i);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
