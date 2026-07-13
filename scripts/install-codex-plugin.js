#!/usr/bin/env node
import { installOrUpdate } from "./plugin-lifecycle.js";

const result = installOrUpdate({ dryRun: process.argv.includes("--dry-run") });
console.log(JSON.stringify({
  ...result,
  dryRun: process.argv.includes("--dry-run")
}, null, 2));
if (!result.ok) process.exitCode = 1;
