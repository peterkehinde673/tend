import { TendEvent } from '../domain/event';
import { BucketStat, DayType, HouseholdBaseline, TimingStat, TransitionStat } from '../domain/baseline';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';

/** Resolves the grouping key the engine reasons about: zoneId if present, else deviceId. */
function signalKeyFor(event: TendEvent): string {
  return event.zoneId ?? event.deviceId;
}

function dayTypeFor(date: Date): DayType {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

function minutesSinceMidnightUtc(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function bucketIndexFor(minutesSinceMidnight: number, config: TendConfig): number {
  const idx = Math.floor(minutesSinceMidnight / config.bucketMinutes);
  return Math.max(0, Math.min(config.bucketsPerDay - 1, idx));
}

function dateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface DayBucket {
  dateKey: string;
  dayType: DayType;
  /** signalKey -> set of bucket indices with activity that day. */
  occurredBuckets: Map<string, Set<number>>;
  /** signalKey -> earliest minutesSinceMidnight seen that day. */
  firstActivityMinutes: Map<string, number>;
  /** signalKey -> bucketIndex -> eventType -> count (for eventTypeMix diagnostics). */
  typeMix: Map<string, Map<number, Map<string, number>>>;
  /** chronological (time, signalKey) sequence for transition modeling. */
  sequence: { minutes: number; signalKey: string }[];
}

/**
 * Builds a HouseholdBaseline from a flat list of normalized events. Events
 * outside [asOfDate - windowDays, asOfDate) are ignored. This function is
 * pure and deterministic: identical input always yields identical output,
 * which is what makes it possible to hand-verify against a known dataset in
 * tests.
 */
export function buildHouseholdBaseline(
  householdId: string,
  events: TendEvent[],
  asOfDate: Date,
  config: TendConfig = DEFAULT_CONFIG,
  windowDaysOverride?: number,
): HouseholdBaseline {
  const windowDays = windowDaysOverride ?? config.defaultWindowDays;
  const windowStart = new Date(asOfDate.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const inWindow = events.filter((e) => {
    const t = Date.parse(e.occurredAt);
    return e.householdId === householdId && t >= windowStart.getTime() && t < asOfDate.getTime();
  });

  const dayBuckets = groupIntoDays(inWindow, config);
  const daysObserved = dayBuckets.size;

  const bucketStats = computeBucketStats(dayBuckets, config);
  const timingStats = computeTimingStats(dayBuckets);
  const transitionStats = computeTransitionStats(dayBuckets, config);

  const confidence = Math.max(0, Math.min(1, daysObserved / windowDays));

  return {
    householdId,
    windowDays,
    daysObserved,
    confidence,
    bucketStats,
    timingStats,
    transitionStats,
    lastUpdatedAt: asOfDate.toISOString(),
  };
}

function groupIntoDays(events: TendEvent[], config: TendConfig): Map<string, DayBucket> {
  const days = new Map<string, DayBucket>();

  for (const event of events) {
    const occurred = new Date(event.occurredAt);
    const key = dateKeyUtc(occurred);
    const signalKey = signalKeyFor(event);
    const minutes = minutesSinceMidnightUtc(occurred);
    const bucketIdx = bucketIndexFor(minutes, config);

    let day = days.get(key);
    if (!day) {
      day = {
        dateKey: key,
        dayType: dayTypeFor(occurred),
        occurredBuckets: new Map(),
        firstActivityMinutes: new Map(),
        typeMix: new Map(),
        sequence: [],
      };
      days.set(key, day);
    }

    if (!day.occurredBuckets.has(signalKey)) {
      day.occurredBuckets.set(signalKey, new Set());
    }
    day.occurredBuckets.get(signalKey)!.add(bucketIdx);

    const currentFirst = day.firstActivityMinutes.get(signalKey);
    if (currentFirst === undefined || minutes < currentFirst) {
      day.firstActivityMinutes.set(signalKey, minutes);
    }

    if (!day.typeMix.has(signalKey)) {
      day.typeMix.set(signalKey, new Map());
    }
    const bucketMap = day.typeMix.get(signalKey)!;
    if (!bucketMap.has(bucketIdx)) {
      bucketMap.set(bucketIdx, new Map());
    }
    const typeCounts = bucketMap.get(bucketIdx)!;
    typeCounts.set(event.eventType, (typeCounts.get(event.eventType) ?? 0) + 1);

    day.sequence.push({ minutes, signalKey });
  }

  for (const day of days.values()) {
    day.sequence.sort((a, b) => a.minutes - b.minutes);
  }

  return days;
}

function computeBucketStats(
  dayBuckets: Map<string, DayBucket>,
  config: TendConfig,
): Record<string, BucketStat[]> {
  // Discover every signalKey that appears anywhere in the window.
  const signalKeys = new Set<string>();
  for (const day of dayBuckets.values()) {
    for (const key of day.occurredBuckets.keys()) signalKeys.add(key);
  }

  const chronologicalDays = [...dayBuckets.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  const result: Record<string, BucketStat[]> = {};

  for (const signalKey of signalKeys) {
    const perDayType: Record<DayType, Map<number, { prob: number; daysObserved: number; totalEvents: number; mix: Map<string, number> }>> = {
      weekday: new Map(),
      weekend: new Map(),
    };

    for (const day of chronologicalDays) {
      const occurredSet = day.occurredBuckets.get(signalKey) ?? new Set<number>();
      const bucketMap = perDayType[day.dayType];

      for (let b = 0; b < config.bucketsPerDay; b++) {
        const occurred = occurredSet.has(b) ? 1 : 0;
        const existing = bucketMap.get(b);
        const prevProb = existing?.prob ?? 0;
        const newProb = config.ewmaAlpha * occurred + (1 - config.ewmaAlpha) * prevProb;

        const mix = existing?.mix ?? new Map<string, number>();
        const typeCounts = day.typeMix.get(signalKey)?.get(b);
        if (typeCounts) {
          for (const [type, count] of typeCounts.entries()) {
            mix.set(type, (mix.get(type) ?? 0) + count);
          }
        }

        bucketMap.set(b, {
          prob: newProb,
          daysObserved: (existing?.daysObserved ?? 0) + (occurred ? 1 : 0),
          totalEvents: (existing?.totalEvents ?? 0) + (typeCounts ? sumCounts(typeCounts) : 0),
          mix,
        });
      }
    }

    const stats: BucketStat[] = [];
    for (const dayType of ['weekday', 'weekend'] as DayType[]) {
      const bucketMap = perDayType[dayType];
      for (let b = 0; b < config.bucketsPerDay; b++) {
        const entry = bucketMap.get(b);
        stats.push({
          bucketIndex: b,
          dayType,
          daysObserved: entry?.daysObserved ?? 0,
          activityProbability: entry?.prob ?? 0,
          totalEventCount: entry?.totalEvents ?? 0,
          eventTypeMix: entry ? Object.fromEntries(entry.mix) : {},
        });
      }
    }
    result[signalKey] = stats;
  }

  return result;
}

function sumCounts(m: Map<string, number>): number {
  let total = 0;
  for (const v of m.values()) total += v;
  return total;
}

function computeTimingStats(dayBuckets: Map<string, DayBucket>): Record<string, TimingStat[]> {
  const signalKeys = new Set<string>();
  for (const day of dayBuckets.values()) {
    for (const key of day.firstActivityMinutes.keys()) signalKeys.add(key);
  }

  const result: Record<string, TimingStat[]> = {};

  for (const signalKey of signalKeys) {
    const byDayType: Record<DayType, number[]> = { weekday: [], weekend: [] };
    for (const day of dayBuckets.values()) {
      const minutes = day.firstActivityMinutes.get(signalKey);
      if (minutes !== undefined) {
        byDayType[day.dayType].push(minutes);
      }
    }

    const stats: TimingStat[] = [];
    for (const dayType of ['weekday', 'weekend'] as DayType[]) {
      const samples = byDayType[dayType];
      const mean = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      const variance =
        samples.length > 0
          ? samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / samples.length
          : 0;
      stats.push({
        dayType,
        meanFirstActivityMinutes: mean,
        stdFirstActivityMinutes: Math.sqrt(variance),
        daysObserved: samples.length,
      });
    }
    result[signalKey] = stats;
  }

  return result;
}

function computeTransitionStats(dayBuckets: Map<string, DayBucket>, config: TendConfig): TransitionStat[] {
  // key: fromZoneId|bucketIndex|dayType -> Map<toZoneId, count>, plus total observed transitions
  const counts = new Map<string, { totalTransitions: number; nextCounts: Map<string, number> }>();

  for (const day of dayBuckets.values()) {
    for (let i = 0; i < day.sequence.length - 1; i++) {
      const from = day.sequence[i];
      const to = day.sequence[i + 1];
      const bucketIdx = bucketIndexFor(from.minutes, config);
      const key = `${from.signalKey}|${bucketIdx}|${day.dayType}`;

      let entry = counts.get(key);
      if (!entry) {
        entry = { totalTransitions: 0, nextCounts: new Map() };
        counts.set(key, entry);
      }
      entry.totalTransitions += 1;
      entry.nextCounts.set(to.signalKey, (entry.nextCounts.get(to.signalKey) ?? 0) + 1);
    }
  }

  const result: TransitionStat[] = [];
  for (const [key, entry] of counts.entries()) {
    const [fromZoneId, bucketIndexStr, dayType] = key.split('|');
    const nextZoneProbabilities: Record<string, number> = {};
    for (const [toZone, count] of entry.nextCounts.entries()) {
      nextZoneProbabilities[toZone] = count / entry.totalTransitions;
    }
    result.push({
      fromZoneId,
      bucketIndex: Number(bucketIndexStr),
      dayType: dayType as DayType,
      nextZoneProbabilities,
      observedTransitions: entry.totalTransitions,
    });
  }

  return result;
}
