import { ReasoningInput, ReasoningOutput, ReasoningService } from './contract';

/**
 * DEVELOPMENT/DEMO TOOL — NOT BEDROCK.
 *
 * Produces contract-compliant ReasoningOutput deterministically from the
 * evidence, without calling any language model. This exists so the demo and
 * test suite can exercise the full evidence -> explanation -> UI pipeline
 * without requiring live AWS credentials, while still respecting the exact
 * same output contract a real BedrockReasoningService must satisfy. It must
 * never be presented as "Bedrock reasoning" in the UI or README — always
 * labeled as the template/offline fallback.
 */
export class TemplateReasoningService implements ReasoningService {
  async explain(input: ReasoningInput): Promise<ReasoningOutput> {
    const { severity } = input.deviation;

    if (severity === 'NORMAL') {
      return {
        severityLabel: 'NORMAL',
        explanation: "Today's activity is consistent with the household's usual routine.",
        evidenceReferences: [],
        recommendedWording: 'No action needed.',
        confidence: input.householdContext.confidence,
        notifyRecommended: false,
      };
    }

    const sentences = input.deviation.evidence.map((e) => describeEvidence(e));
    const explanation =
      sentences.length > 0
        ? `Today's activity differs from the recent routine. ${sentences.join(' ')}`
        : "Today's activity differs from the recent routine, though no single signal fully explains it.";

    const recommendedWording =
      severity === 'HIGH' ? 'Consider checking in.' : severity === 'MODERATE' ? 'Consider checking in.' : 'Worth a quick look.';

    return {
      severityLabel: severity,
      explanation,
      evidenceReferences: input.deviation.evidence.map((e) => e.signal),
      recommendedWording,
      confidence: input.householdContext.confidence,
      notifyRecommended: severity === 'MODERATE' || severity === 'HIGH',
    };
  }
}

function describeEvidence(e: ReasoningInput['deviation']['evidence'][number]): string {
  if (e.observed === false && e.expectedWindow) {
    const past = e.minutesPastWindow !== undefined ? ` (${e.minutesPastWindow} minutes past the usual window of ${e.expectedWindow})` : '';
    return `No activity has been observed for "${e.signal.replace(/_/g, ' ')}"${past}.`;
  }
  if (typeof e.observed === 'string' && e.expectedWindow) {
    return `"${e.signal.replace(/_/g, ' ')}" occurred at ${e.observed}, compared to a usual time of ${e.expectedWindow}.`;
  }
  if (typeof e.observed === 'string') {
    return `An unusual sequence was observed: ${e.observed}.`;
  }
  return `"${e.signal.replace(/_/g, ' ')}" differed from the usual pattern.`;
}
