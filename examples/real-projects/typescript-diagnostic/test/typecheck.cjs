const fs = require("node:fs");

const source = fs.readFileSync("src/user.ts", "utf8");
if (!/return\s*\{[^}]*\bid\s*:/.test(source)) {
  console.error("src/user.ts(6,3): error TS2741: Property 'id' is missing in type '{ name: string; }' but required in type 'User'.");
  process.exit(1);
}
