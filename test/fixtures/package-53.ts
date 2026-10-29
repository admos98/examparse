/** Synthetic, agent-authored package fixtures; not a field/reference exam. */
export const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,1,2,3]);
export const png2 = Uint8Array.from([137,80,78,71,13,10,26,10,4,5,6,7]);
export const passage = ('A traveller went to a small town and met a teacher at the station. The teacher described the library and its history. ').repeat(3).trim();
export const provenance = { source_type: 'claimed', source_ref: 'synthetic source', extra: { retained: true } };
const opts = ['alpha', 'beta', 'gamma', 'delta'].map((text, i) => ({ key: 'ABCD'[i], text }));
export function authoredPackage() {
  const qs = Array.from({ length: 8 }, (_, i) => ({ type: 'multiple_choice', title: `Question ${i + 1}`, stem: `Choose for question ${i + 1}.`, options: opts, answer_key: { correct: ['A'], grading: 'auto' } as any, points: 1 as number | null, grade: '10', subject: 'English', curriculum_hints: null, difficulty: null, provenance }));
  qs[1].answer_key = null; qs[1].points = null;
  qs[2] = { ...qs[2], type: 'fill_in_blank', options: [], answer_key: { correct: ['century'], grading: 'manual' } };
  for (let i = 3; i < 6; i++) qs[i].stem = `${passage}\n\nQuestion ${i + 1}: What happened?`;
  qs[6].stem = `Which sentence matches the picture? ![picture](data:image/png;base64,${Buffer.from(png).toString('base64')})`;
  qs[7].title = 'Question 39';
  qs.push({ ...qs[0], title: 'Question 40', stem: 'Choose for question 40.' });
  return { batch_id: 'synthetic-batch', source_dataset: 'synthetic', questions: qs };
}
export function file(name: string, content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { name, webkitRelativePath: name, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}
