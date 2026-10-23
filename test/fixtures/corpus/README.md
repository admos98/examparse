# Local exam corpus

Each exam is a self-contained folder with:

- `source-lines.json`: the unchanged `SourceLine[]` used by this repository (`id`, `page`, `text`, optional extraction tags).
- `truth.json`: expected printed question numbers, checked types, section titles in order, document total, and literal spot checks.
- `notes.md`: one-line provenance for the source.

To add a field PDF, run the normal local extraction and place its source lines in a new folder here; add truth from a verified key/manual review. Then run `npm run corpus`. The runner uses a deterministic lazy scripted span model and local segmentation, assembly, and gates only; it makes zero provider calls. `npm run bench` runs this corpus gate before the existing performance/quality bench.

The acceptance fixture is the English final `13991009pq89w65173`. Its available source is the bundled text export in the orientation archive. That export contains 360 non-empty lines; the prompt's 323-line stored extraction was not present in this checkout, and the fixture is explicitly labeled with this provenance rather than represented as the missing extraction. The two older field-export source documents are not recoverable from this repository's tests, so no synthetic copies are added.
