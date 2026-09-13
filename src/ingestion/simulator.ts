import { TendEvent } from '../domain/event';
import { EventSource } from './eventSource';
import { DeterministicRandom } from './deterministicRandom';

/**
 * DEVELOPMENT / TEST TOOL ONLY.
 *
 * This simulator generates schema-accurate TendEvent objects so the engine
 * can be built, tested, and demonstrated before real Ring, Ring Playground,
 * or Ring hardware integration is available/verified. It must never be
 * described anywhere in the application UI or docs as an official Ring
 * simulator or as equivalent to a real Ring integration — every event it
 * produces is tagged `source: 'dev_simulator'` and that tag must survive
 * unchanged all the way to the UI and logs.
 */

export type ScenarioName = 'normal' | 'deviation_missing' | 'variable_normal' | 'sequence_deviation';

export const SCENARIO_NAMES: readonly ScenarioName[] = [
  'normal',
  'deviation_missing',
  'variable_normal',
  'sequence_deviation',
];

interface ZoneDefinition {
  zoneId: string;
  deviceId: string;
  /** Typical minutes-since-midnight this zone sees activity, in routine order. */
  baseMinutesSinceMidnight: number;
}

/**
 * Fixed household layout matching the example routine used throughout the
 * Phase 0/1 planning documents:
 *   07:30 kitchen -> 07:42 entrance -> 08:05 kitchen -> 08:20 bedroom
 */
const DEFAULT_ZONES: ZoneDefinition[] = [
  { zoneId: 'kitchen', deviceId: 'device-kitchen-01', baseMinutesSinceMidnight: 7 * 60 + 30 },
  { zoneId: 'entrance', deviceId: 'device-entrance-01', baseMinutesSinceMidnight: 7 * 60 + 42 },
  { zoneId: 'kitchen', deviceId: 'device-kitchen-01', baseMinutesSinceMidnight: 8 * 60 + 5 },
  { zoneId: 'bedroom', deviceId: 'device-bedroom-01', baseMinutesSinceMidnight: 8 * 60 + 20 },
];

export interface SimulatorOptions {
  householdId: string;
  seed: number;
  zones?: ZoneDefinition[];
}

function toDateAtMidnightUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addMinutesIso(dayMidnightUtc: Date, minutesSinceMidnight: number): string {
  const d = new Date(dayMidnightUtc.getTime() + minutesSinceMidnight * 60_000);
  return d.toISOString();
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic, schema-accurate household activity generator.
 * Same (householdId, seed, date, scenario) always yields the same events.
 */
export class HouseholdSimulator implements EventSource {
  readonly name = 'dev-simulator';
  readonly source: TendEvent['source'] = 'dev_simulator';

  private readonly householdId: string;
  private readonly seed: number;
  private readonly zones: ZoneDefinition[];
  private pendingPullBuffer: TendEvent[] = [];

  constructor(options: SimulatorOptions) {
    this.householdId = options.householdId;
    this.seed = options.seed;
    this.zones = options.zones ?? DEFAULT_ZONES;
  }

  /** EventSource#pull — drains whatever has been queued via `queueForPull`. Used by tests exercising the abstraction end-to-end. */
  async pull(): Promise<TendEvent[]> {
    const batch = this.pendingPullBuffer;
    this.pendingPullBuffer = [];
    return batch;
  }

  queueForPull(events: TendEvent[]): void {
    this.pendingPullBuffer.push(...events);
  }

  /**
   * Generates `days` consecutive days ending the day BEFORE `endDateExclusive`,
   * each following Scenario A ("normal") with small deterministic jitter, for
   * seeding a baseline. Given the same seed, this is always identical.
   */
  generateHistoricalWindow(endDateExclusive: Date, days: number): TendEvent[] {
    const events: TendEvent[] = [];
    const end = toDateAtMidnightUtc(endDateExclusive);
    for (let i = days; i >= 1; i--) {
      const day = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
      events.push(...this.generateDay(day, 'normal', /* historicalIndex */ i));
    }
    return events;
  }

  /**
   * Generates one day's events for a given scenario. `variantSalt` allows
   * historical-window callers to vary jitter per day deterministically
   * without every historical day being bit-for-bit identical.
   */
  generateDay(date: Date, scenario: ScenarioName, variantSalt = 0): TendEvent[] {
    const dayMidnight = toDateAtMidnightUtc(date);
    const rng = new DeterministicRandom(this.seed ^ hashDateKey(dateKey(dayMidnight)) ^ variantSalt);

    switch (scenario) {
      case 'normal':
        return this.buildEvents(dayMidnight, this.zones, rng, /* jitterMax */ 5, dateKey(dayMidnight));
      case 'variable_normal':
        return this.buildEvents(dayMidnight, this.zones, rng, /* jitterMax */ 18, dateKey(dayMidnight));
      case 'deviation_missing': {
        // Kitchen + entrance occur roughly on schedule; the later kitchen
        // return and bedroom activity never happen at all.
        const truncatedZones = this.zones.slice(0, 2);
        return this.buildEvents(dayMidnight, truncatedZones, rng, 5, dateKey(dayMidnight));
      }
      case 'sequence_deviation': {
        // Reassign each zone's IDENTITY to a different TIME SLOT than usual,
        // so the true chronological order changes (not just array order).
        // Slot times, in the learned routine's order: [07:30, 07:42, 08:05, 08:20].
        const slotTimes = this.zones.map((z) => z.baseMinutesSinceMidnight);
        const identityOrder: ZoneDefinition[] = [
          this.zones[0], // kitchen normally fills slot 0 (07:30) — unchanged
          this.zones[3], // bedroom now fills slot 1 (07:42) instead of entrance
          this.zones[1], // entrance now fills slot 2 (08:05) instead of kitchen
          this.zones[2], // kitchen (2nd visit) now fills slot 3 (08:20) instead of bedroom
        ];
        const reordered: ZoneDefinition[] = identityOrder.map((zone, idx) => ({
          ...zone,
          baseMinutesSinceMidnight: slotTimes[idx],
        }));
        return this.buildEvents(dayMidnight, reordered, rng, 5, dateKey(dayMidnight));
      }
      default: {
        const exhaustive: never = scenario;
        throw new Error(`Unhandled scenario: ${String(exhaustive)}`);
      }
    }
  }

  private buildEvents(
    dayMidnightUtc: Date,
    zones: ZoneDefinition[],
    rng: DeterministicRandom,
    jitterMax: number,
    dayKey: string,
  ): TendEvent[] {
    return zones.map((zone, index) => {
      const minutes = zone.baseMinutesSinceMidnight + rng.jitterMinutes(jitterMax);
      const occurredAt = addMinutesIso(dayMidnightUtc, minutes);
      const eventId = `${this.householdId}-${zone.deviceId}-${dayKey}-${index}`;
      const requestId = `${eventId}-req`;
      const event: TendEvent = {
        householdId: this.householdId,
        deviceId: zone.deviceId,
        eventId,
        requestId,
        eventType: 'motion_detected',
        subType: 'human',
        zoneId: zone.zoneId,
        occurredAt,
        ingestedAt: occurredAt,
        source: 'dev_simulator',
        rawEventId: `raw-${eventId}`,
      };
      return event;
    });
  }
}

function hashDateKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
