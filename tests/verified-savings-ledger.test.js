import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readVerifiedSavingsLedger,
  updateVerifiedSavingsLedger
} from "../src/core/verified-savings-ledger.js";

const moduleFile = fileURLToPath(new URL("../src/core/verified-savings-ledger.js", import.meta.url));

test("ledger deterministically deduplicates contributions without storing paths or content", () => {
  const home = temporaryHome("private");
  const contributions = fixtureContributions("private", 4_000, 400);
  const first = updateVerifiedSavingsLedger(contributions, { home, now: Date.parse("2026-08-27T12:00:00Z"), timeZone: "UTC" });
  const second = updateVerifiedSavingsLedger(contributions, { home, now: Date.parse("2026-08-27T12:01:00Z"), timeZone: "UTC" });

  assert.equal(first.allTime.contextTokens, 900);
  assert.equal(second.allTime.contextTokens, 900);
  const file = ledgerFile(home);
  const stored = fs.readFileSync(file, "utf8");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(stored) < 1_500_000);
  assert.doesNotMatch(stored, /private-workspace|secret command output|operation:private/);
});

test("legacy exact-key ledger migrates to the bounded v1 representation", () => {
  const home = temporaryHome("migration");
  const file = ledgerFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 0,
    totals: { rawChars: 8_000, compactChars: 800, timeMs: 250 },
    daily: { "2026-08-27": { rawChars: 8_000, compactChars: 800, timeMs: 250 } },
    seenKeys: [key("legacy")]
  })}\n`, { mode: 0o600 });

  const report = updateVerifiedSavingsLedger({ operations: [], events: [], time: [] }, {
    home,
    now: Date.parse("2026-08-27T12:00:00Z"),
    timeZone: "UTC"
  });
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(report.allTime.contextTokens, 1_800);
  assert.equal(report.allTime.timeMs, 250);
  assert.equal(stored.version, 1);
  assert.equal("seenKeys" in stored, false);
  assert.equal(typeof stored.filter.data, "string");
});

test("corrupt ledger is quarantined and rebuilt from verified contributions", () => {
  const home = temporaryHome("corrupt");
  const file = ledgerFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, "{not-json\n", { mode: 0o600 });

  const report = updateVerifiedSavingsLedger(fixtureContributions("rebuild", 2_000, 200), {
    home,
    now: Date.parse("2026-08-27T12:00:00Z"),
    timeZone: "UTC"
  });
  assert.equal(report.allTime.contextTokens, 450);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);
  const quarantine = path.join(home, ".agentshell", ".quarantine");
  assert.equal(fs.readdirSync(quarantine).length, 1);
});

test("concurrent process updates are atomic and do not lose or double-count savings", async () => {
  const home = temporaryHome("concurrent");
  const identities = ["shared", "shared", "one", "two", "three", "four", "five", "six"];
  await Promise.all(identities.map((identity) => runLedgerChild(home, identity)));

  const report = readVerifiedSavingsLedger({
    home,
    now: Date.parse("2026-08-27T12:00:00Z"),
    timeZone: "UTC"
  });
  assert.equal(report.allTime.contextTokens, 7 * 225);
  const stored = JSON.parse(fs.readFileSync(ledgerFile(home), "utf8"));
  assert.equal(stored.totals.rawChars, 7_000);
  assert.equal(stored.totals.compactChars, 700);
  assert.equal(fs.existsSync(`${ledgerFile(home)}.lock`), false);
});

function runLedgerChild(home, identity) {
  const script = `
    import { updateVerifiedSavingsLedger } from ${JSON.stringify(new URL(`file://${moduleFile}`).href)};
    import crypto from "node:crypto";
    const key = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const id = process.argv[1];
    updateVerifiedSavingsLedger({
      operations: [{ key: key("operation:" + id), at: "2026-08-27T10:00:00.000Z", rawChars: 1000 }],
      events: [{ key: key("event:" + id), at: "2026-08-27T10:00:01.000Z", operationKeys: [key("operation:" + id)], compactChars: 100 }],
      time: []
    }, { home: process.argv[2], timeZone: "UTC" });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, identity, home], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `child exited ${code}`)));
  });
}

function fixtureContributions(identity, rawChars, compactChars) {
  const operationKey = key(`operation:${identity}`);
  return {
    operations: [{ key: operationKey, at: "2026-08-27T10:00:00.000Z", rawChars }],
    events: [{
      key: key(`event:${identity}`),
      at: "2026-08-27T10:00:01.000Z",
      operationKeys: [operationKey],
      compactChars
    }],
    time: []
  };
}

function key(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ledgerFile(home) {
  return path.join(home, ".agentshell", "verified-savings-ledger.json");
}

function temporaryHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentshell-ledger-${name}-`));
}
