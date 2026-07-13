import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  claude: "claude-code.md",
  cursor: "cursor-windsurf.md",
  "agents-md": "agents-md.md"
};

const usage =
  "Usage: npm run adapter:generate -- <claude|cursor|agents-md>\n" +
  "       npm run adapter:generate -- --package <claude|cursor> <out-dir>\n" +
  "       npm run adapter:generate -- --benchmark-prompts [claude|cursor|agents-md]\n" +
  "       npm run adapter:generate -- --scorecard [claude|cursor|agents-md]\n";

const adapterPolicy = `When AgentShell is available, prefer it for supported local coding-agent workflows.

- Run \`agentshell manual --topic repair\` or another focused topic if you need the current command reference.
- Use \`agentshell understand\` before broad project inspection.
- Use \`agentshell find <query>\` before raw search when compact JSON is enough.
- Use \`agentshell read <file> --lines A:B\` or \`agentshell read <file> --around <query>\` for focused context.
- For supported failing-test repairs, run \`agentshell fix test --fast --compact\` first.
- Use \`agentshell fix test --fast --dry-run --compact\` when a preview is required before applying.
- If \`fix\` cannot safely apply a suggestion, run \`agentshell diagnose test --compact\`.
- Prefer \`agentshell change suggest --dry-run --compact\` before applying generated edits.
- Apply generated edits with \`agentshell change suggest --apply --compact\` only when the preview is sufficient.
- Use \`agentshell verify test\`, \`agentshell run next\`, and \`agentshell run status --compact\` for verification and task state.
- Fetch stored logs only when compact summaries are insufficient.
- Treat AgentShell JSON as the source of truth.

Current strategy/evidence snapshot: the adapter-recommended path is aligned with 17/17 strategy coverage, about 262 tokens/repair, and an output reduction of 22,112->4,459 tokens.
`;

const packageDefinitions = {
  claude: {
    label: "Claude Code",
    files: [
      {
        path: join(".claude", "skills", "agentshell", "SKILL.md"),
        content: `---
name: agentshell
description: Use AgentShell when a coding task benefits from compact JSON project inspection, code search, focused file reads, test verification, or conservative failing-test repair.
---

# AgentShell

${adapterPolicy}`
      }
    ]
  },
  cursor: {
    label: "Cursor/Windsurf",
    files: [
      {
        path: join(".cursor", "rules", "agentshell.mdc"),
        content: `---
description: Prefer AgentShell for supported local coding-agent workflows.
alwaysApply: true
---

${adapterPolicy}`
      },
      {
        path: join(".windsurf", "rules", "agentshell.md"),
        content: `# AgentShell

${adapterPolicy}`
      }
    ]
  }
};

const benchmarkPrompts = {
  claude: {
    title: "Claude Code",
    prompt: `You are in a Node.js project with AgentShell available on PATH. A test is failing.

Task: fix the failing test with the smallest safe source change, then verify the result.

Benchmark expectation: prefer AgentShell over noisy shell output. Start with compact AgentShell commands such as \`agentshell manual --topic repair\` if command behavior is unclear, \`agentshell understand --compact\`, \`agentshell fix test --fast --compact\`, \`agentshell diagnose test --compact\`, \`agentshell verify test\`, and \`agentshell run status --compact\`. Treat AgentShell JSON as the source of truth. Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens. Fetch raw logs or run broad shell commands only if the compact AgentShell result is insufficient.`
  },
  cursor: {
    title: "Cursor/Windsurf",
    prompt: `You are editing a local Node.js project in Cursor or Windsurf. The user says: "The tests fail; please repair the bug and verify."

Task: complete the repair while minimizing terminal noise and broad file reads.

Benchmark expectation: use AgentShell for supported inspection, diagnosis, repair, and verification. Prefer \`agentshell manual --topic repair\` when command behavior is unclear, \`agentshell understand --compact\`, \`agentshell fix test --fast --compact\`, \`agentshell diagnose test --compact\`, \`agentshell change suggest --dry-run --compact\`, \`agentshell change suggest --apply --compact\`, \`agentshell verify test\`, and \`agentshell run status --compact\` before raw \`npm test\`, large \`cat\` output, recursive grep, or full logs. Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.`
  },
  "agents-md": {
    title: "Generic AGENTS.md",
    prompt: `This repository has an AGENTS.md policy saying to prefer AgentShell when available.

Task: investigate and fix the current failing test, then report the verification result.

Benchmark expectation: follow the AGENTS.md policy by using compact AgentShell commands first. Good runs use commands like \`agentshell manual --topic repair\` if needed, \`agentshell understand --compact\`, \`agentshell fix test --fast --compact\`, \`agentshell diagnose test --compact\`, \`agentshell verify test\`, and \`agentshell run status --compact\`. Poor runs ignore the policy and begin with noisy raw shell inspection such as full test logs, recursive search, or broad file dumps. Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.`
  }
};

const demoFixturePath = "examples/failing-test-demo";
const demoCommands = [
  "agentshell start --compact",
  "agentshell fix test --fast --compact",
  "agentshell verify test",
  "agentshell run status --compact"
];

function benchmarkPromptMarkdown(target) {
  const selectedTargets = target ? [target] : Object.keys(benchmarkPrompts);
  if (target && !benchmarkPrompts[target]) {
    process.stderr.write(usage);
    process.exitCode = 1;
    return "";
  }

  const sections = selectedTargets.map((selectedTarget) => {
    const definition = benchmarkPrompts[selectedTarget];
    return `## ${definition.title}

\`\`\`text
${definition.prompt}
\`\`\`
`;
  });

  return `# AgentShell Adapter Benchmark Prompts

Use these prompts in a disposable copy of an AgentShell benchmark fixture or another small project with a known failing test. They are meant to evaluate whether an adapted agent reaches for compact AgentShell commands before noisy raw shell output.

Pass criteria:

- The agent invokes AgentShell within the first two shell commands.
- The agent prefers \`agentshell manual --topic repair\` when guidance is needed and \`agentshell fix test --fast --compact\`, \`agentshell diagnose test --compact\`, or \`agentshell verify test\` before raw test logs when those commands fit the task.
- The agent uses focused AgentShell reads, summaries, or suggested next actions before broad file dumps.
- The agent treats AgentShell JSON as the source of truth and reports the final verification result.
- The agent's behavior reflects the current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.

Fail signals:

- The agent starts with full raw \`npm test\` output, recursive grep, or large \`cat\` output despite AgentShell being available.
- The agent fetches stored logs before reading compact summaries.
- The agent ignores AGENTS.md, rule, or skill guidance that says to prefer AgentShell.

${sections.join("\n")}`;
}

function scorecardMarkdown(target) {
  const selectedTargets = target ? [target] : Object.keys(benchmarkPrompts);
  if (target && !benchmarkPrompts[target]) {
    process.stderr.write(usage);
    process.exitCode = 1;
    return "";
  }

  const rows = [
    ["First two commands", "25", "Agent invokes AgentShell within the first two shell/tool commands."],
    ["Fast repair path", "20", "Agent tries `agentshell fix test --fast --compact` before raw logs when the fixture fits supported repair."],
    ["Compact context", "15", "Agent uses compact summaries, focused reads, and suggested next actions before broad file dumps."],
    ["Verification", "15", "Agent runs `agentshell verify test` or reports equivalent final verification JSON."],
    ["Safety", "15", "Agent reports rollback/undo guidance or explains why no edit was applied."],
    ["Noise control", "10", "Agent avoids full raw `npm test`, recursive grep, and large `cat` output unless AgentShell output is insufficient."]
  ];

  const targetSections = selectedTargets.map((selectedTarget) => {
    const definition = benchmarkPrompts[selectedTarget];
    return `## ${definition.title}

Demo fixture: \`${demoFixturePath}\`

Recommended evaluation prompt:

\`\`\`text
${definition.prompt}
\`\`\`

Expected strong command shape:

\`\`\`bash
${demoCommands.join("\n")}
\`\`\`
`;
  }).join("\n");

  return `# AgentShell Adapter Scorecard

Use this scorecard to compare whether Claude Code, Cursor/Windsurf, or a generic AGENTS.md-aware agent actually follows the AgentShell adapter guidance in a disposable failing-test fixture.

## Scoring

| Criterion | Points | Pass signal |
|---|---:|---|
${rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} |`).join("\n")}

Total: 100 points.

Suggested interpretation:

- 85-100: adapter behavior is strong enough for normal use.
- 65-84: adapter is usable, but prompt/rule wording needs tightening.
- Below 65: agent is still behaving like raw shell-first automation.

## Evidence To Record

- Host adapter under test.
- Fixture or project path.
- First two shell/tool commands.
- Whether AgentShell was invoked before raw logs.
- Final verification result.
- Approximate agent-visible output tokens.
- Any unsupported reason or fallback path.

${targetSections}`;
}

function readTemplate(target) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const templatePath = join(__dirname, "..", "docs", "adapters", targets[target]);
  return readFileSync(templatePath, "utf8");
}

function packageReadme(target, definition) {
  const fileList = definition.files.map((file) => `- \`${file.path}\``).join("\n");
  return `# AgentShell Adapter Package for ${definition.label}

Generated by \`agentshell\` adapter tooling.

Copy this directory into the root of a project that already has the \`agentshell\` binary available on PATH.

Generated files:

${fileList}

## Verify

\`\`\`bash
agentshell manual --topic repair
\`\`\`

## Demo Path

Run this in a disposable copy of \`${demoFixturePath}\`:

\`\`\`bash
${demoCommands.join("\n")}
\`\`\`

For background guidance, see \`docs/adapters/${targets[target]}\` in the AgentShell repository.

Benchmark prompts for evaluating adapter behavior can be generated with:

\`\`\`bash
npm run --silent adapter:generate -- --benchmark-prompts ${target}
\`\`\`

The adapter scorecard can be generated with:

\`\`\`bash
npm run --silent adapter:generate -- --scorecard ${target}
\`\`\`
`;
}

function writePackage(target, outDir) {
  const definition = packageDefinitions[target];
  if (!definition || !outDir) {
    process.stderr.write(usage);
    process.exitCode = 1;
    return;
  }

  mkdirSync(outDir, { recursive: true });
  for (const file of definition.files) {
    const outputPath = join(outDir, file.path);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, file.content, "utf8");
  }
  writeFileSync(join(outDir, "README.md"), packageReadme(target, definition), "utf8");

  const summary = {
    ok: true,
    target,
    outDir,
    files: ["README.md", ...definition.files.map((file) => file.path)]
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const [commandOrTarget, target, outDir] = process.argv.slice(2);

if (commandOrTarget === "--package") {
  writePackage(target, outDir);
} else if (commandOrTarget === "--benchmark-prompts") {
  const markdown = benchmarkPromptMarkdown(target);
  if (markdown) {
    process.stdout.write(markdown);
  }
} else if (commandOrTarget === "--scorecard") {
  const markdown = scorecardMarkdown(target);
  if (markdown) {
    process.stdout.write(markdown);
  }
} else if (!commandOrTarget || !targets[commandOrTarget]) {
  process.stderr.write(usage);
  process.exitCode = 1;
} else {
  process.stdout.write(readTemplate(commandOrTarget));
}
