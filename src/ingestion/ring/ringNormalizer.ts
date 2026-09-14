import { TendEvent, TendEventSource, TendEventType, TendMotionSubType, isTendEventType, validateTendEvent } from '../../domain/event';
import {
  RingRawDevice,
  RingRawHistoryEntry,
  RingWebhookEnvelope,
  RING_WEBHOOK_EVENT_TYPES,
  CONFIRMED_HISTORY_EVENT_KIND,
  NON_PRODUCTION_HISTORY_EVENT_KINDS,
} from './ringTypes';

/**
 * Maps Ring's own motion subType strings to Tend's TendMotionSubType.
 * Ring's documented classification values are not guaranteed to exactly
 * match Tend's internal vocabulary, so this is an explicit allowlist
 * mapping rather than a cast — anything unrecognized safely becomes
 * 'unknown' instead of silently passing through an unvalidated string.
 */
function mapMotionSubType(raw: string | undefined): TendMotionSubType {
  switch (raw) {
    case 'human':
      return 'human';
    case 'vehicle':
      return 'vehicle';
    case 'animal':
      return 'animal';
    case 'package':
      return 'package';
    default:
      return raw ? 'other_motion' : 'unknown';
  }
}

export interface NormalizationFailure {
  reason: string;
}

export type NormalizationResult = { event: TendEvent } | { error: NormalizationFailure };

/**
 * Converts a (signature-already-verified) Ring webhook envelope into a
 * TendEvent. This is the ONLY place raw Ring webhook JSON is interpreted —
 * everything downstream of this function operates on TendEvent alone.
 *
 * `zoneId` is intentionally left undefined: Ring's webhook payload does not
 * include a household-meaningful zone name (see ringTypes.ts) — that
 * mapping is a household-onboarding concern for a later phase, not
 * something this normalizer should invent.
 */
export function normalizeRingWebhookEvent(
  envelope: RingWebhookEnvelope,
  householdId: string,
  source: Extract<TendEventSource, 'ring_real' | 'ring_playground'>,
  ingestedAt: string = new Date().toISOString(),
): NormalizationResult {
  if (!envelope || typeof envelope !== 'object' || !envelope.meta || !envelope.data) {
    return { error: { reason: 'Malformed Ring webhook envelope: missing meta or data.' } };
  }

  const { meta, data } = envelope;

  if (!(RING_WEBHOOK_EVENT_TYPES as string[]).includes(data.type)) {
    return { error: { reason: `Unsupported Ring webhook event type: ${String(data.type)}` } };
  }

  if (!isTendEventType(data.type)) {
    // Every RingWebhookEventType is also a TendEventType by construction,
    // but this guards against the two enums silently drifting apart.
    return { error: { reason: `Ring webhook event type "${data.type}" has no corresponding Tend event type.` } };
  }
  const eventType: TendEventType = data.type;

  if (!data.attributes || typeof data.attributes.source !== 'string' || data.attributes.source.trim().length === 0) {
    return { error: { reason: 'Malformed Ring webhook: missing attributes.source (device id).' } };
  }
  if (!meta.request_id || !data.id) {
    return { error: { reason: 'Malformed Ring webhook: missing request_id or data.id, both required for idempotency.' } };
  }
  if (!meta.time || Number.isNaN(Date.parse(meta.time))) {
    return { error: { reason: `Malformed Ring webhook: meta.time is not a valid timestamp: ${String(meta.time)}` } };
  }

  const candidate: TendEvent = {
    householdId,
    deviceId: data.attributes.source,
    componentId: data.attributes.component_ids && data.attributes.component_ids.length > 0 ? data.attributes.component_ids[0] : undefined,
    eventId: data.id,
    requestId: meta.request_id,
    eventType,
    subType: eventType === 'motion_detected' ? mapMotionSubType(data.subType) : undefined,
    occurredAt: meta.time,
    ingestedAt,
    source,
    rawEventId: `raw-ring-${meta.request_id}`,
  };

  const problems = validateTendEvent(candidate);
  if (problems.length > 0) {
    return { error: { reason: `Normalized Ring event failed validation: ${problems.join('; ')}` } };
  }

  return { event: candidate };
}

/**
 * Defensively extracts a safe, minimal summary from an unconfirmed-shape
 * raw device entry. Never throws — an entry that doesn't match any
 * expected shape is reported as `unparsed: true` rather than crashing the
 * caller. This is the honest way to handle "the endpoint exists but we
 * haven't confirmed its exact response shape" (see ringTypes.ts).
 */
export function summarizeRingDevice(raw: RingRawDevice): { id: string | null; label: string | null; unparsed: boolean } {
  if (!raw || typeof raw !== 'object') {
    return { id: null, label: null, unparsed: true };
  }
  const id = typeof raw.id === 'string' ? raw.id : null;
  const label = typeof raw.attributes?.name === 'string' ? raw.attributes.name : typeof raw.type === 'string' ? raw.type : null;
  return { id, label, unparsed: id === null && label === null };
}

export interface HistoryNormalizationFailure {
  reason: string;
  /** Set when the entry was rejected specifically because its kind was not the confirmed, production `motion` value — surfaced separately so callers can report this distinctly rather than lumping it in with a generic parse failure. */
  nonProductionKind?: string;
}

export type HistoryNormalizationResult = { event: TendEvent } | { error: HistoryNormalizationFailure };

/**
 * Converts a Ring Event History entry into a TendEvent.
 *
 * IMPORTANT — this function's `source` parameter is deliberately typed to
 * accept ONLY `'ring_real'`, never `'ring_playground'`. The Event History
 * API is Ring's documented polling alternative for a real, production
 * account's webhook-equivalent data — this project has no confirmation
 * that Ring Playground data flows through this endpoint at all, and even
 * if it did, an entry whose `kind` is not the confirmed production value
 * `'motion'` (e.g. `'on_demand'`, a value found only in an unrelated,
 * unofficial third-party library — see ringTypes.ts) is explicitly
 * rejected below rather than normalized. This is a structural guarantee,
 * not just a comment: there is no code path in this function that can
 * produce a TendEvent tagged `ring_playground`, and no code path that
 * accepts a non-`motion` kind. Together these mean this function can never
 * claim "the Playground generated a motion event" — either the caller
 * didn't ask for that (the type system prevents it), or the entry's own
 * kind field disqualifies it.
 */
export function normalizeRingHistoryEntry(
  raw: RingRawHistoryEntry,
  deviceId: string,
  householdId: string,
  source: 'ring_real',
  ingestedAt: string = new Date().toISOString(),
): HistoryNormalizationResult {
  if (!raw || typeof raw !== 'object') {
    return { error: { reason: 'Malformed Ring history entry: not an object.' } };
  }

  const kind = typeof raw.attributes?.kind === 'string' ? raw.attributes.kind : undefined;
  if (kind === undefined) {
    return { error: { reason: 'Malformed Ring history entry: could not defensively determine an event kind (attributes.kind missing or not a string).' } };
  }
  if (kind !== CONFIRMED_HISTORY_EVENT_KIND) {
    const isKnownNonProduction = NON_PRODUCTION_HISTORY_EVENT_KINDS.includes(kind);
    return {
      error: {
        reason: isKnownNonProduction
          ? `Rejected: history entry kind "${kind}" is not a documented production Ring Partner API value — this project will not normalize it as a genuine motion event. (This kind is known only from an unrelated, unofficial third-party consumer-API library, possibly corresponding to a Playground/on-demand-triggered result rather than a passively detected one — it is never treated as equivalent to "${CONFIRMED_HISTORY_EVENT_KIND}".)`
          : `Rejected: history entry kind "${kind}" is not the confirmed production value "${CONFIRMED_HISTORY_EVENT_KIND}" — refusing to guess.`,
        nonProductionKind: kind,
      },
    };
  }

  const entryId = typeof raw.id === 'string' ? raw.id : undefined;
  if (!entryId) {
    return { error: { reason: 'Malformed Ring history entry: missing a string id.' } };
  }

  const occurredAtRaw = raw.attributes?.occurred_at ?? raw.attributes?.time ?? raw.attributes?.timestamp;
  const occurredAt = typeof occurredAtRaw === 'string' ? occurredAtRaw : undefined;
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    return { error: { reason: `Malformed Ring history entry: no valid occurred-at timestamp found (checked attributes.occurred_at/time/timestamp).` } };
  }

  const subType = typeof raw.attributes?.sub_type === 'string' ? raw.attributes.sub_type : undefined;

  const candidate: TendEvent = {
    householdId,
    deviceId,
    eventId: entryId,
    // The Event History API has no per-item delivery request_id the way
    // webhooks do (there is no "delivery attempt" to distinguish from the
    // underlying occurrence) — this synthesizes a stable, local
    // idempotency key from the entry's own id so re-polling the same
    // history window doesn't create duplicates in the event store.
    requestId: `history-${deviceId}-${entryId}`,
    eventType: 'motion_detected',
    subType: mapMotionSubType(subType),
    occurredAt,
    ingestedAt,
    source,
    rawEventId: `raw-ring-history-${deviceId}-${entryId}`,
  };

  const problems = validateTendEvent(candidate);
  if (problems.length > 0) {
    return { error: { reason: `Normalized Ring history entry failed validation: ${problems.join('; ')}` } };
  }

  return { event: candidate };
}
