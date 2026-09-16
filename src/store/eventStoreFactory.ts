import { EventStore } from './eventStore';
import { InMemoryEventStore } from './inMemoryEventStore';
import { DynamoEventStore } from './dynamoEventStore';
import { loadDynamoEventStoreConfig } from './dynamoConfig';

export class EventStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventStoreConfigError';
  }
}

export type EventStoreKind = 'in_memory' | 'dynamodb';

/**
 * Reads `EVENT_STORE` and constructs the corresponding EventStore
 * implementation. Defaults to `in_memory` — the safe, deterministic local
 * default this project's CLI/tests/dev server have always used — so that
 * omitting `EVENT_STORE` entirely (the common case for local development)
 * never requires any AWS configuration at all.
 *
 * Throws EventStoreConfigError with a clear message if `EVENT_STORE` is
 * set to an unrecognized value, or if `dynamodb` is requested but
 * `AWS_REGION`/`DYNAMODB_TABLE_NAME` aren't configured — this project
 * fails safely and explicitly rather than silently falling back to
 * in-memory storage when DynamoDB was actually requested, since silently
 * discarding persistence would be a much worse failure mode than a clear
 * startup error.
 */
export function createEventStore(env: NodeJS.ProcessEnv = process.env): EventStore {
  const kind = (env.EVENT_STORE ?? 'in_memory') as EventStoreKind | string;

  if (kind === 'in_memory') {
    return new InMemoryEventStore();
  }

  if (kind === 'dynamodb') {
    const config = loadDynamoEventStoreConfig(env); // throws DynamoConfigError with a clear message if misconfigured
    return new DynamoEventStore(config);
  }

  throw new EventStoreConfigError(`Unrecognized EVENT_STORE value "${kind}". Expected "in_memory" or "dynamodb".`);
}
