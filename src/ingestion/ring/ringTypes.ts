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

/**
 * Event History API types — READ THIS BEFORE TRUSTING ANYTHING BELOW.
 *
 * CONFIRMED (from Ring's own documentation, api-documentation.html):
 * - The Event History API exists and is Ring's own documented "polling
 *   alternative" to webhooks: "If you aren't ready to process webhooks at
 *   launch, acknowledge deliveries with 200 and use the Event History API
 *   instead."
 * - All Ring Partner API endpoints use base URL `https://api.amazonvision.com`,
 *   JSON:API format, and Bearer token auth.
 *
 * UPGRADED CONFIDENCE (Phase 4 re-check) — corroborated, but NOT from an
 * Amazon-authored documentation page directly:
 * - `GET /v1/history/devices/{device_id}/events` and a comma-separated
 *   `event_types` query parameter (e.g. `event_types=motion,on_demand` for
 *   cameras, `event_types=ding,on_demand,motion` for doorbells) appear in
 *   a real developer's post on the Amazon Developer Community forum
 *   (community.amazondeveloper.com, "Obtaining a camera snapshot",
 *   May 2026) describing their own working integration. This is
 *   user-generated forum content, not an Amazon-authored documentation
 *   page — a second independent real-world source corroborating the same
 *   shape this project had already guessed by analogy, but still short of
 *   a captured example from Ring's own docs. `RING_HISTORY_PATH_TEMPLATE`
 *   below has been updated to match this corroborated path.
 * - The project owner separately asserted that current official
 *   documentation confirms dotted per-subtype filtering values such as
 *   `motion.human`/`motion.vehicle`/`motion.animal`/`motion.other_motion`.
 *   This project's own research found that specific dotted vocabulary
 *   ONLY inside an unofficial, third-party Python client/emulator project
 *   ("ring-sandbox" on GitHub) — i.e. that project's own invented
 *   abstraction over the API, not a confirmed literal value from Ring
 *   itself. The CONFIRMED webhook payload (motion-detection.html) uses a
 *   separate `type`/`subType` field pair, not a combined dotted string —
 *   consistent with how this project already models subType. This
 *   project therefore keeps `event_types` filtering to flat values
 *   (`motion`, `on_demand`, `ding`) rather than adopting the dotted
 *   convention, pending an actual captured example from Ring's own
 *   documentation confirming otherwise.
 *
 * STILL NOT CONFIRMED from an Amazon-authored documentation page directly:
 * - The exact response body shape. RingRawHistoryEntry below is modeled by
 *   analogy to the CONFIRMED webhook `data` shape (JSON:API `id`/`type`/
 *   `attributes`), since every other confirmed Ring endpoint follows that
 *   convention — but this is an analogy, not a captured example, and the
 *   normalizer (see ringNormalizer.ts#normalizeRingHistoryEntry) parses it
 *   defensively rather than assuming it's exactly right.
 *
 * CRITICAL, UNRELATED-API WARNING found during Phase 2's research (still
 * holds after the Phase 4 re-check): the event "kind" vocabulary `motion`
 * / `on_demand` / `ding` ALSO appears in the changelog of
 * `python-ring-doorbell` — a well-known **unofficial, third-party**
 * library that reverse-engineers Ring's separate, undocumented
 * **consumer app** API, a DIFFERENT API surface from the official Ring
 * Partner/Appstore API (`api.amazonvision.com`) this project integrates
 * with. The Phase 4 community-forum corroboration above is a real
 * developer describing the official Partner API specifically, which is
 * why this project now treats the flat `motion`/`on_demand`/`ding`
 * vocabulary as reasonably corroborated for the Partner API too — but
 * `on_demand` and `ding` are still never treated as equivalent to a
 * genuine passively-detected `motion` event. `on_demand` in particular is
 * presumed to correspond to a manually-triggered/live-view-initiated
 * result (e.g. via Ring Playground) rather than autonomous motion
 * detection, though this project has not independently confirmed that
 * specific correspondence either — it is rejected regardless, on the
 * principle that only `motion` is treated as production-grade evidence.
 * See normalizeRingHistoryEntry's hard restriction to `ring_real`.
 */

/** Corroborated by a real-developer community-forum report (Amazon Developer Community); not from an Amazon-authored documentation page directly. See block comment above. */
export const RING_HISTORY_PATH_TEMPLATE = '/v1/history/devices/{deviceId}/events';

/** The only event kind this project's history-polling path is built to trust. Anything else is rejected, not guessed at. */
export const CONFIRMED_HISTORY_EVENT_KIND = 'motion' as const;

/**
 * Kinds explicitly known to NOT represent a genuine, passively-detected
 * production event. `on_demand` and `ding` are corroborated as real
 * Partner API `event_types` values by the Phase 4 community-forum report
 * referenced above; `ding` is a legitimate doorbell-press event but is
 * handled via the confirmed `button_press` webhook type elsewhere in this
 * project, not via history polling, so it is excluded here too rather
 * than silently accepted as a motion-equivalent.
 */
export const NON_PRODUCTION_HISTORY_EVENT_KINDS: readonly string[] = ['on_demand', 'ding'];

/** Loosely-typed raw history entry. UNCONFIRMED shape — see block comment above. */
export interface RingRawHistoryEntry {
  id?: unknown;
  type?: unknown;
  attributes?: {
    /** ASSUMED field name for the event classification. Not confirmed. */
    kind?: unknown;
    /** ASSUMED field name for when the event occurred. Not confirmed — checked alongside `time`/`timestamp` defensively. */
    occurred_at?: unknown;
    time?: unknown;
    timestamp?: unknown;
    sub_type?: unknown;
    device_id?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
