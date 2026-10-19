/** B4/C5 — Memory UI: Playbook · Skills · Activity, plus the B5 controls.
 * Everything is editable/deletable by the user; every harness write is visible in
 * Activity. Read-only mode is used for the Assistant page panel.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { lintSkill, SKILL_CAP_TOKENS, MAX_SKILLS_PER_CALL, evaluateSkillStaleness, parseSkillFile } from '../pipeline/memory/skills';
import { PLAYBOOK_CAP_TOKENS, ASSISTANT_PLAYBOOK_CAP, selectPlaybookEntries } from '../pipeline/memory/playbook';
import type { PlaybookEntry, PlaybookFile } from '../pipeline/memory/types';

async function getJson(url: string): Promise<any> {
  try { const res = await fetch(url); if (!res.ok) return null; return await res.json(); } catch { return null; }
}
async function sendJson(url: string, method: string, body?: any): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) { const data = await res.json().catch(() => ({})); return { ok: false, error: String(data?.error || `HTTP ${res.status}`) }; }
    return { ok: true };
  } catch (error: any) { return { ok: false, error: String(error?.message || error) }; }
}

interface Props {
  readOnly?: boolean;
  /** Bilingual copy follows the existing assistant language setting. */
  fa?: boolean;
}

type MemoryTab = 'playbook' | 'skills' | 'activity';

const SKILL_TEMPLATE = `---
name: My procedure
slug: my-procedure
status: draft
triggers: ["report card", "formatting"]
appliesTo: {"roles": ["agent"]}
maxTokens: 900
source: user
stats: {"injected": 0, "followed": 0, "greenAfter": 0, "redAfter": 0}
---

# My procedure

1. First step — what to check.
2. Second step — which tool, in which order.
3. What NOT to do.

Example: one tiny worked example.
`;

export const MemoryPanel: React.FC<Props> = ({ readOnly = false, fa = false }) => {
  const t = (en: string, persian: string) => (fa ? persian : en);
  const [tab, setTab] = useState<MemoryTab>('playbook');
  const [playbook, setPlaybook] = useState<PlaybookFile>({ version: 1, entries: [] });
  const [skills, setSkills] = useState<Array<{ slug: string; content: string }>>([]);
  const [activity, setActivity] = useState<{ runs: any[]; activity: any[] }>({ runs: [], activity: [] });
  const [config, setConfig] = useState({ learningEnabled: true, reflectionEnabled: true });
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<{ slug: string; content: string; isNew: boolean; activateNow: boolean } | null>(null);
  const [lessonDraft, setLessonDraft] = useState<{ id: string; lesson: string } | null>(null);

  const reload = useCallback(async () => {
    const [pb, sk, act, cfg] = await Promise.all([
      getJson('/api/memory/playbook'),
      getJson('/api/memory/skills'),
      getJson('/api/memory/activity'),
      getJson('/api/memory/config'),
    ]);
    if (pb && Array.isArray(pb.entries)) setPlaybook({ version: 1, entries: pb.entries });
    if (Array.isArray(sk)) setSkills(sk);
    if (act) setActivity({ runs: act.runs || [], activity: act.activity || [] });
    if (cfg) setConfig({ learningEnabled: cfg.learningEnabled !== false, reflectionEnabled: cfg.reflectionEnabled !== false });
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const parsedSkills = useMemo(() => skills.map(item => {
    try { return parseSkillFile(item.content, item.slug); } catch { return null; }
  }).filter(Boolean) as any[], [skills]);

  const staleReports = useMemo(() => {
    try { return evaluateSkillStaleness(parsedSkills); } catch { return []; }
  }, [parsedSkills]);

  const grouped = useMemo(() => {
    const groups: Record<string, PlaybookEntry[]> = { active: [], candidate: [], demoted: [] };
    for (const entry of playbook.entries) (groups[entry.status] ||= []).push(entry);
    return groups;
  }, [playbook]);

  const injectionPreview = useMemo(() => {
    try {
      return selectPlaybookEntries(playbook, { role: 'fast', capTokens: PLAYBOOK_CAP_TOKENS });
    } catch { return { included: [], tokens: 0, omittedCount: 0 }; }
  }, [playbook]);
  const assistantPreview = useMemo(() => {
    try { return selectPlaybookEntries(playbook, { role: 'agent', capTokens: ASSISTANT_PLAYBOOK_CAP }); } catch { return { included: [], tokens: 0 }; }
  }, [playbook]);

  async function persistPlaybook(next: PlaybookFile, note: string) {
    setPlaybook(next);
    const res = await sendJson('/api/memory/playbook', 'PUT', next);
    setMessage(res.ok ? note : `${t('Save failed', 'ذخیره ناموفق')}: ${res.error}`);
    await sendJson('/api/memory/activity', 'POST', { type: 'playbook_edit', message: note, ts: new Date().toISOString() });
    void reload();
  }

  const lint = editing ? lintSkill(editing.content, editing.slug) : null;

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {(['playbook', 'skills', 'activity'] as MemoryTab[]).map(name => (
          <button key={name} onClick={() => setTab(name)}
            className={`px-3 py-1.5 rounded-lg border ${tab === name ? 'bg-blue-600 text-white border-blue-600' : ''}`}>
            {name === 'playbook' ? t('Playbook', 'کتابچه') : name === 'skills' ? t('Skills', 'مهارت‌ها') : t('Activity', 'فعالیت')}
          </button>
        ))}
        <span className="text-slate-500 ml-auto">
          {t('Injection preview', 'پیش‌نمایش تزریق')}: pipeline {injectionPreview.included.length} {t('entries', 'درس')} / {injectionPreview.tokens} tok · assistant {assistantPreview.included.length} / {assistantPreview.tokens} tok
        </span>
      </div>

      {message && <p className="text-slate-500" role="status">{message}</p>}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl border bg-slate-50 dark:bg-slate-900/50">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={config.learningEnabled}
              onChange={async e => { const next = { ...config, learningEnabled: e.target.checked }; setConfig(next); await sendJson('/api/memory/config', 'PUT', next); setMessage(e.target.checked ? t('Learning on', 'یادگیری فعال') : t('Learning off — injections are empty and reflection makes 0 calls', 'یادگیری غیرفعال — تزریق خالی و بازاندیشی ۰ فراخوانی')); }} />
            {t('Learning', 'یادگیری')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={config.reflectionEnabled}
              onChange={async e => { const next = { ...config, reflectionEnabled: e.target.checked }; setConfig(next); await sendJson('/api/memory/config', 'PUT', next); }} />
            {t('Reflection', 'بازاندیشی')}
          </label>
          <button className="px-3 py-1.5 rounded-lg border border-red-300 text-red-600 dark:text-red-400"
            onClick={async () => {
              if (!window.confirm(t('Erase all learned memory? Playbook entries, learned skill drafts and the run journal are deleted. Exam dossiers and exams are kept.', 'همه حافظه آموخته‌شده پاک شود؟ درس‌ها، پیش‌نویس مهارت‌ها و گزارش اجراها حذف می‌شوند. آزمون‌ها باقی می‌مانند.'))) return;
              const res = await sendJson('/api/memory/erase', 'POST', {});
              setMessage(res.ok ? t('Learned memory erased; dossiers kept.', 'حافظه آموخته‌شده پاک شد؛ پرونده‌ها باقی ماندند.') : String(res.error));
              void reload();
            }}>
            {t('Erase all learned memory', 'پاک کردن همه حافظه آموخته‌شده')}
          </button>
        </div>
      )}

      {tab === 'playbook' && (
        <div className="space-y-4">
          {(['active', 'candidate', 'demoted'] as const).map(status => (
            <section key={status}>
              <h4 className="font-semibold mb-1 capitalize">{status} ({grouped[status]?.length || 0})</h4>
              <div className="space-y-2">
                {(grouped[status] || []).map(entry => (
                  <div key={entry.id} className="p-3 rounded-xl border bg-white dark:bg-slate-900 space-y-1">
                    {lessonDraft?.id === entry.id ? (
                      <textarea className="w-full border rounded p-2 text-xs" rows={3} maxLength={280}
                        value={lessonDraft.lesson} onChange={e => setLessonDraft({ id: entry.id, lesson: e.target.value })} />
                    ) : (
                      <p className="text-slate-800 dark:text-slate-200">{entry.lesson}</p>
                    )}
                    <p className="text-[11px] text-slate-500">
                      {entry.kind} · scope {JSON.stringify(entry.scope)} · evidence ✓{entry.evidence.successes} ✗{entry.evidence.failures} · runs {(entry.evidence.runIds || []).length} · confidence {entry.confidence.toFixed(2)} · last {String(entry.evidence.lastSeen || '').slice(0, 10)}
                    </p>
                    {!readOnly && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {lessonDraft?.id === entry.id ? (
                          <>
                            <button className="px-2 py-1 rounded border" onClick={() => { void persistPlaybook({ version: 1, entries: playbook.entries.map(item => item.id === entry.id ? { ...item, lesson: lessonDraft.lesson.slice(0, 280) } : item) }, `Playbook: edited '${lessonDraft.lesson.slice(0, 40)}…'`); setLessonDraft(null); }}>{t('Save', 'ذخیره')}</button>
                            <button className="px-2 py-1 rounded border" onClick={() => setLessonDraft(null)}>{t('Cancel', 'لغو')}</button>
                          </>
                        ) : (
                          <button className="px-2 py-1 rounded border" onClick={() => setLessonDraft({ id: entry.id, lesson: entry.lesson })}>{t('Edit text', 'ویرایش متن')}</button>
                        )}
                        {entry.status !== 'active' && <button className="px-2 py-1 rounded border" onClick={() => void persistPlaybook({ version: 1, entries: playbook.entries.map(item => item.id === entry.id ? { ...item, status: 'active' as const } : item) }, `Playbook: promoted '${entry.lesson.slice(0, 40)}…' manually`)}>{t('Promote now', 'ارتقا')}</button>}
                        {entry.status !== 'demoted' && <button className="px-2 py-1 rounded border" onClick={() => void persistPlaybook({ version: 1, entries: playbook.entries.map(item => item.id === entry.id ? { ...item, status: 'demoted' as const } : item) }, `Playbook: demoted '${entry.lesson.slice(0, 40)}…' manually`)}>{t('Demote', 'تنزل')}</button>}
                        <button className="px-2 py-1 rounded border border-red-300 text-red-600" onClick={() => { if (window.confirm(t('Delete this lesson?', 'این درس حذف شود؟'))) void persistPlaybook({ version: 1, entries: playbook.entries.filter(item => item.id !== entry.id) }, `Playbook: deleted '${entry.lesson.slice(0, 40)}…'`); }}>{t('Delete', 'حذف')}</button>
                      </div>
                    )}
                  </div>
                ))}
                {!(grouped[status]?.length) && <p className="text-slate-400">{t('No entries.', 'موردی نیست.')}</p>}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === 'skills' && (
        <div className="space-y-3">
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <button className="px-3 py-1.5 rounded-lg border bg-blue-600 text-white" onClick={() => {
                const slug = `user-${Date.now().toString(36)}`;
                // Keep frontmatter slug == file slug, or the linter (rightly) rejects the save.
                setEditing({ slug, content: SKILL_TEMPLATE.replace(/^slug:.*$/m, `slug: ${slug}`), isNew: true, activateNow: false });
              }}>{t('New skill', 'مهارت جدید')}</button>
              <label className="px-3 py-1.5 rounded-lg border cursor-pointer">
                {t('Import .md', 'وارد کردن .md')}
                <input type="file" accept=".md,text/markdown" className="hidden" onChange={async e => {
                  const file = e.target.files?.[0]; if (!file) return;
                  const content = await file.text();
                  // Prefer the file's own frontmatter slug; fall back to the sanitized file name
                  // and rewrite the slug line so frontmatter and file name never disagree.
                  const frontSlug = (content.match(/^slug:\s*([a-z0-9][a-z0-9-]{0,63})\s*$/m) || [])[1];
                  const slug = frontSlug || file.name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `imported-${Date.now().toString(36)}`;
                  const imported = frontSlug ? content : content.replace(/^slug:.*$/m, `slug: ${slug}`);
                  setEditing({ slug, content: imported, isNew: true, activateNow: false });
                  e.target.value = '';
                }} />
              </label>
              <span className="text-slate-500 self-center">{t(`Caps: ≤${MAX_SKILLS_PER_CALL} skills and ≤${SKILL_CAP_TOKENS} tokens per call.`, `سقف: ≤${MAX_SKILLS_PER_CALL} مهارت و ≤${SKILL_CAP_TOKENS} توکن در هر فراخوانی.`)}</span>
            </div>
          )}

          {editing && (
            <div className="p-3 rounded-xl border space-y-2 bg-slate-50 dark:bg-slate-900/60">
              <div className="flex flex-wrap items-center gap-2">
                <input className="border rounded p-1.5 font-mono text-[11px]" value={editing.slug} onChange={e => setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-') })} disabled={!editing.isNew} />
                <span className={lint?.ok ? 'text-emerald-600' : 'text-red-600'}>
                  {lint?.ok ? `✓ ${t('lint passed', 'اعتبارسنجی قبول')} · ${lint.tokens}/${lint.maxTokens} tok` : `✗ ${lint?.errors.join('; ')}`}
                </span>
                <label className="flex items-center gap-1 ml-auto"><input type="checkbox" checked={editing.activateNow} onChange={e => setEditing({ ...editing, activateNow: e.target.checked })} />{t('activate now (imports land as draft otherwise)', 'همین حالا فعال کن (واردشده‌ها وگرنه پیش‌نویس می‌مانند)')}</label>
              </div>
              <textarea className="w-full h-72 font-mono text-[11px] border rounded p-2 bg-white dark:bg-slate-950" value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })} />
              <div className="flex flex-wrap gap-2">
                <button className="px-3 py-1.5 rounded-lg border bg-blue-600 text-white disabled:opacity-40" disabled={!lint?.ok}
                  onClick={async () => {
                    let content = editing.content;
                    if (editing.activateNow) content = content.replace(/status:\s*\w+/, 'status: active');
                    const res = await sendJson(`/api/memory/skills/${encodeURIComponent(editing.slug)}`, 'PUT', { content });
                    setMessage(res.ok ? t(`Saved skill ${editing.slug} (${lint?.tokens} tokens)`, `مهارت ${editing.slug} ذخیره شد (${lint?.tokens} توکن)`) : String(res.error));
                    if (res.ok) { setEditing(null); void reload(); }
                  }}>{t('Save skill', 'ذخیره مهارت')}</button>
                <button className="px-3 py-1.5 rounded-lg border" onClick={() => setEditing(null)}>{t('Cancel', 'لغو')}</button>
                <button className="px-3 py-1.5 rounded-lg border" onClick={() => {
                  const blob = new Blob([editing.content], { type: 'text/markdown' });
                  const url = URL.createObjectURL(blob); const a = document.createElement('a');
                  a.href = url; a.download = `${editing.slug}.md`; a.click(); URL.revokeObjectURL(url);
                }}>{t('Export .md', 'خروجی .md')}</button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            {skills.map(item => {
              const parsed = parsedSkills.find(p => p.meta.slug === item.slug);
              const stale = staleReports.find(report => report.slug === item.slug);
              const meta = parsed?.meta;
              return (
                <div key={item.slug} className="p-3 rounded-xl border bg-white dark:bg-slate-900 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{meta?.name || item.slug}</b>
                    <span className="font-mono text-[10px] text-slate-500">{item.slug}</span>
                    <span className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-[10px]">{meta?.status || '?'}</span>
                    <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/60 text-[10px]">{meta?.source || '?'}</span>
                    <span className="text-[10px] text-slate-500">{parsed ? `${parsed.tokens}/${meta?.maxTokens} tok` : t('invalid file', 'فایل نامعتبر')}</span>
                    {stale && <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px]">{meta?.source === 'shipped' ? t('consider archiving', 'بررسی بایگانی') : t('stale → archived', 'فرسوده → بایگانی')}: {stale.reason}</span>}
                  </div>
                  <p className="text-[11px] text-slate-500">{t('triggers', 'محرک‌ها')}: {(meta?.triggers || []).join(', ') || '—'} · injected {meta?.stats?.injected || 0} · followed {meta?.stats?.followed || 0} · green {meta?.stats?.greenAfter || 0} · red {meta?.stats?.redAfter || 0}</p>
                  {!parsed && <p className="text-red-600 text-[11px]">{t('This file failed the linter and is not selected.', 'این فایل اعتبارسنجی نشد و انتخاب نمی‌شود.')}</p>}
                  {!readOnly && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button className="px-2 py-1 rounded border" onClick={() => setEditing({ slug: item.slug, content: item.content, isNew: false, activateNow: false })}>{t('Edit', 'ویرایش')}</button>
                      <button className="px-2 py-1 rounded border" onClick={() => {
                        // A duplicate is the user's own work: own slug, zeroed stats, source user
                        // (so it can be deleted and participates in learned-skill pruning).
                        const copySlug = `${item.slug}-copy`.slice(0, 64);
                        const copy = item.content
                          .replace(/^slug:.*$/m, `slug: ${copySlug}`)
                          .replace(/^source:.*$/m, 'source: user')
                          .replace(/^stats:.*$/m, 'stats: {"injected": 0, "followed": 0, "greenAfter": 0, "redAfter": 0}');
                        setEditing({ slug: copySlug, content: copy, isNew: true, activateNow: false });
                      }}>{t('Duplicate', 'کپی')}</button>
                      <button className="px-2 py-1 rounded border" onClick={() => {
                        const blob = new Blob([item.content], { type: 'text/markdown' });
                        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${item.slug}.md`; a.click(); URL.revokeObjectURL(url);
                      }}>{t('Export .md', 'خروجی .md')}</button>
                      {meta && meta.status !== 'active' && <button className="px-2 py-1 rounded border" onClick={async () => { const res = await sendJson(`/api/memory/skills/${encodeURIComponent(item.slug)}`, 'PUT', { content: item.content.replace(/status:\s*\w+/, 'status: active') }); setMessage(res.ok ? t('Activated', 'فعال شد') : String(res.error)); void reload(); }}>{t('Activate', 'فعال‌سازی')}</button>}
                      {meta && meta.status === 'active' && <button className="px-2 py-1 rounded border" onClick={async () => { const res = await sendJson(`/api/memory/skills/${encodeURIComponent(item.slug)}`, 'PUT', { content: item.content.replace(/status:\s*\w+/, 'status: archived') }); setMessage(res.ok ? t('Archived — leaves the selection pool, restorable in one click', 'بایگانی شد — از استخر انتخاب خارج، با یک کلیک قابل بازگردانی') : String(res.error)); void reload(); }}>{t('Archive', 'بایگانی')}</button>}
                      {meta && meta.status === 'archived' && <button className="px-2 py-1 rounded border" onClick={async () => { const res = await sendJson(`/api/memory/skills/${encodeURIComponent(item.slug)}`, 'PUT', { content: item.content.replace(/status:\s*\w+/, 'status: active') }); setMessage(res.ok ? t('Restored', 'بازگردانی شد') : String(res.error)); void reload(); }}>{t('Restore', 'بازگردانی')}</button>}
                      {meta?.source !== 'shipped' && <button className="px-2 py-1 rounded border border-red-300 text-red-600" onClick={async () => { if (!window.confirm(t('Delete this skill file?', 'این فایل مهارت حذف شود؟'))) return; const res = await sendJson(`/api/memory/skills/${encodeURIComponent(item.slug)}`, 'DELETE'); setMessage(res.ok ? t('Deleted', 'حذف شد') : String(res.error)); void reload(); }}>{t('Delete', 'حذف')}</button>}
                    </div>
                  )}
                </div>
              );
            })}
            {!skills.length && <p className="text-slate-400">{t('No skills on disk.', 'مهارتی روی دیسک نیست.')}</p>}
          </div>

          <p className="text-[11px] text-slate-500 border-t pt-2">
            {t(
              'Memory is ADVISORY, never executive: lessons and skills may inform prompts, but every deterministic gate (coverage, schema validation, ladders, confirmations, caps) fires exactly as before. A poisoned lesson can make one parse worse; it can never make the app lie about health, skip a confirmation, or exceed a cap.',
              'حافظه فقط مشورتی است، نه اجرایی: درس‌ها و مهارت‌ها می‌توانند در پرامپت اثر بگذارند، اما همه دروازه‌های قطعی (پوشش، اعتبارسنجی، نردبان‌ها، تاییدها، سقف‌ها) مثل قبل اجرا می‌شوند. یک درس خراب می‌تواند یک استخراج را بدتر کند؛ هرگز نمی‌تواند سلامت را دروغ بگوید، تایید را رد کند یا از سقف بگذرد.',
            )}
          </p>
        </div>
      )}

      {tab === 'activity' && (
        <div className="space-y-3">
          <section>
            <h4 className="font-semibold mb-1">{t('Reflection proposals & memory writes', 'پیشنهادهای بازاندیشی و نوشتارهای حافظه')}</h4>
            <div className="space-y-1">
              {activity.activity.slice().reverse().map((item: any, index: number) => (
                <p key={index} className="p-2 rounded border bg-white dark:bg-slate-900 text-[11px]">
                  <span className="font-mono text-slate-500">{String(item.ts || '').slice(0, 19)}</span> · {String(item.type || '')} · {String(item.message || item.lesson || item.slug || item.reason || '')}
                </p>
              ))}
              {!activity.activity.length && <p className="text-slate-400">{t('No memory writes yet.', 'هنوز نوشتاری نیست.')}</p>}
            </div>
          </section>
          <section>
            <h4 className="font-semibold mb-1">{t('Recent run journal (memory/runs.jsonl)', 'گزارش اجرای اخیر (memory/runs.jsonl)')}</h4>
            <div className="overflow-auto max-h-72 border rounded-lg">
              <table className="w-full text-[11px]">
                <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                  <tr><th className="p-1.5 text-left">{t('When', 'زمان')}</th><th className="p-1.5 text-left">{t('Kind', 'نوع')}</th><th className="p-1.5">{t('Health', 'سلامت')}</th><th className="p-1.5">{t('Calls', 'فراخوانی')}</th><th className="p-1.5">{t('Tokens', 'توکن')}</th><th className="p-1.5">{t('Cost', 'هزینه')}</th><th className="p-1.5 text-left">{t('Ladder', 'نردبان')}</th><th className="p-1.5">{t('Corr.', 'اصلاح')}</th></tr>
                </thead>
                <tbody>
                  {activity.runs.slice().reverse().map((run: any, index: number) => (
                    <tr key={index} className="border-t">
                      <td className="p-1.5 font-mono">{String(run.ts || '').slice(5, 19)}</td>
                      <td className="p-1.5">{run.kind}</td>
                      <td className="p-1.5 text-center">{run.outcome?.health?.parsed}/{run.outcome?.health?.expected} · {run.outcome?.health?.state}</td>
                      <td className="p-1.5 text-center">{run.outcome?.calls}</td>
                      <td className="p-1.5 text-center">{(run.outcome?.tokens?.input || 0) + (run.outcome?.tokens?.output || 0)}</td>
                      <td className="p-1.5 text-center">${Number(run.outcome?.cost || 0).toFixed(4)}</td>
                      <td className="p-1.5 truncate max-w-[220px]">{(run.ladderPath || []).join(' → ')}</td>
                      <td className="p-1.5 text-center">{run.userCorrections || 0}</td>
                    </tr>
                  ))}
                  {!activity.runs.length && <tr><td colSpan={8} className="p-4 text-center text-slate-400">{t('No completed jobs yet.', 'هنوز کاری کامل نشده.')}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      <p className="text-[11px] text-slate-500">
        {t(
          `Files live in your data folder under memory/ as plain JSON you can open and delete. Caps: playbook ≤${PLAYBOOK_CAP_TOKENS} tokens per call (assistant subset ≤${ASSISTANT_PLAYBOOK_CAP}), skills ≤${SKILL_CAP_TOKENS} tokens / ≤${MAX_SKILLS_PER_CALL} per call. Token estimates use the repo's chars/4 estimator.`,
          `فایل‌ها در پوشه داده شما زیر memory/ به‌صورت JSON ساده هستند. سقف‌ها: کتابچه ≤${PLAYBOOK_CAP_TOKENS} توکن (دستیار ≤${ASSISTANT_PLAYBOOK_CAP})، مهارت‌ها ≤${SKILL_CAP_TOKENS} توکن / ≤${MAX_SKILLS_PER_CALL} در هر فراخوانی. برآورد توکن با chars/4 است.`,
        )}
      </p>
    </div>
  );
};
