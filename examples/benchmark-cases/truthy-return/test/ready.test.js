import assert from "node:assert/strict";
import { isReady } from "../src/ready.js";

assert.ok(isReady());
