#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([".git", ".agentshell", "artifacts", "node_modules"]);
const patterns = [
  ["github-token", /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private-key", /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/g],
  ["absolute-user-path", /\/Users\/[A-Za-z0-9._-]+\//g]
];

const findings = [];
walk(root, (file) => {
  const relative = path.relative(root, file);
  if (relative === "scripts/security-scan.js") return;
  const content = fs.readFileSync(file, "utf8");
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push({ kind, file: relative });
  }
});

console.log(JSON.stringify({
  ok: findings.length === 0,
  protocolVersion: "agentshell.security-scan.v1",
  scannedRoot: root,
  findings
}, null, 2));
if (findings.length > 0) process.exitCode = 1;

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === ".DS_Store") continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target, visit);
    else if (entry.isFile() && fs.statSync(target).size < 2_000_000 && !isBinary(target)) visit(target);
  }
}

function isBinary(file) {
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.alloc(512);
  const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
  fs.closeSync(descriptor);
  return buffer.subarray(0, length).includes(0);
}
