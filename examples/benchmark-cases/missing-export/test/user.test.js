import assert from "node:assert/strict";
import { makeUser } from "../src/user.js";

assert.equal(makeUser({ name: "Ada" }).name, "Ada");
