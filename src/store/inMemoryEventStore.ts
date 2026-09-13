import { TendEvent } from '../domain/event';
import { EventStore, EventTimeRangeQuery } from './eventStore';

/**
 * Simple in-memory implementation. Sufficient for local development and for
 * the full test suite. Deliberately does NOT depend on DynamoDB or any AWS
 * SDK — per Phase 1A instructions, real Ring/AWS integration is a later
 * phase, and forcing DynamoDB into local dev/test would make testing
 * unnecessarily slow and would require live AWS credentials that must not
 * be a precondition for running this test suite.
 */
export class InMemoryEventStore implements EventStore {
  private readonly eventsByHousehold: Map<string, TendEvent[]> = new Map();

  /** (householdId -> Set of eventIds already seen) */
  private readonly seenEventIds: Map<string, Set<string>> = new Map();

  /** (householdId -> Set of requestIds already seen) */
  private readonly seenRequestIds: Map<string, Set<string>> = new Map();

  async append(event: TendEvent): Promise<{ accepted: boolean; reason?: string }> {
    const eventIdSet = this.getOrCreateSet(this.seenEventIds, event.householdId);
    const requestIdSet = this.getOrCreateSet(this.seenRequestIds, event.householdId);

    if (eventIdSet.has(event.eventId)) {
      return { accepted: false, reason: `Duplicate eventId: ${event.eventId}` };
    }
    if (requestIdSet.has(event.requestId)) {
      return { accepted: false, reason: `Duplicate requestId (replay): ${event.requestId}` };
    }

    eventIdSet.add(event.eventId);
    requestIdSet.add(event.requestId);

    const list = this.eventsByHousehold.get(event.householdId) ?? [];
    list.push(event);
    // Keep chronologically sorted by occurredAt for predictable range queries.
    list.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    this.eventsByHousehold.set(event.householdId, list);

    return { accepted: true };
  }

  async getByHousehold(householdId: string): Promise<TendEvent[]> {
    return [...(this.eventsByHousehold.get(householdId) ?? [])];
  }

  async getByTimeRange(query: EventTimeRangeQuery): Promise<TendEvent[]> {
    const from = Date.parse(query.fromIso);
    const to = Date.parse(query.toIso);
    const all = this.eventsByHousehold.get(query.householdId) ?? [];
    return all.filter((e) => {
      const t = Date.parse(e.occurredAt);
      const inRange = t >= from && t < to;
      const deviceMatch = query.deviceId === undefined || e.deviceId === query.deviceId;
      return inRange && deviceMatch;
    });
  }

  async getRecent(householdId: string, limit: number): Promise<TendEvent[]> {
    const all = this.eventsByHousehold.get(householdId) ?? [];
    return all.slice(Math.max(0, all.length - limit));
  }

  async getByDevice(householdId: string, deviceId: string): Promise<TendEvent[]> {
    const all = this.eventsByHousehold.get(householdId) ?? [];
    return all.filter((e) => e.deviceId === deviceId);
  }

  private getOrCreateSet(map: Map<string, Set<string>>, key: string): Set<string> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }
}
