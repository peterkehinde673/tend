# Contributing to Tend

Thanks for your interest in Tend.

## Development setup

Requirements:

- Node.js 22+
- npm

Install the locked dependency set:

```bash
npm ci
```

Run the local dashboard:

```bash
npm run dev:server
```

Then open `http://localhost:8787/dashboard`.

## Before opening a pull request

Run the same core checks used by CI:

```bash
npm run typecheck
npm run build
npm test
npm run release:check
```

If you change `infra/template.yaml`, also run:

```bash
sam validate --template-file infra/template.yaml --lint
```

## Project boundaries

Tend keeps anomaly detection deterministic. Changes should not make the reasoning layer the source of truth for severity or introduce unsupported claims about Ring, AWS, household safety, medical conditions, or emergencies.

Do not commit real credentials, Ring access tokens, webhook secrets, AWS credentials, `.env` files, or production household data.

## Pull requests

Please keep changes focused, include or update tests for behavioral changes, and document externally dependent behavior separately from repository-only verification.
