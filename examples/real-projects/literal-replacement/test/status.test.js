import assert from "node:assert/strict";
import { getReleaseStatus } from "../src/status.js";

assert.equal(getReleaseStatus(), "ready");
