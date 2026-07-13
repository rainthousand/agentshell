import assert from "node:assert/strict";
import { formatStatus } from "../src/status.js";

assert.equal(formatStatus("ready"), "READY");
