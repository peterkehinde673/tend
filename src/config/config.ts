/**
 * All tunable constants for the baseline and deviation engines live here,
 * in one visible place, per the requirement that weighting must never be
 * hidden inside arbitrary code. Nothing in engine/ should hard-code a
 * threshold or weight that isn't imported from this file.
 */

export interface TendConfig {
  /** Number of 30-minute buckets in a day. Fixed by design (48 = 24h / 30min). */
  bucketsPerDay: number;

  /** Minutes represented by one bucket. */
  bucketMinutes: number;

  /** Default rolling baseline window, in days. Configurable per household. */
  defaultWindowDays: number;

  /** EWMA decay factor for recent-activity-probability. Higher = more weight on recent days. */
  ewmaAlpha: number;

  /**
   * Floor standard deviation used when a signal has near-zero observed
   * variance, to avoid division by a near-zero number when computing
   * z-score-like deviations for extremely regular routines.
   */
  floorStdMinutes: number;

  /** Composite deviation score weights. Must sum to 1.0 (validated at load). */
  deviationWeights: {
    presence: number;
    timing: number;
    sequence: number;
  };

  /** Minimum baseline activity-probability for a bucket to count as "expected" when deriving presence windows. */
  presenceExpectedThreshold: number;

  /** Minimum z-score for a timing deviation to be worth surfacing as structured evidence. */
  timingEvidenceZThreshold: number;

  /** Minimum (1 - observedProbability) score for a sequence transition to be worth surfacing as structured evidence. */
  sequenceEvidenceThreshold: number;

  /**
   * Minimum number of historically observed transitions required at the
   * exact (fromZone, bucket, dayType) granularity before it is trusted on
   * its own. Below this count, the engine falls back to an aggregated
   * zone-level transition distribution (summed across all buckets for that
   * fromZone/dayType) — this is what keeps the sequence model useful even
   * when realistic timing jitter spreads a household's historical
   * transitions across several adjacent buckets rather than one exact slot.
   */
  minTransitionObservationsForBucketLevel: number;

  /** Deviation severity thresholds, applied to the composite score. */
  severityThresholds: {
    low: number; // >= this and < moderate => LOW
    moderate: number; // >= this and < high => MODERATE
    high: number; // >= this => HIGH
  };

  feedback: {
    /** Starting sensitivity multiplier for every signal. */
    defaultMultiplier: number;
    minMultiplier: number;
    maxMultiplier: number;
    /** Size of a single nudge applied when a feedback event qualifies. */
    nudgeStep: number;
    /**
     * Minimum number of corroborating feedback events (same signal, same
     * feedback type) within `corroborationWindowDays` required before a
     * nudge beyond the first minimal step is applied. This is the guard
     * against one mistaken click corrupting the model.
     */
    corroborationCountRequired: number;
    corroborationWindowDays: number;
    /** Fraction of the way back toward 1.0 a "not_useful" nudge decays after `decayHalfLifeDays`. */
    decayHalfLifeDays: number;
  };
}

export const DEFAULT_CONFIG: TendConfig = {
  bucketsPerDay: 48,
  bucketMinutes: 30,
  defaultWindowDays: 14,
  ewmaAlpha: 0.2,
  floorStdMinutes: 10,
  deviationWeights: {
    presence: 0.5,
    timing: 0.3,
    sequence: 0.2,
  },
  presenceExpectedThreshold: 0.5,
  timingEvidenceZThreshold: 1.0,
  sequenceEvidenceThreshold: 0.5,
  minTransitionObservationsForBucketLevel: 3,
  severityThresholds: {
    low: 1.0,
    moderate: 2.0,
    high: 3.0,
  },
  feedback: {
    defaultMultiplier: 1.0,
    minMultiplier: 0.5,
    maxMultiplier: 2.0,
    nudgeStep: 0.1,
    corroborationCountRequired: 2,
    corroborationWindowDays: 30,
    decayHalfLifeDays: 30,
  },
};

export function assertValidConfig(config: TendConfig): void {
  const weightSum =
    config.deviationWeights.presence + config.deviationWeights.timing + config.deviationWeights.sequence;
  if (Math.abs(weightSum - 1.0) > 1e-9) {
    throw new Error(`deviationWeights must sum to 1.0, got ${weightSum}`);
  }
  if (config.feedback.minMultiplier >= config.feedback.maxMultiplier) {
    throw new Error('feedback.minMultiplier must be < feedback.maxMultiplier');
  }
  if (
    config.feedback.defaultMultiplier < config.feedback.minMultiplier ||
    config.feedback.defaultMultiplier > config.feedback.maxMultiplier
  ) {
    throw new Error('feedback.defaultMultiplier must be within [minMultiplier, maxMultiplier]');
  }
}

assertValidConfig(DEFAULT_CONFIG);
