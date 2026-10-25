# Held-out furniture probe: refurnished (generated, report-only)

Generated from `english-mcq` by `scripts/generate-probes.ts` (#38 Part E2).
Every page was re-wrapped in NEW furniture never present in development: header "★ STAR ACADEMY · TERMINAL ASSESSMENT · DO NOT WRITE OUTSIDE THE BOX ★",
a per-page footer ("sheet N of M"), and a differently-phrased continued line between pages.
Original furniture flags were stripped; question/section text is byte-identical to the base entry.
Pass condition (see test/ai-first-spine.test.ts): line classification still identifies the same
questions and sections, and the new furniture stays furniture.
