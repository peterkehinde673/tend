import * as crypto from 'node:crypto';
import { EventStore } from '../../store/eventStore';
import { TendEventSource } from '../../domain/event';
import { RingWebhookEnvelope } from './ringTypes';
import { normalizeRingWebhookEvent } from './ringNormalizer';

/**
 * Verifies a Ring webhook's HMAC-SHA256 signature using a constant-time
 * comparison (crypto.timingSafeEqual). Ring sends the signature as
 * `sha256=<hex-digest>` in X-Signature; the bare hex form is also accepted
 * for backwards compatibility with Tend's existing local/dev callers.
 *
 * The raw request body (exact bytes, not a re-serialized/re-parsed version)
 * MUST be used to compute the signature — re-serializing JSON can change
 * byte-for-byte formatting and silently break verification.
 */
export function verifyRingSignature(rawBody: string, signatureHeader: string | undefined, hmacSecret: string): boolean {
  if (!signatureHeader) return false;

  const expected = crypto.createHmac('sha256', hmacSecret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice('sha256='.length) : signatureHeader;

  // A SHA-256 hex digest is exactly 64 ASCII characters. Reject malformed
  // values before the constant-time comparison rather than accepting an
  // arbitrary same-length string.
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) return false;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided.toLowerCase(), 'utf8');
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Basic replay/staleness check: rejects a webhook whose claimed `meta.time`
 * is further than `toleranceMs` from "now" in either direction.
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
 * verification, JSON parsing, replay/timestamp check, schema validation +
 * normalization, and idempotent storage.
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
    return { status: 200, body: { accepted: false, reason: stored.reason } };
  }

  return { status: 200, body: { accepted: true } };
}
