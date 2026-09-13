import { TendEvent } from '../domain/event';

export interface EventTimeRangeQuery {
  householdId: string;
  fromIso: string; // inclusive
  toIso: string; // exclusive
  deviceId?: string;
}

/**
 * Storage-agnostic interface. Phase 1A ships an in-memory implementation
 * (InMemoryEventStore) suitable for tests and local development. A DynamoDB
 * implementation can be added later behind this exact interface without
 * touching the engine or ingestion layers.
 *
 * Idempotency contract: `append` MUST silently reject (return
 * `{ accepted: false }`) an event whose (householdId, eventId) OR
 * (householdId, requestId) has already been recorded, rather than storing a
 * duplicate. eventId identifies the underlying occurrence; requestId
 * identifies a specific webhook delivery attempt — Ring (or any source) may
 * retry a delivery with the same eventId but a fresh requestId, or in
 * principle redeliver the exact same requestId; both must be caught.
 */
export interface EventStore {
  append(event: TendEvent): Promise<{ accepted: boolean; reason?: string }>;

  getByHousehold(householdId: string): Promise<TendEvent[]>;

  getByTimeRange(query: EventTimeRangeQuery): Promise<TendEvent[]>;

  getRecent(householdId: string, limit: number): Promise<TendEvent[]>;

  getByDevice(householdId: string, deviceId: string): Promise<TendEvent[]>;
}
