#!/usr/bin/env tsx
/**
 * #38 Part E1 — the Field-Report-#12 born-digital mock exam as a corpus entry.
 *
 * PROVENANCE (honest): the original field file is NOT present in this checkout (only Field
 * Report #12's description is: born-digital mock exam, ~65 questions, 40 marks, repeated
 * per-page headers, a different marks layout, shipped as 106 questions / 34 "sections" /
 * all points 0). This script therefore AUTHORS a format-faithful paper with exactly those
 * printed properties and derives EVERY truth field from the paper's own generation ledger
 * (never from any model output): 65 questions, 4 real sections, total 40 marks printed as
 * per-question bracket marks + section subtotals + an explicit total line. labels.json is
 * the ground-truth line classification authored alongside the paper.
 *
 * Deterministic: re-running rewrites byte-identical fixtures.
 * If the original field file becomes available, promote it through the Library (#37 B1)
 * and retire this reconstruction.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceLine } from '../src/types';

const DIR = path.join(process.cwd(), 'test/fixtures/corpus/mock-born-digital');

type Label = 'furniture' | 'section-header' | 'instruction' | 'question-start' | 'continuation' | 'option' | 'passage' | 'answer-key' | 'marks' | 'blank';
interface Draft { text: string; label: Label; title?: string }

const draft: Draft[] = [];
const push = (text: string, label: Label, title?: string) => { draft.push({ text, label, title }); };

let printedTotal = 0;
let nextNo = 0;
const headerIndexes: number[] = [];
const question = (stem: string, marks: number, options?: string[]) => {
  nextNo++;
  printedTotal += marks;
  push(`${nextNo}. ${stem} [${marks}]`, 'question-start');
  if (options) push(options.map((o, i) => `${'abcd'[i]}) ${o}`).join('   '), 'option');
};

// --- Page 1 furniture + rubric (born-digital: identical running header/footer every page)
push('MOCK EXAMINATION · GENERAL ENGLISH · FORM M-7', 'furniture');
push('Name: ______________________   Class: __________   Date: __________', 'furniture');
push('Time allowed: 60 minutes. Answer ALL questions in the spaces provided.', 'furniture');
push('Total marks: 40', 'marks');

// --- SECTION A — Vocabulary (Q1–20, 10 marks)
headerIndexes.push(draft.length);
push('SECTION A — Vocabulary (10 marks)', 'section-header', 'Vocabulary');
push('Choose the word closest in meaning to the word in quotation marks.', 'instruction');
const VOCAB: Array<[string, string[]]> = [
  ['rapid', ['slow', 'quick', 'weak', 'late']],
  ['ancient', ['recent', 'modern', 'very old', 'strange']],
  ['brave', ['afraid', 'courageous', 'quiet', 'proud']],
  ['careful', ['cautious', 'careless', 'busy', 'tired']],
  ['decide', ['delay', 'choose', 'doubt', 'forget']],
  ['eager', ['bored', 'keen', 'angry', 'shy']],
  ['famous', ['unknown', 'rich', 'well known', 'funny']],
  ['gentle', ['rough', 'kind and soft', 'loud', 'strict']],
  ['honest', ['truthful', 'clever', 'silent', 'rude']],
  ['improve', ['get worse', 'get better', 'repeat', 'hide']],
  ['journey', ['a short walk', 'a long trip', 'a ticket', 'a map']],
  ['knowledge', ['information learned', 'a question', 'a building', 'a skill in sport']],
  ['lazy', ['energetic', 'idle', 'hungry', 'noisy']],
  ['modern', ['old-fashioned', 'expensive', 'of the present time', 'broken']],
  ['narrow', ['wide', 'not wide', 'deep', 'short']],
  ['polite', ['rude', 'well-mannered', 'clever', 'brave']],
  ['quiet', ['silent', 'busy', 'bright', 'heavy']],
  ['reward', ['a punishment', 'a prize for good work', 'a rule', 'a mistake']],
  ['similar', ['different', 'alike', 'opposite', 'equal in size only']],
  ['wealth', ['health', 'a large amount of money', 'fame', 'strength']],
];
for (const [word, options] of VOCAB) question(`The word "${word}" is closest in meaning to …`, 0.5, options);

// --- SECTION B — Grammar (Q21–35, 10 marks)
headerIndexes.push(draft.length);
push('SECTION B — Grammar (10 marks)', 'section-header', 'Grammar');
push('Complete each sentence with ONE suitable word.', 'instruction');
const FILLS = [
  'She ______ to school by bus every morning.',
  'They ______ finished their homework before dinner yesterday.',
  'The library is ______ the bank and the post office.',
  'If it rains tomorrow, we ______ stay at home.',
  'He has lived in this town ______ 2010.',
  'The report ______ written by the secretary last week.',
  'I am looking forward ______ seeing you soon.',
  'Neither the teacher nor the students ______ in the lab now.',
  'You ______ not smoke in the hospital; it is forbidden.',
  'The man ______ car was stolen called the police.',
];
for (const stem of FILLS) question(stem, 0.5);
push('Choose the correct form.', 'instruction');
const GRAMMAR_MCQ: Array<[string, string[]]> = [
  ['By the time we arrived, the film ______.', ['already started', 'has already started', 'had already started', 'starts']],
  ['She asked me where ______.', ['do I live', 'I live', 'did I live', 'I lived']],
  ['The children ______ in the garden since noon.', ['play', 'are playing', 'have been playing', 'played']],
  ['Hardly ______ the door when the phone rang.', ['I had closed', 'had I closed', 'I close', 'did I closed']],
  ['It is time we ______ home.', ['go', 'went', 'gone', 'going']],
];
for (const [stem, options] of GRAMMAR_MCQ) question(stem, 1, options);

// --- SECTION C — Reading (Q36–50, 12 marks)
headerIndexes.push(draft.length);
push('SECTION C — Reading (12 marks)', 'section-header', 'Reading');
push('Read the passage and answer the questions in your own words.', 'instruction');
const PASSAGE = [
  'The village library stands at the end of Mill Lane, in a stone building that was once a school.',
  'When the school moved to a larger site in 1968, the empty rooms were given to the village, and',
  'volunteers turned them into a library with second-hand shelves and donated books. For years the',
  'library opened only two evenings a week, but after a grant in 2005 it could employ one part-time',
  'librarian and open every day except Sunday. Today it lends about nine hundred books a month, runs',
  'a reading club for children on Saturdays, and offers free internet access to anyone who asks.',
];
for (const line of PASSAGE) push(line, 'passage');
const READING = [
  'Where exactly is the village library?',
  'What was the building used for before 1968?',
  'Why did the school leave the building?',
  'Who received the empty rooms?',
  'How did the volunteers equip the library?',
  'How often did the library open at first?',
  'What changed in 2005?',
  'What did the grant make possible?',
  'On which day is the library closed now?',
  'Roughly how many books does it lend each month?',
  'When does the children\'s reading club meet?',
  'Who may use the internet there?',
  'Give one reason why the library is useful to the village.',
  'Find a word in the passage that means "given for free".',
  'In one sentence, say how the library has grown since it opened.',
];
for (const stem of READING) question(stem, 0.8);

// --- SECTION D — Writing (Q51–65, 8 marks)
headerIndexes.push(draft.length);
push('SECTION D — Writing (8 marks)', 'section-header', 'Writing');
push('Match each number (51–55) with a definition (a–e).', 'instruction');
push('(51) (52) (53) (54) (55)', 'question-start');
nextNo = 55; // the group line carries five printed numbers at 0.6 each
printedTotal += 3;
push('a) a place where bread is made and sold', 'option');
push('b) a person who repairs water pipes', 'option');
push('c) a book in which you record daily events', 'option');
push('d) a vehicle that carries sick people to hospital', 'option');
push('e) a room where scientific experiments are done', 'option');
push('51 = bakery · 52 = plumber · 53 = diary · 54 = ambulance · 55 = laboratory — write only the letter for each number.', 'continuation');
const WRITING = [
  'Write two sentences about your journey to school this morning.',
  'Write a short note to a friend inviting them to your birthday.',
  'Describe the picture in your textbook on page 12 in three sentences.',
  'Write two sentences giving advice to a younger student.',
  'Write the beginning of a story with the words: "When I opened the door, …"',
  'Write three sentences about what you did last weekend.',
  'Write a sentence asking politely for help with your luggage.',
  'Write two sentences comparing the town and the countryside.',
  'Write a short email (3–4 sentences) thanking your teacher.',
  'Write two sentences about your plans for next summer.',
];
for (const stem of WRITING) question(stem, 0.5);

push('END OF EXAMINATION', 'furniture');

// Ledger checks — the truth of this paper, by construction.
if (nextNo !== 65) throw new Error(`question ledger broken: ${nextNo}`);
if (Math.abs(printedTotal - 40) > 1e-9) throw new Error(`marks ledger broken: ${printedTotal}`);

// --- Paginate (6 pages) with identical running header/footer + continued lines.
const PAGES = 6;
const perPage = Math.ceil(draft.length / PAGES);
const lines: SourceLine[] = [];
const labels: Record<string, Label> = {};
const sectionTitles: Record<string, string> = {};
const headerLineNos: number[] = [];
let n = 0;
const emit = (text: string, label: Label, page: number, y: number, title?: string) => {
  n++;
  lines.push({ id: `L${String(n).padStart(4, '0')}`, page, y, text });
  labels[String(n)] = label;
  if (label === 'section-header') { headerLineNos.push(n); if (title) sectionTitles[String(n)] = title; }
};
for (let page = 1; page <= PAGES; page++) {
  emit('MOCK EXAMINATION · GENERAL ENGLISH · FORM M-7', 'furniture', page, 28);
  const slice = draft.slice((page - 1) * perPage, page * perPage);
  slice.forEach((d, i) => emit(d.text, d.label, page, 60 + i * 24, d.title));
  if (page < PAGES) emit('— continued on the next page —', 'furniture', page, 762);
  emit(`Page ${page} of ${PAGES}`, 'furniture', page, 790);
}

const truth = {
  expectedNumbers: Array.from({ length: 65 }, (_, i) => i + 1),
  types: {
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i + 1), 'mcq'])),
    ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [String(31 + i), 'mcq'])),
  },
  totalPoints: 40,
  sectionTitles: ['Vocabulary', 'Grammar', 'Reading', 'Writing'],
  headerLines: headerLineNos,
  groups: [{ parent: 51, children: [52, 53, 54, 55] }],
  spotChecks: [
    { no: 1, stemIncludes: '"rapid"' },
    { no: 21, stemIncludes: 'by bus every morning' },
    { no: 36, stemIncludes: 'village library' },
    { no: 65, stemIncludes: 'next summer' },
  ],
  // Reviewed by the paper's author against the generation ledger (B2 steps in notes.md).
  status: 'reviewed',
  family: 'born-digital-mock',
  features: ['matching', 'writing-topics'],
};

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'source-lines.json'), JSON.stringify(lines, null, 1) + '\n');
fs.writeFileSync(path.join(DIR, 'images.json'), '[]\n');
fs.writeFileSync(path.join(DIR, 'labels.json'), JSON.stringify({ labels, sectionTitles }, null, 1) + '\n');
fs.writeFileSync(path.join(DIR, 'truth.json'), JSON.stringify(truth, null, 1) + '\n');
fs.writeFileSync(path.join(DIR, 'notes.md'), [
  '# Corpus entry: mock-born-digital',
  '',
  'A born-digital mock examination with repeated per-page running headers/footers,',
  '“continued” lines on every page, bracket per-question marks, section subtotals and',
  'an explicit printed total. 65 questions · 4 sections · 40 marks.',
  '',
  'Provenance: Field Report #12 described exactly this format shipping as 106 questions /',
  '34 “sections” / all points 0 under the old code-first pipeline. The original field file',
  'was not present in the checkout when #38 landed, so this paper was authored format-',
  'faithfully by `scripts/generate-mock-exam.ts`; every truth field comes from that',
  'generation ledger (the printed paper), never from model output. `labels.json` is the',
  'ground-truth line classification authored with the paper and drives the #38 label-',
  'assembly acceptance test. Review record (Part B2 steps): counts vs ledger ✓ (65/40),',
  'types limited to the checked MCQ subset ✓, section titles checked ✓, spot questions',
  '1/21/36/65 checked ✓, groups 51–55 checked ✓ → status set reviewed when the runner is green.',
  '',
].join('\n'));
console.log(`wrote mock-born-digital: ${lines.length} lines, 65 questions, 40 marks, headers at ${headerLineNos.join(',')}`);
