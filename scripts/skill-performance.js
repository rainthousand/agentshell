#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = "agentshell.skill-performance.v1";
export const DEFAULT_SKILL_BUDGET = Object.freeze({
  mainEstimatedTokens: 1_200,
  descriptionEstimatedTokens: 120
});

export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value || ""), "utf8") / 4);
}

export function analyzeSkill(skillPath, options = {}) {
  const resolvedPath = resolveSkillPath(skillPath);
  const source = fs.readFileSync(resolvedPath, "utf8");
  const parsed = parseSkillSource(source);
  const budget = normalizeBudget(options.budget);
  const references = analyzeReferences(resolvedPath, parsed.body);
  const mainEstimatedTokens = estimateTokens(source);
  const checks = [
    budgetCheck("main-skill-tokens", mainEstimatedTokens, budget.mainEstimatedTokens),
    budgetCheck("description-tokens", estimateTokens(parsed.metadata.description || ""), budget.descriptionEstimatedTokens)
  ];

  return {
    ok: checks.every((check) => check.status === "pass"),
    protocolVersion: PROTOCOL_VERSION,
    skill: {
      path: resolvedPath,
      bytes: Buffer.byteLength(source, "utf8"),
      lines: countLines(source),
      estimatedTokens: mainEstimatedTokens,
      frontmatter: {
        present: parsed.frontmatter.present,
        bytes: Buffer.byteLength(parsed.frontmatter.raw, "utf8"),
        lines: countLines(parsed.frontmatter.raw),
        estimatedTokens: estimateTokens(parsed.frontmatter.raw),
        metadata: parsed.metadata,
        descriptionEstimatedTokens: estimateTokens(parsed.metadata.description || "")
      },
      body: {
        bytes: Buffer.byteLength(parsed.body, "utf8"),
        lines: countLines(parsed.body),
        estimatedTokens: estimateTokens(parsed.body)
      }
    },
    references,
    budget,
    checks
  };
}

export function parseSkillSource(source) {
  const normalized = String(source || "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return {
      frontmatter: { present: false, raw: "" },
      metadata: {},
      body: normalized
    };
  }

  return {
    frontmatter: { present: true, raw: match[0] },
    metadata: parseFrontmatterMetadata(match[1]),
    body: normalized.slice(match[0].length)
  };
}

export function normalizeBudget(overrides = {}) {
  const budget = { ...DEFAULT_SKILL_BUDGET };
  for (const key of Object.keys(budget)) {
    if (overrides?.[key] === undefined) continue;
    const value = Number(overrides[key]);
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${key} must be a non-negative number`);
    budget[key] = value;
  }
  return budget;
}

function parseFrontmatterMetadata(frontmatter) {
  const metadata = {};
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const [, key, rawValue = ""] = match;
    if (rawValue === ">" || rawValue === "|") {
      const parts = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        parts.push(lines[index + 1].trim());
        index += 1;
      }
      metadata[key] = rawValue === ">" ? parts.join(" ") : parts.join("\n");
      continue;
    }
    metadata[key] = unquote(rawValue.trim());
  }
  return metadata;
}

function analyzeReferences(skillPath, body) {
  const skillDir = path.dirname(skillPath);
  const referencesDir = path.join(skillDir, "references");
  const files = fs.existsSync(referencesDir) ? walkFiles(referencesDir) : [];
  const entries = files.map((file) => {
    const source = fs.readFileSync(file, "utf8");
    return {
      path: path.relative(skillDir, file),
      bytes: Buffer.byteLength(source, "utf8"),
      lines: countLines(source),
      estimatedTokens: estimateTokens(source)
    };
  });
  const linkedPaths = extractLocalReferenceLinks(body);
  const availablePaths = new Set(entries.map((entry) => entry.path));

  return {
    directoryPresent: fs.existsSync(referencesDir),
    count: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    estimatedTokens: entries.reduce((total, entry) => total + entry.estimatedTokens, 0),
    linkedPaths,
    missingLinkedPaths: linkedPaths.filter((entry) => !availablePaths.has(entry)),
    files: entries
  };
}

function extractLocalReferenceLinks(body) {
  const results = new Set();
  for (const match of body.matchAll(/(?:\[[^\]]*\]\(|`)((?:\.\/)?references\/[^)`\s]+)(?:\)|`)/g)) {
    results.add(match[1].replace(/^\.\//, ""));
  }
  return [...results].sort();
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files.sort();
}

function resolveSkillPath(input) {
  const resolved = path.resolve(input || "skills/agentshell/SKILL.md");
  if (!fs.existsSync(resolved)) throw new Error(`Skill path does not exist: ${resolved}`);
  if (fs.statSync(resolved).isDirectory()) {
    const entrypoint = path.join(resolved, "SKILL.md");
    if (!fs.existsSync(entrypoint)) throw new Error(`Skill directory is missing SKILL.md: ${resolved}`);
    return entrypoint;
  }
  return resolved;
}

function budgetCheck(id, value, limit) {
  return { id, status: value <= limit ? "pass" : "fail", value, limit, unit: "estimated_tokens" };
}

function countLines(value) {
  if (!value) return 0;
  return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

function unquote(value) {
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArgs(argv) {
  const options = { skill: "skills/agentshell/SKILL.md", gate: false, budget: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--skill", "--max-skill-tokens", "--max-description-tokens"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--skill") options.skill = value;
      if (arg === "--max-skill-tokens") options.budget.mainEstimatedTokens = value;
      if (arg === "--max-description-tokens") options.budget.descriptionEstimatedTokens = value;
      index += 1;
      continue;
    }
    if (arg === "--gate") options.gate = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node scripts/skill-performance.js [--skill <SKILL.md|dir>] [--max-skill-tokens N] [--max-description-tokens N] [--gate]\n");
      return;
    }
    const report = analyzeSkill(options.skill, { budget: options.budget });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.gate && !report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
