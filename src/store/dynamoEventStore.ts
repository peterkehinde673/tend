import { TendEvent } from '../domain/event';
import { EventStore, EventTimeRangeQuery } from './eventStore';
import { DynamoEventStoreConfig } from './dynamoConfig';

/**
 * DynamoDB-backed implementation of the existing, unchanged EventStore
 * interface. Implements the exact same idempotency contract as
 * InMemoryEventStore: an event whose (householdId, eventId) OR
 * (householdId, requestId) has already been recorded is rejected with a
 * specific reason string, distinguishing the two cases.
 *
 * IMPORTANT — READ BEFORE ASSUMING THIS IS WIRED UP LIKE A NORMAL DEPENDENCY:
 * exactly like src/reasoning/bedrock/bedrockClient.ts, this file loads
 * `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` via a runtime
 * `import()` rather than a static import, because this sandboxed
 * development environment's network egress proxy blocks
 * `registry.npmjs.org` (confirmed directly, same `x-deny-reason:
 * host_not_allowed` pattern as every other blocked host in this project),
 * so `npm install` cannot fetch these packages here. This keeps the rest
 * of the project typechecking/building/testing cleanly. The moment these
 * packages are installed in an environment with registry access, this
 * code calls the real DynamoDB API with no changes required. Every test
 * for this class uses a fake document-client (see test/store/), never a
 * live AWS account.
 *
 * SINGLE-TABLE KEY DESIGN, deliberately chosen over multiple tables or a
 * secondary index, per the "avoid unnecessary complexity" instruction:
 *
 *   Partition key (pk): "HOUSEHOLD#{householdId}"           — scopes every query to one household
 *   Sort key (sk) for the event item:      "EVENT#{occurredAt}#{eventId}"   — sorts chronologically; eventId breaks ties
 *   Sort key (sk) for an idempotency marker on eventId:      "IDEMP_EVENT#{eventId}"
 *   Sort key (sk) for an idempotency marker on requestId:    "IDEMP_REQUEST#{requestId}"
 *
 * `append` writes all three items in a single TransactWriteItems call, each
 * conditioned on `attribute_not_exists(pk)` (the standard DynamoDB
 * insert-if-not-exists idiom). If either idempotency marker already
 * exists, the ENTIRE transaction is atomically rolled back — this is what
 * lets this store distinguish "duplicate eventId" from "duplicate
 * requestId (replay)" exactly like InMemoryEventStore does, without ever
 * partially writing one marker and not the other.
 *
 * Only normalized TendEvent fields are ever written — no raw Ring
 * payloads, no OAuth tokens, no webhook signatures, no video/audio/
 * biometric data. See README "Privacy & Data Minimization" for the full
 * accounting; this store cannot violate it because TendEvent itself never
 * carries that data (see domain/event.ts).
 */
export class DynamoEventStore implements EventStore {
  constructor(
    private readonly config: DynamoEventStoreConfig,
    /**
     * Injectable module loader, defaulting to the real dynamic-import
     * loader below. Exists so tests can supply a fake SDK module shape
     * (fake DynamoDBClient/DynamoDBDocumentClient/QueryCommand/
     * TransactWriteCommand) and exercise this class's actual CRUD/
     * idempotency logic without needing the real, uninstallable AWS SDK
     * package — see test/store/dynamoEventStore.test.ts.
     */
    private readonly moduleLoader: () => Promise<DynamoModulesShape> = loadDynamoModules,
  ) {}

  private async getDocClient(sdk: DynamoModulesShape): Promise<DynamoDocClientShape> {
    const baseClient = new sdk.DynamoDBClient({ region: this.config.region });
    return sdk.DynamoDBDocumentClient.from(baseClient) as DynamoDocClientShape;
  }

  private async loadModules(): Promise<DynamoModulesShape> {
    try {
      return await this.moduleLoader();
    } catch (err) {
      // Preserve the store's typed failure contract for alternate/injected
      // loaders too. The default loader already throws DynamoOperationError,
      // so avoid wrapping that error a second time.
      if (err instanceof DynamoOperationError) throw err;
      throw new DynamoOperationError(
        `Could not load \"@aws-sdk/client-dynamodb\"/\"@aws-sdk/lib-dynamodb\": ${(err as Error).message}. ` +
          `These packages must be installed before any real DynamoDB call can be made.`,
        err,
      );
    }
  }

  async append(event: TendEvent): Promise<{ accepted: boolean; reason?: string }> {
    const sdk = await this.loadModules();
    const client = await this.getDocClient(sdk);

    const pk = householdPartitionKey(event.householdId);
    const eventSk = eventSortKey(event.occurredAt, event.eventId);
    const idempEventSk = idempEventSortKey(event.eventId);
    const idempRequestSk = idempRequestSortKey(event.requestId);

    const conditionExpression = 'attribute_not_exists(pk)';

    try {
      await client.send(
        new sdk.TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.config.tableName, Item: { pk, sk: idempEventSk }, ConditionExpression: conditionExpression } },
            { Put: { TableName: this.config.tableName, Item: { pk, sk: idempRequestSk }, ConditionExpression: conditionExpression } },
            { Put: { TableName: this.config.tableName, Item: { pk, sk: eventSk, ...event }, ConditionExpression: conditionExpression } },
          ],
        }),
      );
      return { accepted: true };
    } catch (err) {
      const cancellationReasons = extractCancellationReasons(err);
      if (cancellationReasons) {
        if (cancellationReasons[0]?.Code === 'ConditionalCheckFailed') {
          return { accepted: false, reason: `Duplicate eventId: ${event.eventId}` };
        }
        if (cancellationReasons[1]?.Code === 'ConditionalCheckFailed') {
          return { accepted: false, reason: `Duplicate requestId (replay): ${event.requestId}` };
        }
      }
      throw new DynamoOperationError(`DynamoDB append failed for household ${event.householdId}: ${(err as Error).message}`, err);
    }
  }

  async getByHousehold(householdId: string): Promise<TendEvent[]> {
    const sdk = await this.loadModules();
    const client = await this.getDocClient(sdk);
    const pk = householdPartitionKey(householdId);

    const items: Record<string, unknown>[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new sdk.QueryCommand({
          TableName: this.config.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': 'EVENT#' },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      items.push(...((result.Items as Record<string, unknown>[] | undefined) ?? []));
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return items.map(stripKeyAttributes).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  async getByTimeRange(query: EventTimeRangeQuery): Promise<TendEvent[]> {
    const sdk = await this.loadModules();
    const client = await this.getDocClient(sdk);
    const pk = householdPartitionKey(query.householdId);

    const result = await client.send(
      new sdk.QueryCommand({
        TableName: this.config.tableName,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        FilterExpression: 'occurredAt < :toIso' + (query.deviceId ? ' AND deviceId = :deviceId' : ''),
        ExpressionAttributeValues: {
          ':pk': pk,
          ':from': eventSortKey(query.fromIso, ''),
          ':to': eventSortKey(query.toIso, '\uffff'),
          ':toIso': query.toIso,
          ...(query.deviceId ? { ':deviceId': query.deviceId } : {}),
        },
      }),
    );

    const items = (result.Items as Record<string, unknown>[] | undefined) ?? [];
    return items.map(stripKeyAttributes);
  }

  async getRecent(householdId: string, limit: number): Promise<TendEvent[]> {
    const sdk = await this.loadModules();
    const client = await this.getDocClient(sdk);
    const pk = householdPartitionKey(householdId);

    const result = await client.send(
      new sdk.QueryCommand({
        TableName: this.config.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': 'EVENT#' },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );

    const items = (result.Items as Record<string, unknown>[] | undefined) ?? [];
    return items.map(stripKeyAttributes).reverse();
  }

  async getByDevice(householdId: string, deviceId: string): Promise<TendEvent[]> {
    const sdk = await this.loadModules();
    const client = await this.getDocClient(sdk);
    const pk = householdPartitionKey(householdId);

    const items: Record<string, unknown>[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new sdk.QueryCommand({
          TableName: this.config.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          FilterExpression: 'deviceId = :deviceId',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': 'EVENT#', ':deviceId': deviceId },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      items.push(...((result.Items as Record<string, unknown>[] | undefined) ?? []));
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return items.map(stripKeyAttributes);
  }
}

export function householdPartitionKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

export function eventSortKey(occurredAtIso: string, eventId: string): string {
  return `EVENT#${occurredAtIso}#${eventId}`;
}

export function idempEventSortKey(eventId: string): string {
  return `IDEMP_EVENT#${eventId}`;
}

export function idempRequestSortKey(requestId: string): string {
  return `IDEMP_REQUEST#${requestId}`;
}

function stripKeyAttributes(item: Record<string, unknown>): TendEvent {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as unknown as TendEvent;
}

export class DynamoOperationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DynamoOperationError';
  }
}

interface CancellationReason {
  Code?: string;
}

function extractCancellationReasons(err: unknown): CancellationReason[] | undefined {
  if (err && typeof err === 'object' && 'CancellationReasons' in err) {
    return (err as { CancellationReasons?: CancellationReason[] }).CancellationReasons;
  }
  return undefined;
}

export interface DynamoDocClientShape {
  send: (command: unknown) => Promise<{ Items?: unknown[]; LastEvaluatedKey?: unknown }>;
}

export interface DynamoModulesShape {
  DynamoDBClient: new (opts: { region: string }) => unknown;
  DynamoDBDocumentClient: { from: (client: unknown) => unknown };
  QueryCommand: new (input: Record<string, unknown>) => unknown;
  TransactWriteCommand: new (input: Record<string, unknown>) => unknown;
}

async function loadDynamoModules(): Promise<DynamoModulesShape> {
  try {
    const clientModuleName = '@aws-sdk/client-dynamodb';
    const libModuleName = '@aws-sdk/lib-dynamodb';
    const [clientModule, libModule]: [unknown, unknown] = await Promise.all([import(clientModuleName), import(libModuleName)]);
    const client = clientModule as { DynamoDBClient: DynamoModulesShape['DynamoDBClient'] };
    const lib = libModule as {
      DynamoDBDocumentClient: DynamoModulesShape['DynamoDBDocumentClient'];
      QueryCommand: DynamoModulesShape['QueryCommand'];
      TransactWriteCommand: DynamoModulesShape['TransactWriteCommand'];
    };
    return {
      DynamoDBClient: client.DynamoDBClient,
      DynamoDBDocumentClient: lib.DynamoDBDocumentClient,
      QueryCommand: lib.QueryCommand,
      TransactWriteCommand: lib.TransactWriteCommand,
    };
  } catch (err) {
    throw new DynamoOperationError(
      `Could not load \"@aws-sdk/client-dynamodb\"/\"@aws-sdk/lib-dynamodb\": ${(err as Error).message}. ` +
        `These packages must be installed before any real DynamoDB call can be made. In this project's own sandboxed ` +
        `development environment, installation is blocked by the network egress policy — see README \"AWS Runtime / ` +
        `Persistent Event Store\" for the confirmed, reproducible reason.`,
      err,
    );
  }
}
