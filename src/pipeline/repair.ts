/**
 * Two-Tier Escalation Repair Pipeline (§5.5)
 * Batches only failing items (max 8 items) to the escalation model with their errors.
 */
import { LLMRequest, Question, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T3_REPAIR_SYSTEM } from './prompts';
import { applyMergePatch } from './patch';
import { RawQuestionSchema, sliceSourceSpans } from './assemble';

export interface RepairResult {
  repairedQuestions: Question[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  shapeMismatch?: boolean;
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

  const idToIdxMap = new Map<number, number>();
  sourceLines.forEach((l, idx) => {
    const num = parseInt(l.id.replace(/\D/g, ''), 10);
    if (!isNaN(num)) idToIdxMap.set(num, idx);
  });

  for (const item of batch) {
    const q = item.question;
    let slice = '';

    if (q.spans && q.spans.length > 0) {
      let minL = Infinity;
      let maxL = -Infinity;
      for (const [s, e] of q.spans) {
        minL = Math.min(minL, s);
        maxL = Math.max(maxL, e);
      }
      const startIdx = Math.max(0, (idToIdxMap.get(minL) ?? 0) - 3);
      const endIdx = Math.min(sourceLines.length, (idToIdxMap.get(maxL) ?? (sourceLines.length - 1)) + 4);
      slice = sourceLines
        .slice(startIdx, endIdx)
        .map(l => `${l.id}: ${l.text}`)
        .join('\n');
    } else {
      // Questions with empty spans must send a page-window context (their page's lines), not an end-of-file slice
      const qIndex = allQuestions.findIndex(x => x.id === q.id);
      let targetPage = 1;
      for (let i = qIndex - 1; i >= 0; i--) {
        const prevQ = allQuestions[i];
        if (prevQ.spans && prevQ.spans.length > 0) {
          const lNum = prevQ.spans[0][0];
          const line = sourceLines.find(l => parseInt(l.id.replace(/\D/g, ''), 10) === lNum);
          if (line) {
            targetPage = line.page;
            break;
          }
        }
      }
      const pageLines = sourceLines.filter(l => l.page === targetPage);
      slice = (pageLines.length > 0 ? pageLines : sourceLines.slice(0, 35))
        .map(l => `${l.id}: ${l.text}`)
        .join('\n');
    }

    // Repair payloads must NOT include assembled option text (spans only)
    const optionsSpansOnly = q.options?.map(o => ({ key: o.key, spans: o.spans }));

    itemsPayload.push(
      `ITEM ID: ${q.id}\nCURRENT JSON:\n${JSON.stringify({
        label: q.label,
        no: q.no,
        type: q.type,
        points: q.points,
        spans: q.spans,
        options: optionsSpansOnly,
        confidence: q.confidence,
      })}\nERRORS:\n- ${item.errors.join('\n- ')}\nSOURCE:\n${slice}`
    );
  }

  // Request envelope {"items": [...]} or bare array
  const promptText = `Please repair these ${batch.length} items by returning a JSON object: {"items": [{"id": string, "patch": <RFC 7386 merge patch>}]} (or a JSON array):\n\n${itemsPayload.join('\n\n=====\n\n')}`;

  const request: LLMRequest = {
    role: 'escalation',
    system: T3_REPAIR_SYSTEM,
    text: promptText,
    maxOutputTokens: 2048,
    label: `Escalation Repair (${batch.length} items)`,
    providerConfig,
  };

  const response = await LLMAdapter.execute(request);

  // Parse envelope {"items": [...]} or bare array
  let rawPatches: any[] | null = null;
  if (Array.isArray(response.json)) {
    rawPatches = response.json;
  } else if (response.json && typeof response.json === 'object') {
    const obj = response.json as any;
    if (Array.isArray(obj.items)) rawPatches = obj.items;
    else if (Array.isArray(obj.patches)) rawPatches = obj.patches;
    else if (Array.isArray(obj.results)) rawPatches = obj.results;
  }

  let shapeMismatch = false;
  if (!rawPatches) {
    console.warn('Escalation repair response returned unexpected format instead of {"items": [...]}:', response.rawText);
    shapeMismatch = true;
    rawPatches = [];
  }

  const patchMap = new Map<string, any>();
  for (const p of rawPatches) {
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

      // Re-slice option texts after patches
      const rawOptions = merged.options !== undefined ? merged.options : q.options;
      const newOptions = rawOptions?.map((opt: any) => ({
        key: opt.key,
        spans: opt.spans || [],
        text: sliceSourceSpans(opt.spans || [], sourceLines),
      }));

      // Remove hard-coded confidence: 0.95; preserve model confidence or patch confidence
      const updatedConfidence = typeof patch.confidence === 'number'
        ? patch.confidence
        : typeof merged.confidence === 'number'
        ? merged.confidence
        : q.confidence;

      const repairedQ: Question = {
        ...q,
        ...merged,
        spans: newSpans,
        stem: sliceSourceSpans(newSpans, sourceLines, newRewrites),
        rewrites: newRewrites,
        options: newOptions,
        confidence: updatedConfidence,
      };

      // Re-validate repaired question
      const validation = RawQuestionSchema.safeParse(repairedQ);
      if (!validation.success) {
        repairedQ.flags = [...(repairedQ.flags || []), 'REPAIR_VALIDATION_WARNING'];
      }

      return repairedQ;
    }
    return q;
  });

  return {
    repairedQuestions,
    usage: response.usage,
    shapeMismatch,
  };
}
