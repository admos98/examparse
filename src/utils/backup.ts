import JSZip from 'jszip';

export interface MemoryBackup {
  playbook?: any;
  runs?: any[];
  activity?: any[];
  config?: any;
  skills?: Array<{ slug: string; content: string }>;
}

export interface BackupInput {
  exams: Record<string, any>;
  images: Record<string, { sha: string; data: Uint8Array }>;
  dossiers: Record<string, any>;
  settings: any;
  /** B5 — learned memory is part of the backup zip and restorable. */
  memory?: MemoryBackup;
}

export async function createBackup(dataDir: BackupInput): Promise<Uint8Array> {
  const zip = new JSZip();
  // Whole data dir (exams, images by sha, dossiers, settings sans keys)
  for (const [id, exam] of Object.entries(dataDir.exams)) {
    zip.file(`exams/${id}.json`, JSON.stringify(exam, null, 2));
  }
  for (const [sha, blob] of Object.entries(dataDir.images)) {
    zip.file(`images/${sha}`, blob.data);
  }
  for (const [id, dossier] of Object.entries(dataDir.dossiers)) {
    zip.file(`dossiers/${id}.json`, JSON.stringify(dossier, null, 2));
  }
  const memory = dataDir.memory;
  if (memory) {
    if (memory.playbook) zip.file('memory/playbook.json', JSON.stringify(memory.playbook, null, 2));
    if (Array.isArray(memory.runs)) zip.file('memory/runs.jsonl', memory.runs.map(run => JSON.stringify(run)).join('\n') + (memory.runs.length ? '\n' : ''));
    if (Array.isArray(memory.activity)) zip.file('memory/activity.jsonl', memory.activity.map(item => JSON.stringify(item)).join('\n') + (memory.activity.length ? '\n' : ''));
    if (memory.config) zip.file('memory/memory-config.json', JSON.stringify(memory.config, null, 2));
    for (const skill of memory.skills || []) {
      if (skill?.slug && typeof skill.content === 'string') zip.file(`memory/skills/${skill.slug}.md`, skill.content);
    }
  }
  // Settings sans keys
  const settingsSansKeys = JSON.parse(JSON.stringify(dataDir.settings || {}));
  if (settingsSansKeys.providers) {
    for (const p of settingsSansKeys.providers) delete p.apiKey;
  }
  zip.file('settings.json', JSON.stringify(settingsSansKeys, null, 2));
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return buf;
}

export interface RestoredBackup {
  exams: Record<string, any>;
  images: Record<string, any>;
  dossiers: Record<string, any>;
  settings: any;
  memory: MemoryBackup;
  counts: { exams: number; images: number; dossiers: number; memorySkills: number; memoryRuns: number; playbookEntries: number };
}

export async function restoreBackup(buffer: Uint8Array | Buffer, validate: (exam: any) => boolean = () => true): Promise<RestoredBackup> {
  const zip = await JSZip.loadAsync(buffer);
  const exams: Record<string, any> = {};
  const images: Record<string, any> = {};
  const dossiers: Record<string, any> = {};
  const memory: MemoryBackup = { skills: [], runs: [], activity: [] };
  let settings: any = null;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (path.startsWith('exams/')) {
      const content = await entry.async('string');
      const parsed = JSON.parse(content);
      if (!validate(parsed)) throw new Error(`Validation failed for ${path}`);
      const id = path.replace('exams/', '').replace('.json', '');
      exams[id] = parsed;
    } else if (path.startsWith('images/')) {
      const data = await entry.async('uint8array');
      const sha = path.replace('images/', '');
      images[sha] = data;
    } else if (path.startsWith('dossiers/')) {
      const content = await entry.async('string');
      dossiers[path.replace('dossiers/', '').replace('.json', '')] = JSON.parse(content);
    } else if (path === 'memory/playbook.json') {
      const parsed = JSON.parse(await entry.async('string'));
      memory.playbook = parsed && Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
    } else if (path === 'memory/runs.jsonl') {
      const text = await entry.async('string');
      memory.runs = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } else if (path === 'memory/activity.jsonl') {
      const text = await entry.async('string');
      memory.activity = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } else if (path === 'memory/memory-config.json') {
      memory.config = JSON.parse(await entry.async('string'));
    } else if (path.startsWith('memory/skills/') && path.endsWith('.md')) {
      const slug = path.replace('memory/skills/', '').replace(/\.md$/, '');
      memory.skills = [...(memory.skills || []), { slug, content: await entry.async('string') }];
    } else if (path === 'settings.json') {
      settings = JSON.parse(await entry.async('string'));
    }
  }
  return {
    exams, images, dossiers, settings, memory,
    counts: {
      exams: Object.keys(exams).length,
      images: Object.keys(images).length,
      dossiers: Object.keys(dossiers).length,
      memorySkills: (memory.skills || []).length,
      memoryRuns: (memory.runs || []).length,
      playbookEntries: memory.playbook?.entries?.length || 0,
    },
  };
}
