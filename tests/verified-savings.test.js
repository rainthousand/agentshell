import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateVerifiedSavings,
  collectVerifiedSavingsContributions,
  mergeVerifiedSavingsContributions
} from "../src/core/verified-savings.js";

test("verified savings use local calendar boundaries and return seven explicit days", () => {
  const contributions = collectVerifiedSavingsContributions([dataset([
    verification("op-before", "2026-08-23T15:50:00.000Z", 400, 40),
    verification("op-today", "2026-08-23T16:10:00.000Z", 800, 80)
  ])]);
  const report = aggregateVerifiedSavings(contributions, {
    now: Date.parse("2026-08-23T16:30:00.000Z"),
    timeZone: "Asia/Shanghai"
  });

  assert.equal(report.today.date, "2026-08-24");
  assert.equal(report.today.contextTokens, 180);
  assert.deepEqual(report.last7Days.map((day) => day.date), [
    "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
    "2026-08-22", "2026-08-23", "2026-08-24"
  ]);
  assert.equal(report.last7Days.at(-2).contextTokens, 90);
  assert.equal(report.allTime.contextTokens, 270);
  assert.equal(report.timeZone, "Asia/Shanghai");
});

test("the same exact operation and event are deduplicated across workspaces", () => {
  const shared = dataset([verification("shared", "2026-08-24T02:00:00.000Z", 4000, 400)]);
  const first = collectVerifiedSavingsContributions([shared], { hashKeys: true });
  const second = collectVerifiedSavingsContributions([shared], { hashKeys: true });
  const report = aggregateVerifiedSavings(mergeVerifiedSavingsContributions([first, second]), {
    now: Date.parse("2026-08-24T03:00:00.000Z"),
    timeZone: "UTC"
  });

  assert.equal(report.today.contextTokens, 900);
  assert.equal(report.allTime.contextTokens, 900);
});

test("verified cache-hit time is assigned to the hit day and deduplicated by operation", () => {
  const operations = [
    { id: "baseline-1", type: "verify", cacheKey: "test", cacheHit: false, durationMs: 490, createdAt: "2026-08-23T23:56:00.000Z" },
    { id: "baseline-2", type: "verify", cacheKey: "test", cacheHit: false, durationMs: 500, createdAt: "2026-08-23T23:57:00.000Z" },
    { id: "baseline-3", type: "verify", cacheKey: "test", cacheHit: false, durationMs: 510, createdAt: "2026-08-23T23:58:00.000Z" },
    { id: "hit", type: "verify", cacheKey: "test", cacheHit: true, durationMs: 100, rawOutputChars: 1000, createdAt: "2026-08-24T00:02:00.000Z" }
  ];
  const events = [{ command: "verify", outputChars: 100, operationIds: ["hit"], createdAt: "2026-08-24T00:02:00.000Z" }];
  const contribution = collectVerifiedSavingsContributions([{ operations, events }], { hashKeys: true });
  const report = aggregateVerifiedSavings(mergeVerifiedSavingsContributions([contribution, contribution]), {
    now: Date.parse("2026-08-24T12:00:00.000Z"),
    timeZone: "UTC"
  });

  assert.equal(report.today.timeMs, 400);
  assert.equal(report.allTime.timeMs, 400);
  assert.equal(report.availability.time, true);
  assert.deepEqual(report.methodology.contextTokenEstimate, {
    unit: "estimated-token",
    method: "output-chars-divided-by-4",
    charsPerToken: 4,
    rounding: "ceil"
  });
  assert.deepEqual(report.methodology.timeBaseline, {
    unit: "milliseconds",
    method: "median-recent-non-cache-hit-samples",
    minimumSamples: 3,
    maximumSamples: 9,
    negativeSavings: "clamped-to-zero"
  });
});

test("time baseline uses a median so a slow outlier cannot inflate savings", () => {
  const operations = [
    cacheMiss("normal-1", 500, "2026-08-24T00:00:00.000Z"),
    cacheMiss("outlier", 20_000, "2026-08-24T00:01:00.000Z"),
    cacheMiss("normal-2", 520, "2026-08-24T00:02:00.000Z"),
    cacheHit("hit", 100, "2026-08-24T00:03:00.000Z")
  ];

  const contributions = collectVerifiedSavingsContributions([{ operations, events: [] }]);
  assert.equal(contributions.time.length, 1);
  assert.equal(contributions.time[0].baselineMs, 520);
  assert.equal(contributions.time[0].savedMs, 420);
  assert.equal(contributions.time[0].baselineSampleCount, 3);
});

test("time baseline follows operation timestamps rather than input ordering", () => {
  const chronological = [
    cacheMiss("miss-1", 400, "2026-08-24T00:00:00.000Z"),
    cacheMiss("miss-2", 500, "2026-08-24T00:01:00.000Z"),
    cacheMiss("miss-3", 600, "2026-08-24T00:02:00.000Z"),
    cacheHit("hit", 100, "2026-08-24T00:03:00.000Z")
  ];
  const shuffled = [chronological[3], chronological[1], chronological[0], chronological[2]];

  const first = collectVerifiedSavingsContributions([{ operations: chronological, events: [] }]);
  const second = collectVerifiedSavingsContributions([{ operations: shuffled, events: [] }]);
  assert.deepEqual(second.time, first.time);
  assert.equal(first.time[0].savedMs, 400);
});

test("time savings stay unavailable until enough baseline samples exist", () => {
  const operations = [
    cacheMiss("miss-1", 500, "2026-08-24T00:00:00.000Z"),
    cacheMiss("miss-2", 520, "2026-08-24T00:01:00.000Z"),
    cacheHit("early-hit", 100, "2026-08-24T00:02:00.000Z")
  ];
  const contributions = collectVerifiedSavingsContributions([{ operations, events: [] }]);
  const report = aggregateVerifiedSavings(contributions, {
    now: Date.parse("2026-08-24T12:00:00.000Z"),
    timeZone: "UTC"
  });

  assert.deepEqual(contributions.time, []);
  assert.equal(report.allTime.timeMs, 0);
  assert.equal(report.availability.time, false);
});

test("time savings never become negative when a cache hit is slower than its baseline", () => {
  const operations = [
    cacheMiss("miss-1", 400, "2026-08-24T00:00:00.000Z"),
    cacheMiss("miss-2", 500, "2026-08-24T00:01:00.000Z"),
    cacheMiss("miss-3", 600, "2026-08-24T00:02:00.000Z"),
    cacheHit("slow-hit", 900, "2026-08-24T00:03:00.000Z")
  ];
  const contributions = collectVerifiedSavingsContributions([{ operations, events: [] }]);

  assert.equal(contributions.time[0].savedMs, 0);
});

test("time baseline history is bounded to the most recent samples", () => {
  const operations = [
    cacheMiss("old-outlier", 50_000, "2026-08-24T00:00:00.000Z"),
    ...Array.from({ length: 9 }, (_, index) => (
      cacheMiss(`recent-${index}`, 500 + index, `2026-08-24T00:${String(index + 1).padStart(2, "0")}:00.000Z`)
    )),
    cacheHit("hit", 100, "2026-08-24T00:11:00.000Z")
  ];
  const contributions = collectVerifiedSavingsContributions([{ operations, events: [] }]);

  assert.equal(contributions.time[0].baselineSampleCount, 9);
  assert.equal(contributions.time[0].baselineMs, 504);
  assert.equal(contributions.time[0].savedMs, 404);
});

test("cache hits without measured duration do not claim time savings", () => {
  const operations = [
    cacheMiss("miss-1", 400, "2026-08-24T00:00:00.000Z"),
    cacheMiss("miss-2", 500, "2026-08-24T00:01:00.000Z"),
    cacheMiss("miss-3", 600, "2026-08-24T00:02:00.000Z"),
    { id: "unmeasured-hit", type: "verify", cacheKey: "test", cacheHit: true, createdAt: "2026-08-24T00:03:00.000Z" }
  ];

  assert.deepEqual(collectVerifiedSavingsContributions([{ operations, events: [] }]).time, []);
});

test("empty verified history reports zero periods without pretending attribution exists", () => {
  const report = aggregateVerifiedSavings({ operations: [], events: [], time: [] }, {
    now: Date.parse("2026-08-24T12:00:00.000Z"),
    timeZone: "UTC"
  });
  assert.equal(report.today.contextTokens, 0);
  assert.equal(report.today.timeMs, 0);
  assert.equal(report.allTime.contextTokens, 0);
  assert.deepEqual(report.availability, { contextTokens: false, time: false });
});

function verification(id, createdAt, rawOutputChars, outputChars) {
  return {
    operation: { id, type: "verify", rawOutputChars, durationMs: 100, createdAt },
    event: { command: "verify", outputChars, operationIds: [id], createdAt }
  };
}

function dataset(values) {
  return {
    operations: values.map((value) => value.operation),
    events: values.map((value) => value.event)
  };
}

function cacheMiss(id, durationMs, createdAt, cacheKey = "test") {
  return { id, type: "verify", cacheKey, cacheHit: false, durationMs, createdAt };
}

function cacheHit(id, durationMs, createdAt, cacheKey = "test") {
  return { id, type: "verify", cacheKey, cacheHit: true, durationMs, createdAt };
}
