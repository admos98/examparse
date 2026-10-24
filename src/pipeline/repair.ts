/**
 * Two-Tier Escalation Repair Pipeline (§5.5)
 * Batches only failing items (max 8 items) to the escalation model with their errors.
 */
import { Flag, LLMRequest, Question, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T3_REPAIR_SYSTEM } from './prompts';
import { applyMergePatch } from './patch';
import { RawQuestionSchema, assembleTables, lineNoFromId, rewriteRejection, sanitizeSpansAgainstSource, sliceSourceSpans, spanLineNumbers } from './assemble';
import { canonicalizeForms } from './forms';
import { spanBounds, spanStartLine } from './spans';

export interface RepairResult {
  repairedQuestions: Question[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  shapeMismatch?: boolean;
  appliedCount?: number;
  rejectedCount?: number;
  restrictedCount?: number;
  /** D — rewrite requests the fence refused (garbled-only, number-free, inside spans, ≤140 chars, never key). */
  rewritesRejected?: number;
  rewritesApplied?: number;
  /** Fix 2 — doc-level flags raised by the adoption-time canonicalization pass. */
  formFlags?: Flag[];
}

export async function runEscalationRepair(params: {
  failingItems: { question: Question; errors: string[] }[];
  allQuestions: Question[];
  sourceLines: SourceLine[];
  keyTerritoryLineNos?: number[];
  providerConfig: any;
  maxOutputTokens?: number;
  onLiveText?: (label: string, channel: 'output' | 'reasoning' | 'info', text: string) => void;
}): Promise<RepairResult> {
  const { failingItems, allQuestions, sourceLines, providerConfig, maxOutputTokens } = params;
  const keyLineNos = new Set(params.keyTerritoryLineNos || []);

  if (failingItems.length === 0) {
    return {
      repairedQuestions: allQuestions,
      usage: { inputTokens: 0, outputTokens: 0 },
      appliedCount: 0,
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
      const bounds = spanBounds(q.spans);
      const minL = bounds ? bounds[0] : 1;
      const maxL = bounds ? bounds[1] : 1;
      const startIdx = Math.max(0, (idToIdxMap.get(minL) ?? 0) - 3);
      const endIdx = Math.min(sourceLines.length, (idToIdxMap.get(maxL) ?? (sourceLines.length - 1)) + 4);
      slice = sourceLines
        .slice(startIdx, endIdx)
        .map(l => `${l.id}: ${keyLineNos.has(parseInt(l.id.replace(/\D/g, ''), 10)) ? '[KEY] ' : ''}${l.text}`)
        .join('\n');
    } else {
      // Questions with empty spans must send a page-window context (their page's lines), not an end-of-file slice
      const qIndex = allQuestions.findIndex(x => x.id === q.id);
      let targetPage = 1;
      for (let i = qIndex - 1; i >= 0; i--) {
        const prevQ = allQuestions[i];
        if (prevQ.spans && prevQ.spans.length > 0) {
          const lNum = spanStartLine(prevQ.spans[0]);
          const line = sourceLines.find(l => parseInt(l.id.replace(/\D/g, ''), 10) === lNum);
          if (line) {
            targetPage = line.page;
            break;
          }
        }
      }
      const pageLines = sourceLines.filter(l => l.page === targetPage);
      slice = (pageLines.length > 0 ? pageLines : sourceLines.slice(0, 35))
        .map(l => `${l.id}: ${keyLineNos.has(parseInt(l.id.replace(/\D/g, ''), 10)) ? '[KEY] ' : ''}${l.text}`)
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
    maxOutputTokens: maxOutputTokens ? Math.min(maxOutputTokens, 2048) : 2048,
    label: `Escalation Repair (${batch.length} items)`,
    providerConfig,
  };

  const response = await LLMAdapter.execute(request, { onDelta: (channel, full) => params.onLiveText?.(request.label, channel, full), onInfo: note => params.onLiveText?.(request.label, 'info', note) });

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
    console.warn('Escalation repair response had an unexpected JSON shape; raw model output was omitted.');
    shapeMismatch = true;
    rawPatches = [];
  }

  const patchMap = new Map<string, any>();
  for (const p of rawPatches) {
    if (p && p.id && p.patch) {
      patchMap.set(p.id, p.patch);
    }
  }

  let appliedCount = 0;
  let rejectedCount = 0;
  let restrictedCount = 0;
  let rewritesRejected = 0;
  let rewritesApplied = 0;
  const lineByNo = new Map(sourceLines.map(line => [lineNoFromId(line.id), line]));
  const repairedCandidates = allQuestions.map(q => {
    if (!patchMap.has(q.id)) return q;
    appliedCount++;
    const patch = patchMap.get(q.id);
    const merged = applyMergePatch(q, patch);
    let restricted = false;

    const safeQuestionSpans = sanitizeSpansAgainstSource(merged.spans || q.spans, sourceLines, keyLineNos);
    // D — the repair channel obeys the same rewrite fence as the structure pass: only locally
    // garbled, digit-free, non-key lines inside the question's own spans, ≤140 chars.
    let newRewrites = q.rewrites;
    if (Array.isArray(merged.rewrites)) {
      const allowed = new Set(spanLineNumbers(safeQuestionSpans.spans));
      const previously = new Set((q.rewrites || []).map(r => `${r.line}:${r.text}`));
      const kept = merged.rewrites.filter((r: any) => {
        if (!r || !Number.isInteger(r.line) || typeof r.text !== 'string') { rewritesRejected++; return false; }
        if (previously.has(`${r.line}:${r.text}`)) return true;
        const reason = rewriteRejection(r, lineByNo.get(r.line), keyLineNos, allowed);
        if (reason) { rewritesRejected++; return false; }
        rewritesApplied++;
        return true;
      });
      newRewrites = kept.length ? kept : undefined;
    }
    restricted ||= safeQuestionSpans.clippedKeyLines || safeQuestionSpans.clippedMissingLines;
    if (!safeQuestionSpans.spans.length) {
      rejectedCount++;
      if (restricted || (merged.spans || q.spans || []).length) restrictedCount++;
      return null;
    }

    const rawOptions = merged.options !== undefined ? merged.options : q.options;
    const newOptions = rawOptions?.flatMap((option: any) => {
      const safe = sanitizeSpansAgainstSource(option?.spans, sourceLines, keyLineNos);
      restricted ||= safe.clippedKeyLines || safe.clippedMissingLines;
      if (!safe.spans.length) return [];
      return [{ key: String(option?.key || ''), spans: safe.spans, text: sliceSourceSpans(safe.spans, sourceLines) }];
    });

    const rawTables = merged.tables !== undefined ? merged.tables : q.tables;
    const safeTables = (rawTables || []).flatMap((table: any) => {
      const safe = sanitizeSpansAgainstSource(table?.spans, sourceLines, keyLineNos);
      restricted ||= safe.clippedKeyLines || safe.clippedMissingLines;
      return safe.spans.length ? [{ ...table, spans: safe.spans }] : [];
    });
    const newTables = assembleTables(safeTables, sourceLines, keyLineNos);

    const answerCandidate = merged.answer !== undefined ? merged.answer : q.answer;
    let safeAnswer = answerCandidate;
    if (answerCandidate?.spans) {
      const safe = sanitizeSpansAgainstSource(answerCandidate.spans, sourceLines, keyLineNos, true);
      if (safe.clippedMissingLines) restricted = true;
      safeAnswer = { ...answerCandidate, spans: safe.spans, text: safe.spans.length ? sliceSourceSpans(safe.spans, sourceLines) : answerCandidate.text || '' };
    }

    const requestedConfidence = typeof patch.confidence === 'number'
      ? patch.confidence
      : typeof merged.confidence === 'number' ? merged.confidence : q.confidence;
    const updatedConfidence = restricted ? Math.min(Number(requestedConfidence) || 0, 0.5) : requestedConfidence;
    const repairedQ: Question = {
      ...q,
      ...merged,
      id: q.id,
      label: q.label,
      no: q.no,
      parentId: q.parentId,
      sectionId: q.sectionId,
      spans: safeQuestionSpans.spans,
      stem: sliceSourceSpans(safeQuestionSpans.spans, sourceLines, newRewrites),
      rewrites: newRewrites,
      options: newOptions?.length ? newOptions : undefined,
      answer: safeAnswer,
      tables: newTables.length ? newTables : undefined,
      confidence: updatedConfidence,
      flags: restricted ? [...(q.flags || []), 'REPAIR_SPAN_RESTRICTED'] : q.flags,
    };

    if (restricted) restrictedCount++;
    const validation = RawQuestionSchema.safeParse(repairedQ);
    if (!validation.success) repairedQ.flags = [...(repairedQ.flags || []), 'REPAIR_VALIDATION_WARNING'];
    return repairedQ;
  });
  let repairedQuestions = repairedCandidates.filter((question): question is Question => question !== null);

  // Fix 2 (Marvel Batch 6) — ADOPTION-TIME CANONICALIZATION (defense in depth).
  // Repaired items are replacements: they must pass the same deterministic registry the
  // assembler uses BEFORE they enter the document, or a repaired stem/option set can ship
  // uncanonicalized (whole-line True/False options, stems keeping their `a) True b) False` tail).
  // Scope = patched questions (+ their group children); untouched questions stay verbatim.
  let formFlags: Flag[] = [];
  if (patchMap.size > 0) {
    const canonical = canonicalizeForms({
      questions: repairedQuestions,
      sourceLines,
      scopeQuestionIds: new Set([...patchMap.keys()]),
    });
    repairedQuestions = canonical.questions;
    formFlags = canonical.flags;
  }

  return {
    repairedQuestions,
    formFlags,
    usage: response.usage,
    shapeMismatch,
    appliedCount,
    rejectedCount,
    restrictedCount,
    rewritesRejected,
    rewritesApplied,
  };
}
