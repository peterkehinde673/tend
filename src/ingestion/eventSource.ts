import { TendEvent } from '../domain/event';

/**
 * The core engine (baseline/deviation/reasoning) must never know or care
 * whether an event arrived via a real Ring webhook, the Ring Playground, or
 * the development simulator. Every concrete adapter — a future
 * `RingWebhookEventSource`, a future `RingPlaygroundEventSource`, and the
 * `SimulatorEventSource` implemented in this phase — must produce exactly
 * this shape and nothing else.
 *
 * This interface is intentionally minimal in Phase 1A: a source is anything
 * that can be asked, "give me the events you have," either as a one-shot
 * pull (used by the simulator and by tests) or by pushing to a sink (used by
 * real webhook ingestion in a later phase). Only the pull side is
 * implemented now because nothing in this phase depends on live push
 * delivery.
 */
export interface EventSource {
  /** Human-readable name for logs/UI, e.g. "dev-simulator". */
  readonly name: string;

  /** The provenance tag this source is allowed to emit. Enforced by adapters, never inferred. */
  readonly source: TendEvent['source'];

  /**
   * Produce a batch of normalized events. Concrete sources are responsible
   * for their own normalization (e.g. mapping raw Ring webhook JSON into
   * TendEvent) before events reach this boundary — nothing downstream of
   * this interface ever sees a raw payload.
   */
  pull(): Promise<TendEvent[]>;
}

/**
 * A push-style sink, used by adapters that receive events asynchronously
 * (e.g. a future real webhook receiver). Not exercised in Phase 1A beyond
 * the interface shape, since no real Ring/Playground integration is wired
 * up yet — included so later phases can implement it without redesigning
 * this boundary.
 */
export interface EventSink {
  ingest(event: TendEvent): Promise<{ accepted: boolean; reason?: string }>;
}
