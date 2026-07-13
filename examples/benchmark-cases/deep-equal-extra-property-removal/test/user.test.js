import assert from "node:assert/strict";
import { createUser } from "../src/user.js";

assert.deepEqual(createUser(), { name: "Ada" });
