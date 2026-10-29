# ExamParse surgical evolution — implementation report

## Parts A–F
- **A — done:** one canonical matching pipeline, original-text slicing, multilingual key/option/title hints, complete printed-set enumeration, two-line/240-character stem window.
- **B — done:** conservative gutters with ambiguity warnings, position-aware repeated furniture, diagnostics/error flags, and page-crop merged image metadata. Real Chromium/PDF.js smoke testing covers a six-page, two-column PDF and actual embedded strips/crops in addition to synthetic fixtures. Corroborated gutters tolerate wide titles; known page geometry protects repeated body options from furniture tagging.
- **C — done:** folder-only exam/image/cache/journal/usage/calibration persistence, blocking setup, separate clearing UI, and the permitted legacy-banner path plus read-only JSON export.
- **D — done:** bounded durable harness and all 20 requested tools; section reparse prepares/validates a candidate, persists its complete before/after diff, waits for explicit consent, revalidates on commit, and rejects human edits (including source-only edits). Assistant nav opens a dedicated page; Step 4–5 contextual verification uses a single panel instance. Human-facing harness/status/refusal/verification/error summaries are Persian/English; machine JSON and technical diagnostics remain machine-readable.
- **E — done:** ten versions, Undo, monthly soft cap, local/server locks, optimistic writes, offline regressions, import firewall, and local health without a model.
- **F — done:** existing TypeScript/runtime/provider stack retained; no execution framework or new dependencies. Existing 23 tests remain green.

## Acceptance (1)–(10)
1. **PASS** — 7 corpus variants each assert the exact printed set `[9,15,16,17,18,31,63,64]`, three key-territory lines, and digit/number false-positive exclusions. Arabic U+064A/U+0643 and Persian U+06CC/U+06A9 spellings are included.
2. **PASS** — byte-identical source JSON and unchanged Unicode stems, options, and grouped answers; no extraction `text: value.normalize(...)` assignments.
3. **PASS** — 3 RTL header segments recover `شنیداری Listening` without digits; crossed-gutter case retains 1 legacy-ordered cluster with an ambiguity flag. Genuine six-page two-column PDF: **12/12** expected numbers, **90** stable source addresses; wide title does not flatten body columns.
4. **PASS** — 6-page furniture fixture retains all 30 line IDs/texts and an identical known-question span slice. Four-of-six repeats tag; three-of-six do not. Furniture is omitted from questions/passages/enumeration. With known PDF geometry, repeated body options/passages are protected; the real six-page PDF tags **6** running headers and preserves body text.
5. **PASS** — 6 strips + 2 photos yield exactly 3 geometry groups; merged bytes/hash/dHash/anchor are replaced by crop-derived values (anchor 1 → 8). Genuine PDF.js run: **8** embedded images → **3** persisted assets / **5** merged strips, with stored bytes matching SHA-256, crop dimensions and a recomputed 16-hex dHash.
6. **PASS** — zero removed-package references in project files; real server begins unconfigured/503, persists folder selection, and clears 3 buckets independently while 2 exam/image SHA-256 hashes remain unchanged per clear.
7. **PASS** — Iranian-header/key fixture: expected 67, parsed 38, missing 29, points 25/48 → retry → locally green 67/67 and 48/48, with **2 model calls / 3 tool executions**. Malformed recovery uses 3 calls; forbidden actions mutate nothing. Initial pack: **376 characters / 383 UTF-8 bytes**. Construction limits the pack to 1,200 bytes and tool results to 600 bytes, tokenizer-independent upper bounds for byte-fallback tokenizers.
8. **PASS** — mock chat applies `primary=#EAB308`; settings reload retains it; reset restores defaults. Invalid token and non-color both fail validation (2 refusals). Real browser chat changes the CSS variable/local settings and actual Settings Reset restores defaults.
9. **PASS** — agent mutation Undo restores questions by deep equality; destructive proposal has 0 mutations/0 snapshots before confirmation. Server retains 10 versions after 12 changes and restores exactly. A stale CAS write is rejected with 409 and unchanged file hash. Real browser section consent survives reload with **0** replayed preparation calls; exact replacement uses **3** actual upstream calls, preserves the other section, retains cumulative cost, and Undo restores full content/flags.
10. **PASS** — offline no-provider health path makes 0 model/network calls with empty usage. Fresh import yields a source-only 0/67 draft. In the actual UI, transcript/usage persistence still uses the local folder HTTP API; **no provider network call** is made. Actual browser/PDF import + local Assistant health likewise makes **0** `/api/llm` requests.

Build checks: `npm install --legacy-peer-deps`, `npx tsc --noEmit`, `npx vite build`, and `npm test` exit 0. **66/66 tests pass**, including all original 23. Build emits non-fatal large-chunk/dynamic-import warnings. npm reports **3 moderate advisories** in the existing dependency tree; no forced breaking upgrades were made. **27 real headless-Chromium smoke checks also pass**, using the actual app, PDF.js, folder API, proxy, existing streaming/structure adapter and a local OpenAI-compatible mock (10 upstream requests across multiple turns). No paid-provider/OCR/vision network calls or manual cross-browser visual certification were performed.

## Additional real-browser verification
The optional smoke runner uses its own temporary production server/config/data folder and a local mock HTTP provider, then cleans them up. It does not select or clear the user's folder. All remote browser traffic is blocked. The external tooling is **not** a project dependency and its binaries/fonts are not checked into Git.

```sh
npm install --legacy-peer-deps
npx tsc --noEmit
npm test
npx vite build
# Optional Linux headless integration tools, installed outside the repository:
TOOLS="$HOME/.cache/examparse-browser"
npm install --prefix "$TOOLS" --no-save --package-lock=false \
  playwright-core @sparticuz/chromium @fontsource/noto-naskh-arabic
EXAMPARSE_BROWSER_MODULES="$TOOLS/node_modules" \
  node --import tsx test/browser.smoke.mjs
```

Results: **66/66** default tests (0 failures/skips) + **27/27** actual Chromium checks. Browser assertions cover genuine PDF extraction/crops/thumbnails/folder persistence, provider-free health, dedicated-page/back navigation, real sectioned adapter preparation, full exact-diff UI, consent reload/no replay, CAS commit, call/cost audit, exact Undo, theme/persistence/Settings reset, Persian RTL/refusal, one contextual panel, 390px viewport fit, and zero uncaught browser errors. Real paid model quality and manual Firefox/Safari/OS-native picker testing remain unverified.

## Agent tool list
- Reads (7): `get_exam_health`, `list_missing`, `get_questions`, `get_source_lines`, `get_question`, `list_images`, `get_settings_summary`.
- Exam mutations (10): `retry_missing_questions`, `reparse_section`, `patch_question`, `set_question_points`, `set_question_type`, `assign_image`, `mark_image_decoration`, `delete_question`, `rename_exam`, `set_meta`.
- App mutations (3): `set_theme_token`, `set_language`, `set_setting`.
- Requested tool cuts: **0**. `reparse_section` is section-scoped and span-only, not a full-document/import/OCR/vision operation. It rejects unknown sections, cross-section/key/out-of-range spans, rewrites/invented stems, unsafe images and locally invalid/low-confidence candidates. Missing coverage must first go through cheaper `retry_missing_questions`. Cancel discards the candidate, never the already-incurred usage audit. Preparation, resume and confirmation share the durable six-call budget; a locally confirmed candidate can commit at that call bound without another provider request.

## Storage
- Removed the active browser persistence backend, fallback paths, and its package/lock references. `getImageBlob` now reads `/api/images` only.
- Exams/images/cache/journals/usage/calibration live under the chosen directory. Server config: `.examparse-storage.json`, or `EXAMFORGE_DATA_DIR`. The default button selects `./examparse-data` explicitly; no implicit browser fallback.
- Settings and keys remain in **localStorage**, as permitted for a local-only app. Only small UI/preferences, not exams/cache/usage, use browser storage. Legacy notice dismissal is also a small local preference.
- Legacy path: dismissible one-time banner in Library, plus explicit native read-only JSON export. No automatic mover, no legacy deletion, and no binary-blob migration. Exported legacy image references may need the old app's image export.
- Cache controls: **Settings → Storage & Privacy**. Each bucket clear confirms counts; none calls a model or deletes exams/images. Clearing journals also removes assistant transcripts/Undo journals; independent exam versions remain available.
- Reload resume is explicit, preserving counters and observations. Uncertain in-flight mutations are not replayed. Abandoned cross-tab leases expire after 90 seconds.
- Parser v2.5 invalidates old extraction caches to avoid reintroducing previously normalized source. Existing saved exams are not rewritten to guess their lost original text.

## Matching audit (final diff grep)
Final requested-module diff grep reports **13** added `.test()`/`.match()` lines; every semantic line/stem/title match is accounted for:
- `quality.ts`: key-page/prose/standalone-heading tests and leading-number `.match()` consume `value`, assigned by `normalizeForMatching`.
- `assemble.ts`: header-row tests consume normalized `value`; instruction detection explicitly normalizes `text`; instruction trimming normalizes `clean`; numeric-title tests normalize `title`; derived-title exclusion normalizes `line.text`. Section-points `.match()` consumes `normalized`. Option/grouped-answer `.exec()`/`.matchAll()` consume `matchingView(...).text` and map offsets back to the original text.
- `structure.ts`: heading `.match()` consumes normalized `value`; answer-target tests explicitly normalize `line.text`. The pre-existing weak-model regex tests provider model metadata, **not source text**. Keyword matches provide title hints only, not hard partition boundaries.
- `extract.ts`: plain-text page-delimiter `.match()` explicitly normalizes `trimmed`; image question anchoring uses `parsePrintedNumberFromStem`, not a separate raw regex.
- `keyfile.ts`: both answer-number `.match()` calls consume `matchingView(trimmed).text`; answer bodies are sliced from the original. Regex syntax/newline splitting/HTML escaping and internal line-ID parsing are formatting/serialization, not semantic matching.
- The legacy `utils/numbers.ts` helpers also route through the same normalizer; original numeric labels use offset mapping.
- New harness Arabic-script language detection normalizes the user message first. Tool-protocol fences, template placeholders, deterministic error diagnostics, color validation and test-only assertions are not semantic source/stem matchers. Geometry helpers inspect coordinates/whitespace only.

## Deliberately not implemented
- No automatic legacy mover or old-blob deletion; the explicitly permitted banner/export alternative is used.
- Folder selection accepts a path on the server computer; no platform-native OS picker is introduced into this browser/Express stack.
- No full-app translation of pre-existing pipeline/settings screens; the requested Assistant page/panel and new harness copy are bilingual. A dedicated page is selected in the existing React navigation state, not by adding a router dependency or URL-route framework.
- No paid model/OCR/vision validation. The local mock proves transport/integration and safety, not real-model accuracy. The generated PDF proves real extraction/render/storage and Arabic-script presence, not exact Persian glyph decoding for all PDF fonts or scans; original decoded source is preserved, not silently repaired.
- No arbitrary code/CSS/JS/filesystem/provider/budget-edit tools; no native-language rewrite; no new dependencies.

## Files changed — path + purpose
- `.gitignore` — Ignore folder config and local runtime data.
- `bun.lock` — Remove the obsolete browser persistence dependency.
- `package.json` — Remove the browser persistence package; add no dependencies.
- `package-lock.json` — Record the npm installation lock.
- `server.ts` — Folder setup/buckets, snapshots (including flags), CAS writes, leases, monthly totals, native tools and durable call limits.
- `src/App.tsx` — Blocking setup, import drafts, Assistant navigation/verify entry, and versions/theme integration.
- `src/components/Header.tsx` — Remove obsolete browser-storage status copy.
- `src/components/SettingsModal.tsx` — Assistant role/cap, Storage controls, theme reset, and privacy copy.
- `src/components/ExamVersions.tsx` — List/restore the last ten lightweight versions.
- `src/components/StoragePanel.tsx` — Display bucket sizes/counts and independently confirmed deletion controls.
- `src/index.css` — Add CSS-variable theme tokens.
- `src/pipeline/agent.ts` — Bounded resumable wire harness with confirmation and independent health gates.
- `src/pipeline/agentI18n.ts` — Typed Persian/English harness copy and operation-error/verification localization.
- `src/pipeline/agentTheme.ts` — Color/token allowlists and deterministic theme application/reset.
- `src/pipeline/agentTools.ts` — Twenty validated, paged, allowlisted tools, including two-phase section reparse.
- `src/pipeline/assemble.ts` — Original-text offset slicing, multilingual options, normalized titles, and furniture exclusion.
- `src/pipeline/extract.ts` — Conservative gutter segmentation, unchanged stored Unicode, PDF page geometry, retained thin strips before merging, crop metadata and image counters.
- `src/pipeline/extractCache.ts` — Persist extraction diagnostics with the extraction cache.
- `src/pipeline/extractionQuality.ts` — Pure column/furniture/diagnostics helpers; corroborated body whitespace distinguishes wide titles from truly crossing body text; known page heights protect body content.
- `src/pipeline/imageGeometry.ts` — Recompute merged asset hash/dHash/anchor from the rendered crop.
- `src/pipeline/index.ts` — Tag OCR furniture before parsing; store diagnostics and empty-page errors.
- `src/pipeline/keyfile.ts` — Normalize matching while slicing original answer text.
- `src/pipeline/localDraft.ts` — Create health-reportable source-only documents without a provider.
- `src/pipeline/patch.ts` — Shared validated RFC 7386/pure mutation funnels and unsafe-key rejection.
- `src/pipeline/prompts.ts` — Bump parser version to v2.5, invalidating old lossy extraction caches.
- `src/pipeline/quality.ts` — Canonical normalization/offsets, key territory, enumeration/window fixes, health and content revisions including source/flags/name provenance for stale-consent/CAS protection.
- `src/pipeline/reparseSection.ts` — Section-only adapter preparation, strict span candidate validation, pure replacement and full diff views.
- `src/pipeline/retryCoverage.ts` — Reuse existing recovery with agent budget propagation and one CAS write.
- `src/pipeline/structure.ts` — Normalize hints, demote furniture, avoid hard keyword-derived boundaries, and audit each completed section call immediately (even if preparation is later interrupted/rejected).
- `src/store/index.ts` — Folder-only data/cache/journal/usage persistence, client settings, errors, and optional CAS.
- `src/store/legacy.ts` — Explicit read-only native legacy JSON export, without an active browser backend.
- `src/types.ts` — Add PDF page-height/furniture/diagnostics, Assistant role/settings and native tool-call types.
- `src/utils/budget.ts` — Move calibration persistence to the folder cache with an in-memory mirror.
- `src/utils/hash.ts` — Sample actual color variance for tiny/nonuniform strips; guard one-pixel dimensions.
- `src/utils/numbers.ts` — Route legacy matching helpers through the canonical normalizer and retain original labels.
- `src/utils/validation.ts` — Validate additive role/settings and agent usage records.
- `src/views/AssistantView.tsx` — Dedicated bilingual page/contextual panel, complete consent diff, persisted candidate/transcript/Undo, local health, cumulative preparation costs and concurrency controls.
- `src/views/LibraryView.tsx` — Folder-only library, dismissible legacy notice, and legacy export.
- `src/views/Step2Source.tsx` — Show extraction diagnostics and empty-page errors.
- `src/views/Step3Analyze.tsx` — Apply the allowlisted live-panel setting and correct cache copy.
- `src/views/Step4Review.tsx` — Share the pure question-deletion funnel.
- `src/views/Step5Exam.tsx` — Apply default exam mode and document folder image restoration.
- `test/browser.smoke.mjs` — Optional isolated genuine Chromium/PDF/UI/proxy/consent/reload/Undo/theme/RTL/mobile integration runner, without app dependencies or paid calls.
- `test/image-uniformity.test.ts` — Thin/nonuniform and one-pixel canvas regressions.
- `test/reparse-section.test.ts` — Candidate validation, exact consent, source/human staleness, read-only/bounds, interruption/reload/Undo, immediate usage and Persian regressions.
- `test/agent.test.ts` — Offline verify/safety/undo/theme/caps/concurrency/resume/byte-bound/no-provider regression fixtures.
- `test/fixtures/trilingual.ts` — Seven Persian, Arabic-spelling, English, mixed, decorated, fullwidth, and ZWNJ corpus variants.
- `test/storage-folder.test.ts` — Real server tests for setup, isolated deletion, versions, CAS, leases, call limits, and monthly accounting.
- `test/trilingual-extraction.test.ts` — Normalization/invariance, numbering, columns, furniture, merged crops, and option regression tests.
- `test/journal-resume.test.ts` — Keep the existing resume test on the new journal bucket and page-position contract.
- `test/pipeline-hardening.test.ts` — Update the early same-page key expectation to the requested page-position rule.
- `vite.config.ts` — Replace deprecated __dirname usage in native ESM configuration.
- `IMPLEMENTATION.md` — Record the implementation status, evidence, gaps, matcher audit, and full file inventory.

**Added dependencies: 0. Removed dependencies: 1.**

---

# ExamParse memory & skills — implementation report (milestone 2)

Three-layer memory: a global run journal (evidence), an evidence-gated playbook (semantic lessons), and skills (procedures). All plain, Notepad-openable files under `<data>/memory/` (`playbook.json`, `runs.jsonl`, `runs-archive.jsonl`, `activity.jsonl`, `memory-config.json`, `skills/{slug}.md`). Memory is ADVISORY (E1): deterministic gates — coverage, zod validation, ladders, confirmations, caps — fire exactly as before regardless of any lesson.

## Parts A–E (one line each)

- **A — Architecture:** append-only `memory/runs.jsonl` (rotates at 2,000 lines into plain `runs-archive.jsonl`), semantic `playbook.json` seeded EMPTY + 5 bootstrap lessons, procedures in skills only, hard caps 5,000 playbook tok/call · ≤3 skills ≤3,000 tok · state pack ≤1,200 B (assistant re-budget: state ≤1,200 B + playbook ≤1,500 tok + skills ≤3,000 tok), every injection reported via a `Guidance: …` digest line.
- **B — Evidence-gated reflection:** one ≤600-output-token call (≤2,000-token compact input, never raw source) on "interesting" jobs incl. every 10th clean job, ≤3 zod-validated proposals, never on cache-hit/learning-off/cap-exhausted, cost labelled "Reflection"; deterministic promotion candidate→active at 2✓0✗ (or conf ≥0.6 with ≥3 obs), demotion at 2 consecutive failures or conf <0.35, 30-day silent candidate expiry, duplicate lessons merge evidence; Memory UI (Playbook/Skills/Activity) fully user-editable and ledgered; Erase-all keeps dossiers; memory rides in the backup zip; nothing leaves the machine.
- **C — Skills:** `memory/skills/{slug}.md` with hand-rolled frontmatter parser + linter (named errors: over budget, missing fields, bad status/source/slug/maxTokens), exactly 7 shipped skills ≤900 tok each, deterministic keyword/regex selection (keyword +3, regex +4, role/docTrait +1, earned-reliability +1 — no embeddings, no model calls), draft-shadow mode with UNVERIFIED banner, LEARNED stale skills auto-archive (SHIPPED only badge), user skill editor/import/export.
- **D — Wiring:** one guidance assembly point per surface (pipeline + assistant) covering single/journal-resume/sectioned/chunked paths, with the playbook cap defaulting per surface (pipeline ≤5,000 tok, assistant ≤1,500 tok) inside `beginJob`; assistant `AGENT_SYSTEM` shrunk 639→395 tokens (−244, −38.2%) with the runtime guidance appended per turn; "Check this exam" chip routes through `run_remediation_pipeline` then triage skill; `maybeReflect(job)` fire-and-forget at every job completion point with its cost logged under label `Reflection` (tokens + cost + provider/model); 10-minute user-correction window (`USER_CORRECTION_WINDOW_MS = 600000`, ledgered versions excluded) scored server-side by a delayed sweep on each journal append — unledgered in-window versions blame the job's matched lessons at most once (`correction-checks.json`); every-10th-clean-job sampling counts the journal's trailing clean streak; cold start byte-identical.
- **E — Guardrails:** advisory-only proven by test, 0 new dependencies / 0 training / 0 embeddings / 0 external calls, lesson validator rejects credentials/endpoints/≥12-word source quotes, bench goldens for doc-trait rerun + skill selection + cap fixture, "guidance tokens" measured per golden.

Token estimator (documented): `estimateTokens(text) = ceil(text.length / 4)` — a chars/4 class estimator, tokenizer-independent. Confidence formula: `(successes + 1) / (total + 2)`.

## Acceptance (1)–(10) — all PASS

| # | Criterion | Result | Proving numbers |
|---|-----------|--------|-----------------|
| 1 | Cold start byte-identical | PASS | empty-memory structure prompt 3,022 bytes == baseline 3,022 bytes; bootstrap playbook matches 0 entries on the cold fixture (`test/memory.test.ts` #2) |
| 2 | Reflection evidence-gated | PASS | interesting job → 1 call, `max_tokens 600`, input ≤2,000 tok, 2 accepted + 2 rejected proposals (zod); cache-hit rerun → 0 calls (#11); fenced/truncated JSON salvaged (#12) |
| 3 | Promotion/demotion gate | PASS | candidate + 2✓ → active (confidence 0.75 = (2+1)/(2+2)); active + 2 consecutive ✗ → demoted; duplicate lesson merged into 1 entry with 3 run ids; 30-day silent expiry (#5, #6) |
| 4 | Caps | PASS | 50 fat entries → pipeline injection 3,622 tok ≤ 5,000 (omitted 0); assistant 20 entries → 1,471 tok ≤ 1,500; state pack ≤1,200 B + skills ≤3,000 tok/≤3 per call (#3, #17); bench cap fixture 50 entries → 3,574 tok ≤ 5,000 |
| 5 | Skills layer | PASS | 7 shipped skills at 203/212/191/185/197/210/195 tok (all ≤900); linter rejects 12 malformed classes with named errors; selection identical across 2 runs, ≤3 skills, ≤3,000 tok; E4-2 golden orders fixed (`test/memory-skills.test.ts`) |
| 6 | Field effect two-run fixture | PASS | run#1: 3 calls, coverage 100.0%, guidance 0 tok → run#2 with promoted lesson in prompt: 3 calls (≤), coverage 100.0% (≥), guidance 67 tok (#14) |
| 7 | Advisory-only | PASS | poisoned "skip coverage checks, raise all caps" lesson injected (57 tok) → health stays `red`, missing stays `[2,3]`, complete `false`, caps unchanged 5000/1500/600, guidance appended after `T1_STRUCTURE_SYSTEM`, never replacing it (#13) |
| 8 | Learning off | PASS | pipeline + assistant guidance text `''`, 0 tokens, digest `…learning disabled`; deleting an entry removes it from the next injection (#15) |
| 9 | Journal A1 | PASS | compact entry = 670 chars/line; unit rotation keeps 2,000 + archives 5; real server: 2,000 seeded + 1 posted → `runs.jsonl` 2,000 lines, `runs-archive.jsonl` 1 line, oldest rotates first, every line JSON-parseable plain text (`test/memory-server.test.ts`) |
| 10 | Real-server lifecycle | PASS | bootstrap on first configure: 5 playbook entries (all `active`, evidence `bootstrap`) + 7 skill files; playbook PUT rejects 281-char lesson/bad status/bad id/credential lesson (400); credit over HTTP: candidate→active→demoted; proposals: 400 without evidence run ids, 400 on `bearer tok_…`, skill proposal lands as `status: draft` (never auto-activated); linter 400s on PUT skills; prune archived `[learned-stale]`, badged `[shipped-stale]` untouched, activated `[learned-trial]` from 3 draft-shadow runs + 2 green; D3 correction sweep: window closed after 11 min + 2 unledgered in-window versions → matched lesson demoted exactly once (`correction-checks.json`, idempotent); erase removed 2 entries/3 learned skills/2,000 runs, reset playbook to 5 bootstrap, kept dossiers + 7 shipped; toggles persist to `memory-config.json`; backup round-trip restores playbook/runs/activity/config/skills exactly and strips provider keys |

Suites: `npm test` → **132 tests, 132 pass, 0 fail** (99 pre-existing + 17 memory + 14 skills + 2 real-server). `npx tsc --noEmit` clean. `npx vite build` OK. `npm run bench` PASS ×2 (memory goldens stable across runs, no drift).

## Shipped skills (7, `source: shipped`, ≤900 tokens each)

| Skill | Tokens | Purpose |
|-------|--------|---------|
| `verify-and-repair-exam` | 203 | end-to-end verify/repair loop for the assistant agent |
| `missing-questions-triage` | 212 | triage missing/unparsed questions (the "Check this exam" chip lands here) |
| `image-placement` | 191 | unplaced/misplaced image diagnosis and repair |
| `section-integrity` | 185 | section boundary/span integrity repairs |
| `answer-key-handling` | 197 | key territory, separate keyfiles, RTL key pages |
| `weak-model-mode` | 210 | degraded-model wire protocol discipline |
| `user-communication` | 195 | how to report state/limits to the user |

Bootstrap playbook (5, `status: active`, evidence `['bootstrap']`, 188 tokens of lessons total): `bootstrap_001_sectioned_mode` (scope docTrait `long` — 40k-token ramble → sectioned pass), `bootstrap_002_arabic_key` (docTrait `rtl-key-pages` — Arabic-ي key pages), `bootstrap_003_group_children` (docTrait `sectioned` — group children vs retry), `bootstrap_004_option_shared` (docTrait `image-heavy` — shared option lines), `bootstrap_005_free_model_wire` (modelId `free` + role `fast` — free-model wire issues).

## Guidance assembly points (2 — everything else inherits)

1. **Pipeline:** `resolveStructureGuidance()` in `src/pipeline/structure.ts` — the single point where single-pass, journal-resume, sectioned and chunked structure calls obtain their playbook block (fed by `assemblePipelineGuidance` → `selectPlaybookEntries`; cap 5,000 tok).
2. **Assistant:** `beginJob()` in `src/pipeline/memory/harness.ts` — playbook (≤1,500 tok) + skills (≤3, ≤3,000 tok) selected once per turn, injected via `runtime.guidance.text` appended to the shrunk `AGENT_SYSTEM`; `endJob()` writes the journal line (with the `guidance` stamp incl. `draftShadowSkills`), credits/blames matched entries, updates skill stats, prunes, and fires reflection.

Digest example (shown in stage cards/transcripts): `Guidance: playbook 3 entries (812 tok), skills 2 (1,940 tok), 2 omitted by cap`.
Guidance tokens per bench golden (bootstrap playbook, offline): iranian-rtl 153 · english-mcq 73 · scanned-noisy 75 · two-column 0 · image-heavy 70 · giant-120 76 · separate-keyfile 0 · pathological-model 0.

## Files changed / added — added dependencies: 0 (`package.json` untouched)

New: `src/pipeline/memory/{types,tokens,docTraits,runs,playbook,lint,skills,guidance,reflection,harness,bootstrap,shippedSkills}.ts` (12 modules, 2,018 lines), `src/components/MemoryPanel.tsx` (332 lines), `test/memory.test.ts` (541), `test/memory-skills.test.ts` (370), `test/memory-server.test.ts` (243), `test/fixtures/golden/memory-goldens.json`.
Modified: `server.ts` (+353: memory routes registered before generic `/api/memory/:id`, bootstrap seeding, rotation, prune/erase), `src/pipeline/structure.ts` (+75), `src/pipeline/agent.ts` (+133), `src/pipeline/index.ts` (+74), `src/pipeline/retryCoverage.ts` (+41), `src/views/AssistantView.tsx` (+94), `src/components/SettingsModal.tsx` (+47: Assistant tab + memory in backup zip), `src/utils/backup.ts` (+118: `MemoryBackup` paths + restore counts), `scripts/bench.ts` (+80: Guidance column + E4 memory goldens), `IMPLEMENTATION.md` (this report).

## Deliberately not implemented

- Embeddings/vector similarity or any model call in skill/lesson selection — deterministic keyword/regex scoring only (per spec).
- Training/fine-tuning, external telemetry, or any network call beyond the existing provider/localhost surface.
- Compression or a database for the run journal/archive — plain `.jsonl` rotation (Notepad-openable, zero deps).
- Exact tokenizer counts — the documented `ceil(chars/4)` estimator is used everywhere for caps (upper bound, tokenizer-independent).
- Auto-activation of skills outside the evidence gate — reflection skill proposals are always `draft`; activation requires the harness path (3 matched jobs + 2 green) with a one-time ledgered notice, or a user click.
- Auto-archiving of SHIPPED skills — staleness only badges them; archiving shipped content is a human decision.
- Duplicate-lesson detection beyond normalized-text equality (no semantic dedupe without embeddings).
- Concurrent multi-process journal writes — single-writer (the local server) is assumed, matching the app's storage model.
- Cross-machine memory sync / cloud backup — memory never leaves the machine by design.

# ExamParse cleanup · ownership · validators · executor — implementation report (milestone 3)

Branch `arena/c68468f1-examparse`, 5 commits on top of `b13e776`. Suites: `npx tsc --noEmit` clean · `npm test` **162 pass / 0 fail** (was 151) · `npm run bench` **PASS** (9 goldens incl. new `gauntlet-lazy`). Added dependencies: **0**.

## Parts

- **A — Stage 2.5 CLEANUP: done.** `src/pipeline/cleanup.ts`: A1 local pre-pass (`furniture|pagenum|key`, `source:'local'`, 0 calls, reuses furniture detection + key territory) always runs; A2 one AI judgment per exam (≤400-line chunks, cache key = content hash + `CLEANUP_VERSION` + model, `roleMapping.cleanup` → fast model, `L#### text` input + ±2 context, strict JSON `{id, verdict, conf}`, 7 worked trap examples in the system prompt); A3 fences (printed-number/option-marker/blank-marker lines never junk → `CLEANUP_FENCE_SAVED`; junk needs local agreement or conf ≥ 8, 5–7 → `suspect-junk`; header/instruction/passage/dialogue tags only; failure after one retry → local tags + `CLEANUP_AI_SKIPPED`); A4 clean view (`[FURNITURE]/[KEY]/[HDR]/[INSTR]` prefixes, AI-confirmed junk omitted; bench reports lines before/after), Step 2 **Cleanup lens** (All/Kept/Junk/Suspect, tag badges, `GARBLED?`, per-line override `auto/keep/junk/header/instruction` persisted under `cleanupOverrides:${fileHash}` and respected by the stage); A5 Step 3 cleanup stage card + cost estimate priced at the cleanup role; Settings toggle (default on, governs the AI call only). Tags never mutate text/spans/numbering.
- **B — Line ownership: done.** `src/pipeline/ownership.ts`: B1 ownership map (question / section / unowned, key lines excluded); B2 gap completion (unowned non-header/instruction/furniture lines absorbed into the preceding question — stem continuation before options, option area after, option splitter re-run; never crosses a printed-number line, section header, key boundary or another question's lines; cap 30, trailing gap ≤ 8 same page) → `GAP_ABSORBED` per question + `gap-completion` trace transform; B3 `ORPHAN_LINES` (info ≤ 2 %, warn above) in Step 4 health with **jump to Step 2** (line focus + scroll), orphan rate in the quality score (confidence 10 → 6 + orphan 4; server fallback mirrors it); bench asserts orphan rate 0 on lazy-span goldens; B4 START-anchor rule in the structure prompt.
- **C — Validators & gates: done.** C1 `STEM_HOLLOW` (error; ≥ 12 non-number chars, ≥ 6 for truefalse/fillblank/matching), `OPTIONS_MISSING` (error when the option area has evidence, else `OPTIONS_UNVERIFIED`), `META_TOTAL` cross-check (document wins: last total-points line in exam territory > key-page جمع نمره > section-header sum → `META_TOTAL_CORRECTED`; none → `META_TOTAL_UNCHECKED`; total < question sum always corrected), `SECTION_CONTAINMENT` → `SECTION_REASSIGNED` (exactly one container) else `SECTION_AMBIGUOUS` error + review queue. C2 all error flags feed the existing escalation repair/recovery (same budgets); survivors → `REPAIR_SURVIVORS` → PARTIAL banner. C3 local section plan anchors on header tags then printed-number contiguity; `SECTION_SPLIT_LOCAL` when a range contains another header.
- **D — Fenced rewrites: done.** Only via the existing `rewrites` channel (structure funnel AND repair channel share `rewriteRejection`): ≤ 140 chars, only lines locally marked `[GARBLED?]` (≥ 30 % mixed-script glue/�/watermark residue), rejected on lines with printed number/option marker/digits/blank marker, inside the question's own spans, never key territory. `REWRITE_APPLIED` / `REWRITE_REJECTED` (doc + per question), `rewrite` trace transform, Step 4 **original ⮕ rewrite** panel with one-click **Revert** (re-slices from original lines). Sections > 40 % garbled routed once to the escalation model (≤ 2 per pass, `SECTION_GARBLED_ESCALATED`; `SECTION_GARBLED` warn when no budget/model).
- **E — Assistant executor: done.** E1 batched tool calls (≤ 8 blocks/reply, reads parallel, mutations sequential, per-block error isolation; prompt + shipped skills teach it); E2 `diagnose_missing` returns a canonical `actionQueue` (`split_group_children` / `accept_group_representation`-or-reparse) run by the harness between model turns (read+mutate local, destructive → confirm card), one health re-observe, single delta report, args validated against doc state; E3 budgets 30 model calls (5–60) / 200 tool executions (reads weighted 0.25), bound hit checkpoints executor state and resume continues the queue without repeats; E4 working-memory brief persisted on the task, refuses re-planning completed rungs; E5 state pack shows ladder position + next rung + worked follow-up example; E6 **Fix it** chip = deterministic pipeline, 0 model calls.
- **F — Proof: done.** F1 gauntlet fixture + bench gate; F2 Iranian BEFORE/AFTER table; F3 cleanup-off hash regression + `CLEANUP_AI_SKIPPED` shape-mismatch mock; F4 executor tests (6); F5 all suites green with counts above; stage card gained the cleanup stage.

## F1 scorecard (`gauntlet-lazy`, scripted dumb model: one-line spans, wrong meta, mixed sections)

`{ STEM_HOLLOW: 0, mcqUnder2Options: 0, orphanRate: 0, totalPoints: 20, documentTotal: 20, sections: [Listening, Vocabulary, Grammar, Reading] == headerSet, coverage: 100, state: green }` — bench asserts each line and FAILS otherwise. Flags: GAP_ABSORBED×19 · OPTIONS_SYNTHESIZED×13 · SECTION_REASSIGNED×7 · SECTION_POINTS_MISMATCH×4 · META_TOTAL_CORRECTED×1 · SECTION_SPLIT_LOCAL×1 · POINTS_MISMATCH×1 · STEM_SHAPE_SUSPECT×1. Clean view 73 → 70 lines, 1 structure call (420 tok), quality 95.

## F2 — Iranian-layout golden (`iranian-rtl`) BEFORE → AFTER

| Metric | Before | After |
|---|---|---|
| Hollow stems (`STEM_HOLLOW`) | 0 | 0 |
| Misfiled questions (section containment) | 0 | 0 |
| Points parsed | 100 % | 100 % |
| Coverage | 100 % | 100 % |
| Orphan rate | — (not measured) | 0 % |
| Structure prompt tokens | 1067 | 1073 (−0.6 %: local-only pass adds tag prefixes; savings come from AI-confirmed junk omission, 3 pagenum lines omitted here) |
| Quality score | 95 | 95 |

## Acceptance numbers

- Fence-saved lines (junk-everything mock on gauntlet): judged 56 · junk 21 · suspect 0 · **fence-saved 44**.
- Orphan rate: gauntlet 0 %, iranian-rtl 0 %, giant-120 0.8 %, two-column 6.7 % (warn, honest).
- Hollow count: gauntlet 0, iranian-rtl 0 (english-mcq 17 / separate-keyfile 19 are legacy fixtures with intentionally terse scripted stems, unchanged thresholds).
- Executor: "Fix it" → **0 model calls, 6 tool executions (weighted 3)**, missing 2 → 0; diagnose → executor → 2 model calls, 4 tool executions (weighted 1.75); 4 batched reads → **1 model call**; bound-hit resume → 2 splits total, no repeats; brief carries facts verbatim.
- F3: cleanup-off doc hash == local-only hash == AI-tagger hash (tags/flags excluded) on both fixtures; AI-skipped path → local tags only, 0 blocking.

## C2 audit — every error-severity code and its wired consequence

| Code | Consequence |
|---|---|
| `STEM_HOLLOW` | per-question flag → escalation repair (existing budget) → survivors `REPAIR_SURVIVORS` → health `complete=false` → PARTIAL banner + hollow list |
| `OPTIONS_MISSING` | same path as `STEM_HOLLOW` (repair → survivors → PARTIAL); evidence-less case downgraded to `OPTIONS_UNVERIFIED` (warn) |
| `SECTION_AMBIGUOUS` | question queued for review (per-question flag, hollow list in health banner), `complete=false` |
| `REPAIR_SURVIVORS` | PARTIAL banner in Step 4; `complete=false` |
| `REPAIR_SPAN_REJECTED` | repaired question excluded (never written from key territory); counted into coverage → `COVERAGE_MISSING` recovery |
| `COVERAGE_MISSING` / `PARTIAL_COVERAGE` | recovery pass on missing numbers (existing budget); assistant `diagnose_missing` actionQueue; PARTIAL banner |
| `STRUCTURE_EMPTY` | PARTIAL banner "no questions parsed"; recovery/chunked fallback |
| `SECTION_NODE_FAILED` | other sections continue; missing numbers flow into `COVERAGE_MISSING` recovery |
| `EXTRACTION_PAGE_EMPTY` | OCR stage for that page; Step 2 diagnostics |
| `META_TOTAL_CORRECTED` (warn when doc overrides) | document total replaces model meta; points score recomputed |

## Files changed — added dependencies: 0

New: `src/pipeline/cleanup.ts` (473), `src/pipeline/ownership.ts` (347), `src/pipeline/gates.ts` (62), `test/gauntlet.test.ts` (217), `test/executor.test.ts` (245), `test/fixtures/golden/gauntlet-lazy.ts` (157). Modified (34): `agent.ts` (+804), `assemble.ts`, `index.ts`, `structure.ts`, `semanticValidators.ts`, `quality.ts`, `qualityScore.ts`, `repair.ts`, `provenance.ts`, `prompts.ts`, `agentTools.ts`, `dossier.ts`, `cache.ts`, `patch.ts`, `reparseSection.ts`, `shippedSkills.ts`, `types.ts`, `store/index.ts`, `utils/validation.ts`, `utils/budget.ts`, `server.ts`, `App.tsx`, `Step2Source.tsx`, `Step3Analyze.tsx`, `Step4Review.tsx`, `AssistantView.tsx`, `ExamHealthBanner.tsx`, `SettingsModal.tsx`, `scripts/bench.ts`, `thresholds.json`, `memory-goldens.json`, 3 existing tests.

## Bug sweep (after the parts landed)

- **ExamDoc schema rejected new usage roles** — `usage[].role` enum lacked `cleanup`/`critic`/`consensus`, so any parsed doc with a cleanup call failed export → import (`parseExamDocImport`) and `reparseSection`'s post-validation. Fixed + regression test (`test/gauntlet.test.ts` "schema — …").
- **Step 3 cache-hit check never matched** the pipeline's structure key (which now carries the cleanup signature). The signature is now deterministic and computable pre-flight (`cleanupKeySignature`: version | model-or-off | overrides) and shared by both sides.
- **False `SECTION_AMBIGUOUS` on lazy section spans** — containment now falls back to order-based territory (section first line → next section's first line) before declaring an error.
- **"Choose one out of four …" parsed as a total-points line** — bare `out of` now needs a score word or a very short line.
- Chunked fallback sent raw `L####` lines — now renders the same clean view as every other structure path.
- Malformed spans from foreign docs crashed `spanLines`; banner orphan rate used a different denominator than the score; orphan count went stale after Step 4 edits (now recomputed live); PARTIAL headline now names validator survivors; Step 2 jump switches page/lens; Step 2 gains an **Orphan** lens + per-line ORPHAN badge; per-question flag chips in Step 4; cleanup role row in Settings.

Suites after the sweep: tsc clean · **163 tests pass** · bench PASS · `vite build` OK.

## Deliberately not implemented

- Garbled-section escalation on the consensus second pass — the consensus pass intentionally uses a different model and is recovery-only (where the spec excludes routing).
- Local-only token savings — a regex-only pass cannot omit lines safely (only AI-confirmed junk conf ≥ 8 is omitted), so the F2 token column is honest about −0.6 %.
- Rewrites that translate or invent, rewrites on numbered/option/digit lines, or any rewrite outside the `rewrites` channel.
- Any model call in gap completion, ownership, gates, META_TOTAL or the "Fix it" path — all deterministic by design.

## Follow-up #50 — Fix the input, tame the pathologies
Full report: [`docs/followup-50-report.md`](docs/followup-50-report.md).
- **A:** stream breaker on every generative call (3 identical top-level items cut the stream). Declared counts plus compile-time reconciliation (`reconciled{truncated,deduped}`). Proportional caps (map 3000, section 800+n×220, fix 400+n×300 clamped to 800–8192). Salvage plus ONE complaint retry. Read-role `repeat_penalty 1.12` with a `[no-repeat-penalty]` rung.
- **B:** map passage `blanks`; one `fillblank` per blank; `blank-missing` verdict with a section-scoped fix; `cloze-passage` corpus entry at 15/15.
- **C:** a normalised digit twin per line (original text untouched); `digitSuspect` for corrupt digit runs; `watermark` lines kept but hidden from every prompt.
- **D:** difficulty is sent as the native llama.cpp score (`criteria` array), gated on a real captured server response. Stored as argmax, `uncertain` when the top level is below 0.4.
- **E:** one automatic section re-read when a section returns under 50% of its expected questions; the better attempt is kept; counted in `sectionReReads`.
- Checks: `npm test` 420/420, `tsc` and build clean; existing corpus entries are byte-identical to before.

## Follow-up #51 — Visual map audit + six phases (check, then fix once)
Full report: [`docs/followup-51-report.md`](docs/followup-51-report.md).
- **Six phases, one order:** Extract → Map → Parse → Check → Fix → Present. Step 3, the loop receipt (`local-loop-v2`) and the stage ids all use the same six names. `receipt.timeline` records what ran. v1 receipts with the old step names still parse and render.
- **A, visual map audit:** on a multimodal decide endpoint, three new item kinds (`section-start-visible`, `pictures-present`, `passage-visible`) each send one page image (reused from OCR; nothing new is stored). They route exactly like text votes. Image errors are skipped and counted (short-circuit after 3 in a row) and never stop the text audit. The map outline shows seen ✓ / seen ? / seen ✗ / text only. THX `image-belongs` now actually sends pixels.
- **B, check then fix once:** Check produces one merged, source-tagged list. When code and the decision audit flag the same concern on the same item, that counts as one verdict and keeps the decision probability. Fix is ONE generative pass batched by section; uncertain votes are hints only. Present re-checks: code with 0 calls, decision re-votes only changed or indicted items (fixture: 30 of 600).
- **C, deleted:** the self-review step (its instructions moved into the Fix prompt), Final fix as its own phase, and the code-fix-before-audit ordering.
- Checks: `npm test` 434/434 (−1 deleted self-review test, +15 new). `tsc` and build clean. Corpus entries are identical to #50 on questions, sections, points and surviving verdicts.
