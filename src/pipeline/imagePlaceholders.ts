/** #57 Part C — package image placeholder tokens are REFERENCES, never student-facing text.
 *
 * Field defect: stems carried the literal text `img_<sha>` / `img_<sha>stem` (and markdown
 * `assets/<sha>.<ext>` links) while the asset files were ignored, so Step 4 rendered tokens and
 * the bank export reported zero images. These helpers find and strip every recognized token form
 * against the package's known asset shas. Shared by import (strip + attach at the offset),
 * bank/structured export (belt-and-braces scrub) and Step 4 (rendered text).
 */

export interface PlaceholderTokenHit {
  start: number;
  end: number;
  /** Lowercased hex digest as written in the text. */
  sha: string;
}

/** Recognized forms: markdown image `![alt](assets/<sha>.<ext>)`, `img_<sha>[stem]`, `assets/<sha>.<ext]`. */
const TOKEN_SOURCE = String.raw`(?:!\[[^\]]*\]\((?:\.\/)?(?:assets\/)?([0-9a-f]{16,64})(?:\.[a-z0-9]{2,5})?\))|(?:img_([0-9a-f]{16,64})(?:stem)?(?![a-z0-9]))|(?:assets\/([0-9a-f]{16,64})(?:\.[a-z0-9]{2,5})?)`;

function tokenPattern(): RegExp {
  return new RegExp(TOKEN_SOURCE, 'gi');
}

/** Every placeholder token in `text`, in document order. */
export function findImagePlaceholderTokens(text: string): PlaceholderTokenHit[] {
  const hits: PlaceholderTokenHit[] = [];
  for (const match of (text || '').matchAll(tokenPattern())) {
    const sha = (match[1] || match[2] || match[3] || '').toLowerCase();
    if (sha) hits.push({ start: match.index, end: match.index + match[0].length, sha });
  }
  return hits;
}

/** Remove every recognized placeholder token. Used by export scrubbing and Step-4 rendering. */
export function stripImagePlaceholderTokens(text: string): string {
  return (text || '').replace(tokenPattern(), '');
}

/** Resolve a written digest against known asset shas (exact, or a written prefix of one). */
export function resolvePlaceholderSha(sha: string, knownShas: Iterable<string>): string | undefined {
  const needle = sha.toLowerCase();
  let prefixed: string | undefined;
  for (const known of knownShas) {
    const candidate = known.toLowerCase();
    if (candidate === needle) return known;
    if (!prefixed && candidate.startsWith(needle)) prefixed = known;
  }
  return prefixed;
}
