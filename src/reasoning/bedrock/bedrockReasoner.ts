import { ModelInvoker } from '../bedrockReasoningService';
import { ReasoningInput } from '../contract';
import { BedrockClient } from './bedrockClient';

/**
 * Bridges the real AWS Bedrock client into Tend's existing,
 * provider-independent `ModelInvoker` interface (defined in
 * bedrockReasoningService.ts, unchanged from Phase 1). This is the ONLY
 * new class the rest of the reasoning layer needs to know about — nothing
 * outside this `src/reasoning/bedrock/` directory imports the AWS SDK, or
 * even knows it exists.
 *
 * Deliberately thin: all safety-contract enforcement (banned terms,
 * allowed wording, evidence grounding, severity-match) continues to live
 * entirely in the existing, untouched `BedrockReasoningService.explain()`
 * and `validateReasoningOutput()` — this class's only job is turning a
 * (systemPrompt, ReasoningInput) pair into a raw text response from a real
 * model, exactly like the pattern already established for tests via a
 * mock ModelInvoker.
 */
export class BedrockModelInvoker implements ModelInvoker {
  constructor(private readonly client: BedrockClient) {}

  async invoke(systemPrompt: string, userPayload: ReasoningInput): Promise<string> {
    // The ReasoningInput is entirely composed of the deterministic engine's
    // own generated evidence (signal identifiers, computed scores, fixed
    // vocabulary) — never raw Ring payload text — so JSON-stringifying it
    // as the user message does not introduce any Ring-supplied free text
    // into the prompt. See ringNormalizer.ts: nothing Ring-supplied ever
    // reaches evidence.signal/observed as arbitrary free text.
    const userMessage = JSON.stringify(userPayload);
    return this.client.converse(systemPrompt, userMessage);
  }
}
