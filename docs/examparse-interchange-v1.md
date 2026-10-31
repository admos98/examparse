# ExamParse standalone interchange v1.0.0

ExamParse is the system of record for this interchange. It can be read and re-imported without a bank application, database, online service, credential, or model call. The future destination adapter is separate and is not part of this format or implementation.

## Files

* `examparse.json` is the canonical, complete ExamParse document. It is the ordinary structured JSON export with the same root fields and meaning.
* `assets/manifest.json` is a byte-for-byte JSON representation of `examparse.json.assetManifest`.
* `assets/<sha256>.<ext>` contains actual, locally available image bytes. The extension and MIME are derived from the byte signature; `sha256` is computed over the file bytes. ZIP paths are relative to the package root and may not escape it.
* `batch.json` or `part-N/batch.json` is a **lossy legacy bank projection**, not the canonical document. `legacy-projection.json` explains its known losses and points back to `examparse.json`. Sidecars such as `preserved/answers.json` and `preserved/listening-scripts.json` are compatibility aids, not replacements for the canonical document.

The root of `examparse.json` is an ExamDoc plus `format: "examparse.interchange"`, `formatVersion: "1.0.0"`, `assetManifest`, `completeness`, `teacherOnly`, and `exportMeta`. Full identity is `id` plus the exact printed `label`, section/parent identity, and any branch identity; `no` is only a numeric ordering aid and is never a unique key. Unknown or absent information stays absent/null/unknown.

## Authority, evidence, and privacy

`questions[].answer` is reserved for source/keyfile evidence bound to addressable, key-tagged source lines or an explicit teacher save (`source: "manual"`). Model/raw-reader answers belong in `questions[].enrichment.proposedAnswer`; they are not grading keys. Existing legacy AI answers are migrated out of executable answer fields during export. Teacher saves supersede the active source answer while the original history remains in review/import metadata.

`teacherOnly.boundary` is always `not-student-safe`. The full record can contain source keys, teacher work, source lines, private review/evidence history, model proposals, explanations and scripts. `teacherOnly.listeningScripts` records exact script text and its question/section identity; it is not audio and does not prove the original recording. This interchange is not a student payload. Student views must explicitly project safe fields.

A missing/unavailable pixel file is not synthesized from a placeholder or description. Manifest records preserve its ID, SHA if known, MIME, owners, and reason. An asset without a trustworthy owner is retained as `unassigned`. Image ownership is represented by question image references and option `imageRefs`, preserving role/order/position metadata where available. Inline base64 is never serialized into the JSON document.

`completeness.state` is `complete`, `partial`, or `unverified`; `issues` records unpriced points, unresolved grading keys/types/optional rules, missing images, unverified multipart receipts, and other pending conditions. Missing points remain `null`/absent, not invented values. Optional rules remain `unknown` unless the source establishes them.

## Compatibility

The native ZIP importer checks `examparse.json` first, verifies every available asset's SHA-256, restores teacher scripts, and retains missing/corrupt assets as unavailable. Legacy `batch.json`, older ExamParse JSON, and supported multipart packages remain readable through the legacy importer. A legacy projection can be lossy in identity, source evidence, review history, script data, optional-group semantics, and image position/ownership; it must not be mistaken for the v1 canonical record.

The machine-readable JSON Schema is `schemas/examparse-interchange-1.0.0.schema.json`. Runtime checks also enforce unique question/section IDs, exact labels, safe relative available-asset paths, and manifest structure.
