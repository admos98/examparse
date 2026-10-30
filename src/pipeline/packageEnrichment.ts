/** Package-only decisions. This path never calls the parse/fix pipeline or mutates package content. */
import type { AppSettings, ExamDoc, Question, QuestionEnrichment } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { getReviewImageBlob } from '../store';
import { canonicalLetter, parseAnswerLetter } from './answerCorrectness';
import { curriculumLessons, hintsForLesson } from './curriculumHints';
import { generatePackageExplanations, explanationKey } from './packageExplanations';
import { normalizeIdentity } from './identity';
import { hasCompletenessCorroboration } from './completenessCorroboration';
import { DIFFICULTY_LEVELS, DIFFICULTY_INSTRUCTIONS, blindChoiceSoundProbability, buildLoopDecisionState, buildThxDecisionBody, decideIsMultimodal, IMAGE_OWNERSHIP_INSTRUCTIONS, resolveDecisionProvider, type LoopDecisionCaller, type LoopDecisionItem, type LoopDecisionVote } from './loopAudit';
import { DECIDE_TIMEOUT_MS } from './audit';

const OUTSIDE = "not from this textbook's lessons";
export function lessonRanking(distribution: Record<string, number>, outside = OUTSIDE): Pick<QuestionEnrichment, 'lessons' | 'origin' | 'lessonDistribution'> {
  const entries = Object.entries(distribution).filter(([, p]) => Number.isFinite(p) && p >= 0 && p <= 1).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  return { lessonDistribution: Object.fromEntries(entries), lessons: entries.filter(([name, p]) => name !== outside && p >= .1).slice(0, 3).map(([lesson, probability]) => ({ lesson, probability })),
    ...(top ? { origin: top[0] === outside || top[1] < .30 ? 'beyond-book' as const : entries.filter(([name, p]) => name !== outside && p >= .25).length >= 2 ? 'multi' as const : 'single' as const } : {}) };
}
const valid = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
export async function enrichPackage(doc: ExamDoc, settings: AppSettings, options: { explanationCaller?: NonNullable<Parameters<typeof generatePackageExplanations>[2]>['caller']; decisionCaller?: LoopDecisionCaller; onProgress?: (message: string) => void; onJournal?: (entry: { label: string; rawText: string; requestText: string }) => Promise<void> } = {}): Promise<ExamDoc> {
  const out: ExamDoc = structuredClone(doc);
  const explanationNotes = await generatePackageExplanations(out, settings, { caller: options.explanationCaller, onProgress: options.onProgress, onJournal: options.onJournal });
  const provider = resolveDecisionProvider(settings);
  if (!provider) {
    out.source.enrichmentStatus = 'not run'; out.source.enrichmentNotes = [...explanationNotes, 'No decision provider configured.'];
    for (const q of out.questions) { q.confidence = null as unknown as number; q.enrichment = { source: 'model', verification: 'unjudged', ...(q.enrichment?.teacherLesson ? { teacherLesson: q.enrichment.teacherLesson } : {}), ...(q.explanation ? { explanationCheck: { state: 'unjudged' } } : {}) }; }
    const identity = normalizeIdentity(out.meta.grade, out.meta.subject);
    if (!curriculumLessons(identity.grade, identity.subject).length) {
      out.source.enrichmentNotes.push(`lesson ranking skipped — no curriculum lessons for grade ${identity.grade || 'unknown'} / subject ${identity.subject || 'unknown'}.`);
      for (const q of out.questions) Object.assign(q.enrichment!, { lessons: [], origin: 'unknown' });
    }
    return out;
  }
  const caller = options.decisionCaller || (body => LLMAdapter.executeDecisions({ providerConfig: provider, body, timeoutMs: DECIDE_TIMEOUT_MS }));
  const notes = new Set<string>(explanationNotes); let failures = 0; let calls = 0; let consecutiveErrors = 0;
  const flag = (q: Question, code: string, message: string) => { out.flags.push({ id: `enrichment_${q.id}_${code}`, code: 'PACKAGE_ENRICHMENT', severity: 'warn', questionId: q.id, message, rootCauseId: `enrichment_${q.id}_${code}` }); };
  out.flags = out.flags.filter(f => f.code !== 'PACKAGE_ENRICHMENT');
  const decide = async (q: Question, name: string, instructions: string, input: Record<string, unknown>, choices?: Record<string, string>, images?: LoopDecisionItem['images']): Promise<LoopDecisionVote | undefined> => {
    if (consecutiveErrors >= 5) return undefined;
    const item: LoopDecisionItem = { id: `${q.id}::${name}`, name: `${q.id} ${name}`, type: name === 'difficulty' ? 'difficulty' : 'complete', questionNumbers: [q.no], instructions, input, ...(choices ? { choices: Object.keys(choices), choiceDescriptions: choices } : {}), ...(images ? { images } : {}) };
    const body = provider.decideDialect === 'thx' ? buildThxDecisionBody(item, provider.model, buildLoopDecisionState(item)) : { input: { exam: doc.fileHash.slice(0, 12), purpose: 'package enrichment' }, questions: [{ name: item.id, type: name === 'difficulty' ? 'score' : choices ? 'choice' : 'probability', instructions, input, ...(name === 'difficulty' ? { criteria: [...DIFFICULTY_LEVELS] } : {}), ...(choices ? { choices: Object.keys(choices), choiceDescriptions: choices } : {}), ...(images ? { images } : {}) }] };
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
    const e: QuestionEnrichment = { source: 'model', verification: 'unjudged', origin: 'unknown', ...(q.enrichment?.teacherLesson ? { teacherLesson: q.enrichment.teacherLesson } : {}) }; q.enrichment = e;
    const passage = out.passages?.find(p => p.id === q.passageId);
    const input = { question: { number: q.no, type: q.type, stem: q.stem, options: (q.options || []).map(o => ({ key: o.key, text: o.text })) }, ...(passage ? { passageText: passage.text } : {}), ...((typeof q.imported?.transcript === 'string' && q.imported.transcript.trim()) || (typeof q.imported?.script === 'string' && q.imported.script.trim()) ? { listeningScript: q.imported?.transcript?.trim() || q.imported?.script?.trim() } : {}) };
    const listening = /\b(?:listen|listening|audio|recording|transcript)\b|شنید/i.test(`${q.imported?.title || ''} ${out.sections.find(s => s.id === q.sectionId)?.title || ''} ${q.stem || ''}`) && !(/\b(?:listening script|transcript)\s*:/i.test(`${passage?.text || ''} ${q.stem || ''}`) || (typeof q.imported?.transcript === 'string' && !!q.imported.transcript.trim()) || (typeof q.imported?.script === 'string' && !!q.imported.script.trim()));
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
    if (listening) notes.add('Listening answer checks without an included script are unverifiable.');
    if (visualMissing) notes.add('Image-dependent judgments were skipped where pixels or a multimodal decision endpoint were unavailable.');
    if (!listening && !visualMissing) {
      const key = q.imported?.answer_key; const answer = q.answer?.text && (key?.correct?.length === 1 || q.answer.source === 'manual') ? q.answer.text : undefined;
      const opts = q.options || [];
      if (answer && opts.length >= 2) {
        const letter = parseAnswerLetter(answer, q);
        const expected = opts.find(o => o.key.trim().toLowerCase() === answer.trim().toLowerCase() || o.text?.trim().toLowerCase() === answer.trim().toLowerCase() || (letter && canonicalLetter(o.key) === letter))?.key;
        if (expected) {
          const vote = await decide(q, 'blind-answer', 'Which option is the correct answer to this question?', input, Object.fromEntries(opts.map(o => [o.key, o.text || ''])), payloads);
          if (vote) { const sound = blindChoiceSoundProbability(expected, opts.map(o => o.key), vote); e.verification = sound === 1 ? 'verified' : sound === 0 ? 'disagreed' : 'uncertain'; e.verificationProbability = vote.distribution && valid(vote.distribution[expected]) ? vote.distribution[expected] : vote.choice === expected ? vote.probability : 1 - vote.probability; e.checkerChoice = vote.choice; if (sound === 0) flag(q, 'answer', `The checker disagrees with the answer key: it would answer ${vote.choice}; the package says ${expected}.`); }
        }
      } else if (answer && !opts.length) {
        const vote = await decide(q, 'answer', `The answer '${answer}' is a correct answer to this question.`, input, undefined, payloads);
        if (vote) { e.verificationProbability = vote.probability; e.verification = vote.probability >= .8 ? 'verified' : vote.probability <= .2 ? 'disagreed' : 'uncertain'; if (e.verification === 'disagreed') flag(q, 'answer', 'The checker disagrees with the answer key.'); }
      }
    }
    if (q.explanation) {
      const check = await decide(q, 'explanation-check', 'This explanation correctly explains why the marked answer is correct.', { ...input, key: explanationKey(q), explanation: q.explanation.text });
      e.explanationCheck = check ? { probability: check.probability, state: check.probability >= .8 ? 'verified' : check.probability <= .2 ? 'rejected' : 'uncertain' } : { state: 'unjudged' };
    }
    const complete = await decide(q, 'complete', 'This question can be answered from the text given, without anything missing.', input, undefined, payloads);
    if (complete) { e.completeness = { probability: complete.probability }; if (complete.probability <= .2 && hasCompletenessCorroboration(q, passage?.text)) flag(q, 'complete', 'The checker thinks this question may be incomplete.'); }
    const identity = normalizeIdentity(out.meta.grade, out.meta.subject);
    const lessons = curriculumLessons(identity.grade, identity.subject);
    if (lessons.length) {
      const teacherLesson = lessons.find(l => l.title === e.teacherLesson?.lesson);
      if (teacherLesson) { q.curriculumHints = hintsForLesson(teacherLesson); }
      const criteria = Object.fromEntries([...lessons.map(l => [l.title, [l.keywords, l.grammar?.join('; '), l.writingFocus, l.function].filter(Boolean).join('; ')]), [OUTSIDE, "not from this textbook's lessons"]]);
      const vote = await decide(q, 'lessons', 'Choose the lesson most relevant to this question.', input, criteria, payloads);
      if (vote?.choice && !vote.distribution) Object.assign(e, lessonRanking({ [vote.choice]: vote.probability }));
      if (vote?.distribution) {
        Object.assign(e, lessonRanking(vote.distribution));
        const ranked = Object.entries(vote.distribution).filter(([, p]) => valid(p)).sort((a,b) => b[1] - a[1]);
        const selected = lessons.find(l => l.title === ranked[0]?.[0]);
        if (!e.teacherLesson) {
          q.curriculumHints = selected && ranked[0][1] >= .5 && ranked[0][1] - (ranked[1]?.[1] || 0) >= .15 ? hintsForLesson(selected) : { chapter: null, lesson: null, topic: null };
          q.curriculumSource = 'decision';
        }
      }
    }
    else { e.lessons = []; e.origin = 'unknown'; notes.add(`lesson ranking skipped — no curriculum lessons for grade ${identity.grade || 'unknown'} / subject ${identity.subject || 'unknown'}.`); }
    if (passage) {
      const vote = await decide(q, 'reading-mode', 'How is the answer found in the passage?', input, { 'direct-finding': 'the answer is stated directly in the passage', comprehension: 'the answer must be inferred or understood, not just located' }, payloads);
      if (vote?.choice) e.readingMode = { value: vote.choice as 'direct-finding' | 'comprehension', probability: vote.probability, distribution: vote.distribution };
    }
    const difficulty = await decide(q, 'difficulty', DIFFICULTY_INSTRUCTIONS, input, { '1': DIFFICULTY_LEVELS[0], '2': DIFFICULTY_LEVELS[1], '3': DIFFICULTY_LEVELS[2], '4': DIFFICULTY_LEVELS[3], '5': DIFFICULTY_LEVELS[4] }, payloads);
    if (difficulty?.choice && difficulty.probability >= .4) { q.difficulty = { value: Number(difficulty.choice) as 1|2|3|4|5, source: 'model' }; q.difficultyMode = 'active'; }
    else { q.difficulty = null as unknown as Question['difficulty']; if (difficulty) e.difficultyUncertain = true; }
    const vote = await decide(q, 'demand', 'Choose the cognitive demand of this question.', { ...input, ...(e.readingMode ? { readingMode: e.readingMode.value } : {}) }, { recall: 'answer is remembered facts, words, or rules', comprehension: 'answer requires understanding meaning in context', inference: 'answer requires combining information, inferring, or applying to a new case' }, payloads);
    if (vote?.choice) {
      const capped = e.readingMode?.value === 'direct-finding' && vote.choice === 'inference';
      if (!capped || valid(vote.distribution?.comprehension)) e.demand = { value: (capped ? 'comprehension' : vote.choice) as 'recall' | 'comprehension' | 'inference', probability: capped ? vote.distribution!.comprehension : vote.probability, distribution: vote.distribution };
    }
    // Confidence precedence: blind-answer sound, completeness, then demand; no vote means null.
    q.confidence = e.verificationProbability ?? e.completeness?.probability ?? e.demand?.probability ?? (null as unknown as number);
    for (const ref of q.images) {
      e.imagePlacement ||= []; const payload = payloads.find(p => p.id === ref.imageId);
      if (!payload) { e.imagePlacement.push({ imageId: ref.imageId, state: 'skipped-no-evidence' }); continue; }
      const image = out.images.find(i => i.id === ref.imageId);
      const owners = out.questions.filter(other => other.images.some(r => r.imageId === ref.imageId));
      const shared = owners.length >= 2;
      const isMatching = /\b(?:picture|image|photo|illustration)\b/i.test(q.stem || '') && (q.options || []).length >= 2;
      if (shared) {
        const structurallyAssigned = image?.packageShared?.structural && owners.every(owner => image.packageShared!.ownerIds.includes(owner.id));
        if (isMatching || structurallyAssigned) {
          const numbers = owners.map(owner => owner.no).sort((a, b) => a - b);
          notes.add(`Image shared by ${numbers.map(n => `Q${n}`).join('–')} — judged as a group.`);
        }
        if (!isMatching) {
          e.imagePlacement.push({ imageId: ref.imageId, state: structurallyAssigned ? 'verified' : 'skipped-no-evidence' });
          continue;
        }
      }
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
