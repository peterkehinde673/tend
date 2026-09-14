import { TendEvent, TendEventSource, TendEventType, TendMotionSubType, isTendEventType, validateTendEvent } from '../../domain/event';
import { RingRawDevice, RingWebhookEnvelope, RING_WEBHOOK_EVENT_TYPES } from './ringTypes';

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
