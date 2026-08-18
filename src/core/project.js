import fs from "node:fs";
import path from "node:path";

import {
  detectPackageManager,
  directTestFileCommand,
  getPackageInfo,
  scriptCommand,
  scriptCommandWithArgs
} from "./package-json.js";
import { loadGoProjectConfig } from "./project-config.js";
import { findUp } from "./workspace.js";

export function getProjectInfo(root) {
  const packagePath = findUp(root, ["package.json"]);
  const goModPath = findUp(root, ["go.mod"]);
  const goWorkPath = findUp(root, ["go.work"]);
  const workspace = goWorkPath ? goWorkspaceInfo(goWorkPath) : null;

  if (!packagePath && !goModPath) return workspace;
  if (!packagePath) {
    const module = goProjectInfo(goModPath);
    return workspaceContains(workspace, module.root) ? workspace : module;
  }
  if (!goModPath) {
    const node = nodeProjectInfo(packagePath);
    if (workspace?.root === node.root && !node.commands.test) return workspace;
    return node;
  }

  const packageRoot = path.dirname(packagePath);
  const goRoot = path.dirname(goModPath);
  if (packageRoot === goRoot) {
    const node = nodeProjectInfo(packagePath);
    if (node.commands.test) return node;
    const module = goProjectInfo(goModPath);
    return workspaceContains(workspace, module.root) ? workspace : module;
  }

  if (isInside(packageRoot, goRoot)) return nodeProjectInfo(packagePath);
  const module = goProjectInfo(goModPath);
  return workspaceContains(workspace, module.root) ? workspace : module;
}

export function projectCommand(project, name) {
  return project?.commands?.[name] || null;
}

export function relatedTestCommand(project, testFile) {
  if (!project || !testFile) return null;
  if (project.kind === "go") {
    if (!testFile.endsWith("_test.go")) return null;
    if (project.commandSources?.test?.kind === "custom") return null;
    const directory = path.dirname(testFile).split(path.sep).join("/");
    const packagePattern = directory === "." ? "." : `./${directory}`;
    return `go test ${shellQuote(packagePattern)}`;
  }

  const script = project.rawScripts.test;
  const direct = directTestFileCommand(script, testFile);
  if (direct) return direct;
  if (!/^\s*(?:vitest|jest|mocha)(?:\s|$)/.test(script)) return null;
  return scriptCommandWithArgs(project.manager, "test", [testFile]);
}

function nodeProjectInfo(manifestPath) {
  const packageInfo = getPackageInfo(path.dirname(manifestPath));
  const manager = detectPackageManager(packageInfo.root);
  const commands = {};
  for (const name of ["test", "lint", "build", "dev"]) {
    if (packageInfo.scripts[name]) commands[name] = scriptCommand(manager, name);
  }
  return {
    kind: "node",
    root: packageInfo.root,
    path: packageInfo.path,
    manifest: "package.json",
    name: packageInfo.name,
    manager,
    commands,
    rawScripts: packageInfo.scripts,
    dependencies: packageInfo.dependencies
  };
}

function goProjectInfo(manifestPath) {
  const root = path.dirname(manifestPath);
  const content = fs.readFileSync(manifestPath, "utf8");
  const moduleName = content.match(/^\s*module\s+(\S+)/m)?.[1] || path.basename(root);
  const defaults = goCommands(["./..."]);
  const config = loadGoProjectConfig(root);
  const commands = { ...defaults, ...config.commands };
  return {
    kind: "go",
    root,
    path: manifestPath,
    manifest: "go.mod",
    name: moduleName,
    manager: "go",
    commands,
    rawScripts: commands,
    dependencies: {},
    commandSources: commandSources(defaults, config.commands),
    profiles: config.profiles,
    issues: config.issues
  };
}

function goWorkspaceInfo(manifestPath) {
  const root = path.dirname(manifestPath);
  const content = fs.readFileSync(manifestPath, "utf8");
  const entries = parseGoWorkUses(content);
  const modules = [];
  const seenRoots = new Set();

  for (const entry of entries) {
    const moduleRoot = path.resolve(root, entry);
    const goModPath = path.join(moduleRoot, "go.mod");
    let resolvedRoot = moduleRoot;
    let valid = false;
    let reason = null;

    try {
      if (moduleRoot !== root && !isInside(moduleRoot, root)) {
        reason = "use-path-outside-workspace";
      } else {
        const stat = fs.statSync(moduleRoot);
        if (!stat.isDirectory()) {
          reason = "use-path-not-directory";
        } else if (!fs.existsSync(goModPath)) {
          reason = "go-mod-missing";
        } else {
          valid = true;
        }
      }
    } catch (error) {
      reason = error?.code === "ENOENT" ? "use-path-missing" : "use-path-unreadable";
    }

    const identity = valid ? fs.realpathSync(resolvedRoot) : null;
    if (identity && seenRoots.has(identity)) continue;
    if (identity) seenRoots.add(identity);
    modules.push({
      path: entry,
      root: resolvedRoot,
      valid,
      reason
    });
  }

  const validModules = modules.filter((module) => module.valid);
  const targets = validModules.map((module) => workspaceModulePattern(root, module.root));
  const defaults = targets.length > 0 ? goCommands(targets) : {};
  const config = loadGoProjectConfig(root);
  const commands = { ...defaults, ...config.commands };
  const issues = modules
    .filter((module) => !module.valid)
    .map((module) => ({
      code: "GO_WORK_USE_INVALID",
      path: module.path,
      reason: module.reason
    }));

  if (entries.length === 0) {
    issues.push({
      code: "GO_WORK_USE_MISSING",
      path: null,
      reason: "no-use-directives"
    });
  }
  issues.push(...config.issues);

  return {
    kind: "go",
    root,
    path: manifestPath,
    manifest: "go.work",
    name: path.basename(root),
    manager: "go",
    commands,
    rawScripts: commands,
    dependencies: {},
    commandSources: commandSources(defaults, config.commands),
    profiles: config.profiles,
    modules,
    issues
  };
}

function parseGoWorkUses(content) {
  const uses = [];
  let inUseBlock = false;

  for (const sourceLine of content.split(/\r?\n/)) {
    let line = stripGoLineComment(sourceLine).trim();
    if (!line) continue;

    if (inUseBlock) {
      const closeIndex = line.indexOf(")");
      const value = closeIndex === -1 ? line : line.slice(0, closeIndex).trim();
      if (value) uses.push(parseGoWorkPath(value));
      if (closeIndex !== -1) inUseBlock = false;
      continue;
    }

    const match = line.match(/^use(?:\s+|$)(.*)$/);
    if (!match) continue;
    line = match[1].trim();
    if (line.startsWith("(")) {
      inUseBlock = true;
      line = line.slice(1).trim();
      const closeIndex = line.indexOf(")");
      const value = closeIndex === -1 ? line : line.slice(0, closeIndex).trim();
      if (value) uses.push(parseGoWorkPath(value));
      if (closeIndex !== -1) inUseBlock = false;
    } else if (line) {
      uses.push(parseGoWorkPath(line));
    }
  }

  return uses.filter(Boolean);
}

function parseGoWorkPath(value) {
  const token = value.trim();
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token);
    } catch {
      return token.slice(1, token.lastIndexOf('"'));
    }
  }
  if (token.startsWith("`")) {
    const end = token.lastIndexOf("`");
    return end > 0 ? token.slice(1, end) : token.slice(1);
  }
  return token.split(/\s+/)[0];
}

function stripGoLineComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "`") {
      quote = quote === char ? null : (quote || char);
      continue;
    }
    if (!quote && char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }
  return line;
}

function workspaceModulePattern(workspaceRoot, moduleRoot) {
  const relative = path.relative(workspaceRoot, moduleRoot).split(path.sep).join("/");
  if (!relative) return "./...";
  if (relative.startsWith("../")) return `${relative}/...`;
  return `./${relative}/...`;
}

function goCommands(targets) {
  const packages = targets.length === 1 && targets[0] === "./..."
    ? "./..."
    : targets.map(shellQuote).join(" ");
  return {
    test: `go test ${packages}`,
    build: `go build ${packages}`,
    lint: `go vet ${packages}`
  };
}

function commandSources(defaults, custom) {
  return Object.fromEntries(Object.keys({ ...defaults, ...custom }).map((name) => [
    name,
    { kind: Object.hasOwn(custom, name) ? "custom" : "default" }
  ]));
}

function workspaceContains(workspace, moduleRoot) {
  return Boolean(workspace?.modules.some(
    (module) => module.valid && samePath(module.root, moduleRoot)
  ));
}

function samePath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
