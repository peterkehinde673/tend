import { TendEvent } from '../../domain/event';
import { EventSource } from '../eventSource';
import { RingApiClient } from './ringClient';
import { RingConfig } from './ringConfig';
import { summarizeRingDevice } from './ringNormalizer';
import { RingDeviceSummary } from './ringTypes';

/**
 * Implements the existing EventSource boundary for a real (or Playground)
 * Ring connection.
 *
 * IMPORTANT — read before assuming this "pulls Ring events": Ring delivers
 * motion/button/etc. events via webhook PUSH to a registered endpoint, not
 * via a pull-style "give me recent events" API that this class could poll
 * (the Event History API exists per documentation but is out of scope for
 * this phase, per the approved Phase 2 plan). Real-time events therefore
 * arrive through the separate webhook handler (ringWebhookHandler.ts), not
 * through this class's `pull()`.
 *
 * `pull()` still exists (to satisfy the EventSource interface so this class
 * is a drop-in alongside the simulator) but honestly returns an empty
 * array — it does not fabricate events from device-discovery data, since
 * a device is not an event. Its real, verified purpose in this phase is
 * `checkConnection()` and `discoverDevices()`, used by `ring:check` to
 * prove genuine runtime Ring API usage.
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
    // without misrepresenting what it can currently do.
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
}
