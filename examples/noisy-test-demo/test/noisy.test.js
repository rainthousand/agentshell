import assert from "node:assert/strict";
import { createUser } from "../src/user.js";

for (let i = 1; i <= 300; i += 1) {
  console.log(`setup noise line ${i}: loading fixture chunk ${i}`);
}

const user = createUser({
  name: "Ada",
  email: "ada@example.com"
});

assert.ok(user.id, "Expected user.id to be defined");
