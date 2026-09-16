import { TendEvent } from '../../domain/event';
import { EventStore } from '../../store/eventStore';
import { RingEventSource } from './ringEventSource';
import { HistoryNormalizationFailure } from './ringNormalizer';
import { RingRawHistoryEntry } from './ringTypes';

export interface RingHistorySyncResult {
  /** Events that normalized successfully AND were newly persisted (not duplicates). */
  persisted: TendEvent[];
  /** Events that normalized successfully but were already present (idempotent no-op). */
  duplicates: { event: TendEvent; reason?: string }[];
  /** Raw entries that failed normalization (e.g. a non-"motion" kind, or malformed) — never reach the store at all. */
  rejected: { raw: RingRawHistoryEntry; reason: HistoryNormalizationFailure }[];
}

/**
 * Polls a device's Ring Event History (via the existing, unchanged
 * `RingEventSource.pollMotionHistory`) and persists every successfully
 * normalized `motion` event through the given `EventStore` — the exact
 * same storage abstraction the webhook path and the simulator both use.
 *
 * This function does not change any existing security/honesty behavior:
 * - Normalization/rejection rules are entirely owned by
 *   `normalizeRingHistoryEntry` (unchanged) — this function never accepts
 *   an entry the normalizer rejected.
 * - `pollMotionHistory` already refuses to run at all for a
 *   `ring_playground`-configured source; this function inherits that
 *   restriction unchanged, since it calls that method directly.
 * - `EventStore.append`'s existing idempotency contract (distinguishing a
 *   duplicate eventId from a duplicate requestId) is preserved — repeated
 *   polls of the same history window are safe and do not create
 *   duplicate persisted events.
 */
export async function syncMotionHistoryToStore(
  ringEventSource: RingEventSource,
  store: EventStore,
  deviceId: string,
): Promise<RingHistorySyncResult> {
  const polled = await ringEventSource.pollMotionHistory(deviceId);

  const persisted: TendEvent[] = [];
  const duplicates: { event: TendEvent; reason?: string }[] = [];

  for (const event of polled.accepted) {
    const result = await store.append(event);
    if (result.accepted) {
      persisted.push(event);
    } else {
      duplicates.push({ event, reason: result.reason });
    }
  }

  return { persisted, duplicates, rejected: polled.rejected };
}
