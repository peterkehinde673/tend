/**
 * All Ring integration configuration comes from environment variables.
 * Nothing here is ever hardcoded, and nothing here is ever logged in full —
 * see redactToken() below, used anywhere a token might otherwise end up in
 * a log line.
 *
 * CONFIRMED vs UNKNOWN, per the project's Ring documentation research:
 * - Base URL `https://api.amazonvision.com` is documented directly.
 * - `/v1/users/me` and `/v1/devices` are documented as existing endpoints
 *   (device discovery, Users API), but this project has not captured a
 *   confirmed example response body for either — see ringClient.ts and
 *   ringNormalizer.ts for how that uncertainty is handled defensively.
 */

export class RingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RingConfigError';
  }
}

export interface RingConfig {
  /** Bearer token for the Ring Partner API (or a Ring Playground one-click token, ~30 min lifetime). */
  accessToken: string;
  /** Documented base URL for the Ring Partner API. */
  apiBaseUrl: string;
  /**
   * Which provenance this configuration represents. Must be set explicitly
   * via RING_EVENT_SOURCE — never inferred from the token's shape, since
   * this project has no reliable way to tell a real-account token from a
   * Playground token just by looking at it.
   */
  source: 'ring_real' | 'ring_playground';
  /** HMAC-SHA256 signing secret for verifying inbound Ring webhooks, if configured. */
  webhookHmacSecret: string | undefined;
}

/**
 * Redacts a token/secret for safe display: shows only that a value is
 * present and its length, never any of its actual characters. Used any time
 * configuration status needs to be reported to a human (e.g. `ring:check`).
 */
export function redactToken(value: string | undefined): string {
  if (!value) return '(not set)';
  return `(set, ${value.length} chars, redacted)`;
}

/**
 * Loads RingConfig from environment variables. Throws RingConfigError with
 * a clear, actionable message if required configuration is missing — this
 * project fails safely rather than silently proceeding with no
 * authentication or guessing a default token.
 */
export function loadRingConfig(env: NodeJS.ProcessEnv = process.env): RingConfig {
  const accessToken = env.RING_ACCESS_TOKEN;
  if (!accessToken || accessToken.trim().length === 0) {
    throw new RingConfigError(
      'Missing RING_ACCESS_TOKEN environment variable. Ring integration cannot authenticate without it. ' +
        'Set RING_ACCESS_TOKEN to a Bearer token issued by Ring account linking or the Ring Developer Playground.',
    );
  }

  const apiBaseUrl = env.RING_API_BASE_URL && env.RING_API_BASE_URL.trim().length > 0 ? env.RING_API_BASE_URL : 'https://api.amazonvision.com';

  const rawSource = env.RING_EVENT_SOURCE;
  if (rawSource !== 'ring_real' && rawSource !== 'ring_playground') {
    throw new RingConfigError(
      'Missing or invalid RING_EVENT_SOURCE environment variable. Set it to exactly "ring_real" or "ring_playground" ' +
        'so every event this integration produces is labeled with its true provenance — this is never inferred automatically.',
    );
  }

  const webhookHmacSecret = env.RING_WEBHOOK_HMAC_SECRET && env.RING_WEBHOOK_HMAC_SECRET.trim().length > 0 ? env.RING_WEBHOOK_HMAC_SECRET : undefined;

  return { accessToken, apiBaseUrl, source: rawSource, webhookHmacSecret };
}

/** Non-throwing variant for callers (like `ring:check`) that want to report configuration status rather than crash. */
export function tryLoadRingConfig(env: NodeJS.ProcessEnv = process.env): { config: RingConfig } | { error: string } {
  try {
    return { config: loadRingConfig(env) };
  } catch (err) {
    if (err instanceof RingConfigError) {
      return { error: err.message };
    }
    throw err;
  }
}
