const fs = require("node:fs");

const source = fs.readFileSync("src/user.ts", "utf8");
if (!source.includes('expectStatus("ready")')) {
  console.error("src/user.ts(7,43): error TS2345: Argument of type '\"pending\"' is not assignable to parameter of type '\"ready\"'.");
  process.exit(1);
}
