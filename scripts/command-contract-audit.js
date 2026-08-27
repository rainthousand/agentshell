#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HELP_COMMANDS, SCHEMA_NAMES } from "../src/core/command-registry.js";

export const PROTOCOL_VERSION = "agentshell.command-contract-audit.v1";

export function auditCommandContracts(options = {}) {
  const root = path.resolve(options.root || path.resolve(import.meta.dirname, ".."));
  const skill = path.resolve(root, options.skill || "skills/agentshell/SKILL.md");
  const references = path.resolve(root, options.references || "skills/agentshell/references");
  const schemas = path.resolve(root, options.schemas || "schemas");
  const helpCommands = options.helpCommands || HELP_COMMANDS;
  const schemaNames = options.schemaNames || SCHEMA_NAMES;
  const markdownFiles = [skill, ...walkMarkdownFiles(references)];
  const snippets = markdownFiles.flatMap((file) => extractAgentShellCommands(fs.readFileSync(file, "utf8"), file, root));
  const invalidCommands = snippets.filter((entry) => !matchesHelpCommand(entry.command, helpCommands));
  const registeredSchemas = [...new Set(schemaNames)].sort();
  const diskSchemas = listSchemaNames(schemas);
  const missingSchemas = registeredSchemas.filter((name) => !diskSchemas.includes(name));
  const unregisteredSchemas = diskSchemas.filter((name) => !registeredSchemas.includes(name));
  const duplicateHelpCommands = duplicates(helpCommands);
  const duplicateSchemaNames = duplicates(schemaNames);
  const packageIssues = auditPackageContract(root);
  const issues = [
    ...duplicateHelpCommands.map((command) => `duplicate help command: ${command}`),
    ...duplicateSchemaNames.map((name) => `duplicate schema name: ${name}`),
    ...missingSchemas.map((name) => `registered schema is missing: ${name}`),
    ...unregisteredSchemas.map((name) => `schema is not registered: ${name}`),
    ...invalidCommands.map((entry) => `unregistered skill command: ${entry.command} (${entry.file}:${entry.line})`),
    ...packageIssues
  ];

  return {
    ok: issues.length === 0,
    protocolVersion: PROTOCOL_VERSION,
    summary: {
      helpCommands: helpCommands.length,
      schemas: registeredSchemas.length,
      markdownFiles: markdownFiles.length,
      skillCommands: snippets.length,
      issueCount: issues.length
    },
    drift: {
      duplicateHelpCommands,
      duplicateSchemaNames,
      missingSchemas,
      unregisteredSchemas,
      invalidCommands,
      packageIssues
    },
    issues
  };
}

export function extractAgentShellCommands(source, file = "SKILL.md", root = process.cwd()) {
  const commands = [];
  const lines = String(source).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(/`(agentshell\s+[^`\n]+)`/g)) {
      commands.push({
        command: match[1].trim(),
        file: path.relative(root, file),
        line: index + 1
      });
    }
  }
  return commands;
}

export function matchesHelpCommand(command, helpCommands = HELP_COMMANDS) {
  const actual = commandTokens(command);
  if (actual[0] !== "agentshell") return false;
  return helpCommands.some((signature) => matchesDescriptor(actual.slice(1), parseHelpDescriptor(signature)));
}

function parseHelpDescriptor(signature) {
  const tokens = String(signature).trim().split(/\s+/).slice(1);
  const literals = [];
  let positional = null;
  for (const token of tokens) {
    if (token.startsWith("--") || token.startsWith("[--") || token.startsWith("(--")) break;
    const required = token.match(/^<([^>]+)>$/);
    if (required) {
      positional = positionalDescriptor(required[1], false);
      break;
    }
    const optional = token.match(/^\[([^\]-][^\]]*)\]$/);
    if (optional) {
      positional = positionalDescriptor(optional[1], true);
      break;
    }
    if (/[[\]()<>]/.test(token)) break;
    literals.push(token);
  }
  return { literals, positional };
}

function positionalDescriptor(value, optional) {
  const choices = value.split("|");
  const isChoice = choices.length > 1 && choices.every((entry) => /^[a-z0-9-]+$/i.test(entry));
  return { optional, choices: isChoice ? choices : null };
}

function matchesDescriptor(actual, descriptor) {
  if (descriptor.literals.some((token, index) => actual[index] !== token)) return false;
  const rest = actual.slice(descriptor.literals.length);
  if (!descriptor.positional) return rest.length === 0;
  if (rest.length === 0) return descriptor.positional.optional;
  if (!descriptor.positional.choices) return true;
  return descriptor.positional.choices.includes(rest[0]);
}

function commandTokens(command) {
  const beforeOptions = String(command).trim().split(/\s+/);
  const tokens = [];
  for (const token of beforeOptions) {
    if (token === "--" || token.startsWith("--") || token.startsWith("[--")) break;
    tokens.push(token.replace(/[,:;.]$/, ""));
  }
  return tokens;
}

function listSchemaNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => name.slice(0, -".schema.json".length))
    .sort();
}

function walkMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
  }
  return files.sort();
}

function duplicates(values) {
  const seen = new Set();
  const duplicatesFound = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicatesFound.add(value);
    seen.add(value);
  }
  return [...duplicatesFound].sort();
}

function auditPackageContract(root) {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) return ["package.json is missing"];
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const issues = [];
  if (!packageJson.bin?.agentshell) issues.push("package.json is missing the agentshell binary");
  else if (!fs.existsSync(path.resolve(root, packageJson.bin.agentshell))) {
    issues.push(`package.json agentshell binary is missing: ${packageJson.bin.agentshell}`);
  }
  return issues;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--root", "--skill", "--references", "--schemas"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { help: true };
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node scripts/command-contract-audit.js [--root <dir>] [--skill <file>] [--references <dir>] [--schemas <dir>]\n");
      return;
    }
    const report = auditCommandContracts(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, protocolVersion: PROTOCOL_VERSION, error: error.message })}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
