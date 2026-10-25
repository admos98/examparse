# Follow-up #39 — Wing, Not Cage

## Default path

Before (#38 and older):

`Extract → OCR → Cleanup → Text Repair → Classify → Segment → Vision → Structure/per-section recovery → Assemble/gates → old escalation repair → defect repair → consensus → critic/reparse → canonicalize → answer checks → save`

After (#39), exactly five user-visible stages:

1. **Extract** — addressed lines/geometry/images; scanned-page OCR and the optional fenced Text Repair overlay live inside extraction.
2. **Global Read** — canonical `read` role, whole paper in one call when it fits, page-boundary chunks with ten read-only overlap lines only when it does not. Reasoning is forcibly disabled. The response is spans/evidence, never authored question text.
3. **Check** — identity/counting/arithmetic checks only.
4. **Repair** — local model at most twice; then canonical `cloud` role receives exactly one surviving defect and only its evidence. Three rounds maximum.
5. **Present** — saved document plus `computeAttention` survivors. A failed Global Read is explicit and never invokes a code-first parser.

## Removed/demoted default machinery

- Removed deterministic segmenter and its fallback from the orchestrator.
- Removed whole-paper/per-section `structure` calls and the old escalation-repair path from the orchestrator.
- Removed cleanup as a semantic default-path stage.
- Removed consensus and critic from the default path. Their settings default to off; their report-only modules remain available for explicit proving-ground use.
- Removed answer-correction, semantic section surgery, point distribution/defaulting, form canonicalization, and local content decisions from the default orchestrator.
- Removed per-question raw-flag chips from Step 4. Teacher-facing issue counts and rows come from `computeAttention`.
- Kept OCR, Text Repair, memory/playbook/skills, content-hash caches, journals, bundled image captions, exact image ownership/I13, PAPERWORK UI, Library, folder storage, and provider settings.

## Canonical roles

- `read`: whole-document proposal; hard reasoning-off profile.
- `meta`: two tiny header/total reads; hard reasoning-off profile.
- `repair`: bounded local defect fixes.
- `cloud`: defect-only escalation.
- `vision`: OCR, image captions, and one-image metadata tie-break.

Legacy role names remain accepted only for old saved settings/journals; the default path does not call them.

## Test-count delta

- Before: **322 tests**.
- Deleted: **16 tests** whose only purpose was the removed classify/segment/structure/old-escalation pipeline (the #38 AI-first pipeline suite, structure-before/after-vision cache tests, and old T1-wire pipeline replacement/dedup/demotion cases).
- Added: **4 #39 wing tests** covering reasoning defusal + verbatim validator retry, arithmetic Global Read validation, Persian metadata rejection/consensus, and defect-only cloud locality.
- After: **310 tests**.
- Net: **−12 tests**.

The retained lower-level segment/structure tests cover import compatibility and optional report-only tooling, not the default path.

## Acceptance evidence

- Unit suite: **310/310 passed**.
- TypeScript: clean.
- Vite production build: clean.
- Corpus hard gate: **67/67 · 8/8 · exactly 48 · shape 0/0/0**.
- Field-#12 mock: pipeline **65/65**, bare unchecked baseline **52/65**; sections **4/4**, total **40**, shape **0/0/0**.
- Wing comparison: pipeline is at least the scripted bare baseline on every corpus entry and strictly better on Field-#12.
- Bench: **9/9 fixtures PASS**.
