/** Tiny hand-rolled skill frontmatter parser + local linter (no deps).
 * Shared by the client Skills UI, the server PUT validator, and tests so the
 * rules live in exactly one place (C1/C5).
 */
import { estimateTokens } from './tokens';
import type { SkillMeta } from './types';

export interface ParsedSkill {
  meta: SkillMeta;
  body: string;
  raw: string;
  tokens: number; // body tokens (chars/4 estimator)
  slug: string;
}

export const REQUIRED_FRONTMATTER = ['name', 'slug', 'status', 'triggers', 'maxTokens', 'source'] as const;
export const DEFAULT_MAX_TOKENS = 900;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

function parseScalar(value: string): any {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    // JSON arrays first (quoted items keep spaces); a parsed non-array is wrapped.
    try { const parsed = JSON.parse(trimmed.replace(/'/g, '"')); return Array.isArray(parsed) ? parsed : [parsed]; } catch { /* fall through */ }
    try { const parsed = JSON.parse(inner.replace(/'/g, '"')); return Array.isArray(parsed) ? parsed : [parsed]; } catch { /* fall through */ }
    return inner.split(',').map(part => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return JSON.parse(trimmed.replace(/'/g, '"')); } catch { return trimmed; }
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Split a `---`-delimited frontmatter skill file. Throws named errors. */
export function parseSkillFile(content: string, slugHint?: string): ParsedSkill {
  const errors: string[] = [];
  if (typeof content !== 'string' || !content.trim()) throw new Error('missing frontmatter (empty skill file)');
  const match = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('missing frontmatter (--- delimited block not found)');
  const front = match[1];
  const body = match[2].replace(/\r/g, '').trim();
  const meta: Record<string, any> = {};
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) { errors.push(`malformed frontmatter line: ${line.slice(0, 60)}`); continue; }
    meta[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
  }
  for (const field of REQUIRED_FRONTMATTER) {
    if (meta[field] === undefined || meta[field] === '') throw new Error(`missing frontmatter field: ${field}`);
  }
  const status = String(meta.status);
  if (!['active', 'draft', 'archived'].includes(status)) throw new Error(`invalid status: ${status} (must be active|draft|archived)`);
  const source = String(meta.source);
  if (!['shipped', 'learned', 'user'].includes(source)) throw new Error(`invalid source: ${source} (must be shipped|learned|user)`);
  const slug = String(meta.slug || slugHint || '');
  if (!SAFE_SLUG.test(slug)) throw new Error(`invalid slug: "${slug}" (lowercase letters, digits, hyphens)`);
  if (slugHint && slug !== slugHint) throw new Error(`slug mismatch: frontmatter "${slug}" vs file "${slugHint}"`);
  if (!Array.isArray(meta.triggers) || meta.triggers.length === 0) throw new Error('triggers must be a non-empty array');
  const maxTokens = Number(meta.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > 4000) throw new Error(`invalid maxTokens: ${meta.maxTokens} (1..4000)`);
  const tokens = estimateTokens(body);
  if (tokens > maxTokens) throw new Error(`over budget: body ${tokens} tokens > maxTokens ${maxTokens}`);
  if (!body) throw new Error('empty skill body (procedure steps required)');
  const stats = (meta.stats && typeof meta.stats === 'object') ? meta.stats : { injected: 0, followed: 0, greenAfter: 0, redAfter: 0 };
  const normalizedStats = {
    injected: Number(stats.injected) || 0,
    followed: Number(stats.followed) || 0,
    greenAfter: Number(stats.greenAfter) || 0,
    redAfter: Number(stats.redAfter) || 0,
    lastUsed: stats.lastUsed,
    lastInjected: stats.lastInjected,
  };
  if (errors.length) throw new Error(errors.join('; '));
  return {
    meta: {
      name: String(meta.name).slice(0, 120),
      slug,
      status: status as SkillMeta['status'],
      triggers: meta.triggers.map((t: any) => String(t)),
      appliesTo: meta.appliesTo && typeof meta.appliesTo === 'object' ? meta.appliesTo : undefined,
      maxTokens,
      source: source as SkillMeta['source'],
      stats: normalizedStats,
      createdAt: meta.createdAt ? String(meta.createdAt) : undefined,
    },
    body,
    raw: content,
    tokens,
    slug,
  };
}

export interface LintResult { ok: boolean; errors: string[]; tokens?: number; maxTokens?: number; meta?: SkillMeta }

/** Local linter: runs on save/import/edit. Named errors only — never throws. */
export function lintSkill(content: string, slugHint?: string): LintResult {
  try {
    const parsed = parseSkillFile(content, slugHint);
    return { ok: true, errors: [], tokens: parsed.tokens, maxTokens: parsed.meta.maxTokens, meta: parsed.meta };
  } catch (error: any) {
    return { ok: false, errors: [String(error?.message || error)], tokens: undefined, maxTokens: undefined };
  }
}

export function serializeSkill(meta: Partial<SkillMeta>, body: string): string {
  const front = [
    `name: ${meta.name ?? 'Untitled skill'}`,
    `slug: ${meta.slug ?? 'untitled-skill'}`,
    `status: ${meta.status ?? 'draft'}`,
    `triggers: [${(meta.triggers || []).map(t => JSON.stringify(String(t))).join(', ')}]`,
    `appliesTo: ${JSON.stringify(meta.appliesTo || { roles: ['agent'] })}`,
    `maxTokens: ${meta.maxTokens ?? DEFAULT_MAX_TOKENS}`,
    `source: ${meta.source ?? 'user'}`,
    `stats: ${JSON.stringify(meta.stats || { injected: 0, followed: 0, greenAfter: 0, redAfter: 0 })}`,
    ...(meta.createdAt ? [`createdAt: ${meta.createdAt}`] : []),
  ].join('\n');
  return `---\n${front}\n---\n\n${body.trim()}\n`;
}
