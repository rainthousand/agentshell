import assert from "node:assert/strict";
import { shout } from "../src/format.js";

assert.equal(shout("ada"), "ADA");
