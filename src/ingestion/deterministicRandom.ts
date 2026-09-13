/**
 * Small deterministic PRNG (mulberry32) so the development simulator can
 * produce "realistic-looking" jitter (e.g. household wakes at 07:28 one day,
 * 07:33 the next) while remaining exactly reproducible from a numeric seed.
 * This is NOT used anywhere in the baseline/deviation engine itself — only
 * in the simulator, which is explicitly a development/test tool.
 */
export class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer jitter in [-maxAbs, maxAbs]. */
  jitterMinutes(maxAbs: number): number {
    return Math.round((this.next() * 2 - 1) * maxAbs);
  }
}
