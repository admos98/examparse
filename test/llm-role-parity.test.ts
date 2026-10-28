import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LLM_ROLES } from '../src/types';
import { validateLlmRequest, validateDecisionsRequest } from '../server';

const quoted = (block: string) => [...block.matchAll(/'([^']+)'/g)].map(match => match[1]);

const minimalRequest = (role: string) => ({ role, system: 'system', text: 'text', label: 'label' });

test('parity — server validator accepted-role set equals the types.ts role union', () => {
  const typesSrc = fs.readFileSync(path.join(process.cwd(), 'src/types.ts'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');

  const constMatch = typesSrc.match(/export const LLM_ROLES\s*=\s*\[([^\]]+)\]/);
  assert.ok(constMatch, 'LLM_ROLES must be exported from src/types.ts');
  assert.deepEqual(quoted(constMatch[1]), [...LLM_ROLES]);

  const handwritten = [...typesSrc.matchAll(/role:\s*((?:'[^']+'\s*\|\s*)+'[^']+')/g)]
    .map(match => quoted(match[1]))
    .filter(roles => roles.includes('fast') && roles.includes('vision'));
  for (const roles of handwritten) {
    assert.deepEqual(roles, [...LLM_ROLES], 'handwritten LLM role union drifted from LLM_ROLES');
  }
  assert.equal((typesSrc.match(/role:\s*LLMRole/g) || []).length >= 2, true, 'UsageRecord and LLMRequest must use LLMRole');

  assert.match(serverSrc, /LLM_ROLES/);
  assert.match(serverSrc, /export function validateLlmRequest/);
  assert.doesNotMatch(
    serverSrc,
    /\['fast',\s*'standard',\s*'escalation',\s*'vision',\s*'ocr',\s*'patch',\s*'agent'\]/,
    'server must not keep a stale hardcoded role whitelist',
  );

  const accepted = LLM_ROLES.filter(role => validateLlmRequest(minimalRequest(role)) === null);
  assert.deepEqual(accepted, [...LLM_ROLES]);
});

test('server seam — text-repair and cleanup pass validateLlmRequest; a bogus role is still rejected', () => {
  assert.equal(validateLlmRequest(minimalRequest('text-repair')), null);
  assert.equal(validateLlmRequest(minimalRequest('cleanup')), null);
  assert.equal(validateLlmRequest(minimalRequest('critic')), null);
  assert.equal(validateLlmRequest(minimalRequest('consensus')), null);
  assert.equal(validateLlmRequest(minimalRequest('not-a-role')), 'Unsupported LLM role.');
  assert.equal(validateLlmRequest(minimalRequest('')), 'Unsupported LLM role.');
  assert.equal(validateLlmRequest({ system: 'system', text: 'text' }), 'Unsupported LLM role.');
});


test('#46 decisions proxy validator accepts typed probability/choice payloads with optional image pixels and rejects malformed ones', () => {
  const providerConfig = { kind: 'openai-compatible', model: 'decider', baseURL: 'http://127.0.0.1:11434/v1', decisionsPath: '/v1/decisions' };
  const body = { input: { exam: 'h' }, questions: [
    { type: 'probability', name: 'Q1::stem-faithful', instructions: 'Is the stem faithful?', input: { question: { number: 1 } } },
    { type: 'choice', name: 'Image img1 image-belongs', instructions: 'Does it belong?', choices: ['this question', 'another question on the page', 'no question'], input: { caption: 'cat' }, images: [{ id: 'img1', mime: 'image/png', data: 'aGVsbG8=' }] },
  ] };
  assert.equal(validateDecisionsRequest({ providerConfig, body }), null);
  assert.ok(validateDecisionsRequest({ providerConfig: { ...providerConfig, kind: 'gemini' }, body }));
  assert.ok(validateDecisionsRequest({ providerConfig, body: { ...body, questions: [{ ...body.questions[0], type: 'essay' }] } }));
  assert.ok(validateDecisionsRequest({ providerConfig, body: { ...body, questions: [{ ...body.questions[1], images: [{ id: 'img1', mime: 'text/html', data: 'aGVsbG8=' }] }] } }));
  assert.ok(validateDecisionsRequest({ providerConfig: { ...providerConfig, decisionsPath: 'https://evil.example' }, body }));
});
