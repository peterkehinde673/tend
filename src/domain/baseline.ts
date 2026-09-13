/** Domain types for the personalized, per-household activity baseline. */

export type DayType = 'weekday' | 'weekend';

/** A single 30-minute-bucket statistic for one (deviceId/zoneId, dayType) pair. */
export interface BucketStat {
  bucketIndex: number; // 0..47
  dayType: DayType;

  /** Number of historical days in the window where this bucket was observed at all. */
  daysObserved: number;

  /** EWMA-smoothed probability that activity occurs in this bucket (0..1). */
  activityProbability: number;

  /** Raw count of events ever seen in this bucket across the window (diagnostic only, not used directly in scoring). */
  totalEventCount: number;

  /** Mix of event types seen in this bucket, for transparency/debugging. */
  eventTypeMix: Partial<Record<string, number>>;
}

/** Timing statistics for "first activity of the day" per zone/device + dayType. */
export interface TimingStat {
  dayType: DayType;
  /** Mean first-activity time, expressed as minutes since midnight. */
  meanFirstActivityMinutes: number;
  /** Standard deviation of first-activity time, in minutes. */
  stdFirstActivityMinutes: number;
  daysObserved: number;
}

/** First-order transition probability: P(nextZone | currentZone, bucketIndex). */
export interface TransitionStat {
  fromZoneId: string;
  bucketIndex: number;
  dayType: DayType;
  /** Map of next zoneId -> observed probability (sums to <= 1.0; missing mass = "no further activity observed"). */
  nextZoneProbabilities: Record<string, number>;
  observedTransitions: number;
}

/** The full baseline for one household, covering all known devices/zones. */
export interface HouseholdBaseline {
  householdId: string;
  windowDays: number;
  daysObserved: number;

  /** Overall confidence in this baseline, derived from daysObserved / windowDays, clamped to [0,1]. */
  confidence: number;

  /** Keyed by zoneId (falls back to deviceId if no zoneId is set). */
  bucketStats: Record<string, BucketStat[]>;
  timingStats: Record<string, TimingStat[]>;
  transitionStats: TransitionStat[];

  /** ISO timestamp of the most recent event folded into this baseline. */
  lastUpdatedAt: string;
}
