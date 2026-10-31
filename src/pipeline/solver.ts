/**
 * AI Solver Engine
 * Solves exam questions with verified, concise solutions in a single batched call or per-question.
 * Parses {"items"|"answers"|"results": [...]} envelopes and bare arrays.
 * On json: null (truncation), retries once at 2× cap.
 * Tagged with source: 'ai'
 */
import { LLMRequest, Question, UsageRecord } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T6_SOLVER_SYSTEM } from './prompts';
import { hasSourceKey, migrateLegacyAiAnswers } from '../utils/bankAnswers';
import type { ExamDoc } from '../types';

export interface SolverResult {
  updatedQuestions: Question[];
  solvedCount: number;
  usageRecord: UsageRecord;
}

/**
 * Extract answer array from JSON response — handles envelopes and bare arrays
 */
function extractAnswers(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    if (Array.isArray(json.items)) return json.items;
    if (Array.isArray(json.answers)) return json.answers;
    if (Array.isArray(json.results)) return json.results;
  }
  return [];
}

export async function solveQuestionsWithAI(params: {
  questions: Question[];
  questionIdsToSolve?: string[];
  providerConfig: any;
  maxOutputTokens?: number;
}): Promise<SolverResult> {
  const { questionIdsToSolve, providerConfig, maxOutputTokens } = params;
  // Old stored AI answers are normalized before target selection, so they cannot masquerade as keys.
  const normalized = migrateLegacyAiAnswers({ questions: structuredClone(params.questions) } as ExamDoc).questions;
  const questions = normalized;

  // A source/keyfile/teacher key is not a missing answer. Explicitly targeted re-solves still
  // produce proposals, but never overwrite that authoritative value.
  const targetQuestions = questions.filter(q => questionIdsToSolve?.length
    ? questionIdsToSolve.includes(q.id)
    : !hasSourceKey(q));

  if (targetQuestions.length === 0) {
    return {
      updatedQuestions: questions,
      solvedCount: 0,
      usageRecord: {
        ts: new Date().toISOString(),
        role: 'standard',
        provider: providerConfig.name,
        model: providerConfig.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        label: 'AI Solver (No missing questions)',
      },
    };
  }

  // Format questions payload compactly
  const items = targetQuestions.map(q => ({
    id: q.id,
    label: q.label,
    type: q.type,
    stem: q.stem,
    options: q.options?.map(o => `${o.key}: ${o.text}`).join(' | '),
    points: q.points,
  }));

  const budgetCap = maxOutputTokens || 8192;
  const baseCap = Math.min(budgetCap, Math.min(4096, Math.max(500, items.length * 80)));

  const promptText = `Solve these ${items.length} questions. Output JSON array of {"id": string, "answer": string} (or {"items": [...]}):\n\n${JSON.stringify(items, null, 2)}`;

  const request: LLMRequest = {
    role: 'standard',
    system: T6_SOLVER_SYSTEM,
    text: promptText,
    maxOutputTokens: baseCap,
    label: `AI Solver (${items.length} questions)`,
    providerConfig,
  };

  let response = await LLMAdapter.execute(request);
  let answers = extractAnswers(response.json);
  let totalUsage = { ...response.usage };

  // On json: null (truncation), retry once at 2× cap
  if (response.json === null && baseCap < budgetCap) {
    const retryCap = Math.min(budgetCap, baseCap * 2);
    console.warn(`Solver truncated (json: null, finishReason=${response.finishReason}). Retrying once at 2x cap (${retryCap})...`);
    const retryRequest: LLMRequest = {
      ...request,
      maxOutputTokens: retryCap,
      label: `AI Solver (Retry 2x Cap, ${items.length} questions)`,
    };
    const retryResponse = await LLMAdapter.execute(retryRequest);
    totalUsage.inputTokens += retryResponse.usage.inputTokens;
    totalUsage.outputTokens += retryResponse.usage.outputTokens;
    totalUsage.cachedTokens = (totalUsage.cachedTokens || 0) + (retryResponse.usage.cachedTokens || 0);
    response = retryResponse;
    answers = extractAnswers(response.json);
  }

  const answerMap = new Map<string, string>();
  for (const item of answers) {
    if (item && item.id && item.answer) {
      answerMap.set(item.id, String(item.answer).trim());
    }
  }

  let solvedCount = 0;
  const updatedQuestions = questions.map(q => {
    if (answerMap.has(q.id)) {
      solvedCount++;
      return {
        ...q,
        enrichment: {
          ...(q.enrichment || { source: 'model' as const, verification: 'unjudged' as const }),
          proposedAnswer: { text: answerMap.get(q.id)!, source: 'model' as const },
        },
      };
    }
    return q;
  });

  const usageRecord: UsageRecord = {
    ts: new Date().toISOString(),
    role: 'standard',
    provider: providerConfig.name,
    model: providerConfig.model,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cachedTokens: totalUsage.cachedTokens,
    label: `AI Solver (${solvedCount} questions solved)`,
  };

  return {
    updatedQuestions,
    solvedCount,
    usageRecord,
  };
}

export async function solveSingleQuestionWithAI(params: {
  question: Question;
  providerConfig: any;
  maxOutputTokens?: number;
}): Promise<{ answerText: string; usageRecord: UsageRecord }> {
  const { question, providerConfig, maxOutputTokens } = params;

  const res = await solveQuestionsWithAI({
    questions: [question],
    questionIdsToSolve: [question.id],
    providerConfig,
    maxOutputTokens,
  });

  const ans = res.updatedQuestions[0]?.enrichment?.proposedAnswer?.text || '';
  return {
    answerText: ans,
    usageRecord: res.usageRecord,
  };
}
