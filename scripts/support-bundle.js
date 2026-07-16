#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSupportBundle,
  SUPPORT_BUNDLE_PROTOCOL_VERSION
} from "../src/core/support-bundle.js";

export { createSupportBundle, SUPPORT_BUNDLE_PROTOCOL_VERSION };

function parseArgs(argv) {
  const options = { packageDir: null, output: null, format: null, home: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--package-dir", "--output", "--format", "--home"].includes(arg)) {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw argumentError("INVALID_ARGUMENT", `${arg} requires a value`);
      const key = { "--package-dir": "packageDir", "--output": "output", "--format": "format", "--home": "home" }[arg];
      options[key] = argv[++index];
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw argumentError("INVALID_ARGUMENT", `Unknown argument: ${arg}`);
  }
  return options;
}

function argumentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const mainFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (mainFile === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = options.help ? {
      ok: true,
      protocolVersion: SUPPORT_BUNDLE_PROTOCOL_VERSION,
      usage: "node scripts/support-bundle.js --package-dir <delivery-dir> --output <bundle.json|bundle.zip> [--format json|zip] [--home <home>] [--dry-run]"
    } : createSupportBundle(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      protocolVersion: SUPPORT_BUNDLE_PROTOCOL_VERSION,
      error: { code: error.code || "SUPPORT_BUNDLE_FAILED", message: error.message }
    })}\n`);
    process.exitCode = 1;
  }
}
