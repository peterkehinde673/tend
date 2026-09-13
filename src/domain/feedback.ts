/** Domain types for the caregiver feedback loop. */

export type FeedbackType = 'expected' | 'not_useful' | 'keep_watching' | 'unusual';

export const FEEDBACK_TYPES: readonly FeedbackType[] = [
  'expected',
  'not_useful',
  'keep_watching',
  'unusual',
];

export function isFeedbackType(value: unknown): value is FeedbackType {
  return typeof value === 'string' && (FEEDBACK_TYPES as string[]).includes(value);
}

/** One caregiver response to a specific deviation/evidence bundle. */
export interface FeedbackEvent {
  householdId: string;
  deviationId: string;
  feedbackType: FeedbackType;
  /** The evidence `signal` identifiers this feedback applies to. */
  affectedSignals: string[];
  timestamp: string; // ISO 8601
}

/**
 * The per-signal sensitivity multiplier state. This is deliberately SEPARATE
 * from the baseline itself (see domain/baseline.ts) — feedback only ever
 * adjusts how sensitive the deviation *threshold* is for a given signal, it
 * never rewrites the underlying observed-behavior statistics.
 */
export interface SignalSensitivity {
  householdId: string;
  signal: string;
  multiplier: number;
  lastUpdatedAt: string;
  /** Recent feedback events considered for corroboration-gating, most recent first. Bounded length. */
  recentFeedback: FeedbackEvent[];
}
