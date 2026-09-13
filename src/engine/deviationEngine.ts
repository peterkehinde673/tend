import { TendEvent } from '../domain/event';
import { HouseholdBaseline, DayType } from '../domain/baseline';
import { DeviationResult, DeviationSeverity, EvidenceItem } from '../domain/deviation';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';

interface ExpectedWindow {
  signalKey: string;
  startBucket: number;
  endBucket: number;
  avgProbability: number;
}

function dayTypeFor(date: Date): DayType {
  const day = date.getUTCDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

function minutesSinceMidnightUtc(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function bucketIndexFor(minutesSinceMidnight: number, config: TendConfig): number {
  const idx = Math.floor(minutesSinceMidnight / config.bucketMinutes);
  return Math.max(0, Math.min(config.bucketsPerDay - 1, idx));
}

function bucketToTimeLabel(bucketIndex: number, config: TendConfig): string {
  const totalMinutes = bucketIndex * config.bucketMinutes;
  const hh = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0');
  const mm = (totalMinutes % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Derives contiguous "expected activity windows" for a signal/dayType from
 * its baseline bucket statistics: consecutive buckets whose EWMA activity
 * probability meets or exceeds PRESENCE_EXPECTED_THRESHOLD are merged into
 * one window. Exported so the algorithm can be unit-tested directly against
 * a known baseline.
 */
export function deriveExpectedWindows(
  baseline: HouseholdBaseline,
  dayType: DayType,
  config: TendConfig = DEFAULT_CONFIG,
): ExpectedWindow[] {
  const windows: ExpectedWindow[] = [];

  for (const [signalKey, stats] of Object.entries(baseline.bucketStats)) {
    const relevant = stats
      .filter((s) => s.dayType === dayType)
      .sort((a, b) => a.bucketIndex - b.bucketIndex);

    let current: { start: number; end: number; probs: number[] } | null = null;

    for (const stat of relevant) {
      if (stat.activityProbability >= config.presenceExpectedThreshold) {
        if (current && stat.bucketIndex === current.end + 1) {
          current.end = stat.bucketIndex;
          current.probs.push(stat.activityProbability);
        } else {
          if (current) {
            windows.push(toWindow(signalKey, current));
          }
          current = { start: stat.bucketIndex, end: stat.bucketIndex, probs: [stat.activityProbability] };
        }
      } else if (current) {
        windows.push(toWindow(signalKey, current));
        current = null;
      }
    }
    if (current) {
      windows.push(toWindow(signalKey, current));
    }
  }

  return windows;
}

function toWindow(signalKey: string, current: { start: number; end: number; probs: number[] }): ExpectedWindow {
  return {
    signalKey,
    startBucket: current.start,
    endBucket: current.end,
    avgProbability: current.probs.reduce((a, b) => a + b, 0) / current.probs.length,
  };
}

/**
 * Resolves the transition distribution to use for a given (fromZone,
 * bucket, dayType) context. If the exact bucket-level data meets the
 * configured minimum observation count, it is used directly (most
 * time-specific). Otherwise, all buckets for the same fromZone/dayType are
 * aggregated (summed, weighted by observation count) into one
 * zone-level distribution — this is what keeps the sequence model useful
 * when realistic timing jitter spreads a household's historical
 * transitions across several adjacent buckets instead of one exact slot.
 * Exported so this fallback behavior can be unit-tested directly.
 */
export function resolveTransitionDistribution(
  baseline: HouseholdBaseline,
  fromZoneId: string,
  bucketIndex: number,
  dayType: DayType,
  config: TendConfig,
): { nextZoneProbabilities: Record<string, number>; observedTransitions: number; resolvedAt: 'bucket' | 'zone' } | null {
  const exact = baseline.transitionStats.find(
    (t) => t.fromZoneId === fromZoneId && t.bucketIndex === bucketIndex && t.dayType === dayType,
  );
  if (exact && exact.observedTransitions >= config.minTransitionObservationsForBucketLevel) {
    return { nextZoneProbabilities: exact.nextZoneProbabilities, observedTransitions: exact.observedTransitions, resolvedAt: 'bucket' };
  }

  const allForZone = baseline.transitionStats.filter((t) => t.fromZoneId === fromZoneId && t.dayType === dayType);
  if (allForZone.length === 0) {
    return null;
  }

  const combinedCounts = new Map<string, number>();
  let totalObserved = 0;
  for (const stat of allForZone) {
    totalObserved += stat.observedTransitions;
    for (const [nextZone, prob] of Object.entries(stat.nextZoneProbabilities)) {
      const count = prob * stat.observedTransitions;
      combinedCounts.set(nextZone, (combinedCounts.get(nextZone) ?? 0) + count);
    }
  }
  if (totalObserved === 0) {
    return null;
  }

  const nextZoneProbabilities: Record<string, number> = {};
  for (const [nextZone, count] of combinedCounts.entries()) {
    nextZoneProbabilities[nextZone] = count / totalObserved;
  }

  return { nextZoneProbabilities, observedTransitions: totalObserved, resolvedAt: 'zone' };
}

/**
 * Evaluates a single day's events against a household baseline as of a given
 * point in time (`asOf`). Only expected windows that end at or before `asOf`
 * are considered for presence deviation — this is what lets Tend say
 * "N minutes past the usual window" rather than flagging activity that
 * simply hasn't had a chance to happen yet.
 *
 * This function performs NO natural-language generation and makes NO call
 * to any reasoning service — it is pure arithmetic over the supplied
 * baseline and event list, by design (see README "Deterministic vs Bedrock
 * boundary").
 */
export function evaluateDeviation(
  baseline: HouseholdBaseline,
  todayEvents: TendEvent[],
  evaluatedDate: Date,
  asOf: Date,
  config: TendConfig = DEFAULT_CONFIG,
): DeviationResult {
  const dayType = dayTypeFor(evaluatedDate);
  const asOfMinutes = minutesSinceMidnightUtc(asOf);
  const asOfBucket = bucketIndexFor(asOfMinutes, config);

  const occurredBucketsBySignal = new Map<string, Set<number>>();
  const firstActivityBySignal = new Map<string, number>();
  const sequence: { minutes: number; signalKey: string }[] = [];

  for (const event of todayEvents) {
    const signalKey = event.zoneId ?? event.deviceId;
    const occurred = new Date(event.occurredAt);
    const minutes = minutesSinceMidnightUtc(occurred);
    const bucketIdx = bucketIndexFor(minutes, config);

    if (!occurredBucketsBySignal.has(signalKey)) occurredBucketsBySignal.set(signalKey, new Set());
    occurredBucketsBySignal.get(signalKey)!.add(bucketIdx);

    const prevFirst = firstActivityBySignal.get(signalKey);
    if (prevFirst === undefined || minutes < prevFirst) {
      firstActivityBySignal.set(signalKey, minutes);
    }

    sequence.push({ minutes, signalKey });
  }
  sequence.sort((a, b) => a.minutes - b.minutes);

  // ---- Presence deviation ----
  const expectedWindows = deriveExpectedWindows(baseline, dayType, config).filter(
    (w) => w.endBucket <= asOfBucket,
  );

  const evidence: EvidenceItem[] = [];
  const presenceScores: number[] = [];

  for (const window of expectedWindows) {
    const occurredSet = occurredBucketsBySignal.get(window.signalKey);
    const windowBuckets = range(window.startBucket, window.endBucket);
    const wasObserved = windowBuckets.some((b) => occurredSet?.has(b));

    const p = window.avgProbability;
    // "Surprise" score for a confidently-expected-but-missed window: higher
    // when the baseline was more confident (closer to 1.0) that activity
    // would occur. sqrt(p*(1-p)) is the Bernoulli std; a tiny epsilon avoids
    // division by zero for a baseline that is essentially certain (p -> 1).
    const bernoulliStd = Math.sqrt(p * (1 - p)) + 0.05;
    const score = wasObserved ? 0 : p / bernoulliStd;
    presenceScores.push(score);

    if (!wasObserved) {
      const endMinutes = (window.endBucket + 1) * config.bucketMinutes;
      evidence.push({
        signal: `${window.signalKey}_presence`,
        expectedWindow: `${bucketToTimeLabel(window.startBucket, config)}-${bucketToTimeLabel(window.endBucket + 1, config)}`,
        observed: false,
        minutesPastWindow: Math.max(0, asOfMinutes - endMinutes),
        confidence: Number(baseline.confidence.toFixed(2)),
      });
    }
  }

  const presenceDeviation = average(presenceScores);

  // ---- Timing deviation ----
  const timingScores: number[] = [];
  for (const [signalKey, firstMinutes] of firstActivityBySignal.entries()) {
    const timingStatsForSignal = baseline.timingStats[signalKey]?.find((t) => t.dayType === dayType);
    if (!timingStatsForSignal || timingStatsForSignal.daysObserved === 0) continue;

    const std = Math.max(timingStatsForSignal.stdFirstActivityMinutes, config.floorStdMinutes);
    const z = Math.abs(firstMinutes - timingStatsForSignal.meanFirstActivityMinutes) / std;
    timingScores.push(z);

    if (z >= config.timingEvidenceZThreshold) {
      evidence.push({
        signal: `${signalKey}_timing`,
        expectedWindow: `~${minutesToLabel(timingStatsForSignal.meanFirstActivityMinutes)}`,
        observed: minutesToLabel(firstMinutes),
        confidence: Number(baseline.confidence.toFixed(2)),
      });
    }
  }
  const timingDeviation = average(timingScores);

  // ---- Sequence deviation ----
  const sequenceScores: number[] = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const from = sequence[i];
    const to = sequence[i + 1];
    const fromBucket = bucketIndexFor(from.minutes, config);
    const transition = resolveTransitionDistribution(baseline, from.signalKey, fromBucket, dayType, config);

    if (!transition || transition.observedTransitions === 0) {
      // No prior data for this context at any granularity — neutral, not
      // penalized, but also not evidence of normalcy. Skip rather than guess.
      continue;
    }

    const observedProb = transition.nextZoneProbabilities[to.signalKey] ?? 0;
    const score = 1 - observedProb;
    sequenceScores.push(score);

    if (score >= config.sequenceEvidenceThreshold) {
      evidence.push({
        signal: `${from.signalKey}_to_${to.signalKey}_sequence`,
        observed: `${from.signalKey}->${to.signalKey}`,
        confidence: Number(baseline.confidence.toFixed(2)),
      });
    }
  }
  const sequenceDeviation = average(sequenceScores);

  const compositeScore =
    config.deviationWeights.presence * presenceDeviation +
    config.deviationWeights.timing * timingDeviation +
    config.deviationWeights.sequence * sequenceDeviation;

  const severity = classifySeverity(compositeScore, config);

  return {
    householdId: baseline.householdId,
    evaluatedDate: evaluatedDate.toISOString().slice(0, 10),
    presenceDeviation,
    timingDeviation,
    sequenceDeviation,
    compositeScore,
    severity,
    evidence,
    confidence: baseline.confidence,
  };
}

export function classifySeverity(compositeScore: number, config: TendConfig = DEFAULT_CONFIG): DeviationSeverity {
  if (compositeScore >= config.severityThresholds.high) return 'HIGH';
  if (compositeScore >= config.severityThresholds.moderate) return 'MODERATE';
  if (compositeScore >= config.severityThresholds.low) return 'LOW';
  return 'NORMAL';
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function minutesToLabel(minutes: number): string {
  const clamped = Math.max(0, Math.round(minutes));
  const hh = Math.floor(clamped / 60)
    .toString()
    .padStart(2, '0');
  const mm = (clamped % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}
