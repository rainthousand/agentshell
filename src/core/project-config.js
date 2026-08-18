import fs from "node:fs";
import path from "node:path";

const CONFIG_NAME = ".agentshell.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 4096;
const COMMAND_NAMES = new Set([
  "test",
  "build",
  "lint"
]);
const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SUPPORTED_PROFILES = new Set(["fast", "race", "coverage"]);

export function loadGoProjectConfig(root) {
  const configPath = path.join(root, CONFIG_NAME);
  const empty = {
    path: configPath,
    present: false,
    commands: {},
    profiles: {},
    issues: []
  };

  let stat;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return empty;
    return invalidConfig(configPath, "config-unreadable");
  }

  if (stat.isSymbolicLink()) return invalidConfig(configPath, "config-symbolic-link");
  if (!stat.isFile()) return invalidConfig(configPath, "config-not-file");
  if (stat.size > MAX_CONFIG_BYTES) return invalidConfig(configPath, "config-too-large");

  let document;
  try {
    document = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    return invalidConfig(
      configPath,
      error instanceof SyntaxError ? "invalid-json" : "config-unreadable"
    );
  }

  const validation = validateDocument(document);
  if (!validation.ok) return invalidConfig(configPath, validation.reason, validation.field);

  return {
    path: configPath,
    present: true,
    commands: document.go?.commands || {},
    profiles: normalizeProfiles(document.go?.profiles || {}),
    issues: []
  };
}

function validateDocument(document) {
  if (!isPlainObject(document)) return failure("config-not-object");
  if (!hasOnlyKeys(document, ["version", "go"])) return failure("unknown-root-field");
  if (document.version !== 1) return failure("unsupported-version", "version");
  if (document.go === undefined) return success();
  if (!isPlainObject(document.go)) return failure("go-not-object", "go");
  if (!hasOnlyKeys(document.go, ["commands", "profiles"])) return failure("unknown-go-field", "go");

  if (document.go.commands !== undefined) {
    const result = validateCommands(document.go.commands, "go.commands");
    if (!result.ok) return result;
  }

  if (document.go.profiles !== undefined) {
    if (!isPlainObject(document.go.profiles)) {
      return failure("profiles-not-object", "go.profiles");
    }
    for (const [name, profile] of Object.entries(document.go.profiles)) {
      const field = `go.profiles.${name}`;
      if (!PROFILE_NAME.test(name)) return failure("invalid-profile-name", field);
      if (!SUPPORTED_PROFILES.has(name)) return failure("unsupported-profile", field);
      if (!isPlainObject(profile)) return failure("profile-not-object", field);
      if (!hasOnlyKeys(profile, ["commands"])) return failure("unknown-profile-field", field);
      if (!Object.hasOwn(profile, "commands")) return failure("profile-commands-missing", field);
      const result = validateCommands(profile.commands, `${field}.commands`, {
        allowedNames: new Set(["test"])
      });
      if (!result.ok) return result;
      if (Object.keys(profile.commands).length === 0) {
        return failure("commands-empty", `${field}.commands`);
      }
    }
  }

  return success();
}

function validateCommands(commands, field, options = {}) {
  if (!isPlainObject(commands)) return failure("commands-not-object", field);
  const allowedNames = options.allowedNames || COMMAND_NAMES;
  for (const [name, command] of Object.entries(commands)) {
    const commandField = `${field}.${name}`;
    if (!allowedNames.has(name)) return failure("unsupported-command", commandField);
    if (typeof command !== "string") return failure("command-not-string", commandField);
    if (command.length === 0 || command.trim() !== command) {
      return failure("command-not-normalized", commandField);
    }
    if (command.length > MAX_COMMAND_LENGTH) return failure("command-too-long", commandField);
    if (/[\u0000-\u001f\u007f]/.test(command)) {
      return failure("command-control-character", commandField);
    }
  }
  return success();
}

function normalizeProfiles(profiles) {
  return Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [
    name,
    {
      commands: { ...profile.commands },
      commandSources: Object.fromEntries(
        Object.keys(profile.commands).map((command) => [
          command,
          { kind: "profile", profile: name }
        ])
      )
    }
  ]));
}

function invalidConfig(configPath, reason, field = null) {
  return {
    path: configPath,
    present: true,
    commands: {},
    profiles: {},
    issues: [{
      code: "AGENTSHELL_CONFIG_INVALID",
      path: CONFIG_NAME,
      reason,
      field
    }]
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function success() {
  return { ok: true };
}

function failure(reason, field = null) {
  return { ok: false, reason, field };
}
