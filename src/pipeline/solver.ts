/**
 * AI Solver Engine
 * Solves exam questions with verified, concise solutions in a single batched call or per-question.
 * Tagged with source: 'ai'
 */
import { LLMRequest, Question, UsageRecord } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T6_SOLVER_SYSTEM } from './prompts';

export interface SolverResult {
  updatedQuestions: Question[];
  solvedCount: number;
  usageRecord: UsageRecord;
}

export async function solveQuestionsWithAI(params: {
  questions: Question[];
  questionIdsToSolve?: string[];
  providerConfig: any;
}): Promise<SolverResult> {
  const { questions, questionIdsToSolve, providerConfig } = params;

  // Filter questions to solve (either specified IDs, or all questions lacking an answer)
  const targetQuestions = questions.filter(q => {
    if (questionIdsToSolve && questionIdsToSolve.length > 0) {
      return questionIdsToSolve.includes(q.id);
    }
    return !q.answer || !q.answer.text;
  });

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

  const promptText = `Solve these ${items.length} questions. Output JSON array of {"id": string, "answer": string}:\n\n${JSON.stringify(items, null, 2)}`;

  const request: LLMRequest = {
    role: 'standard',
    system: T6_SOLVER_SYSTEM,
    text: promptText,
    maxOutputTokens: Math.min(4096, Math.max(500, items.length * 80)),
    label: `AI Solver (${items.length} questions)`,
    providerConfig,
  };

  const response = await LLMAdapter.execute(request);
  const answers: any[] = Array.isArray(response.json) ? response.json : [];
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
        answer: {
          text: answerMap.get(q.id)!,
          source: 'ai' as const,
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
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cachedTokens: response.usage.cachedTokens,
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
}): Promise<{ answerText: string; usageRecord: UsageRecord }> {
  const { question, providerConfig } = params;

  const res = await solveQuestionsWithAI({
    questions: [question],
    questionIdsToSolve: [question.id],
    providerConfig,
  });

  const ans = res.updatedQuestions[0]?.answer?.text || '';
  return {
    answerText: ans,
    usageRecord: res.usageRecord,
  };
}
