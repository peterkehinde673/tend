import * as crypto from 'node:crypto';
import { EventStore } from '../../store/eventStore';
import { TendEventSource } from '../../domain/event';
import { RingWebhookEnvelope } from './ringTypes';
import { normalizeRingWebhookEvent } from './ringNormalizer';

/**
 * Verifies a Ring webhook's HMAC-SHA256 signature using a constant-time
 * comparison (crypto.timingSafeEqual), so response timing cannot leak
 * information about how much of the expected signature matched. The raw
 * request body (exact bytes, not a re-serialized/re-parsed version) MUST be
 * used to compute the signature — re-serializing JSON can change byte-for-
 * byte formatting and silently break verification, which is why this
 * function takes `rawBody: string` rather than a parsed object.
 */
export function verifyRingSignature(rawBody: string, signatureHeader: string | undefined, hmacSecret: string): boolean {
  if (!signatureHeader) return false;

  const expected = crypto.createHmac('sha256', hmacSecret).update(rawBody, 'utf8').digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws if buffer lengths differ — a length mismatch is
  // itself a safe, immediate "not equal" rather than an exception path that
  // could be distinguished by timing or by crashing the caller.
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Basic replay/staleness check: rejects a webhook whose claimed `meta.time`
 * is further than `toleranceMs` from "now" in either direction. This limits
 * how useful a captured-and-replayed (but validly-signed) old payload can
 * be, without requiring any additional Ring-documented replay mechanism
 * (none is confirmed to exist beyond request_id idempotency).
 */
export function isWithinReplayTolerance(claimedTimeIso: string, now: Date = new Date(), toleranceMs = 5 * 60 * 1000): boolean {
  const claimed = Date.parse(claimedTimeIso);
  if (Number.isNaN(claimed)) return false;
  return Math.abs(now.getTime() - claimed) <= toleranceMs;
}

export interface RingWebhookHandlerResult {
  status: number;
  body: { accepted: boolean; reason?: string };
}

export interface RingWebhookHandlerOptions {
  householdId: string;
  source: Extract<TendEventSource, 'ring_real' | 'ring_playground'>;
  hmacSecret: string | undefined;
  now?: Date;
}

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * Handles one inbound Ring webhook request end to end: size limit, HMAC
 * verification (constant-time), JSON parsing, replay/timestamp check,
 * schema validation + normalization (via ringNormalizer), and idempotent
 * storage (via the existing EventStore — the exact same store the
 * simulator writes to, since both converge on TendEvent). Returns a plain
 * {status, body} result so it can be unit-tested without an HTTP server,
 * and is wired into the dev server as the actual POST /webhooks/ring route.
 *
 * Never logs the raw body or the signature/secret. Only ever returns a
 * safe `reason` string on rejection — no internals, no payload contents.
 */
export async function handleRingWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  store: EventStore,
  options: RingWebhookHandlerOptions,
): Promise<RingWebhookHandlerResult> {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    return { status: 413, body: { accepted: false, reason: 'Request body too large.' } };
  }

  if (!options.hmacSecret) {
    // Safe default: refuse to accept anything if no secret is configured,
    // rather than accepting unverified webhook data. This is the "leave
    // the webhook adapter ready but do not pretend it's live" behavior
    // requested for environments (like this one) with no real Ring
    // credentials configured.
    return { status: 501, body: { accepted: false, reason: 'Ring webhook verification is not configured (RING_WEBHOOK_HMAC_SECRET is unset).' } };
  }

  if (!verifyRingSignature(rawBody, signatureHeader, options.hmacSecret)) {
    return { status: 401, body: { accepted: false, reason: 'Invalid webhook signature.' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { accepted: false, reason: 'Request body is not valid JSON.' } };
  }

  const envelope = parsed as RingWebhookEnvelope;
  if (!envelope?.meta?.time || !isWithinReplayTolerance(envelope.meta.time, options.now)) {
    return { status: 400, body: { accepted: false, reason: 'Event timestamp is missing or outside the accepted replay tolerance window.' } };
  }

  const result = normalizeRingWebhookEvent(envelope, options.householdId, options.source, (options.now ?? new Date()).toISOString());
  if ('error' in result) {
    return { status: 400, body: { accepted: false, reason: result.error.reason } };
  }

  const stored = await store.append(result.event);
  if (!stored.accepted) {
    // A duplicate/replay by (eventId, requestId) is not an error — Ring's
    // own documentation expects webhook consumers to be idempotent and to
    // still acknowledge with 200, since Ring may retry a delivery.
    return { status: 200, body: { accepted: false, reason: stored.reason } };
  }

  return { status: 200, body: { accepted: true } };
}
