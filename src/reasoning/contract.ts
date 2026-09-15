import { DeviationSeverity } from '../domain/deviation';

/**
 * The exact JSON contract between the deterministic engine and the
 * reasoning layer (Bedrock in production, a fake/deterministic
 * implementation in tests). This file is the safety boundary: it defines
 * what the reasoning layer is allowed to receive and, critically, what
 * shape and vocabulary its output is constrained to.
 */

export interface ReasoningEvidenceInput {
  signal: string;
  expectedWindow?: string;
  observed: boolean | string;
  minutesPastWindow?: number;
  confidence: number;
}

export interface ReasoningFeedbackContext {
  signal: string;
  lastFeedback: string;
  daysAgo: number;
}

export interface ReasoningInput {
  householdContext: {
    daysOfBaseline: number;
    confidence: number;
  };
  deviation: {
    compositeScore: number;
    severity: DeviationSeverity;
    evidence: ReasoningEvidenceInput[];
  };
  recentFeedbackContext: ReasoningFeedbackContext[];
}

/**
 * Pre-approved, fixed phrase set. The reasoning layer's `recommendedWording`
 * MUST be one of these — never a freely generated string — precisely so the
 * non-emergency framing cannot be undermined by model behavior. This is a
 * structural guardrail, not just a prompt instruction.
 */
export const ALLOWED_RECOMMENDED_WORDING: readonly string[] = [
  'Consider checking in.',
  'Worth a quick look.',
  'No action needed.',
];

/**
 * Terms the explanation text must never contain, regardless of how the
 * underlying evidence is phrased. Checked case-insensitively as substrings.
 * This list intentionally stays narrow and literal (see this project's
 * broader constitution around not over-narrating detection mechanics) — it
 * exists to catch clearly disqualifying language, not to be a exhaustive
 * clinical dictionary.
 */
export const BANNED_EXPLANATION_TERMS: readonly string[] = [
  'emergency',
  'call 911',
  '911',
  'diagnos', // catches diagnose/diagnosis/diagnostic
  'medical condition',
  'injur', // catches injury/injured
  'fall detected',
  'fallen',
  'stroke',
  'heart attack',
  'dead',
  'died',
  'facial recognition',
  'identified as',
  'biometric',
  'police',
  'law enforcement',
  'credential',
  'access token',
  'api key',
  'password',
  'secret key',
];

export interface ReasoningOutput {
  severityLabel: DeviationSeverity;
  explanation: string;
  evidenceReferences: string[];
  recommendedWording: string;
  confidence: number;
  notifyRecommended: boolean;
}

export interface ReasoningService {
  explain(input: ReasoningInput): Promise<ReasoningOutput>;
}

/**
 * Validates a candidate reasoning output against the input it was produced
 * from. Returns a list of violations; an empty array means the output is
 * safe to surface to a caregiver. This validation is deliberately mechanical
 * (string/shape checks) rather than semantic — it cannot catch every
 * possible failure, but it enforces the hard, non-negotiable constraints
 * listed in the project's Bedrock safety contract.
 */
export function validateReasoningOutput(output: ReasoningOutput, input: ReasoningInput): string[] {
  const problems: string[] = [];

  // Defensive guards first: `output` originates from JSON.parse'd, untrusted
  // model text that has only been cast to ReasoningOutput's TYPE, not
  // verified to actually match its SHAPE at runtime. A malformed model
  // response (missing fields, wrong types) must always surface as a normal
  // validation problem here — it must never be able to crash this function
  // with an unhandled exception, since that would propagate as an opaque
  // TypeError instead of the safety-contract violation it actually is.
  if (!output || typeof output !== 'object') {
    return ['Reasoning output is not an object.'];
  }

  if (output.severityLabel !== input.deviation.severity) {
    problems.push(
      `severityLabel (${String(output.severityLabel)}) does not match the deterministic severity (${input.deviation.severity}) — the reasoning layer must not alter the deterministic classification.`,
    );
  }

  if (!Array.isArray(output.evidenceReferences)) {
    problems.push(`evidenceReferences must be an array of strings; got ${JSON.stringify(output.evidenceReferences)}.`);
  } else {
    const knownSignals = new Set(input.deviation.evidence.map((e) => e.signal));
    for (const ref of output.evidenceReferences) {
      if (!knownSignals.has(ref)) {
        problems.push(`evidenceReferences contains "${String(ref)}", which is not present in the supplied evidence.`);
      }
    }
    if (output.evidenceReferences.length === 0 && input.deviation.evidence.length > 0) {
      problems.push('evidenceReferences is empty despite evidence being supplied — explanation must cite its basis.');
    }
  }

  if (!ALLOWED_RECOMMENDED_WORDING.includes(output.recommendedWording)) {
    problems.push(
      `recommendedWording "${String(output.recommendedWording)}" is not in the allowed wording set: ${ALLOWED_RECOMMENDED_WORDING.join(' | ')}`,
    );
  }

  if (typeof output.explanation !== 'string') {
    problems.push(`explanation must be a string; got ${JSON.stringify(output.explanation)}.`);
  } else {
    const lowerExplanation = output.explanation.toLowerCase();
    for (const banned of BANNED_EXPLANATION_TERMS) {
      if (lowerExplanation.includes(banned)) {
        problems.push(`explanation contains banned term/phrase: "${banned}"`);
      }
    }
  }

  if (output.confidence < 0 || output.confidence > 1) {
    problems.push(`confidence ${output.confidence} is out of range [0,1]`);
  }

  // Detect explanation text referencing a time or number not derivable from
  // the supplied evidence. This is a best-effort check (looks for digit
  // sequences in the explanation and asks whether they show up anywhere in
  // the evidence's rendered text) rather than a full grounding proof — full
  // grounding verification is a later-phase concern, but this catches the
  // most obvious invented-number failure mode cheaply.
  const evidenceText = JSON.stringify(input.deviation.evidence);
  const numbersInExplanation = output.explanation.match(/\d+/g) ?? [];
  for (const num of numbersInExplanation) {
    if (!evidenceText.includes(num)) {
      problems.push(`explanation references a number ("${num}") not found anywhere in the supplied evidence.`);
    }
  }

  return problems;
}
