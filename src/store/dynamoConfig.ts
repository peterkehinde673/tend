/**
 * Configuration for the DynamoDB-backed EventStore. Mirrors the existing
 * pattern established in ringConfig.ts / bedrockConfig.ts: only non-secret
 * operational configuration is read here. AWS credentials themselves are
 * never read directly — they are resolved entirely by the AWS SDK's own
 * standard credential provider chain.
 */

export class DynamoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DynamoConfigError';
  }
}

export interface DynamoEventStoreConfig {
  /** AWS region for the DynamoDB table, e.g. "us-east-1". */
  region: string;
  /** The DynamoDB table name. This project uses a single-table design (see dynamoEventStore.ts). */
  tableName: string;
}

export function loadDynamoEventStoreConfig(env: NodeJS.ProcessEnv = process.env): DynamoEventStoreConfig {
  const region = env.AWS_REGION;
  if (!region || region.trim().length === 0) {
    throw new DynamoConfigError('Missing AWS_REGION environment variable. The DynamoDB event store cannot select an endpoint without it.');
  }

  const tableName = env.DYNAMODB_TABLE_NAME;
  if (!tableName || tableName.trim().length === 0) {
    throw new DynamoConfigError(
      'Missing DYNAMODB_TABLE_NAME environment variable. Set it to the name of a DynamoDB table provisioned for Tend ' +
        '(see README "AWS Runtime / Persistent Event Store" for the expected key schema).',
    );
  }

  return { region, tableName };
}

export function tryLoadDynamoEventStoreConfig(env: NodeJS.ProcessEnv = process.env): { config: DynamoEventStoreConfig } | { error: string } {
  try {
    return { config: loadDynamoEventStoreConfig(env) };
  } catch (err) {
    if (err instanceof DynamoConfigError) {
      return { error: err.message };
    }
    throw err;
  }
}
