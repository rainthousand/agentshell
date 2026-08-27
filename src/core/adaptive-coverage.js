import path from "node:path";

import { readCommandObservations } from "./command-coverage.js";

export const ADAPTIVE_COVERAGE_PROTOCOL_VERSION = "agentshell.adaptive-coverage.v1";

export const DEFAULT_ADAPTIVE_COVERAGE_THRESHOLDS = Object.freeze({
  candidateMinObservations: 2,
  candidateMinPriorityScore: 20,
  promotionMinObservations: 10,
  promotionMinSources: 2,
  promotionMinPriorityScore: 70
});

const MAX_CANDIDATES = 25;
const DEFAULT_CANDIDATES = 10;
const MAX_OBSERVATIONS = 10_000;
const MAX_FAMILY_CHARS = 64;
const FORBIDDEN_INPUT_KEYS = new Set([
  "argv", "args", "arguments", "command", "commandLine", "cwd", "path", "paths",
  "stdout", "stderr", "output", "eventId"
]);

export function adaptiveCoverage(root, options = {}) {
  const thresholds = normalizeAdaptiveCoverageThresholds(options.thresholds);
  const limit = boundedLimit(options.limit);
  const rawObservations = options.observations ?? readCommandObservations(path.resolve(root));
  const normalized = normalizeObservations(rawObservations);
  const unsupported = normalized.filter((entry) => entry.supportedReplacement === false);
  const grouped = groupUnsupportedFamilies(unsupported);
  const scored = grouped.map((group) => buildCandidate(group, unsupported.length, thresholds));
  const discoverable = scored
    .filter((candidate) => candidate.observationCount >= thresholds.candidateMinObservations)
    .filter((candidate) => candidate.priorityScore >= thresholds.candidateMinPriorityScore)
    .sort(compareCandidates);
  const candidates = discoverable.slice(0, limit);
  const promotableCount = discoverable.filter((candidate) => candidate.promotion.status === "eligible").length;

  return {
    ok: true,
    protocolVersion: ADAPTIVE_COVERAGE_PROTOCOL_VERSION,
    status: normalized.length === 0 ? "no-observations" : unsupported.length === 0 ? "covered" : "candidates-available",
    thresholds,
    summary: {
      observationCount: normalized.length,
      unsupportedObservationCount: unsupported.length,
      unsupportedFamilyCount: grouped.length,
      discoverableCandidateCount: discoverable.length,
      promotableCandidateCount: promotableCount
    },
    candidates,
    bounded: {
      candidateLimit: limit,
      returnedCandidateCount: candidates.length,
      omittedCandidateCount: Math.max(0, discoverable.length - candidates.length),
      maximumCandidateLimit: MAX_CANDIDATES,
      maximumInputObservations: MAX_OBSERVATIONS
    },
    privacy: {
      inputContract: "privacy-safe-command-observations",
      includesRawArguments: false,
      includesPaths: false,
      includesOutput: false,
      includesSourceNames: false,
      includesEventIdentifiers: false
    },
    suggestedNextActions: buildNextActions(candidates)
  };
}

export function normalizeAdaptiveCoverageThresholds(overrides = {}) {
  const result = { ...DEFAULT_ADAPTIVE_COVERAGE_THRESHOLDS };
  for (const key of Object.keys(result)) {
    if (overrides?.[key] === undefined) continue;
    const value = Number(overrides[key]);
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${key} must be a non-negative number`);
    if (key !== "candidateMinPriorityScore" && key !== "promotionMinPriorityScore" && !Number.isInteger(value)) {
      throw new TypeError(`${key} must be an integer`);
    }
    if ((key === "candidateMinPriorityScore" || key === "promotionMinPriorityScore") && value > 100) {
      throw new TypeError(`${key} must be between 0 and 100`);
    }
    result[key] = value;
  }
  return result;
}

export function normalizeAdaptiveCoverageInput(value) {
  const observations = Array.isArray(value) ? value : value?.observations;
  if (!Array.isArray(observations)) throw new TypeError("Input must be an observation array or an object containing observations");
  return normalizeObservations(observations);
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  if (observations.length > MAX_OBSERVATIONS) throw new TypeError(`observations cannot exceed ${MAX_OBSERVATIONS} entries`);
  return observations.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Every observation must be an object");
    assertNoSensitiveFields(entry);
    const executable = normalizeFamily(entry.executable);
    if (!executable) throw new TypeError("Every observation requires a privacy-safe executable family");
    if (typeof entry.supportedReplacement !== "boolean") throw new TypeError("Every observation requires supportedReplacement");
    const source = normalizeOpaqueSource(entry.source);
    return {
      executable,
      category: normalizeCategory(entry.category),
      supportedReplacement: entry.supportedReplacement,
      source
    };
  });
}

function assertNoSensitiveFields(value) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_INPUT_KEYS.has(key)) {
      throw new TypeError("Input contains raw command details; provide privacy-safe observations only");
    }
  }
}

function normalizeFamily(value) {
  if (typeof value !== "string") return null;
  const family = value.trim().toLowerCase();
  if (family.length === 0 || family.length > MAX_FAMILY_CHARS) return null;
  if (path.basename(family) !== family || !/^[a-z0-9][a-z0-9+._-]*$/u.test(family)) return null;
  return family;
}

function normalizeCategory(value) {
  const category = typeof value === "string" ? value.trim().toLowerCase() : "unsupported";
  return /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(category) ? category : "unsupported";
}

function normalizeOpaqueSource(value) {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  return value.slice(0, 32);
}

function groupUnsupportedFamilies(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const current = groups.get(observation.executable) || {
      executableFamily: observation.executable,
      categoryCounts: new Map(),
      count: 0,
      sources: new Set()
    };
    current.count += 1;
    current.sources.add(observation.source);
    current.categoryCounts.set(observation.category, (current.categoryCounts.get(observation.category) || 0) + 1);
    groups.set(observation.executable, current);
  }
  return [...groups.values()];
}

function buildCandidate(group, unsupportedCount, thresholds) {
  const sourceCount = group.sources.size;
  const priority = priorityScore(group.count, sourceCount, unsupportedCount, thresholds);
  const category = dominantCategory(group.categoryCounts);
  const checks = [
    promotionCheck("observation-count", group.count, ">=", thresholds.promotionMinObservations),
    promotionCheck("source-diversity", sourceCount, ">=", thresholds.promotionMinSources),
    promotionCheck("priority-score", priority.total, ">=", thresholds.promotionMinPriorityScore)
  ];
  const eligible = checks.every((check) => check.passed);
  const slug = group.executableFamily.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "command";
  return {
    executableFamily: group.executableFamily,
    category,
    observationCount: group.count,
    sourceCount,
    unsupportedSharePercent: percent(group.count, unsupportedCount),
    priorityScore: priority.total,
    scoreComponents: priority.components,
    profileDraft: {
      id: `adaptive-${slug}`,
      match: { executableFamily: group.executableFamily },
      strategy: "bounded-semantic-summary",
      outputContract: { preserveExitStatus: true, maxLines: 80, maxEstimatedTokens: 800 }
    },
    fixtureDraft: {
      id: `adaptive-${slug}-fixture`,
      scenarios: ["successful-noisy-output", "failed-diagnostic-output", "truncated-large-output"],
      requiredAssertions: ["exit-status-preserved", "diagnostic-signal-preserved", "output-budget-enforced"]
    },
    promotion: {
      status: eligible ? "eligible" : "needs-evidence",
      checks
    }
  };
}

function priorityScore(count, sourceCount, unsupportedCount, thresholds) {
  const frequencyTarget = Math.max(1, thresholds.promotionMinObservations);
  const sourceTarget = Math.max(1, thresholds.promotionMinSources);
  const frequency = round(Math.min(50, (count / frequencyTarget) * 50));
  const prevalence = round(Math.min(30, (count / Math.max(1, unsupportedCount)) * 30));
  const sourceDiversity = round(Math.min(20, (sourceCount / sourceTarget) * 20));
  return {
    total: round(frequency + prevalence + sourceDiversity),
    components: { frequency, prevalence, sourceDiversity }
  };
}

function dominantCategory(counts) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || "unsupported";
}

function promotionCheck(id, value, operator, threshold) {
  return { id, passed: value >= threshold, value, operator, threshold };
}

function compareCandidates(left, right) {
  return right.priorityScore - left.priorityScore
    || right.observationCount - left.observationCount
    || left.executableFamily.localeCompare(right.executableFamily);
}

function buildNextActions(candidates) {
  const eligible = candidates.filter((candidate) => candidate.promotion.status === "eligible").length;
  if (eligible > 0) {
    return [{ action: "review-promotable-candidates", candidateCount: eligible, reason: "Candidates passed every evidence gate" }];
  }
  if (candidates.length > 0) {
    return [{ action: "collect-more-observations", candidateCount: candidates.length, reason: "Candidates need more privacy-safe evidence" }];
  }
  return [];
}

function boundedLimit(value) {
  const number = Number(value ?? DEFAULT_CANDIDATES);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError("limit must be a positive integer");
  return Math.min(number, MAX_CANDIDATES);
}

function percent(part, whole) {
  return whole > 0 ? round((part / whole) * 100) : 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
