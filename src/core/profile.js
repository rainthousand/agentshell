export function createProfile() {
  const started = process.hrtime.bigint();
  const phases = [];
  return {
    async measure(name, fn) {
      const phaseStarted = process.hrtime.bigint();
      const result = await fn();
      phases.push({
        name,
        durationMs: elapsedMs(phaseStarted)
      });
      return result;
    },
    measureSync(name, fn) {
      const phaseStarted = process.hrtime.bigint();
      const result = fn();
      phases.push({
        name,
        durationMs: elapsedMs(phaseStarted)
      });
      return result;
    },
    report(extra = {}) {
      const totalMs = elapsedMs(started);
      const measuredMs = phases.reduce((total, phase) => total + phase.durationMs, 0);
      return {
        totalMs,
        measuredMs,
        unmeasuredMs: Math.max(0, totalMs - measuredMs),
        phases,
        ...extra
      };
    }
  };
}

export function elapsedMs(started) {
  return Number((process.hrtime.bigint() - started) / 1_000_000n);
}
