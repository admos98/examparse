# Grade 12 Iranian National Final English Exam (`13991009pq89w65173`, Shahrivar 1399)

- **Ground-truth correction (Part A1)**: 9-section truth was inherited from model exports and was wrong. Re-derived directly from the printed 8-page paper:
  - **Pages 1–6**: Exam paper (`67` printed questions, `48` total points).
  - **Pages 7–8**: Official marking guide / answer key (`راهنمای تصحیح`, final 2 pages).
  - **8 printed section title headers** at source lines `7, 46, 65, 92, 151, 178, 206, 221` of the 323-line extraction, in printed order:
    1. `L0007`: `Listening` (`3 Listening 1`)
    2. `L0046`: `Vocabulary` (`Vocabulary 5`)
    3. `L0065`: `Grammar` (`3 Grammar 8`)
    4. `L0092`: `Reading` (`4 Reading 11` — Row 12 `4 متن زیر رابخوانید... 12` at `L0117` is a sub-header passage instruction inside `Reading`, NOT a 9th section title header)
    5. `L0151`: `Writing` (`2 Writing 13`)
    6. `L0178`: `Vocabulary` (`ocabulary V 16`)
    7. `L0206`: `Grammar` (`4 Grammar 17`)
    8. `L0221`: `Writing` (`8 Writing 18`)
- **Extraction provenance & ordering choice (Part A2)**: `source-lines.json` has been regenerated to match the actual `323`-line (`L0001..L0323`) y-band field extraction shipped in real exports (`English — 11_structured (2).json`), replacing the earlier unmerged `360`-line plain-text dump. Where the raw text dump split same-row table cells (`نمره` mark column, center prompt/header, `ردیف` row ordinal, masthead URL/page number, and duplicate diagonal watermarks) onto separate lines, field LTR row ordering (`<points> <title/instruction> <row>`) and 8-page assignment (`p1..p6` exam, `p7..p8` answer key) are preferred and preserved deterministically with zero lost text.
- **Evidence-only point gate (Part D)**: Q67's older `4`-point spot-check was not backed by an explicit per-item key mark or an unambiguous section-header mark in these stored source lines. With model-provided point defaults ignored, its deterministic residual allocation is `1.86` while the 48-point document total remains exact. This is fallback (`English — 11_structured (2).json`) evidence, not the missing requested 12 export.

## Answer-side discipline acceptance

Q25's exact **0.5** mark is sourced from key L0258 (`هر پاسخ صحیح … ) 5 (./ نمره`),
with items 25–30 on L0259. The spot check now pins that source-backed mark rather than
Q67's old **1.86** residual allocation (which was not a printed per-item mark).
Residual allocation can change as more explicit key marks are recognized; the immutable
48-point sum remains gated, as do Q63's long type and answer-text furniture hygiene.
