# Corpus entry: mock-born-digital

A born-digital mock examination with repeated per-page running headers/footers,
“continued” lines on every page, bracket per-question marks, section subtotals and
an explicit printed total. 65 questions · 4 sections · 40 marks.

Provenance: Field Report #12 described exactly this format shipping as 106 questions /
34 “sections” / all points 0 under the old code-first pipeline. The original field file
was not present in the checkout when #38 landed, so this paper was authored format-
faithfully by `scripts/generate-mock-exam.ts`; every truth field comes from that
generation ledger (the printed paper), never from model output. `labels.json` is the
ground-truth line classification authored with the paper and drives the #38 label-
assembly acceptance test. Review record (Part B2 steps): counts vs ledger ✓ (65/40),
types limited to the checked MCQ subset ✓, section titles checked ✓, spot questions
1/21/36/65 checked ✓, groups 51–55 checked ✓ → status set reviewed when the runner is green.
