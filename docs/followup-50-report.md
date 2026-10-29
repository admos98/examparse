# Follow-up #50 — Fix the input, tame the pathologies

Built on #48/#49. There are no new stages, roles or thresholds. The #46 rules still hold: code checkers only comment, content patches come only from the generative model, and nothing aborts a save. Every retry below is **one** retry per target. A second pathology marks the target partial, and there is never a third attempt.

## D — Difficulty score shape (first gate, done before any parser code)
- **Captured, not guessed.** I built llama.cpp `master @ 0893ec98` from source and served `/v1/systemone` from tiny random-weight `openjev` GGUFs, because the HuggingFace test models were unreachable. The capture is in `test/fixtures/systemone-llama-score-response.json` (model path redacted). To reproduce it, run `scripts/systemone-capture/capture-systemone-score.sh`. Its generator reproduces the capture GGUFs byte for byte.
- **Why the old request failed.** `{type:"score", levels:[…]}` gets **HTTP 400**: `"criteria" must be an array of 2 to 10 levels`. That was the endpoint error on difficulty items only.
- **New request.** It uses the native score fields, `{type:"score", instructions, criteria:["1: trivial recall","2: easy","3: medium","4: hard","5: very hard multi-step"]}`, so there is no choice-shaped workaround. This matches upstream `server-decision.cpp` and `test_systemone.py`.
- **Response.** `{type:"score", score, legend:{"0":…}, probabilities:{"0".."4"}, confidence}`. The adapter maps the 0-based keys to levels 1–5 and returns `{choice: argmax, probability: top, distribution}`. A missing or non-numeric key throws `THX score response malformed`, which is counted as an endpoint error.
- **Stored result.** `q.difficulty = {value: argmax, source:"model"}`, plus `uncertain: true` when the top level is below **0.4**. This replaces the old "value 3 is uncertain" rule. The flat capture gives 5 (p 0.263) and is uncertain; the peaked capture gives 2 (p 0.896).

## A — Loops can't hurt
- **Breaker** (`src/pipeline/streamBreaker.ts`). It scans the stream incrementally and is safe across string, escape and chunk boundaries. It hashes every completed **top-level** list element after normalising whitespace.
  - When the same element completes 3 times, the call is aborted (`reader.cancel()`) with `finishReason:'repetition-loop'` and `breaker:{kind, completedItems}`.
  - Nested arrays, such as identical True/False options, never trip it.
  - The ≥40 ascending-integers rule is still there.
  - It is on for every generative call made through the read caller: map, section parse, self-review and both fix passes.
- **Declared counts.** The prompts declare counts before lists (`sectionCount`, `instructionGroupCount`, `passageCount`, `imageCount`; section parse `questionCount`) and say "emit each entry exactly once".
  - At compile time, exact duplicates are dropped **first**: same range plus NFKC/whitespace-normalised text, or same number plus stem. Lists longer than the declared count are then truncated.
  - A declared `sectionCount` below 1 is ignored.
  - The result is recorded as `reconciled:{truncated, deduped}` on the map receipt and on `LoopReceipt`.
- **Proportional caps:**

  | Call | Cap (tokens) |
  |---|---|
  | Map | 3000 |
  | Section parse | 800 + expected×220 (≤16384) |
  | Self-review / code-fix / final-fix | 400 + flagged×300 (floor 800, ceiling 8192) |
  | Re-map | max(800, 1.5 × the passage's tokens + 200) |

  The page-READ fallback keeps its generous allowance.
- **Salvage and one retry** (`callWithOneRetry`). A breaker or cap cut compiles the complete prefix objects. Fix passes salvage complete correction objects only and dedupe identical ones. An unflagged unparseable patch is still all-or-nothing.
  - The note reads `<label>: generation loop cut at item N — salvaged M items (pathology: repetition|counting loop|output cap X tokens)`. N counts completed list items across the whole output.
  - ONE retry goes to the same model with the complaint quoted ("your previous output repeated the same item; emit each item once").
  - The better attempt is kept, and records go to `receipt.pathologies`.
  - The pathology retry and the existing unparseable retry share one budget.
- **`repeat_penalty: 1.12`** is sent only on read-role calls on the OpenAI-compatible path (llama.cpp and Ollama accept it as an extra field). If a provider rejects it, a new `[no-repeat-penalty]` ladder rung drops it, in both the stream and non-stream ladders. Extra body JSON can override it, or remove it with `null`.

## B — Cloze blanks are questions
- **Map.** A map passage can carry `blanks:[9,…]`, which is parsed, deduped and sorted. The prompt treats blanks as questions that count toward the section's `questionCount`. The section-parse prompt asks for one `fillblank` per blank: number = the blank's number, stem = the surrounding printed sentence, linked by `passageId`.
- **New code verdict `blank-missing`.** Its id is `code:blank-missing:<pid>:<n>`, and its page is the line that prints `(n)`. The code fix is section-scoped: it gets the owning section contract and the passage with its blanks.
- **New corpus entry `cloze-passage`.** Blanks (9)–(13) sit in a Reading section, and the scripted reader now detects numbered blanks. Result: 15/15 questions, 3/3 sections, and all 5 blanks come out as passage-linked `fillblank`. I marked it report-only (`unreviewed`) because the legacy proving-ground reader can't see blanks by design. The coverage table was regenerated.

## C — Input hygiene at line-build (`src/pipeline/lineNormalize.ts`)
- **Normalised twin.** Each line gets a `normalized` twin, only when it differs from the original: Persian and Arabic-Indic digits become Latin. Persian and Arabic letters are untouched, and `source.lines[].text` is never changed.
- **Corrupt glyphs in digit runs.** A hard-corrupt glyph (U+0FDB–0FFF, U+FFF0–FFFF) touching a digit run flags the line `digitSuspect` and shows the run as `�` in the twin. Private-use glyphs count only when they sit strictly between digits, so symbol-font bullets are safe.
- **Watermarks.** A line that is a single token or domain repeated 3 or more times is tagged `watermark`. It stays in storage, counts as furniture, and is left out of every model prompt.
- **Wiring.** `runLocalLoop` uses `modelFacingLines()`. The map, section, fix and header prompts read the twin, and `extractionDiagnostics` lists `digitSuspectLines` and `watermarkLines`.

## E — One automatic section re-read
After a section parse, if it returned fewer than 50% of the map's expected count (or 0 when 3 or more were expected), it gets ONE re-read before self-review.
- It uses the same lines with the map contract quoted, labelled `Section parse · <title> · re-read`, with the complaint "previous attempt returned N of M expected questions — find the missing ones, especially any passage blanks".
- The re-read replaces the first attempt only if it returns more questions; otherwise the first attempt is kept.
- Re-reads are counted in `sectionReReads` (map receipt and `LoopReceipt`).
- If the first attempt had both an under-count and a pathology, both complaints share the same single re-read.

## Verification
- `npm test`: **420/420 pass** (403 before; 17 new in `test/follow-up-50.test.ts`; two #48 score stubs updated to the captured shape; the corpus-count test went from 14 to 15).
- `npx tsc --noEmit`: clean. `npm run build`: clean (the dynamic-import warnings were already there).
- `npx tsx scripts/corpus.ts`: every existing entry is byte-identical to the pre-change run (mock-born-digital 60/65 · 4/4 · 37/40; english-final 29/67; giant-120 119/120; and so on). New: `cloze-passage` 15/15 · 3/3.
- The server `repeat_penalty` test spawns the real `server.ts` against a fake upstream. It checks that read-role calls carry 1.12, vision calls carry nothing, and a rejecting provider is recovered by the `[no-repeat-penalty]` rung.

## Known limits
- The difficulty capture proves the **wire shape** only, because the weights are random. Real difficulty quality depends on the user's decision model.
- Code-side numbering (`enumerateExpectedQuestionNos`) still doesn't count cloze blanks. Blanks enter through the map contract and are guarded by `blank-missing`. Widening the line-start enumerator would change a code threshold, which #50 rules out.
