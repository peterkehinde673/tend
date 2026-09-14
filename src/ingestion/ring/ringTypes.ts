/**
 * Types for Ring Partner API data this project actually consumes.
 *
 * Two confidence tiers, and they are handled very differently:
 *
 * 1. CONFIRMED — the webhook envelope. This project's earlier research
 *    captured a concrete example structure for `motion_detected` webhooks
 *    directly from Ring's API documentation: a `meta`/`data` envelope with
 *    `type`, `subType`, and `attributes.source`/`source_type`/
 *    `component_ids`. RingWebhookEnvelope below reflects exactly that, and
 *    the normalizer (ringNormalizer.ts) trusts these fields.
 *
 * 2. UNCONFIRMED — device discovery / current-user response bodies. This
 *    project's research confirmed that `GET /v1/devices` and
 *    `GET /v1/users/me` exist as documented endpoints (device discovery,
 *    Users API, JSON:API-based), but did NOT capture a concrete example
 *    response body for either. RingRawDevice/RingRawUser below are
 *    deliberately loose (`unknown`-safe), and ringNormalizer.ts extracts
 *    fields defensively rather than assuming a rigid shape — this is the
 *    honest way to handle "the endpoint exists" without pretending to know
 *    its exact JSON shape.
 */

/**
 * Ring's confirmed webhook event types (from the Ring Appstore API release
 * notes, which lists these 10 cumulatively across releases).
 *
 * NOTE — documentation discrepancy observed during Phase 2 research: the
 * "Ring API Development Guide" page (develop.html) separately states "The
 * API supports three webhook types: motion detection events, device
 * addition notifications, and device removal events" — a smaller, older-
 * sounding list. This project follows the more detailed, explicitly dated
 * release-notes list below rather than silently picking one; if a real
 * integration encounters an event type not in this list, normalizeRingWebhookEvent
 * will reject it explicitly rather than guessing.
 */
export type RingWebhookEventType =
  | 'motion_detected'
  | 'button_press'
  | 'device_added'
  | 'device_removed'
  | 'device_online'
  | 'device_offline'
  | 'app_integration_added'
  | 'app_integration_removed'
  | 'subscription_activated'
  | 'subscription_deactivated';

export const RING_WEBHOOK_EVENT_TYPES: readonly RingWebhookEventType[] = [
  'motion_detected',
  'button_press',
  'device_added',
  'device_removed',
  'device_online',
  'device_offline',
  'app_integration_added',
  'app_integration_removed',
  'subscription_activated',
  'subscription_deactivated',
];

export interface RingWebhookMeta {
  version?: string;
  time: string;
  request_id: string;
  account_id: string;
}

export interface RingWebhookDataAttributes {
  /** The device_id this event is associated with. */
  source: string;
  source_type: string;
  /** Only present for multi-camera devices (e.g. Ring Elite modules). */
  component_ids?: string[];
}

export interface RingWebhookData {
  id: string;
  type: RingWebhookEventType;
  /** Only meaningful for motion_detected. Ring's own classification value — not guaranteed to be one of Tend's TendMotionSubType values, hence the normalizer maps defensively rather than casting. */
  subType?: string;
  attributes: RingWebhookDataAttributes;
}

/** The confirmed shape of a Ring Partner API webhook POST body. */
export interface RingWebhookEnvelope {
  meta: RingWebhookMeta;
  data: RingWebhookData;
}

/**
 * A loosely-typed raw device entry from `GET /v1/devices`.
 *
 * UPDATE (Phase 2 documentation re-check): a concrete example response was
 * found directly in Ring's own Partner API Documentation page:
 *   { "meta": { "time": "..." },
 *     "data": [ { "type": "devices", "id": "ava1.ring.device.XXXYYY",
 *                 "attributes": { "name": "Front Door Camera" },
 *                 "relationships": { "status": {...}, "capabilities": {...} } } ] }
 * This CONFIRMS the JSON:API `{ meta, data: [...] }` envelope and the
 * `type`/`id`/`attributes.name` fields this project's client and
 * normalizer already handled defensively (see ringClient.ts#listDevices
 * and ringNormalizer.ts#summarizeRingDevice) — those were written before
 * this confirmation was found, as a permissive best-guess, and happen to
 * be compatible with it. `relationships` (status/capabilities links) is
 * now confirmed to exist but is NOT consumed anywhere in this project —
 * out of scope per the "no live video/media/device controls" restriction.
 * Fields beyond this one example are still not confirmed to be present on
 * every device type, so this type remains deliberately permissive.
 */
export interface RingRawDevice {
  id?: unknown;
  type?: unknown;
  attributes?: {
    name?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A loosely-typed raw response from `GET /v1/users/me`. Same UNCONFIRMED caveat as RingRawDevice. */
export interface RingRawUser {
  id?: unknown;
  type?: unknown;
  attributes?: {
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RingDeviceSummary {
  /** Only populated if a string id field was actually present in the raw response. */
  id: string | null;
  /** Only populated if a string name/type field was actually present. */
  label: string | null;
  /** True if the raw entry could not be defensively parsed at all. */
  unparsed: boolean;
}
