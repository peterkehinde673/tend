# Tend — Current Project Status

## Current phase

**Phase 8 — Security Verification**

Tend has progressed through the core engine, Ring integration, Bedrock reasoning, AWS runtime, security hardening, and production-verification work. Phase 8 is focused on turning important infrastructure security assumptions into deterministic regression tests.

## Verified in the repository

- Deterministic baseline, deviation, reasoning, feedback, Ring, runtime, and persistence test suites are present.
- The latest known full suite passed **245/245 tests** before the Phase 8 infrastructure-only tests were added.
- The AWS SAM template uses Node.js 22.
- Ring HMAC configuration is marked `NoEcho`.
- Runtime DynamoDB permissions are restricted to the Tend table and required operations.
- Bedrock permission is restricted to `bedrock:Converse` on the configured model ARN.
- SNS publishing is restricted to the Tend notification topic.
- EventBridge Scheduler trust is restricted by source ARN and source account.
- Scheduler invocation permission is restricted to the Tend runtime Lambda.
- DynamoDB point-in-time recovery and server-side encryption are enabled.
- Household identity is fail-closed and the deployed `RingHouseholdId` is explicit rather than inferred from a request.

## Phase 8 scope

Phase 8 adds static infrastructure-security regression tests. These tests inspect `infra/template.yaml`; they do **not** claim live AWS connectivity, Ring account access, deployment success, or real notification delivery.

## What remains before calling the project production-verified

1. Run the complete test suite locally on the Phase 8 branch and confirm the new infrastructure tests pass alongside the existing suite.
2. Validate the SAM template with the AWS SAM CLI where available.
3. Review the resulting PR and merge the verification tests into the production-verification line.
4. If real AWS/Ring credentials and supported devices are available, perform live smoke tests separately from deterministic repository tests.

A successful repository test run is evidence about the code and template only. It is not evidence that an external AWS or Ring account is configured correctly.
