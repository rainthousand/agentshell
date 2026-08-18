import fs from "node:fs";
import path from "node:path";

const BUILTIN_PROFILES = {
  fast: ["-short", "-failfast"],
  race: ["-race"],
  coverage: ["-covermode=atomic"]
};
const MAX_PATTERN_LENGTH = 256;
const MAX_FUZZ_DURATION_MS = 10 * 60 * 1000;

export function planGoVerification(project, type, options = {}) {
  if (project?.kind !== "go") return null;

  if (type === "test" && options.profile) {
    return planProfile(project, options.profile);
  }
  if (type === "benchmark") return planBenchmark(project, options);
  if (type === "fuzz") return planFuzz(project, options);
  if (type === "generate") return planGenerate(project);
  return null;
}

export function isGoAdvancedType(type) {
  return type === "benchmark" || type === "fuzz" || type === "generate";
}

function planProfile(project, profile) {
  if (!Object.hasOwn(BUILTIN_PROFILES, profile)) {
    return invalid("GO_PROFILE_INVALID", "--profile must be fast, race, or coverage", {
      profile,
      supportedProfiles: Object.keys(BUILTIN_PROFILES)
    });
  }

  const configured = configuredProfileCommand(project, profile);
  if (configured) {
    return success(configured, { cacheable: true });
  }

  const base = project.commands?.test;
  if (!isGoTestCommand(base)) {
    return invalid("GO_PROFILE_UNSUPPORTED", `The ${profile} profile requires a go test command`);
  }
  return success(insertGoTestFlags(base, BUILTIN_PROFILES[profile]), { cacheable: true });
}

function planBenchmark(project, options) {
  const pattern = options.bench === undefined ? "." : options.bench;
  const patternError = validatePattern(pattern, "--bench");
  if (patternError) return patternError;

  return success([
    "go test",
    "-run '^$'",
    `-bench ${shellQuote(pattern)}`,
    "-benchmem",
    packageTargets(project).join(" ")
  ].join(" "), { cacheable: false });
}

function planFuzz(project, options) {
  const targetError = validatePattern(options.fuzz, "--fuzz", { required: true });
  if (targetError) return targetError;

  const duration = options.duration || "10s";
  const durationMs = parseDurationMs(duration);
  if (durationMs === null || durationMs > MAX_FUZZ_DURATION_MS) {
    return invalid(
      "GO_FUZZ_DURATION_INVALID",
      "--duration must be a positive finite duration no longer than 10m (for example 10s or 2m)",
      { duration, maximumDuration: "10m" }
    );
  }

  const packagePlan = resolveFuzzPackage(project, options.package);
  if (!packagePlan.ok) return packagePlan;

  return success([
    "go test",
    "-run '^$'",
    `-fuzz ${shellQuote(options.fuzz)}`,
    `-fuzztime ${shellQuote(duration)}`,
    shellQuote(packagePlan.package)
  ].join(" "), { cacheable: false });
}

function planGenerate(project) {
  return success(`go generate -n ${packageTargets(project).join(" ")}`, {
    cacheable: false
  });
}

function configuredProfileCommand(project, profile) {
  const sources = [
    project.config?.go?.profiles,
    project.config?.profiles,
    project.goConfig?.profiles,
    project.go?.profiles,
    project.profiles
  ];
  for (const profiles of sources) {
    const value = profiles?.[profile];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value?.test === "string" && value.test.trim()) return value.test.trim();
    if (typeof value?.command === "string" && value.command.trim()) return value.command.trim();
    if (typeof value?.commands?.test === "string" && value.commands.test.trim()) {
      return value.commands.test.trim();
    }
  }
  return null;
}

function packageTargets(project) {
  if (project.manifest !== "go.work") return ["./..."];
  const targets = (project.modules || [])
    .filter((module) => module.valid)
    .map((module) => {
      const relative = path.relative(project.root, module.root).split(path.sep).join("/");
      return shellQuote(relative ? `./${relative}/...` : "./...");
    });
  return targets.length > 0 ? targets : ["./..."];
}

function resolveFuzzPackage(project, value) {
  if (typeof value !== "string" || !value.trim()) {
    return invalid(
      "GO_FUZZ_PACKAGE_REQUIRED",
      "--package is required because fuzzing must target exactly one package"
    );
  }
  const packageName = value.trim();
  if (
    packageName !== "." &&
    (!packageName.startsWith("./") ||
      packageName.includes("...") ||
      packageName.includes("\\") ||
      /[\s\0\r\n]/.test(packageName))
  ) {
    return invalid(
      "GO_FUZZ_PACKAGE_INVALID",
      "--package must be one local package such as . or ./internal/parser",
      { package: value }
    );
  }

  const absolute = path.resolve(project.root, packageName);
  let real;
  try {
    real = fs.realpathSync(absolute);
    if (!fs.statSync(real).isDirectory()) throw new Error("not-directory");
  } catch {
    return invalid("GO_FUZZ_PACKAGE_INVALID", "The fuzz package directory does not exist", {
      package: packageName
    });
  }

  const moduleRoots = project.manifest === "go.work"
    ? (project.modules || []).filter((module) => module.valid).map((module) => module.root)
    : [project.root];
  const insideModule = moduleRoots.some((root) => sameOrInside(real, fs.realpathSync(root)));
  if (!insideModule) {
    return invalid(
      "GO_FUZZ_PACKAGE_OUTSIDE_PROJECT",
      "The fuzz package must stay inside a module in the active Go project",
      { package: packageName }
    );
  }

  return { ok: true, package: packageName };
}

function validatePattern(value, flag, options = {}) {
  if (value === undefined && !options.required) return null;
  if (typeof value !== "string" || !value || value.length > MAX_PATTERN_LENGTH || /[\0\r\n]/.test(value)) {
    return invalid(
      options.required ? "GO_FUZZ_TARGET_REQUIRED" : "GO_BENCH_PATTERN_INVALID",
      `${flag} must be a non-empty single-line regex no longer than ${MAX_PATTERN_LENGTH} characters`
    );
  }
  try {
    new RegExp(value);
  } catch {
    return invalid(
      options.required ? "GO_FUZZ_TARGET_INVALID" : "GO_BENCH_PATTERN_INVALID",
      `${flag} must be a valid regular expression`,
      { pattern: value }
    );
  }
  return null;
}

function parseDurationMs(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^([1-9]\d*)(ns|us|µs|ms|s|m|h)$/);
  if (!match) return null;
  const multipliers = {
    ns: 1 / 1_000_000,
    us: 1 / 1_000,
    "µs": 1 / 1_000,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000
  };
  return Number(match[1]) * multipliers[match[2]];
}

function insertGoTestFlags(command, flags) {
  return command.replace(/^(\s*go\s+test)(?=\s|$)/, `$1 ${flags.join(" ")}`);
}

function isGoTestCommand(command) {
  return typeof command === "string" && /^\s*go\s+test(?:\s|$)/.test(command);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function success(command, metadata) {
  return { ok: true, command, ...metadata };
}

function invalid(code, message, details = {}) {
  return { ok: false, code, message, details };
}
