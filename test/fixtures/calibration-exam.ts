/** #52 deterministic calibration analogue, NOT the unavailable geometry-verified field paper.
 * 65 fully authored items; arithmetic answers and marks are computed independently of the judge.
 * The red-circle PNG is generated locally (no licensed assets, model output, or cloud calls). */
import type { ImageAsset, SourceLine } from '../../src/types';
import type { AuthoredDocument } from '../../src/pipeline/localLoop';
export const CALIBRATION_FIXTURE = 'synthetic-65-v1 (not the field exam)';
export function calibrationExam(): { document: AuthoredDocument; lines: SourceLine[]; images: ImageAsset[] } {
  const questions: AuthoredDocument['questions'] = Array.from({ length: 65 }, (_, i) => {
    const number = i + 1, answer = number % 2 ? 'b' : 'a';
    return { number, sectionTitle: 'Calibration', type: 'mcq', stem: `What is ${number} plus one?`,
      options: [{ key: 'a', text: String(number + (answer === 'a' ? 1 : 2)) }, { key: 'b', text: String(number + (answer === 'b' ? 1 : 2)) }],
      answer, points: number % 3 ? .5 : 1, sourcePages: [1], imageIds: [] };
  });
  Object.assign(questions[18], { stem: 'Which sentence describes a blue square?', answer: 'a',
    options: [{ key: 'a', text: 'A blue square.' }, { key: 'b', text: 'A green triangle.' }] });
  Object.assign(questions[19], { stem: 'Which sentence does the picture illustrate?', answer: 'a', imageIds: ['q20-picture'],
    options: [{ key: 'a', text: 'A red circle.' }, { key: 'b', text: 'A blue square.' }] });
  const totalPoints = questions.reduce((sum, q) => sum + q.points!, 0);
  const document: AuthoredDocument = { meta: { totalPoints }, sections: [{ title: 'Calibration' }], questions };
  const text = ['SECTION A — Calibration', `Total marks: ${totalPoints}`, ...questions.flatMap(q => [
    `${q.number}. ${q.stem} [${q.points}]`, q.options.map(o => `${o.key}) ${o.text}`).join('   ')])];
  return { document, lines: text.map((text, i) => ({ id: `L${String(i + 1).padStart(4, '0')}`, page: 1, text })),
    images: [{ id: 'q20-picture', page: 1, label: { caption: 'A red circle', role: 'question' } } as unknown as ImageAsset] };
}
export const CALIBRATION_CORRUPTIONS = ['swap-keys', 'truncate-stem', 'move-options', 'move-picture', 'delete-question', 'duplicate-question', 'flatten-points'] as const;
export type CalibrationCorruption = typeof CALIBRATION_CORRUPTIONS[number];
export const expectedKind: Record<CalibrationCorruption, string> = {
  'swap-keys': 'answer-correct', 'truncate-stem': 'empty-stem', 'move-options': 'uncontaminated', 'move-picture': 'image-belongs',
  'delete-question': 'missing-number', 'duplicate-question': 'duplicate-number', 'flatten-points': 'points-sum-mismatch',
};
export function plantCorruption(document: AuthoredDocument, kind: CalibrationCorruption): AuthoredDocument {
  const doc = structuredClone(document), q = doc.questions;
  if (kind === 'swap-keys') [q[0].answer, q[1].answer] = [q[1].answer, q[0].answer];
  if (kind === 'truncate-stem') q[4].stem = q[4].stem.slice(0, 12); // proven against the numbered source
  if (kind === 'move-options') { q[3].options.push(...q[2].options); q[2].options = []; }
  if (kind === 'move-picture') { q[18].imageIds = q[19].imageIds; q[19].imageIds = []; }
  if (kind === 'delete-question') q.splice(9, 1);
  if (kind === 'duplicate-question') q.splice(11, 0, structuredClone(q[10]));
  if (kind === 'flatten-points') q.forEach(item => { item.points = 1; });
  return doc;
}

export const calibrationPixels = { id: 'q20-picture', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABWElEQVR4nO3cwXHDMBQDUVfi/otKL0kHWYsiPijP7rAA4Z1Fvn7t317tDzg9gSCBIIEggSCBIIEggSCBIIEggSCBIIGgGtDP+331VL5zGmjBpSs1BLTFpSIVBwrRjDEFgQZoBphSQMM6OaMIUEUnZLQZqEgTYtoJVHdJGG0DqouEjPYA1S1yRhuA6gpRo7tA9f1pI4GSQPXlA0brQPXNM0aLQPW1Y0YCBYDqOyeNBNoNVF84bCSQQJNA9W3zRgIJNAZUX1UxEkgggQQSSKADj0ACCSSQQAcfgQQSSCCBDj77gb7J6PPJAgk0CfQdRpf2CiTQMNDTja6OFSgA9FyjhaUCZYCeaLQ20/+kk0BPMbozUKAw0PlGN9d5XwzyxiHknVXIW8+Q9+YhX16AfLsD8vUXyPeDIF+ggnzDDPIVPEggSCBIIEggSCBIIEggSCBIIEggSCBIIOgPA8MrvdLy8EoAAAAASUVORK5CYII=' };
