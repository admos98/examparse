# Follow-up #58 — release-repair after the real 71-question replay

Builds on #57 (`0951014`, PR #41). No new framework, no pipeline rewrite, no exam assembly,
no Rust/retraining. The subject of this follow-up is not "make the suite green": #57 was
green (TypeScript, 512/512 tests, bench, build) and the real 1399 package replay still lost
answers and showed false trust states. #58 therefore changes behaviour that the #57 suite had
encoded, and adds tests that assert the *replay findings*, with synthetic fixtures.

## Results in this branch

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (`npm run lint`) | clean |
| `npm test` (all files) | **529 / 529 pass**, 0 fail |
| `npm run bench` | **PASS** (9 fixtures, memory goldens deterministic, Part 2 verifier PASS) |
| `npm run build` (`vite build`) | **built**, only pre-existing `INEFFECTIVE_DYNAMIC_IMPORT` warnings |
| `test/follow-up-58.test.ts` | 17 tests, all pass |
| Real bank adapter + `validateImportBatch` replay | **NOT RUN** — see "External gate" |
| Unattended parent folder of unseen real exams | **NOT RUN** |

`dist/` is not committed and the repo holds no credentials.

## A. Real answers are preserved; proposals are never executed

* `src/utils/bankAnswers.ts` is the single answer planner. It distinguishes **option keys**
  (MCQ / matching / true-false: the printed answer maps to an option key), **text blanks**
  (optionless fill-in-the-blank: the source string survives, one entry per blank, with
  explicitly supplied alternatives as their own accept list), and **descriptive answers**
  (source/keyfile/teacher text, which becomes a non-executing sample with paper/keyfile/
  teacher provenance).
* `correctFillBlanks` is always `string[][]` — `[['century','hundred years'], ['war']]` — so
  "two blanks" and "one blank with two accepted alternatives" can never collapse into each
  other.
* `hasSourceKey(q)` (answer object | imported `answer_key.correct` | imported
  `correctFillBlanks`) is the honest "is this item actually keyed?" test used by attention
  and explanation visibility. "Can the destination represent it?" is a different question,
  answered by `planBankAnswer`.
* Legacy AI Solve answers, stored `answer.source:'ai'`, and new checker proposals
  (`enrichment.proposedAnswer`) are proposals. They never populate `answer`,
  `answer_key.correct`, `correctFillBlanks` or any other executable field. Only an explicit
  teacher save commits. Keyless optionless blanks get a `proposal-check` vote (0.80
  threshold), and the candidate remains in the review payload.
* A judge disagreement or uncertainty adds `answer_key_needs_review`; it never deletes a
  genuine `paper`/`keyfile`/`manual` answer.

## B. Durable samples, rubrics and teacher work

* Model samples + 2–4 rubric criteria are generated in the explain batching (≤4 per call,
  same instruction group), and the sample and rubric are judged separately (0.80 / 0.20).
* A teacher-confirmed version is never overwritten by a rerun. Teacher artifacts carry the
  evidence fingerprint from the moment of confirmation; if the task changes, the artifact is
  kept and exported with `reconfirm: true` instead of being deleted or silently kept
  "verified".
* An imported artifact of unknown state never becomes verified.
* Rubric arithmetic: a valid model distribution is preserved; a mismatched but representable
  total gets an exact even split (e.g. 0.125×4 on 0.5, 1.5+1.5 on 3); an unrepresentable
  split (1/3) stays pending. Negative weights and mixed positive/zero weights are rejected as
  malformed; zero/absent weights only get an even split when a printed total exists. No
  printed points means no invented points.
* Salvage: `repairTruncatedJson` is string/escape aware, nested objects are recovered,
  `salvageJsonObjects` reports generated/verified/uncertain/rejected/unjudged/missing
  counts, and a missing part gets exactly one scoped retry.

## C. Right evidence for the right check

* The sample writer and the sample/rubric judges receive the addressed image bundle for that
  question, and the mapped listening script for that section. A check that needs a picture or
  a script is forced `unjudged` (`evidenceComplete` gate) when the pixels/script are missing
  — never `verified`.
* One addressed bundle per call, at the local limit (`decisionImageLimit`, default 4). If a
  bundle cannot be sent and splitting is not authorised, the visual checks stay unjudged with
  one concise explanation; nothing is split, sent to the cloud, or guessed from a caption.
  The rest of the exam still runs.
* Image placement is addressed with real candidates: same-section questions within ±3 known
  numbers, or questions with a known image on the same page — never the whole paper. The
  source/teacher answer is used as placement evidence only (`sourceAnswer`), never inserted
  into the blind-answer question. With no candidate and no source answer the check is
  `skipped-no-evidence`; the app does not invent a placement question.
* Q51/Q52 (home/family picture flagged 0.57; tired pupil picture incorrectly verified) are
  not hardcoded: they are covered structurally by the candidate restriction, the source
  answer use, and the "never verified on incomplete evidence" gate.

## D. Package integrity

* One asset pool per export (`assets/` + `assets/manifest.json`), one file per SHA, and
  per-part manifests (`part-N/assets-manifest.json`) so a part can resolve the shared pool.
  The 11/11 SHA-verified stem-image result from the replay is preserved; this follow-up fixes
  the missing and option-image cases.
* Unresolved placeholders are **retained in metadata** (`unresolved_placeholders` with the
  asset id and known SHA) and reported (`report.missing_assets`, `export-report.json`,
  `preserved/answers.json`). They are no longer rendered as a `missing:<sha>` image block or a
  placeholder token in student content, and removing a placeholder leaves no empty brackets.
* Inline `data:image/...` option URIs never leak base64: the picture is extracted to the asset
  pool, the textual option stays intact, and the question carries
  `option_image_unsupported` + `unsupported_option_images` + a contract pending entry.
* Per-section listening scripts remain non-student-facing evidence (structured export and
  judge payloads only).
* Essay/paragraph/writing/explicit-`long_answer` items become `long_answer`; a source item
  labelled short_answer whose task asks for a paragraph keeps its source type and gains
  `type_suggestion_long_answer` plus a report note (17D).
* Multipart packages: parts declare `part_index` / `part_total`. Import requires contiguous
  1..N parts, one base batch id and a matching declared total; otherwise it throws before
  import and reports the missing parts. The root ZIP and the parent folder both reconstruct
  one logical package with the shared pool; no partial success is reported.

## E. Honest provenance, inheritance and review

* Actual `source_type` is kept (no title → `official_cited`, no claimed → authored remap
  without opt-in). `official_cited` without an explicit source ref is rejected at export.
* Unknown pages/groups are not defaulted: no page → no fabricated `p.1`; no group → no
  section-index-as-group.
* Inheritance only for individual votes that genuinely abstained; a confident 0.90
  outside-book vote is never overridden, and inherited provenance is carried to the bank or
  disclosed.
* `computeAttention` stays the single source of truth; header, chip, list and Library count
  the same grouped items. A quiet state says "verified" only when a required check passed
  against current evidence. Keyless true/false and keyless descriptive items are attention
  items, never "0 attention · 2 verified". `needs_rubric` clears only on a teacher-confirmed
  valid rubric, and missing rubric is distinguished from an absent auto key.

## F. Live progress

* `PackageAnalyze` shows `Exam i / N · <phase>`, decision calls completed vs an
  honestly-changing estimate (`planned` raises it), current check label, errors/skips, and a
  collapsible live stream. The stream reuses the single generative call (`onDelta`) — no
  duplicate model call — and journals the same way as the existing explanation path.
* Step 1's parent-folder import shows `Exam i / N` plus a collapsible live log fed by the same
  `EnrichmentEvent` stream. The PDF Step-3 live view is untouched.

## G. Acceptance evidence (`test/follow-up-58.test.ts`)

Synthetic fixtures only; the mocks prove control flow, not model accuracy.

1. Source answer types in both exports: option key, optionless blank, multiple blanks with
   alternatives, descriptive sample, keyless short/long, teacher edit.
2. Proposals and legacy AI Solve never fill an executable field; byte-identical executable
   snapshot with and without proposals; teacher save is the only commit.
3. Fractional rubric validity and rejection of unpriced/malformed weights.
4. Nested-object salvage plus one scoped retry with separate counts.
5. Sample/rubric/explanation judges receive the addressed bundle and the mapped script only.
6. Missing pixels / over-limit bundle → unjudged with one explanation, no split, no guess.
7. Teacher artifacts survive a rerun; a changed task asks for reconfirmation without deleting
   teacher work.
8. Imported artifact of unknown state never becomes verified.
9. >50-question export: one asset pool, every part resolves it, both root and parent import,
   missing part reported, no base64/token leaks.
10. Picture options ship the file and an explicit review state without base64.
11. Unresolved placeholder retained in metadata/report, never as student content.
12. Keyless true/false and keyless descriptive are never "verified".
13. Provenance/page/group/label preserved, never fabricated.
14. Image placement addressed with nearby candidates and a source answer, skipped when the
    evidence is absent.
15. Live progress: honest phases/estimates, `Exam i / N`, isolated failures, streamed output
    from the same single call.

Plus the existing #52–#57 tests (529 total, all passing).

## Contract status — not verified

`src/utils/bankContract.ts` holds the 12 exact questions that must be answered by the bank
side (optionless blank wire shape and `correctFillBlanks` mapping; keyless import vs publish
gate; descriptive sample/rubric input shape and provenance; `needs_rubric` / teacher
confirmation; claimed provenance and opt-in remapping; inherited-hint metadata; picture
options and missing assets; teacher-only listening evidence; >50-question manifest
resolution; matching/ordering/true-false shapes; and the real adapter invocation).

The default profile is `bank-v2-provisional`; `appendix-a-1.1` writes only the provable
option-key `answer_key` into `batch.json` and carries the rest losslessly in
`preserved/answers.json`. Every export report and every `contract/requests.json` says
`verified: false`, and the UI shows an unverified-contract banner. No unvalidated ZIP is
described as bank-ready.

## External gate — NOT RUN

The following are **not** results; they are the required gate, still pending:

1. Replay the real 1399 package through the native ZIP using the **other agent's actual
   adapter** and its `validateImportBatch` (not a same-named local copy).
2. Inspect the resulting bank records: 71 questions; 32 MCQ keys; 14 fill-in-the-blank; 17
   manual samples; 8 keyless tashrihi items legitimately teacher-graded; correct tags; 11
   source-matching stem assets across both chunks; per-section listening evidence present and
   non-student-facing.
3. Then run an unattended parent folder of unseen real exams, with no manual repair, and keep
   every judge error as a review item rather than a silent pass.

What must be supplied to run it: a checkout/wheel of the bank import path exposing the real
adapter and `validateImportBatch`, plus the 1399 package bytes. Until then this document and
the app report `verified: false`.

Correction retained from the replay: "0 images to place" in Step 4 counts *unassigned*
images; it did not mean zero exported. An offline replay of the structured export with the
original bytes placed 11/11 source-matching SHA-verified stem images. That positive result is
kept; #58 only fixes the missing/option-image cases.
