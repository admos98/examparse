# Follow-up #53 — package import and enrichment

Select the JSON and image files together, or use **Choose folder** in Step 1.
Both authored packages and Appendix A `batch.json`/`assets` are accepted. Imported
metadata (including package provenance and the original key) remains distinct from
ExamParse-generated metadata. Shared passage blocks are factored and identical image
bytes are SHA-256 deduplicated. The original image positions and explicitly numbered
filename assignments are retained; other images remain in the unassigned tray.
Reimporting an identical saved package opens it rather than overwriting teacher edits.

Step 3 uses a package-only decision flow, not the PDF parsing loop. Results are
model estimates, not edits: choices are blind to the key, and disagreement becomes an
attention item. The imported key is not changed. Lesson distributions, derived origin,
reading mode and demand are stored separately; teacher-confirmed lessons win at export.
Without a configured decision provider the package remains usable and enrichment is
not run. Missing scripts or pixels prevent evidence-dependent judgments. Endpoint
failures leave estimates unjudged and stop repeated calls after five failures.
No live Lightning endpoint or real-model calibration was available for this work;
the automated routing tests use scripted responses and make no model accuracy claim.

Bank export keeps the existing Appendix A option-key representation. A package answer
that cannot be expressed as an option key (for example a free-text fill-in answer) is
retained in the imported exam but omitted from the batch key and reported as needing
attention rather than converted into a fabricated option. Imported difficulty is not
mapped from demand or generated during package export.

Validation in this checkout: TypeScript and production build pass; **479 tests pass**
(**+12** versus the 467-test #52 baseline). The offline bench passes all 9 golden
fixtures, with the report-only mock-born-digital loop unchanged at 60/65 questions,
4/4 sections and 37/40 points. The package fixture is synthetic, not a field package.
