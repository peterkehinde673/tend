/**
 * Shared types for the Bedrock adapter. Kept separate from bedrockClient.ts
 * so error/result shapes can be imported without pulling in the dynamic
 * AWS SDK loading logic.
 */

export class BedrockInvocationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BedrockInvocationError';
  }
}

/**
 * Thrown specifically when the @aws-sdk/client-bedrock-runtime package
 * itself could not be loaded (e.g. not installed). Distinguished from a
 * general BedrockInvocationError so callers (and this project's own
 * `bedrock:check`) can report "the SDK isn't installed" as a distinct,
 * more specific condition than "a Bedrock call failed" — these have
 * different remedies and this project never conflates them.
 */
export class BedrockSdkUnavailableError extends BedrockInvocationError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'BedrockSdkUnavailableError';
  }
}
