/** Token estimator — repo's existing estimator is calibration chars/3.2 but spec caps use chars/4 for tokenizer-independent upper bound.
 * We provide both and state it: estimator is chars/4-class (ceil(length/4)).
 * This matches the harness's previous byte-fallback bounds (1,200 bytes ≈ 300 tokens).
 * For playbook/skills we use the same simple estimator everywhere so caps are deterministic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Simple chars/4 estimator — documented as tokenizer-independent upper bound
  return Math.ceil(text.length / 4);
}

export function estimateTokensWithCalibration(text: string, calibratedCharsPerToken?: number): number {
  if (!text) return 0;
  const cpt = calibratedCharsPerToken || 3.2;
  return Math.ceil(text.length / cpt);
}

/** Measure guidance size for bench reporting */
export function measureGuidanceTokens(playbookTokens: number, skillsTokens: number, basePromptOverhead?: number): number {
  return playbookTokens + skillsTokens + (basePromptOverhead || 0);
}
