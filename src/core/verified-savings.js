import crypto from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const TIME_BASELINE_MIN_SAMPLES = 3;
const TIME_BASELINE_MAX_SAMPLES = 9;

export function collectVerifiedSavingsContributions(datasets, options = {}) {
  const hashKeys = options.hashKeys === true;
  const operations = new Map();
  const events = new Map();
  const time = new Map();

  for (const dataset of datasets) {
    const workspaceOperations = Array.isArray(dataset.operations) ? dataset.operations : [];
    for (const operation of workspaceOperations) {
      if (operation?.type !== "verify" || !operation.id) continue;
      const key = contributionKey("operation", operation.id, hashKeys);
      const candidate = {
        key,
        at: validDate(operation.createdAt),
        rawChars: nonNegative(operation.rawOutputChars)
      };
      preferContribution(operations, candidate);
    }

    for (const event of Array.isArray(dataset.events) ? dataset.events : []) {
      const operationKeys = [...new Set((event?.operationIds || [])
        .map((id) => contributionKey("operation", id, hashKeys))
        .filter((key) => operations.has(key)))].sort();
      if (operationKeys.length === 0) continue;
      const at = validDate(event.createdAt);
      const compactChars = nonNegative(event.outputChars);
      const identity = [at, event.command || "", compactChars, operationKeys.join(",")].join("|");
      const key = contributionKey("event", identity, true);
      preferContribution(events, { key, at, operationKeys, compactChars });
    }

    for (const contribution of cacheTimeContributions(workspaceOperations, hashKeys)) {
      preferContribution(time, contribution);
    }
  }

  return {
    operations: [...operations.values()],
    events: [...events.values()],
    time: [...time.values()]
  };
}

export function aggregateVerifiedSavings(contributions, options = {}) {
  const now = numericNow(options.now);
  const timeZone = resolvedTimeZone(options.timeZone);
  const today = localDateKey(now, timeZone);
  const dates = lastLocalDates(today, 7);
  const operations = new Map((contributions?.operations || []).map((entry) => [entry.key, entry]));
  const claimedOperations = new Set();
  const seenEvents = new Set();
  const tokenByDate = new Map();

  for (const event of [...(contributions?.events || [])].sort(compareContributions)) {
    if (!event?.key || seenEvents.has(event.key)) continue;
    seenEvents.add(event.key);
    let rawChars = 0;
    for (const key of [...new Set(event.operationKeys || [])]) {
      if (claimedOperations.has(key)) continue;
      const operation = operations.get(key);
      if (!operation) continue;
      claimedOperations.add(key);
      rawChars += nonNegative(operation.rawChars);
    }
    const compactChars = nonNegative(event.compactChars);
    const date = localDateKey(event.at, timeZone);
    const current = tokenByDate.get(date) || { rawChars: 0, compactChars: 0 };
    current.rawChars += rawChars;
    current.compactChars += compactChars;
    tokenByDate.set(date, current);
  }

  const timeByDate = new Map();
  const seenTime = new Set();
  for (const entry of [...(contributions?.time || [])].sort(compareContributions)) {
    if (!entry?.key || seenTime.has(entry.key)) continue;
    seenTime.add(entry.key);
    const date = localDateKey(entry.at, timeZone);
    timeByDate.set(date, (timeByDate.get(date) || 0) + nonNegative(entry.savedMs));
  }

  const tokenAvailable = claimedOperations.size > 0;
  const timeAvailable = seenTime.size > 0;
  const daily = dates.map((date) => savingsPeriod(date, tokenByDate.get(date), timeByDate.get(date)));
  return {
    timeZone,
    today: daily.at(-1),
    last7Days: daily,
    allTime: savingsPeriod(null, combineTokenBuckets(tokenByDate), sumMap(timeByDate)),
    availability: {
      contextTokens: tokenAvailable,
      time: timeAvailable
    },
    methodology: {
      contextTokens: "exact-operation-attribution",
      time: "verified-cache-hit-baseline",
      deduplication: "operation-id",
      contextTokenEstimate: {
        unit: "estimated-token",
        method: "output-chars-divided-by-4",
        charsPerToken: TOKEN_ESTIMATE_CHARS_PER_TOKEN,
        rounding: "ceil"
      },
      timeBaseline: {
        unit: "milliseconds",
        method: "median-recent-non-cache-hit-samples",
        minimumSamples: TIME_BASELINE_MIN_SAMPLES,
        maximumSamples: TIME_BASELINE_MAX_SAMPLES,
        negativeSavings: "clamped-to-zero"
      }
    }
  };
}

export function mergeVerifiedSavingsContributions(values) {
  return {
    operations: deduplicate(values.flatMap((value) => value?.operations || [])),
    events: deduplicate(values.flatMap((value) => value?.events || [])),
    time: deduplicate(values.flatMap((value) => value?.time || []))
  };
}

function cacheTimeContributions(operations, hashKeys) {
  const baselines = new Map();
  const result = [];
  const candidates = operations
    .filter((operation) => operation?.type === "verify" && operation.cacheKey)
    .map((operation, index) => ({ operation, index }))
    .sort((left, right) => (
      Date.parse(validDate(left.operation.createdAt)) - Date.parse(validDate(right.operation.createdAt))
      || String(left.operation.id || "").localeCompare(String(right.operation.id || ""))
      || left.index - right.index
    ));

  for (const { operation } of candidates) {
    if (operation?.type !== "verify" || !operation.cacheKey) continue;
    if (!operation.cacheHit && Number.isFinite(operation.durationMs)) {
      const samples = baselines.get(operation.cacheKey) || [];
      samples.push(nonNegative(operation.durationMs));
      if (samples.length > TIME_BASELINE_MAX_SAMPLES) samples.shift();
      baselines.set(operation.cacheKey, samples);
      continue;
    }
    const samples = baselines.get(operation.cacheKey) || [];
    if (
      !operation.cacheHit
      || !Number.isFinite(operation.durationMs)
      || samples.length < TIME_BASELINE_MIN_SAMPLES
      || !operation.id
    ) continue;
    const baseline = median(samples);
    result.push({
      key: contributionKey("time", operation.id, hashKeys),
      at: validDate(operation.createdAt),
      savedMs: Math.max(0, baseline - nonNegative(operation.durationMs)),
      baselineMs: baseline,
      baselineSampleCount: samples.length,
      baselineMethod: "median-recent-non-cache-hit-samples"
    });
  }
  return result;
}

function savingsPeriod(date, token, timeMs = 0) {
  const rawChars = nonNegative(token?.rawChars);
  const compactChars = nonNegative(token?.compactChars);
  return {
    ...(date ? { date } : {}),
    contextTokens: Math.max(0, estimateTokens(rawChars) - estimateTokens(compactChars)),
    timeMs: nonNegative(timeMs)
  };
}

function combineTokenBuckets(values) {
  let rawChars = 0;
  let compactChars = 0;
  for (const value of values.values()) {
    rawChars += nonNegative(value.rawChars);
    compactChars += nonNegative(value.compactChars);
  }
  return { rawChars, compactChars };
}

function deduplicate(values) {
  const map = new Map();
  for (const value of values) preferContribution(map, value);
  return [...map.values()];
}

function preferContribution(map, candidate) {
  if (!candidate?.key) return;
  const current = map.get(candidate.key);
  if (!current || compareContributionValue(candidate, current) > 0) map.set(candidate.key, candidate);
}

function compareContributionValue(left, right) {
  return nonNegative(left.rawChars || left.compactChars || left.savedMs)
    - nonNegative(right.rawChars || right.compactChars || right.savedMs);
}

function compareContributions(left, right) {
  return Date.parse(left?.at || "") - Date.parse(right?.at || "")
    || String(left?.key || "").localeCompare(String(right?.key || ""));
}

function contributionKey(kind, value, hashKey) {
  const identity = `${kind}:${value}`;
  return hashKey ? crypto.createHash("sha256").update(identity).digest("hex") : identity;
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
  const date = new Date(typeof value === "number" ? value : Date.parse(value || ""));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
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

function validDate(value) {
  return Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : new Date(0).toISOString();
}

function nonNegative(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function estimateTokens(chars) {
  return Math.ceil(nonNegative(chars) / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function sumMap(values) {
  let total = 0;
  for (const value of values.values()) total += nonNegative(value);
  return total;
}
