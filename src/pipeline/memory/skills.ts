/** Layer 3 — procedural memory (skills). Selection is deterministic keyword/pattern
 * scoring: NO embedding calls, NO model call to choose skills (C3).
 */
import { estimateTokens } from './tokens';
import { lintSkill, parseSkillFile, serializeSkill, type ParsedSkill } from './lint';
import type { DocTraits, SkillMeta } from './types';

export type { ParsedSkill };
export { lintSkill, parseSkillFile, serializeSkill };

export const SKILL_CAP_TOKENS = 3000; // A4
export const MAX_SKILLS_PER_CALL = 3; // A4
export const STALE_MIN_INJECTIONS = 8; // C4
export const STALE_GREEN_RATE = 0.4; // C4
export const STALE_DAYS_UNUSED = 45; // C4
export const DRAFT_SHADOW_MIN_TRIGGERS = 3; // B3(b)
export const DRAFT_SHADOW_MIN_GREEN = 2; // B3(b)

export interface SkillSelectionCtx {
  userMessage?: string;
  health?: any;
  docTraits?: DocTraits;
  openIssueCodes?: string[];
  roles?: string[];
}

function haystack(ctx: SkillSelectionCtx): string {
  const parts: string[] = [];
  if (ctx.userMessage) parts.push(ctx.userMessage);
  if (ctx.health) {
    parts.push(JSON.stringify({
      state: ctx.health.state, missing: (ctx.health.missing || []).slice(0, 10),
      unplacedImages: ctx.health.unplacedImages?.length ?? ctx.health.unplacedImages,
      duplicates: ctx.health.duplicates, coveragePercent: ctx.health.coveragePercent,
    }));
  }
  if (ctx.docTraits) parts.push(JSON.stringify(ctx.docTraits));
  if (ctx.openIssueCodes?.length) parts.push(ctx.openIssueCodes.join(' '));
  return parts.join(' ').toLowerCase();
}

/** Deterministic trigger scoring. Keyword hit = 3, regex trigger hit = 4, scope fit = +1. */
export function scoreSkill(skill: ParsedSkill, ctx: SkillSelectionCtx): number {
  const hay = haystack(ctx);
  let score = 0;
  for (const raw of skill.meta.triggers || []) {
    const trigger = String(raw).trim();
    if (!trigger) continue;
    if (trigger.startsWith('/') && trigger.endsWith('/') && trigger.length > 2) {
      try { if (new RegExp(trigger.slice(1, -1), 'i').test(hay)) score += 4; } catch { /* bad regex: ignore */ }
      continue;
    }
    const token = trigger.toLowerCase();
    if (hay.includes(token)) score += 3;
  }
  const applies = skill.meta.appliesTo;
  if (applies?.roles?.length && ctx.roles?.length) {
    if (applies.roles.some(role => ctx.roles!.includes(role))) score += 1;
  }
  if (applies?.docTraits?.length && ctx.docTraits) {
    const traits = ctx.docTraits;
    const hit = applies.docTraits.some(trait => {
      const t = String(trait).toLowerCase();
      if (t.includes('rtl')) return Boolean(traits.rtl);
      if (t.includes('image')) return traits.hasImages > 0;
      if (t.includes('long')) return Boolean(traits.isLong);
      if (t.includes('key')) return Boolean(traits.hasKeyPages);
      return traits.languagesDetected?.some(lang => t.includes(lang)) ?? false;
    });
    if (hit) score += 1;
  }
  // Earned reliability: skills with a proven green rate get a small, bounded boost.
  const stats = skill.meta.stats;
  const observed = (stats?.greenAfter || 0) + (stats?.redAfter || 0);
  if (observed >= 3 && (stats.greenAfter / observed) >= 0.6) score += 1;
  return score;
}

/** Rank + pack skills: top ≤3 within the 3,000-token cap (C3/A4). */
export function selectSkillsFromPool(
  pool: ParsedSkill[],
  ctx: SkillSelectionCtx,
  capTokens = SKILL_CAP_TOKENS,
  maxSkills = MAX_SKILLS_PER_CALL,
): { selected: Array<{ skill: ParsedSkill; draftShadow: boolean }>; totalTokens: number; omitted: number; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  const eligible = pool.filter(skill => skill.meta.status === 'active' || skill.meta.status === 'draft');
  const ranked = eligible
    .map(skill => ({ skill, score: scoreSkill(skill, ctx) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.meta.slug.localeCompare(b.skill.meta.slug));
  for (const item of ranked) scores[item.skill.meta.slug] = item.score;

  const active = ranked.filter(item => item.skill.meta.status === 'active');
  const drafts = ranked.filter(item => item.skill.meta.status === 'draft');
  const selected: Array<{ skill: ParsedSkill; draftShadow: boolean }> = [];
  let totalTokens = 0;
  let omitted = 0;
  for (const item of active) {
    if (selected.length >= maxSkills) { omitted++; continue; }
    const tokens = estimateTokens(item.skill.body);
    if (totalTokens + tokens > capTokens) { omitted++; continue; }
    selected.push({ skill: item.skill, draftShadow: false });
    totalTokens += tokens;
  }
  // draft-shadow: only when its trigger scores highest AND no active skill matched (C3).
  if (!selected.length && drafts.length) {
    const top = drafts[0];
    const topActiveScore = active.length ? active[0].score : 0;
    if (top.score > topActiveScore) {
      const tokens = estimateTokens(top.skill.body);
      if (tokens <= capTokens) { selected.push({ skill: top.skill, draftShadow: true }); totalTokens += tokens; }
      else omitted++;
    } else omitted++;
  }
  omitted += Math.max(0, drafts.length - (selected.some(s => s.draftShadow) ? 1 : 0));
  return { selected, totalTokens, omitted, scores };
}

export function formatSkillsForInjection(selected: Array<{ skill: ParsedSkill; draftShadow: boolean }>): string {
  if (!selected.length) return '';
  const blocks = selected.map(({ skill, draftShadow }) => {
    const banner = draftShadow ? '\n[UNVERIFIED PROCEDURE — this skill is on trial: follow it, but do not treat it as established.]\n' : '';
    return `--- SKILL: ${skill.meta.slug} (${skill.meta.name}) ---${banner}\n${skill.body}`;
  });
  const names = selected.map(item => item.skill.meta.slug).join(', ');
  return `\n\nSKILLS (procedural memory — follow the steps that apply):\n${blocks.join('\n\n')}\nSkills: ${names}\n`;
}

/** C4 pruning — deterministic. Learned skills auto-archive; shipped skills only get a badge. */
export interface StaleReport {
  slug: string;
  source: SkillMeta['source'];
  reason: string;
  action: 'archived' | 'badge';
}

export function evaluateSkillStaleness(skills: ParsedSkill[], opts?: { now?: number; triggerDomainOccurrences?: Record<string, number> }): StaleReport[] {
  const now = opts?.now ?? Date.now();
  const reports: StaleReport[] = [];
  for (const skill of skills) {
    if (skill.meta.status !== 'active') continue;
    const stats = skill.meta.stats || { injected: 0, followed: 0, greenAfter: 0, redAfter: 0 };
    const injected = Number(stats.injected) || 0;
    const green = Number(stats.greenAfter) || 0;
    const red = Number(stats.redAfter) || 0;
    const observed = green + red;
    const rate = observed > 0 ? green / observed : 1;
    if (injected >= STALE_MIN_INJECTIONS && rate < STALE_GREEN_RATE) {
      reports.push({
        slug: skill.meta.slug, source: skill.meta.source,
        reason: `injected ${injected}× with green rate ${(rate * 100).toFixed(0)}% < 40%`,
        action: skill.meta.source === 'learned' ? 'archived' : 'badge',
      });
      continue;
    }
    const lastUsed = stats.lastUsed || stats.lastInjected;
    const idleDays = lastUsed ? (now - Date.parse(lastUsed)) / 86_400_000 : Infinity;
    const domainHits = (opts?.triggerDomainOccurrences || {})[skill.meta.slug] || 0;
    if (idleDays > STALE_DAYS_UNUSED && domainHits >= 5) {
      reports.push({
        slug: skill.meta.slug, source: skill.meta.source,
        reason: `not injected in ${Math.round(idleDays)} days while its trigger domain occurred ${domainHits}×`,
        action: skill.meta.source === 'learned' ? 'archived' : 'badge',
      });
    }
  }
  return reports;
}

/** B3(b) harness auto-activation: draft whose trigger matched ≥3 jobs and greenAfter ≥2. */
export function draftEligibleForActivation(skill: ParsedSkill, triggerMatches: number): boolean {
  if (skill.meta.status !== 'draft') return false;
  const stats = skill.meta.stats || { injected: 0, greenAfter: 0 };
  return triggerMatches >= DRAFT_SHADOW_MIN_TRIGGERS && (Number(stats.greenAfter) || 0) >= DRAFT_SHADOW_MIN_GREEN;
}

/** Shared credit/blame machinery (B2) — updates skill stats from job outcomes. */
export function applySkillOutcome(skills: ParsedSkill[], injectedSlugs: string[], outcome: { green: boolean; followed: boolean }, now = new Date().toISOString()): ParsedSkill[] {
  return skills.map(skill => {
    if (!injectedSlugs.includes(skill.meta.slug)) return skill;
    const stats = { ...(skill.meta.stats || { injected: 0, followed: 0, greenAfter: 0, redAfter: 0 }) };
    stats.injected = (Number(stats.injected) || 0) + 1;
    if (outcome.followed) stats.followed = (Number(stats.followed) || 0) + 1;
    if (outcome.green) stats.greenAfter = (Number(stats.greenAfter) || 0) + 1;
    else stats.redAfter = (Number(stats.redAfter) || 0) + 1;
    stats.lastUsed = now;
    stats.lastInjected = now;
    return { ...skill, meta: { ...skill.meta, stats } };
  });
}

export const SKILL_CAPS = { SKILL_CAP_TOKENS, MAX_SKILLS_PER_CALL };

// --- Client persistence (folder-backed via /api/memory/skills) ---
export async function loadSkills(): Promise<ParsedSkill[]> {
  try {
    const res = await fetch('/api/memory/skills');
    if (!res.ok) return [];
    const list = await res.json();
    const out: ParsedSkill[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const lint = lintSkill(String(item?.content || ''), String(item?.slug || ''));
      if (lint.ok && lint.meta) out.push(parseSkillFile(String(item.content), String(item.slug)));
    }
    return out;
  } catch { return []; }
}

export async function loadSkill(slug: string): Promise<ParsedSkill | null> {
  try {
    const res = await fetch(`/api/memory/skills/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return parseSkillFile(String(data.content || ''), slug);
  } catch { return null; }
}

export async function saveSkill(slug: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const lint = lintSkill(content, slug);
  if (!lint.ok) return { ok: false, error: lint.errors.join('; ') };
  try {
    const res = await fetch(`/api/memory/skills/${encodeURIComponent(slug)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: String(body?.error || `HTTP ${res.status}`) };
    }
    return { ok: true };
  } catch (error: any) { return { ok: false, error: String(error?.message || error) }; }
}

export async function deleteSkill(slug: string): Promise<void> {
  try { await fetch(`/api/memory/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' }); } catch { /* offline */ }
}

export async function selectSkills(ctx: SkillSelectionCtx, capTokens = SKILL_CAP_TOKENS): Promise<{ selected: Array<{ skill: ParsedSkill; draftShadow: boolean }>; totalTokens: number; omitted: number }> {
  const pool = await loadSkills();
  return selectSkillsFromPool(pool, ctx, capTokens);
}
