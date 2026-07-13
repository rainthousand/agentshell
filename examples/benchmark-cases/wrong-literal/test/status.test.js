import assert from "node:assert/strict";
import { getStatus } from "../src/status.js";

assert.equal(getStatus(), "ready");
