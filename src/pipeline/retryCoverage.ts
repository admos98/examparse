import { AppSettings, ExamDoc, UsageRecord } from '../types';
import { runStructurePass } from './structure';
import { assembleAndValidateQuestions, assembleAndValidateSections } from './assemble';
import { computeImageQuestionHints, enumerateExpectedQuestionNos, evaluateCoverage, parsePrintedNumberFromStem } from './quality';
import { sliceSourceSpans } from './assemble';
import { calculateActualCost } from '../utils/budget';
import { sha256 } from '../utils/hash';
import { getPipelineCache, appendUsageRecord, saveExamDoc } from '../store';
import { PARSER_VERSION } from './prompts';

/** Journal-aware, local-only merge recovery for Step 4's Retry missing questions action. */
export async function retryMissingCoverage(
  doc: ExamDoc,
  settings: AppSettings,
  onProgress?: (message: string) => void,
  onLiveText?: (label: string, channel: 'output' | 'reasoning' | 'info', text: string) => void,
  agentBudgetId?: string,
): Promise<ExamDoc> {
  const expected = doc.source.expectedQuestionNos || enumerateExpectedQuestionNos(doc.source.lines).numbers;
  const before = evaluateCoverage(expected, doc.questions, doc.meta.totalPoints);
  if (before.missing.length === 0) return doc;
  const role = settings.roleMapping.fast;
  const provider = settings.providers.find(item => item.id === role.providerId) || settings.providers[0];
  const providerConfig = { ...provider, model: role.model, agentBudgetId };
  const lines = doc.source.lines;
  const linesHash = await sha256(JSON.stringify(lines));
  let journalKey = await getPipelineCache<string>(`journalkey:${doc.fileHash}`);
  if (!journalKey) journalKey = await sha256(`${doc.fileHash}:${linesHash}:${providerConfig.id}:${providerConfig.model}:${PARSER_VERSION}`);

  const existingRawQuestions = doc.questions.map(question => ({
    id: question.id, label: question.label, no: question.no, parentId: question.parentId, sectionId: question.sectionId,
    spans: question.spans, points: question.points, type: question.type,
    options: question.options?.map(option => ({ key: option.key, spans: option.spans })),
    answer: question.answer?.spans ? { spans: question.answer.spans } : undefined,
    tables: question.tables?.map(table => ({ spans: table.spans })),
    rewrites: question.rewrites,
    images: question.images,
    confidence: question.confidence,
    flags: question.flags,
  }));
  const meta = { subject: doc.meta.subject, grade: doc.meta.grade, totalPoints: doc.meta.totalPoints, language: doc.meta.language };
  const result = await runStructurePass({
    sourceLines: lines, images: doc.images, languageHint: doc.meta.language, latexEnabled: settings.thrift.latexNormalization,
    providerConfig, maxBudgetTokens: settings.budget.maxOutputTokens, journalEnabled: settings.thrift.cacheEnabled, journalKey,
    forceSectionMode: true, recoveryOnlyNumbers: before.missing, existingRawQuestions,
    existingSections: doc.sections, existingMeta: meta, onProgress, onLiveText,
  });

  const missingSet = new Set(before.missing);
  const additionRaw = result.rawQuestions.filter(raw => {
    const printedNo = parsePrintedNumberFromStem(sliceSourceSpans(raw.spans || [], lines));
    const qNo = printedNo ?? Number(raw.no);
    if (!missingSet.has(qNo)) return false;
    return !doc.questions.some(question => question.no === qNo);
  });
  const unresolvedImageIds = doc.images.filter(image => !image.dataUrl).map(image => image.id);
  const assembled = assembleAndValidateQuestions(additionRaw, lines, doc.meta.totalPoints, {
    keyTerritoryLineNos: doc.source.keyTerritoryLineNos || enumerateExpectedQuestionNos(lines).keyTerritory.lineNos,
    imageIds: doc.images.map(image => image.id), unresolvedImageIds,
  });
  let additions = assembled.questions;
  const hints = computeImageQuestionHints(doc.images, additions, lines);
  const updatedImages = doc.images.map(image => {
    const hint = hints[image.id];
    if (!hint || image.label?.role === 'decoration' || image.label?.kind === 'decoration') return image;
    return { ...image, label: { ...(image.label || {}), role: image.label?.role || 'stem', questionRef: image.label?.questionRef || hint.questionRef } };
  });
  additions = additions.map(question => ({
    ...question,
    images: [
      ...question.images,
      ...updatedImages.filter(image => image.label?.questionRef === question.label || image.label?.questionRef === String(question.no))
        .filter(image => !question.images.some(ref => ref.imageId === image.id))
        .map(image => ({ imageId: image.id, role: image.label?.role || 'stem', anchorLine: image.anchorLine })),
    ],
  }));
  const mergedQuestions = [...doc.questions, ...additions].sort((a, b) => a.no - b.no || Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)));
  const sectionsResult = assembleAndValidateSections(result.sections.length ? result.sections : doc.sections, lines, mergedQuestions, doc.source.keyTerritoryLineNos || []);
  const coverage = evaluateCoverage(expected, mergedQuestions, doc.meta.totalPoints);
  const retainedFlags = (doc.flags || []).filter(flag => !['COVERAGE_MISSING', 'COVERAGE_DUPLICATE', 'PARTIAL_COVERAGE', 'POINTS_MISMATCH'].includes(flag.code));
  const flags = [...retainedFlags, ...assembled.flags, ...sectionsResult.flags, ...(result.flags || []).filter((flag: any) => !['COVERAGE_MISSING', 'COVERAGE_DUPLICATE', 'POINTS_MISMATCH', 'PARTIAL_COVERAGE'].includes(flag.code))];
  if (coverage.missing.length) flags.push({ id: `flag_coverage_missing_${coverage.missing.join('_')}`, severity: 'error' as const, code: 'COVERAGE_MISSING', message: `Missing printed question numbers: ${coverage.missing.join(', ')}.` });
  if (coverage.missing.length) flags.push({ id: `flag_partial_${coverage.missing.join('_')}`, severity: 'error' as const, code: 'PARTIAL_COVERAGE', message: `Recovery exhausted with ${coverage.missing.length} missing question(s): ${coverage.missing.join(', ')}.` });
  if (coverage.duplicates.length) flags.push({ id: `flag_duplicate_${coverage.duplicates.join('_')}`, severity: 'warn' as const, code: 'COVERAGE_DUPLICATE', message: `Duplicate printed question numbers: ${coverage.duplicates.join(', ')}.` });
  if (!coverage.pointsMatch) flags.push({ id: `flag_points_${coverage.pointDeficit}`, severity: 'warn' as const, code: 'POINTS_MISMATCH', message: `Points sum ${coverage.pointsParsed} does not match header ${doc.meta.totalPoints}; deficit ${coverage.pointDeficit}.` });

  const calls: UsageRecord[] = (result.callUsage || []).map(call => ({
    ts: new Date().toISOString(), role: agentBudgetId ? 'agent' : 'fast', provider: provider.name, model: role.model,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, cachedTokens: call.cachedTokens,
    costUsd: calculateActualCost(call.inputTokens, call.outputTokens, role.model, settings.costTable), label: call.label,
  }));
  for (const call of calls) appendUsageRecord(call);
  const recovered: ExamDoc = {
    ...doc,
    sections: sectionsResult.sections,
    questions: mergedQuestions,
    images: updatedImages,
    flags,
    usage: [...(doc.usage || []), ...calls],
    source: { ...doc.source, expectedQuestionNos: expected, keyTerritoryLineNos: doc.source.keyTerritoryLineNos || [...enumerateExpectedQuestionNos(lines).keyTerritory.lineNos] },
  };
  // Agent persistence is performed once by its CAS/versioned mutation funnel.
  if (!agentBudgetId) await saveExamDoc(recovered);
  return recovered;
}
