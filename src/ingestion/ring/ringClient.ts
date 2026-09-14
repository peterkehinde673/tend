import { RingConfig, redactToken } from './ringConfig';
import { RingRawDevice, RingRawUser } from './ringTypes';

/**
 * Deliberately minimal. Per the approved Phase 2 scope, this client
 * supports ONLY: an authenticated request primitive, current-user lookup,
 * and device discovery. It does NOT implement live video, media downloads,
 * computer vision, or device controls — none of those are needed for
 * Tend's routine-deviation reasoning, and each one would expand the
 * capability (and privacy/security surface) well beyond what this phase
 * calls for.
 *
 * Uses Node's built-in global `fetch` (available in Node 18+) — no HTTP
 * client dependency, consistent with the rest of this project's
 * zero-dependency stance in this sandboxed environment.
 */

export class RingApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = 'RingApiError';
  }
}

export class RingApiClient {
  constructor(private readonly config: RingConfig) {}

  /**
   * Performs an authenticated GET against the Ring Partner API. Never logs
   * the Authorization header or token value under any code path, including
   * error paths — errors carry only status codes and safe metadata.
   */
  async authenticatedGet(path: string): Promise<unknown> {
    const url = `${this.config.apiBaseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      // Network-level failure (DNS, connection refused, TLS, egress policy,
      // etc.) — never include the token in this error, and don't assume
      // this means the token itself is bad.
      throw new RingApiError(
        `Network error calling Ring API at ${this.config.apiBaseUrl}${path}: ${(err as Error).message}. ` +
          `This is a connectivity failure (or a network egress policy blocking this host), not necessarily an authentication problem. ` +
          `Token status: ${redactToken(this.config.accessToken)}.`,
        undefined,
        err,
      );
    }

    if (!response.ok) {
      throw new RingApiError(
        `Ring API returned HTTP ${response.status} for ${path}. Token status: ${redactToken(this.config.accessToken)}.`,
        response.status,
        undefined,
      );
    }

    try {
      return await response.json();
    } catch (err) {
      throw new RingApiError(`Ring API response for ${path} was not valid JSON: ${(err as Error).message}`, response.status, err);
    }
  }

  /**
   * GET /v1/users/me — documented as part of the Ring Partner API's Users
   * API. Response shape is UNCONFIRMED (see ringTypes.ts), so this returns
   * the raw parsed JSON for the normalizer to handle defensively rather
   * than casting it to a rigid type here.
   */
  async getCurrentUser(): Promise<RingRawUser> {
    const raw = await this.authenticatedGet('/v1/users/me');
    return raw as RingRawUser;
  }

  /**
   * GET /v1/devices — documented device discovery endpoint. Response shape
   * is UNCONFIRMED beyond "the endpoint exists and returns JSON"; this
   * method makes only the minimal assumption that a successful response is
   * either an array of device-like entries or an object with a `data`
   * array (the JSON:API convention Ring's docs say the API follows). If
   * neither shape matches, it returns an empty array rather than throwing —
   * the caller (ring:check / RingEventSource) is responsible for reporting
   * that discovery returned zero usable devices, which is itself useful,
   * truthful information.
   */
  async listDevices(): Promise<RingRawDevice[]> {
    const raw = await this.authenticatedGet('/v1/devices');
    if (Array.isArray(raw)) {
      return raw as RingRawDevice[];
    }
    if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
      return (raw as { data: RingRawDevice[] }).data;
    }
    return [];
  }
}
