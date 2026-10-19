/** C-part unit suite: skill linter (C1), shipped skills (C2), deterministic
 * selection + draft-shadow (C3), staleness/pruning (C4), draft activation
 * (B3(b)), the harness guidance stamp (B5) and the backup round-trip (B5).
 * Offline: every persistence call goes through a fetch mock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSkillFile, lintSkill, serializeSkill, REQUIRED_FRONTMATTER, DEFAULT_MAX_TOKENS,
} from '../src/pipeline/memory/lint';
import {
  selectSkillsFromPool, scoreSkill, formatSkillsForInjection, evaluateSkillStaleness,
  draftEligibleForActivation, applySkillOutcome,
  SKILL_CAP_TOKENS, MAX_SKILLS_PER_CALL, STALE_MIN_INJECTIONS, STALE_GREEN_RATE, STALE_DAYS_UNUSED,
  DRAFT_SHADOW_MIN_TRIGGERS, DRAFT_SHADOW_MIN_GREEN, type SkillSelectionCtx,
} from '../src/pipeline/memory/skills';
import { SHIPPED_SKILLS } from '../src/pipeline/memory/shippedSkills';
import { deriveDocTraits } from '../src/pipeline/memory/docTraits';
import { estimateTokens } from '../src/pipeline/memory/tokens';
import { endJob, type JobHandle } from '../src/pipeline/memory/harness';
import { createBackup, restoreBackup } from '../src/utils/backup';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
type FetchHandler = (init?: any) => any;
function installFetchMock(routes: Array<[string, FetchHandler]>): { restore: () => void; calls: Array<{ url: string; body: any }> } {
  const original = (globalThis as any).fetch;
  const calls: Array<{ url: string; body: any }> = [];
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const target = String(url);
    let body: any;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = String(init?.body || ''); }
    calls.push({ url: target, body });
    for (const [prefix, handler] of routes) {
      if (target.startsWith(prefix)) {
        const result = handler(init);
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(result ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  return { restore: () => { (globalThis as any).fetch = original; }, calls };
}

function skillFile(opts: {
  slug?: string; name?: string; status?: string; source?: string; triggers?: string[];
  maxTokens?: number; body?: string; stats?: any; appliesTo?: any; createdAt?: string;
}): string {
  return serializeSkill({
    name: opts.name ?? `Skill ${opts.slug ?? 'test'}`,
    slug: opts.slug ?? 'test-skill',
    status: (opts.status ?? 'active') as any,
    triggers: opts.triggers ?? ['missing questions'],
    appliesTo: opts.appliesTo ?? { roles: ['agent'] },
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    source: (opts.source ?? 'user') as any,
    stats: opts.stats,
    createdAt: opts.createdAt,
  } as any, opts.body ?? '1. Do the thing.\n2. Verify the result.');
}

const miniDocLines = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ id: `L000${i}`, page: 1, text: `${i}. Question ${i} a) opt b) opt` }));
const miniTraits = deriveDocTraits({ sourceLines: miniDocLines, images: [], sections: [], pages: 1 });

/* ------------------------------------------------------------------ */
/* C2 — the shipped skill set                                          */
/* ------------------------------------------------------------------ */
test('C2 shipped skills: exactly 7, linter-clean, ≤900 tokens each, unique slugs', () => {
  assert.equal(SHIPPED_SKILLS.length, 7);
  const slugs = new Set<string>();
  for (const skill of SHIPPED_SKILLS) {
    assert.ok(!slugs.has(skill.slug), `duplicate shipped slug ${skill.slug}`);
    slugs.add(skill.slug);
    const lint = lintSkill(skill.content, skill.slug);
    assert.ok(lint.ok, `${skill.slug} fails its own linter: ${lint.errors.join('; ')}`);
    assert.ok((lint.tokens || 0) <= 900, `${skill.slug} is ${lint.tokens} tok > 900`);
    assert.equal(lint.meta?.source, 'shipped');
    for (const field of REQUIRED_FRONTMATTER) assert.ok(lint.meta && (lint.meta as any)[field] !== undefined, `${skill.slug} missing ${field}`);
    assert.ok((lint.meta?.triggers.length || 0) > 0);
  }
  assert.deepEqual([...slugs].sort(), [
    'answer-key-handling', 'image-placement', 'missing-questions-triage', 'section-integrity',
    'user-communication', 'verify-and-repair-exam', 'weak-model-mode',
  ]);
  console.log(`shipped tokens: ${SHIPPED_SKILLS.map(s => `${s.slug} ${lintSkill(s.content, s.slug).tokens}`).join(', ')}`);
});

/* ------------------------------------------------------------------ */
/* C1 — the linter rejects over-budget / malformed skills              */
/* ------------------------------------------------------------------ */
test('C1 linter: named errors for every malformed-skill class', () => {
  assert.equal(lintSkill('', 'x').ok, false);
  assert.match(lintSkill('', 'x').errors[0], /missing frontmatter/);
  assert.match(lintSkill('no frontmatter here', 'x').errors[0], /missing frontmatter/);
  for (const field of REQUIRED_FRONTMATTER) {
    const content = skillFile({}).split('\n').filter(line => !line.startsWith(`${field}:`)).join('\n');
    const lint = lintSkill(content, 'test-skill');
    assert.equal(lint.ok, false, `removing ${field} must fail the linter`);
    assert.match(lint.errors[0], new RegExp(`missing frontmatter field: ${field}`));
  }
  assert.match(lintSkill(skillFile({ status: 'paused' }), 'test-skill').errors[0], /invalid status/);
  assert.match(lintSkill(skillFile({ source: 'magic' }), 'test-skill').errors[0], /invalid source/);
  assert.match(lintSkill(skillFile({ slug: 'Bad Slug!' }), 'bad-slug').errors[0], /invalid slug/);
  assert.match(lintSkill(skillFile({ slug: 'other-name' }), 'test-skill').errors[0], /slug mismatch/);
  assert.match(lintSkill(skillFile({ maxTokens: 0 }), 'test-skill').errors[0], /invalid maxTokens/);
  assert.match(lintSkill(skillFile({ maxTokens: 5000 }), 'test-skill').errors[0], /invalid maxTokens/);
  // Over budget: body tokens > declared maxTokens.
  const fat = skillFile({ maxTokens: 10, body: 'x'.repeat(400) });
  const fatLint = lintSkill(fat, 'test-skill');
  assert.equal(fatLint.ok, false);
  assert.match(fatLint.errors[0], /over budget: body 100 tokens > maxTokens 10/);
  // Empty body and empty triggers.
  assert.match(lintSkill(skillFile({ body: '   ' }), 'test-skill').errors[0], /empty skill body/);
  assert.match(lintSkill(skillFile({ triggers: [] }), 'test-skill').errors[0], /triggers must be a non-empty array/);
  // A valid file passes and reports exact numbers.
  const good = lintSkill(skillFile({ body: 'a'.repeat(360) }), 'test-skill');
  assert.ok(good.ok);
  assert.equal(good.tokens, 90);
  assert.equal(good.maxTokens, DEFAULT_MAX_TOKENS);
});

test('C1 serializeSkill round-trip: nested JSON stats + createdAt survive (harness rewrite regression)', () => {
  const stats = { injected: 3, followed: 2, greenAfter: 2, redAfter: 1, lastUsed: '2026-10-01T00:00:00.000Z', lastInjected: '2026-10-01T00:00:00.000Z' };
  const content = skillFile({ stats, createdAt: '2026-09-01T00:00:00.000Z', body: '1. Step one.\n2. Step two.' });
  const parsed = parseSkillFile(content, 'test-skill');
  assert.deepEqual(parsed.meta.stats, stats);
  assert.equal(parsed.meta.createdAt, '2026-09-01T00:00:00.000Z');
  // Simulate the harness endJob rewrite: bump stats, re-serialize, re-parse.
  const [bumped] = applySkillOutcome([parsed], ['test-skill'], { green: true, followed: true }, '2026-10-02T00:00:00.000Z');
  assert.equal(bumped.meta.stats.injected, 4);
  assert.equal(bumped.meta.stats.greenAfter, 3);
  const rewritten = parseSkillFile(serializeSkill(bumped.meta, bumped.body), 'test-skill');
  assert.deepEqual(rewritten.meta.stats.injected, 4);
  assert.deepEqual(rewritten.meta.stats.greenAfter, 3);
  assert.equal(rewritten.meta.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(rewritten.body, parsed.body);
  // The old regex rewrite would corrupt stats JSON containing '}' — prove serialize is exact.
  assert.ok(!/stats:\s*\{[^}]*\}\}/.test(serializeSkill(bumped.meta, bumped.body).split('---')[1] || ''), 'frontmatter must stay line-oriented');
});

/* ------------------------------------------------------------------ */
/* C3 — deterministic keyword/pattern selection, no model calls        */
/* ------------------------------------------------------------------ */
test('C3 selection is deterministic, capped at ≤3 skills and ≤3,000 tokens', () => {
  const pool = [
    parseSkillFile(skillFile({ slug: 'alpha', triggers: ['missing questions'], body: '1. alpha step' }), 'alpha'),
    parseSkillFile(skillFile({ slug: 'beta', triggers: ['/answer\\s*key/'], body: '1. beta step' }), 'beta'),
    parseSkillFile(skillFile({ slug: 'gamma', triggers: ['images'], appliesTo: { roles: ['agent'], docTraits: ['image-heavy'] }, body: '1. gamma step' }), 'gamma'),
    parseSkillFile(skillFile({ slug: 'delta', triggers: ['zzz-unrelated'], appliesTo: { roles: ['vision'] }, body: '1. delta step' }), 'delta'),
  ];
  const ctx: SkillSelectionCtx = { userMessage: 'Two missing questions and a stray answer key', health: { state: 'red', missing: [4] }, docTraits: miniTraits, roles: ['agent'] };
  const first = selectSkillsFromPool(pool, ctx);
  const second = selectSkillsFromPool(pool, ctx);
  assert.deepEqual(first.selected.map(s => s.skill.meta.slug), second.selected.map(s => s.skill.meta.slug), 'same input must select the same skills');
  assert.deepEqual(first.scores, second.scores);
  assert.ok(first.selected.length <= MAX_SKILLS_PER_CALL);
  assert.ok(first.totalTokens <= SKILL_CAP_TOKENS);
  // delta scores 0 (no trigger hit, wrong role) → filtered before ranking, never selected.
  assert.ok(!first.selected.some(s => s.skill.meta.slug === 'delta'));
  assert.equal(first.scores['delta'], undefined);
  // Keyword = 3 points, regex = 4 points, role match = +1 (documented scoring).
  assert.equal(scoreSkill(pool[0], ctx), 3 + 1, 'keyword 3 + role 1');
  assert.equal(scoreSkill(pool[1], ctx), 4 + 1, 'regex 4 + role 1');
  assert.equal(scoreSkill(pool[3], ctx), 0, 'no match scores 0');
  console.log(`C3: selected [${first.selected.map(s => s.skill.meta.slug)}] tokens ${first.totalTokens} omitted ${first.omitted}`);
});

test('C3 hard caps: 6 matching skills → ≤3 per call; token cap packs greedily by rank', () => {
  const body = 'word '.repeat(560).trim(); // 2,800 chars ≈ 700 tokens each
  const pool = Array.from({ length: 6 }, (_, i) =>
    parseSkillFile(skillFile({ slug: `match-${i}`, triggers: ['missing questions'], body }), `match-${i}`));
  const ctx: SkillSelectionCtx = { userMessage: 'missing questions everywhere', roles: ['agent'], docTraits: miniTraits };
  const sel = selectSkillsFromPool(pool, ctx);
  assert.equal(sel.selected.length, MAX_SKILLS_PER_CALL, 'never more than 3 skills per call');
  assert.ok(sel.totalTokens <= SKILL_CAP_TOKENS);
  assert.equal(sel.omitted, 3);
  // Token cap bites before the count cap when the budget is small.
  const tight = selectSkillsFromPool(pool, ctx, 1500);
  assert.equal(tight.selected.length, 2, '2×700 fits 1,500; a third would overflow');
  assert.ok(tight.totalTokens <= 1500);
  assert.equal(tight.omitted, 4);
});

test('C3 draft-shadow: drafts inject only when no active skill matches, with an UNVERIFIED banner', () => {
  const draft = parseSkillFile(skillFile({ slug: 'learned-1', status: 'draft', source: 'learned', triggers: ['missing questions'], body: '1. trial step' }), 'learned-1');
  const ctx: SkillSelectionCtx = { userMessage: 'missing questions', roles: ['agent'], docTraits: miniTraits };
  // Draft alone → shadow injection.
  const solo = selectSkillsFromPool([draft], ctx);
  assert.equal(solo.selected.length, 1);
  assert.equal(solo.selected[0].draftShadow, true);
  assert.match(formatSkillsForInjection(solo.selected), /UNVERIFIED PROCEDURE/);
  assert.match(formatSkillsForInjection(solo.selected), /SKILL: learned-1/);
  // Any active match wins — the draft stays out.
  const active = parseSkillFile(skillFile({ slug: 'active-1', triggers: ['missing questions'], body: '1. proven step' }), 'active-1');
  const mixed = selectSkillsFromPool([draft, active], ctx);
  assert.deepEqual(mixed.selected.map(s => s.skill.meta.slug), ['active-1']);
  assert.equal(mixed.selected[0].draftShadow, false);
  assert.ok(!formatSkillsForInjection(mixed.selected).includes('UNVERIFIED'));
  // Archived skills are never eligible.
  const archived = parseSkillFile(skillFile({ slug: 'archived-1', status: 'archived', triggers: ['missing questions'] }), 'archived-1');
  assert.equal(selectSkillsFromPool([archived], ctx).selected.length, 0);
});

/* ------------------------------------------------------------------ */
/* C4 — staleness: learned auto-archive, shipped badge only            */
/* ------------------------------------------------------------------ */
test('C4 staleness: learned → archived, shipped → badge, fresh → nothing; archived stays restorable', () => {
  const badStats = { injected: STALE_MIN_INJECTIONS + 2, followed: 10, greenAfter: 1, redAfter: 9 };
  assert.ok(badStats.greenAfter / (badStats.greenAfter + badStats.redAfter) < STALE_GREEN_RATE);
  const learned = parseSkillFile(skillFile({ slug: 'learned-stale', source: 'learned', stats: badStats }), 'learned-stale');
  const shipped = parseSkillFile(skillFile({ slug: 'shipped-stale', source: 'shipped', stats: badStats }), 'shipped-stale');
  const fresh = parseSkillFile(skillFile({ slug: 'fresh', stats: { injected: 1, greenAfter: 1, redAfter: 0, lastUsed: new Date().toISOString() } }), 'fresh');
  const reports = evaluateSkillStaleness([learned, shipped, fresh]);
  assert.equal(reports.length, 2);
  const byAction = Object.fromEntries(reports.map(r => [r.slug, r.action]));
  assert.equal(byAction['learned-stale'], 'archived');
  assert.equal(byAction['shipped-stale'], 'badge', 'shipped skills are NEVER auto-archived');
  // Idle path: >45 days unused while the trigger domain occurred ≥5×.
  const idle = parseSkillFile(skillFile({
    slug: 'idle-learned', source: 'learned',
    stats: { injected: 2, greenAfter: 2, redAfter: 0, lastUsed: new Date(Date.now() - (STALE_DAYS_UNUSED + 5) * 86_400_000).toISOString() },
  }), 'idle-learned');
  const idleReports = evaluateSkillStaleness([idle], { triggerDomainOccurrences: { 'idle-learned': 5 } });
  assert.equal(idleReports.length, 1);
  assert.equal(idleReports[0].action, 'archived');
  assert.match(idleReports[0].reason, /not injected in \d+ days/);
  // Without domain occurrences, an idle skill is left alone (no false pruning).
  assert.equal(evaluateSkillStaleness([idle]).length, 0);
  // Archived skills stay on disk and are one-click restorable: flip status back, lint passes.
  const archivedContent = serializeSkill({ ...learned.meta, status: 'archived' }, learned.body);
  assert.equal(parseSkillFile(archivedContent, 'learned-stale').meta.status, 'archived');
  const restored = lintSkill(serializeSkill({ ...learned.meta, status: 'active' }, learned.body), 'learned-stale');
  assert.ok(restored.ok, 'restore must re-lint clean');
  assert.equal(restored.meta?.status, 'active');
});

/* ------------------------------------------------------------------ */
/* B3(b) — draft activation gate + skill outcome bookkeeping           */
/* ------------------------------------------------------------------ */
test('B3(b) draft activation: ≥3 matched jobs AND ≥2 green; drafts never auto-activate below the bar', () => {
  const green2 = parseSkillFile(skillFile({ slug: 'd2', status: 'draft', source: 'learned', stats: { injected: 0, greenAfter: 2, redAfter: 0 } }), 'd2');
  const green1 = parseSkillFile(skillFile({ slug: 'd1', status: 'draft', source: 'learned', stats: { injected: 0, greenAfter: 1, redAfter: 0 } }), 'd1');
  assert.equal(DRAFT_SHADOW_MIN_TRIGGERS, 3);
  assert.equal(DRAFT_SHADOW_MIN_GREEN, 2);
  assert.equal(draftEligibleForActivation(green2, 3), true);
  assert.equal(draftEligibleForActivation(green2, 2), false, 'only 2 matched jobs');
  assert.equal(draftEligibleForActivation(green1, 10), false, 'only 1 green outcome');
  assert.equal(draftEligibleForActivation(parseSkillFile(skillFile({ slug: 'a1', status: 'active', stats: { injected: 0, greenAfter: 5 } }), 'a1'), 5), false, 'non-drafts are not "activated"');
  // applySkillOutcome only touches injected slugs.
  const pool = [green1, parseSkillFile(skillFile({ slug: 'other' }), 'other')];
  const [updated, untouched] = applySkillOutcome(pool, ['d1'], { green: false, followed: true }, '2026-10-19T00:00:00.000Z');
  assert.equal(updated.meta.stats.injected, 1);
  assert.equal(updated.meta.stats.redAfter, 1);
  assert.equal(updated.meta.stats.followed, 1);
  assert.equal(updated.meta.stats.lastUsed, '2026-10-19T00:00:00.000Z');
  assert.equal(untouched.meta.stats.injected, 0);
});

/* ------------------------------------------------------------------ */
/* E4-2 golden — skill selection is a fixed, reproducible mapping      */
/* ------------------------------------------------------------------ */
test('E4-2 skill-selection golden: shipped pool + fixed contexts → exact slug orders (run twice)', () => {
  const pool = SHIPPED_SKILLS.map(s => parseSkillFile(s.content, s.slug));
  const ctxA: SkillSelectionCtx = {
    userMessage: 'questions 4 and 7 are missing from the parse, please triage',
    health: { state: 'red', missing: [4, 7], unplacedImages: 0 },
    docTraits: miniTraits, roles: ['agent'],
  };
  const ctxB: SkillSelectionCtx = {
    userMessage: 'the answer key page was parsed as questions',
    health: { state: 'amber', missing: [] },
    docTraits: miniTraits, roles: ['agent'],
  };
  const goldenA = { selected: ['image-placement', 'missing-questions-triage', 'answer-key-handling'], totalTokens: 600, omitted: 2 };
  const goldenB = { selected: ['answer-key-handling', 'image-placement', 'missing-questions-triage'] };
  for (const run of [1, 2]) {
    const a = selectSkillsFromPool(pool, ctxA);
    assert.deepEqual(a.selected.map(s => s.skill.meta.slug), goldenA.selected, `run ${run} ctx A`);
    assert.equal(a.totalTokens, goldenA.totalTokens);
    assert.equal(a.omitted, goldenA.omitted);
    const b = selectSkillsFromPool(pool, ctxB);
    assert.deepEqual(b.selected.map(s => s.skill.meta.slug), goldenB.selected, `run ${run} ctx B`);
  }
  console.log(`E4-2 golden: ctxA [${goldenA.selected}] ${goldenA.totalTokens} tok; ctxB [${goldenB.selected}]`);
});

/* ------------------------------------------------------------------ */
/* B5 regression — endJob stamps entry.guidance incl. draftShadowSkills */
/* ------------------------------------------------------------------ */
test('B5 harness: run-journal entry carries the guidance stamp (incl. draftShadowSkills) for prune B3(b)', async () => {
  const posted: any[] = [];
  const mock = installFetchMock([
    ['/api/memory/config', () => ({ learningEnabled: true, reflectionEnabled: false })],
    ['/api/memory/runs', (init: any) => { posted.push(JSON.parse(String(init.body))); return { ok: true }; }],
    ['/api/memory/skills', () => []],
    ['/api/memory/playbook', () => ({ version: 1, entries: [] })],
  ]);
  try {
    const handle: JobHandle = {
      jobId: 'job_test_1', kind: 'assistant', startedAt: Date.now(), docTraits: miniTraits, models: { agent: 'mock' },
      matchedPlaybookIds: [], playbook: { block: 'PLAYBOOK', tokens: 120, included: [{ id: 'e1' } as any, { id: 'e2' } as any], omittedCount: 1, omittedIds: ['e3'], digest: 'd' },
      skills: [
        { slug: 'verify-and-repair-exam', draftShadow: false, tokens: 203 },
        { slug: 'learned-trial', draftShadow: true, tokens: 150 },
      ],
      skillsBlock: 'SKILLS', guidanceTokens: 473, ladderPath: [], flagsRaised: [],
    };
    const result = await endJob(handle, {
      health: { state: 'green', missing: [], expected: 3, parsed: 3, coveragePercent: 100 },
      calls: 2, tokens: { input: 100, output: 50 }, costUsd: 0,
      learningEnabled: true,
    });
    assert.ok(result.entry.guidance, 'journal entry must carry the guidance stamp');
    assert.deepEqual(result.entry.guidance, {
      playbookEntries: 2, playbookTokens: 120,
      skills: ['verify-and-repair-exam'], skillsTokens: 353, omittedByCap: 1,
      draftShadowSkills: ['learned-trial'],
    });
    assert.equal(posted.length, 1, 'entry must reach the append-only journal');
    assert.deepEqual(posted[0].guidance.draftShadowSkills, ['learned-trial']);
    // No draft shadows → the optional field is absent (keeps lines compact).
    const plainHandle: JobHandle = { ...handle, jobId: 'job_test_2', skills: [{ slug: 'a', draftShadow: false, tokens: 10 }] };
    const plain = await endJob(plainHandle, { health: { state: 'green', missing: [] }, calls: 1, tokens: { input: 1, output: 1 }, costUsd: 0, learningEnabled: true });
    assert.equal(plain.entry.guidance?.draftShadowSkills, undefined);
  } finally { mock.restore(); }
});

/* ------------------------------------------------------------------ */
/* B5 — memory rides in the backup zip and restores byte-exact         */
/* ------------------------------------------------------------------ */
test('B5 backup round-trip: playbook, runs, activity, config and skills survive the zip', async () => {
  const playbook = { version: 1, entries: [{ id: 'e1', kind: 'strategy', scope: {}, lesson: 'Derive sections from headers.', status: 'active', confidence: 0.7, evidence: { runIds: ['r1'], successes: 1, failures: 0, firstSeen: 'x', lastSeen: 'y' } }] };
  const runs = [{ jobId: 'j1', kind: 'assistant', guidance: { playbookEntries: 1, playbookTokens: 10, skills: [], skillsTokens: 0, omittedByCap: 0 } }];
  const skills = [{ slug: 'learned-trial', content: skillFile({ slug: 'learned-trial', source: 'learned', status: 'draft' }) }];
  const config = { learningEnabled: false, reflectionEnabled: true };
  const zip = await createBackup({
    exams: { exam_1: { id: 'exam_1', questions: [] } }, images: {}, dossiers: { exam_1: { id: 'exam_1', events: [] } },
    settings: { providers: [{ id: 'p', apiKey: 'secret' }] },
    memory: { playbook, runs, activity: [{ type: 'note' }], config, skills },
  });
  const restored = await restoreBackup(zip);
  assert.deepEqual(restored.memory.playbook, playbook);
  assert.deepEqual(restored.memory.runs, runs);
  assert.deepEqual(restored.memory.activity, [{ type: 'note' }]);
  assert.deepEqual(restored.memory.config, config);
  assert.deepEqual(restored.memory.skills, skills);
  assert.deepEqual(restored.counts, { exams: 1, images: 0, dossiers: 1, memorySkills: 1, memoryRuns: 1, playbookEntries: 1 });
  // Provider keys never ride along.
  assert.equal((restored.settings.providers[0] as any).apiKey, undefined);
  // A backup without memory still restores (cold-start compatibility).
  const bare = await restoreBackup(await createBackup({ exams: {}, images: {}, dossiers: {}, settings: {} }));
  assert.deepEqual(bare.memory.playbook, undefined);
  assert.equal(bare.counts.memorySkills, 0);
});

/* ------------------------------------------------------------------ */
/* A4 — skill token estimator sanity used by the caps                  */
/* ------------------------------------------------------------------ */
test('A4 skill caps are constants and the estimator is the documented chars/4 class', () => {
  assert.equal(SKILL_CAP_TOKENS, 3000);
  assert.equal(MAX_SKILLS_PER_CALL, 3);
  assert.equal(DEFAULT_MAX_TOKENS, 900);
  assert.equal(estimateTokens('a'.repeat(3600)), 900);
  const pool = SHIPPED_SKILLS.map(s => parseSkillFile(s.content, s.slug));
  // Even if all 7 shipped skills somehow matched, the cap machinery keeps ≤3/≤3,000.
  const ctx: SkillSelectionCtx = { userMessage: 'missing questions answer key images sections weak model verify repair', roles: ['agent'], docTraits: miniTraits };
  const sel = selectSkillsFromPool(pool, ctx);
  assert.ok(sel.selected.length <= 3 && sel.totalTokens <= 3000);
});
