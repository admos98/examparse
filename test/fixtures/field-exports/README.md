# Field Export Replay Fixtures (Part F2)

- `English — 11_structured (2).json`: Baseline Field Report #8 structured export fixture carrying the 323-line field extraction (`L0001..L0323`) of `english-final-13991009pq89w65173` and the pre-Marvel-Final (`c8844ae`) export defects (9 sections due to Row 12 `متن زیر را بخوانید` sub-header promotion, 6 inline True/False whole-line option/stem collisions, Q38 >500-char passage-in-stem leak, Q15 shared-line duplicate sibling stems + phantom self-child `15`, and uncanonicalized matching/word-bank/unscramble items).
- Run `npx tsx scripts/field-replay.ts` (or pass any external structured export JSON path as `argv[2]`) to execute deterministic local replay (0 provider calls) and print per-class diff summary counts.
