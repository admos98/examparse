/** Unified guidance assembly (D1/D2). One place decides what memory rides along with
 * a model call, so prompts cannot silently bloat and the caps are enforced once (A4).
 *
 *  • PIPELINE calls (structure/journal/resume/sectioned/chunked): playbook subset only.
 *  • ASSISTANT turns + reflection: state pack (≤1,200 B) + playbook subset (≤1,500 tok)
 *    + skills (≤3 skills, ≤3,000 tok).
 *  • VISION / OCR: NO playbook — perception, not judgment — unless an entry is
 *    explicitly scoped to that role.
 */
import { estimateTokens } from './tokens';
import { deriveDocTraits } from './docTraits';
import {
  ASSISTANT_PLAYBOOK_CAP, PLAYBOOK_CAP_TOKENS, loadMemoryConfig, loadPlaybook,
  selectPlaybookEntries, type PlaybookCtx, type PlaybookInjection,
} from './playbook';
import {
  SKILL_CAP_TOKENS, formatSkillsForInjection, loadSkills, selectSkillsFromPool,
  type ParsedSkill, type SkillSelectionCtx,
} from './skills';
import type { DocTraits, PlaybookFile } from './types';

const EMPTY_PLAYBOOK_INJECTION: PlaybookInjection = {
  block: '', tokens: 0, included: [], omittedCount: 0, omittedIds: [],
  digest: 'Guidance: playbook 0 entries (0 tok).',
};

export interface PipelineGuidanceCtx {
  sourceLines?: any[];
  images?: any[];
  sections?: any[];
  pages?: number;
  languageHint?: string;
  modelId?: string;
  role?: 'fast' | 'vision' | 'ocr' | 'escalation' | 'patch';
  capTokens?: number;
  docTraits?: DocTraits;
}

export interface PipelineGuidance {
  text: string;
  tokens: number;
  digest: string;
  includedCount: number;
  omittedCount: number;
  docTraits: DocTraits;
}

/** D1 — playbook subset for a pipeline call. Empty memory ⇒ empty text (D4). */
export async function assemblePipelineGuidance(ctx: PipelineGuidanceCtx): Promise<PipelineGuidance> {
  const docTraits = ctx.docTraits || deriveDocTraits({
    sourceLines: ctx.sourceLines || [], images: ctx.images || [], sections: ctx.sections || [],
    pages: ctx.pages, languageHint: ctx.languageHint,
  });
  const config = await loadMemoryConfig();
  if (!config.learningEnabled) {
    return { text: '', tokens: 0, digest: 'Guidance: playbook 0 entries (0 tok) — learning disabled.', includedCount: 0, omittedCount: 0, docTraits };
  }
  const file = await loadPlaybook();
  return fromPlaybook(file, ctx, docTraits);
}

function fromPlaybook(file: PlaybookFile, ctx: PipelineGuidanceCtx, docTraits: DocTraits): PipelineGuidance {
  const playbookCtx: PlaybookCtx = {
    modelId: ctx.modelId, docTraits, role: ctx.role || 'fast',
    capTokens: ctx.capTokens ?? PLAYBOOK_CAP_TOKENS,
  };
  const injection = selectPlaybookEntries(file, playbookCtx);
  return {
    text: injection.block, tokens: injection.tokens, digest: injection.digest,
    includedCount: injection.included.length, omittedCount: injection.omittedCount, docTraits,
  };
}

export interface AssistantGuidanceCtx {
  doc?: any;
  userMessage?: string;
  health?: any;
  docTraits?: DocTraits;
  openIssueCodes?: string[];
  modelId?: string;
  playbookCapTokens?: number;
  skillsCapTokens?: number;
}

export interface AssistantGuidance {
  text: string;
  tokens: number;
  playbookTokens: number;
  skillsTokens: number;
  includedPlaybook: number;
  omittedPlaybook: number;
  includedSkills: string[];
  draftShadowSkills: string[];
  digest: string;
}

/** D2 — playbook subset (assistant budget) + relevance-selected skills for a chat turn. */
export async function assembleAssistantGuidance(ctx: AssistantGuidanceCtx): Promise<AssistantGuidance> {
  const docTraits = ctx.docTraits || deriveDocTraits({
    sourceLines: ctx.doc?.source?.lines || [], images: ctx.doc?.images || [], sections: ctx.doc?.sections || [],
  });
  const config = await loadMemoryConfig();
  if (!config.learningEnabled) {
    return { text: '', tokens: 0, playbookTokens: 0, skillsTokens: 0, includedPlaybook: 0, omittedPlaybook: 0, includedSkills: [], draftShadowSkills: [], digest: 'Guidance: playbook 0 entries (0 tok), skills 0 (0 tok) — learning disabled.' };
  }
  const [file, pool] = await Promise.all([loadPlaybook(), loadSkills()]);
  return assembleAssistantGuidanceFrom(file, pool, ctx, docTraits);
}

/** Offline/synchronous variant used by tests, bench and the memory UI preview. */
export function assembleAssistantGuidanceFrom(
  file: PlaybookFile,
  pool: ParsedSkill[],
  ctx: AssistantGuidanceCtx,
  docTraits?: DocTraits,
): AssistantGuidance {
  const traits = docTraits || ctx.docTraits || deriveDocTraits({
    sourceLines: ctx.doc?.source?.lines || [], images: ctx.doc?.images || [], sections: ctx.doc?.sections || [],
  });
  const injection = selectPlaybookEntries(file, {
    modelId: ctx.modelId, docTraits: traits, role: 'agent',
    capTokens: ctx.playbookCapTokens ?? ASSISTANT_PLAYBOOK_CAP,
  });
  const skillCtx: SkillSelectionCtx = {
    userMessage: ctx.userMessage, health: ctx.health, docTraits: traits,
    openIssueCodes: ctx.openIssueCodes, roles: ['agent'],
  };
  const selection = selectSkillsFromPool(pool, skillCtx, ctx.skillsCapTokens ?? SKILL_CAP_TOKENS);
  const skillsText = formatSkillsForInjection(selection.selected);
  const skillsTokens = estimateTokens(skillsText);
  const text = `${injection.block}${skillsText}`;
  return {
    text,
    tokens: estimateTokens(text),
    playbookTokens: injection.tokens,
    skillsTokens,
    includedPlaybook: injection.included.length,
    omittedPlaybook: injection.omittedCount,
    includedSkills: selection.selected.map(item => item.skill.meta.slug),
    draftShadowSkills: selection.selected.filter(item => item.draftShadow).map(item => item.skill.meta.slug),
    digest: `Guidance: playbook ${injection.included.length} entries (${injection.tokens} tok), skills ${selection.selected.length} (${skillsTokens} tok)`,
  };
}

/** Offline/synchronous pipeline variant (tests + bench golden "guidance tokens" line). */
export function assemblePipelineGuidanceFrom(file: PlaybookFile, ctx: PipelineGuidanceCtx): PipelineGuidance {
  const docTraits = ctx.docTraits || deriveDocTraits({
    sourceLines: ctx.sourceLines || [], images: ctx.images || [], sections: ctx.sections || [], pages: ctx.pages, languageHint: ctx.languageHint,
  });
  return fromPlaybook(file, ctx, docTraits);
}

/** B5 — the exact string shown in stage-card details / transcripts. */
export function guidanceDigestLine(guidance: { playbookTokens?: number; includedPlaybook?: number; skillsTokens?: number; includedSkills?: string[]; omittedPlaybook?: number }): string {
  const playbookEntries = guidance.includedPlaybook ?? 0;
  const playbookTokens = guidance.playbookTokens ?? 0;
  const skills = guidance.includedSkills?.length ?? 0;
  const skillsTokens = guidance.skillsTokens ?? 0;
  const omitted = guidance.omittedPlaybook ?? 0;
  const n = (value: number) => value.toLocaleString('en-US');
  return `Guidance: playbook ${playbookEntries} entries (${n(playbookTokens)} tok), skills ${skills} (${n(skillsTokens)} tok)${omitted ? `, ${omitted} omitted by cap` : ''}`;
}

export const GUIDANCE_CAPS = { PLAYBOOK_CAP_TOKENS, ASSISTANT_PLAYBOOK_CAP, SKILL_CAP_TOKENS };
export { EMPTY_PLAYBOOK_INJECTION };
