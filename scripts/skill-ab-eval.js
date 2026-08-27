#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSkill } from "./skill-performance.js";

export const PROTOCOL_VERSION = "agentshell.skill-ab-eval.v1";

export function compareSkills(currentPath, candidatePath, options = {}) {
  const current = analyzeSkill(currentPath, options);
  const candidate = analyzeSkill(candidatePath, options);
  const currentTokens = current.skill.estimatedTokens;
  const candidateTokens = candidate.skill.estimatedTokens;
  const reduction = currentTokens - candidateTokens;

  return {
    ok: candidate.ok && reduction >= 0,
    protocolVersion: PROTOCOL_VERSION,
    estimator: {
      method: "ceil(UTF-8 bytes / 4)",
      scope: "Static main SKILL.md context only; references are reported but excluded from activation context."
    },
    current,
    candidate,
    comparison: {
      estimatedContextTokens: {
        current: currentTokens,
        candidate: candidateTokens,
        reduction,
        reductionPercent: percent(reduction, currentTokens)
      },
      bytes: delta(current.skill.bytes, candidate.skill.bytes),
      lines: delta(current.skill.lines, candidate.skill.lines),
      descriptionEstimatedTokens: delta(
        current.skill.frontmatter.descriptionEstimatedTokens,
        candidate.skill.frontmatter.descriptionEstimatedTokens
      ),
      referenceEstimatedTokens: {
        current: current.references.estimatedTokens,
        candidate: candidate.references.estimatedTokens,
        delta: candidate.references.estimatedTokens - current.references.estimatedTokens
      }
    }
  };
}

function delta(current, candidate) {
  return { current, candidate, reduction: current - candidate };
}

function percent(value, total) {
  if (total === 0) return 0;
  return Math.round((value / total) * 10_000) / 100;
}

function parseArgs(argv) {
  const options = { budget: {}, gate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--current", "--candidate", "--output", "--max-skill-tokens", "--max-description-tokens"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--current") options.current = value;
      if (arg === "--candidate") options.candidate = value;
      if (arg === "--output") options.output = value;
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
      process.stdout.write("Usage: node scripts/skill-ab-eval.js --current <SKILL.md|dir> --candidate <SKILL.md|dir> [--output report.json] [--gate]\n");
      return;
    }
    if (!options.current || !options.candidate) throw new Error("--current and --candidate are required");
    const report = compareSkills(options.current, options.candidate, { budget: options.budget });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      const output = path.resolve(options.output);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, serialized);
    }
    process.stdout.write(serialized);
    if (options.gate && !report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
