import assert from "node:assert/strict";
import { format } from "../src/status.js";

assert.equal(format("hello", "there"), "hello there");
