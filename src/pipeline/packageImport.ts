/** Import authored and Appendix A packages without asking a model to reconstruct them. */
import type { ExamDoc, ImageAsset, Question } from '../types';
import { sha256 } from '../utils/hash';
import { normalizeIdentity } from './identity';
import { isPackageListeningQuestion, packageListeningEvidence } from './packageListening';

export interface PackageFile { name: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; type?: string; webkitRelativePath?: string }
const types: Record<string, Question['type']> = { multiple_choice: 'mcq', true_false: 'truefalse', fill_in_blank: 'fillblank', short_answer: 'short', matching: 'matching', ordering: 'multi' };
const mimeFor = (name: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' } as Record<string, string>)[name.split('.').pop()!.toLowerCase()];
function numberFromTitle(title: string, fallback: number): number {
  const match = /(?:question|\bq)\s*[-#.:]?\s*(\d+)/i.exec(title) || /^\s*(\d+)(?=[A-Za-z]|\s*[.):])/.exec(title);
  return match ? Number(match[1]) : fallback;
}
function labelFromTitle(title: string, fallback: number): string {
  return /(?:question|\bq)\s*[-#.:]?\s*(\d+[A-Za-z]?(?:[-–][A-Za-z0-9]+)?)(?![A-Za-z0-9])/i.exec(title)?.[1] || /^\s*(\d+[A-Za-z]?(?:[-–][A-Za-z0-9]+)?)(?=\s|[.):]|$)/.exec(title)?.[1] || String(fallback);
}
function sectionTitle(title: string): string | undefined {
  const range = title.match(/^(.*?\b(?:questions?|q)\s*\d+\s*[-–]\s*\d+[^\n]*)/i);
  if (range) return range[1].trim();
  // A title that is only a question title is not a section.
  if (/^(?:question|q)\s*\d+\b/i.test(title) || !title.trim()) return undefined;
  const prefix = title.match(/^(.+?)\s*[:—–-]\s*(?:question|q)\s*\d+/i);
  return prefix?.[1].trim();
}
/** Prefer explicit package groups, then repeated title suffixes, then textual markers. */
function deriveSections(batch: any): { rule: 'explicit' | 'title-suffix' | 'marker' | 'fallback'; labels: string[] } {
  const rows: any[] = batch.questions;
  const numbers = rows.map((r, i) => numberFromTitle(String(r?.title || ''), i + 1));
  const groupName = (value: any): string => typeof value === 'string' ? value.trim() : typeof value?.title === 'string' ? value.title.trim() : typeof value?.name === 'string' ? value.name.trim() : '';
  const explicit = rows.map((r, i) => {
    const own = groupName(r?.section) || groupName(r?.section_title) || groupName(r?.sectionTitle);
    if (own) return own;
    const group = Array.isArray(batch.sections) && batch.sections.find((g: any) => {
      const start = Number(g?.start ?? g?.first ?? g?.from ?? g?.firstQuestion ?? g?.first_question ?? g?.appliesToFirst);
      const end = Number(g?.end ?? g?.last ?? g?.to ?? g?.lastQuestion ?? g?.last_question ?? g?.appliesToLast ?? start);
      if (r?.section_id != null && r.section_id === g?.id) return true;
      return (Number.isFinite(start) && Number.isFinite(end) && numbers[i] >= start && numbers[i] <= end) ||
        (Array.isArray(g?.questions ?? g?.question_numbers) && (g.questions ?? g.question_numbers).some((x: any) => x === numbers[i] || (r?.id != null && x === r.id) || (typeof x === 'object' && x?.id && x.id === r?.id)));
    });
    return groupName(group);
  });
  const fill = (labels: string[]) => {
    let current = labels.find(Boolean) || 'Imported questions';
    return labels.map(label => { if (label) current = label; return current; });
  };
  if (explicit.some(Boolean)) return { rule: 'explicit', labels: fill(explicit) };
  const suffixes = rows.map(r => /^\s*(?:question|q)\s*\d+\s*[—–-]\s*(.+?)\s*$/i.exec(String(r?.title || ''))?.[1]?.trim() || '');
  const runs = suffixes.map(() => '');
  for (let i = 0; i < suffixes.length;) {
    let j = i + 1;
    while (j < suffixes.length && suffixes[i] && suffixes[j].toLocaleLowerCase() === suffixes[i].toLocaleLowerCase() && numbers[j] === numbers[j - 1] + 1) j++;
    if (suffixes[i] && j - i >= 2) for (let k = i; k < j; k++) runs[k] = suffixes[i];
    i = j;
  }
  if (runs.some(Boolean)) return { rule: 'title-suffix', labels: fill(runs) };
  const markers = rows.map(r => {
    const text = [r?.instructions, r?.stem, ...(Array.isArray(r?.stem_blocks) ? r.stem_blocks.filter((b: any) => b?.t === 'text').map((b: any) => b.v) : [])].filter(x => typeof x === 'string').join('\n');
    return /^\s*(?:section|part)\s+([A-Za-z0-9]+(?:\s*[:—–-]\s*[^\n]+)?)\s*$/im.exec(text)?.[0]?.trim() || sectionTitle(String(r?.title || '')) || '';
  });
  return markers.some(Boolean) ? { rule: 'marker', labels: fill(markers) } : { rule: 'fallback', labels: rows.map(() => 'Imported questions') };
}
function commonPrefix(a: string, b: string): string {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const prefix = a.slice(0, i);
  // Factor whole prefix blocks only, not an arbitrary shared fragment of a question.
  const boundary = Math.max(prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('\r\n\r\n'));
  return boundary >= 200 ? prefix.slice(0, boundary).trimEnd() : '';
}
export async function importQuestionPackage(files: PackageFile[]): Promise<ExamDoc> {
  const jsons = files.filter(f => /\.json$/i.test(f.name) && !/export-report\.json$/i.test(f.name));
  const json = jsons.find(f => /(^|\/)batch\.json$/i.test(f.webkitRelativePath || f.name)) || (jsons.length === 1 ? jsons[0] : undefined);
  if (!json) throw new Error('Select one package JSON (or batch.json) together with its images.');
  const raw = await json.text(); let batch: any;
  try { batch = JSON.parse(raw); } catch { throw new Error('Package JSON is invalid.'); }
  if (!batch || typeof batch.batch_id !== 'string' || !Array.isArray(batch.questions) || !batch.questions.length) throw new Error('Package must have a batch_id and a nonempty questions array.');
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is required to import package images.');
  const images: ImageAsset[] = []; const byHash = new Map<string, ImageAsset>(); const fileAssets = new Map<string, ImageAsset>();
  const addAsset = async (bytes: Uint8Array, mime: string) => {
    const hash = await sha256(bytes); let asset = byHash.get(hash);
    if (!asset) {
      let data = ''; for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192));
      asset = { id: `img_${hash}`, page: 1, bbox: { x: 0, y: 0, w: 0, h: 0 }, mime, sha: hash, width: 0, height: 0, blobKey: hash, dataUrl: `data:${mime};base64,${btoa(data)}` };
      byHash.set(hash, asset); images.push(asset);
    }
    return asset;
  };
  for (const file of files) {
    const mime = mimeFor(file.name); if (!mime) continue;
    const asset = await addAsset(new Uint8Array(await file.arrayBuffer()), mime);
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    fileAssets.set(path.toLowerCase(), asset); fileAssets.set(file.name.toLowerCase(), asset);
    fileAssets.set(asset.sha.toLowerCase(), asset);
  }
  const sections: ExamDoc['sections'] = []; const derivation = deriveSections(batch);
  const structuralOwners = new Map<string, Set<string>>();
  const markStructural = (imageId: string, questionId: string) => { const owners = structuralOwners.get(imageId) || new Set<string>(); owners.add(questionId); structuralOwners.set(imageId, owners); };
  const questions: Question[] = [];
  for (let index = 0; index < batch.questions.length; index++) {
    const row = batch.questions[index];
    if (!row || typeof row !== 'object' || typeof row.type !== 'string' || (typeof row.stem !== 'string' && !Array.isArray(row.stem_blocks))) throw new Error(`Question ${index + 1} needs a type and stem or stem_blocks.`);
    const title = typeof row.title === 'string' ? row.title : '';
    const explicitLabel = typeof row.label === 'string' && /^\d+[A-Za-z]?(?:[-–][A-Za-z0-9]+)?$/.test(row.label.trim()) ? row.label.trim() : undefined;
    const no = explicitLabel ? Number(/^\d+/.exec(explicitLabel)![0]) : numberFromTitle(title, index + 1); const st = derivation.labels[index];
    if (!sections.length || sections[sections.length - 1].title !== st) sections.push({ id: `section_${sections.length + 1}`, index: sections.length, title: st, spans: [] });
    const refs: Question['images'] = [];
    const positions: NonNullable<Question['packageImagePositions']> = [];
    const attach = (asset?: ImageAsset) => { if (asset && !refs.some(r => r.imageId === asset.id)) refs.push({ imageId: asset.id, role: 'stem' }); };
    let stem = '';
    if (Array.isArray(row.stem_blocks)) {
      for (const block of row.stem_blocks) {
        if (block?.t === 'text' && typeof block.v === 'string') stem += block.v;
        if (block?.t === 'img' && typeof block.asset === 'string') {
          const asset = fileAssets.get(block.asset.toLowerCase()) || fileAssets.get(block.asset.split('/').pop()!.toLowerCase());
          if (!asset) throw new Error(`Missing package asset: ${block.asset}`);
          attach(asset); positions.push({ imageId: asset.id, offset: stem.length });
        }
      }
    } else {
      const pattern = /!\[[^\]]*\]\((data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+))\)/g;
      let previous = 0; let match: RegExpExecArray | null;
      while ((match = pattern.exec(row.stem))) {
        stem += row.stem.slice(previous, match.index); previous = pattern.lastIndex;
        let decoded: string; try { decoded = atob(match[3].replace(/\s/g, '')); } catch { throw new Error(`Invalid embedded image in question ${no}.`); }
        const asset = await addAsset(Uint8Array.from(decoded, c => c.charCodeAt(0)), match[2]); attach(asset); positions.push({ imageId: asset.id, offset: stem.length });
      }
      stem += row.stem.slice(previous);
    }
    // Script filenames are provenance, not instructions a student can follow.
    const originalStem = stem;
    const replacements: Array<{ start: number; end: number; length: number }> = [];
    stem = stem.replace(/Listen to[^.\n]*?\b(?:listening[^\s,]*|transcript[^\s,]*)\.md(?:\s*,?\s*Section\s+(\d+))?\s*\./gi,
      (match, section, offset) => { const clean = `Listen to the recording${section ? ` (Section ${section})` : ''}.`; replacements.push({ start: offset, end: offset + match.length, length: clean.length }); return clean; });
    for (const position of positions) {
      const original = position.offset;
      position.offset = original + replacements.reduce((delta, r) => delta + (original >= r.end ? r.length - (r.end - r.start) : original > r.start ? r.length - (original - r.start) : 0), 0);
    }
    for (const ref of refs) markStructural(ref.imageId, `q_${index + 1}`);
    const sourceTextLength = stem.trim().length + (Array.isArray(row.options) ? row.options.reduce((n: number, o: any) => n + String(o?.text ?? '').length, 0) : 0);
    const leading = stem.length - stem.trimStart().length;
    positions.forEach(p => { p.offset = Math.max(0, p.offset - leading); });
    const key = row.answer_key;
    const answer = key && Array.isArray(key.correct) && key.correct.length ? { text: key.correct.map(String).join(', '), source: 'paper' as const } : undefined;
    const { stem: _stem, stem_blocks: _blocks, options: _options, ...metadata } = row;
    if (stem !== originalStem) metadata.provenance = { ...(metadata.provenance || {}), source_ref: [metadata.provenance?.source_ref, originalStem.match(/[^.\n]*(?:listening|transcript)[^\n]*?\.md[^\n]*/i)?.[0]?.trim()].filter(Boolean).join(' — ') };
    questions.push({ id: `q_${index + 1}`, no, label: explicitLabel || labelFromTitle(title, no), sectionId: sections[sections.length - 1].id, spans: [], stem: stem.trim(), type: types[row.type] || 'unknown',
      options: Array.isArray(row.options) ? row.options.map((o: any) => ({ key: String(o.key), text: String(o.text ?? ''), spans: [] })) : [],
      ...(answer ? { answer } : {}), points: row.points == null ? null : row.points, images: refs, packageImagePositions: positions, packageSourceTextLength: sourceTextLength, confidence: null as unknown as number, imported: structuredClone(metadata) });
  }
  // Only an explicit section or an unambiguous range is evidence of ownership.
  const scripts: Array<{ id: string; text: string; first?: number; last?: number }> = [];
  for (const file of files.filter(f => /^(?:listening.*|transcript.*)\.md$/i.test(f.name))) {
    const text = await file.text();
    for (const block of text.matchAll(/^##\s+Section\s+(\d+)\b([^\n]*)\n([\s\S]*?)(?=^##\s+|$(?![\s\S]))/gim)) {
      const range = /(?:questions?|q(?:uestions)?\.?|items?)\s*(\d+)\s*[-–—]\s*(?:q(?:uestions)?\.?\s*)?(\d+)/i.exec(block[2]) || /\(\s*(\d+)\s*[-–—]\s*(\d+)\s*\)/.exec(block[2]);
      scripts.push({ id: block[1], text: block[3].trim(), ...(range ? { first: Number(range[1]), last: Number(range[2]) } : {}) });
    }
  }
  const packageScriptReceipt: NonNullable<ExamDoc['source']['packageScriptReceipt']> = [];
  for (const q of questions) {
    // Do not trust an unscoped script supplied in generic metadata.
    const directTranscript = typeof q.imported?.transcript === 'string' ? q.imported.transcript : undefined;
    if (q.imported) { delete q.imported.script; delete q.imported.transcript; }
    const section = sections.find(s => s.id === q.sectionId);
    const evidence = packageListeningEvidence(q);
    if (!isPackageListeningQuestion(q, section?.title)) continue;
    const refs = [...evidence.matchAll(/\b(?:section|group)\s+(\d+)\b/gi)].map(m => m[1]);
    const explicit = [...new Set(refs)];
    let candidates = explicit.length ? (explicit.length === 1 ? scripts.filter(b => b.id === explicit[0]) : []) : scripts.filter(b => b.first != null && q.no >= b.first && q.no <= b.last!);
    if (!explicit.length && candidates.length === 0) {
      const groups = Array.isArray(batch.instructionGroups) ? batch.instructionGroups : Array.isArray(batch.instruction_groups) ? batch.instruction_groups : [];
      const memberships = groups.filter((g: any) => {
        const ids = q.instructionGroups || q.imported?.instructionGroups || q.imported?.instruction_groups || [];
        const refs = Array.isArray(ids) ? ids : [ids];
        const members = g.questions ?? g.question_numbers ?? g.members ?? [];
        return (g.id != null && refs.some((id: unknown) => String(id) === String(g.id))) ||
          (Array.isArray(members) && members.some((member: any) => String(member?.id ?? member?.label ?? member) === q.label || (q.imported?.id != null && String(member?.id ?? member) === String(q.imported.id)))) ||
          (q.no >= Number(g.appliesToFirst ?? g.start) && q.no <= Number(g.appliesToLast ?? g.end));
      });
      candidates = scripts.filter(b => b.first != null && memberships.some((g: any) => Number(g.appliesToFirst ?? g.start) >= b.first! && Number(g.appliesToLast ?? g.end) <= b.last!));
    }
    const mapped = candidates.length === 1 && candidates[0].text ? candidates[0] : undefined;
    if (mapped) q.imported = { ...q.imported, script: mapped.text };
    else if (!scripts.length && directTranscript?.trim()) q.imported = { ...q.imported, transcript: directTranscript };
    packageScriptReceipt.push({ label: q.label, sectionId: mapped?.id || null });
  }
  // Filename assignment is explicit evidence; a duplicate asset may have multiple owners.
  for (const file of files) {
    const match = /(?:^|[\/\\])questions?[-_\s]*(\d+[A-Za-z]?(?:[-_][A-Za-z0-9]+)?)(?=\.[^.]+$)/i.exec(file.webkitRelativePath || file.name);
    if (!match) continue;
    const asset = fileAssets.get((file.webkitRelativePath || file.name).toLowerCase()) || fileAssets.get(file.name.toLowerCase()); if (!asset) continue;
    const label = match[1].replace(/_/g, '-');
    const range = /^(\d+)-(\d+)$/.exec(label);
    for (const q of questions) if (range ? q.no >= Number(range[1]) && q.no <= Number(range[2]) && /^\d+$/.test(q.label) : q.label.toLowerCase() === label.toLowerCase()) { if (!q.images.some(r => r.imageId === asset.id)) q.images.push({ imageId: asset.id, role: 'stem' }); markStructural(asset.id, q.id); }
  }
  for (const image of images) {
    const owners = questions.filter(q => q.images.some(ref => ref.imageId === image.id));
    if (owners.length >= 2) image.packageShared = { ownerIds: owners.map(q => q.id), structural: owners.every(q => structuralOwners.get(image.id)?.has(q.id)) };
  }
  const passages: NonNullable<ExamDoc['passages']> = [];
  // A repeated passage can only own a contiguous run in its section. A different
  // passage-length block is a hard boundary, even if the old text reappears later.
  const passageRun = (anchor: number, core: string): Question[] => {
    const sectionId = questions[anchor].sectionId;
    const compatible = (q: Question) => q.sectionId === sectionId && (!q.passageId || !!passages.find(p => p.id === q.passageId)?.text.includes(core)) && (!(q.stem || '').split(/\n\s*\n/).some(block => block.trim().length >= 200) || (q.stem || '').includes(core));
    let first = anchor, last = anchor;
    while (first > 0 && questions[first].no === questions[first - 1].no + 1 && compatible(questions[first - 1])) first--;
    while (last + 1 < questions.length && questions[last + 1].no === questions[last].no + 1 && compatible(questions[last + 1])) last++;
    return questions.slice(first, last + 1);
  };
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].passageId) continue;
    let best = '';
    for (let j = i + 1; j < questions.length; j++) { const prefix = commonPrefix(questions[i].stem || '', questions[j].stem || ''); const core = prefix.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length >= 200).sort((a,b) => b.length-a.length)[0] || prefix; if (prefix.length > best.length && passageRun(i, core).filter(q => !q.passageId && (q.stem || '').startsWith(prefix) && /^\s*\n/.test((q.stem || '').slice(prefix.length))).length >= 3) best = prefix; }
    if (!best) continue;
    const bestCore = best.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length >= 200).sort((a,b) => b.length-a.length)[0] || best;
    const group = passageRun(i, bestCore).filter(q => !q.passageId && (q.stem || '').startsWith(best) && /^\s*\n/.test((q.stem || '').slice(best.length)));
    const id = `passage_${passages.length + 1}`;
    passages.push({ id, sectionTitle: sections.find(s => s.id === group[0].sectionId)?.title || 'Imported questions', text: best });
    const min = Math.min(...group.map(q => q.no)), max = Math.max(...group.map(q => q.no));
    for (const q of passageRun(i, bestCore)) {
      if (q.sectionId === group[0].sectionId && q.no >= min && q.no <= max && !q.passageId && !group.includes(q) && !(q.stem || '').split(/\n\s*\n/).some(block => block.trim().length >= 200)) q.passageId = id;
    }
    for (const q of group) { q.passageId = id; const suffix = q.stem!.slice(best.length); const removed = best.length + suffix.length - suffix.trimStart().length; q.stem = suffix.trimStart(); q.packageImagePositions = q.packageImagePositions?.map(p => ({ ...p, offset: Math.max(0, p.offset - removed) })); }
  }
  // Some subheaders precede the same passage. Match the factored passage block even
  // when it no longer begins at offset zero, then inherit across the full run.
  for (const passage of passages) {
    const members = questions.filter(q => q.passageId === passage.id);
    if (!members.length) continue;
    const sectionId = members[0].sectionId;
    const blocks = passage.text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length >= 200).sort((a,b) => b.length - a.length);
    const core = blocks[0] || passage.text;
    if (core.length < 200) continue;
    const run = passageRun(questions.indexOf(members[0]), core);
    for (const q of run.filter(q => q.sectionId === sectionId && !q.passageId && (q.stem || '').includes(core))) {
      const stem = q.stem || ''; const at = stem.indexOf(core);
      const remainder = (stem.slice(0, at) + stem.slice(at + core.length)).trim();
      // A different passage-length block belongs to its own run.
      if (remainder.split(/\n\s*\n/).some(block => block.trim().length >= 200)) continue;
      q.passageId = passage.id;
      q.stem = remainder;
      q.packageImagePositions = q.packageImagePositions?.map(p => ({ ...p, offset: Math.max(0, p.offset <= at ? p.offset : p.offset - core.length) }));
    }
    const linked = questions.filter(q => q.passageId === passage.id);
    const min = Math.min(...linked.map(q => q.no)), max = Math.max(...linked.map(q => q.no));
    for (const q of run) if (q.sectionId === sectionId && !q.passageId && q.no >= min && q.no <= max && !(q.stem || '').split(/\n\s*\n/).some(block => block.trim().length >= 200)) q.passageId = passage.id;
  }
  const optionalGroups: NonNullable<ExamDoc['optionalGroups']> = [];
  // An announced pair of labelled ranges is stronger than adjacency and also
  // covers packages which print the instruction only on the first item.
  for (const q of questions) {
    const text = `${q.imported?.instructions || ''} ${q.stem || ''}`;
    if (!/\b(?:either|optional|choose|select)\b/i.test(text) || !/\bor\b/i.test(text)) continue;
    const ranges = [...text.matchAll(/\b(\d+)([A-Za-z])\s*[-–—]\s*(\d+)\2\b/gi)];
    if (ranges.length !== 2 || ranges[0][2].toUpperCase() === ranges[1][2].toUpperCase()) continue;
    const branches: Record<string, string[]> = {};
    for (const range of ranges) {
      const branch = range[2].toUpperCase(); const first = Number(range[1]), last = Number(range[3]);
      branches[branch] = questions.filter(item => !item.optionalGroupId && item.no >= first && item.no <= last && new RegExp(`^\\d+${branch}$`, 'i').test(item.label)).map(item => item.label);
    }
    if (Object.values(branches).some(labels => !labels.length)) continue;
    const id = `optional_${optionalGroups.length + 1}`; const memberLabels = Object.values(branches).flat();
    for (const item of questions.filter(item => memberLabels.includes(item.label))) { item.optionalGroupId = id; item.optionalBranch = Object.keys(branches).find(branch => branches[branch].includes(item.label)); }
    const total = /(?:total|each (?:branch|part))\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(text);
    optionalGroups.push({ id, rule: 'choose-one-branch', memberLabels, branches, ...(total ? { printedTotal: Number(total[1]) } : {}) });
  }
  const byBase = new Map<number, Question[]>();
  for (const q of questions.filter(q => !q.optionalGroupId)) { const m = /^(\d+)([A-Za-z])(?:[-–][A-Za-z0-9]+)?$/.exec(q.label); if (m) byBase.set(q.no, [...(byBase.get(q.no) || []), q]); }
  const paired = [...byBase.entries()].filter(([, qs]) => new Set(qs.map(q => /^(?:\d+)([A-Za-z])/.exec(q.label)![1].toUpperCase())).size === 2).sort((a,b) => a[0]-b[0]);
  for (let i = 0; i < paired.length;) {
    let j = i + 1;
    const signature = (qs: Question[]) => [...new Set(qs.map(q => /^(?:\d+)([A-Za-z])/.exec(q.label)![1].toUpperCase()))].sort().join('');
    const ruleText = (qs: Question[]) => String(qs[0].imported?.instructions || /(?:optional\s+group[^\n]*|(?:answer|choose|select)\s+either[^\n]*)/i.exec(qs[0].stem || '')?.[0] || '').trim();
    while (j < paired.length && paired[j][0] === paired[j-1][0] + 1 && signature(paired[j][1]) === signature(paired[i][1]) && paired[j][1][0].sectionId === paired[i][1][0].sectionId && ruleText(paired[j][1]) === ruleText(paired[i][1])) j++;
    const candidates = paired.slice(i,j).flatMap(([, qs]) => qs);
    const announcement = candidates.map(q => `${q.stem || ''} ${q.imported?.instructions || ''}`).join(' ');
    const announcedBranch = /(?:answer|choose|select)\s+either[\s\S]{0,200}\bor\b|optional\s+group/i.test(announcement);
    // Label pairs are only optional when under a shared instruction, or an explicit rule.
    const instruction = (q: Question) => q.imported?.instructions || (Array.isArray(q.imported?.instructionGroups) ? JSON.stringify(q.imported.instructionGroups) : '');
    const sameInstruction = candidates.every(q => q.sectionId === candidates[0].sectionId && instruction(q) === instruction(candidates[0]));
    if (announcedBranch || (sameInstruction && !!instruction(candidates[0]))) {
      const id = `optional_${optionalGroups.length + 1}`; const branches: Record<string,string[]> = {};
      for (const q of candidates) { const branch = /^(?:\d+)([A-Za-z])/.exec(q.label)![1].toUpperCase(); (branches[branch] ||= []).push(q.label); q.optionalGroupId = id; q.optionalBranch = branch; }
      const total = /(?:total|each (?:branch|part))\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(announcement);
      optionalGroups.push({ id, rule: announcedBranch && paired.slice(i,j).length > 1 ? 'choose-one-branch' : 'choose-one-per-number', memberLabels: candidates.map(q => q.label), branches, ...(total ? { printedTotal: Number(total[1]) } : {}) });
    }
    i = j;
  }
  const collisions = [...new Set(questions.map(q => q.no))].map(number => ({ number, labels: questions.filter(q => q.no === number).map(q => q.label) })).filter(c => c.labels.length > 1 && new Set(c.labels).size === c.labels.length);
  const fileHash = await sha256(raw + '\n' + [...fileAssets.entries()].map(([name, image]) => `${name}:${image.sha}`).sort().join('\n') + [...byHash.keys()].sort().join('\n')); 
  const originalGrade = batch.grade ?? batch.questions[0]?.grade; const originalSubject = batch.subject ?? batch.questions[0]?.subject;
  const identity = normalizeIdentity(originalGrade, originalSubject);
  const title = typeof batch.title === 'string' && batch.title.trim() ? batch.title.trim() : [identity.subject, identity.gradeDisplay || identity.grade].filter(Boolean).join(' — ') || batch.source_dataset || batch.batch_id;
  const languageSample = questions.map(q => `${q.stem || ''} ${(q.options || []).map(o => o.text || '').join(' ')}`).join(' ');
  const inferredRtl = (languageSample.match(/[\u0600-\u06ff]/g) || []).length > (languageSample.match(/[A-Za-z]/g) || []).length;
  const language = typeof batch.language === 'string' && batch.language.trim() ? batch.language : inferredRtl ? 'fa' : 'en';
  const packageSectionReceipt = { rule: derivation.rule, sections: sections.map(section => ({ title: section.title || 'Imported questions', questionNumbers: questions.filter(q => q.sectionId === section.id).map(q => q.no) })) };
  return { id: `exam_${fileHash.slice(0, 12)}`, fileHash, createdAt: new Date().toISOString(), displayName: title, meta: { title, ...identity, language, direction: batch.direction === 'rtl' || (batch.direction !== 'ltr' && /^(?:fa|ar|ur)(?:-|$)/i.test(language)) ? 'rtl' : 'ltr' }, sections, passages, optionalGroups, questions, images,
    source: { kind: 'package', packageBatchId: batch.batch_id, packageJsonHash: await sha256(raw), packageDataset: batch.source_dataset, packageIdentity: { grade: originalGrade, subject: originalSubject, title: batch.title }, packageSectionReceipt, packageScriptReceipt, packageStructureReceipt: { labelsPreserved: questions.length, optionalGroups, collisions }, enrichmentStatus: 'not run', lines: [], pages: 1, ocrUsed: false, fileName: json.name }, flags: [], usage: [] };
}
