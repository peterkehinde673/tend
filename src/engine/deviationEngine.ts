import { TendEvent } from '../domain/event';
import { HouseholdBaseline, DayType } from '../domain/baseline';
import { DeviationResult, DeviationSeverity, EvidenceItem } from '../domain/deviation';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';

interface ExpectedWindow { signalKey: string; startBucket: number; endBucket: number; avgProbability: number; }

function dayTypeFor(date: Date): DayType { const day = date.getUTCDay(); return day === 0 || day === 6 ? 'weekend' : 'weekday'; }
function minutesSinceMidnightUtc(date: Date): number { return date.getUTCHours() * 60 + date.getUTCMinutes(); }
function bucketIndexFor(minutesSinceMidnight: number, config: TendConfig): number { const idx = Math.floor(minutesSinceMidnight / config.bucketMinutes); return Math.max(0, Math.min(config.bucketsPerDay - 1, idx)); }
function bucketToTimeLabel(bucketIndex: number, config: TendConfig): string { const totalMinutes = bucketIndex * config.bucketMinutes; const hh = Math.floor(totalMinutes / 60).toString().padStart(2, '0'); const mm = (totalMinutes % 60).toString().padStart(2, '0'); return `${hh}:${mm}`; }

export function deriveExpectedWindows(baseline: HouseholdBaseline, dayType: DayType, config: TendConfig = DEFAULT_CONFIG): ExpectedWindow[] {
  const windows: ExpectedWindow[] = [];
  for (const [signalKey, stats] of Object.entries(baseline.bucketStats)) {
    const relevant = stats.filter((s) => s.dayType === dayType).sort((a, b) => a.bucketIndex - b.bucketIndex);
    let current: { start: number; end: number; probs: number[] } | null = null;
    for (const stat of relevant) {
      if (stat.activityProbability >= config.presenceExpectedThreshold) {
        if (current && stat.bucketIndex === current.end + 1) { current.end = stat.bucketIndex; current.probs.push(stat.activityProbability); }
        else { if (current) windows.push(toWindow(signalKey, current)); current = { start: stat.bucketIndex, end: stat.bucketIndex, probs: [stat.activityProbability] }; }
      } else if (current) { windows.push(toWindow(signalKey, current)); current = null; }
    }
    if (current) windows.push(toWindow(signalKey, current));
  }
  return windows;
}
function toWindow(signalKey: string, current: { start: number; end: number; probs: number[] }): ExpectedWindow { return { signalKey, startBucket: current.start, endBucket: current.end, avgProbability: current.probs.reduce((a, b) => a + b, 0) / current.probs.length }; }

export function resolveTransitionDistribution(baseline: HouseholdBaseline, fromZoneId: string, bucketIndex: number, dayType: DayType, config: TendConfig): { nextZoneProbabilities: Record<string, number>; observedTransitions: number; resolvedAt: 'bucket' | 'zone' } | null {
  const exact = baseline.transitionStats.find((t) => t.fromZoneId === fromZoneId && t.bucketIndex === bucketIndex && t.dayType === dayType);
  if (exact && exact.observedTransitions >= config.minTransitionObservationsForBucketLevel) return { nextZoneProbabilities: exact.nextZoneProbabilities, observedTransitions: exact.observedTransitions, resolvedAt: 'bucket' };
  const allForZone = baseline.transitionStats.filter((t) => t.fromZoneId === fromZoneId && t.dayType === dayType);
  if (allForZone.length === 0) return null;
  const combinedCounts = new Map<string, number>();
  let totalObserved = 0;
  for (const stat of allForZone) { totalObserved += stat.observedTransitions; for (const [nextZone, prob] of Object.entries(stat.nextZoneProbabilities)) combinedCounts.set(nextZone, (combinedCounts.get(nextZone) ?? 0) + prob * stat.observedTransitions); }
  if (totalObserved === 0) return null;
  const nextZoneProbabilities: Record<string, number> = {};
  for (const [nextZone, count] of combinedCounts.entries()) nextZoneProbabilities[nextZone] = count / totalObserved;
  return { nextZoneProbabilities, observedTransitions: totalObserved, resolvedAt: 'zone' };
}

/**
 * Evaluates one day deterministically. `signalSensitivity` is an optional
 * per-signal multiplier learned from caregiver feedback. Values above 1
 * make that signal less sensitive; values below 1 make it more sensitive.
 * The default path remains byte-for-byte compatible with the Phase 1
 * algorithm when the map is omitted.
 */
export function evaluateDeviation(
  baseline: HouseholdBaseline,
  todayEvents: TendEvent[],
  evaluatedDate: Date,
  asOf: Date,
  config: TendConfig = DEFAULT_CONFIG,
  signalSensitivity: Readonly<Record<string, number>> = {},
): DeviationResult {
  const dayType = dayTypeFor(evaluatedDate);
  const asOfMinutes = minutesSinceMidnightUtc(asOf);
  const asOfBucket = bucketIndexFor(asOfMinutes, config);
  const sensitivityFor = (signal: string): number => {
    const value = signalSensitivity[signal];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
  };
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
    if (prevFirst === undefined || minutes < prevFirst) firstActivityBySignal.set(signalKey, minutes);
    sequence.push({ minutes, signalKey });
  }
  sequence.sort((a, b) => a.minutes - b.minutes);

  const expectedWindows = deriveExpectedWindows(baseline, dayType, config).filter((w) => w.endBucket <= asOfBucket);
  const evidence: EvidenceItem[] = [];
  const presenceScores: number[] = [];
  for (const window of expectedWindows) {
    const occurredSet = occurredBucketsBySignal.get(window.signalKey);
    const windowBuckets = range(window.startBucket, window.endBucket);
    const wasObserved = windowBuckets.some((b) => occurredSet?.has(b));
    const p = window.avgProbability;
    const bernoulliStd = Math.sqrt(p * (1 - p)) + 0.05;
    const rawScore = wasObserved ? 0 : p / bernoulliStd;
    presenceScores.push(rawScore / sensitivityFor(window.signalKey));
    if (!wasObserved) {
      const endMinutes = (window.endBucket + 1) * config.bucketMinutes;
      evidence.push({ signal: `${window.signalKey}_presence`, expectedWindow: `${bucketToTimeLabel(window.startBucket, config)}-${bucketToTimeLabel(window.endBucket + 1, config)}`, observed: false, minutesPastWindow: Math.max(0, asOfMinutes - endMinutes), confidence: Number(baseline.confidence.toFixed(2)) });
    }
  }
  const presenceDeviation = average(presenceScores);

  const timingScores: number[] = [];
  for (const [signalKey, firstMinutes] of firstActivityBySignal.entries()) {
    const timingStatsForSignal = baseline.timingStats[signalKey]?.find((t) => t.dayType === dayType);
    if (!timingStatsForSignal || timingStatsForSignal.daysObserved === 0) continue;
    const std = Math.max(timingStatsForSignal.stdFirstActivityMinutes, config.floorStdMinutes);
    const z = Math.abs(firstMinutes - timingStatsForSignal.meanFirstActivityMinutes) / std;
    timingScores.push(z / sensitivityFor(signalKey));
    if (z >= config.timingEvidenceZThreshold * sensitivityFor(signalKey)) evidence.push({ signal: `${signalKey}_timing`, expectedWindow: `~${minutesToLabel(timingStatsForSignal.meanFirstActivityMinutes)}`, observed: minutesToLabel(firstMinutes), confidence: Number(baseline.confidence.toFixed(2)) });
  }
  const timingDeviation = average(timingScores);

  const sequenceScores: number[] = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const from = sequence[i]; const to = sequence[i + 1];
    const fromBucket = bucketIndexFor(from.minutes, config);
    const transition = resolveTransitionDistribution(baseline, from.signalKey, fromBucket, dayType, config);
    if (!transition || transition.observedTransitions === 0) continue;
    const observedProb = transition.nextZoneProbabilities[to.signalKey] ?? 0;
    const score = 1 - observedProb;
    sequenceScores.push(score / sensitivityFor(`${from.signalKey}_to_${to.signalKey}_sequence`));
    if (score >= config.sequenceEvidenceThreshold * sensitivityFor(`${from.signalKey}_to_${to.signalKey}_sequence`)) evidence.push({ signal: `${from.signalKey}_to_${to.signalKey}_sequence`, observed: `${from.signalKey}->${to.signalKey}`, confidence: Number(baseline.confidence.toFixed(2)) });
  }
  const sequenceDeviation = average(sequenceScores);

  const compositeScore = config.deviationWeights.presence * presenceDeviation + config.deviationWeights.timing * timingDeviation + config.deviationWeights.sequence * sequenceDeviation;
  const severity = classifySeverity(compositeScore, config);
  return { householdId: baseline.householdId, evaluatedDate: evaluatedDate.toISOString().slice(0, 10), presenceDeviation, timingDeviation, sequenceDeviation, compositeScore, severity, evidence, confidence: baseline.confidence };
}

export function classifySeverity(compositeScore: number, config: TendConfig = DEFAULT_CONFIG): DeviationSeverity {
  if (compositeScore >= config.severityThresholds.high) return 'HIGH';
  if (compositeScore >= config.severityThresholds.moderate) return 'MODERATE';
  if (compositeScore >= config.severityThresholds.low) return 'LOW';
  return 'NORMAL';
}
function range(start: number, end: number): number[] { const out: number[] = []; for (let i = start; i <= end; i++) out.push(i); return out; }
function average(values: number[]): number { if (values.length === 0) return 0; return values.reduce((a, b) => a + b, 0) / values.length; }
function minutesToLabel(minutes: number): string { const clamped = Math.max(0, Math.round(minutes)); const hh = Math.floor(clamped / 60).toString().padStart(2, '0'); const mm = (clamped % 60).toString().padStart(2, '0'); return `${hh}:${mm}`; }
