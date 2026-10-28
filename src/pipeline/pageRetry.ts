import type { AppSettings, ExamDoc, Flag, SpinePageReadRecord, SpinePageReadStatus, UsageRecord } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { appendUsageRecord, getPipelineCache, getReviewImageBlob, saveExamDoc, setPipelineCache } from '../store';
import { calculateActualCost } from '../utils/budget';
import { validateAndFixDuplicateImageIds } from './assemble';
import { computeDefects, type Defect } from './defects';
import {
  PAGE_RETRY_ALLOWANCE,
  assembleReadProposal,
  buildReadChunks,
  deserializeReadProposal,
  mergePageProposals,
  openQuestionAfterPage,
  pageReadFailedMessage,
  readSinglePageWithFallback,
  serializeReadProposal,
  type OpenQuestionCarryOver,
  type PageReadCache,
  type PageReadCacheEntry,
  type ReadBudget,
  type ReadCaller,
  type ReadProposal,
} from './globalRead';
import { assignImagesExact, enforceSingleImageOwnership } from './imageOwnership';
import { prepareReviewDocument } from './reviewIntegrity';
import { effectiveReadFormat } from './readFormat';
import { localProviderFor } from './localProvider';
import { applyCorrections, buildLoopPagePrompt, buildLoopPages, errorMessage, pageFromResponse, projectAuthoredDocument, LOOP_READ_SYSTEM } from './localLoop';
import { loopFlags } from './loopFlags';

const lineNo = (id: string) => Number(String(id || '').replace(/\D/g, ''));

function providerFor(settings: AppSettings, role: 'read' | 'cloud') {
  const selection = role === 'read'
    ? settings.roleMapping.read || settings.roleMapping.fast
    : settings.roleMapping.cloud || settings.roleMapping.escalation;
  const provider = settings.providers.find(p => p.id === selection.providerId) || settings.providers[0];
  return provider ? { ...provider, model: selection.model } : undefined;
}

function forcedOff<T extends { disableReasoning?: boolean; extraBodyJson?: string }>(provider: T): T {
  let extra: Record<string, unknown> = {};
  try { extra = provider.extraBodyJson ? JSON.parse(provider.extraBodyJson) : {}; } catch { extra = {}; }
  for (const key of ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking', 'chat_template_kwargs']) delete extra[key];
  return { ...provider, disableReasoning: true, extraBodyJson: Object.keys(extra).length ? JSON.stringify(extra) : '' };
}

function makeUsageRecord(role: UsageRecord['role'], provider: any, usage: any, label: string): UsageRecord {
  return {
    ts: new Date().toISOString(),
    role,
    provider: provider?.name || 'unconfigured',
    model: provider?.model || 'none',
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    costUsd: calculateActualCost(usage?.inputTokens || 0, usage?.outputTokens || 0, provider?.model || '', {}),
    label,
  };
}

function defectFlags(defects: Defect[]): Flag[] {
  return defects.map((defect, i): Flag => {
    const qid = defect.questionIds[0];
    const imageId = defect.kind === 'image-unplaced' ? defect.id.replace(/^image-unplaced:/, '') : undefined;
    const map: Record<string, string> = {
      'hollow-question': 'STEM_HOLLOW',
      'options-missing': 'OPTIONS_MISSING',
      'points-unresolved': 'POINTS_UNPRICED',
      'points-sum': 'POINTS_MISMATCH',
      'image-ownership': 'IMAGE_ORDER_SUSPECT',
      'image-unplaced': 'IMAGE_UNPLACED',
    };
    return {
      id: `attention_survivor_${i + 1}`,
      severity: defect.kind === 'hollow-question' || defect.kind === 'options-missing' ? 'error' : 'warn',
      code: map[defect.kind] || 'PARSE_CHECK_SURVIVOR',
      message: defect.detail,
      ...(qid ? { questionId: qid } : {}),
      ...(imageId ? { imageId } : {}),
      rootCauseId: defect.id,
    };
  });
}

/**
 * Re-run ONLY page `page`'s Global Read on demand (local `read` twice -> `cloud` once).
 * Never re-reads any other page. If successful, merges the page into the document,
 * re-runs `assignImagesExact` + `computeDefects`, clears the failed-page attention item,
 * and saves the updated `ExamDoc`.
 */
export async function retryFailedPage(
  doc: ExamDoc,
  page: number,
  settings: AppSettings,
  options?: {
    onProgress?: (message: string) => void;
    caller?: ReadCaller;
    cloudCaller?: ReadCaller;
    persist?: boolean;
  },
): Promise<{
  doc: ExamDoc;
  status: SpinePageReadStatus;
  questionsAdded: number;
  message: string;
}> {
  // #46 loop documents retry with the local generative reader only. No cloud fallback exists here.
  if (doc.loop) {
    const lines = doc.source?.lines || [];
    const chunk = buildLoopPages(lines).find(c => c.page === page);
    if (!chunk) return { doc, status: 'failed', questionsAdded: 0, message: `Page ${page} has no extracted lines.` };
    const provider = localProviderFor(settings, 'read');
    const before = doc.questions.length;
    try {
      options?.onProgress?.(`Reading page ${page} with the local model…`);
      const response = options?.caller
        ? await options.caller({ system: LOOP_READ_SYSTEM, text: buildLoopPagePrompt(chunk, doc.images), label: `Retry page ${page}`, maxOutputTokens: Math.max(16384, settings.budget.maxOutputTokens || 0) } as any)
        : provider ? await LLMAdapter.execute({ role: 'read', system: LOOP_READ_SYSTEM, text: buildLoopPagePrompt(chunk, doc.images), label: `Retry page ${page}`, maxOutputTokens: Math.max(16384, settings.budget.maxOutputTokens || 0), providerConfig: { ...provider, disableReasoning: true } }, { detectCountingLoop: true, salvagePartial: true })
        : undefined;
      if (!response) throw new Error('no local read model configured');
      const parsed = pageFromResponse({ rawText: response.rawText, json: (response as any).json, usage: response.usage }, page);
      const corrections = parsed.document.questions.map(q => ({ action: (doc.loop!.document.questions.some(old => old.number === q.number) ? 'replace' : 'insert') as 'replace' | 'insert', questionNumber: q.number, question: q }));
      const applied = applyCorrections(doc.loop!.document, corrections);
      const loop = structuredClone(doc.loop!);
      loop.document = applied.document;
      loop.notes.push(`Page ${page} retried locally: ${applied.applied} correction(s) applied. ${parsed.receipt.notes.join(' ')}`);
      const pageRow = loop.pages.find(p => p.page === page);
      if (pageRow) Object.assign(pageRow, parsed.receipt, { status: parsed.receipt.status === 'empty' ? 'failed' : parsed.receipt.status });
      else loop.pages.push(parsed.receipt);
      const projected = projectAuthoredDocument(loop.document);
      const next: ExamDoc = { ...doc, questions: projected.questions, sections: projected.sections, meta: { ...doc.meta, ...projected.meta }, loop };
      next.flags = loopFlags(loop, next);
      if (options?.persist !== false) await saveExamDoc(next);
      return { doc: next, status: parsed.receipt.status === 'empty' ? 'failed' : 'local ok', questionsAdded: Math.max(0, next.questions.length - before), message: `Page ${page} retried locally; ${applied.applied} correction(s) applied.` };
    } catch (error) {
      const message = `Page ${page} local retry skipped — ${errorMessage(error)}. The saved document is unchanged.`;
      const loop = structuredClone(doc.loop); loop.notes.push(message);
      const next = { ...doc, loop, flags: loopFlags(loop, doc) };
      if (options?.persist !== false) try { await saveExamDoc(next); } catch { /* keep in memory */ }
      return { doc: next, status: 'failed', questionsAdded: 0, message };
    }
  }
  const lines = doc.source?.lines || [];
  const chunks = buildReadChunks(lines);
  const targetIdx = chunks.findIndex(c => c.page === page);
  if (targetIdx < 0) {
    return { doc, status: 'failed', questionsAdded: 0, message: `Page ${page} has no extracted lines.` };
  }
  const targetChunk = chunks[targetIdx];

  const readProviderRaw = providerFor(settings, 'read');
  const readProvider = readProviderRaw ? forcedOff(readProviderRaw) : undefined;
  const cloudProviderRaw = providerFor(settings, 'cloud');
  const cloudProvider = cloudProviderRaw ? forcedOff(cloudProviderRaw) : undefined;

  const caller: ReadCaller | undefined = options?.caller ?? (readProvider
    ? async req => {
        const r = await LLMAdapter.execute({
          role: 'read',
          system: req.system,
          text: req.text,
          label: req.label,
          maxOutputTokens: req.maxOutputTokens,
          providerConfig: readProvider,
        });
        return { rawText: r.rawText, json: r.json, usage: r.usage };
      }
    : undefined);

  const cloudCaller: ReadCaller | undefined = options?.cloudCaller ?? (cloudProvider
    ? async req => {
        const r = await LLMAdapter.execute({
          role: 'cloud',
          system: req.system,
          text: req.text,
          label: req.label,
          maxOutputTokens: req.maxOutputTokens,
          providerConfig: cloudProvider,
        });
        return { rawText: r.rawText, json: r.json, usage: r.usage };
      }
    : undefined);

  // Write-only cache on explicit retry so a manual [Retry page] always tries fresh, then caches on success.
  const writeOnlyCache: PageReadCache = {
    get: () => undefined,
    set: async (key, value: PageReadCacheEntry) => {
      if (settings.thrift?.cacheEnabled) {
        try { await setPipelineCache(key, value); } catch { /* ignore offline storage absence */ }
      }
    },
  };

  // Recover existing per-page proposals from doc.spine without re-reading any other page.
  const storedPageProposals: Record<string, string> = { ...(doc.spine?.classify?.pageProposals || {}) };
  const priorProposalsByPage = new Map<number, ReadProposal>();
  for (const c of chunks) {
    if (c.page === page) continue;
    const raw = storedPageProposals[String(c.page)];
    if (raw) {
      const parsed = deserializeReadProposal(raw);
      if (parsed) priorProposalsByPage.set(c.page, parsed);
    }
  }

  let openQuestion: OpenQuestionCarryOver | undefined;
  for (let i = 0; i < targetIdx; i++) {
    const prevChunk = chunks[i];
    const prevProp = priorProposalsByPage.get(prevChunk.page);
    openQuestion = prevProp
      ? openQuestionAfterPage(prevProp, prevChunk.owned, lines, openQuestion)
      : undefined;
  }

  options?.onProgress?.(`Retrying page ${page}/${chunks.length}…`);
  // #41: a teacher's [Retry page] always gets a fresh page allowance, whatever the original run spent.
  const retryBudget: ReadBudget = { calls: 0, maxCalls: PAGE_RETRY_ALLOWANCE };
  const readRes = await readSinglePageWithFallback({
    chunk: targetChunk,
    totalPages: chunks.length,
    allLines: lines,
    openQuestion,
    images: doc.images,
    caller,
    cloudCaller,
    model: readProvider?.model,
    format: effectiveReadFormat(settings),
    pageCache: writeOnlyCache,
    budget: retryBudget,
    allowKeyOnlyPage: chunks.length > 1 && (doc.questions?.length || 0) > 0,
  });

  const newUsage: UsageRecord[] = [...(doc.usage || [])];
  if (readRes.localCalls) {
    const rec = makeUsageRecord('read', readProvider, readRes.usage, `Retry Page ${page} (${readRes.localCalls} call${readRes.localCalls === 1 ? '' : 's'})`);
    newUsage.push(rec);
    try { appendUsageRecord(rec); } catch { /* ignore */ }
  }
  if (readRes.cloudCalls) {
    const rec = makeUsageRecord('cloud', cloudProvider, readRes.cloudUsage, `Cloud · Retry Page ${page}`);
    newUsage.push(rec);
    try { appendUsageRecord(rec); } catch { /* ignore */ }
  }

  const prevPages = doc.spine?.classify?.pages || chunks.map(c => ({
    page: c.page,
    status: (c.page === page ? 'failed' : 'local ok') as SpinePageReadStatus,
    calls: 1,
    questions: (doc.questions || []).filter(q => q.spans?.some((s: any) => Array.isArray(s) && c.owned.some(l => lineNo(l.id) === s[0]))).length,
  }));

  const updatedPageRecord: SpinePageReadRecord = {
    page,
    status: readRes.status,
    format: effectiveReadFormat(settings),
    outputTokens: readRes.usage.outputTokens + readRes.cloudUsage.outputTokens,
    calls: readRes.localCalls + readRes.cloudCalls,
    cloudCalls: readRes.cloudCalls,
    ...(readRes.cloudCalls ? { cloudAttempts: readRes.cloudAttempts } : {}),
    ...(readRes.cloudError ? { cloudError: readRes.cloudError } : {}),
    runningCalls: (doc.spine?.classify?.calls || 0) + (doc.spine?.classify?.cloudCalls || 0) + readRes.localCalls + readRes.cloudCalls,
    localComplaints: readRes.localComplaints,
    questions: readRes.proposal?.questions.length || 0,
    ...(readRes.complaints.length ? { reason: readRes.complaints.join('; ') } : {}),
  };
  const nextPageRecords: SpinePageReadRecord[] = prevPages.some(p => p.page === page)
    ? prevPages.map(p => (p.page === page ? updatedPageRecord : p))
    : [...prevPages, updatedPageRecord].sort((a, b) => a.page - b.page);

  if (readRes.status === 'failed' || !readRes.proposal) {
    const stillFailedDoc: ExamDoc = {
      ...doc,
      usage: newUsage,
      ...(doc.spine
        ? {
            spine: {
              ...doc.spine,
              classify: {
                ...doc.spine.classify,
                calls: (doc.spine.classify.calls || 0) + readRes.localCalls,
                cloudCalls: (doc.spine.classify.cloudCalls || 0) + readRes.cloudCalls,
                pages: nextPageRecords,
              },
            },
          }
        : {}),
    };
    if (options?.persist !== false) {
      try { await saveExamDoc(stillFailedDoc); } catch { /* ignore */ }
    }
    return {
      doc: stillFailedDoc,
      status: 'failed',
      questionsAdded: 0,
      message: `Page ${page} still couldn't be read${readRes.complaints[0] ? ` (${readRes.complaints[0]})` : ''}.`,
    };
  }

  let questions = doc.questions || [];
  let sections = doc.sections || [];
  let keyLineNos = doc.source?.keyTerritoryLineNos || [];
  let accountedLineNos: number[] = [];
  let nextPageProposals = { ...storedPageProposals, [String(page)]: serializeReadProposal(readRes.proposal) };

  if (priorProposalsByPage.size > 0 || chunks.length === 1) {
    const entries = chunks.map(c => ({
      page: c.page,
      owned: c.owned,
      proposal: c.page === page ? readRes.proposal : priorProposalsByPage.get(c.page),
    }));
    const merged = mergePageProposals(entries, lines);
    nextPageProposals = merged.pageProposals;
    if (merged.proposal) {
      const assembled = assembleReadProposal(merged.proposal, lines);
      // Preserve existing answers/user-edited question metadata by printed question number on unchanged pages.
      const prevByNo = new Map((doc.questions || []).map(q => [q.no, q]));
      const pageLineSet = new Set(targetChunk.owned.map(l => lineNo(l.id)));
      questions = assembled.questions.map(q => {
        const onRetriedPage = q.spans.some((s: any) => Array.isArray(s) && pageLineSet.has(s[0]));
        const prev = prevByNo.get(q.no);
        if (!onRetriedPage && prev?.answer && !q.answer) {
          return { ...q, answer: prev.answer };
        }
        return q;
      });
      sections = assembled.sections;
      keyLineNos = assembled.keyLineNos;
      accountedLineNos = [...merged.proposal.labels.keys()].filter(
        n => !questions.some(q => q.spans.some((s: any) => Array.isArray(s) && n >= s[0] && n <= s[1])),
      );
    }
  } else {
    // Fallback for hand-constructed ExamDocs without stored pageProposals: splice assembled page questions in order.
    const pageAssembled = assembleReadProposal(readRes.proposal, lines);
    const pageLineSet = new Set(targetChunk.owned.map(l => lineNo(l.id)));
    const keptQuestions = (doc.questions || []).filter(
      q => !q.spans.some((s: any) => Array.isArray(s) && pageLineSet.has(s[0])),
    );
    questions = [...keptQuestions, ...pageAssembled.questions].sort((a, b) => {
      const sa = Array.isArray(a.spans[0]) ? a.spans[0][0] : 0;
      const sb = Array.isArray(b.spans[0]) ? b.spans[0][0] : 0;
      return sa - sb || a.no - b.no;
    });
    if (pageAssembled.sections.length) {
      const existingIds = new Set(sections.map(s => s.id));
      const added = pageAssembled.sections.map((s, idx) => ({
        ...s,
        id: existingIds.has(s.id) ? `${s.id}_p${page}` : s.id,
        index: sections.length + idx + 1,
      }));
      sections = [...sections, ...added];
    }
    keyLineNos = [...new Set([...keyLineNos, ...pageAssembled.keyLineNos])];
  }

  const remainingFailedPages = nextPageRecords.filter(p => p.status === 'failed').map(p => p.page);
  let updatedImages: ExamDoc['images'] = (doc.images || []).map(img => ({ ...img, ...(img.label ? { label: { ...img.label } } : {}) }));
  try {
    const assigned = await assignImagesExact({
      questions,
      images: updatedImages,
      sourceLines: lines,
      failedPages: remainingFailedPages,
    });
    questions = assigned.questions;
    updatedImages = assigned.images;
  } catch { /* leave images as-is */ }

  const ownMax = Math.max(0, ...questions.map(q => q.no));
  const expectedNumbers = Array.from({ length: ownMax }, (_, i) => i + 1);
  const defects = computeDefects({
    doc: { questions, sections, images: updatedImages, totalPoints: doc.meta?.totalPoints },
    lines,
    expectedNumbers,
    keyLineNos,
    accountedLineNos,
  });
  const orphanLineNos = [...new Set(defects.filter(d => d.kind === 'unaccounted-lines').flatMap(d => d.lineIds))].sort((a, b) => a - b);

  const metaFlags = (doc.flags || []).filter(f => f.code === 'META_MISSING');
  const pageReadFailedFlags: Flag[] = remainingFailedPages.map(fp => ({
    id: `page_read_failed_${fp}`,
    code: 'PAGE_READ_FAILED',
    severity: 'error',
    rootCauseId: `page_read_failed_${fp}`,
    message: pageReadFailedMessage(fp, nextPageRecords.find(p => p.page === fp)?.reason),
  }));
  const rebuiltFlags: Flag[] = [...defectFlags(defects), ...metaFlags, ...pageReadFailedFlags];
  const hasErrorFlag = rebuiltFlags.some(f => f.severity === 'error');
  if (hasErrorFlag) {
    rebuiltFlags.push({
      id: 'partial_exam',
      code: 'PARTIAL_EXAM',
      severity: 'error',
      message: 'Some checked defects remain; the document is saved as partial.',
    });
  }

  const questionsAdded = Math.max(0, questions.length - (doc.questions?.length || 0));
  let nextDoc: ExamDoc = {
    ...doc,
    questions,
    sections,
    images: updatedImages,
    partial: hasErrorFlag || undefined,
    flags: rebuiltFlags,
    usage: newUsage,
    source: {
      ...doc.source,
      expectedQuestionNos: expectedNumbers,
      keyTerritoryLineNos: keyLineNos,
      orphanLineNos,
    },
    spine: {
      classify: {
        status: remainingFailedPages.length ? 'partial' : 'completed',
        provider: doc.spine?.classify?.provider || readProvider?.id,
        model: doc.spine?.classify?.model || readProvider?.model,
        calls: (doc.spine?.classify?.calls || 0) + readRes.localCalls,
        cloudCalls: (doc.spine?.classify?.cloudCalls || 0) + readRes.cloudCalls,
        labelledLines: doc.spine?.classify?.labelledLines,
        pages: nextPageRecords,
        pageProposals: nextPageProposals,
      },
      repairLoop: doc.spine?.repairLoop || {
        status: 'skipped',
        rounds: 0,
        calls: 0,
        opsAccepted: 0,
        opsRejected: 0,
        escalations: 0,
        defectsRemaining: defects.length,
        remainingKinds: [...new Set(defects.map(d => d.kind))],
      },
      budget: doc.spine?.budget || { calls: readRes.localCalls + readRes.cloudCalls, units: 0, maxCalls: 30, maxUnits: 200 },
    },
  };
  nextDoc = validateAndFixDuplicateImageIds(nextDoc).doc;
  nextDoc = enforceSingleImageOwnership(nextDoc).doc;

  if (options?.persist !== false) {
    try {
      await saveExamDoc(nextDoc);
      nextDoc = await prepareReviewDocument(nextDoc, getReviewImageBlob);
    } catch { /* ignore in headless test environments */ }
  }
  void getPipelineCache;

  return {
    doc: nextDoc,
    status: readRes.status,
    questionsAdded,
    message: `Page ${page} read (${readRes.status}) — ${readRes.proposal.questions.length} question(s) recovered.`,
  };
}
