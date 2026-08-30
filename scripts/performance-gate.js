import { performance } from "node:perf_hooks";

const ISOLATED_MODE = "isolated";
const REPORT_SCHEMA_VERSION = 1;

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function percentile(sorted, quantile) {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Summarize isolated samples without treating one noisy host measurement as a
 * baseline. The median is the primary signal and p95 is a bounded variance
 * check; both are calculated from the same fresh-process sample set.
 */
export function summarizeDurations(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("performance samples must be a non-empty array");
  }
  samples.forEach((sample, index) => assertFiniteNumber(sample, `sample ${index}`));
  const sorted = [...samples].sort((left, right) => left - right);
  const median = percentile(sorted, 0.5);
  const deviations = sorted
    .map((sample) => Math.abs(sample - median))
    .sort((left, right) => left - right);
  return {
    min: rounded(sorted[0]),
    max: rounded(sorted[sorted.length - 1]),
    median: rounded(median),
    p95: rounded(percentile(sorted, 0.95)),
    mad: rounded(percentile(deviations, 0.5)),
  };
}

function normalizeWork(work) {
  if (work === undefined) return {};
  if (work === null || typeof work !== "object" || Array.isArray(work)) {
    throw new TypeError("performance work must be an object");
  }
  const normalized = {};
  for (const [name, value] of Object.entries(work)) {
    assertFiniteNumber(value, `work.${name}`);
    if (value < 0) throw new TypeError(`work.${name} must not be negative`);
    normalized[name] = value;
  }
  return normalized;
}

function accumulateWork(target, work) {
  for (const [name, value] of Object.entries(normalizeWork(work))) {
    target[name] = (target[name] ?? 0) + value;
  }
}

function assertBudgetNumber(budget, name) {
  assertFiniteNumber(budget[name], `budget.${name}`);
  if (budget[name] < 0) throw new TypeError(`budget.${name} must not be negative`);
}

/**
 * Apply a scenario's stable gate to a completed report.
 *
 * Duration ceilings are deliberately checked against robust summary values;
 * exact work budgets catch ambient scans and repeated discovery independently
 * of host speed.
 */
export function assertPerformanceGate({ report, budget }) {
  if (!report || typeof report !== "object") {
    throw new TypeError("performance report must be an object");
  }
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new TypeError("performance budget must be an object");
  }
  const failures = [];
  const stats = report.duration_stats_ms;
  if (!stats || typeof stats !== "object") {
    throw new TypeError("performance report is missing duration statistics");
  }
  for (const name of ["maxMedianMs", "maxP95Ms", "maxMadMs"]) {
    if (budget[name] === undefined) continue;
    assertBudgetNumber(budget, name);
  }
  if (budget.maxMedianMs !== undefined && stats.median > budget.maxMedianMs) {
    failures.push(
      `median ${stats.median}ms exceeds ${budget.maxMedianMs}ms`,
    );
  }
  if (budget.maxP95Ms !== undefined && stats.p95 > budget.maxP95Ms) {
    failures.push(`p95 ${stats.p95}ms exceeds ${budget.maxP95Ms}ms`);
  }
  if (budget.maxMadMs !== undefined && stats.mad > budget.maxMadMs) {
    failures.push(`mad ${stats.mad}ms exceeds ${budget.maxMadMs}ms`);
  }

  const actualWork = normalizeWork(report.work);
  for (const [name, expected] of Object.entries(budget.exactWork ?? {})) {
    assertFiniteNumber(expected, `budget.exactWork.${name}`);
    if (expected < 0) throw new TypeError(`budget.exactWork.${name} must not be negative`);
    if (actualWork[name] !== expected) {
      failures.push(
        `work.${name} is ${actualWork[name] ?? "missing"}; expected exactly ${expected}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`performance gate failed for ${report.scenario}: ${failures.join("; ")}`);
  }
  return report;
}

/**
 * Run one scenario's setup and operation in a process that the runner has
 * marked as isolated, then emit one structured report after the gate passes.
 * The operation returns its work counters; this module excludes warmup work
 * and aggregates measured work so scenarios do not own that lifecycle policy.
 */
export async function runPerformanceScenario({
  scenario,
  lane,
  iterations = 5,
  warmupIterations = 1,
  budget,
  setup,
  measure,
  reportWork,
  cleanup,
}) {
  if (process.env.SKILL_CUSTOMIZATION_PERFORMANCE_MODE !== ISOLATED_MODE) {
    throw new Error("performance scenarios must use scripts/run-performance.js");
  }
  if (typeof scenario !== "string" || !scenario) {
    throw new TypeError("performance scenario requires a name");
  }
  if (typeof lane !== "string" || !lane) {
    throw new TypeError("performance scenario requires a lane");
  }
  assertPositiveInteger(iterations, "iterations");
  assertNonNegativeInteger(warmupIterations, "warmupIterations");
  if (typeof setup !== "function" || typeof measure !== "function") {
    throw new TypeError("performance scenario requires setup and measure functions");
  }
  if (reportWork !== undefined && typeof reportWork !== "function") {
    throw new TypeError("performance scenario reportWork must be a function");
  }
  if (cleanup !== undefined && typeof cleanup !== "function") {
    throw new TypeError("performance scenario cleanup must be a function");
  }

  const state = await setup();
  try {
    for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
      await measure(state, { iteration });
    }
    const samples = [];
    const measuredWork = Object.fromEntries(
      Object.keys(budget?.exactWork ?? {}).map((name) => [name, 0]),
    );
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const started = performance.now();
      const iterationWork = await measure(state, { iteration });
      samples.push(performance.now() - started);
      accumulateWork(measuredWork, iterationWork);
    }
    const supplementalWork = normalizeWork(
      reportWork ? await reportWork(state) : undefined,
    );
    for (const name of Object.keys(supplementalWork)) {
      if (measuredWork[name] !== undefined) {
        throw new Error(`performance reportWork duplicates measured work.${name}`);
      }
    }
    const durationStats = summarizeDurations(samples);
    const report = {
      schema_version: REPORT_SCHEMA_VERSION,
      mode: ISOLATED_MODE,
      isolation: "fresh-process",
      lane,
      scenario,
      iterations,
      warmup_iterations: warmupIterations,
      duration_ms: durationStats.median,
      duration_stats_ms: durationStats,
      budget: structuredClone(budget ?? {}),
      work: { ...measuredWork, ...supplementalWork },
    };
    assertPerformanceGate({ report, budget: budget ?? {} });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  } finally {
    await cleanup?.(state);
  }
}
