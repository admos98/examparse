# Follow-up #52 — calibrated question shapes

## What changed

- MCQ answer checks are blind native choices. The comparison target lives in code-only
  metadata; only whitelisted question fields, option texts, passages and key-free source
  lines travel to the referee. Existing letter/text answer normalization resolves keys.
  Missing/unresolvable keys never generate an answer ratification vote.
- Argmax agreement verifies; disagreement at confidence **≥0.50** indicts; a weak/flat
  choice remains uncertain. THX retains distributions and chooses their argmax rather
  than trusting an inconsistent returned answer string. Discrete comparison routing
  scores are explicitly **not calibrated posterior probabilities**.
- Noul templates each make one affirmative claim. No new verdict kinds. Noul bands
  remain **0.80/0.20**; no per-kind threshold adjustments were made.
- Missing pixels, passages, source text and unprinted listening scripts produce
  `skippedNoEvidence`, notes for the teacher, and **no call/vote** for that item.
  Required item/source-item/passage/script evidence stays intact. Background context
  uses marked middle elision, preserving final statements. Oversize indispensable
  evidence is not silently discarded to meet the old ~850-token target.
- Image ownership includes illustrative-scene licence, plus a separate blind sentence
  choice when options exist. A `none` alternative avoids forcing an unrelated sentence
  when a picture is misassigned. Both measurements must be available to verify;
  contradictory measurements produce uncertainty, never a silent pass.
- Passage-scope map audits choose among actual candidate passages plus `none`, without
  putting the proposed passage identifier into the record. Visual map audits still
  attach exactly one rendered page image per vote.
- Calibration and production share Check→Fix routing/batching. The six phases and
  only-the-generator-patches rule are unchanged. Export code is untouched.

## Calibration: routing evidence versus model evidence

The independently built, geometry-verified **field** package described in the request
is not in this checkout. `mock-born-digital` is explicitly documented as a synthetic
corpus entry. Do not represent it as the field reference.

`test/fixtures/calibration-exam.ts` supplies an independently checkable synthetic
65-question analogue (arithmetic, two scene sentences, one locally drawn PNG, differing
marks). Each run plants exactly one of the seven requested corruptions, **at the Check
boundary**. This is intentional: #50 compile reconciliation drops exact duplicate
model emissions before Check; planting in a Parse response would test reconciliation
instead of detecting a corrupted working document.

The truncation plant uses a conservative deterministic numbered-source-prefix check
under the existing `empty-stem` concern. It is not a general linguistic truncation
classifier. Numbering gaps, duplicates, source-proven truncation and totals remain code
checks. Points-sum failures suppress redundant points-plausible votes, and proven
truncation suppresses redundant complete/stem-faithful votes.

```sh
npm run calibrate:decide
```

Measured **scripted routing result**: **7/7 planted scenarios caught**, **0/67 clean
unit indictments**, zero endpoint errors. The 67-unit denominator is 65 questions,
one image and one document-wide check unit; it does not multiply repeated verdicts
or repeated runs. Per-kind clean denominators count verdict opportunities, and catch
counts count planted scenarios. These are **not** empirical model sensitivity or
specificity. The script labels them scripted; Settings refuses to show them as a live
measurement for promotion. Runtime reports default to ignored `data/`.

### Live, local, report-only

Tunnel your real Lightning llama-server locally, with its trained model and mmproj:

```sh
DECIDE_URL=http://127.0.0.1:8080/v1/systemone \
DECIDE_MODEL=your-real-lightning-model \
npm run calibrate:decide -- --live --out data/decide-calibration.json \
  --capture-score test/fixtures/systemone-real-model-score-response.json
```

The full catalogue is run on controls and each planted case; this can take thousands
of single-item calls. There is no CI accuracy gate, no cloud fallback, no automatic
threshold tuning, no promotion, and no patching. Endpoint failures and evidence skips
are printed alongside per-kind catch/false-alarm counts. Review nonzero errors/skips
before interpreting the counts. The optional score capture is written only after
successful decoding, retains request/response and model/date provenance, and must be
reviewed/redacted before checking it in. Test only wire shape, **never score values**.
The original tiny-random-weight score fixture remains explicitly shape-only.

To use the actual independently verified package rather than the analogue, add
`--fixture /path/to/verified-package.json`. It must contain:

```ts
{
  name: string,
  document: AuthoredDocument, // 65+ questions in source order, marked keys retained
  lines: SourceLine[],
  images: ImageAsset[],
  imagePayloads: Record<string, { id: string; mime: string; data: string }>
}
```

Corruption indices refer to Q1/Q2, Q3/Q4, Q5, Q19/Q20, Q10 and Q11. Match the source
order before running. An external package is live-only: the scripted oracle is
specific to the synthetic analogue, not a pretend oracle for arbitrary exams.

In **Settings → Decide**, import the resulting JSON. The live summary is matched to
model, endpoint host and dialect and appears beside Shadow/Active, with per-kind
counts expandable. Import never enables Active. Teacher promotion remains explicit.

## Outstanding field evidence

No Lightning endpoint or real trained-model score capture was available in this
session. Therefore **no live reliability numbers and no real-model score capture are
claimed**. Run the command above with the verified field package before treating
promotion as calibrated. No thresholds were changed on the strength of stubs.

## Validation in this checkout

- TypeScript: `npm run lint` — clean.
- Tests: **467/467**, **+33** from the 434-test V37 baseline; no skips.
- Production build: passes (existing chunk-size/dynamic-import warnings remain).
- `npm run bench`: **PASS**; all nine golden fixtures pass.
- Scripted corpus loop: mock-born-digital **60/65**, sections **4/4**, points
  **37.00000000000001/40**, unchanged from the V37-class report (report-only).
- `npm run calibrate:decide`: **7/7**, **0/67** clean-unit indictments (scripted only).
- `git diff --check`: clean; question-bank export code untouched.
