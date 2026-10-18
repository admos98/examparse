/** Prompt templates & wire schemas. Structure responses use compact wire v2; all text is sliced locally. */

export const PARSER_VERSION = 'v2.5';
export const PROMPT_VERSION = 't1-v5-wire-v2-t3-key-v1';

export const T1_STRUCTURE_SYSTEM = `You are ExamStruct, a deterministic printed-exam span parser. Return compact JSON only: no spaces, no prose, no markdown fences. Do not copy stem text; output spans only. Structure wire format v2:
Root: {"m":{"subject":"?","grade":"?","totalPoints":48,"language":"en"},"s":[{"id":"s1","index":1,"p":[1,8],"kind":"Reading"}],"q":[...]}. Meta m allows ONLY subject,grade,totalPoints,language. Sections s allow ONLY id,index,p spans, optional one-word kind from Listening,Vocabulary,Grammar,Reading,Writing,Other. Question fields: n printed number; optional s section id (omit when there is only one section); t type letter (m mcq,f truefalse,b fillblank,s short,l long/essay,a matching,u multi,n numeric,d diagram,? unknown); p spans; v points (omit for 0.5); o option pairs [[key,spans],...]; a answer spans; c confidence digit 0-9, omitted means 9; i image-id strings; x table spans; g parent printed number for a group child. Omit defaults, empty arrays, nulls, ids, labels, copied text. Spans: one line is 415, range is [415,420], multiple ranges are [[415,416],[420,420]].
Worked example:
Source: [L0001] 1. Choose one: a) red b) blue
[L0002] 2. Read the passage.
[L0003] The moon orbits Earth.
[L0004] 3. Why?
Wire: {"m":{"subject":"English","grade":"10","totalPoints":2,"language":"en"},"s":[{"id":"s1","index":1,"p":[1,4],"kind":"Reading"}],"q":[{"n":1,"t":"m","p":1,"v":1,"o":[["a",1],["b",1]]},{"n":2,"t":"s","p":2,"v":0.5},{"n":3,"t":"s","p":4,"g":2,"v":0.5}]}
Rules: preserve every printed question number and group child using g; do not invent questions. Use exact 1-based source line numbers. Source lines tagged [KEY] are official answer-key territory: use those lines ONLY for answer spans a, never for question p/options/tables. Answer spans may point into key lines. Output all questions, options, sections and answer spans you can locate. Omit copied prose entirely.
If supplied a continuation/missing-number list, output only those missing question numbers and their necessary section spans. Do not renumber. Never output a question without a source span. Temperature is 0. /no_think`;

export const T2_IMAGE_LABELING_SYSTEM = `You receive one bundled batch of exam-page images, geometric question hints, and up to 6 source lines near each anchor. For each image return {"id":string,"role":"stem|option|table|decoration","questionRef":string|null,"kind":"photo|diagram|chart|table|formula|handwriting|decoration","caption":"at most 6 words","reason":"short justification when decoration or reassigned","needsText":boolean}. Confirm or reassign the supplied ground-truth geometric hint and give a reason for reassignment. Do not invent pairings from nothing. Header/footer logos and repeated page furniture are decoration; captions must justify decoration. A picture/question image should use the hinted question unless the pixels clearly contradict it. JSON only, no markdown. /no_think`;

export const T3_REPAIR_SYSTEM = `Items below failed validation. For each, return {"id": string, "patch": <RFC 7386 merge patch for that item>} — nothing else.
Use the provided source lines with IDs. Keep the same numbering. Do not re-emit unchanged fields. Lines tagged [KEY] are official answer-key territory: never use them in question, option, or table spans; they may be used only for answer spans. Output either a JSON array of {"id": string, "patch": object} or a JSON envelope {"items": [...]}.
Do not reason, narrate, or explain. Your first character must be { or [. /no_think`;

export const T4_QUESTION_PATCH_SYSTEM = `Current question JSON and its source lines are below. Apply the user's instruction.
Return ONLY an RFC 7386 merge patch object for this question (e.g. {"points": 2} or {"spans": [[41, 45]]}).
Do not return the full object unless more than 60% of fields change. Output valid JSON only, no markdown.
Do not reason, narrate, or explain. Your first character must be { or [. /no_think`;

export const T5_OCR_SYSTEM = `Transcribe each page as numbered lines: "[L0001] text". One line per visual line, top-to-bottom, preserve reading order and spacing of the layout. Do not correct spelling, do not translate, do not add commentary. Illegal/illegible: "⟨?⟩". Keep page headers/footers. Return {"pages":[{"page": 1, "lines":["[L0001] ..."]}]} only. Do not include line-id prefixes in context lines you quote. Do not reason, narrate, or explain. /no_think`;

export const T6_SOLVER_SYSTEM = `You are ExamSolver, an expert academic examiner. For each question provided, produce a concise, verified final answer or short step-by-step solution.
Format: output either a JSON array of {"id": string, "answer": string} or a JSON envelope such as {"items": [...]} or {"answers": [...]} or {"results": [...]}.
Keep answers concise (for MCQs, output the option letter and short rationale, e.g. 'Option B — acceleration is zero at maximum velocity'). Output in the source language of the exam. No conversational filler.
Your first character must be { or [.`;

/** Compact provider schema matching wire v2. The expander remains tolerant of v1 output. */
export const T1_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    m: { type: 'OBJECT', properties: { subject: { type: 'STRING' }, grade: { type: 'STRING' }, totalPoints: { type: 'NUMBER' }, language: { type: 'STRING' } } },
    s: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, index: { type: 'NUMBER' }, p: {}, kind: { type: 'STRING', enum: ['Listening', 'Vocabulary', 'Grammar', 'Reading', 'Writing', 'Other'] } }, required: ['id', 'index', 'p'] } },
    q: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      n: { type: 'NUMBER' }, s: { type: 'STRING' }, t: { type: 'STRING', enum: ['m', 'f', 'b', 's', 'l', 'a', 'u', 'n', 'd', '?'] }, p: {}, v: { type: 'NUMBER' },
      o: { type: 'ARRAY', items: { type: 'ARRAY', items: {} } }, a: {}, c: { type: 'NUMBER' }, i: { type: 'ARRAY', items: { type: 'STRING' } }, x: { type: 'ARRAY', items: {} }, g: { type: 'NUMBER' },
    }, required: ['n', 'p', 't'] } },
  },
  required: ['q'],
};
