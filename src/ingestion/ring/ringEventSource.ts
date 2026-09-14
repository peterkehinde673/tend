import { TendEvent } from '../../domain/event';
import { EventSource } from '../eventSource';
import { RingApiClient } from './ringClient';
import { RingConfig } from './ringConfig';
import { summarizeRingDevice, normalizeRingHistoryEntry, HistoryNormalizationFailure } from './ringNormalizer';
import { RingDeviceSummary, RingRawHistoryEntry } from './ringTypes';

/**
 * Implements the existing EventSource boundary for a real (or Playground)
 * Ring connection.
 *
 * IMPORTANT — read before assuming this "pulls Ring events": Ring delivers
 * motion/button/etc. events via webhook PUSH to a registered endpoint, not
 * via a pull-style "give me recent events" API that this class's `pull()`
 * (the EventSource interface method) could use directly. Real-time events
 * therefore arrive through the separate webhook handler
 * (ringWebhookHandler.ts), not through `pull()`, which is preserved exactly
 * as it was: an honest no-op returning `[]`.
 *
 * This class ADDITIONALLY exposes `pollMotionHistory()`, a distinct,
 * explicitly-named method (not wired into `pull()`) for the Ring Event
 * History API — Ring's own documented polling alternative to webhooks. It
 * is kept separate from `pull()` deliberately: `pull()`'s existing,
 * already-tested "honestly returns []" contract is preserved unchanged,
 * and history polling is opt-in via its own method so a caller must
 * consciously choose to use it rather than silently inheriting new
 * behavior through the generic EventSource interface.
 */
export class RingEventSource implements EventSource {
  readonly name: string;
  readonly source: TendEvent['source'];
  private readonly client: RingApiClient;

  constructor(config: RingConfig) {
    this.client = new RingApiClient(config);
    this.source = config.source;
    this.name = config.source === 'ring_playground' ? 'ring-playground' : 'ring-real';
  }

  async pull(): Promise<TendEvent[]> {
    // Honest no-op: see class-level doc comment. Returning [] here, rather
    // than throwing, keeps this class usable as a drop-in EventSource
    // without misrepresenting what it can currently do. Unchanged from
    // before the Event History polling path was added.
    return [];
  }

  /** Calls GET /v1/users/me and reports only whether it succeeded — never returns or logs the raw response body, which is of unconfirmed shape and could contain account details. */
  async checkConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.client.getCurrentUser();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Calls GET /v1/devices and returns a defensively-parsed, safe summary of each entry. */
  async discoverDevices(): Promise<RingDeviceSummary[]> {
    const raw = await this.client.listDevices();
    return raw.map(summarizeRingDevice);
  }

  /**
   * Polls the Ring Event History API for a device's `motion` history (see
   * ringTypes.ts and ringClient.ts#getEventHistory for the exact
   * confirmed/unconfirmed breakdown of this endpoint), normalizes each
   * entry, and returns accepted TendEvents separately from rejected raw
   * entries with their rejection reason.
   *
   * DELIBERATELY UNAVAILABLE for `ring_playground` sources: this method
   * throws immediately if `this.source !== 'ring_real'`, rather than
   * silently attempting to poll and mislabel whatever comes back. This
   * project has no confirmation that Ring Playground data flows through
   * the Event History endpoint at all, and normalizeRingHistoryEntry's
   * own type signature independently enforces the same restriction — this
   * is a second, redundant guard against ever producing a TendEvent that
   * claims "the Playground generated a motion event."
   *
   * Any entry whose kind is not exactly the confirmed production value
   * `'motion'` (e.g. a hypothetical `'on_demand'` result) is returned in
   * `rejected`, never silently coerced into `accepted`.
   */
  async pollMotionHistory(deviceId: string): Promise<{ accepted: TendEvent[]; rejected: { raw: RingRawHistoryEntry; reason: HistoryNormalizationFailure }[] }> {
    if (this.source !== 'ring_real') {
      throw new Error(
        `pollMotionHistory is only available for source "ring_real" (got "${this.source}"). ` +
          `This project has no confirmation that Ring Playground data flows through the Event History API, ` +
          `so this path refuses to run rather than guessing — see ringEventSource.ts for the full rationale.`,
      );
    }

    const rawEntries = await this.client.getEventHistory(deviceId, ['motion']);
    const accepted: TendEvent[] = [];
    const rejected: { raw: RingRawHistoryEntry; reason: HistoryNormalizationFailure }[] = [];

    // householdId is not tracked by this class today (it has no concept of
    // a linked household beyond the Ring account itself) — callers that
    // need household scoping are expected to supply it when wiring this
    // into a real ingestion pipeline. For this phase, the device_id is
    // used directly as a placeholder householdId scope key so the
    // resulting TendEvents are still well-formed and testable end to end.
    const householdId = `ring-account-for-${deviceId}`;

    for (const raw of rawEntries) {
      const result = normalizeRingHistoryEntry(raw, deviceId, householdId, 'ring_real');
      if ('event' in result) {
        accepted.push(result.event);
      } else {
        rejected.push({ raw, reason: result.error });
      }
    }

    return { accepted, rejected };
  }
}
