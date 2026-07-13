#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const pluginName = "agentshell";
const sourceRoot = path.resolve(import.meta.dirname, "..");
const home = os.homedir();
const pluginTarget = path.join(home, "plugins", pluginName);
const marketplacePath = path.join(home, ".agents", "plugins", "marketplace.json");

const ignored = new Set([
  ".git",
  ".agentshell",
  "artifacts",
  "node_modules"
]);

const marketplaceEntry = {
  name: pluginName,
  source: {
    source: "local",
    path: `./plugins/${pluginName}`
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL"
  },
  category: "Productivity"
};

const plan = {
  ok: true,
  dryRun,
  sourceRoot,
  pluginTarget,
  marketplacePath,
  marketplaceEntry
};

if (!dryRun) {
  fs.rmSync(pluginTarget, { recursive: true, force: true });
  copyDir(sourceRoot, pluginTarget);
  upsertMarketplace(marketplacePath, marketplaceEntry);
}

console.log(JSON.stringify(plan, null, 2));

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(source, target);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      preserveExecutableMode(source, target);
    }
  }
}

function preserveExecutableMode(source, target) {
  const mode = fs.statSync(source).mode;
  if ((mode & 0o111) !== 0) {
    fs.chmodSync(target, mode);
  }
}

function upsertMarketplace(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const marketplace = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {
      name: "personal",
      interface: {
        displayName: "Personal"
      },
      plugins: []
    };

  if (!marketplace.interface) {
    marketplace.interface = { displayName: "Personal" };
  }
  if (!Array.isArray(marketplace.plugins)) {
    marketplace.plugins = [];
  }

  const index = marketplace.plugins.findIndex((plugin) => plugin.name === entry.name);
  if (index >= 0) {
    marketplace.plugins[index] = entry;
  } else {
    marketplace.plugins.push(entry);
  }

  fs.writeFileSync(file, `${JSON.stringify(marketplace, null, 2)}\n`);
}
