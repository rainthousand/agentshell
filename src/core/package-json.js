import fs from "node:fs";
import path from "node:path";
import { findUp, readJson } from "./workspace.js";

export function getPackageInfo(root) {
  const packagePath = findUp(root, ["package.json"]);
  if (!packagePath) return null;

  const packageRoot = path.dirname(packagePath);
  const pkg = readJson(packagePath);
  return {
    root: packageRoot,
    path: packagePath,
    name: pkg.name || path.basename(packageRoot),
    scripts: pkg.scripts || {},
    dependencies: {
      ...pkg.dependencies,
      ...pkg.devDependencies
    }
  };
}

export function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(root, "package-lock.json"))) return "npm";
  return "npm";
}

export function scriptCommand(packageManager, scriptName) {
  if (packageManager === "pnpm") return `pnpm ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  if (packageManager === "bun") return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

export function scriptCommandWithArgs(packageManager, scriptName, args) {
  const suffix = args.map(shellQuote).join(" ");
  if (!suffix) return scriptCommand(packageManager, scriptName);
  if (packageManager === "pnpm") return `pnpm ${scriptName} -- ${suffix}`;
  if (packageManager === "yarn") return `yarn ${scriptName} ${suffix}`;
  if (packageManager === "bun") return `bun run ${scriptName} ${suffix}`;
  return `npm run ${scriptName} -- ${suffix}`;
}

export function directTestFileCommand(script, testFile) {
  const match = /^\s*node\s+--test(?:\s+(.+?))?\s*$/.exec(script);
  if (!match) return null;
  const tokens = (match[1] || "").split(/\s+/).filter(Boolean);
  if (tokens.some((token) => token.startsWith("-"))) return null;
  const quoted = shellQuote(testFile);
  return `node --test ${quoted}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
