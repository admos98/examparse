/** Package-only decisions. This path never calls the parse/fix pipeline or mutates package content. */
import type { AppSettings, ExamDoc, Question, QuestionEnrichment } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { canonicalLetter, parseAnswerLetter } from './answerCorrectness';
import { decisionImageLimit, listeningEvidence, loadImageBundle } from './evidenceBundle';
import { evidenceFingerprint, rubricFingerprint } from './evidence';
import { executableAnswerText, migrateLegacyAiAnswers, proposalText } from '../utils/bankAnswers';
import { curriculumLessons, hintsForLesson } from './curriculumHints';
import { generatePackageExplanations, explanationKey } from './packageExplanations';
import { generatePackageTashrihi, judgeState, RUBRIC_JUDGE, SAMPLE_ANSWER_JUDGE } from './packageTashrihi';
import { generateFillBlankCandidates } from './packageProposals';
import { normalizeIdentity } from './identity';
import { isPackageListeningQuestion } from './packageListening';
import { hasCompletenessCorroboration } from './completenessCorroboration';
import { DIFFICULTY_LEVELS, DIFFICULTY_INSTRUCTIONS, blindChoiceSoundProbability, buildLoopDecisionState, buildThxDecisionBody, decideIsMultimodal, IMAGE_OWNERSHIP_INSTRUCTIONS, resolveDecisionProvider, type LoopDecisionCaller, type LoopDecisionItem, type LoopDecisionVote } from './loopAudit';
import { DECIDE_TIMEOUT_MS } from './audit';

const OUTSIDE = "not from this textbook's lessons";
/** #57 Part B — auto-graded types whose keyless items may receive (but never be written) a proposal. */
const AUTO_GRADED_TYPES: ReadonlySet<Question['type']> = new Set<Question['type']>(['mcq', 'fillblank', 'matching']);
export function lessonRanking(distribution: Record<string, number>, outside = OUTSIDE): Pick<QuestionEnrichment, 'lessons' | 'origin' | 'lessonDistribution'> {
  const entries = Object.entries(distribution).filter(([, p]) => Number.isFinite(p) && p >= 0 && p <= 1).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  return { lessonDistribution: Object.fromEntries(entries), lessons: entries.filter(([name, p]) => name !== outside && p >= .1).slice(0, 3).map(([lesson, probability]) => ({ lesson, probability })),
    ...(top ? { origin: top[0] === outside || top[1] < .30 ? 'beyond-book' as const : entries.filter(([name, p]) => name !== outside && p >= .25).length >= 2 ? 'multi' as const : 'single' as const } : {}) };
}
const valid = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
export interface EnrichmentEvent {
  kind: 'exam' | 'phase' | 'call' | 'error' | 'skip' | 'stream';
  completed?: number; planned?: number; label?: string; check?: string; message?: string; text?: string;
}
export async function enrichPackage(doc: ExamDoc, settings: AppSettings, options: {
  explanationCaller?: NonNullable<Parameters<typeof generatePackageExplanations>[2]>['caller'];
  decisionCaller?: LoopDecisionCaller;
  onProgress?: (message: string) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText: string }) => Promise<void>;
  /** #58 Part F — structured live progress for the primary package path. */
  onEvent?: (event: EnrichmentEvent) => void;
  /** Injected image loader (tests / browser storage); defaults to the folder blob store. */
  loadImageBlob?: (blobKey: string) => Promise<Blob | undefined>;
  /** #58 Part F — raw streamed output of the generative pass (one call, shown live). */
  onStream?: (text: string) => void;
} = {}): Promise<ExamDoc> {
  const out: ExamDoc = structuredClone(doc);
  // #58 — legacy AI Solve values become explicit non-executing proposals; the user's text stays.
  migrateLegacyAiAnswers(out);
  // Legacy package imports may contain the old first-section fallback. Without a
  // mapping receipt it is unsafe evidence, even on re-enrichment.
  for (const q of out.questions) {
    if (!q.imported) continue;
    const listening = isPackageListeningQuestion(q, out.sections.find(s => s.id === q.sectionId)?.title);
    const mapped = out.source.packageScriptReceipt?.some(r => r.label === q.label && r.sectionId != null);
    if (!listening || !mapped) delete q.imported.script;
    if (!listening) delete q.imported.transcript;
  }
  const stream = Boolean(options.onStream);
  options.onEvent?.({ kind: 'phase', message: 'explanations' });
  const explanationNotes = await generatePackageExplanations(out, settings, {
    caller: options.explanationCaller, onProgress: options.onProgress, onJournal: options.onJournal,
    ...(options.onStream ? { onStream: options.onStream } : {}),
    // #58 Part C — the writer must not draft prose for a picture it cannot see.
    canDraft: (q: Question) => {
      if (!q.images.length) return true;
      if (!decideIsMultimodal(settings, resolveDecisionProvider(settings) || undefined)) return false;
      return q.images.every(ref => Boolean(out.images.find(image => image.id === ref.imageId)));
    },
  });
  // #57 Part A — the same local generative pass proposes sample answers + rubrics for keyless tashrihi items.
  const imageLimit = decisionImageLimit(settings);
  const multimodal = decideIsMultimodal(settings, resolveDecisionProvider(settings) || undefined);
  const loadBundle = (q: Question) => loadImageBundle(out, q, imageLimit, options.loadImageBlob);
  options.onEvent?.({ kind: 'phase', message: 'sample answers & rubrics' });
  const tashrihiNotes = await generatePackageTashrihi(out, settings, { caller: options.explanationCaller, onProgress: options.onProgress, onJournal: options.onJournal, loadBundle: multimodal ? loadBundle : undefined, ...(stream ? { onStream: options.onStream } : {}) });
  // #58 Part A — keyless OPTIONLESS blanks get a review-only candidate in the same small batch.
  const candidateNotes = await generateFillBlankCandidates(out, settings, { caller: options.explanationCaller, onProgress: options.onProgress, onJournal: options.onJournal });
  options.onEvent?.({ kind: 'phase', message: 'decision checks' });
  const provider = resolveDecisionProvider(settings);
  if (!provider) {
    out.source.enrichmentStatus = 'not run'; out.source.enrichmentNotes = [...explanationNotes, ...tashrihiNotes, ...candidateNotes, 'No decision provider configured.'];
    for (const q of out.questions) { q.confidence = null as unknown as number; q.enrichment = { source: 'model', verification: 'unjudged', ...(q.enrichment?.teacherLesson ? { teacherLesson: q.enrichment.teacherLesson } : {}), ...(q.explanation ? { explanationCheck: { state: 'unjudged' } } : {}) }; }
    const identity = normalizeIdentity(out.meta.grade, out.meta.subject);
    if (!curriculumLessons(identity.grade, identity.subject).length) {
      out.source.enrichmentNotes.push(`lesson ranking skipped — no curriculum lessons for grade ${identity.grade || 'unknown'} / subject ${identity.subject || 'unknown'}.`);
      for (const q of out.questions) Object.assign(q.enrichment!, { lessons: [], origin: 'unknown' });
    }
    return out;
  }
  const caller = options.decisionCaller || (body => LLMAdapter.executeDecisions({ providerConfig: provider, body, timeoutMs: DECIDE_TIMEOUT_MS }));
  const notes = new Set<string>([...explanationNotes, ...tashrihiNotes, ...candidateNotes]);
  const evidenceNotes = new Set<string>();
  // #58 Part F — an honest planned-call estimate: checks per question vary, and retries make the
  // final total unknown, so the estimate is raised only as real calls occur.
  let planned = out.questions.reduce((total, question) => total
    + 3 // lessons · demand · complete
    + (question.passageId ? 1 : 0)
    + (proposalText(question) || executableAnswerText(question) ? 1 : 0)
    + (question.explanation ? 1 : 0)
    + (question.images?.length || 0), 0);
  let failures = 0; let calls = 0; let consecutiveErrors = 0;
  const flag = (q: Question, code: string, message: string) => { out.flags.push({ id: `enrichment_${q.id}_${code}`, code: 'PACKAGE_ENRICHMENT', severity: 'warn', questionId: q.id, message, rootCauseId: `enrichment_${q.id}_${code}` }); };
  out.flags = out.flags.filter(f => f.code !== 'PACKAGE_ENRICHMENT');
  const decide = async (q: Question, name: string, instructions: string, input: Record<string, unknown>, choices?: Record<string, string>, images?: LoopDecisionItem['images']): Promise<LoopDecisionVote | undefined> => {
    if (consecutiveErrors >= 5) return undefined;
    const item: LoopDecisionItem = { id: `${q.id}::${name}`, name: `${q.id} ${name}`, type: name === 'difficulty' ? 'difficulty' : 'complete', questionNumbers: [q.no], instructions, input, ...(choices ? { choices: Object.keys(choices), choiceDescriptions: choices } : {}), ...(images ? { images } : {}) };
    const body = provider.decideDialect === 'thx' ? buildThxDecisionBody(item, provider.model, buildLoopDecisionState(item)) : { input: { exam: doc.fileHash.slice(0, 12), purpose: 'package enrichment' }, questions: [{ name: item.id, type: name === 'difficulty' ? 'score' : choices ? 'choice' : 'probability', instructions, input, ...(name === 'difficulty' ? { criteria: [...DIFFICULTY_LEVELS] } : {}), ...(choices ? { choices: Object.keys(choices), choiceDescriptions: choices } : {}), ...(images ? { images } : {}) }] };
    options.onProgress?.(`Q${q.label || q.no} · ${name}`); calls++;
    if (calls > planned) planned = calls;
    options.onEvent?.({ kind: 'call', completed: calls, planned, label: `Q${q.label || q.no}`, check: name });
    try {
      const response = await caller(body); consecutiveErrors = 0; const row = response.results.find(r => r.name === item.id || r.name === item.name);
      if (!row || !valid(row.probability)) { failures++; options.onEvent?.({ kind: 'skip', completed: calls, planned, label: `Q${q.label || q.no}`, check: name, message: 'the checker returned no usable verdict' }); return undefined; }
      let choice = row.choice, probability = row.probability;
      if (choices && row.distribution) {
        const entries = Object.entries(row.distribution).filter(([key, p]) => key in choices && valid(p)).sort((a,b) => b[1]-a[1]);
        if (entries.length) [choice, probability] = entries[0];
      }
      if (choices && (!choice || !(choice in choices))) { failures++; return undefined; }
      try { await options.onJournal?.({ label: `Package enrichment · ${name}`, rawText: JSON.stringify(response.results), requestText: JSON.stringify(body) }); } catch { /* journal best effort */ }
      return { probability, choice, distribution: row.distribution };
    } catch { failures++; consecutiveErrors++; notes.add('Some decision requests failed; those estimates are unjudged.'); options.onEvent?.({ kind: 'error', completed: calls, planned, label: `Q${q.label || q.no}`, check: name, message: 'decision request failed; this estimate is unjudged' }); if (consecutiveErrors === 5) notes.add('Decision endpoint unreachable — remaining checks were not run.'); return undefined; }
  };
  for (const q of out.questions) {
    // The generative pass may already have stored review-only candidates; they survive the reset.
    const earlierProposal = q.enrichment?.proposedAnswer;
    const e: QuestionEnrichment = { source: 'model', verification: 'unjudged', origin: 'unknown', ...(q.enrichment?.teacherLesson ? { teacherLesson: q.enrichment.teacherLesson } : {}), ...(earlierProposal ? { proposedAnswer: earlierProposal } : {}) };
    q.enrichment = e;
    const passage = out.passages?.find(p => p.id === q.passageId);
    const input = { question: { number: q.no, label: q.label, type: q.type, stem: q.stem, options: (q.options || []).map(o => ({ key: o.key, text: o.text })) }, ...(passage ? { passageText: passage.text } : {}), ...((typeof q.imported?.transcript === 'string' && q.imported.transcript.trim()) || (typeof q.imported?.script === 'string' && q.imported.script.trim()) ? { listeningScript: q.imported?.transcript?.trim() || q.imported?.script?.trim() } : {}) };
    const listening = isPackageListeningQuestion(q, out.sections.find(s => s.id === q.sectionId)?.title) && !(/\b(?:listening script|transcript)\s*:/i.test(`${passage?.text || ''} ${q.stem || ''}`) || (typeof q.imported?.transcript === 'string' && !!q.imported.transcript.trim()) || (typeof q.imported?.script === 'string' && !!q.imported.script.trim()));
    // #58 Part C — ONE addressed bundle per question, respecting the endpoint's real image limit.
    // Missing/over-limit evidence leaves the affected visual checks unjudged; nothing is split,
    // sent elsewhere, or guessed from a caption.
    const bundle = multimodal && q.images.length ? await loadImageBundle(out, q, imageLimit, options.loadImageBlob) : undefined;
    const payloads: NonNullable<LoopDecisionItem['images']> = bundle?.complete ? bundle.payloads : [];
    const visualMissing = Boolean(bundle && !bundle.complete) || (/\b(?:picture|image|photo|illustration)\b/i.test(q.stem || '') && !q.images.length);
    if (listening) notes.add('Listening answer checks without an included script are unjudged.');
    if (bundle && !bundle.complete && bundle.reason) evidenceNotes.add(bundle.reason);
    else if (visualMissing) evidenceNotes.add('Image-dependent judgments were unjudged because pixels or a multimodal decision endpoint were unavailable.');
    if (!listening && !visualMissing) {
      const key = q.imported?.answer_key;
      // #58 Part A — only a source/keyfile/teacher answer is executable evidence. A legacy AI
      // value or an enrichment proposal never becomes the thing a blind check is leashed to.
      const answer = executableAnswerText(q) && (key?.correct?.length === 1 || q.answer?.source === 'manual') ? executableAnswerText(q) : undefined;
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
      } else if (!q.answer?.text?.trim() && opts.length >= 2 && AUTO_GRADED_TYPES.has(q.type)) {
        // #57 Part B — propose, never execute. The checker may name a candidate for a keyless
        // auto-graded item, but the proposal lives ONLY in enrichment.proposedAnswer: it is never
        // written to answer / answer_key / any executable grading field. Adoption is a teacher
        // action in Step 4 (their save stores it as teacher-entered).
        const proposal = await decide(q, 'answer-proposal', 'Propose the correct answer to this question.', input, Object.fromEntries(opts.map(o => [o.key, o.text || ''])), payloads);
        if (proposal?.choice) e.proposedAnswer = { text: proposal.choice, source: 'model', probability: proposal.probability };
      } else if (!executableAnswerText(q) && !opts.length && q.type === 'fillblank' && proposalText(q)) {
        // #58 — the candidate for an optionless blank is CHECKED here, but stays review-only.
        const proposed = proposalText(q)!;
        const check = await decide(q, 'proposal-check', `The answer '${proposed}' is a correct answer to this question.`, input, undefined, payloads);
        e.proposedAnswer = {
          ...(q.enrichment?.proposedAnswer || { text: proposed, source: 'model' }),
          text: proposed,
          ...(check ? { probability: check.probability, check: { state: judgeState(check.probability), probability: check.probability, evidence: evidenceFingerprint(out, q) } } : { check: { state: 'unjudged' } }),
        };
      }
    }
    if (q.explanation && !listening && !visualMissing) {
      const check = await decide(q, 'explanation-check', 'This explanation correctly explains why the marked answer is correct.', { ...input, key: explanationKey(q), explanation: q.explanation.text });
      e.explanationCheck = check ? { probability: check.probability, state: check.probability >= .8 ? 'verified' : check.probability <= .2 ? 'rejected' : 'uncertain' } : { state: 'unjudged' };
    }
    if (q.explanation && (listening || visualMissing)) e.explanationCheck = { state: 'unjudged' };
    // #57 Part A — the decision judge grades each model artifact with its single clause and
    // routes it (≥0.80 verified · ≤0.20 rejected · middle uncertain). Teacher confirmation in
    // Step 4 is still the only promotion; rejected artifacts stay in the record, never in exports.
    // #58 Part C — a judge may only verify an artifact when it received ALL required evidence:
    // the right question, its instruction group and passage, the mapped section script, and this
    // question's own picture bundle. Otherwise the artifact stays unjudged (never "verified").
    const evidenceComplete = !listening && !visualMissing && (payloads.length === q.images.length);
    if (q.sampleAnswer?.source === 'model') {
      if (evidenceComplete) {
        const check = await decide(q, 'sample-answer-check', SAMPLE_ANSWER_JUDGE, { ...input, sampleAnswer: q.sampleAnswer.text }, undefined, payloads);
        if (check) { q.sampleAnswer.probability = check.probability; q.sampleAnswer.judged = judgeState(check.probability); q.sampleAnswer.evidence = evidenceFingerprint(out, q); }
      } else q.sampleAnswer.judged = 'unjudged';
    }
    if (q.rubric?.source === 'model') {
      if (evidenceComplete) {
        const check = await decide(q, 'rubric-check', RUBRIC_JUDGE, { ...input, rubric: q.rubric.criteria, points: typeof q.points === 'number' ? q.points : null }, undefined, payloads);
        if (check) { q.rubric.probability = check.probability; q.rubric.judged = judgeState(check.probability); q.rubric.evidence = rubricFingerprint(out, q, q.rubric.criteria); }
      } else q.rubric.judged = 'unjudged';
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
    // Confidence precedence (#57 Part D): blind-answer sound first, then demand; completeness no
    // longer feeds confidence (it is displayed only through its corroborated flag). No vote → null.
    q.confidence = e.verificationProbability ?? e.demand?.probability ?? (null as unknown as number);
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
          const labels = [...new Set(owners.map(owner => owner.label || String(owner.no)))];
          notes.add(`Image shared by ${labels.map(label => `Q${label}`).join('–')} — judged as a group.`);
        }
        if (!isMatching) {
          e.imagePlacement.push({ imageId: ref.imageId, state: structurallyAssigned ? 'verified' : 'skipped-no-evidence' });
          continue;
        }
      }
      const key = q.answer?.text && (q.imported?.answer_key?.correct?.length === 1 || q.answer.source === 'manual') ? q.answer.text : undefined;
      const expected = isMatching ? q.options?.find(o => o.key.toLowerCase() === key?.toLowerCase() || o.text?.toLowerCase() === key?.toLowerCase())?.key : 'this question';
      const choices: Record<string, string> = isMatching ? { ...Object.fromEntries((q.options || []).map(o => [o.key, o.text || ''])), none: 'None of these sentences' } : { 'this question': 'this question', 'another question on the page': 'another question', 'no question': 'no question' };
      // #58 Part C — address placement with the questions that could actually own the picture:
      // known source position (same section, ±3 numbers) first, then the known page, never the
      // whole unseen paper. The source/teacher answer is placement evidence only; it is never
      // written into the blind-answer question.
      const refPage = out.images.find(image => image.id === ref.imageId)?.page;
      const pageOf = (question: typeof q) => question.images?.map(item => out.images.find(image => image.id === item.imageId)?.page).filter((page): page is number => page != null) || [];
      const nearby = out.questions.filter(other => other.id !== q.id && (
        (q.no != null && other.no != null && other.sectionId === q.sectionId && Math.abs(other.no - q.no) <= 3)
        || (refPage != null && pageOf(other).includes(refPage))
      ));
      const candidateQuestions = nearby.length ? nearby : undefined;
      if (!isMatching && !candidateQuestions && !key) {
        e.imagePlacement.push({ imageId: ref.imageId, state: 'skipped-no-evidence' });
        continue;
      }
      const placementInput = {
        ...input,
        ...(candidateQuestions ? { candidateQuestions: candidateQuestions.map(other => ({ number: other.no, stem: other.stem, options: (other.options || []).map(o => ({ key: o.key, text: o.text })) })) } : {}),
        ...(key ? { sourceAnswer: key } : {}),
      };
      const vote = await decide(q, 'image-placement', isMatching ? 'Which sentence does this picture illustrate? A typical illustrative scene counts as a match.' : IMAGE_OWNERSHIP_INSTRUCTIONS, isMatching ? input : placementInput, choices, [payload]);
      const sound = vote && expected ? blindChoiceSoundProbability(expected, Object.keys(choices), vote) : .5;
      const state = !vote ? 'skipped-no-evidence' : sound === 1 ? 'verified' : sound === 0 ? 'disagreed' : 'uncertain';
      e.imagePlacement.push({ imageId: ref.imageId, state, ...(vote ? { probability: vote.probability, choice: vote.choice } : {}) });
      if (state === 'disagreed') flag(q, `image_${ref.imageId}`, 'Image may belong to another question or sentence.');
    }
    // #58 Part B — every verdict above is bound to the exact evidence it was produced from.
    e.evidence = evidenceFingerprint(out, q);
  }
  // #57 Part E — judge each factored passage once; member questions whose own lesson vote
  // abstained (no hint under the ≥0.50/margin rule) inherit the passage's confident lesson,
  // stored with curriculumSource 'inherited'. Teacher and confident individual votes always win.
  const lessonIdentity = normalizeIdentity(out.meta.grade, out.meta.subject);
  const lessonOptions = curriculumLessons(lessonIdentity.grade, lessonIdentity.subject);
  if (lessonOptions.length && consecutiveErrors < 5) {
    const criteria = Object.fromEntries([...lessonOptions.map(l => [l.title, [l.keywords, l.grammar?.join('; '), l.writingFocus, l.function].filter(Boolean).join('; ')]), [OUTSIDE, "not from this textbook's lessons"]]);
    const judged = new Set<string>();
    for (const q of out.questions) {
      const passage = q.passageId ? out.passages?.find(p => p.id === q.passageId) : undefined;
      if (!passage || !passage.text.trim() || judged.has(passage.id)) continue;
      judged.add(passage.id);
      const vote = await decide(q, 'passage-lessons', 'Choose the lesson most relevant to this passage.', { passageText: passage.text }, criteria);
      if (!vote?.distribution) continue;
      const ranked = Object.entries(vote.distribution).filter(([, p]) => valid(p)).sort((a, b) => b[1] - a[1]);
      const selected = lessonOptions.find(l => l.title === ranked[0]?.[0]);
      if (!selected || ranked[0][1] < .5 || ranked[0][1] - (ranked[1]?.[1] || 0) < .15) continue;
      for (const member of out.questions.filter(item => item.passageId === passage.id)) {
        // Individual abstention only: a confident individual hint or a teacher lesson is never overridden.
        if (member.enrichment?.teacherLesson || member.curriculumHints?.lesson) continue;
        if (!member.enrichment?.lessonDistribution) continue;
        member.curriculumHints = hintsForLesson(selected);
        member.curriculumSource = 'inherited';
      }
    }
  }
  // #57 Part E — outcome-first notes: the final state first; intermediate narration survives
  // only when the final outcome is incomplete (kept as counted summary lines from generation).
  const eligibleExplanations = out.questions.filter(q => explanationKey(q)).length;
  const madeExplanations = out.questions.filter(q => explanationKey(q) && q.explanation).length;
  const rejectedExplanations = out.questions.filter(q => q.enrichment?.explanationCheck?.state === 'rejected').length;
  for (const note of [...notes]) if (note.startsWith('explanations:')) notes.delete(note);
  notes.add(`explanations: ${madeExplanations} of ${eligibleExplanations} keyed questions${rejectedExplanations ? `; ${rejectedExplanations} rejected by the checker` : ''}`);
  const tashrihi = out.questions.filter(question => ['short', 'long', 'essay'].includes(question.type) && !executableAnswerText(question));
  const artifacts = out.questions.flatMap(q => [q.sampleAnswer, q.rubric]).filter(artifact => Boolean(artifact));
  if (artifacts.length) {
    const tally = { verified: 0, uncertain: 0, rejected: 0, unjudged: 0 };
    for (const artifact of artifacts) tally[artifact!.judged]++;
    notes.add(`sample & rubric checks: ${tally.verified} verified · ${tally.uncertain} uncertain · ${tally.rejected} rejected${tally.unjudged ? ` · ${tally.unjudged} unjudged` : ''}`);
  }
  if (tashrihi.length) {
    const missingSample = tashrihi.filter(question => !question.sampleAnswer).length;
    const missingRubric = tashrihi.filter(question => !question.rubric).length;
    notes.add(`tashrihi artifacts: ${tashrihi.length - missingSample} of ${tashrihi.length} items have a sample · ${tashrihi.length - missingRubric} of ${tashrihi.length} have a rubric (teacher confirmation still required)`);
  }
  for (const note of evidenceNotes) notes.add(note);
  const missingExplanations = out.questions.some(q => explanationKey(q) && !q.explanation);
  out.source.enrichmentStatus = !calls || failures === calls ? 'not run' : failures || consecutiveErrors >= 5 || missingExplanations ? 'partial' : 'completed'; out.source.enrichmentNotes = [...notes];
  return out;
}
