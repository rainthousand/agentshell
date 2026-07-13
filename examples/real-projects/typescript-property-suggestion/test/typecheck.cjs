const fs = require("node:fs");

const source = fs.readFileSync("src/user.ts", "utf8");
if (!source.includes("return `${customer.firstName} ${customer.lastName}`;")) {
  console.error("src/user.ts(9,22): error TS2551: Property 'fristName' does not exist on type 'Customer'. Did you mean 'firstName'?");
  process.exit(1);
}
