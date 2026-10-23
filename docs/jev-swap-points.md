# Jev native-decision-model swap points (notes only)

- **Cleanup verdicts:** attach a future client at the cleanup-adjudication boundary in `src/pipeline/cleanup.ts`, where line-level keep/junk/suspect judgments are currently normalized; preserve the existing local-first and reversible-tag contract.
- **Segment typing:** attach at the advisory segment classification boundary in `src/pipeline/structure.ts` (`runStructurePass` / segment-wire response handling); deterministic `segment.ts` boundaries remain authoritative and Jev must not execute edits.
- **Per-question verification:** attach at `src/pipeline/semanticValidators.ts` / the local validation-and-repair boundary in `src/pipeline/assemble.ts`; emit typed verdicts as advisory findings only, with existing invariants and deterministic gates retaining execution authority.
