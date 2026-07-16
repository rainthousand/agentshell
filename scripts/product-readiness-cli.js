#!/usr/bin/env node
import { runProductReadinessCli } from "./product-readiness.js";

process.exitCode = runProductReadinessCli();
