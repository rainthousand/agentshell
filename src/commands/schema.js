import fs from "node:fs";
import path from "node:path";
import { fail } from "../core/output.js";
import { resolvePackageRoot } from "../core/package-root.js";
import { SCHEMA_NAMES } from "../core/command-registry.js";

const SCHEMAS = SCHEMA_NAMES;
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

  const entryRoot = process.env.AGENTSHELL_PACKAGE_ROOT
    || (process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..") : undefined);
  const packageRoot = resolvePackageRoot({ sourceRoot: entryRoot });
  const file = path.join(packageRoot, "schemas", `${name}.schema.json`);
  return {
    protocolVersion: SCHEMA_GET_PROTOCOL_VERSION,
    ...JSON.parse(fs.readFileSync(file, "utf8"))
  };
}
