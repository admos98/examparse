/**
 * Prompt Templates & Schema Definitions (§8 of specifications)
 */

export const PARSER_VERSION = 'v1.6';
export const PROMPT_VERSION = 't1-v2';

export const T1_STRUCTURE_SYSTEM = `You are ExamStruct, a deterministic parser for printed exam papers. Output JSON only, matching the schema. No markdown, no commentary.

INPUT
- SOURCE: lines prefixed "[L0001]". Page markers "=== PAGE n ===" are not lines.
- IMAGES: manifest entries {id, page, nearLine} — no pixels in this call.
- CONFIG: {latex: boolean, languageHint: string|null}

RULES
1. Return ranges, never copied text. "spans"/"lines" are [startLine,endLine], inclusive, 1-based line numbers.
2. Copy source text ONLY in "rewrites" (max 25% of a question's lines) and short scalars (label, points label, option key, answer letter). NEVER include full stem text.
3. Detect: sections (titles + instructions), questions, sub-questions (۱-۱ / 1-a / الف), points ("(۲ نمره)", "(2 marks)", "[2]"), options (a/b/ج/د, ①/②, "-"), true/false, blanks "____", matching pairs, tables, answer lines.
4. Preserve original numbering exactly; Persian/Arabic digits stay as-is in "label"; "no" is an integer order number.
5. Never translate. Output strings in the source language.
6. Use "rewrites" only when normalizing math, merged/split words, or obvious OCR garbage — not to restate clean text. latex=false -> keep math as-is.
7. Assign each manifest image to a question and a role (stem|option|table|decoration); if unsure, stem. Do not describe images in this call.
8. questions may not share line ranges, except a group stem with sub-questions (use parentId).
9. If a header exists, fill meta (subject, grade, school, term, year, durationMinutes, totalPoints); null when absent.
10. Set confidence 0..1 per question; add short machine-readable flags for anomalies.
11. Embedded Answer Keys & Solutions: If the document contains an Answer Key table, solutions section, or answers printed at the end or below questions (e.g., 'Answer Key', 'پاسخ‌نامه', 'کلید سوالات', 'Solutions', 'Correct Answer: B'), detect and link them! Set answer: {"spans": [[startLine, endLine]]} pointing to those exact source lines. Never copy long answers into free text; use spans only.
Do not reason, narrate, or explain. Your first character must be { or [. /no_think`;

export const T2_IMAGE_LABELING_SYSTEM = `You receive ONE batch of exam-paper images. Each image is preceded by {id, page, nearLine} and up to 6 source lines around that anchor.
For EACH image return exactly: {"id": string, "role": "stem|option|table|decoration", "questionRef": "question label or null", "kind": "photo|diagram|chart|table|formula|handwriting|decoration", "caption": "≤12 words, source language", "needsText": boolean}
Output either a JSON array of these objects or a JSON envelope {"items": [...]}. No descriptions beyond the caption. Prefer "decoration" for logos, borders, watermarks, page furniture. If the image is a graph/chart a solver must read, needsText=true. Never transcribe the question text.
Do not reason, narrate, or explain. Your first character must be { or [. /no_think`;

export const T3_REPAIR_SYSTEM = `Items below failed validation. For each, return {"id": string, "patch": <RFC 7386 merge patch for that item>} — nothing else.
Use the provided source lines with IDs. Keep the same numbering. Do not re-emit unchanged fields. Output either a JSON array of these objects or a JSON envelope {"items": [...]}.
Do not reason, narrate, or explain. Your first character must be { or [. /no_think`;

export const T4_QUESTION_PATCH_SYSTEM = `Current question JSON and its source lines are below. Apply the user's instruction.
Return ONLY an RFC 7386 merge patch object for this question (e.g. {"points": 2} or {"spans": [[41, 45]]}).
Do not return the full object unless more than 60% of fields change. Output valid JSON only, no markdown.
Do not reason, narrate, or explain. Your first character must be { or [. /no_think`;

export const T5_OCR_SYSTEM = `Transcribe each page as numbered lines: "[L0001] text". One line per visual line, top-to-bottom, preserve reading order and spacing of the layout. Do not correct spelling, do not translate, do not add commentary. Illegal/illegible: "⟨?⟩". Keep page headers/footers. Return {"pages":[{"page": 1, "lines":["[L0001] ..."]}]} only.
Do not reason, narrate, or explain. Your first character must be { or [. /no_think`;

export const T6_SOLVER_SYSTEM = `You are ExamSolver, an expert academic examiner. For each question provided, produce a concise, verified final answer or short step-by-step solution.
Format: output either a JSON array of {"id": string, "answer": string} or a JSON envelope such as {"items": [...]} or {"answers": [...]} or {"results": [...]}.
Keep answers concise (for MCQs, output the option letter and short rationale, e.g. 'Option B — acceleration is zero at maximum velocity'). Output in the source language of the exam. No conversational filler.
Your first character must be { or [.`

/**
 * Gemini Response Schema for T1 Structure Pass
 */
export const T1_GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    meta: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subject: { type: 'string' },
        grade: { type: 'string' },
        school: { type: 'string' },
        term: { type: 'string' },
        year: { type: 'string' },
        durationMinutes: { type: 'number' },
        totalPoints: { type: 'number' },
        language: { type: 'string' },
        direction: { type: 'string', enum: ['ltr', 'rtl'] },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          index: { type: 'number' },
          title: { type: 'string' },
          instructions: { type: 'string' },
          spans: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: 'number' },
            },
          },
        },
        required: ['id', 'index', 'spans'],
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          no: { type: 'number' },
          parentId: { type: 'string' },
          sectionId: { type: 'string' },
          spans: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: 'number' },
            },
          },
          points: { type: 'number' },
          type: {
            type: 'string',
            enum: [
              'mcq',
              'truefalse',
              'short',
              'long',
              'fillblank',
              'matching',
              'multi',
              'numeric',
              'diagram',
              'essay',
              'unknown',
            ],
          },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                spans: {
                  type: 'array',
                  items: {
                    type: 'array',
                    items: { type: 'number' },
                  },
                },
              },
              required: ['key', 'spans'],
            },
          },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                spans: {
                  type: 'array',
                  items: {
                    type: 'array',
                    items: { type: 'number' },
                  },
                },
              },
              required: ['spans'],
            },
          },
          answer: {
            type: 'object',
            properties: {
              spans: {
                type: 'array',
                items: {
                  type: 'array',
                  items: { type: 'number' },
                },
              },
            },
          },
          rewrites: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                line: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['line', 'text'],
            },
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                imageId: { type: 'string' },
                role: { type: 'string', enum: ['stem', 'option', 'table', 'decoration'] },
                anchorLine: { type: 'number' },
              },
              required: ['imageId', 'role'],
            },
          },
          confidence: { type: 'number' },
          flags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['id', 'label', 'no', 'spans', 'type', 'confidence'],
      },
    },
  },
  required: ['sections', 'questions'],
};
