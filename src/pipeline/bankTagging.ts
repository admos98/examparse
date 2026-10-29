/** Optional export-time tagging when no audit proposal exists. Never blocks export on a model failure. */
import type { AppSettings, ExamDoc, Question } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { resolveDecisionProvider } from './loopAudit';
import { DECIDE_TIMEOUT_MS } from './audit';
import { curriculumLessons, keywordCurriculumHint, hintsForLesson, emptyCurriculumHints } from './curriculumHints';
import { bankOptions, bankQuestions, bankStem } from '../utils/questionBankExport';

export interface BankTagProgress { completed: number; total: number; endpointErrors: number; skipped?: boolean }
export async function tagBankQuestions(params: { doc: ExamDoc; settings: AppSettings; includeModelDifficulty: boolean;
  onProgress?: (progress: BankTagProgress) => void;
  decisionCaller?: (body: any) => Promise<{ results: Array<{ name: string; probability: number; choice?: string }> }>;
}): Promise<{ doc: ExamDoc; endpointErrors: number; skipped: boolean }> {
  const doc = structuredClone(params.doc);
  const questions = bankQuestions(doc); const lessons = curriculumLessons(doc.meta.grade, doc.meta.subject);
  const provider = resolveDecisionProvider(params.settings);
  const active = (params.settings.decideMode ?? 'shadow') === 'active';
  const candidates: Array<{ q: Question; difficulty: boolean; hint: boolean }> = [];
  for (const q of questions) {
    if (!q.curriculumHints?.lesson) {
      const hint = keywordCurriculumHint(lessons, `${bankStem(doc, q)} ${bankOptions(doc, q).map(o => o.text).join(' ')}`);
      q.curriculumHints = hint || emptyCurriculumHints();
      if (hint) q.curriculumSource = 'keyword'; else delete q.curriculumSource;
    }
    const difficulty = params.includeModelDifficulty && !q.difficulty;
    const hint = active && lessons.length > 0 && !q.curriculumHints?.lesson;
    if (provider && (difficulty || hint)) candidates.push({ q, difficulty, hint });
  }
  const progress: BankTagProgress = { completed: 0, total: candidates.length, endpointErrors: 0 };
  const emit = () => { try { params.onProgress?.({ ...progress }); } catch { /* optional UI */ } };
  emit();
  let consecutiveErrors = 0;
  for (const candidate of candidates) {
    const q = candidate.q;
    const question = { stem: bankStem(doc, q), options: bankOptions(doc, q), section: doc.sections.find(s => s.id === q.sectionId)?.title || '' };
    const decide = async (kind: 'difficulty' | 'curriculum-hint') => {
      const name = `Q${q.no} ${kind}`;
      const choices = kind === 'difficulty' ? ['1','2','3','4','5'] : lessons.map(l => l.title);
      const instructions = kind === 'difficulty' ? 'Rate expected student difficulty from 1 (recall/trivial) to 5 (multi-step/very hard), considering stem, options and section.' : 'Choose the official lesson most relevant to this question.';
      const thx = provider!.decideDialect === 'thx';
      const body = thx ? { model: provider!.model, state: `Question: ${JSON.stringify(question)}`, questions: { [name]: {
        type: kind === 'difficulty' ? 'score' : 'choice', instructions,
        ...(kind === 'difficulty' ? { levels: choices } : { criteria: Object.fromEntries(lessons.map(l => [l.title, l.choiceDescription || l.title])) }),
      } } } : { input: { purpose: 'question bank tagging' }, questions: [{ name, type: 'choice', instructions, input: { question }, choices }] };
      const caller = params.decisionCaller || ((body: any) => LLMAdapter.executeDecisions({ providerConfig: provider!, body, timeoutMs: DECIDE_TIMEOUT_MS }));
      const response = await caller(body);
      const result = response.results.find(r => r.name === name);
      if (!result || !Number.isFinite(result.probability)) throw new Error('No usable tagging decision');
      consecutiveErrors = 0;
      if (kind === 'difficulty' && choices.includes(result.choice || '')) q.difficulty = { value: Number(result.choice) as 1|2|3|4|5, source: 'model' }, q.difficultyMode = active ? 'active' : 'shadow';
      if (kind === 'curriculum-hint' && result.probability >= 0.5) {
        const lesson = lessons.find(l => l.title === result.choice);
        if (lesson) { q.curriculumHints = hintsForLesson(lesson); q.curriculumSource = 'decision'; }
      }
    };
    for (const kind of [candidate.difficulty ? 'difficulty' : undefined, candidate.hint ? 'curriculum-hint' : undefined] as const) {
      if (!kind || consecutiveErrors >= 5) continue;
      try { await decide(kind); }
      catch (error) {
        if (/HTTP 5\d\d|abort|timed? ?out|network|fetch|unreachable|connection|ECONN/i.test(String((error as Error)?.message))) { consecutiveErrors++; progress.endpointErrors++; }
        else consecutiveErrors = 0;
      }
    }
    progress.completed++; emit();
    if (consecutiveErrors >= 5) { progress.skipped = true; emit(); break; }
  }
  return { doc, endpointErrors: progress.endpointErrors, skipped: !!progress.skipped };
}
