import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { examContentRevision } from '../src/pipeline/quality';
const hash = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
test(
  'folder-only server: setup, validated buckets, isolated clearing, durable 10 versions and exact restore',
  { timeout: 30000 },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'examparse-storage-test-'),
    );
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((r) => listener.close(() => r()));
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
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(
          () => reject(new Error(`Server startup timed out: ${output}`)),
          15000,
        );
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('ExamParse server running')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Server exited ${code}`));
        });
        child.stderr.on('data', (chunk) => {
          output += String(chunk);
        });
      });
      const base = `http://127.0.0.1:${port}`;
      const request = (url: string, method = 'GET', body?: unknown) =>
        fetch(base + url, {
          method,
          ...(body !== undefined
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }
            : {}),
        });
      assert.equal(
        (await (await request('/api/storage/health')).json()).configured,
        false,
      );
      assert.equal((await request('/api/exams')).status, 503);
      const dir = path.join(root, 'folder');
      assert.equal(
        (await request('/api/storage/config', 'POST', { dir })).status,
        200,
      );
      assert.equal(
        (await (await request('/api/storage/health')).json()).mode,
        'folder',
      );
      assert.equal(
        JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'))
          .dir,
        dir,
      );
      assert.equal(
        (
          await request('/api/agent-lock/exam_fixture', 'POST', {
            owner: 'tab_one',
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request('/api/agent-lock/exam_fixture', 'POST', {
            owner: 'tab_two',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request('/api/agent-lock/exam_fixture', 'DELETE', {
            owner: 'tab_two',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request('/api/agent-lock/exam_fixture', 'DELETE', {
            owner: 'tab_one',
          })
        ).status,
        200,
      );
      let doc: any = {
        id: 'exam_fixture',
        fileHash: 'abc',
        displayName: 'Original',
        createdAt: new Date().toISOString(),
        meta: { language: 'fa', direction: 'rtl' },
        source: {
          pages: 1,
          ocrUsed: false,
          fileName: 'fixture.txt',
          lines: [{ id: 'L0001', page: 1, text: '۱. می‌شود؟' }],
        },
        questions: [
          {
            id: 'q1',
            no: 1,
            label: '۱',
            type: 'short',
            stem: '۱. می‌شود؟',
            spans: [[1, 1]],
            confidence: 0.9,
            images: [],
          },
        ],
        sections: [],
        images: [],
        flags: [],
        usage: [],
      };
      assert.equal(
        (await request('/api/exams/exam_fixture', 'PUT', doc)).status,
        200,
      );
      for (let i = 0; i < 12; i++) {
        doc = {
          ...doc,
          displayName: `Version ${i}`,
          questions: [{ ...doc.questions[0], points: i }],
        };
        assert.equal(
          (await request('/api/exams/exam_fixture', 'PUT', doc)).status,
          200,
        );
      }
      const beforeConflict = hash(
        await fs.readFile(path.join(dir, 'exams/exam_fixture.json')),
      );
      const conflict = await fetch(`${base}/api/exams/exam_fixture`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': 'stale_hash',
        },
        body: JSON.stringify({ ...doc, displayName: 'must not overwrite' }),
      });
      assert.equal(conflict.status, 409);
      assert.equal(
        hash(await fs.readFile(path.join(dir, 'exams/exam_fixture.json'))),
        beforeConflict,
      );
      const same = await fetch(`${base}/api/exams/exam_fixture`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': hash(examContentRevision(doc)),
        },
        body: JSON.stringify(doc),
      });
      assert.equal(same.status, 200);
      const versions = await (
        await request('/api/exams/exam_fixture/versions')
      ).json();
      assert.equal(versions.length, 10);
      assert.equal(versions.at(-1).displayName, 'Version 10');
      assert.equal(
        (
          await request(
            `/api/exams/exam_fixture/restore/${versions.at(-1).id}`,
            'POST',
          )
        ).status,
        200,
      );
      const restored = await (await request('/api/exams/exam_fixture')).json();
      assert.deepEqual(restored.questions, versions.at(-1).questions);
      assert.equal(restored.source.lines[0].text, '۱. می‌شود؟');
      await request('/api/cache/test_cache', 'PUT', { cached: true });
      await request('/api/journals/test_journal', 'PUT', { calls: [1] });
      await request('/api/usage', 'POST', {
        role: 'agent',
        ts: new Date().toISOString(),
        label: 'Mock',
        provider: 'local',
        model: 'mock',
        costUsd: 0.1,
      });
      const image = await fetch(
        `${base}/api/images/image_one?mime=image%2Fpng`,
        { method: 'PUT', body: new Uint8Array([137, 80, 78, 71]) },
      );
      assert.equal(image.status, 200);
      const examFile = path.join(dir, 'exams/exam_fixture.json');
      const imageFile = path.join(dir, 'images/image_one.png');
      const examHash = hash(await fs.readFile(examFile));
      const imageHash = hash(await fs.readFile(imageFile));
      const journalHash = hash(
        await fs.readFile(path.join(dir, 'journals/test_journal.json')),
      );
      const stats = await (await request('/api/storage/stats')).json();
      for (const bucket of ['exams', 'images', 'cache', 'journals', 'usage'])
        assert.ok(stats.buckets[bucket].bytes > 0);
      for (const bucket of ['cache', 'journals', 'usage']) {
        const result = await (
          await request(`/api/storage/buckets/${bucket}`, 'DELETE')
        ).json();
        assert.equal(result.deleted, 1);
        assert.equal(hash(await fs.readFile(examFile)), examHash);
        assert.equal(hash(await fs.readFile(imageFile)), imageHash);
        if (bucket === 'cache')
          assert.equal(
            hash(
              await fs.readFile(path.join(dir, 'journals/test_journal.json')),
            ),
            journalHash,
          );
      }
      assert.equal(
        (await request('/api/storage/buckets/exams', 'DELETE')).status,
        400,
      );
      assert.equal(
        (await request('/api/cache/bad%3Akey', 'PUT', {})).status,
        400,
      );
      assert.equal(
        (await request('/api/journals/bad%3Akey', 'PUT', {})).status,
        400,
      );
      await fs.symlink(examFile, path.join(dir, 'cache/symlink.json'));
      assert.equal((await request('/api/cache/symlink')).status, 400);
      assert.equal((await request('/api/exams/exam_fixture')).status, 200);
      assert.equal((await request('/api/usage')).status, 200);
      // Mock upstream is local and deterministic: no real provider calls or credentials.
      let upstreamCalls = 0;
      const limits: number[] = [];
      const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          upstreamCalls++;
          const payload = JSON.parse(body);
          limits.push(payload.max_tokens ?? payload.max_completion_tokens);
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { content: 'Local mock only.' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        });
      });
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      try {
        const upstreamPort = (upstream.address() as net.AddressInfo).port;
        for (let i = 0; i < 7; i++) {
          const res = await request('/api/llm', 'POST', {
            role: 'agent',
            system: 'mock',
            text: 'mock',
            label: 'test budget',
            maxOutputTokens: i === 0 ? 256 : 9999,
            providerConfig: {
              id: 'mock',
              name: 'Mock',
              kind: 'openai-compatible',
              model: 'mock',
              baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
              structuredOutputs: false,
              agentBudgetId: 'budget_fixture',
            },
          });
          assert.equal(res.status, i < 6 ? 200 : 500);
        }
        assert.equal(upstreamCalls, 6);
        assert.ok(limits.every((n) => n === 256));
        assert.equal(
          (
            await (
              await request('/api/journals/agent_budget_budget_fixture')
            ).json()
          ).calls,
          6,
        );
        const refused = await request('/api/llm', 'POST', {
          role: 'agent',
          system: '',
          text: '',
          images: [{ id: 'x', mime: 'image/png', data: 'AAAA' }],
          providerConfig: {
            id: 'mock',
            kind: 'openai-compatible',
            model: 'mock',
            baseURL: `http://127.0.0.1:${upstreamPort}`,
            agentBudgetId: 'vision_forbidden',
          },
        });
        assert.equal(refused.status, 400);
        assert.equal(upstreamCalls, 6);
      } finally {
        await new Promise<void>((r) => upstream.close(() => r()));
      }
      // Monthly totals survive the rolling 500-entry UI history limit.
      for (let i = 0; i < 2; i++) {
        const batch = Array.from({ length: i === 0 ? 500 : 1 }, (_, n) => ({
          role: 'agent',
          ts: new Date().toISOString(),
          label: `monthly ${i}-${n}`,
          provider: 'mock',
          model: 'mock',
          costUsd: 1,
        }));
        assert.equal((await request('/api/usage', 'POST', batch)).status, 200);
      }
      assert.equal((await (await request('/api/usage')).json()).length, 500);
      assert.equal(
        (await (await request('/api/usage/monthly')).json())[
          new Date().toISOString().slice(0, 7)
        ],
        501,
      );
      console.log(
        'storage: 3 isolated bucket clears; 2 unchanged SHA-256 hashes per clear; 10 versions retained; exact restore',
      );
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
