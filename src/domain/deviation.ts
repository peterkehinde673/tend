/** Domain types for the deterministic deviation engine's output. */

export type DeviationSeverity = 'NORMAL' | 'LOW' | 'MODERATE' | 'HIGH';

/**
 * A single structured, factual observation produced by the deterministic
 * engine. This is NOT prose — it is the trusted evidence that Bedrock is
 * later allowed to reference (see reasoning/contract.ts). No field here may
 * ever be populated with a value the deterministic engine did not itself
 * calculate from stored events/baseline data.
 */
export interface EvidenceItem {
  signal: string; // e.g. "kitchen_presence", "entrance_sequence"
  expectedWindow?: string; // e.g. "07:20-07:45", only for timing/presence signals
  observed: boolean | string; // boolean for presence, string for sequence description
  minutesPastWindow?: number;
  confidence: number; // 0..1, derived from the underlying baseline's confidence
}

export interface DeviationResult {
  householdId: string;
  evaluatedDate: string; // ISO date (yyyy-mm-dd) this result covers
  presenceDeviation: number;
  timingDeviation: number;
  sequenceDeviation: number;
  compositeScore: number;
  severity: DeviationSeverity;
  evidence: EvidenceItem[];
  /** Overall confidence in this result, derived from the underlying baseline confidence. */
  confidence: number;
}
