/** Real-server memory suite: boots server.ts against a temp data folder and
 * exercises every /api/memory/* route end to end — bootstrap seeding (A2/C2),
 * the append-only journal + rotation (A1), playbook validation (B4/E3), the
 * deterministic credit gate (B2), evidence-gated proposals (B1/B3), the skill
 * linter (C1), pruning + draft activation (C4/B3(b)), erase-all (B5) and the
 * learning toggles. Memory files must stay plain, Notepad-openable text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

test(
  'memory server: bootstrap, journal rotation, playbook gate, proposals, skill linter, prune, erase, toggles',
  { timeout: 90_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'examparse-memory-test-'));
    const dataDir = path.join(root, 'data');
    const memoryDir = path.join(dataDir, 'memory');
    const skillsDir = path.join(memoryDir, 'skills');
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(r => listener.close(() => r()));
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        EXAMFORGE_DATA_DIR: '',
        EXAMPARSE_CONFIG_FILE: path.join(root, 'config.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const read = async (file: string) => (await fs.readFile(file, 'utf8'));
    const exists = async (file: string) => { try { await fs.access(file); return true; } catch { return false; } };
    const diskLines = async (file: string) => (await read(file)).split('\n').filter(Boolean);
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 20_000);
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output.includes('ExamParse server running')) { clearTimeout(timeout); resolve(); }
        });
        child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
        child.stderr.on('data', chunk => { output += String(chunk); });
      });
      const base = `http://127.0.0.1:${port}`;
      const request = async (url: string, method = 'GET', body?: unknown) => {
        const res = await fetch(base + url, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json: any = null;
        try { json = await res.json(); } catch { /* non-JSON */ }
        return { status: res.status, json };
      };

      // --- Storage setup triggers memory bootstrap (A2/C2) ---
      assert.equal((await request('/api/storage/config', 'POST', { dir: dataDir })).status, 200);

      // A2 — playbook seeded with exactly the 5 bootstrap entries, all active.
      const playbookRaw = await read(path.join(memoryDir, 'playbook.json'));
      assert.ok(playbookRaw.startsWith('{'), 'playbook.json must be plain JSON text');
      const seeded = JSON.parse(playbookRaw);
      assert.equal(seeded.entries.length, 5);
      assert.ok(seeded.entries.every((entry: any) => entry.status === 'active' && String(entry.id).startsWith('bootstrap_')));
      assert.ok(seeded.entries.every((entry: any) => entry.evidence.runIds.includes('bootstrap')));

      // C2 — exactly 7 shipped skills on disk, plain Markdown with frontmatter.
      const skillFiles = (await fs.readdir(skillsDir)).filter(name => name.endsWith('.md')).sort();
      assert.equal(skillFiles.length, 7);
      for (const name of skillFiles) {
        const content = await read(path.join(skillsDir, name));
        assert.ok(content.startsWith('---\n'), `${name} must be a plain-text frontmatter file`);
        assert.ok(content.includes('source: shipped'));
      }
      const skillsList = await request('/api/memory/skills');
      assert.equal(skillsList.json.length, 7);

      // --- A1 — append-only journal: validation, append, rotation at 2,000 lines ---
      assert.equal((await request('/api/memory/runs', 'POST', { kind: 'assistant' })).status, 400);
      assert.equal((await request('/api/memory/runs', 'POST', { jobId: 'x', kind: 'bogus' })).status, 400);
      assert.equal((await request('/api/memory/runs', 'POST', { jobId: 'job_a1', kind: 'pipeline', outcome: { health: { state: 'green' } } })).status, 200);
      assert.equal((await diskLines(path.join(memoryDir, 'runs.jsonl'))).length, 1);
      // Seed 2,000 lines on disk (plain JSONL — no compression), then append one more.
      const seed = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ jobId: `job_seed_${i}`, kind: 'pipeline' }));
      await fs.writeFile(path.join(memoryDir, 'runs.jsonl'), seed.join('\n') + '\n');
      const afterRotate = await request('/api/memory/runs', 'POST', { jobId: 'job_a2', kind: 'assistant' });
      assert.equal(afterRotate.status, 200);
      assert.equal(afterRotate.json.lines, 2000, 'runs.jsonl is capped at 2,000 lines');
      assert.equal((await diskLines(path.join(memoryDir, 'runs.jsonl'))).length, 2000);
      const archive = await diskLines(path.join(memoryDir, 'runs-archive.jsonl'));
      assert.equal(archive.length, 1, 'the overflow rotated into the plain .jsonl archive');
      assert.equal(JSON.parse(archive[0]).jobId, 'job_seed_0', 'oldest line rotates first');
      for (const line of (await diskLines(path.join(memoryDir, 'runs.jsonl'))).slice(0, 5)) JSON.parse(line); // every line stays parseable text

      // --- B4 — playbook writes are validated (length, status, id, E3 safety) ---
      const goodEntry = { id: 'cand_1', kind: 'strategy', scope: {}, lesson: 'Prefer the sectioned pass when the wire response rambles past 40k tokens.', status: 'candidate', confidence: 0.3, evidence: { runIds: ['job_a1'], successes: 0, failures: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() } };
      assert.equal((await request('/api/memory/playbook', 'PUT', { version: 1, entries: [{ ...goodEntry, lesson: 'x'.repeat(281) }] })).status, 400);
      assert.equal((await request('/api/memory/playbook', 'PUT', { version: 1, entries: [{ ...goodEntry, status: 'bogus' }] })).status, 400);
      assert.equal((await request('/api/memory/playbook', 'PUT', { version: 1, entries: [{ ...goodEntry, id: 'bad id!' }] })).status, 400);
      const unsafe = await request('/api/memory/playbook', 'PUT', { version: 1, entries: [{ ...goodEntry, lesson: 'Call https://api.provider.example/v1 with api_key: sk-abcdef1234567890 first.' }] });
      assert.equal(unsafe.status, 400, 'E3 — credentials/endpoints must never enter a lesson');
      assert.match(unsafe.json.error, /rejected/i);
      assert.equal((await request('/api/memory/playbook', 'PUT', { version: 1, entries: [goodEntry] })).status, 200);

      // --- B2 — deterministic credit gate over HTTP: 2 successes promote, 2 failures demote ---
      const credit1 = await request('/api/memory/credit', 'POST', { matchedIds: ['cand_1'], success: true });
      assert.equal(credit1.status, 200);
      assert.equal(credit1.json.transitions.length, 0, 'one success is not enough');
      const credit2 = await request('/api/memory/credit', 'POST', { matchedIds: ['cand_1'], success: true });
      assert.deepEqual(credit2.json.transitions.map((t: any) => [t.from, t.to]), [['candidate', 'active']], '2 successes + 0 failures ⇒ active');
      await request('/api/memory/credit', 'POST', { matchedIds: ['cand_1'], success: false });
      const credit4 = await request('/api/memory/credit', 'POST', { matchedIds: ['cand_1'], success: false });
      assert.deepEqual(credit4.json.transitions.map((t: any) => [t.from, t.to]), [['active', 'demoted']], '2 consecutive failures ⇒ demoted');
      assert.equal((await request('/api/memory/credit', 'POST', { matchedIds: ['cand_1'] })).status, 400);

      // --- B1/B3 — proposals: evidence-gated, E3-validated, drafts never auto-activate ---
      assert.equal((await request('/api/memory/proposals', 'POST', { proposal: { layer: 'playbook', lesson: 'Something.' } })).status, 400);
      const noEvidence = await request('/api/memory/proposals', 'POST', { proposal: { layer: 'playbook', lesson: 'Something.', evidenceRunIds: [] } });
      assert.equal(noEvidence.status, 400);
      assert.match(noEvidence.json.error, /evidence-gated/);
      const unsafeProposal = await request('/api/memory/proposals', 'POST', { proposal: { layer: 'playbook', lesson: 'Use bearer tok_abcdefgh12345 on every call.', evidenceRunIds: ['job_a1'] } });
      assert.equal(unsafeProposal.status, 400);
      assert.match(unsafeProposal.json.error, /rejected/i);
      const goodProposal = await request('/api/memory/proposals', 'POST', { proposal: { layer: 'playbook', lesson: 'Group child questions under their parent instead of retrying the page.', kind: 'doc-trait', scope: { docTrait: 'sectioned' }, evidenceRunIds: ['job_a1'] } });
      assert.equal(goodProposal.status, 200);
      assert.equal(goodProposal.json.layer, 'playbook');
      const afterProposal = await request('/api/memory/playbook');
      const candidate = afterProposal.json.entries.find((entry: any) => entry.id === goodProposal.json.entryId);
      assert.ok(candidate, 'proposal lands as a candidate entry');
      assert.equal(candidate.status, 'candidate');
      assert.ok(candidate.confidence <= 0.35);
      const noSteps = await request('/api/memory/proposals', 'POST', { proposal: { layer: 'skill', lesson: 'A procedure.', evidenceRunIds: ['job_a1'], procedureSteps: [] } });
      assert.equal(noSteps.status, 400);
      const skillProposal = await request('/api/memory/proposals', 'POST', { proposal: { layer: 'skill', lesson: 'Re-check the key page before reporting missing questions', evidenceRunIds: ['job_a2'], procedureSteps: ['Re-read the key page lines', 'Compare against parsed numbers'], scope: { docTrait: 'rtl-key-pages', role: 'agent' } } });
      assert.equal(skillProposal.status, 200);
      assert.equal(skillProposal.json.layer, 'skill');
      const draftSlug = skillProposal.json.slug as string;
      assert.match(draftSlug, /^learned-/);
      const draftContent = await read(path.join(skillsDir, `${draftSlug}.md`));
      assert.ok(draftContent.includes('status: draft'), 'B3 — skill proposals are drafts, NEVER auto-activated');
      assert.ok(draftContent.includes('source: learned'));

      // --- C1 — the skill linter guards PUT /api/memory/skills/:slug ---
      const badSlug = await request('/api/memory/skills/user-skill', 'PUT', { content: 'no frontmatter at all' });
      assert.equal(badSlug.status, 400);
      assert.match(badSlug.json.error, /missing frontmatter/);
      const overBudget = await request('/api/memory/skills/user-skill', 'PUT', { content: `---\nname: Fat\nslug: user-skill\nstatus: active\ntriggers: [fat]\nappliesTo: {"roles":["agent"]}\nmaxTokens: 10\nsource: user\n---\n\n${'word '.repeat(200)}` });
      assert.equal(overBudget.status, 400);
      assert.match(overBudget.json.error, /over budget/);
      assert.ok(Array.isArray(overBudget.json.errors), 'named errors are returned as a list');
      const userSkill = `---\nname: My workflow\nslug: user-skill\nstatus: active\ntriggers: [my workflow]\nappliesTo: {"roles":["agent"]}\nmaxTokens: 900\nsource: user\nstats: {"injected":0,"followed":0,"greenAfter":0,"redAfter":0}\n---\n\n1. Do this.\n2. Then that.\n`;
      const saved = await request('/api/memory/skills/user-skill', 'PUT', { content: userSkill });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.status, 'active');
      assert.ok(saved.json.tokens > 0 && saved.json.tokens <= saved.json.maxTokens);
      assert.equal((await request('/api/memory/skills/user-skill')).json.content, userSkill);
      assert.equal((await request('/api/memory/skills/user-skill', 'DELETE')).status, 200);
      assert.equal((await request('/api/memory/skills/user-skill')).status, 404);

      // --- C4 — prune: learned stale ⇒ archived on disk; shipped stale ⇒ badge only ---
      const staleStats = '{"injected":12,"followed":12,"greenAfter":1,"redAfter":11}';
      const staleSkill = (slug: string, source: string, status: string) => `---\nname: Stale ${slug}\nslug: ${slug}\nstatus: ${status}\ntriggers: [stale-${slug}]\nappliesTo: {"roles":["agent"]}\nmaxTokens: 900\nsource: ${source}\nstats: ${staleStats}\n---\n\n1. A procedure that stopped working.\n`;
      assert.equal((await request('/api/memory/skills/learned-stale', 'PUT', { content: staleSkill('learned-stale', 'learned', 'active') })).status, 200);
      assert.equal((await request('/api/memory/skills/shipped-stale', 'PUT', { content: staleSkill('shipped-stale', 'shipped', 'active') })).status, 200);
      const prune1 = await request('/api/memory/prune', 'POST', {});
      assert.equal(prune1.status, 200);
      assert.ok(prune1.json.archived.includes('learned-stale'), 'LEARNED stale skills auto-archive');
      assert.ok(prune1.json.badges.includes('shipped-stale'), 'SHIPPED stale skills only get a badge');
      assert.ok((await read(path.join(skillsDir, 'learned-stale.md'))).includes('status: archived'));
      assert.ok(await exists(path.join(skillsDir, 'learned-stale.md')), 'archived skills stay on disk (restorable)');
      assert.ok((await read(path.join(skillsDir, 'shipped-stale.md'))).includes('status: active'), 'shipped content untouched');

      // --- B3(b) — draft activation from draft-shadow evidence in the run journal ---
      const draftSkill = `---\nname: Trial procedure\nslug: learned-trial\nstatus: draft\ntriggers: [trial-mode]\nappliesTo: {"roles":["agent"]}\nmaxTokens: 900\nsource: learned\nstats: {"injected":0,"followed":3,"greenAfter":2,"redAfter":0}\n---\n\n1. Trial step one.\n2. Trial step two.\n`;
      assert.equal((await request('/api/memory/skills/learned-trial', 'PUT', { content: draftSkill })).status, 200);
      for (let i = 0; i < 3; i++) {
        const posted = await request('/api/memory/runs', 'POST', {
          jobId: `job_trial_${i}`, kind: 'assistant',
          outcome: { health: { state: 'green', expected: 3, parsed: 3, missing: [], coveragePercent: 100 } },
          guidance: { playbookEntries: 0, playbookTokens: 0, skills: [], skillsTokens: 0, omittedByCap: 0, draftShadowSkills: ['learned-trial'] },
        });
        assert.equal(posted.status, 200);
      }
      const prune2 = await request('/api/memory/prune', 'POST', {});
      assert.ok(prune2.json.activated.includes('learned-trial'), '3 shadowed runs + 2 green ⇒ activated with notice');
      assert.ok((await read(path.join(skillsDir, 'learned-trial.md'))).includes('status: active'));

      // --- B5 — toggles persist ---
      assert.deepEqual(await (await request('/api/memory/config')).json, { learningEnabled: true, reflectionEnabled: true });
      assert.equal((await request('/api/memory/config', 'PUT', { learningEnabled: false, reflectionEnabled: false })).status, 200);
      assert.deepEqual(await (await request('/api/memory/config')).json, { learningEnabled: false, reflectionEnabled: false });
      assert.deepEqual(JSON.parse(await read(path.join(memoryDir, 'memory-config.json'))), { learningEnabled: false, reflectionEnabled: false });
      await request('/api/memory/config', 'PUT', {});
      assert.deepEqual(await (await request('/api/memory/config')).json, { learningEnabled: true, reflectionEnabled: true });

      // --- B5 — activity ledger recorded the whole story (checked pre-erase: erase rotates the ledger) ---
      const activity = await request('/api/memory/activity');
      const types = activity.json.activity.map((item: any) => item.type);
      for (const expected of ['playbook_bootstrap', 'playbook_promoted', 'playbook_demoted', 'playbook_candidate', 'skill_draft', 'skill_saved', 'skill_archived', 'skill_activated']) {
        assert.ok(types.includes(expected), `activity must include '${expected}' (have: ${[...new Set(types)].join(', ')})`);
      }

      // --- B5 — erase-all wipes learned memory but keeps dossiers + shipped skills ---
      assert.equal((await request('/api/memory/dossier_exam1', 'PUT', { id: 'exam1', events: [{ type: 'note' }] })).status, 200);
      const erase = await request('/api/memory/erase', 'POST', {});
      assert.equal(erase.status, 200);
      assert.equal(erase.json.dossiersKept, true);
      assert.ok(erase.json.removedEntries >= 2, `removed ${erase.json.removedEntries} non-bootstrap entries`);
      assert.ok(erase.json.removedSkills >= 2, `removed ${erase.json.removedSkills} learned skills`);
      assert.ok(erase.json.removedRuns >= 2000, `removed ${erase.json.removedRuns} run lines`);
      const erasedPlaybook = await request('/api/memory/playbook');
      assert.equal(erasedPlaybook.json.entries.length, 5);
      assert.ok(erasedPlaybook.json.entries.every((entry: any) => String(entry.id).startsWith('bootstrap_')), 'playbook reset to bootstrap');
      assert.deepEqual(await (await request('/api/memory/runs')).json, []);
      assert.equal(await exists(path.join(memoryDir, 'runs.jsonl')), false, 'journal file gone');
      assert.equal(await exists(path.join(memoryDir, 'runs-archive.jsonl')), false, 'archive gone too');
      const kept = (await fs.readdir(skillsDir)).filter(name => name.endsWith('.md')).sort();
      assert.ok(!kept.includes('learned-trial.md') && !kept.includes('learned-stale.md') && !kept.includes(draftSlug + '.md'), 'learned skills erased');
      assert.ok(kept.includes('shipped-stale.md'), "the user's own shipped-source skill stays");
      assert.equal(kept.filter(name => !name.includes('stale')).length, 7, 'the 7 shipped skills stay');
      const postEraseActivity = await request('/api/memory/activity');
      assert.ok(postEraseActivity.json.activity.some((item: any) => item.type === 'memory_erased'), 'the erase itself is ledgered');
      const dossier = await request('/api/memory/dossier_exam1');
      assert.equal(dossier.status, 200, 'per-exam dossiers are kept');
      assert.deepEqual(dossier.json.events, [{ type: 'note' }]);

      console.log(`memory server: bootstrap 5 entries + 7 skills; rotation 2000+1→archive 1; credit candidate→active→demoted; proposal candidate conf ${candidate.confidence}; draft ${draftSlug} never auto-activated; prune archived [${prune1.json.archived}] badged [${prune1.json.badges}]; activated [${prune2.json.activated}]; erase kept dossiers + 7 shipped, removed ${erase.json.removedEntries} entries/${erase.json.removedSkills} skills/${erase.json.removedRuns} runs`);
    } finally {
      child.kill('SIGKILL');
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
