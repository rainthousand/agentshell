import assert from "node:assert/strict";
import { createUser } from "../src/user.js";

const user = createUser({ name: "Ada", email: "ada@example.com" });
assert.ok(user.id, "Expected user.id to be present");
