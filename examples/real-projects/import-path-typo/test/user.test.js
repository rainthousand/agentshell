import assert from "node:assert/strict";
import { makeUser } from "../src/usre.js";

assert.equal(makeUser({ name: "Ada" }).name, "Ada");
