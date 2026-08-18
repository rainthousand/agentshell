import fs from "node:fs";
import path from "node:path";

const FILE_REFERENCE = /((?:file:\/\/)?(?:\.{0,2}\/)?[A-Za-z0-9._/-]+\.go):(\d+)(?::(\d+))?/g;

export function parseGoTestJson(text, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const modules = readModuleMappings(root, options.modules);
  const failed = new Map();
  const outputRecords = [];
  const relatedFiles = new Set();
  const fallbackLines = [];
  let eventCount = 0;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const event = parseEvent(rawLine);
    if (!event) {
      fallbackLines.push(rawLine);
      collectRelatedFiles(rawLine, null, root, modules, relatedFiles);
      continue;
    }

    eventCount += 1;
    if (event.Action === "fail" && event.Test) {
      const packageName = event.Package || event.ImportPath || "";
      failed.set(`${packageName}\0${event.Test}`, { packageName, testName: event.Test });
    }
    if (typeof event.Output === "string") {
      outputRecords.push({ output: event.Output, package: event.Package || event.ImportPath || null });
      collectRelatedFiles(event.Output, event, root, modules, relatedFiles);
    }
  }

  if (eventCount === 0) return null;

  const outputText = outputRecords.map((record) => record.output).join("") +
    (fallbackLines.length > 0 ? `${fallbackLines.join("\n")}\n` : "");
  const failures = [...failed.values()];
  const failedLeaves = failures.filter((failure) =>
    !failures.some((candidate) =>
      candidate.packageName === failure.packageName &&
      candidate.testName !== failure.testName &&
      candidate.testName.startsWith(`${failure.testName}/`)
    )
  );

  return {
    mainError: selectMainError(outputRecords, fallbackLines),
    failedTests: failedLeaves.length || null,
    failedTestNames: failedLeaves.map((failure) => failure.testName),
    relatedFiles: [...relatedFiles].slice(0, 10),
    outputText,
    eventCount
  };
}

function parseEvent(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || typeof value.Action !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function selectMainError(records, fallbackLines) {
  const candidates = [];
  let order = 0;
  for (const record of records) {
    for (const line of record.output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push({ line: trimmed, score: errorScore(trimmed), order: order++ });
    }
  }
  for (const line of fallbackLines) {
    const trimmed = line.trim();
    if (trimmed) candidates.push({ line: trimmed, score: errorScore(trimmed), order: order++ });
  }

  const meaningful = candidates.filter((candidate) => candidate.score > 0);
  meaningful.sort((left, right) => right.score - left.score || left.order - right.order);
  return meaningful[0]?.line || candidates.at(-1)?.line || null;
}

function errorScore(line) {
  if (/\.go:\d+(?::\d+)?:\s+.+/.test(line)) return 100;
  if (/^panic:\s+/i.test(line)) return 90;
  if (/\b(?:fatal error|runtime error):\s+/i.test(line)) return 85;
  if (/^(?:Error|Fatal|FATAL):\s+/i.test(line)) return 80;
  if (/^--- FAIL:\s+/.test(line)) return 60;
  if (/^\[build failed\]$/i.test(line)) return 50;
  if (/^FAIL(?:\s|$)/.test(line)) return 20;
  return 0;
}

function collectRelatedFiles(text, event, root, modules, files) {
  for (const match of String(text).matchAll(FILE_REFERENCE)) {
    const file = resolveFileReference(match[1], event, root, modules);
    if (file) files.add(file);
  }
}

function resolveFileReference(value, event, root, modules) {
  let file = value.replace(/^file:\/\//, "").replace(/^\.\//, "");
  if (path.isAbsolute(file)) return relativeExistingFile(root, file);

  const fromRoot = path.join(root, file);
  if (fs.existsSync(fromRoot)) return normalizeRelative(root, fromRoot);

  const packageDir = packageDirectory(event?.Package || event?.ImportPath, modules);
  if (packageDir !== null) {
    const fromPackage = path.join(root, packageDir, file);
    if (fs.existsSync(fromPackage)) return normalizeRelative(root, fromPackage);
  }

  if (path.dirname(file) !== ".") return null;
  const matches = findByBasename(root, file);
  return matches.length === 1 ? matches[0] : null;
}

function packageDirectory(packagePath, modules) {
  if (!packagePath) return null;
  const module = modules
    .filter((candidate) => packagePath === candidate.path || packagePath.startsWith(`${candidate.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!module) return null;
  const packageRelative = packagePath === module.path
    ? ""
    : packagePath.slice(module.path.length + 1);
  return path.join(module.root, packageRelative);
}

function readModuleMappings(root, workspaceModules) {
  const roots = Array.isArray(workspaceModules)
    ? workspaceModules.filter((module) => module?.valid).map((module) => module.root)
    : [root];
  const mappings = [];
  for (const moduleRoot of roots) {
    try {
      const contents = fs.readFileSync(path.join(moduleRoot, "go.mod"), "utf8");
      const modulePath = contents.match(/^\s*module\s+(\S+)/m)?.[1];
      const relativeRoot = path.relative(root, moduleRoot);
      if (modulePath && !relativeRoot.startsWith("..") && !path.isAbsolute(relativeRoot)) {
        mappings.push({ path: modulePath, root: relativeRoot });
      }
    } catch {
      // Invalid workspace modules are already reported by project discovery.
    }
  }
  return mappings;
}

function relativeExistingFile(root, file) {
  if (!fs.existsSync(file)) return null;
  return normalizeRelative(root, file);
}

function normalizeRelative(root, file) {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function findByBasename(root, basename) {
  const matches = [];
  const ignored = new Set([".git", ".agentshell", "node_modules", "vendor"]);
  const pending = [root];
  while (pending.length > 0 && matches.length < 2) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) pending.push(path.join(directory, entry.name));
      } else if (entry.isFile() && entry.name === basename) {
        matches.push(normalizeRelative(root, path.join(directory, entry.name)));
      }
    }
  }
  return matches;
}
