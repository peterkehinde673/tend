# Tend — Current Project Status

## Current phase

**Phase 8 — Security Verification**

Tend has progressed through the core engine, Ring integration, Bedrock reasoning, AWS runtime, security hardening, and production-verification work. Phase 8 turns important infrastructure security assumptions into deterministic regression tests.

## Verified in the repository

- Deterministic baseline, deviation, reasoning, feedback, Ring, runtime, and persistence test suites are present.
- Phase 8 adds deterministic infrastructure-security regression coverage.
- The AWS SAM template uses Node.js 22.
- Ring HMAC configuration is marked `NoEcho`.
- Runtime DynamoDB permissions are restricted to the Tend table and required operations.
- Bedrock permission is restricted to `bedrock:Converse` on the configured model ARN.
- SNS publishing is restricted to the Tend notification topic.
- EventBridge Scheduler trust is restricted by source ARN and source account.
- Scheduler invocation permission is restricted to the Tend runtime Lambda.
- DynamoDB point-in-time recovery and server-side encryption are enabled.
- Household identity is fail-closed and the deployed `RingHouseholdId` is explicit rather than inferred from a request.

## Phase 8 verification status

- GitHub Actions `Tend CI` passed on commit `ae412dcd636a5303d44a7349b2654e07bbc110fa`.
- CI completed dependency installation, typecheck, build, test, and SAM template validation successfully.
- The Phase 8 PR contains only `docs/STATUS.md` and `test/infra/templateSecurity.test.ts`.
- The CI result verifies the repository and template checks; it does **not** claim live AWS connectivity, Ring account access, deployment success, or real notification delivery.

## What remains before calling the project production-verified

1. Merge the Phase 8 verification PR into the production-verification line.
2. If real AWS/Ring credentials and supported devices are available, perform live smoke tests separately from deterministic repository tests.
3. Keep external-account verification clearly separated from repository/CI evidence.

A successful repository test run is evidence about the code and template only. It is not evidence that an external AWS or Ring account is configured correctly.
