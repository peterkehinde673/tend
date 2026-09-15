import { BedrockConfig } from './bedrockConfig';
import { BedrockInvocationError, BedrockSdkUnavailableError } from './bedrockTypes';

/**
 * IMPORTANT — READ BEFORE ASSUMING THIS IS WIRED UP LIKE A NORMAL DEPENDENCY.
 *
 * This project declares `@aws-sdk/client-bedrock-runtime` in package.json,
 * per the "use official AWS SDK packages" requirement, and this file uses
 * the real AWS SDK v3 Converse API exactly as it would be used in a normal
 * Node project. However: this sandboxed development environment's network
 * egress proxy blocks `registry.npmjs.org` (confirmed directly — the same
 * `x-deny-reason: host_not_allowed` behavior already documented for Ring's
 * API domains), so `npm install` cannot actually fetch this package here.
 *
 * To keep the REST of this project typechecking, building, and testing
 * cleanly in an environment where this package cannot be installed, the
 * SDK is loaded via a runtime `import()` rather than a top-level static
 * import, and its types are treated defensively (not statically resolved
 * against the package's own .d.ts files, which also aren't present). This
 * is a real, working pattern for an optional/heavy dependency — not a
 * workaround that hides the limitation. The moment this package is
 * actually installed (`npm install`, in an environment with registry
 * access), this code calls the real Bedrock Converse API with no changes
 * required.
 *
 * Every test in this project that exercises Bedrock reasoning does so
 * through the existing `ModelInvoker` mock seam (see
 * bedrockReasoningService.ts and bedrockReasoner.ts) and NEVER through
 * this file's dynamic import — so passing tests never imply this file's
 * real AWS SDK call path has been exercised. See README "AWS / Amazon
 * Bedrock Integration" for the exact CONFIRMED / NOT VERIFIED breakdown.
 */

interface BedrockRuntimeModuleShape {
  BedrockRuntimeClient: new (opts: { region: string }) => { send: (command: unknown) => Promise<unknown> };
  ConverseCommand: new (input: {
    modelId: string;
    system: { text: string }[];
    messages: { role: 'user'; content: { text: string }[] }[];
  }) => unknown;
}

async function loadBedrockRuntimeModule(): Promise<BedrockRuntimeModuleShape> {
  try {
    // The bare specifier is intentionally not statically analyzable-typed
    // here (see file-level comment) — this is the one place in the
    // codebase that touches the AWS SDK at all.
    const moduleName = '@aws-sdk/client-bedrock-runtime';
    const mod: unknown = await import(moduleName);
    return mod as BedrockRuntimeModuleShape;
  } catch (err) {
    throw new BedrockSdkUnavailableError(
      `Could not load the "@aws-sdk/client-bedrock-runtime" package: ${(err as Error).message}. ` +
        `This package must be installed (npm install) before any real Bedrock call can be made. ` +
        `In this project's own sandboxed development environment, installation is blocked by the network egress ` +
        `policy — see README "AWS / Amazon Bedrock Integration" for the confirmed, reproducible reason.`,
      err,
    );
  }
}

export class BedrockClient {
  constructor(private readonly config: BedrockConfig) {}

  /**
   * Calls Bedrock's Converse API with a system prompt and a single user
   * message, returning the model's text response. Never logs the prompt,
   * the user message, or the response content — only safe operational
   * metadata (region, model id, success/failure) should ever be logged by
   * a caller of this method.
   */
  async converse(systemPrompt: string, userMessage: string): Promise<string> {
    const sdk = await loadBedrockRuntimeModule();

    const client = new sdk.BedrockRuntimeClient({ region: this.config.region });
    const command = new sdk.ConverseCommand({
      modelId: this.config.modelId,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userMessage }] }],
    });

    let response: unknown;
    try {
      response = await client.send(command);
    } catch (err) {
      // Never include systemPrompt/userMessage in the error — they may
      // contain evidence derived from household activity data.
      throw new BedrockInvocationError(
        `Bedrock Converse call failed for model "${this.config.modelId}" in region "${this.config.region}": ${(err as Error).message}`,
        err,
      );
    }

    const text = extractConverseText(response);
    if (text === undefined) {
      throw new BedrockInvocationError('Bedrock response did not contain the expected text content shape (output.message.content[0].text).');
    }
    return text;
  }
}

/** Defensively extracts the text field from a Bedrock Converse API response, per its documented output shape, without assuming every optional field is present. Exported for direct unit testing of malformed-response handling. */
export function extractConverseText(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const output = (response as { output?: unknown }).output;
  if (!output || typeof output !== 'object') return undefined;
  const message = (output as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!first || typeof first !== 'object') return undefined;
  const text = (first as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}
