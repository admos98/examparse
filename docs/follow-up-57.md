# Follow-up #57 — closing batch: judged sample answers, proposals, travelling images, attention-first review

Builds on #56. The judge's thresholds and instructions are unchanged (0.20/0.80, demand
inference as measured); `source_type` values are never remapped (claimed stays claimed);
there are no exam-assembly branch rules and no changes to blind verification, image choice
or script mapping beyond referencing their assets.

## Sample answers and rubrics (tashrihi items)

For every keyless descriptive item (short answer, paragraph, essay, imported `long_answer` /
writing types) the local generative role writes a model sample answer — a whole paragraph for
a paragraph task, one sentence for a topic-sentence task — and a rubric of 2–4 criteria whose
`maxPoints` sum to the item's points, in the same explain-stage batching as explanations
(≤4 per call, salvage, one retry). The decision judge grades each artifact with a single
clause ("This sample answer correctly completes the task as asked." / "This rubric grades
exactly what this task asks, at the stated points."): ≥0.80 verified, ≤0.20 rejected
(record-only — suppressed from both exports), in between uncertain (structured export only;
the student-facing bank carries only verified artifacts). Nothing about grading changes
until the teacher clicks: Step 4 shows "model sample + rubric proposed — confirm or edit",
the item keeps `needs_rubric`, and a confirm/edit stores the artifacts as teacher-confirmed
(provenance flips, the tag clears). Descriptive question types travel to the bank as
`long_answer`; `short_answer` stays `short_answer`. Absence of sample or rubric never
blocks an export.

## Proposals are never executed

For a keyless auto-graded item (MCQ / fill-in-blank / matching with no package key) the
checker may propose an answer — but it is stored only as `enrichment.proposedAnswer` and
surfaced in the attention list ("checker proposes B — adopt?"). No code path, including
re-export, ever writes it into `answer`, `answer_key` or any executable grading field; the
structured and bank exports are byte-identical in those fields with and without the
proposal. The Step 4 adopt button pre-fills the key editor from the proposal; the commit is
the teacher's save, stored as teacher-entered with the proposal marked adopted. Until then
the item stays keyless everywhere downstream and carries `answer_key_needs_review`.
Pixels-less questions (an attached picture the checker cannot see) keep the existing
evidence gate: no proposal, still listed as keyless.

## Images travel

Package stems that carry placeholder tokens (`img_<sha>`, `img_<sha>stem`, markdown
`assets/<sha>.<ext>`) resolve those references at import: the asset attaches at the token
position, the token leaves the stem, and a token with no matching file becomes an explicit
warning flag — never student-facing text. Step 4 renders the actual image (token-form ids
display as a short reference, never raw). The bank export emits Appendix A v1.1: files named
by SHA-256 under `assets/`, a manifest mapping asset id → file/sha/mime/byte size, and stems
that reference assets by hash only. Shared assets live once in the pool and are referenced by
every owner. When pixels are unavailable the question exports with an explicit
`missing:<sha>` marker plus a report entry instead of failing silently or dropping the
reference. The export report counts truthfully: `images_placed` (files emitted) beside
`image_references` (questions referencing them), so "0 images" is impossible when
references exist.

## Attention-first Step 4

The default Step 4 filter is **Needs attention**: disagreements, uncertains, keyless items
(by kind — tashrihi awaiting confirmation, auto-graded keyless with or without a proposal),
image mismatches and rejected-explanation items, grouped in that order. The header count,
the collapsed chip and the visible list all read one function, so the number always equals
the rows. Verified and quiet items collapse into a single "N verified · show" line that
expands and is searchable. Every list, note and flag identifies questions by label
(`17C-a`, `55B`), never by the bare number. Completeness probability is shown only where it
produced a corroborated flag; confidence now falls back verification → demand → null.

## Passage lessons, provenance and notes

Each factored passage is judged once for its lesson; member questions whose own vote
abstained (no hint under the ≥0.50/margin rule) inherit the confident passage lesson, stored
as `curriculumSource: "inherited"` — teacher and confident individual votes always win.
Bank `source_ref` is the compact physical reference
`<file> · p.<page> · item <label> · group <n> (<total>)`, ≤200 chars; the full prose
reference stays in the structured export only. Enrichment notes lead with the final state
("explanations: 60 of 63 keyed; 2 rejected by the checker"); intermediate
malformed/retry narration appears only when the outcome is incomplete, as one counted
summary line.

## Validation

TypeScript and production build pass. **512 tests pass (+6** versus the 506-test #56
baseline); `test/follow-up-57.test.ts` covers the six Part-F acceptance gates with scripted
models — sample/rubric generate→judge→route with teacher-only promotion, the B.3
propose-never-execute byte assertion, a complete v1.1 asset manifest with zero placeholder
tokens in any exported stem, header count == visible list with labels in every row,
non-overriding marked inheritance, and compressed refs ≤200 chars — plus an unattended
parent-folder batch-import → chain-enrich field proxy whose exports pass an Appendix-A
adapter check with expected-state notes only. The Part-F field protocol on a folder of
previously unseen real exams remains the acceptance gate for release; run it per
`docs/package-import-enrichment.md` before merging to a released branch.
