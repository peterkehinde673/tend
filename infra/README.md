# Tend AWS runtime deployment

Phase 5 adds a small AWS-native deployment boundary around the existing Tend services.

## What this provisions

- **API Gateway HTTP API** with `POST /webhooks/ring` and authenticated `POST /feedback`
- **AWS Lambda** runtime entry point at `src/runtime/lambdaHandler.ts`
- **DynamoDB** on-demand table for normalized Tend events and per-household sensitivity state
- **EventBridge Scheduler** invoking the analysis worker every 15 minutes by default
- Optional **SNS** notification delivery with an email subscription
- Least-privilege Lambda access to the Tend DynamoDB table and, when enabled, the SNS topic
- Optional `bedrock:Converse` permission scoped to the configured foundation-model ARN
- DynamoDB server-side encryption and point-in-time recovery

The application logic remains in `src/`; the SAM template supplies the production execution boundary.

## Caregiver feedback persistence

`POST /feedback` uses the same HMAC verification boundary as the Ring webhook. A valid request updates only the named signal sensitivities using the existing conservative feedback algorithm, then persists the normalized state as `SENSITIVITY#{signal}` under the household partition in the shared DynamoDB table.

The analysis worker reloads those multipliers before deterministic deviation scoring. A multiplier above `1.0` makes that signal less sensitive; a multiplier below `1.0` makes it more sensitive. The underlying household baseline statistics are not rewritten.

## Optional notifications

Set `NotificationEmail` during deployment to create an SNS email subscription and enable scheduled-analysis notification delivery. The recipient must confirm the SNS subscription email before messages are delivered. Leave it empty to keep notification delivery disabled.

Tend sends only the normalized reasoning output needed for the caregiver digest: household identifier, severity, explanation, recommended wording, and notification recommendation. Raw Ring payloads, credentials, video/audio, and biometric data are not sent through the notification adapter.

## Prerequisites

Install/configure the AWS CLI and AWS SAM CLI, then make sure the selected AWS account has permission to create the resources in `infra/template.yaml`.

No Ring token, webhook secret, or AWS credential should be committed to the repository.

## Validate and build

From the repository root:

```bash
sam validate --template-file infra/template.yaml
sam build --template-file infra/template.yaml
```

The SAM build uses esbuild to package `src/runtime/lambdaHandler.ts` and its dependencies.

## Deploy

Use guided deployment for the first deployment:

```bash
sam deploy --guided --template-file infra/template.yaml
```

When prompted:

- provide a strong value for `RingWebhookHmacSecret` (do not commit it)
- leave `BedrockModelId` empty if you want the deterministic template reasoning fallback
- set `BedrockModelId` to a model available to the account/region only after confirming model access
- set `NotificationEmail` only if you want SNS email delivery
- keep the default 15-minute schedule unless a different cadence is required

The stack outputs `RingWebhookUrl` and `CaregiverFeedbackUrl` expose the two HTTPS API routes.

## Important runtime notes

1. The Ring webhook is accepted only after HMAC verification, timestamp/replay checks, schema normalization, and idempotent persistence.
2. Only normalized `TendEvent` fields and normalized sensitivity state are persisted; raw webhook payloads, credentials, video/audio, and biometric data are not stored by these persistence layers.
3. Scheduled analysis reloads caregiver sensitivity before deterministic baseline/deviation evaluation. Bedrock receives only structured evidence after severity is computed.
4. If Bedrock configuration is absent, the Lambda uses the existing deterministic template reasoning service. If Bedrock is configured but the call fails, the existing fallback service handles the failure.
5. Notification delivery is optional and remains behind the existing `NotificationService` abstraction. No notification is sent when `NotificationEmail` is left empty.
6. The current deployment template uses a single Lambda for webhook ingestion, caregiver feedback, and scheduled analysis to keep the runtime boundary small. It can be split later if measured load or isolation requirements justify it.

## Verification status

This directory is **deployment wiring, not proof of a live AWS deployment**. Before claiming a live integration in a hackathon submission, run `sam validate`, `sam build`, deploy into an AWS account, confirm the SNS subscription if enabled, exercise the webhook and feedback route with valid signatures, confirm DynamoDB persistence, and confirm a scheduled invocation reaches the analysis worker.
