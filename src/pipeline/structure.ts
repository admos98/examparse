/**
 * Stage 2: Structure Pass Pipeline (§6.2)
 * Sends Line-Addressed Source (LAS) + image manifest to LLM with Prompt T1 and strict schema.
 */
import { ImageAsset, LLMRequest, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T1_GEMINI_SCHEMA, T1_STRUCTURE_SYSTEM } from './prompts';
import { repairTruncatedJson } from '../utils/jsonRepair';
import { appendJournalCall, loadJournal, markJournalComplete } from './journal';

export interface StructurePassResult {
  sections: any[];
  rawQuestions: any[];
  meta: any;
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  rawText: string;
  label?: string;
  resumeLine?: number;
  attempts?: number;
  finishReason?: string;
  flags?: any[];
  /** True only if the (final) model response had json: null origin — such results must never be cached. */
  jsonNull?: boolean;
}

/** Unwrap result/data/exam/output envelopes containing questions (sections/meta alongside win, outer is fallback). */
export function unwrapStructureData(data: any): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (Array.isArray(data.questions)) return data;
  for (const key of ['result', 'data', 'exam', 'output'] as const) {
    const env = data[key];
    if (env && typeof env === 'object' && !Array.isArray(env) && Array.isArray(env.questions)) {
      return {
        ...data,
        ...env,
        questions: env.questions,
        sections: Array.isArray(env.sections) ? env.sections : data.sections,
        meta: env.meta ?? data.meta,
      };
    }
  }
  return data;
}

function buildStructureShapeError(params: {
  finishReason?: string;
  rawText?: string;
  jsonNull: boolean;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}): Error & any {
  const rawText = params.rawText || '';
  const snippet = rawText.slice(0, 300);
  let message = `Structure response had no usable questions (finishReason=${params.finishReason || 'unknown'}): ${snippet}`;
  if (params.jsonNull && !rawText.includes('{')) {
    message = `Structure response had no usable questions (finishReason=${params.finishReason || 'unknown'}): the model spent its output on prose/reasoning instead of JSON; use a non-reasoning instruct model or a higher output cap. Raw: ${snippet}`;
  }
  const flag = {
    id: 'flag_structure_shape_mismatch',
    severity: 'error' as const,
    code: 'STRUCTURE_SHAPE_MISMATCH',
    message,
  };
  const err: any = new Error(message);
  err.code = 'STRUCTURE_SHAPE_MISMATCH';
  err.flag = flag;
  err.flags = [flag];
  err.attempts = params.attempts;
  err.usage = params.usage;
  err.finishReason = params.finishReason;
  err.rawText = rawText;
  return err;
}

export interface StructurePassParams {
  sourceLines: SourceLine[];
  images: ImageAsset[];
  languageHint?: string;
  latexEnabled: boolean;
  providerConfig: any;
  maxBudgetTokens?: number;
  journalKey?: string;
  journalEnabled?: boolean;
  onLiveText?: (label: string, channel: 'output' | 'reasoning' | 'info', fullText: string) => void;
  recoveryBudget?: { count: number };
}

export function coveredUntilLine(questions: any[]): number {
  let maximum = 0;
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.spans)) {
      for (const span of node.spans) {
        if (!Array.isArray(span)) continue;
        const endLine = Number(span[1]);
        if (Number.isFinite(endLine)) maximum = Math.max(maximum, endLine);
      }
    }
    for (const key of ['options', 'subQuestions', 'tables']) {
      if (Array.isArray(node[key])) node[key].forEach(visit);
    }
    if (node.answer) visit(node.answer);
  };
  if (Array.isArray(questions)) questions.forEach(visit);
  return maximum;
}

const COMPACT_T1_SCHEMA = {
  meta: { title: 'string?', language: 'string', direction: 'ltr|rtl', totalPoints: 'number?' },
  sections: [
    { id: 'string', index: 'number', title: 'string?', instructions: 'string?', spans: '[[startLine, endLine]]' },
  ],
  questions: [
    {
      id: 'string',
      label: 'string',
      no: 'number',
      parentId: 'string?',
      sectionId: 'string?',
      spans: '[[startLine, endLine]]',
      type: 'mcq|truefalse|short|long|fillblank|matching|multi|numeric|diagram|essay|unknown',
      points: 'number?',
      options: [{ key: 'string', spans: '[[startLine, endLine]]' }],
      tables: [{ spans: '[[startLine, endLine]]' }],
      answer: { spans: '[[startLine, endLine]]' },
      rewrites: [{ line: 'number', text: 'string' }],
      images: [{ imageId: 'string', role: 'stem|option|table|decoration' }],
      confidence: 'number(0..1)',
    },
  ],
};

export async function runStructurePass(params: StructurePassParams): Promise<StructurePassResult> {
  const { sourceLines, images, languageHint, latexEnabled, providerConfig, maxBudgetTokens } = params;
  const recoveryBudget = params.recoveryBudget || (params.recoveryBudget = { count: 0 });
  const consumeRecovery = () => { if (recoveryBudget.count >= 8) return false; recoveryBudget.count++; return true; };

  // Format Line-Addressed Source (LAS)
  // Each line prefixed with [L0001], page markers === PAGE n ===
  let lasText = '';
  let currentPage = 0;

  for (const line of sourceLines) {
    if (line.page !== currentPage) {
      currentPage = line.page;
      lasText += `=== PAGE ${currentPage} ===\n`;
    }
    lasText += `[${line.id}] ${line.text}\n`;
  }

  // Format Image Manifest (IDs, page, near line — NO pixels!)
  const manifestEntries = images.map(img => ({
    id: img.id,
    page: img.page,
    nearLine: img.anchorLine || 'unknown',
  }));

  const isGemini = providerConfig?.kind === 'gemini';

  let userPrompt = `CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint: languageHint || null })}\n\nIMAGE MANIFEST:\n${JSON.stringify(manifestEntries, null, 2)}\n\nSOURCE:\n${lasText}`;

  // For non-Gemini providers, embed a compact JSON schema directly in user prompt
  if (!isGemini) {
    userPrompt += `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA, null, 2)}`;
  }

  // If source text > 120k characters, chunk by pages (rare for exams, but supported per §5.8 & §10)
  if (lasText.length > 120_000) {
    return await runChunkedStructurePass(params, lasText, manifestEntries);
  }

  // Size from exam density while respecting the user's configured ceiling.
  const budgetCap = maxBudgetTokens || 16384;
  const estimatedInput = Math.ceil(lasText.length / 3.2);
  const estimatedOutput = Math.max(estimatedInput * 0.25, sourceLines.length * 14);
  const baseCap = Math.min(budgetCap, Math.max(8192, Math.ceil(estimatedOutput * 1.25)));

  const request: LLMRequest = {
    role: 'fast',
    system: T1_STRUCTURE_SYSTEM,
    text: userPrompt,
    jsonSchema: isGemini ? T1_GEMINI_SCHEMA : undefined,
    maxOutputTokens: baseCap,
    label: 'Structure Pass',
    providerConfig,
  };

  let attempts = 1;
  // Recover the newest journal partial only via ordinary salvage/repair + structure validation.
  if (params.journalEnabled && params.journalKey) {
    const journal = await loadJournal(params.journalKey);
    if (journal && !journal.complete) {
      let recovered: any = null; let recoveredRaw = ''; let recoveredWasRepaired = false;
      for (const call of [...journal.calls].reverse()) {
        if (!call.rawText?.includes('{')) continue;
        let parsed: any = null; let wasRepaired = false;
        try { parsed = JSON.parse(call.rawText); } catch { parsed = repairTruncatedJson(call.rawText); wasRepaired = parsed !== null; }
        parsed = unwrapStructureData(parsed);
        if (Array.isArray(parsed?.questions) && parsed.questions.length) { recovered = parsed; recoveredRaw = call.rawText; recoveredWasRepaired = wasRepaired; break; }
      }
      if (recovered) {
        const questions = [...recovered.questions]; const sections = [...(recovered.sections || [])];
        const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        let addedAtLeastOne = false; let covered = coveredUntilLine(questions);
        for (let round = 0; round < 2; round++) {
          if (round > 0 && !consumeRecovery()) break;
          const startLine = Math.max(1, covered - 1);
          const remaining = sourceLines.filter(line => Number(line.id.replace(/\D/g, '')) >= startLine);
          if (!remaining.length) break;
          const lastBySection: Record<string, number> = {};
          for (const q of questions) { const sid = q.sectionId || 'default'; lastBySection[sid] = Math.max(lastBySection[sid] || 0, Number(q.no) || 0); }
          const memory = `SESSION MEMORY (already established — do NOT repeat these): meta=${JSON.stringify(recovered.meta || {})}; sections=${JSON.stringify(sections.map(s => ({ id: s.id, title: String(s.title || '').slice(0, 40) })))}; lastQuestionNoBySection=${JSON.stringify(lastBySection)}; coveredSourceLines=1..${covered}. Reuse these section ids; continue question numbering after the given numbers; output ONLY questions/sections for the source below.`.slice(0, 1100);
          const lines = remaining.map(line => `[${line.id}] ${line.text}`).join('\n');
          const basePrefix = request.text.split('\n\nSOURCE:')[0];
          const configEnd = basePrefix.indexOf('\n');
          const withMemory = configEnd >= 0 ? `${basePrefix.slice(0, configEnd)}\n${memory}${basePrefix.slice(configEnd)}` : `${basePrefix}\n${memory}`;
          const contract = !isGemini ? `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA)}` : '';
          const continuationReq: LLMRequest = { ...request, text: `${withMemory}\n\nSOURCE (continuation):\n${lines}${contract}`, maxOutputTokens: Math.min(budgetCap, Math.max(4096, Math.ceil(Math.max(remaining.length * 14, remaining.reduce((n,l)=>n+l.text.length,0)/3.2*0.25)*1.25))), label: `Structure Pass (Journal Continuation ${round + 1})` };
          const continuation = await LLMAdapter.execute(continuationReq, { onDelta: (channel, full) => params.onLiveText?.(continuationReq.label, channel, full), onInfo: note => params.onLiveText?.(continuationReq.label, 'info', note), salvagePartial: true });
          if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: continuationReq.label, rawText: continuation.rawText, reasoningText: continuation.reasoningText, finishReason: continuation.finishReason, usage: continuation.usage, complete: true });
          usage.inputTokens += continuation.usage.inputTokens; usage.outputTokens += continuation.usage.outputTokens; usage.cachedTokens = (usage.cachedTokens || 0) + (continuation.usage.cachedTokens || 0);
          let part: any = unwrapStructureData(continuation.json);
          if (!Array.isArray(part?.questions) && continuation.json == null) part = unwrapStructureData(repairTruncatedJson(continuation.rawText));
          const seen = new Set(questions.map(q => `${q.sectionId || ''}:${q.no}`));
          const added = (part?.questions || []).filter((q: any) => { const k = `${q.sectionId || ''}:${q.no}`; if (seen.has(k)) return false; seen.add(k); return true; });
          if (!added.length) break;
          addedAtLeastOne = true; questions.push(...added); sections.push(...(part.sections || [])); recovered.meta = recovered.meta || part.meta; covered = coveredUntilLine(questions);
          const lastSourceLine = Math.max(0, ...sourceLines.map(line => Number(line.id.replace(/\D/g, '')) || 0));
          if (covered >= lastSourceLine) break;
        }
        if (addedAtLeastOne && params.journalEnabled && params.journalKey) await markJournalComplete(params.journalKey);
        const priorUsage = journal.calls.reduce((a, c) => ({ inputTokens: a.inputTokens + (c.usage?.inputTokens || 0), outputTokens: a.outputTokens + (c.usage?.outputTokens || 0), cachedTokens: (a.cachedTokens || 0) + (c.usage?.cachedTokens || 0) }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
        return { sections, rawQuestions: questions, meta: recovered.meta || {}, usage: { inputTokens: priorUsage.inputTokens + usage.inputTokens, outputTokens: priorUsage.outputTokens + usage.outputTokens, cachedTokens: (priorUsage.cachedTokens || 0) + (usage.cachedTokens || 0) }, rawText: recoveredRaw, resumeLine: Math.max(1, covered - 1), attempts: journal.calls.length + 2, finishReason: 'journal-resume', flags: [...(addedAtLeastOne ? [{ code: 'RESUMED_FROM_JOURNAL', message: `Recovered ${questions.length} questions from a previous partial parse.` }] : [{ code: 'PARTIAL_COVERAGE', message: 'The recovered partial could not be extended.' }]), ...(recoveredWasRepaired ? [{ code: 'TRUNCATED_JSON_REPAIRED', message: `Recovered ${questions.length} questions from truncated JSON.` }] : [])], jsonNull: !addedAtLeastOne };
      }
    }
  }

  const streamOpts = (label: string) => {
    let output = '', reasoning = '', lastPersist = 0;
    return {
      onDelta: (channel: 'output' | 'reasoning', fullText: string) => {
        if (channel === 'output') output = fullText; else reasoning = fullText;
        params.onLiveText?.(label, channel, fullText);
        const now = Date.now();
        if (params.journalEnabled && params.journalKey && now - lastPersist >= 3000) {
          lastPersist = now;
          void appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: output, reasoningText: reasoning, complete: false });
        }
      },
      onInfo: (note: string) => params.onLiveText?.(label, 'info', note),
      salvagePartial: true,
    };
  };
  let response = await LLMAdapter.execute(request, streamOpts(request.label));
  if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: request.label, rawText: response.rawText, reasoningText: response.reasoningText, finishReason: response.finishReason, usage: response.usage, complete: true });
  let data: any = unwrapStructureData(response.json);
  const totalUsage = { ...response.usage };
  let finalFinishReason = response.finishReason;
  let finalRawText = response.rawText;

  // Truncation-only sizing ladder. Parseable wrong-shape replies fail fast.
  const truncated = (r: any) => r.finishReason === 'MAX_TOKENS' || r.finishReason === 'length' || r.finishReason === 'stream-died' || r.json == null;
  const caps = [Math.min(budgetCap, baseCap * 2), budgetCap];
  for (const cap of caps) {
    if (!truncated(response)) break;
    if (!consumeRecovery()) break;
    const retryReq = { ...request, maxOutputTokens: cap, label: `Structure Pass (Retry ${attempts + 1})` };
    const retryResponse = await LLMAdapter.execute(retryReq, streamOpts(retryReq.label));
    attempts++;
    if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: retryReq.label, rawText: retryResponse.rawText, reasoningText: retryResponse.reasoningText, finishReason: retryResponse.finishReason, usage: retryResponse.usage, complete: true });
    totalUsage.inputTokens += retryResponse.usage.inputTokens;
    totalUsage.outputTokens += retryResponse.usage.outputTokens;
    totalUsage.cachedTokens = (totalUsage.cachedTokens || 0) + (retryResponse.usage.cachedTokens || 0);
    response = retryResponse;
    data = unwrapStructureData(retryResponse.json);
    finalFinishReason = retryResponse.finishReason;
    finalRawText = retryResponse.rawText;
  }
  let repaired = false;
  if (response.json == null && finalRawText.includes('{')) {
    const recovered = repairTruncatedJson(finalRawText);
    const unwrapped = unwrapStructureData(recovered);
    if (Array.isArray(unwrapped?.questions) && unwrapped.questions.length > 0) {
      data = unwrapped;
      repaired = true;
    }
  }

  let questions = data && Array.isArray(data.questions) ? data.questions : [];

  if (questions.length === 0 && response.json == null && (finalFinishReason === 'length' || finalFinishReason === 'MAX_TOKENS' || finalFinishReason === 'stream-died') && finalRawText.includes('{')) {
    const chunked = await runChunkedStructurePass(params, lasText, manifestEntries);
    chunked.attempts = attempts + (chunked.attempts || 0);
    chunked.usage.inputTokens += totalUsage.inputTokens;
    chunked.usage.outputTokens += totalUsage.outputTokens;
    chunked.usage.cachedTokens = (chunked.usage.cachedTokens || 0) + (totalUsage.cachedTokens || 0);
    return chunked;
  }
  if (questions.length === 0 && response.json == null && !finalRawText.includes('{') && consumeRecovery()) {
    const enforcedReq = { ...request, maxOutputTokens: budgetCap, system: `${request.system}\n\nYour previous reply was prose, which is invalid. Output JSON only — first character { — no reasoning text in the reply.`, label: 'Structure Pass (Format Retry)' };
    const enforced = await LLMAdapter.execute(enforcedReq, streamOpts(enforcedReq.label));
    attempts++;
    if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: enforcedReq.label, rawText: enforced.rawText, reasoningText: enforced.reasoningText, finishReason: enforced.finishReason, usage: enforced.usage, complete: true });
    totalUsage.inputTokens += enforced.usage.inputTokens;
    totalUsage.outputTokens += enforced.usage.outputTokens;
    totalUsage.cachedTokens = (totalUsage.cachedTokens || 0) + (enforced.usage.cachedTokens || 0);
    response = enforced;
    finalRawText = enforced.rawText;
    finalFinishReason = enforced.finishReason;
    data = unwrapStructureData(enforced.json);
    questions = Array.isArray(data?.questions) ? data.questions : [];
    if (!questions.length && enforced.json == null && finalRawText.includes('{')) {
      const recovered = unwrapStructureData(repairTruncatedJson(finalRawText));
      if (Array.isArray(recovered?.questions) && recovered.questions.length) { data = recovered; questions = recovered.questions; repaired = true; }
    }
  }

  if (questions.length === 0) {
    throw buildStructureShapeError({
      finishReason: finalFinishReason,
      rawText: finalRawText,
      jsonNull: response.json === null || response.json === undefined,
      attempts,
      usage: totalUsage,
    });
  }

  const needsContinuation = repaired || finalFinishReason === 'length' || finalFinishReason === 'MAX_TOKENS' || finalFinishReason === 'stream-died';
  if (needsContinuation && params.journalEnabled && params.journalKey) {
    // Route a recovered truncated prefix through the same journal continuation path on LAS after coverage.
    return runStructurePass(params);
  }
  let coverageCompleted = false;
  if (needsContinuation && !params.journalEnabled && questions.length > 0) {
    let covered = coveredUntilLine(questions);
    for (let round = 0; round < 2; round++) {
      if (round > 0 && !consumeRecovery()) break;
      const tail = sourceLines.filter(line => Number(line.id.replace(/\D/g, '')) >= Math.max(1, covered - 1));
      if (!tail.length) break;
      const lastNos: Record<string, number> = {};
      questions.forEach((q: any) => { const id = q.sectionId || 'default'; lastNos[id] = Math.max(lastNos[id] || 0, Number(q.no) || 0); });
      const memory = `SESSION MEMORY (already established — do NOT repeat these): meta=${JSON.stringify(data.meta || {})}; sections=${JSON.stringify((data.sections || []).map((s: any) => ({ id: s.id, title: String(s.title || '').slice(0,40) })))}; lastQuestionNoBySection=${JSON.stringify(lastNos)}; coveredSourceLines=1..${covered}. Reuse these section ids; continue question numbering after the given numbers; output ONLY questions/sections for the source below.`.slice(0,1100);
      const lineText = tail.map(line => `[${line.id}] ${line.text}`).join('\n');
      const basePrefix = request.text.split('\n\nSOURCE:')[0];
      const configEnd = basePrefix.indexOf('\n');
      const withMemory = configEnd >= 0 ? `${basePrefix.slice(0, configEnd)}\n${memory}${basePrefix.slice(configEnd)}` : `${basePrefix}\n${memory}`;
      const prompt = `${withMemory}\n\nSOURCE (continuation):\n${lineText}${!isGemini ? `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA)}` : ''}`;
      const continuationReq: LLMRequest = { ...request, text: prompt, label: `Structure Pass (Continuation ${round + 1})`, maxOutputTokens: budgetCap };
      const cont = await LLMAdapter.execute(continuationReq, streamOpts(continuationReq.label));
      attempts++; totalUsage.inputTokens += cont.usage.inputTokens; totalUsage.outputTokens += cont.usage.outputTokens; totalUsage.cachedTokens = (totalUsage.cachedTokens || 0) + (cont.usage.cachedTokens || 0);
      let more: any = unwrapStructureData(cont.json);
      if (!Array.isArray(more?.questions) && cont.json == null) more = unwrapStructureData(repairTruncatedJson(cont.rawText));
      const existing = new Set(questions.map((q: any) => `${q.sectionId || ''}:${q.no}`));
      const additions = (more?.questions || []).filter((q: any) => { const key = `${q.sectionId || ''}:${q.no}`; if (existing.has(key)) return false; existing.add(key); return true; });
      if (!additions.length) break;
      questions.push(...additions); data.sections = [...(data.sections || []), ...(more.sections || [])]; covered = coveredUntilLine(questions); coverageCompleted = true;
      const lastSourceLine = Math.max(0, ...sourceLines.map(line => Number(line.id.replace(/\D/g, '')) || 0));
      if (covered >= lastSourceLine) break;
    }
  }

  // Token-Thrift Acceptance Check (§12 Test 1): expect output ≤ 12% of input
  const thriftRatio = totalUsage.inputTokens > 0
    ? (totalUsage.outputTokens / totalUsage.inputTokens) * 100
    : 0;
  console.log(
    `[Token-Thrift Audit] Structure Pass: in=${totalUsage.inputTokens}, out=${totalUsage.outputTokens} (ratio: ${thriftRatio.toFixed(1)}%, target: <=12%)`
  );

  if (params.journalEnabled && params.journalKey && !repaired) await markJournalComplete(params.journalKey);
  return {
    sections: Array.isArray(data.sections) ? data.sections : [],
    rawQuestions: questions,
    meta: data.meta || {},
    usage: totalUsage,
    rawText: finalRawText,
    label: response.label || request.label,
    attempts,
    finishReason: finalFinishReason,
    flags: [...(repaired ? [{ code: 'TRUNCATED_JSON_REPAIRED', message: `Recovered ${questions.length} questions from truncated JSON.` }] : []), ...(needsContinuation && !coverageCompleted ? [{ code: 'PARTIAL_COVERAGE', message: 'No additional questions were recovered during continuation.' }] : [])],
    jsonNull: (response.json === null || response.json === undefined) && !coverageCompleted,
  };
}

/** Sequential 80-line chunk fallback with overlap, session context, and bounded bisection. */
async function runChunkedStructurePass(params: any, _fullLas: string, manifest: any[]): Promise<StructurePassResult> {
  const { sourceLines, languageHint, latexEnabled, providerConfig } = params;
  const isGemini = providerConfig?.kind === 'gemini';
  const budgetCap = params.maxBudgetTokens || 16384;
  const chunkSize = 80, overlap = 2;
  const mergedSections: any[] = [], mergedQuestions: any[] = [];
  let mergedMeta: any = {}; let totalInTokens = 0, totalOutTokens = 0, totalCachedTokens = 0, attempts = 0;
  let lastFinishReason: string | undefined, lastRawText = '', lastJsonNull = false;
  let capped = false;
  let repairedPartial = false;
  const sessionBrief = () => {
    const lastBySection: Record<string, number> = {};
    for (const q of mergedQuestions) { const id = q.sectionId || 'default'; lastBySection[id] = Math.max(lastBySection[id] || 0, Number(q.no) || 0); }
    const covered = coveredUntilLine(mergedQuestions);
    return `SESSION MEMORY (already established — do NOT repeat these): meta=${JSON.stringify(mergedMeta)}; sections=${JSON.stringify(mergedSections.map(s => ({ id: s.id, title: String(s.title || '').slice(0,40) })))}; lastQuestionNoBySection=${JSON.stringify(lastBySection)}; coveredSourceLines=1..${covered}. Reuse these section ids; continue question numbering after the given numbers; output ONLY questions/sections for the source below.`.slice(0, 1100);
  };
  const recordResponse = async (resp: any, label: string) => {
    attempts++;
    totalInTokens += resp.usage.inputTokens; totalOutTokens += resp.usage.outputTokens; totalCachedTokens += resp.usage.cachedTokens || 0;
    lastFinishReason = resp.finishReason; lastRawText = resp.rawText; lastJsonNull = resp.json == null;
    if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: resp.rawText, reasoningText: resp.reasoningText, finishReason: resp.finishReason, usage: resp.usage, complete: true });
  };
  const processChunk = async (lines: SourceLine[], label: string, depth: number): Promise<void> => {
    if (capped) return;
    if (depth > 0) {
      if (!params.recoveryBudget || params.recoveryBudget.count >= 8) { capped = true; return; }
      params.recoveryBudget.count++;
    }
    const las = lines.map(l => `[${l.id}] ${l.text}`).join('\n');
    const start = Number(lines[0]?.id.replace(/\D/g,'')), end = Number(lines[lines.length-1]?.id.replace(/\D/g,''));
    const chunkManifest = manifest.filter((m:any) => { const n = Number(m.nearLine); return n >= start && n <= end; });
    const base = `CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint: languageHint || null })}\n${mergedQuestions.length ? sessionBrief() + '\n' : ''}\nIMAGE MANIFEST:\n${JSON.stringify(chunkManifest)}\n\nSOURCE CHUNK:\n${las}`;
    const schemaBlock = !isGemini ? `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA)}` : '';
    const inTokens = Math.ceil(lines.reduce((n,l)=>n+l.text.length,0) / 3.2);
    const est = Math.max(inTokens * .25, lines.length * 14);
    const cap = Math.min(budgetCap, Math.max(4096, Math.ceil(est * 1.25)));
    const req: LLMRequest = { role: 'fast', system: T1_STRUCTURE_SYSTEM, text: base + schemaBlock, jsonSchema: isGemini ? T1_GEMINI_SCHEMA : undefined, maxOutputTokens: cap, label, providerConfig };
    let liveOutput = '', liveReasoning = '', lastJournalWrite = 0;
    const opts = { onDelta: (channel: 'output'|'reasoning', fullText: string) => {
      if (channel === 'output') liveOutput = fullText; else liveReasoning = fullText;
      params.onLiveText?.(label, channel, fullText);
      if (params.journalEnabled && params.journalKey && Date.now() - lastJournalWrite >= 3000) {
        lastJournalWrite = Date.now();
        void appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: liveOutput, reasoningText: liveReasoning, complete: false });
      }
    }, onInfo: (note: string) => params.onLiveText?.(label, 'info', note), salvagePartial: true };
    const resp = await LLMAdapter.execute(req, opts); await recordResponse(resp, label);
    let data: any = unwrapStructureData(resp.json);
    const trunc = resp.finishReason === 'length' || resp.finishReason === 'MAX_TOKENS' || resp.finishReason === 'stream-died' || resp.json == null;
    let repaired = false;
    if (trunc && (!Array.isArray(data?.questions) || !data.questions.length) && resp.rawText.includes('{')) {
      const recovered = unwrapStructureData(repairTruncatedJson(resp.rawText));
      if (Array.isArray(recovered?.questions) && recovered.questions.length > 0) {
        data = recovered;
        repaired = true;
      }
    }
    const chunkQuestions = Array.isArray(data?.questions) ? data.questions : [];
    if (trunc && chunkQuestions.length === 0) {
      if (depth < 3 && lines.length >= 20) {
        const mid = Math.ceil(lines.length / 2);
        await processChunk(lines.slice(0, mid), `${label} (bisect A)`, depth + 1);
        await processChunk(lines.slice(Math.max(0, mid - 2)), `${label} (bisect B)`, depth + 1);
        return;
      }
      throw buildStructureShapeError({ finishReason: resp.finishReason, rawText: resp.rawText, jsonNull: resp.json == null, attempts, usage: { inputTokens: totalInTokens, outputTokens: totalOutTokens, cachedTokens: totalCachedTokens } });
    }
    if (trunc && repaired) repairedPartial = true;
    if (chunkQuestions.length) mergedQuestions.push(...chunkQuestions);
    if (Array.isArray(data?.sections)) mergedSections.push(...data.sections);
    if (data?.meta && !Object.keys(mergedMeta).length) mergedMeta = data.meta;
  };
  for (let i = 0, n = 0; i < sourceLines.length; i += chunkSize - overlap, n++) {
    await processChunk(sourceLines.slice(i, i + chunkSize), `Structure Pass (Chunk ${n + 1})`, 0);
    if (capped) break;
  }
  const seen = new Set<string>();
  const questions = mergedQuestions.filter(q => { const key = `${q.sectionId || ''}:${q.no}`; if (seen.has(key)) return false; seen.add(key); return true; });
  if (!questions.length) throw buildStructureShapeError({ finishReason: lastFinishReason, rawText: lastRawText, jsonNull: lastJsonNull, attempts, usage: { inputTokens: totalInTokens, outputTokens: totalOutTokens, cachedTokens: totalCachedTokens } });
  if (!capped && !lastJsonNull && params.journalEnabled && params.journalKey) await markJournalComplete(params.journalKey);
  return { sections: mergedSections, rawQuestions: questions, meta: mergedMeta, usage: { inputTokens: totalInTokens, outputTokens: totalOutTokens, cachedTokens: totalCachedTokens }, rawText: 'Merged from chunks', attempts, finishReason: lastFinishReason, flags: [...(repairedPartial ? [{ code: 'TRUNCATED_JSON_REPAIRED', message: `Recovered ${questions.length} questions from truncated JSON.` }] : []), ...(capped ? [{ code: 'PARTIAL_COVERAGE', message: 'Recovery call limit reached; returning recovered questions only.' }] : [])], jsonNull: capped || lastJsonNull };
}
