# Tend AWS runtime deployment

Phase 5 adds a small AWS-native deployment boundary around the existing Tend services.

## What this provisions

- **API Gateway HTTP API** with `POST /webhooks/ring`
- **AWS Lambda** runtime entry point at `src/runtime/lambdaHandler.ts`
- **DynamoDB** on-demand table for normalized Tend events
- **EventBridge Scheduler** invoking the analysis worker every 15 minutes by default
- Least-privilege Lambda access to the Tend DynamoDB table
- Optional `bedrock:Converse` permission scoped to the configured foundation-model ARN
- DynamoDB server-side encryption and point-in-time recovery

The application logic remains in `src/`; the SAM template only supplies the production execution boundary.

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
- keep the default 15-minute schedule unless a different cadence is required

The stack output `RingWebhookUrl` is the HTTPS endpoint to use when configuring the Ring webhook integration.

## Important runtime notes

1. The Ring webhook is accepted only after HMAC verification, timestamp/replay checks, schema normalization, and idempotent persistence.
2. Only normalized `TendEvent` fields are persisted; raw webhook payloads and credentials are not stored by the event store.
3. Scheduled analysis runs the deterministic baseline/deviation engine before any reasoning call. Bedrock explains the already-computed evidence; it does not determine severity.
4. If Bedrock configuration is absent, the Lambda uses the existing deterministic template reasoning service. If Bedrock is configured but the call fails, the existing fallback service handles the failure.
5. Notification delivery remains behind the existing `NotificationService` abstraction. Phase 5 does not invent an external notification provider.
6. The current deployment template uses a single Lambda for both webhook ingestion and scheduled analysis to keep the runtime boundary small. It can be split later if measured load or isolation requirements justify it.

## Verification status

This directory is **deployment wiring, not proof of a live AWS deployment**. Before claiming a live integration in a hackathon submission, run `sam validate`, `sam build`, deploy into an AWS account, exercise the webhook with a real Ring-issued signature, confirm DynamoDB persistence, and confirm a scheduled invocation reaches the analysis worker.
