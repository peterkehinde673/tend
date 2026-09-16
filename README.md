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
  the provider-independent Bedrock adapter shape, built around an
  injectable `ModelInvoker` so it's fully unit-testable without any AWS
  account. As of Phase 3, a real implementation of `ModelInvoker`
  (`BedrockModelInvoker`, `src/reasoning/bedrock/`) exists and uses the
  actual AWS SDK v3 Bedrock Converse API — see "AWS / Amazon Bedrock
  Integration" below for exactly what that does and does not prove in this
  environment.
- `TemplateReasoningService` (`src/reasoning/templateReasoningService.ts`)
  is a deterministic, non-LLM fallback used whenever Bedrock isn't
  configured or fails for any reason (see `FallbackReasoningService`
  below). **It is not Bedrock and is never described as such anywhere in
  this codebase.**
- `FallbackReasoningService` (`src/reasoning/fallbackReasoningService.ts`)
  is a small, entirely provider-independent composition: try a primary
  `ReasoningService`, and on ANY failure (missing config, missing SDK,
  network failure, a malformed model response that fails
  `validateReasoningOutput`), fall back to a secondary one. This is what
  guarantees the dashboard/CLI never breaks just because AWS isn't
  configured or reachable.

## AWS / Amazon Bedrock Integration

**Read the CONFIRMED / NOT VERIFIED split below carefully before trusting
any claim about Bedrock working.**

### Architecture

```
Deterministic evidence (unchanged from the Reasoning boundary above)
        │  ReasoningInput — never raw events, never Ring payloads
        ▼
ReasoningService (existing, provider-independent interface, UNCHANGED)
        │
        ▼
FallbackReasoningService
        ├─ primary: BedrockReasoningService(BedrockModelInvoker(BedrockClient))
        │     — real AWS SDK v3 Converse API call, see src/reasoning/bedrock/
        └─ fallback: TemplateReasoningService
              — used whenever the primary fails for ANY reason
```

**Bedrock explains; it does not decide.** Nothing changed about the
deterministic/reasoning boundary described above — `BedrockModelInvoker`
only ever receives the same `ReasoningInput` (composite score, severity,
structured evidence) that `TemplateReasoningService` and every existing
test already use. Bedrock cannot alter the severity classification
(`validateReasoningOutput` rejects a mismatched `severityLabel`), cannot
invent evidence (a number/reference not present in the input is rejected),
and is never given raw Ring events, device IDs, or timestamps outside what
the deterministic engine already computed.

### Files

- `src/reasoning/bedrock/bedrockConfig.ts` — reads only `AWS_REGION` and
  `BEDROCK_MODEL_ID`. AWS credentials themselves are **never** read here or
  anywhere else in this project — they're resolved entirely by the AWS
  SDK's own standard credential provider chain (env vars it reads itself,
  shared credentials file, IAM role, SSO, etc.), per this project's
  security rules.
- `src/reasoning/bedrock/bedrockTypes.ts` — `BedrockInvocationError` and a
  more specific `BedrockSdkUnavailableError` for the "package genuinely
  isn't installed" case (see below).
- `src/reasoning/bedrock/bedrockClient.ts` — wraps the real
  `@aws-sdk/client-bedrock-runtime` Converse API. **Loads the SDK via a
  runtime `import()` rather than a static import.** This is not
  decorative: this sandboxed development environment's network egress
  proxy blocks `registry.npmjs.org` (confirmed directly via `curl` —
  `x-deny-reason: host_not_allowed`, the same behavior already documented
  for Ring's API domains), so `npm install` cannot fetch this package
  here. The dynamic-import pattern is what lets the rest of this project
  typecheck, build, and test cleanly in an environment where an optional
  heavy dependency can't be installed — it is a real, working pattern for
  this exact situation, not a workaround that hides the limitation. The
  moment the package is actually installed elsewhere, this code calls the
  real API with no changes required.
- `src/reasoning/bedrock/bedrockReasoner.ts` — `BedrockModelInvoker`,
  the thin bridge implementing the existing `ModelInvoker` interface. This
  is the only new class the rest of the reasoning layer needs to know
  about.
- `src/reasoning/fallbackReasoningService.ts` — provider-independent
  fallback composition (see Architecture above).
- Wired into `src/dev/demoState.ts`: if `AWS_REGION`/`BEDROCK_MODEL_ID` are
  configured, a real Bedrock attempt is made on every reasoning call,
  falling back to the template on any failure. `DemoSnapshot` carries a
  `reasoningProvider: 'bedrock' | 'template'` field (kept outside the
  `ReasoningOutput` contract itself) so the CLI/dashboard can show which
  provider actually answered a given call, rather than assuming.

### `bedrock:check` — the runtime proof command

```bash
npm run bedrock:check
```

Mirrors `ring:check` exactly: reads config, and — only if both
`AWS_REGION` and `BEDROCK_MODEL_ID` are present — attempts one real,
minimal Bedrock Converse call ("reply with the word OK"). Never prints
prompt/response content, only a character count. **Never fakes success.**

### CONFIRMED

- AWS SDK v3 (`@aws-sdk/client-bedrock-runtime`) integration is implemented
  using the real Converse API, exactly as it would be called in a normal
  Node project once the package is installed.
- 34 new Bedrock-specific tests pass — config validation, malformed/
  non-JSON model responses, model errors, empty evidence, low-confidence
  evidence, prompt-injection-like evidence text, secret-looking text
  never echoed, and full graceful-fallback behavior — all against a
  mocked `ModelInvoker`/`BedrockClient`, never against a live AWS account.
- One test genuinely (not mocked) exercises the real dynamic-import
  failure path, since the SDK really is absent from `node_modules` here.
- The application runs correctly with **zero** AWS configuration (falls
  straight to the template) and with AWS configured but the SDK/network
  unavailable (attempts Bedrock, fails honestly, falls back) — both
  verified by actually running the CLI demo and dev server, not just
  reasoning about the code.
- The original 69 Phase 1 tests and 82 Phase 2 Ring tests are unaffected —
  185 total, all passing.

### NOT VERIFIED

- **No live Bedrock API call has ever succeeded from this environment.**
  `npm run bedrock:check` with a placeholder model ID fails at the
  dynamic-import step (`Cannot find module '@aws-sdk/client-bedrock-runtime'`)
  because the package cannot be installed here — this is a stronger
  negative than the Ring case (Ring's client used only Node's built-in
  `fetch`, so no package-installation blocker existed there).
  Consequently, this project cannot verify: that the Converse API request
  shape used here is exactly correct, that a specific Claude model ID is
  actually available in a specific region/account, or that a real
  response parses as expected — all of that requires an environment where
  the SDK can be installed and real AWS credentials exist.
- Whether the AWS credential provider chain resolves correctly in a real
  environment is unverified here (no credentials of any kind exist in
  this sandbox).
- The exact pinned version (`^3.637.0`) of `@aws-sdk/client-bedrock-runtime`
  could not be checked against the live npm registry (`npm view` is
  blocked the same way `npm install` is) — treat it as a reasonable,
  unverified placeholder to be corrected on first real install.

**This project does not claim "Bedrock works."** It claims: the adapter is
correctly designed against the real SDK's real API, is thoroughly tested
against mocks, degrades gracefully without AWS, and has never been proven
against a live Bedrock endpoint — because it couldn't be, in this
environment.

## AWS Runtime / Persistent Event Store

**Read the CONFIRMED / TESTED / LIVE VERIFIED / NOT VERIFIED split below
carefully before trusting any claim about this running as "an AWS-backed
application."**

### Local mode (unchanged default)

```
Ring / Simulator -> normalization -> InMemoryEventStore -> deterministic analysis -> Bedrock/template reasoning -> result
```

Nothing about local mode changed in this phase. `EVENT_STORE` defaults to
`in_memory` when unset — every existing CLI command, test, and dev-server
route works exactly as before with zero AWS configuration.

### AWS mode (implemented, never live-verified)

```
Ring -> verified webhook/history -> normalized TendEvent -> DynamoEventStore ->
analysis worker (runAnalysis) -> deterministic baseline/deviation engine ->
structured evidence -> Bedrock reasoning -> notification abstraction
```

### Persistent event store (`src/store/`)

- `dynamoConfig.ts` — reads only `AWS_REGION` and `DYNAMODB_TABLE_NAME`.
  AWS credentials are never read here — resolved entirely by the AWS SDK's
  own standard credential provider chain, same rule as Bedrock.
- `dynamoEventStore.ts` — implements the existing, **unchanged**
  `EventStore` interface using `@aws-sdk/client-dynamodb` +
  `@aws-sdk/lib-dynamodb`, loaded via the same runtime `import()` pattern
  established for Bedrock (`registry.npmjs.org` is blocked in this
  sandbox — confirmed, identical `x-deny-reason: host_not_allowed`
  pattern — so these packages cannot be installed here either).
  - **Single-table key design**: partition key `HOUSEHOLD#{householdId}`,
    sort key `EVENT#{occurredAt}#{eventId}` for event items, plus
    `IDEMP_EVENT#{eventId}` / `IDEMP_REQUEST#{requestId}` marker items.
    `append` writes all three atomically via `TransactWriteItems`, each
    conditioned on `attribute_not_exists(pk)` — this is what lets it
    distinguish "duplicate eventId" from "duplicate requestId (replay)"
    exactly like `InMemoryEventStore`, without ever partially writing one
    marker and not the other.
  - Time-range queries use `BETWEEN` (the only sort-key range DynamoDB's
    `KeyConditionExpression` supports) plus a `FilterExpression` on the
    stored `occurredAt` attribute to enforce the interface's exclusive
    upper bound — the standard technique for a half-open range query.
  - `getRecent` uses `ScanIndexForward: false` + `Limit`. No table `Scan`
    is used anywhere.
  - `getByDevice` queries the household partition and filters — **no GSI
    was added**, per the "avoid unnecessary secondary indexes without a
    demonstrated need" instruction. If device-scoped queries become a hot
    path, a GSI on `deviceId` is the natural next step.
- `eventStoreFactory.ts` — `EVENT_STORE=in_memory|dynamodb` runtime
  switch, defaulting to `in_memory`. Requesting `dynamodb` without
  `AWS_REGION`/`DYNAMODB_TABLE_NAME` configured fails loudly
  (`DynamoConfigError`) rather than silently falling back to in-memory —
  silently discarding persistence would be a far worse failure mode than
  a clear startup error.

### Privacy & Data Minimization (persistent store)

Reviewed explicitly before implementing DynamoDB, per this phase's
requirement. `DynamoEventStore` persists **only** the fields already
present on the existing, unchanged `TendEvent` type (`domain/event.ts`):
`householdId`, `deviceId`, optional `componentId`/`zoneId`,
`eventId`/`requestId`, `eventType`, optional `subType`, `occurredAt`,
`ingestedAt`, `source`, and `rawEventId` (itself just an internal pointer
string, never the raw payload — see Phase 1's design). This store
**cannot** persist OAuth tokens, webhook signatures, Authorization
headers, raw Ring payloads, video, audio, biometric data, or facial
embeddings, because none of those ever exist on a `TendEvent` in the
first place — data minimization here is inherited structurally from
Phase 1's domain model, not bolted on separately. The webhook handler
(`ringWebhookHandler.ts`, unchanged) verifies the HMAC signature and
replay window **before** normalization and persistence ever happen — an
invalid or stale webhook is rejected before it reaches the store.

### Ring Event History → persistent store

`src/ingestion/ring/ringHistorySync.ts` (`syncMotionHistoryToStore`) polls
history via the existing, unchanged `RingEventSource.pollMotionHistory`
and persists every accepted `motion` entry through the same `EventStore`
interface the webhook path and simulator use. It inherits, unchanged:
the `ring_playground` restriction (refuses to run at all for that
source), the rejection of non-`motion` kinds (`on_demand`, `ding` — never
mislabeled as genuine motion), and `EventStore.append`'s idempotency
contract (re-polling the same window never creates duplicates).

**Event History contract confidence, re-checked this phase:** a real
developer's post on the Amazon Developer Community forum
(`community.amazondeveloper.com`, May 2026) independently describes using
`GET /v1/history/devices/{device_id}/events` with
`event_types=motion,on_demand` (cameras) or `event_types=ding,on_demand,motion`
(doorbells) against the official Partner API. This is **user-generated
forum content, not an Amazon-authored documentation page** — a second
independent real-world source corroborating the path/vocabulary this
project had already guessed by analogy, which is why
`RING_HISTORY_PATH_TEMPLATE` was updated to match it. A separately
claimed dotted-subtype filtering convention (`motion.human`,
`motion.vehicle`, etc.) was traced, on inspection, to an **unofficial,
third-party** Python client/emulator project's own invented abstraction —
not to Ring itself — so this project did not adopt it; the confirmed
webhook payload's separate `type`/`subType` fields (already implemented)
remain the model.

### Scheduled analysis design

The AWS-native target is:

```
EventBridge Scheduler -> analysis worker (Lambda) -> DynamoEventStore ->
deterministic engine -> Bedrock -> notification abstraction
```

**This phase implements the worker and its dependencies
(`src/analysis/analysisWorker.ts`, `runAnalysis()`) — it does not deploy
EventBridge Scheduler or Lambda infrastructure**, per the explicit
instruction to avoid overbuilding infrastructure for its own sake.
`runAnalysis()` is exactly the function a Lambda handler, a cron job, or a
manual invocation would call: it loads events via one bounded
`getByTimeRange` query, runs the **unchanged** deterministic
baseline/deviation engine, builds `ReasoningInput` from the resulting
evidence only, calls the existing `ReasoningService` interface, and
optionally delivers a digest via `NotificationService`. **The reasoning
service is structurally incapable of deciding whether an anomaly
exists** — the deterministic engine's classification happens before
`runAnalysis` ever touches the reasoning layer, and a reasoning
implementation that tries to report a different severity is rejected by
the existing, unchanged safety contract (proven directly in
`test/analysis/analysisWorker.test.ts`).

**Remaining deployment wiring for a future phase**: an actual EventBridge
Scheduler rule, a Lambda function wrapping `runAnalysis()`, IAM roles
scoped to the specific DynamoDB table and Bedrock model, and CloudWatch
alarms/logging configuration. None of this is application logic — it's
infrastructure-as-code that has no local-testable equivalent, which is
why it's deliberately left out of this phase rather than built without
being able to verify it.

### Notification abstraction (`src/notification/`)

`NotificationService` interface with exactly one implementation,
`ConsoleNotificationService` — per the explicit instruction not to add
multiple providers speculatively. It honors the reasoning layer's own
`notifyRecommended: false` as a deliberate no-op (not a silent failure),
and only ever logs fields already present on the reasoning output — never
raw evidence, never raw Ring data. SNS/email/push can be added later as
additional `NotificationService` implementations without touching
`analysisWorker.ts` or anything upstream of it.

### `analysis:check` — exercising the worker locally

```bash
npm run analysis:check [normal|deviation_missing|variable_normal|sequence_deviation]
```

Runs the full pipeline (simulator -> in-memory store -> `runAnalysis` ->
template reasoning -> console notification) end to end with zero AWS/Ring
credentials, so the worker's correctness can be verified without any live
service.

### CONFIRMED / TESTED

- `EventStore` interface unchanged; `DynamoEventStore` implements it using
  the real AWS SDK v3 Converse-style pattern already established for
  Bedrock (dynamic import, since the package can't be installed here).
- Idempotency semantics (duplicate eventId vs. duplicate requestId/replay)
  are preserved exactly, via an atomic `TransactWriteItems` design.
- No table `Scan` anywhere; all queries are partition-scoped and bounded.
- Ring webhook path re-smoke-tested live against the running dev server
  with the new configurable store wired in — identical behavior to
  Phase 2 (valid signature 200, replay 200/duplicate, invalid signature
  401), confirmed by actually running it, not just by unit tests.
- The analysis worker's anomaly-decision ordering (deterministic engine
  before reasoning, reasoning cannot override severity) is proven by a
  dedicated test using the real `BedrockReasoningService` safety contract.
- 24 new Phase 4 tests pass, 219 total (up from 185 at the end of Phase 3).

### LIVE VERIFIED

- Nothing new in this phase. See "AWS / Amazon Bedrock Integration" above
  for what was and wasn't live-verified for Bedrock specifically (answer:
  nothing — the SDK cannot be installed here).

### NOT VERIFIED

- **No live DynamoDB call has ever succeeded from this environment** —
  the same `@aws-sdk/client-dynamodb`/`@aws-sdk/lib-dynamodb` packages
  cannot be installed here (registry blocked), so `DynamoEventStore`'s
  real request/response shapes against an actual table have never been
  exercised, only its key-construction logic and its genuine
  SDK-unavailable failure path.
- No real DynamoDB table has ever been provisioned or queried.
- The EventBridge Scheduler + Lambda deployment path is designed but not
  built or deployed in this phase.

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
- `getEventHistory()` / `pollMotionHistory()` — the Ring-documented
  **polling alternative** to webhooks ("If you aren't ready to process
  webhooks at launch, acknowledge deliveries with 200 and use the Event
  History API instead"). **Read this carefully before trusting it:**
  - CONFIRMED: the Event History API exists and is Ring's own documented
    polling alternative to webhooks.
  - **NOT CONFIRMED**: its exact endpoint path, query parameter name, and
    response shape. No captured example was found anywhere in official
    Ring documentation despite dedicated searches. This project's
    `RING_HISTORY_PATH_TEMPLATE` (`/v1/devices/{deviceId}/history`) and its
    `event_types=motion` query parameter are a **best-effort construction**
    by analogy to every other confirmed device sub-resource endpoint — not
    a copied real example. `ringTypes.ts` documents this in detail.
  - **`pollMotionHistory()` only accepts `source: 'ring_real'` — this is
    enforced at both the type level and a runtime check.** This project
    found the vocabulary `motion` / `on_demand` / `ding` only in the
    changelog of `python-ring-doorbell`, a well-known **unofficial,
    third-party** library that reverse-engineers Ring's separate,
    undocumented *consumer app* API — a different surface entirely from
    the official Partner API this project integrates with. Nothing here
    assumes that vocabulary applies to the Partner API's Event History
    endpoint. It's used only as a defensive rejection list: any history
    entry whose `kind` isn't exactly the confirmed value `motion` (e.g. a
    hypothetical `on_demand` result) is placed in `rejected`, never
    normalized into an accepted `TendEvent` — so **this path can never
    claim "the Playground generated a motion event,"** either because the
    Playground isn't an allowed source for it at all, or because a
    non-`motion` kind is explicitly refused.
  - `pull()` (the `EventSource` interface method) is **completely
    unchanged** by this addition — `pollMotionHistory()` is a separate,
    explicitly-named, opt-in method, precisely so the existing webhook
    path and `pull()`'s tested "honestly returns `[]`" contract are
    preserved exactly as they were.

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
npm run bedrock:check   # proves (or honestly disproves) genuine runtime Bedrock API usage — see "AWS / Amazon Bedrock Integration"
npm run analysis:check [scenario]   # exercises the full analysis worker pipeline locally — see "AWS Runtime / Persistent Event Store"
```

### Dev server endpoints

All simulator/demo data comes from the in-memory development simulator
(`source: dev_simulator`). The `/reasoning`, `/demo` responses may reflect
a real Bedrock call if `AWS_REGION`/`BEDROCK_MODEL_ID` are configured and
reachable (see `reasoningProvider` in the response) — otherwise they use
the deterministic template. `/webhooks/ring` is the one route that
genuinely talks to Ring-shaped data (see below).

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

None of this is an architectural recommendation for production. This
project's `package.json` DOES declare `@aws-sdk/client-bedrock-runtime` as
a proper dependency with a pinned version — it simply cannot be installed
in this specific sandbox (see "AWS / Amazon Bedrock Integration" for the
confirmed, reproducible reason). A real package manager run in an
environment with registry access should install it normally and also
replace the vendored `@types/node` copy.

## Current limitations

- No live Ring API call has ever succeeded from this development
  environment — see "Phase 2: what was actually verified" above for the
  exact, checkable reason (sandbox egress policy, confirmed via direct
  `curl`), and no Ring Playground event source or webhook delivery has
  been confirmed either.
- No AWS deployment infrastructure actually deployed (Lambda, API Gateway,
  EventBridge Scheduler, SNS, SES, Step Functions) — `DynamoEventStore`
  and the analysis worker are implemented and locally tested, but no real
  AWS resources have been provisioned; explicitly out of scope for this
  phase per the "avoid overbuilding infrastructure" instruction.
- No live Bedrock or DynamoDB API call has ever succeeded from this
  environment — see "AWS / Amazon Bedrock Integration" and "AWS Runtime /
  Persistent Event Store" above for the exact, checkable reason
  (`@aws-sdk/*` packages cannot be installed here; the npm registry is
  blocked by the same egress policy documented for Ring). Both adapters
  are real, tested against mocks/fakes, and degrade gracefully, but
  neither has been proven end-to-end against a live AWS account.
- No authentication/authorization on the dev server — it's explicitly a
  local development tool, not exposed infrastructure.
- `SensitivityStore` (caregiver feedback) still resets on restart even
  when `EVENT_STORE=dynamodb` — only the event store itself was made
  persistent this phase; feedback persistence is a natural next step
  using the same `DynamoEventStore` pattern.
- The `deviation_missing` vs `sequence_deviation` calibration property noted
  above is a known open tuning question, not a defect being hidden.
- `zoneId` is currently assigned directly by the simulator; a real
  integration needs a household-onboarding step to map real Ring
  `deviceId`s to human-meaningful zone names, since Ring's webhook payloads
  don't include this.
- The Ring Partner API's `GET /v1/users/me` response shape remains
  unconfirmed/unused. The Event History endpoint's path/vocabulary is now
  corroborated by a real-developer community-forum report (see above) but
  still not by an Amazon-authored documentation page directly.
- No GitHub remote is configured in this development environment, and
  `github.com` is blocked by the same egress policy as everything else —
  confirmed directly via `curl` (`x-deny-reason: host_not_allowed`) and
  `git ls-remote`. All Phase 4 work exists only as local commits on
  `phase-4-aws-runtime`; pushing requires an environment with actual
  GitHub network access and configured credentials.
