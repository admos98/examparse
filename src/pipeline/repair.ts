/**
 * Two-Tier Escalation Repair Pipeline (§5.5)
 * Batches only failing items (max 8 items) to the escalation model with their errors.
 */
import { LLMRequest, Question, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T3_REPAIR_SYSTEM } from './prompts';
import { applyMergePatch } from './patch';
import { sliceSourceSpans } from './assemble';

export interface RepairResult {
  repairedQuestions: Question[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}

export async function runEscalationRepair(params: {
  failingItems: { question: Question; errors: string[] }[];
  allQuestions: Question[];
  sourceLines: SourceLine[];
  providerConfig: any;
}): Promise<RepairResult> {
  const { failingItems, allQuestions, sourceLines, providerConfig } = params;

  if (failingItems.length === 0) {
    return {
      repairedQuestions: allQuestions,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  // Max 8 failing items per repair round
  const batch = failingItems.slice(0, 8);
  const itemsPayload: string[] = [];

  for (const item of batch) {
    const q = item.question;
    let minL = sourceLines.length;
    let maxL = 1;
    for (const [s, e] of q.spans) {
      minL = Math.min(minL, s);
      maxL = Math.max(maxL, e);
    }
    const slice = sourceLines
      .slice(Math.max(0, minL - 3), Math.min(sourceLines.length, maxL + 3))
      .map(l => `${l.id}: ${l.text}`)
      .join('\n');

    itemsPayload.push(
      `ITEM ID: ${q.id}\nCURRENT JSON:\n${JSON.stringify({ label: q.label, no: q.no, type: q.type, points: q.points, spans: q.spans, options: q.options })}\nERRORS:\n- ${item.errors.join('\n- ')}\nSOURCE:\n${slice}`
    );
  }

  const promptText = `Please repair these ${batch.length} items by returning a JSON array of {"id": string, "patch": <RFC 7386 merge patch>}:\n\n${itemsPayload.join('\n\n=====\n\n')}`;

  const request: LLMRequest = {
    role: 'escalation',
    system: T3_REPAIR_SYSTEM,
    text: promptText,
    maxOutputTokens: 2048,
    label: `Escalation Repair (${batch.length} items)`,
    providerConfig,
  };

  const response = await LLMAdapter.execute(request);
  const patches: any[] = Array.isArray(response.json) ? response.json : [];
  const patchMap = new Map<string, any>();
  for (const p of patches) {
    if (p && p.id && p.patch) {
      patchMap.set(p.id, p.patch);
    }
  }

  const repairedQuestions = allQuestions.map(q => {
    if (patchMap.has(q.id)) {
      const patch = patchMap.get(q.id);
      const merged = applyMergePatch(q, patch);
      const newSpans = merged.spans || q.spans;
      const newRewrites = merged.rewrites || q.rewrites;
      return {
        ...q,
        ...merged,
        spans: newSpans,
        stem: sliceSourceSpans(newSpans, sourceLines, newRewrites),
        confidence: 0.95, // repaired
      };
    }
    return q;
  });

  return {
    repairedQuestions,
    usage: response.usage,
  };
}
