import test from 'node:test';
import assert from 'node:assert/strict';
import type { LLMRequest, LLMResponse, SourceLine } from '../src/types';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { runStructurePass } from '../src/pipeline/structure';
import { LLMAdapter } from '../src/providers/adapter';

const lines: SourceLine[] = [
  { id: 'L0001', page: 1, text: '1. Original question' },
  { id: 'L0002', page: 1, text: '1. Duplicate printed question' },
];
const question = (line: number) => ({ n: 1, s: 'sec_1', t: 's', p: [[line, line]], c: 8 });
const output: LLMResponse = {
  json: {
    m: {},
    s: [{ id: 'sec_1', index: 1, p: [[1, 2]], kind: 'Other' }],
    q: [question(1), question(2)],
  },
  rawText: '', finishReason: 'STOP', usage: { inputTokens: 20, outputTokens: 10 },
};

test('structure recovery retains repeated printed numbers at distinct source anchors', async () => {
  const originalExecute = LLMAdapter.execute;
  let calls = 0;
  LLMAdapter.execute = (async (_request: LLMRequest) => { calls++; return output; }) as typeof LLMAdapter.execute;
  try {
    const parsed = await runStructurePass({
      sourceLines: lines, images: [], latexEnabled: false, forceSectionMode: true,
      providerConfig: { id: 'test', name: 'test', kind: 'openai-compatible', model: 'gpt-4o', baseURL: 'https://example.test/v1' },
    });
    assert.equal(calls, 1);
    assert.equal(parsed.rawQuestions.length, 2);
    assert.equal(parsed.jsonNull, true);
    assert.ok(parsed.flags?.some(flag => flag.code === 'COVERAGE_DUPLICATE'));
    const assembled = assembleAndValidateQuestions(parsed.rawQuestions, lines);
    assert.equal(new Set(assembled.questions.map(item => item.id)).size, 2);
  } finally { LLMAdapter.execute = originalExecute; }
});
