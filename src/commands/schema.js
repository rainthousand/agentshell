import fs from "node:fs";
import path from "node:path";
import { fail } from "../core/output.js";
import { resolvePackageRoot } from "../core/package-root.js";

const SCHEMAS = [
  "common",
  "start",
  "understand",
  "doctor",
  "plugin-status",
  "plugin-validate",
  "plugin-release-local",
  "plugin-smoke",
  "manual",
  "read",
  "verify",
  "diagnose",
  "change",
  "change-fill",
  "change-suggest",
  "fix",
  "benchmark",
  "benchmark-suite",
  "strategy-coverage-matrix",
  "strategy-intake",
  "product-readiness",
  "codex-plugin-trial",
  "codex-plugin-trial-template",
  "codex-plugin-trial-plan",
  "codex-plugin-trial-suite",
  "trial-export",
  "trial-status",
  "beta-funnel",
  "dashboard",
  "cold-start-benchmark",
  "real-project-eval",
  "real-project-candidates",
  "adapter-trial",
  "adapter-trial-collect",
  "adapter-trial-suite",
  "metrics",
  "run",
  "run-next",
  "run-clear"
];
const SCHEMA_LIST_PROTOCOL_VERSION = "agentshell.schema-list.v1";
const SCHEMA_GET_PROTOCOL_VERSION = "agentshell.schema-get.v1";

export async function schema(root, action, name) {
  if (action === "list" || !action) {
    return {
      ok: true,
      protocolVersion: SCHEMA_LIST_PROTOCOL_VERSION,
      schemas: SCHEMAS.map((schemaName) => ({
        name: schemaName,
        command: `agentshell schema get ${schemaName}`
      }))
    };
  }

  if (action !== "get") {
    return fail("INVALID_ARGUMENT", "Usage: agentshell schema list OR agentshell schema get <name>");
  }

  if (!SCHEMAS.includes(name)) {
    return fail("SCHEMA_NOT_FOUND", `Unknown schema: ${name}`, {
      available: SCHEMAS
    });
  }

  const schemaPath = path.resolve(root, "schemas", `${name}.schema.json`);
  const fallbackPath = path.join(resolvePackageRoot({ root }), "schemas", `${name}.schema.json`);
  const file = fs.existsSync(schemaPath) ? schemaPath : fallbackPath;
  return {
    protocolVersion: SCHEMA_GET_PROTOCOL_VERSION,
    ...JSON.parse(fs.readFileSync(file, "utf8"))
  };
}
