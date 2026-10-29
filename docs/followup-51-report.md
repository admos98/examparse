# Follow-up #51: Visual map audit and six phases (check, then fix once)

Builds on #50. The #46 law is unchanged: checkers only comment, only the generative model patches, nothing aborts a save, and everything runs locally by default. This batch adds no new checkers, no new verdict kinds, no threshold changes and no cloud calls. `DECIDE_CATCH`/`DECIDE_PASS` stay at 0.20/0.80.

## The pipeline, in order

| # | Phase | What runs | Generative calls | Decision calls | Saved |
|---|---|---|---|---|---|
| 1 | **Extract** | Text layer, #50 hygiene (digit twin, watermark), OCR | none here (OCR is counted on the row) | none | — |
| 2 | **Map** | Generative map → code count → decision audit (**text + visual**) → re-map of indicted entries only | map, scoped re-maps | map audit | **no** (no document yet; an empty save would overwrite a good one) |
| 3 | **Parse** | Each section against its contract; #50 re-read rule; cloze blanks; one unmapped-number parse; page parse as the never-empty fallback | section parses | none | yes |
| 4 | **Check** | Code verdicts, then the decision audit (catalogue + difficulty/curriculum hints, live progress). Both only comment. Output: **one merged, source-tagged verdict list** | none | full catalogue | yes |
| 5 | **Fix** | **One** generative patch pass, batched by section | one per section batch | none | yes |
| 6 | **Present** | Re-check: code re-runs (0 model calls); the decision audit re-votes only items Fix **changed** or that were **confidently indicted**. Surviving verdicts become the attention list | none | changed + indicted only | yes (plus the app shell's final save) |

`receipt.timeline` records what ran, collapsed into `{phase, event, count}` entries. On the acceptance fixture it reads exactly:
`map:generate → map:code → map:decide → parse:generate → check:code → check:decide → fix:generate → present:code → present:decide`.

## Part A: Visual map audit

- **When it runs:** only if the decide endpoint is marked multimodal (`settings.decideMultimodal` or the provider's `multimodalDecisions`, i.e. the existing mmproj flag), and only if a page image is available.
- **Page images:** it reuses the page image OCR already rendered (`extracted.pageImages[i]`, falling back to the stored page thumbnail). Nothing new is stored.
- **New noul items:** three kinds, each carrying exactly **one** page image.
  - `section-start-visible` (one per section). The claim is "The map claims a section titled '<title>' begins on this page (question <first>)." The page comes from the printed line of the section's first question, or from its `(n)` blank.
  - `pictures-present` (one per page the map places images on). The claim is "This page contains one or more pictures that exam questions refer to." The page comes from `ImageAsset.page`. One vote applies to every map image on that page.
  - `passage-visible` (one per mapped passage). The claim is "This page contains a distinct reading-passage text block." The page comes from the line matching the start of the passage text, or else from the line of its first question.
  - If the text gives no evidence for a page, no item is built. The audit never guesses a page.
- **Request formats:**
  - THX: `images: ["data:image/…;base64,…"]` at the top level, matching what llama.cpp `/v1/systemone` accepts.
  - JEV: `questions[0].images: [{id,mime,data}]`.
  - The server proxy now validates THX images (at most 8, data URLs only, 32 MiB limit).
- **Routing** is identical to text votes:
  - Confident-wrong in active mode indicts the entry and triggers the scoped re-map (#49 1d). The re-map prompt quotes `… p=0.05 (seen on the page image)`.
  - An uncertain vote marks the entry.
  - Shadow mode only reports.
  - New `unchangedIndictment` rules (plus a generic "identical entry" fallback) make sure an unchanged re-map cannot clear a visual indictment.
- **Failures never silence the text referee:**
  - Visual items run after the text items and keep a separate error count.
  - A failed item is skipped and counted in `map.visualAudit = {items, voted, skipped}`.
  - After 3 consecutive image errors, the remaining visual items are skipped without making a call.
  - If the text audit already stopped because the endpoint was down, no visual items are attempted.
- **UI:** in the map outline, each entry shows **seen ✓** (visual pass), **seen ?** (uncertain), **seen ✗** (visual catch) or **text only**. Markers appear only when a visual audit actually ran, so the legacy outline is unchanged.
- **Related fix:** `buildThxDecisionBody` used to drop `item.images`, so THX `image-belongs` never saw any pixels even on an mmproj build. It now attaches them.

## Part B: Check, then fix once

### Merged verdict list (Check)

`mergeVerdicts(code, decision, DECIDE_PASS)` decides when both checkers flagged the same thing. It only takes part when the decision vote is below the pass line. It is a fixed mapping between kinds that already exist; no new kinds are added:

| Concern | Code kinds | Decision kind |
|---|---|---|
| stem | `empty-stem` | `stem-faithful` |
| complete | `options-missing-for-type`, `passage-missing`, `passage-link-missing` | `complete` |
| contamination | `passage-in-stem` | `uncontaminated` |
| section | `section-range-mismatch` | `belongs-in-section` |
| image (keyed by `imageId`) | `image-unassigned`, `image-double-assigned` | `image-belongs` |

When both checkers flag the same item for the same concern, the result is **one** verdict:
- it keeps the decision probability;
- `sources: ['code','decision']`;
- `merged[]` quotes both original messages.

### Fix (one pass)

- **In scope:**
  - every code verdict, including merged ones;
  - confident-wrong decision verdicts (p ≤ `DECIDE_CATCH`) in active mode.
- **Hints:**
  - Uncertain decision verdicts (between `DECIDE_CATCH` and `DECIDE_PASS`) are passed as hints, e.g. "the audit is unsure whether Q14 is complete — check it while you're here; change it only if the source shows a defect".
  - A hint only joins a batch that already exists. It never causes a call on its own.
- **Shadow mode:** the fixer sees code verdicts only. No decision probability reaches it.
- **Batching:** batches follow the section of each question (`sectionTitle`, or the map range for missing numbers), at most 12 flagged questions per batch. Document-level verdicts (meta, image-only) ride in the first batch.
- **Each batch carries:** the flagged question objects (each question sent once), their source pages, and every verdict on them with `sources` / `probability` quoted.
- **Applying patches:** corrections come back by number through the existing patch machinery (#47 stem disambiguation, `mergeDuplicates`, points withdrawal, meta correction).
- **Retries:** the #50 one-retry rule still applies. There are no loops.
- **Receipt:** `changedQuestionNumbers(before, after)` records what Fix actually changed. The comparison ignores Check's own tags (difficulty, curriculum, source pages).

### Re-check (Present)

- The code check runs again with **zero** model calls.
- `runLoopDecisionAudit({ recheck: { previous, revote } })` re-votes only items whose question changed, or whose decision verdict was confidently indicted. These calls bypass the persistent cache.
- Every other item reuses its Check vote. Items with no Check vote stay unvoted, so a re-check never widens the audit.
- Difficulty and curriculum tags are re-applied to replaced questions.
- `receipt.survivingVerdicts` is the merge of the post-fix code verdicts with the post-fix decision votes. This is the attention list. Decision-only verdicts are now shown as plain sentences, e.g. "The audit judges Q4 likely not faithful to the printed stem (sound p=0.05)."

**Economy on the acceptance fixture** (60 questions, Fix changes 3):

| | Decision calls |
|---|---|
| Check | 600 |
| Present re-check | **30** (= every catalogue item of Q2, Q4, Q50) |
| Reused | 570 |

Code re-check: 0 calls. The repaired defects (two empty stems, one invented stem) do **not** survive. The three remaining survivors are the fixture's `meta-field-implausible` comments, because no total is printed.

### Receipt and UI

- **Receipt:** `LOOP_PHASES = ['extract','map','parse','check','fix','present']`, with `LOOP_VERSION` set to `local-loop-v2`.
- **Per-phase row:** calls (generative and decision), patches applied, verdicts raised, closed and **carried** (new).
- **Step 3:** shows exactly these six phases with the same names, and the map outline (with seen markers) sits directly under **Map**, before **Parse**.
- **Phase summaries:** each phase's summary line goes on its own row only. It never becomes a teacher attention note.
- **Legacy exports:** v1 receipts with the old step ids (`read`, `self-review`, `code-check`, `code-fix`, `decision-audit`, `final-fix`) still parse and render, labelled "(legacy receipt)" (`LegacyLoopStepId`). The old `forceStages: ['read']` alias still forces Map + Parse.

## Part C: Deleted / demoted (for the PR)

**Deleted:**
- The **self-review** step: its call, the `LOOP_REVIEW_SYSTEM` prompt and `buildReviewChunks`. Its useful instructions are now part of `LOOP_FIX_SYSTEM`: catch wrong or incomplete text, duplicated or missing questions, and material belonging to another question; return whole objects only, never field patches; return `{"corrections":[]}` when there is nothing to fix.
- **Final fix** as a separate phase. Confident-wrong decision verdicts now go to the single Fix pass.
- **Code-verdict fix before the audit**, which was an ordering inversion: a patch ran before the second checker had commented.
- The private `chunkVerdicts` / `closedVerdictIds` helpers. Section batching replaces them, and closure is now decided by the re-check.

**Not deleted:**
- map audit and re-map;
- the #50 section re-read rule;
- scoped re-asks inside Parse (unmapped numbers);
- the patch machinery;
- the decision catalogue;
- shadow and active modes;
- bank export, difficulty and curriculum tagging (they ride on the final document, untouched).

## Verification

- `npm test`: **434 / 434 pass.**
  - Delta vs #50 (420): **−1 + 15**.
  - Deleted: "self-review retries malformed output only once" (the step no longer exists).
  - Added: 15 in `test/follow-up-51.test.ts`.
  - Rewritten to the new phases (same intent): #46 audit routing, #46 fault injection, #48 fix retry, #50 caps / fix-salvage / blank-missing / re-read, #49 outline text, and the page-wise loop stage list.
- `npx tsc --noEmit`: clean. `npm run build`: OK.
- **Corpus (scripted loop) vs the #50 baseline:** all 15 entries have **identical** questions, sections, points and surviving-verdict counts. Teacher notes dropped by 1 per entry; that note was the deleted Final fix's "skipped" line.

| Acceptance | Test |
|---|---|
| 1 Phase order | `#51 phase order …` (timeline plus raw call log: only decision calls between the last Parse call and Fix; one Fix call; zero self-review/final-fix calls) |
| 2 Merged verdict | `#51 merged verdict …`, `#51 merge unit …`, `#51 shadow mode …` |
| 3 Re-check economy | `#51 re-check economy …` (re-votes = changed + indicted items, exactly; 0 generative calls after Fix; repaired defects gone) |
| 4 Visual | `#51 visual: …` ×6 (one payload per item in THX and JEV; visual indictment → scoped re-map; uncertain/shadow → none; image errors skipped and counted while text votes land; non-multimodal → zero items; runner wiring + server validation) |
| 5 No regressions | full suite, corpus diff, tsc, build; #48 bank export / difficulty tests unchanged and green |
| 6 UI / receipt | `#51 UI …`, `#51 receipt …` (incl. legacy v1 rendering), `#51 attention …` |

## Files

- **New:** `test/follow-up-51.test.ts`, `docs/followup-51-report.md`.
- **Modified:**
  - Pipeline: `src/pipeline/localLoop.ts` (phases, merge, batching, Fix prompt), `localLoopRunner.ts` (six-phase runner, rewritten), `mapFirst.ts` (`runMapPhase` / `runParsePhase`, visual audit, `seenMark`), `loopAudit.ts` (THX images, `decideIsMultimodal`, `recheck`), `index.ts` (stage ids, page-image source, usage roles).
  - Server and types: `server.ts` (THX image validation), `src/types.ts`.
  - UI: `src/views/Step3Analyze.tsx` (`initialLoopStages`, `LoopPhaseList`), `src/components/MapOutline.tsx`, `LoopReceipt.tsx`, `SettingsModal.tsx` (labels).
  - Other: `src/utils/attention.ts` (plain sentences), `scripts/corpusLoop.ts` (phase step ids), and the tests listed above.
