import { SignalSensitivity } from '../domain/feedback';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';
import { DynamoEventStoreConfig } from '../store/dynamoConfig';
import { SensitivityStore } from './sensitivityStore';

/**
 * DynamoDB persistence for caregiver sensitivity state.
 *
 * Uses the existing single-table event-store table with a distinct sort-key
 * namespace: HOUSEHOLD#{id} / SENSITIVITY#{signal}. Only normalized
 * sensitivity state is persisted; no raw Ring payloads are introduced.
 *
 * The AWS SDK is loaded dynamically for the same dependency/installability
 * reason as DynamoEventStore. Tests inject a small fake document client so
 * persistence behavior is verified without requiring a live AWS account.
 */
export class DynamoSensitivityStore implements SensitivityStore {
  constructor(
    private readonly config: DynamoEventStoreConfig,
    private readonly moduleLoader: () => Promise<SensitivityDynamoModules> = loadSensitivityDynamoModules,
  ) {}

  async get(householdId: string, signal: string, config: TendConfig = DEFAULT_CONFIG): Promise<SignalSensitivity> {
    const sdk = await this.moduleLoader();
    const client = await this.getClient(sdk);
    const result = await client.send(new sdk.GetCommand({
      TableName: this.config.tableName,
      Key: { pk: householdPartitionKey(householdId), sk: sensitivitySortKey(signal) },
    }));

    if (result.Item) return stripKeys(result.Item);

    return {
      householdId,
      signal,
      multiplier: config.feedback.defaultMultiplier,
      lastUpdatedAt: new Date(0).toISOString(),
      recentFeedback: [],
    };
  }

  async put(sensitivity: SignalSensitivity): Promise<void> {
    const sdk = await this.moduleLoader();
    const client = await this.getClient(sdk);
    await client.send(new sdk.PutCommand({
      TableName: this.config.tableName,
      Item: {
        pk: householdPartitionKey(sensitivity.householdId),
        sk: sensitivitySortKey(sensitivity.signal),
        ...sensitivity,
      },
    }));
  }

  private async getClient(sdk: SensitivityDynamoModules): Promise<SensitivityDocClient> {
    const base = new sdk.DynamoDBClient({ region: this.config.region });
    return sdk.DynamoDBDocumentClient.from(base) as SensitivityDocClient;
  }
}

export function householdPartitionKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

export function sensitivitySortKey(signal: string): string {
  return `SENSITIVITY#${signal}`;
}

function stripKeys(item: Record<string, unknown>): SignalSensitivity {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as SignalSensitivity;
}

export interface SensitivityDocClient {
  send: (command: unknown) => Promise<{ Item?: Record<string, unknown> }>;
}

export interface SensitivityDynamoModules {
  DynamoDBClient: new (opts: { region: string }) => unknown;
  DynamoDBDocumentClient: { from: (client: unknown) => unknown };
  GetCommand: new (input: Record<string, unknown>) => unknown;
  PutCommand: new (input: Record<string, unknown>) => unknown;
}

async function loadSensitivityDynamoModules(): Promise<SensitivityDynamoModules> {
  try {
    const clientModuleName = '@aws-sdk/client-dynamodb';
    const libModuleName = '@aws-sdk/lib-dynamodb';
    const [clientModule, libModule]: [unknown, unknown] = await Promise.all([import(clientModuleName), import(libModuleName)]);
    const client = clientModule as { DynamoDBClient: SensitivityDynamoModules['DynamoDBClient'] };
    const lib = libModule as {
      DynamoDBDocumentClient: SensitivityDynamoModules['DynamoDBDocumentClient'];
      GetCommand: SensitivityDynamoModules['GetCommand'];
      PutCommand: SensitivityDynamoModules['PutCommand'];
    };
    return {
      DynamoDBClient: client.DynamoDBClient,
      DynamoDBDocumentClient: lib.DynamoDBDocumentClient,
      GetCommand: lib.GetCommand,
      PutCommand: lib.PutCommand,
    };
  } catch (err) {
    throw new Error(`Could not load DynamoDB SDK for sensitivity persistence: ${(err as Error).message}`);
  }
}
