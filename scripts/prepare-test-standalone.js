#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "bin", "agentshell-darwin-arm64");

if (/\s/u.test(process.execPath)) {
  throw new Error("The test standalone launcher requires a Node path without whitespace.");
}

const cli = pathToFileURL(path.join(root, "src", "cli.js")).href;
const launcher = [
  `#!${process.execPath}`,
  `process.env.AGENTSHELL_PACKAGE_ROOT ||= ${JSON.stringify(root)};`,
  `await import(${JSON.stringify(cli)});`,
  ""
].join("\n");
fs.writeFileSync(output, launcher, { mode: 0o755 });
fs.chmodSync(output, 0o755);

console.log(JSON.stringify({
  ok: true,
  protocolVersion: "agentshell.test-standalone.v1",
  output,
  runtimeDependency: true
}));
