/** Shipped skill set — 7 skills ≤900 tokens each, tight, no fluff, derived from real incident history */
import { estimateTokens } from './tokens';

export const SHIPPED_SKILLS: Array<{ slug:string; content:string }> = [
{
  slug:'verify-and-repair-exam',
  content: `---
name: Verify and Repair Exam
slug: verify-and-repair-exam
status: active
triggers: [verify, check, repair, health, fix, exam health, coverage]
appliesTo: {roles: [agent]}
maxTokens: 900
source: shipped
stats: {injected: 0, followed: 0, greenAfter: 0, redAfter: 0}
---
# Verify and Repair Exam — D5 Loop

1. ONE reply, batched reads: get_exam_health + list_missing + get_question_index (+ get_source_lines) — leading reads run in parallel; each costs 0.25 of a tool execution.
2. If amber/red, run deterministic L0 checks locally — option splits, numbering, image assignment.
3. Call retry_missing_questions (L1) when missing>0; report attempted/added/stillMissing.
4. For remaining missing, call diagnose_missing {numbers}: it returns an actionQueue the harness executor runs BEFORE your next turn (split_group_children / accept_group_representation locally; reparse_section stops at the confirm card). Read its single delta report; do not repeat what it ran.
5. If section swallowed or tripwired, prepare reparse_section for affected section; show exact diff; await user Confirm.
6. Never claim green unless health is green; quote before/after numbers.

What NOT to do: one read per turn; full reparse before retry; invent numbers; skip confirmation; re-plan a rung the brief lists as done.
Example: missing 29 → retry adds 12 → 17 remain → diagnose → executor splits 2 groups (+10) → reparse 1 section → green.
`,
},
{
  slug:'missing-questions-triage',
  content: `---
name: Missing Questions Triage
slug: missing-questions-triage
status: active
triggers: [missing, coverage, triage, ladder, L0, L1, L2, L3, retry]
appliesTo: {roles: [agent]}
maxTokens: 900
source: shipped
stats: {injected: 0, followed: 0, greenAfter: 0, redAfter: 0}
---
# Missing Questions Triage — Ladder L0-L4

L0 deterministic locals (0 calls): option/answer splits, numbering hygiene, image reassignment — harness runs before your first call.
L1 retry_missing_questions (1 call, additive): when coverage gap exists. Zero-add → bump to next rung.
L2 inspect: diagnose_missing {numbers} (+ get_source_lines/get_question_index in the SAME reply) — diagnose WHY (group? sub-part? section swallowed? key-territory leak?). Its actionQueue is executed by the harness; you get one delta report.
L3 reparse_section: candidate+confirm for affected section only; show delta {added, removed, changed}.
L4 escalate: state what's missing, what was tried (ledger), two options (accept partial / reparse with escalation model).

Group vs sub-part: (15)(16)(17)(18) enumerations on one line → parent+children; 63 a-d → ONE question.
When retry futile: section header missing → L3 directly after L2 diagnosis.
`,
},
{
  slug:'image-placement',
  content: `---
name: Image Placement
slug: image-placement
status: active
triggers: [image, picture, figure, diagram, orphan, unplaced, anchor]
appliesTo: {roles: [agent]}
maxTokens: 900
source: shipped
stats: {injected: 0, followed: 0, greenAfter: 0, redAfter: 0}
---
# Image Placement — Anchor Geometry First

1. Check health: unplacedImages count and list_images(placed:false).
2. For each orphan, inspect anchorLine, page, bbox via list_images; compute nearest question via geometry.
3. Vision confirms: bundled vision call already supplies role/caption/reason; trust geometry where pixels ambiguous.
4. Call assign_image with deterministic role (stem/option/table) or mark_image_decoration with reason.
5. If repeated logo on ≥3 pages, keep as decoration — local auto-decorate already handled.
6. After placement, re-check health; orphan count must drop.

Do NOT: guess without anchor; overwrite vision decoration without reason.
Example: anchorLine 42 → Q7 stem → assign_image {imageId:"img_2", questionId:"q7", role:"stem"}.
`,
},
{
  slug:'section-integrity',
  content: `---
name: Section Integrity
slug: section-integrity
status: active
triggers: [section, header, plan, swallowed, title, Listening, Vocabulary, Grammar, Reading]
appliesTo: {roles: [fast, agent]}
maxTokens: 900
source: shipped
stats: {injected: 0, followed: 0, greenAfter: 0, redAfter: 0}
---
# Section Integrity — Header-Derived Plans

1. Derive section plan from headers (detectSectionHeaders) — not model-invented buckets; Iranian-layout docs use RTL headers.
2. Validate titles: generic "Question group" forbidden when header title exists within ±3 lines.
3. Detect swallowed sections: expected numbers without section assignment → check plan spans.
4. If model-invented buckets collapse sections, re-derive locally and reparse affected section only.
5. Preserve header-derived spans: sectionPoints from header; do not overwrite with model hallucination.

Symptoms: section count drops from 5→2; titles become generic; missing cluster aligns to section boundary.
Fix: reparse_section for swallowed section; confirm exact diff.
`,
},
{
  slug:'answer-key-handling',
  content: `---
name: Answer Key Handling
slug: answer-key-handling
status: active
triggers: [answer, key, keyfile, territory, grouped answer, y-kar, cross-check]
appliesTo: {roles: [fast, agent]}
maxTokens: 900
source: shipped
stats: {injected: 0, followed: 0, greenAfter: 0, redAfter: 0}
---
# Answer Key Handling — Territory Discipline

1. Identify key territory: lines after markerLine (راهنمای تصحیح / Answer Key) — tagged [KEY]; never use for question p/options/tables.
2. Answer spans may point into [KEY] lines — allowed for a only.
3. Grouped answer splitting: Arabic ی (U+064A) vs Persian ی (U+06CC) — normalize before matching; split grouped letters per question.
4. Cross-check etiquette: verify answers locally; never overwrite user-confirmed answers without confirmation.
5. If model leaks key lines into question spans, clip locally (clipSpansBeforeKey) and flag.

Example: key page lists "1: ب  2: الف ..." → split per number; map to question nos robustly despite spelling variants.
Never: parse questions from key territory; invent answers where source lacks them.
`,
},
{
  slug:'weak-model-mode',
  content: `---
name: Weak Model Mode
slug: weak-model-mode
status: active
triggers: [weak, free-model, lite, mini, sectioned, wire, bound, economy]
appliesTo: {roles: [fast]}
maxTokens: 900
source: shipped
stats: {injected: 0, followed: 0, greenAfter: 0, redAfter: 0}
---
# Weak Model Mode — Sectioned Parsing & Wire Economy

1. Trigger sectioned mode when: model name contains free/lite/mini/small/tiny or 3-9b or maxBudgetTokens<8192 or lines>220 or expectedQs>25.
2. Bound economy: maxOutputTokens = min(budget, max(2048, ceil(max(lines*12, chars/3.2*0.3)*1.25))); sectioned inherits budget/8 recovery calls.
3. Wire fallback: compact wire v2 {m,s,q} with spans-only; on reasoning prose failure, retry with format-enforced prompt; chunked fallback at 80-line overlap.
4. Sectioned path: one call per locally derived section plan; merge by printed-number identity; detect group children vs retry.
5. Retry futile? If sectioned missing persists after 2 rounds (max 3 sections/round), escalate — do not loop.

Wire issues: 40k-token ramble → sectioned mode; truncated JSON → repairTruncatedJson; zero-add → L2.
`,
},
{
  slug:'user-communication',
  content: `---
name: User Communication
slug: user-communication
status: active
triggers: [communicate, language, confirm, quote, numbers, destructive, cheapest]
appliesTo: {roles: [agent]}
maxTokens: 900
source: shipped
stats: {injected: 0, followed: 0, greenAfter: 0, redAfter: 0}
---
# User Communication — State Numbers First

1. Numbers first: always quote expected/parsed/missing/points before acting; after mutation quote before/after.
2. Cheapest first: L0→L1→L2→L3→L4; never reparse before retry; confirm destructive.
3. Confirm destructive: reparse_section and delete_question require explicit user Confirm; show exact diff.
4. Quote before/after: "Missing 29 → after retry missing 17 (added 9,15,16...)" — measurable.
5. Reply in user's language: detect Arabic script → Persian, else English; harness copy matches.
6. One ask: "a question costs one turn; a wrong mutation costs trust" — ask when unsure.

Do NOT: claim success when health amber; invent numbers from memory.
Example: user fa → respond fa; user en → en; include reset hint for theme actions.
`,
},
];

/** Body of a skill file = everything after the second `---` fence. */
export function skillBodyOf(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

export function shippedSkillTokens(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of SHIPPED_SKILLS) out[s.slug] = estimateTokens(skillBodyOf(s.content));
  return out;
}
