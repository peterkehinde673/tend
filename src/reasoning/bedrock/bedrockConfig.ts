/**
 * Bedrock integration configuration.
 *
 * Deliberately does NOT read AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 * AWS_SESSION_TOKEN or any other credential material directly. Per this
 * project's security rules, AWS credentials are resolved exclusively by
 * the AWS SDK's own standard credential provider chain (environment
 * variables it reads itself, shared credentials file, IAM role, SSO,
 * etc.) — Tend's own config loader only owns the two pieces of
 * non-secret operational configuration it actually needs: which AWS
 * region to call, and which Bedrock model to invoke.
 */

export class BedrockConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BedrockConfigError';
  }
}

export interface BedrockConfig {
  /** AWS region to call Bedrock in, e.g. "us-east-1". Not every Bedrock model is available in every region — this project does not assume otherwise. */
  region: string;
  /** The exact Bedrock model identifier to invoke, e.g. an Anthropic Claude model ID as listed in the AWS Bedrock model catalog for the configured region. */
  modelId: string;
}

/**
 * Loads BedrockConfig from environment variables. Throws BedrockConfigError
 * with a clear, actionable message if required configuration is missing —
 * consistent with this project's existing fail-safe pattern (see
 * ringConfig.ts). This is deliberately synchronous and makes no network
 * call: it only proves configuration is *present*, never that it is valid
 * or that the underlying AWS credentials/model access actually work.
 */
export function loadBedrockConfig(env: NodeJS.ProcessEnv = process.env): BedrockConfig {
  const region = env.AWS_REGION;
  if (!region || region.trim().length === 0) {
    throw new BedrockConfigError(
      'Missing AWS_REGION environment variable. Bedrock integration cannot select an endpoint without it.',
    );
  }

  const modelId = env.BEDROCK_MODEL_ID;
  if (!modelId || modelId.trim().length === 0) {
    throw new BedrockConfigError(
      'Missing BEDROCK_MODEL_ID environment variable. Set it to a Bedrock model ID available in your AWS account/region ' +
        '(e.g. an Anthropic Claude model ID from the Bedrock model catalog) — this project does not assume a default model, ' +
        'since availability varies by region and account access.',
    );
  }

  return { region, modelId };
}

/** Non-throwing variant for callers (like `bedrock:check`) that want to report configuration status rather than crash. */
export function tryLoadBedrockConfig(env: NodeJS.ProcessEnv = process.env): { config: BedrockConfig } | { error: string } {
  try {
    return { config: loadBedrockConfig(env) };
  } catch (err) {
    if (err instanceof BedrockConfigError) {
      return { error: err.message };
    }
    throw err;
  }
}
