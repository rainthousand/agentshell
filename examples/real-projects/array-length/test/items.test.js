import assert from "node:assert/strict";
import { items } from "../src/items.js";

assert.equal(items().length, 2);
