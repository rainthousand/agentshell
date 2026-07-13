import assert from "node:assert/strict";
import { tags } from "../src/tags.js";

assert.deepEqual(tags(), ["a", "b"]);
