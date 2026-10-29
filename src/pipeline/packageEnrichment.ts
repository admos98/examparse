/** Package-only decisions. This path never calls the parse/fix pipeline or mutates package content. */
import type { AppSettings, ExamDoc, Question, QuestionEnrichment } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { getReviewImageBlob } from '../store';
import { canonicalLetter, parseAnswerLetter } from './answerCorrectness';
import { curriculumLessons } from './curriculumHints';
import { blindChoiceSoundProbability, buildLoopDecisionState, buildThxDecisionBody, decideIsMultimodal, IMAGE_OWNERSHIP_INSTRUCTIONS, resolveDecisionProvider, type LoopDecisionCaller, type LoopDecisionItem, type LoopDecisionVote } from './loopAudit';
import { DECIDE_TIMEOUT_MS } from './audit';

const OUTSIDE = "not from this textbook's lessons";
export function lessonRanking(distribution: Record<string, number>, outside = OUTSIDE): Pick<QuestionEnrichment, 'lessons' | 'origin' | 'lessonDistribution'> {
  const entries = Object.entries(distribution).filter(([, p]) => Number.isFinite(p) && p >= 0 && p <= 1).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  return { lessonDistribution: Object.fromEntries(entries), lessons: entries.filter(([name, p]) => name !== outside && p >= .1).slice(0, 3).map(([lesson, probability]) => ({ lesson, probability })),
    ...(top ? { origin: top[0] === outside || top[1] < .30 ? 'beyond-book' as const : entries.filter(([name, p]) => name !== outside && p >= .25).length >= 2 ? 'multi' as const : top[1] >= .50 && (entries[1]?.[1] || 0) < .25 ? 'single' as const : undefined } : {}) };
}
const valid = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
export async function enrichPackage(doc: ExamDoc, settings: AppSettings, options: { decisionCaller?: LoopDecisionCaller; onProgress?: (message: string) => void; onJournal?: (entry: { label: string; rawText: string; requestText: string }) => Promise<void> } = {}): Promise<ExamDoc> {
  const out: ExamDoc = structuredClone(doc);
  const provider = resolveDecisionProvider(settings);
  if (!provider) { out.source.enrichmentStatus = 'not run'; out.source.enrichmentNotes = ['No decision provider configured.']; return out; }
  const caller = options.decisionCaller || (body => LLMAdapter.executeDecisions({ providerConfig: provider, body, timeoutMs: DECIDE_TIMEOUT_MS }));
  const notes = new Set<string>(); let failures = 0; let calls = 0; let consecutiveErrors = 0;
  const flag = (q: Question, code: string, message: string) => { out.flags.push({ id: `enrichment_${q.id}_${code}`, code: 'PACKAGE_ENRICHMENT', severity: 'warn', questionId: q.id, message, rootCauseId: `enrichment_${q.id}_${code}` }); };
  out.flags = out.flags.filter(f => f.code !== 'PACKAGE_ENRICHMENT');
  const decide = async (q: Question, name: string, instructions: string, input: Record<string, unknown>, choices?: Record<string, string>, images?: LoopDecisionItem['images']): Promise<LoopDecisionVote | undefined> => {
    if (consecutiveErrors >= 5) return undefined;
    const item: LoopDecisionItem = { id: `${q.id}::${name}`, name: `${q.id} ${name}`, type: 'complete', questionNumbers: [q.no], instructions, input, ...(choices ? { choices: Object.keys(choices), choiceDescriptions: choices } : {}), ...(images ? { images } : {}) };
    const body = provider.decideDialect === 'thx' ? buildThxDecisionBody(item, provider.model, buildLoopDecisionState(item)) : { input: { exam: doc.fileHash.slice(0, 12), purpose: 'package enrichment' }, questions: [{ name: item.id, type: choices ? 'choice' : 'probability', instructions, input, ...(choices ? { choices: Object.keys(choices), choiceDescriptions: choices } : {}), ...(images ? { images } : {}) }] };
    options.onProgress?.(`Q${q.no} · ${name}`); calls++;
    try {
      const response = await caller(body); consecutiveErrors = 0; const row = response.results.find(r => r.name === item.id || r.name === item.name);
      if (!row || !valid(row.probability)) { failures++; return undefined; }
      let choice = row.choice, probability = row.probability;
      if (choices && row.distribution) {
        const entries = Object.entries(row.distribution).filter(([key, p]) => key in choices && valid(p)).sort((a,b) => b[1]-a[1]);
        if (entries.length) [choice, probability] = entries[0];
      }
      if (choices && (!choice || !(choice in choices))) { failures++; return undefined; }
      try { await options.onJournal?.({ label: `Package enrichment · ${name}`, rawText: JSON.stringify(response.results), requestText: JSON.stringify(body) }); } catch { /* journal best effort */ }
      return { probability, choice, distribution: row.distribution };
    } catch { failures++; consecutiveErrors++; notes.add('Some decision requests failed; those estimates are unjudged.'); if (consecutiveErrors === 5) notes.add('Decision endpoint unreachable — remaining checks were not run.'); return undefined; }
  };
  const multimodal = decideIsMultimodal(settings, provider);
  for (const q of out.questions) {
    const e: QuestionEnrichment = { source: 'model', verification: 'unjudged', ...(q.enrichment?.teacherLesson ? { teacherLesson: q.enrichment.teacherLesson } : {}) }; q.enrichment = e;
    const passage = out.passages?.find(p => p.id === q.passageId);
    const input = { question: { number: q.no, type: q.type, stem: q.stem, options: (q.options || []).map(o => ({ key: o.key, text: o.text })) }, ...(passage ? { passageText: passage.text } : {}) };
    const listening = /\b(?:listen|listening|audio|recording|transcript)\b|شنید/i.test(`${q.imported?.title || ''} ${q.stem || ''}`) && !/\b(?:listening script|transcript)\s*:/i.test(`${passage?.text || ''} ${q.stem || ''}`);
    const payloads: NonNullable<LoopDecisionItem['images']> = [];
    if (multimodal) for (const ref of q.images) {
      const image = out.images.find(i => i.id === ref.imageId); if (!image) continue;
      try {
        let data = image.dataUrl?.startsWith('data:') ? image.dataUrl.split(',')[1] : undefined;
        if (!data) { const blob = await getReviewImageBlob(image.blobKey); if (blob) { const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); data = btoa(binary); } }
        if (data) payloads.push({ id: image.id, mime: image.mime, data });
      } catch { /* missing pixels are skipped */ }
    }
    const visualMissing = (q.images.length > payloads.length) || (/\b(?:picture|image|photo|illustration)\b/i.test(q.stem || '') && !q.images.length);
    if (listening) notes.add('Listening questions without an included script are unverifiable.');
    if (visualMissing) notes.add('Image-dependent judgments were skipped where pixels or a multimodal decision endpoint were unavailable.');
    if (!listening && !visualMissing) {
      const key = q.imported?.answer_key; const answer = q.answer?.text && (key?.correct?.length === 1 || q.answer.source === 'manual') ? q.answer.text : undefined;
      const opts = q.options || [];
      if (answer && opts.length >= 2) {
        const letter = parseAnswerLetter(answer, q);
        const expected = opts.find(o => o.key.trim().toLowerCase() === answer.trim().toLowerCase() || o.text?.trim().toLowerCase() === answer.trim().toLowerCase() || (letter && canonicalLetter(o.key) === letter))?.key;
        if (expected) {
          const vote = await decide(q, 'blind-answer', 'Which option is the correct answer to this question?', input, Object.fromEntries(opts.map(o => [o.key, o.text || ''])), payloads);
          if (vote) { const sound = blindChoiceSoundProbability(expected, opts.map(o => o.key), vote); e.verification = sound === 1 ? 'verified' : sound === 0 ? 'disagreed' : 'uncertain'; e.verificationProbability = vote.probability; e.checkerChoice = vote.choice; if (sound === 0) flag(q, 'answer', `The checker disagrees with the answer key: it would answer ${vote.choice}; the package says ${expected}.`); }
        }
      } else if (answer && !opts.length) {
        const vote = await decide(q, 'answer', `The answer '${answer}' is a correct answer to this question.`, input, undefined, payloads);
        if (vote) { e.verificationProbability = vote.probability; e.verification = vote.probability >= .8 ? 'verified' : vote.probability <= .2 ? 'disagreed' : 'uncertain'; if (e.verification === 'disagreed') flag(q, 'answer', 'The checker disagrees with the answer key.'); }
      }
      const complete = await decide(q, 'complete', 'This question can be answered from the text given, without anything missing.', input, undefined, payloads);
      if (complete) { e.completeness = { probability: complete.probability }; if (complete.probability <= .2) flag(q, 'complete', 'The checker thinks this question may be incomplete.'); }
      const lessons = curriculumLessons(q.imported?.grade ?? out.meta.grade, q.imported?.subject ?? out.meta.subject);
      if (lessons.length) {
        const criteria = Object.fromEntries([...lessons.map(l => [l.title, [l.keywords, l.grammar?.join('; '), l.writingFocus, l.function].filter(Boolean).join('; ')]), [OUTSIDE, "not from this textbook's lessons"]]);
        const vote = await decide(q, 'lessons', 'Choose the lesson most relevant to this question.', input, criteria, payloads);
        if (vote?.distribution) { Object.assign(e, lessonRanking(vote.distribution)); if (e.origin === 'beyond-book') flag(q, 'lesson', 'No clear lesson match — may be beyond the book.'); }
      }
      if (passage) {
        const vote = await decide(q, 'reading-mode', 'How is the answer found in the passage?', input, { 'direct-finding': 'the answer is stated directly in the passage', comprehension: 'the answer must be inferred or understood, not just located' }, payloads);
        if (vote?.choice) e.readingMode = { value: vote.choice as 'direct-finding' | 'comprehension', probability: vote.probability, distribution: vote.distribution };
      }
      const vote = await decide(q, 'demand', 'Choose the cognitive demand of this question.', { ...input, ...(e.readingMode ? { readingMode: e.readingMode.value } : {}) }, { recall: 'answer is remembered facts, words, or rules', comprehension: 'answer requires understanding meaning in context', inference: 'answer requires combining information, inferring, or applying to a new case' }, payloads);
      if (vote?.choice) {
        const capped = e.readingMode?.value === 'direct-finding' && vote.choice === 'inference';
        if (!capped || valid(vote.distribution?.comprehension)) e.demand = { value: (capped ? 'comprehension' : vote.choice) as 'recall' | 'comprehension' | 'inference', probability: capped ? vote.distribution!.comprehension : vote.probability, distribution: vote.distribution };
      }
    }
    for (const ref of q.images) {
      e.imagePlacement ||= []; const payload = payloads.find(p => p.id === ref.imageId);
      if (!payload) { e.imagePlacement.push({ imageId: ref.imageId, state: 'skipped-no-evidence' }); continue; }
      const isMatching = /\b(?:picture|image|photo|illustration)\b/i.test(q.stem || '') && (q.options || []).length >= 2;
      const key = q.answer?.text && (q.imported?.answer_key?.correct?.length === 1 || q.answer.source === 'manual') ? q.answer.text : undefined;
      const expected = isMatching ? q.options?.find(o => o.key.toLowerCase() === key?.toLowerCase() || o.text?.toLowerCase() === key?.toLowerCase())?.key : 'this question';
      const choices: Record<string, string> = isMatching ? { ...Object.fromEntries((q.options || []).map(o => [o.key, o.text || ''])), none: 'None of these sentences' } : { 'this question': 'this question', 'another question on the page': 'another question', 'no question': 'no question' };
      const vote = await decide(q, 'image-placement', isMatching ? 'Which sentence does this picture illustrate? A typical illustrative scene counts as a match.' : IMAGE_OWNERSHIP_INSTRUCTIONS, isMatching ? input : { ...input, candidateQuestions: out.questions.filter(other => other.id !== q.id).map(other => ({ number: other.no, stem: other.stem, options: (other.options || []).map(o => ({ key: o.key, text: o.text })) })) }, choices, [payload]);
      const sound = vote && expected ? blindChoiceSoundProbability(expected, Object.keys(choices), vote) : .5;
      const state = !vote ? 'skipped-no-evidence' : sound === 1 ? 'verified' : sound === 0 ? 'disagreed' : 'uncertain';
      e.imagePlacement.push({ imageId: ref.imageId, state, ...(vote ? { probability: vote.probability, choice: vote.choice } : {}) });
      if (state === 'disagreed') flag(q, `image_${ref.imageId}`, 'Image may belong to another question or sentence.');
    }
  }
  out.source.enrichmentStatus = !calls || failures === calls ? 'not run' : failures || consecutiveErrors >= 5 ? 'partial' : 'completed'; out.source.enrichmentNotes = [...notes];
  return out;
}
