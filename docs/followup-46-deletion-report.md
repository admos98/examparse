# Follow-up #46 — The Local Loop

## Default path

Before (#39–#45):

`Extract → OCR → optional Text Repair → Classify → Global Read (spans) → meta reads → Vision → Check → bounded local Repair → cloud escalation → consensus/critic/cleanup → canonicalize → Present`

After (#46), the default spine is:

`Extract/OCR/bundled local captions → READ → SELF-REVIEW → CODE CHECK → CODE-VERDICT FIX → DECISION AUDIT → FINAL FIX → Present`

The working artifact is now the model-authored JSON document (`ExamDoc.loop.document`). The PAPERWORK projection (`questions`, `sections`, `meta`) is derived from it with empty spans. Boundary hints such as `stemFrom/stemTo` are retained as advisory metadata and never used to slice text.

## The six steps

1. **READ** — one local generative `read` call per extracted page, with the previous page's last 30 lines as read-only context. The model authors complete question objects: number, section title, type, full stem, options, printed answer/points, image ids. Same number + section on a later page is merged as a continuation. Complete-object salvage applies to truncated JSON; zero salvage is a note, not a fatal error.
2. **SELF-REVIEW** — a fresh `read` call receives the merged document plus the original source text (or section/page chunks when too long). It returns only full-object corrections: replace/insert by number, duplicate deletions. Unparseable output skips that chunk with a note.
3. **CODE CHECK** — comments only, closed vocabulary: `invalid-json-remnant`, `duplicate-number`, `missing-number`, `empty-stem`, `options-missing-for-type`, `points-sum-mismatch`, `image-unassigned`, `image-double-assigned`, `meta-field-implausible`. No content mutation and no gate.
4. **CODE-VERDICT FIX** — one generative patch pass over flagged full objects + their source-page text + the verdicts. Implausible metadata includes first-page header lines for reread. There is no separate metadata stage and no vision tie-break.
5. **DECISION AUDIT** — optional local `decide` endpoint using the #43 typed probability catalogue. Each item receives the full question + source-page text. Image items receive pixels on a multimodal build, otherwise caption + candidate stems. Choices are `this question / another question on the page / no question`, normalized to the positive frame. Comment-only. Shadow mode routes nothing; active mode routes confident-wrong (`p ≤ 0.20`) items to step 6. Missing/erroring endpoint skips with a note.
6. **FINAL FIX** — one generative patch pass over active routed objects/source + quoted audit verdicts, then stop. Each question is sent at most once per patch step, with all of its verdicts.

Save happens after READ and after every applied patch. Extraction text guarantees a document shell even when every model step throws, including a replayed image-payload failure. No default counter can abort, discard, or block a save.

## Removed/demoted default machinery

- Removed span slicing/line accounting from the default path. `spans`, forms, field replay, and the old page-retry cloud fallback remain exported only for legacy/Assistant/proving-ground use.
- Removed `repair`, `cloud`, `classify`, and separate `meta` stages from the default orchestrator. Legacy settings are tolerated but never called by the loop. `cloud` remains available to Assistant.
- Removed the default-path Budget / Execution Stop abort class. Preflight estimates and the settings budget threshold are display-only. `agentLimits` no longer bounds the loop.
- Removed consensus/critic/cleanup/read-format controls from the default settings surface; they remain in saved profiles and the Assistant/proving-ground disclosure.
- Kept the #45 streaming enumeration circuit-breaker as a pathology guard. With `salvagePartial`, a counting generation returns the partial stream (`finishReason: 'counting-loop'`) instead of throwing an abort class.
- Output allowance is generous: at least 16384 tokens, growing with page text, capped only by the server's 65536 transport limit.
- Vision captions run bundled before READ. Failure degrades image placement with a note; it never aborts.
- Step-4 page retry for loop documents is local-only. There is no cloud fallback.
- Memory playbook/skills injection and content-hash caching are retained. Reflection is disabled for the loop so there is no seventh generative call.
- The decisions transport now goes through a thin validated `/api/decisions` server proxy (typed probability/choice payloads, optional image pixels) instead of a direct browser-to-provider fetch.

## New modules

- `src/pipeline/localLoop.ts` — authored-document core: normalize/salvage/merge/corrections/code verdicts/projection/prompts/chunking.
- `src/pipeline/localLoopRunner.ts` — six-step orchestration, per-step notes/receipts, page cache, save/step callbacks, patch batching.
- `src/pipeline/loopAudit.ts` — comment-only decision catalogue, cache, shadow/active routing, pixels vs caption-only.
- `src/pipeline/localProvider.ts` — local-only provider guard shared by the loop and page retry.
- `src/pipeline/loopFlags.ts` — receipt → parse-report flags.
- `src/components/LoopReceipt.tsx` — collapsible per-step receipt shared by Step 4 and the parse report.
- `scripts/corpusLoop.ts` — scripted-generative corpus mode (authors full JSON from source text only; truth is used afterwards for reporting).

## Corpus

`npm run corpus` now defaults to the scripted-generative loop mode and reports questions/sections/points against printed truth for all 14 entries, including `mock-born-digital`, with **no hard gates**. The old wing/bare comparison and reviewed-only gates remain available explicitly via `npm run corpus -- --legacy` for the proving ground; that legacy run still passes.

Loop-mode scores are honest report-only measurements of the deterministic scripted reader, not provider results. Several fixtures print marks at section level rather than per question, so the scripted reader reports `0/N` points there; the loop surfaces the resulting `points-sum-mismatch` comments instead of inventing or distributing marks.

## Test-count delta

- Before: **359 tests** (`baseline-tests.log`).
- After: **367 tests**.
- Net: **+8 tests**.

Adjustments to removed-spine tests (no wholesale deletions):

- `test/page-wise-global-read.test.ts`: the two old pipeline-level #40 acceptance tests (cloud rescue / all-pages-fail spine expectations) were replaced in place with two #46 loop tests: page-wise local retry + never-empty shell.
- `test/read-allowance.test.ts`: the old #41 starvation/cloud-rescue pipeline test was replaced in place with a #46 local-only no-cloud/no-budget test. Lower-level `globalRead` allowance tests remain as legacy/proving-ground coverage.
- `test/read-format.test.ts`: the stream-breaker test now expects a salvaged partial (`finishReason: 'counting-loop'`) rather than a rejected `CountingLoopError`, matching the pathology-guard-not-gate rule.
- Four legacy corpus callers (`field-batch`, `godlike-batch1`, `marvel-final`, `marvel6-final-pass`) now request `mode: 'legacy'` explicitly so they continue to pin the old proving-ground gates without making them loop gates.

Added:

- `test/follow-up-46.test.ts` — 7 tests: patch replace/insert/delete + unknown-number note; duplicate-number and points-sum verdicts; audit unconfigured skip; multimodal pixels vs caption-only; shadow routes none / active routes confident-wrong exactly once; never-empty fault injection through the real pipeline with every model stub throwing; corpus loop mode reports every entry + mock without gates.
- `test/llm-role-parity.test.ts` — 1 test for the `/api/decisions` payload/image validator.

## Acceptance evidence

- `npm run lint` (`tsc --noEmit`): clean.
- `npm test`: **367/367 passed** (`final-tests.log`).
- `npm run build`: clean (`final-build.log`; only pre-existing ineffective-dynamic-import warnings).
- `npm run corpus`: 14 loop-mode entries reported, no gates.
- `npm run corpus -- --legacy`: PASS (reviewed-only gate + acceptance hard gate; 0 provider calls).
- Fault injection at every step completes Present, saves the extraction shell, and records per-step notes; it never reaches a top-level “Analysis failed.”
