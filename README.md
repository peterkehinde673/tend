# Tend — Explainable Routine-Deviation Reasoning

Tend turns a household's Ring activity into a personalized routine baseline,
detects meaningful deviations from that routine, and explains *why* in
plain, non-alarmist language — instead of another raw motion-alert feed.

> **Status: Phase 1A core engine.** No real Ring account, Ring Playground,
> or physical Ring device is connected yet. Everything in this repository
> runs against a deterministic development simulator. See "Ring Integration
> Status" below for exactly what is and isn't real.

## The problem

Ring's own platform already advertises a template "elderly care monitoring"
use case: *motion analysis, activity alerts, daily summaries.* That's a
binary alert on raw motion — useful, but it doesn't know what's normal for
*this* household, doesn't explain *why* something is unusual, and doesn't
get better at avoiding false alarms over time.

Tend is deliberately not that. It:

- Learns a **personalized, per-household baseline** from actual observed
  activity, rather than applying a fixed "no motion for X minutes" rule.
- Scores deviations across three independent signals — **presence**,
  **timing**, and **sequence** — and produces **structured evidence**, not
  just a flag.
- Separates **deterministic, auditable math** from **natural-language
  explanation**, so nothing in the explanation can be a fact the system
  didn't actually compute.
- Includes a **caregiver feedback loop** that adjusts sensitivity
  conservatively over time, instead of either ignoring feedback or
  overreacting to a single click.

## What Tend is not

Tend does not perform facial recognition or any form of biometric
identification, does not diagnose illness or injury, does not claim or imply
an emergency, and does not correlate data across households. It reasons
about *whether a household's own routine looks different from usual*, in
plain language, with an explicit recommendation to "consider checking in" —
never a diagnosis, never a 911 call, never a claim about a specific person.

## Architecture

```
EventSource (Ring real / Ring Playground / dev simulator)
        │  produces TendEvent — never a raw payload
        ▼
EventStore (idempotent by eventId + requestId)
        │
        ▼
Baseline Engine  ──►  HouseholdBaseline (per-zone bucket stats, timing stats, transition stats)
        │
        ▼
Deviation Engine (deterministic, NEVER calls the reasoning layer)
        │  produces DeviationResult + structured EvidenceItem[]
        ▼
Reasoning Layer (Bedrock in production; Template fallback for offline dev)
        │  receives ONLY structured evidence — never raw events
        ▼
ReasoningOutput (severity, explanation, evidence references, fixed-wording recommendation)
        │
        ▼
Caregiver feedback  ──►  Sensitivity Engine (per-signal multiplier, conservative/corroboration-gated)
```

Every event, regardless of where it came from, is normalized into exactly
one `TendEvent` shape (`src/domain/event.ts`) before anything else touches
it. The engine layers never see a raw Ring webhook payload or know which
`EventSource` produced an event beyond its `source` tag.

## Event model

`TendEvent` (`src/domain/event.ts`) carries only fields that are documented
or safely derivable from the Ring Partner API research for this project:
`householdId`, `deviceId`, optional `componentId` (multi-camera devices
only), `eventId`/`requestId` (idempotency), `eventType`, optional `subType`
(motion classification), optional `zoneId` (household-configured, not part
of any Ring payload), `occurredAt`/`ingestedAt`, and a mandatory `source`.

**`source` is always one of:**
- `ring_real` — a genuine Ring account/device, not yet implemented.
- `ring_playground` — Ring's official Developer Playground, not yet implemented.
- `dev_simulator` — this repository's own deterministic generator. **This is
  the only source currently wired up.**

No image/video/audio data, no facial embeddings, and no biometric fields
exist anywhere in this model.

## Baseline algorithm (`src/engine/baselineEngine.ts`)

For each household, over a rolling window (default 14 days):

1. **Time buckets**: the day is split into 48 fixed 30-minute buckets,
   tracked separately for **weekday** vs **weekend**.
2. **EWMA activity probability**: for each (zone, bucket, day-type), an
   exponentially-weighted moving average (default α = 0.2) of whether
   activity occurred, so recent days matter more than stale ones without a
   full retrain.
3. **Timing statistics**: mean and standard deviation of each zone's
   first-activity-of-the-day time, so a household with a rock-solid routine
   and one with a naturally variable schedule are treated differently.
4. **Transition model**: a first-order `P(nextZone | fromZone, bucket,
   dayType)` table learned from observed zone-to-zone sequences. When the
   exact bucket has too few observations (`minTransitionObservationsForBucketLevel`,
   default 3) — which realistically happens once timing jitter spreads a
   household's routine across adjacent buckets — the engine falls back to
   an aggregated zone-level distribution rather than silently ignoring the
   transition. See `resolveTransitionDistribution`.
5. **Confidence**: `min(daysObserved / windowDays, 1.0)` — a baseline built
   from 3 days visibly carries less confidence than one built from 14+.

All weights and thresholds live in `src/config/config.ts` — nothing is a
magic number buried in engine code.

## Deviation algorithm (`src/engine/deviationEngine.ts`)

Purely deterministic. **Never calls the reasoning layer.**

- **Presence deviation**: derives contiguous "expected windows" (consecutive
  buckets with baseline probability ≥ `presenceExpectedThreshold`, default
  0.5) per zone, and checks whether each window (that has already ended
  as of the evaluation time) was actually observed. A missed window's score
  scales with how confidently it was expected (`p / sqrt(p·(1-p))`), so a
  near-certain routine that's missed surprises the system more than a
  naturally inconsistent one.
- **Timing deviation**: a z-score of today's first-activity time against the
  learned mean/std for that zone (with a configurable floor std to avoid
  division by ~0 for extremely regular routines).
- **Sequence deviation**: `1 − P(observedNextZone | learnedTransition)` for
  each consecutive pair of zone visits today.
- **Composite score**: a configurable weighted sum (default 50% presence /
  30% timing / 20% sequence), classified into `NORMAL` / `LOW` / `MODERATE`
  / `HIGH` against configurable thresholds (default 1.0 / 2.0 / 3.0).

Every non-trivial signal produces a **structured `EvidenceItem`** — a fact,
not a sentence. This is the only thing the reasoning layer is ever allowed
to see.

## Reasoning boundary (`src/reasoning/`)

This is the most important architectural boundary in the project:

- **Deterministic engine owns**: all arithmetic, thresholds, evidence
  generation, and severity classification.
- **Reasoning layer owns**: turning already-computed, already-scored
  evidence into a short, calm explanation. It receives `ReasoningInput`
  (`src/reasoning/contract.ts`) — composite score, severity, and evidence
  items — and **never** a raw event, a device ID, or a timestamp outside
  what's already in the evidence.
- `validateReasoningOutput` mechanically enforces this: severity must match
  the deterministic classification exactly, every evidence reference must
  exist in the input, `recommendedWording` must be one of three fixed
  phrases (never freely generated), a fixed list of banned terms
  (`emergency`, `diagnos*`, `injur*`, `facial recognition`, etc.) is
  rejected, and any number appearing in the explanation must be traceable
  back to the supplied evidence.
- `BedrockReasoningService` (`src/reasoning/bedrockReasoningService.ts`) is
  the real integration shape, built around an injectable `ModelInvoker` so
  it's fully unit-testable today. **It is not wired to a live AWS Bedrock
  call** — this sandboxed environment has no network access to install the
  AWS SDK, and per the approved architecture, real AWS deployment is a
  later phase regardless.
- `TemplateReasoningService` (`src/reasoning/templateReasoningService.ts`)
  is a deterministic, non-LLM fallback used by the CLI demo and dev server
  so the full pipeline can be exercised offline. **It is not Bedrock and is
  never described as such anywhere in this codebase.**

## Feedback mechanism (`src/feedback/feedbackEngine.ts`)

Caregiver feedback (`expected` / `not_useful` / `keep_watching` / `unusual`)
adjusts a **per-signal sensitivity multiplier** — never the baseline's
underlying observed-behavior statistics directly. Design:

- Bounded to `[0.5, 2.0]` (configurable).
- `keep_watching` is a strict no-op on the multiplier.
- The **first** occurrence of a feedback type for a signal only ever applies
  one minimal nudge (`nudgeStep`, default 0.1).
- A second **corroborating** event of the same type, for the same signal,
  within `corroborationWindowDays` (default 30) allows one additional step —
  never a compounding/multiplying effect.
- Every adjustment **decays back toward the default (1.0)** on a half-life
  (default 30 days), so a stale preference doesn't permanently silence a
  genuinely new pattern.

## Privacy & safety constraints

- No facial recognition, no biometric identification, anywhere in this codebase.
- No image, video, or audio data is stored — the event model carries
  metadata only.
- No cross-household data — every store/engine call is scoped to a single
  `householdId`.
- No medical diagnosis, no emergency claims — enforced both in the fixed
  `recommendedWording` allowlist and the banned-term check in
  `validateReasoningOutput`.
- No secrets are hardcoded or committed (there are none in this phase — no
  real Ring or AWS credentials exist yet).
- Reasoning input is contractually restricted to structured evidence (see
  above) — this also means a caregiver's own feedback text, if ever added as
  free-form input in a later phase, cannot smuggle arbitrary instructions
  into the reasoning layer's system prompt, since the contract only accepts
  the fixed `ReasoningInput` shape, not arbitrary strings.
- `eventId` + `requestId` together give any future real ingestion path
  (webhook or otherwise) the fields needed for idempotency/replay
  protection; `InMemoryEventStore` enforces this today.

## Ring integration status — read this before assuming anything is "real"

| Path | Status in this repo |
|---|---|
| `ring_real` (a genuine linked Ring account/device) | **Client, normalizer, webhook receiver, and `ring:check` are implemented and unit-tested — but no live call has ever succeeded.** See "Phase 2: what was actually verified" below. |
| `ring_playground` (Ring's official Developer Playground) | **Not implemented as an event source.** Whether Playground-simulated events reach an external webhook remains genuinely UNKNOWN — see below; nothing here depends on that answer either way. |
| `dev_simulator` | **Fully implemented.** `src/ingestion/simulator.ts` deterministically generates schema-accurate `TendEvent`s. This is a development/test tool, explicitly labeled as such everywhere it appears (code comments, CLI output, server startup banner, and the `source` field itself). |

**This is not an official Ring simulator, and this project does not claim
Ring integration is working.** The `EventSource` interface
(`src/ingestion/eventSource.ts`) exists specifically so a real
`RingWebhookEventSource` or `RingPlaygroundEventSource` can be added later
without touching the baseline, deviation, or reasoning layers at all.

## Phase 2: Ring integration adapter

`src/ingestion/ring/` implements the smallest genuine Ring integration
boundary, built strictly against the `EventSource` interface established in
Phase 1 — the core engine (baseline/deviation/reasoning/feedback) was not
touched.

- `ringConfig.ts` — loads `RING_ACCESS_TOKEN`, `RING_EVENT_SOURCE`
  (`ring_real` | `ring_playground`, never inferred), optional
  `RING_API_BASE_URL` (defaults to the documented
  `https://api.amazonvision.com`), and optional
  `RING_WEBHOOK_HMAC_SECRET`. Throws a clear, actionable `RingConfigError`
  when required configuration is missing — this project fails safely
  rather than guessing or proceeding unauthenticated. `redactToken()` is
  used anywhere a token's *presence* needs reporting; the value itself is
  never included.
- `ringTypes.ts` — two confidence tiers, handled very differently:
  - **CONFIRMED**: the webhook envelope shape (`meta`/`data` with
    `type`/`subType`/`attributes.source`/`source_type`/`component_ids`),
    captured directly from Ring's API documentation.
  - **Device discovery** (`GET /v1/devices`): a concrete example response
    was found during Phase 2 research directly in Ring's own Partner API
    documentation — a JSON:API `{ meta, data: [...] }` envelope with
    `type`/`id`/`attributes.name`/`relationships` per device. This
    project's client and normalizer were written defensively *before*
    finding that example and happen to already be compatible with it;
    fields beyond that one example are still not confirmed for every
    device type, so parsing stays defensive rather than assuming a rigid
    schema.
  - `GET /v1/users/me`'s response body remains **unconfirmed** — no
    example was captured. `ring:check` reports only that the call
    succeeded, never assumes a shape from the body.
- `ringClient.ts` — `RingApiClient`: authenticated GET only (`getCurrentUser`,
  `listDevices`, generic `authenticatedGet`). Deliberately does **not**
  implement live video, media downloads, computer vision, facial
  recognition, WHEP streaming, or device controls — none of those are
  needed for Tend and each would expand the privacy/security surface for
  no benefit. Uses Node's built-in global `fetch`; never logs the
  Authorization header or token, on any code path including errors.
- `ringNormalizer.ts` — `normalizeRingWebhookEvent` converts a
  (signature-already-verified) Ring webhook envelope into a `TendEvent`,
  rejecting anything malformed or unsupported rather than guessing;
  `summarizeRingDevice` defensively extracts an id/label from an
  unconfirmed-shape device entry without ever throwing on an unexpected
  shape.
- `ringEventSource.ts` — `RingEventSource` implements the existing
  `EventSource` interface. Read this carefully: Ring delivers events via
  webhook **push**, not a pull-style "recent events" API (the Event
  History API exists per documentation but is out of scope for this
  phase). So `pull()` honestly returns `[]` — it does not fabricate events
  from device-discovery data, since a device is not an event. Its real,
  verified purpose this phase is `checkConnection()` and
  `discoverDevices()`, which `ring:check` uses to prove genuine runtime
  Ring API usage.
- `ringWebhookHandler.ts` — `handleRingWebhook`, a pure, fully unit-tested
  function (no HTTP server needed to test it) implementing: request-size
  limit, constant-time HMAC-SHA256 verification (`crypto.timingSafeEqual`),
  a ±5 minute replay/staleness tolerance window on `meta.time`, JSON schema
  validation via the normalizer, and idempotent storage via the same
  `EventStore` interface the simulator uses. **Safe-deny default**: if
  `RING_WEBHOOK_HMAC_SECRET` isn't configured, it returns `501` and stores
  nothing, rather than accepting unverified data.
- Wired into the dev server as `POST /webhooks/ring`, storing into a
  **separate** in-memory event store from the simulator/demo data — Ring-
  sourced and simulator-sourced events never mix.

### `ring:check` — the runtime proof command

```bash
npm run ring:check
```

Reads `RING_ACCESS_TOKEN`/`RING_EVENT_SOURCE`, and — **only if both are
present** — makes a real HTTP call to the Ring Partner API. Never prints
the token; only reports whether one is configured and its length. Exits
non-zero and states exactly what's missing if configuration is absent.
**Never fakes success.**

### Phase 2: what was actually verified (read this before trusting any Ring claim)

- **Unit-level, mocked**: `RingApiClient`, `RingEventSource`, and
  `handleRingWebhook` are fully tested against a mocked global `fetch` and
  hand-built fixtures — 59 new tests, all passing. These prove the
  request-construction, response-parsing, signature-verification, replay,
  and idempotency logic is correct in isolation. **They do not prove
  anything about Ring's real API**, and are never described as doing so.
- **Live network call**: attempted for real via `ring:check`, with a
  placeholder (non-functional) token. The result: `HTTP 403` from
  `https://api.amazonvision.com`, with the response body
  `Host not in allowlist: api.amazonvision.com... x-deny-reason:
  host_not_allowed` — this is this **sandboxed development environment's
  own network egress proxy** blocking the outbound call before it ever
  reaches Ring's servers, not a decision made by Ring's API. This was
  independently confirmed via direct `curl` to `api.amazonvision.com`,
  `oauth.ring.com`, and `developer.amazon.com` — all three are blocked the
  same way. **No live Ring API call has ever succeeded from this
  environment**, and none is claimed to have.
- **Ring Developer Playground**: re-investigated directly for Phase 2.
  `https://developer.amazon.com/ring/console/playground` disallows
  automated fetching per its `robots.txt` (confirmed directly — a fetch
  attempt was refused for exactly this reason), and using it in practice
  requires an authenticated browser session this project has no access to.
  Combined with the unresolved documentation question from Phase 1
  (whether Playground-simulated events reach an externally-registered
  webhook — still not stated anywhere in the documentation found), this
  means: **the Playground's actual behavior for this specific question
  remains UNKNOWN, and can only be resolved by a human logging into the
  real portal.** This is not a gap this project can close from within a
  sandboxed research/coding environment.
- **Documentation discrepancy noted**: Ring's "API Development Guide" page
  states webhooks support "three webhook types" (motion, device added,
  device removed), while the Release Notes changelog lists 10 cumulative
  event types (including `button_press`, `device_online`/`offline`,
  subscription events, etc.). This project follows the more detailed,
  explicitly-dated release-notes list (`RING_WEBHOOK_EVENT_TYPES` in
  `ringTypes.ts`) and rejects, rather than guesses at, anything outside it.

### Environment variables (Ring integration)

| Variable | Required | Purpose |
|---|---|---|
| `RING_ACCESS_TOKEN` | Yes, for any real Ring call | Bearer token for the Ring Partner API |
| `RING_EVENT_SOURCE` | Yes, for any real Ring call | `ring_real` or `ring_playground` — always explicit, never inferred |
| `RING_API_BASE_URL` | No | Overrides the default `https://api.amazonvision.com` (e.g. for a staging URL) |
| `RING_WEBHOOK_HMAC_SECRET` | No | Enables `POST /webhooks/ring`; without it, the route safely returns 501 |

None of these are ever committed; no `.env` file exists in this repository.

## Development simulator

`HouseholdSimulator` (`src/ingestion/simulator.ts`) generates four
deterministic scenarios for a fixed household layout (kitchen → entrance →
kitchen → bedroom, matching the routine used throughout this project's
planning):

- `normal` — the routine with small jitter (±5 min).
- `variable_normal` — the same routine with larger jitter (±18 min); should
  generally stay at low severity, since it's still "normal for this
  household," just noisier.
- `deviation_missing` — kitchen and entrance occur; the later kitchen
  return and bedroom activity never happen.
- `sequence_deviation` — the same four zones occur, but with each zone
  reassigned to a different time slot than usual, producing a genuinely
  different chronological order (not just a different array order — an
  earlier version of this simulator had that bug; see `simulator.test.ts`
  for the scenario-shape tests that would have caught it).

`generateHistoricalWindow` deterministically seeds 14 days of `normal` data
from a given seed, so the same seed always produces the same baseline.

**Known calibration property, observed by actually running the demo, not
just inferred:** with the default 14-day baseline and default weights,
`deviation_missing` currently classifies as `NORMAL` (composite ≈0.69),
while `sequence_deviation` reaches `LOW` (composite ≈1.32). This is a
legitimate consequence of presence-deviation being an *average* across
expected windows rather than a sum, combined with a fairly confident
14-day baseline — not a bug. It's a real Phase 1B tuning question (do we
want a single fully-silent morning to register higher than LOW?) rather
than something quietly papered over here.

## Running things

```bash
npm install        # see "Environment note" below
npm run typecheck   # tsc --noEmit
npm test             # builds, then runs the full suite with node:test
npm run dev:demo -- <scenario>   # normal | deviation_missing | variable_normal | sequence_deviation
npm run dev:server   # starts the local HTTP dev server on :8787
npm run ring:check   # proves (or honestly disproves) genuine runtime Ring API usage — see below
```

### Dev server endpoints

All data comes from the in-memory development simulator (`source:
dev_simulator`); nothing here talks to AWS or Ring.

- `GET /health` — liveness check.
- `GET /demo` — full snapshot: baseline + deviation + reasoning + recent events.
- `GET /events` — recent normalized events.
- `GET /baseline` — the current household baseline.
- `GET /deviation` — the current deviation result.
- `GET /reasoning` — the current reasoning-layer output.
- `POST /scenario` — `{ "scenario": "normal" | "deviation_missing" | "variable_normal" | "sequence_deviation" }` — regenerates "today"'s events.
- `POST /feedback` — `{ "feedbackType": "expected" | "not_useful" | "keep_watching" | "unusual", "signals": string[] }`.
- `POST /webhooks/ring` — Ring Partner API webhook receiver. Requires the `x-signature` header and `RING_WEBHOOK_HMAC_SECRET` to be configured; returns `501` otherwise. Stores into a separate event store from the simulator data above.

### Environment note (read before filing an issue about missing packages)

This project was built in a sandboxed environment with **no npm registry
access**. As a result:

- Tests use Node's built-in `node:test` / `node:assert` — **not Jest** —
  because Jest could not be installed.
- The dev server uses Node's built-in `http` module — **not Express** — for
  the same reason.
- `@types/node` is vendored into `node_modules/@types/node` from a copy
  bundled with another globally-available package, rather than installed
  from the registry.

None of this is an architectural recommendation for production — before
real AWS/Bedrock integration, add `@aws-sdk/client-bedrock-runtime` as a
proper dependency; a real package manager run should replace the vendored
`@types/node` the moment registry access is available.

## Current limitations

- No live Ring API call has ever succeeded from this development
  environment — see "Phase 2: what was actually verified" above for the
  exact, checkable reason (sandbox egress policy, confirmed via direct
  `curl`), and no Ring Playground event source or webhook delivery has
  been confirmed either.
- No AWS integration (Lambda, API Gateway, DynamoDB, EventBridge, SNS, SES,
  Step Functions) — explicitly out of scope until Ring integration is
  proven with a real account, per the approved phase plan. Bedrock remains
  behind the existing `ReasoningService` interface, unconnected to a live
  model.
- No authentication/authorization on the dev server — it's explicitly a
  local development tool, not exposed infrastructure.
- No persistence — `InMemoryEventStore` and `SensitivityStore` reset on
  restart. A DynamoDB-backed implementation can be dropped in behind the
  existing `EventStore` interface without touching any other layer.
- The `deviation_missing` vs `sequence_deviation` calibration property noted
  above is a known open tuning question, not a defect being hidden.
- `zoneId` is currently assigned directly by the simulator; a real
  integration needs a household-onboarding step to map real Ring
  `deviceId`s to human-meaningful zone names, since Ring's webhook payloads
  don't include this.
- The Ring Event History API and the Ring Partner API's `GET /v1/users/me`
  response shape remain unconfirmed/unused — this project only implements
  what was needed and could be verified for a minimal, honest integration
  boundary.
