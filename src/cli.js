#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

main().catch((error) => {
  printJson(fail("UNEXPECTED_ERROR", error.message));
  process.exitCode = 1;
});

async function main() {
  if (command === "--version" || command === "-v" || command === "version") {
    printJson({
      ok: true,
      protocolVersion: "agentshell.version.v1",
      name: "agentshell",
      version: "1.0.0"
    });
  } else if (!command || command === "--help" || command === "-h") {
    const { HELP_COMMANDS } = await import("./core/command-registry.js");
    printJson({ ok: true, name: "agentshell", version: "1.0.0", commands: HELP_COMMANDS });
  } else if (command === "manual") {
    const parsed = parseManualOptions(args.slice(1));
    if (!parsed.ok) {
      printJson(parsed);
      process.exitCode = 2;
    } else {
      const { manual } = await import("./commands/manual.js");
      const result = await manual(parsed.value);
      printJson(result.compact === true && !Object.hasOwn(result, "summary")
        ? { ...result, summary: { status: result.ok === false ? "error" : "ok" } }
        : result);
      process.exitCode = result.ok ? 0 : 2;
    }
  } else {
    await import("./cli-runtime.js");
  }
}

function parseManualOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--topic") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return fail("INVALID_ARGUMENT", "Missing value for --topic");
      options.topic = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--topic=")) {
      options.topic = arg.slice("--topic=".length);
      continue;
    }
    return fail("INVALID_ARGUMENT", `Unknown manual argument: ${arg}`);
  }
  if (options.full && options.topic) return fail("INVALID_ARGUMENT", "Choose either --full or --topic, not both");
  return { ok: true, value: options };
}

function fail(code, message, details = {}, suggestedNextActions = []) {
  return { ok: false, error: { code, message, details, suggestedNextActions } };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
