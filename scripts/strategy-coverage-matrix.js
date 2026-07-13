#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PROTOCOL_VERSION = "agentshell.strategy-coverage-matrix.v1";
const UNKNOWN_STRATEGY = "unknown";

const BENCHMARK_CASE_STRATEGIES = {
  "deep-equal-array-elements": ["deep-equal-array-elements"],
  "deep-equal-array-removal": ["deep-equal-array-removal"],
  "deep-equal-missing-property": ["deep-equal-missing-property"],
  "import-path-typo": ["import-path"],
  "missing-export": ["missing-named-export"],
  "missing-property": ["missing-object-property"],
  "truthy-return": ["truthy-return"],
  "typescript-diagnostic": [
    "typescript-missing-property",
    "typescript-primitive-literal-mismatch",
    "typescript-literal-mismatch"
  ],
  "typescript-property-suggestion": ["typescript-property-suggestion"],
  "wrong-literal": ["literal-replacement"]
};

const DOC_SOURCE_GROUPS = [
  { name: "readme", roots: ["README.md"] },
  { name: "docs", roots: ["docs"] },
  { name: "skill", roots: ["skills/agentshell/SKILL.md"] },
  { name: "manual", roots: ["src/commands/manual.js"] }
];

const UNIT_TEST_ROOTS = ["tests"];
const BENCHMARK_ROOTS = ["examples/benchmark-cases"];
const REAL_PROJECT_MANIFEST = "examples/real-projects.json";
const REAL_PROJECT_ROOTS = ["examples/real-projects"];

export function buildStrategyCoverageMatrix(projectRoot = root) {
  const strategies = readStrategies(projectRoot);
  const unitTestFiles = listFiles(projectRoot, UNIT_TEST_ROOTS)
    .filter((file) => path.basename(file) !== "strategy-coverage-matrix.test.js");
  const benchmarkFiles = listFiles(projectRoot, BENCHMARK_ROOTS);
  const realProjectFiles = listFiles(projectRoot, REAL_PROJECT_ROOTS);
  const docGroups = DOC_SOURCE_GROUPS.map((group) => ({
    ...group,
    files: listFiles(projectRoot, group.roots)
  }));
  const realProjectManifest = readJson(path.join(projectRoot, REAL_PROJECT_MANIFEST));

  const rows = strategies.map((strategy) => {
    const unitTests = exactTextMatches(projectRoot, unitTestFiles, strategy);
    const benchmarkCases = benchmarkMatches(projectRoot, benchmarkFiles, strategy);
    const realProjectFixtures = realProjectMatches(projectRoot, realProjectFiles, realProjectManifest, strategy);
    const docs = docsMatches(projectRoot, docGroups, strategy);

    return {
      strategy,
      coverage: {
        unitTests: unitTests.length > 0,
        benchmarkCases: benchmarkCases.length > 0,
        realProjectFixtures: realProjectFixtures.length > 0,
        docs: docs.matches.length > 0
      },
      matches: {
        unitTests,
        benchmarkCases,
        realProjectFixtures,
        docs
      }
    };
  });

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      strategyEnum: "schemas/change-suggest.schema.json#/properties/strategy/enum",
      unitTests: UNIT_TEST_ROOTS,
      benchmarkCases: BENCHMARK_ROOTS,
      realProjectFixtures: [REAL_PROJECT_MANIFEST, ...REAL_PROJECT_ROOTS],
      docs: DOC_SOURCE_GROUPS.map((group) => group.name)
    },
    summary: summarize(rows),
    strategies: rows
  };
}

function readStrategies(projectRoot) {
  const schema = readJson(path.join(projectRoot, "schemas", "change-suggest.schema.json"));
  return schema.properties.strategy.enum.filter((strategy) => strategy !== UNKNOWN_STRATEGY);
}

function summarize(rows) {
  const missing = {
    unitTests: [],
    benchmarkCases: [],
    realProjectFixtures: [],
    docs: []
  };

  for (const row of rows) {
    for (const key of Object.keys(missing)) {
      if (!row.coverage[key]) missing[key].push(row.strategy);
    }
  }

  return {
    totalStrategies: rows.length,
    covered: {
      unitTests: rows.length - missing.unitTests.length,
      benchmarkCases: rows.length - missing.benchmarkCases.length,
      realProjectFixtures: rows.length - missing.realProjectFixtures.length,
      docs: rows.length - missing.docs.length
    },
    missing
  };
}

function benchmarkMatches(projectRoot, files, strategy) {
  const matches = exactTextMatches(projectRoot, files, strategy);
  for (const [caseName, strategies] of Object.entries(BENCHMARK_CASE_STRATEGIES)) {
    if (strategies.includes(strategy) && directoryExists(projectRoot, "examples", "benchmark-cases", caseName)) {
      addUniqueMatch(matches, `examples/benchmark-cases/${caseName}`, "fixture-alias");
    }
  }
  return matches.sort(compareMatches);
}

function realProjectMatches(projectRoot, files, manifest, strategy) {
  const matches = exactTextMatches(projectRoot, files, strategy);
  for (const project of manifest.projects ?? []) {
    if (project.expectedFailureClass === strategy) {
      addUniqueMatch(matches, REAL_PROJECT_MANIFEST, project.id);
      if (project.repoPath && directoryExists(projectRoot, project.repoPath)) {
        addUniqueMatch(matches, project.repoPath, "manifest-repoPath");
      }
    }
  }
  return matches.sort(compareMatches);
}

function docsMatches(projectRoot, docGroups, strategy) {
  const bySource = {};
  const matches = [];
  for (const group of docGroups) {
    bySource[group.name] = exactTextMatches(projectRoot, group.files, strategy);
    matches.push(...bySource[group.name].map((match) => ({ ...match, source: group.name })));
  }
  return {
    bySource,
    matches: matches.sort(compareMatches)
  };
}

function exactTextMatches(projectRoot, files, strategy) {
  const matches = [];
  for (const file of files) {
    const relativePath = path.relative(projectRoot, file);
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(strategy)) {
        addUniqueMatch(matches, relativePath, index + 1);
      }
    });
  }
  return matches.sort(compareMatches);
}

function addUniqueMatch(matches, file, line) {
  if (!matches.some((match) => match.file === file && match.line === line)) {
    matches.push({ file, line });
  }
}

function listFiles(projectRoot, roots) {
  return roots.flatMap((entry) => {
    const absolutePath = path.join(projectRoot, entry);
    if (!fs.existsSync(absolutePath)) return [];
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) return [absolutePath];
    return walkFiles(absolutePath);
  }).filter((file) => /\.(cjs|js|json|md|ts)$/.test(file));
}

function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".agentshell") return [];
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(absolutePath);
    return entry.isFile() ? [absolutePath] : [];
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function directoryExists(projectRoot, ...segments) {
  return fs.existsSync(path.join(projectRoot, ...segments));
}

function compareMatches(left, right) {
  const fileCompare = left.file.localeCompare(right.file);
  if (fileCompare !== 0) return fileCompare;
  return String(left.line).localeCompare(String(right.line), undefined, { numeric: true });
}

if (process.argv[1] === import.meta.filename) {
  console.log(JSON.stringify(buildStrategyCoverageMatrix(), null, 2));
}
