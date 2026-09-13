/**
 * Core Tend domain event model.
 *
 * This is intentionally decoupled from Ring's webhook JSON shape. Only fields
 * that are documented (or directly and safely derivable) are represented.
 * See /README.md "Ring Integration Status" for the confirmed/unconfirmed
 * distinction behind each field.
 *
 * IMPORTANT: `source` is mandatory and must never be inferred silently. It is
 * the single mechanism by which Tend guarantees it never presents a simulated
 * event as if it came from a real Ring device.
 */

/** Where a normalized event actually originated. Never omit or fake this. */
export type TendEventSource = 'ring_real' | 'ring_playground' | 'dev_simulator';

/**
 * Event types Tend supports. Restricted to types documented in the Ring
 * Partner API webhook event-type reference. `contact_sensor_event` is an
 * optional, Early-Access signal (per research) and is treated as such
 * throughout — it is never required for the engine to function.
 */
export type TendEventType =
  | 'motion_detected'
  | 'button_press'
  | 'device_online'
  | 'device_offline'
  | 'device_added'
  | 'device_removed'
  | 'contact_sensor_event';

/**
 * Motion sub-classification. Only `human` is confirmed directly in the API
 * reference example payload; the others are named in Ring's own marketing
 * copy and CV classification docs but are not certain to appear verbatim in
 * every account/device combination. `unknown` is the safe fallback and must
 * be used rather than guessing when a payload's subType is absent or
 * unrecognized.
 */
export type TendMotionSubType =
  | 'human'
  | 'vehicle'
  | 'animal'
  | 'package'
  | 'other_motion'
  | 'unknown';

export const TEND_EVENT_TYPES: readonly TendEventType[] = [
  'motion_detected',
  'button_press',
  'device_online',
  'device_offline',
  'device_added',
  'device_removed',
  'contact_sensor_event',
];

export const TEND_MOTION_SUBTYPES: readonly TendMotionSubType[] = [
  'human',
  'vehicle',
  'animal',
  'package',
  'other_motion',
  'unknown',
];

export const TEND_EVENT_SOURCES: readonly TendEventSource[] = [
  'ring_real',
  'ring_playground',
  'dev_simulator',
];

/**
 * The normalized event Tend's engine operates on. This shape is the seam
 * between "how did this event arrive" and "what does Tend do with it" —
 * every ingestion path (real Ring webhook, Ring Playground, or the
 * development simulator) must converge on exactly this interface before
 * anything downstream touches it.
 *
 * Deliberately excluded, per privacy constraints: no image/video URLs or
 * blobs, no facial embeddings, no biometric fields, no person-identifying
 * attributes of any kind. If a future phase needs a media reference, it must
 * be fetched on demand and referenced by ID, never persisted here.
 */
export interface TendEvent {
  /** Our concept, mapped 1:1 to a linked Ring account_id in production. */
  householdId: string;

  /** Ring device_id (or simulator-assigned device id using the same shape). */
  deviceId: string;

  /**
   * Present only for multi-camera devices (e.g. Ring Elite modules).
   * Confirmed field name; optional because most devices only have one camera.
   */
  componentId?: string;

  /** Ring's data.id (or simulator-generated equivalent). Used for idempotency. */
  eventId: string;

  /** Ring's meta.request_id (or simulator-generated equivalent). Used for de-duplication of a given webhook delivery attempt, distinct from eventId. */
  requestId: string;

  eventType: TendEventType;

  /** Only meaningful for motion_detected. */
  subType?: TendMotionSubType;

  /**
   * Logical zone/device grouping label used by the baseline/deviation
   * engine (e.g. "kitchen", "entrance"). This is NOT part of any Ring
   * webhook payload — it is either configured by the household during
   * onboarding (mapping a deviceId to a human-meaningful zone name) or, in
   * the simulator, assigned directly. Treat as optional enrichment.
   */
  zoneId?: string;

  /** Ring's meta.time (or simulator equivalent) — when the event actually occurred, ISO 8601. */
  occurredAt: string;

  /** Our own server-side receipt timestamp, ISO 8601. Never trust this for "when did it happen". */
  ingestedAt: string;

  source: TendEventSource;

  /**
   * Internal id linking back to a short-retention raw-payload audit log
   * entry (see store layer). This is NOT the raw payload itself — the
   * normalized event never carries the original JSON body.
   */
  rawEventId: string;
}

/** Type guard used by ingestion adapters before anything is trusted downstream. */
export function isTendEventType(value: unknown): value is TendEventType {
  return typeof value === 'string' && (TEND_EVENT_TYPES as string[]).includes(value);
}

export function isTendMotionSubType(value: unknown): value is TendMotionSubType {
  return typeof value === 'string' && (TEND_MOTION_SUBTYPES as string[]).includes(value);
}

export function isTendEventSource(value: unknown): value is TendEventSource {
  return typeof value === 'string' && (TEND_EVENT_SOURCES as string[]).includes(value);
}

/**
 * Structural validation for a candidate normalized event. Returns a list of
 * human-readable problems; an empty array means the event is well-formed.
 * This does NOT validate business logic (e.g. whether the household exists)
 * — only shape and required-field validity, which is what ingestion
 * adapters need before they persist anything.
 */
export function validateTendEvent(candidate: Partial<TendEvent>): string[] {
  const problems: string[] = [];

  const requiredStringFields: (keyof TendEvent)[] = [
    'householdId',
    'deviceId',
    'eventId',
    'requestId',
    'occurredAt',
    'ingestedAt',
    'rawEventId',
  ];

  for (const field of requiredStringFields) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push(`Missing or empty required field: ${String(field)}`);
    }
  }

  if (!isTendEventType(candidate.eventType)) {
    problems.push(`Missing or unsupported eventType: ${String(candidate.eventType)}`);
  }

  if (candidate.subType !== undefined && !isTendMotionSubType(candidate.subType)) {
    problems.push(`Unsupported subType: ${String(candidate.subType)}`);
  }

  if (candidate.eventType === 'motion_detected' && candidate.subType === undefined) {
    // Not fatal — Ring may omit subType — but the engine should be able to
    // fall back safely. We normalize this in the ingestion layer, not here.
  }

  if (!isTendEventSource(candidate.source)) {
    problems.push(`Missing or invalid source: ${String(candidate.source)}. Must be one of ${TEND_EVENT_SOURCES.join(', ')}`);
  }

  if (candidate.occurredAt !== undefined && Number.isNaN(Date.parse(candidate.occurredAt))) {
    problems.push(`occurredAt is not a valid ISO 8601 timestamp: ${candidate.occurredAt}`);
  }

  if (candidate.ingestedAt !== undefined && Number.isNaN(Date.parse(candidate.ingestedAt))) {
    problems.push(`ingestedAt is not a valid ISO 8601 timestamp: ${candidate.ingestedAt}`);
  }

  return problems;
}
