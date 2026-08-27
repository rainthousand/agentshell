import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEDGER_VERSION = 1;
const FILTER_BITS = 1 << 23;
const FILTER_HASHES = 7;
const MAX_DAILY_BUCKETS = 400;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function updateVerifiedSavingsLedger(contributions, options = {}) {
  return withVerifiedSavingsLedgerLock(options, () => {
    const ledger = readLedgerUnlocked(options);
    applyContributions(ledger, contributions);
    pruneDailyBuckets(ledger);
    ledger.updatedAt = new Date(options.now ?? Date.now()).toISOString();
    writeLedgerUnlocked(ledger, options);
    return ledgerReport(ledger, options);
  });
}

export function readVerifiedSavingsLedger(options = {}) {
  return withVerifiedSavingsLedgerLock(options, () => {
    const ledger = readLedgerUnlocked(options);
    return ledger.seenCount > 0 || hasSavings(ledger) ? ledgerReport(ledger, options) : null;
  });
}

export function withVerifiedSavingsLedgerLock(options, callback) {
  if (options?.ledgerLockHeld === true) return callback();
  const lock = `${ledgerFile(options)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const timeoutMs = positiveNumber(options?.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const staleMs = positiveNumber(options?.staleLockMs, DEFAULT_STALE_LOCK_MS);
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, "owner"), `${process.pid}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error("Timed out waiting for verified savings ledger lock");
      sleep(10);
    }
  }
  try {
    return callback();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function readLedgerUnlocked(options) {
  const file = ledgerFile(options);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeLedger(value);
  } catch (error) {
    if (error?.code !== "ENOENT") quarantineLedger(file, options);
    return emptyLedger();
  }
}

function normalizeLedger(value) {
  if (value?.version === 0 && Array.isArray(value.seenKeys)) {
    const ledger = emptyLedger();
    ledger.totals = normalizeBucket(value.totals);
    ledger.daily = normalizeDaily(value.daily);
    for (const key of value.seenKeys.filter(validKey).sort()) addFilterKey(ledger, key);
    return ledger;
  }
  if (value?.version !== LEDGER_VERSION || value.filter?.bits !== FILTER_BITS
    || value.filter?.hashes !== FILTER_HASHES || typeof value.filter?.data !== "string") {
    throw new Error("Unsupported verified savings ledger");
  }
  const bytes = Buffer.from(value.filter.data, "base64");
  if (bytes.length !== FILTER_BITS / 8) throw new Error("Invalid verified savings ledger filter");
  return {
    version: LEDGER_VERSION,
    updatedAt: validDate(value.updatedAt),
    totals: normalizeBucket(value.totals),
    daily: normalizeDaily(value.daily),
    seenCount: nonNegativeInteger(value.seenCount),
    filter: { bits: FILTER_BITS, hashes: FILTER_HASHES, data: bytes.toString("base64") }
  };
}

function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    updatedAt: new Date(0).toISOString(),
    totals: emptyBucket(),
    daily: {},
    seenCount: 0,
    filter: {
      bits: FILTER_BITS,
      hashes: FILTER_HASHES,
      data: Buffer.alloc(FILTER_BITS / 8).toString("base64")
    }
  };
}

function applyContributions(ledger, contributions) {
  ledger.filterBytes = Buffer.from(ledger.filter.data, "base64");
  const operations = new Map((contributions?.operations || [])
    .filter((entry) => validKey(entry?.key))
    .map((entry) => [entry.key, entry]));
  const events = [...(contributions?.events || [])]
    .filter((entry) => validKey(entry?.key))
    .sort(compareContributions);

  for (const event of events) {
    if (hasFilterKey(ledger, event.key)) continue;
    addFilterKey(ledger, event.key);
    let rawChars = 0;
    for (const operationKey of [...new Set(event.operationKeys || [])].sort()) {
      const operation = operations.get(operationKey);
      if (!operation || hasFilterKey(ledger, operationKey)) continue;
      addFilterKey(ledger, operationKey);
      rawChars += nonNegative(operation.rawChars);
    }
    addSavings(ledger, event.at, {
      rawChars,
      compactChars: nonNegative(event.compactChars),
      timeMs: 0
    });
  }

  for (const entry of [...(contributions?.time || [])]
    .filter((item) => validKey(item?.key)).sort(compareContributions)) {
    if (hasFilterKey(ledger, entry.key)) continue;
    addFilterKey(ledger, entry.key);
    addSavings(ledger, entry.at, { rawChars: 0, compactChars: 0, timeMs: nonNegative(entry.savedMs) });
  }
  ledger.filter.data = ledger.filterBytes.toString("base64");
  delete ledger.filterBytes;
}

function addSavings(ledger, at, savings) {
  addBucket(ledger.totals, savings);
  const date = dateKey(at);
  ledger.daily[date] ||= emptyBucket();
  addBucket(ledger.daily[date], savings);
}

function addBucket(target, value) {
  target.rawChars += nonNegative(value.rawChars);
  target.compactChars += nonNegative(value.compactChars);
  target.timeMs += nonNegative(value.timeMs);
}

function addFilterKey(ledger, key) {
  const bytes = ledger.filterBytes || Buffer.from(ledger.filter.data, "base64");
  for (const bit of filterPositions(key)) bytes[bit >> 3] |= 1 << (bit & 7);
  ledger.seenCount += 1;
}

function hasFilterKey(ledger, key) {
  const bytes = ledger.filterBytes || Buffer.from(ledger.filter.data, "base64");
  return filterPositions(key).every((bit) => (bytes[bit >> 3] & (1 << (bit & 7))) !== 0);
}

function filterPositions(key) {
  const digest = crypto.createHash("sha256").update(key).digest();
  const first = digest.readUInt32BE(0);
  const second = digest.readUInt32BE(4) || 0x9e3779b9;
  return Array.from({ length: FILTER_HASHES }, (_, index) => (
    (first + (index * second) + (index * index)) % FILTER_BITS
  ));
}

function pruneDailyBuckets(ledger) {
  const dates = Object.keys(ledger.daily).sort();
  for (const date of dates.slice(0, Math.max(0, dates.length - MAX_DAILY_BUCKETS))) delete ledger.daily[date];
}

function ledgerReport(ledger, options) {
  const now = numericNow(options.now);
  const timeZone = resolvedTimeZone(options.timeZone);
  const today = localDateKey(now, timeZone);
  const dates = lastLocalDates(today, 7);
  const period = (date, bucket = emptyBucket()) => ({
    ...(date ? { date } : {}),
    contextTokens: savedTokens(bucket),
    timeMs: nonNegative(bucket.timeMs)
  });
  return {
    timeZone,
    today: period(today, ledger.daily[today]),
    last7Days: dates.map((date) => period(date, ledger.daily[date])),
    allTime: period(null, ledger.totals),
    availability: {
      contextTokens: ledger.totals.rawChars > 0,
      time: ledger.totals.timeMs > 0
    },
    methodology: {
      contextTokens: "durable-exact-operation-attribution",
      time: "durable-verified-cache-hit-baseline",
      deduplication: "bounded-deterministic-hash-filter"
    }
  };
}

function writeLedgerUnlocked(ledger, options) {
  const file = ledgerFile(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(ledger)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch {}
}

function quarantineLedger(file, options) {
  try {
    const directory = path.join(path.dirname(file), ".quarantine");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.renameSync(file, path.join(directory, `verified-savings-ledger.${Date.now()}.${crypto.randomUUID()}.bad`));
  } catch {}
}

function ledgerFile(options = {}) {
  const home = path.resolve(options.homeDir || options.home || os.homedir());
  return path.join(home, ".agentshell", "verified-savings-ledger.json");
}

function normalizeDaily(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .map(([key, bucket]) => [key, normalizeBucket(bucket)]));
}

function normalizeBucket(value) {
  return {
    rawChars: nonNegative(value?.rawChars),
    compactChars: nonNegative(value?.compactChars),
    timeMs: nonNegative(value?.timeMs)
  };
}

function emptyBucket() {
  return { rawChars: 0, compactChars: 0, timeMs: 0 };
}

function savedTokens(bucket) {
  return Math.max(0, Math.ceil(nonNegative(bucket.rawChars) / 4) - Math.ceil(nonNegative(bucket.compactChars) / 4));
}

function hasSavings(ledger) {
  return ledger.totals.rawChars > 0 || ledger.totals.compactChars > 0 || ledger.totals.timeMs > 0;
}

function validKey(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function compareContributions(left, right) {
  return Date.parse(left?.at || "") - Date.parse(right?.at || "")
    || String(left?.key || "").localeCompare(String(right?.key || ""));
}

function dateKey(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "1970-01-01";
}

function validDate(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function resolvedTimeZone(value) {
  const timeZone = value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function localDateKey(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function lastLocalDates(today, count) {
  const [year, month, day] = today.split("-").map(Number);
  const anchor = Date.UTC(year, month - 1, day);
  return Array.from({ length: count }, (_, index) => (
    new Date(anchor - ((count - index - 1) * DAY_MS)).toISOString().slice(0, 10)
  ));
}

function numericNow(value) {
  const parsed = value instanceof Date ? value.getTime() : Number(value ?? Date.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function nonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function nonNegativeInteger(value) {
  return Math.floor(nonNegative(value));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
