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
