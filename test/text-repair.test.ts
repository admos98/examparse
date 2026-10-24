import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTextRepairOverlay,
  collectTextRepairCandidates,
  runTextRepairStage,
  textRepairCacheKey,
  textRepairRejectionReasons,
  revertTextRepairOverlays,
  type TextRepairCache,
  type TextRepairCacheEntry,
} from '../src/pipeline/textRepair';
import type { ExamDoc, SourceLine } from '../src/types';
import { buildExportDoc } from '../src/utils/examExport';

class MemoryRepairCache implements TextRepairCache {
  data = new Map<string, TextRepairCacheEntry>();
  async get(key: string) { return this.data.get(key); }
  async set(key: string, value: TextRepairCacheEntry) { this.data.set(key, value); }
}

const sourceLine = (text: string, id = 'L0001', extra: Partial<SourceLine> = {}): SourceLine => ({ id, page: 1, text, ...extra });

test('Part B: candidates are local suspicion only; answer-key/furniture lines are never candidates', () => {
  const lines = [
    sourceLine('متن‌ مشکوک برای اصلاح', 'L0001', { garbled: true }),
    sourceLine('متن‌ کلید مشکوک', 'L0002', { garbled: true }),
    sourceLine('footer text', 'L0003', { garbled: true, furniture: true }),
    sourceLine('ordinary readable English sentence', 'L0004'),
  ];
  const candidates = collectTextRepairCandidates(lines, new Set([2]));
  assert.deepEqual(candidates.map(candidate => candidate.lineNo), [1]);
  assert.ok(candidates[0].reasons.includes('extraction-garbled'));
});

test('Part B: repair fences protect digits, Latin words/islands, printed anchors, length and Arabic script ratio', () => {
  const original = '۳. متن English Island برای اصلاح';
  assert.ok(textRepairRejectionReasons(original, '۴. متن English Island برای اصلاح').includes('digit multiset changed'));
  assert.ok(textRepairRejectionReasons(original, '۳. متن English Phrase برای اصلاح').includes('Latin token multiset changed'));
  assert.ok(textRepairRejectionReasons('متن one two برای اصلاح', 'متن two one برای اصلاح').includes('Latin island changed'));
  assert.ok(textRepairRejectionReasons('متن alpha فارسی beta', 'متن beta فارسی alpha').includes('Latin island changed'), 'separate Latin islands cannot be reordered across RTL runs');
  assert.ok(textRepairRejectionReasons(original, 'متن English Island برای اصلاح').includes('printed-number token changed'));
  assert.ok(textRepairRejectionReasons(original, 'متن').some(reason => reason.startsWith('length ratio')));
  assert.ok(textRepairRejectionReasons('هذا نص عربي واضح مع English', 'English text only').includes('Arabic-script ratio decreased'));
  assert.deepEqual(textRepairRejectionReasons('متن‌ مشکوک برای اصلاح', 'متن مشکوک برای اصلاح'), []);
});

test('Part B: repairs are overlays only, one batched call, and cached content-hash reruns make zero calls', async () => {
  const lines = [sourceLine('متن‌ مشکوک برای اصلاح', 'L0001', { garbled: true })];
  const cache = new MemoryRepairCache();
  let calls = 0;
  const caller = async () => {
    calls++;
    return { json: { r: [[1, 'متن مشکوک برای اصلاح']] }, usage: { inputTokens: 51, outputTokens: 12 } };
  };
  const first = await runTextRepairStage({ lines, enabled: true, provider: 'provider-a', model: 'model-a', caller, cache });
  assert.equal(calls, 1);
  assert.equal(first.stats.calls, 1);
  assert.equal(first.stats.repaired, 1);
  assert.equal(lines[0].text, 'متن‌ مشکوک برای اصلاح');
  const effective = applyTextRepairOverlay(lines, first.lineRepairs);
  assert.equal(effective[0].text, 'متن مشکوک برای اصلاح');
  assert.equal(lines[0].text, 'متن‌ مشکوک برای اصلاح');

  const second = await runTextRepairStage({ lines, enabled: true, provider: 'provider-a', model: 'model-a', caller, cache });
  assert.equal(calls, 1);
  assert.equal(second.stats.status, 'cached');
  assert.equal(second.stats.calls, 0);
  assert.equal(second.stats.cachedLines, 1);
  assert.deepEqual(second.lineRepairs, first.lineRepairs);

  const changed = await textRepairCacheKey('different text', 'provider-a', 'model-a');
  const same = await textRepairCacheKey('متن‌ مشکوک برای اصلاح', 'provider-a', 'model-a');
  assert.notEqual(changed, same);
});

test('Part B: source/review/export preserve originals, expose overlays, and line revert rebuilds dependent stems', () => {
  const lines: SourceLine[] = [
    sourceLine('Complete the following items.', 'L0001'),
    sourceLine('۱. گرامر اشتباه است', 'L0002'),
    sourceLine('۲. پاسخ غلط است', 'L0003'),
  ];
  const doc: ExamDoc = {
    id: 'text-repair-revert', fileHash: 'repair-hash', createdAt: 'now', displayName: 'Repair fixture',
    meta: { language: 'fa', direction: 'rtl', totalPoints: 1 },
    sections: [{ id: 'sec_1', index: 1, title: 'Vocabulary', spans: [[1, 3]] }],
    questions: [
      { id: 'q1', label: '1', no: 1, sectionId: 'sec_1', spans: [[2, 2]], stem: '۱. گرامر درست است', points: 0.5, type: 'short', confidence: 0.9, images: [] },
      { id: 'q2', label: '2', no: 2, sectionId: 'sec_1', spans: [[3, 3]], stem: '۲. پاسخ صحیح است', points: 0.5, type: 'short', confidence: 0.9, images: [] },
    ],
    images: [],
    source: {
      lines, pages: 1, ocrUsed: false, fileName: 'fixture.pdf', expectedQuestionNos: [1, 2],
      lineRepairs: { '2': '۱. گرامر درست است', '3': '۲. پاسخ صحیح است' },
      textRepairStats: { status: 'completed', candidates: 2, repaired: 2, rejected: 0, unchanged: 0, calls: 1, inputTokens: 51, outputTokens: 12, cachedLines: 0, reverted: 0, rejectionReasons: {} },
    },
    flags: [
      { id: 'flag_TEXT_REPAIR_APPLIED_L2', code: 'TEXT_REPAIR_APPLIED', severity: 'info', message: 'overlay 2' },
      { id: 'flag_TEXT_REPAIR_APPLIED_L3', code: 'TEXT_REPAIR_APPLIED', severity: 'info', message: 'overlay 3' },
    ],
    usage: [],
  };
  const exportedBefore = buildExportDoc(doc);
  assert.equal(exportedBefore.source.lines[1].text, '۱. گرامر اشتباه است');
  assert.equal(exportedBefore.source.lineRepairs['2'], '۱. گرامر درست است');
  assert.equal(exportedBefore.source.textRepairStats.calls, 1);

  const reverted = revertTextRepairOverlays(doc, [2]);
  assert.equal(reverted.source.lineRepairs?.['2'], undefined);
  assert.equal(reverted.source.lineRepairs?.['3'], '۲. پاسخ صحیح است');
  assert.equal(reverted.source.textRepairStats?.reverted, 1);
  assert.equal(reverted.questions.find(question => question.no === 1)?.stem, '۱. گرامر اشتباه است');
  assert.equal(reverted.questions.find(question => question.no === 2)?.stem, '۲. پاسخ صحیح است');
  assert.equal(doc.source.lines[1].text, '۱. گرامر اشتباه است', 'stored source object remains unchanged');
  assert.ok(reverted.flags.some(flag => flag.code === 'TEXT_REPAIR_REVERTED'));
  assert.ok(!reverted.flags.some(flag => flag.id === 'flag_TEXT_REPAIR_APPLIED_L2'));
  const exportedAfter = buildExportDoc(reverted);
  assert.equal(exportedAfter.source.lines[1].text, '۱. گرامر اشتباه است');
  assert.equal(exportedAfter.source.lineRepairs['3'], '۲. پاسخ صحیح است');
  assert.equal(exportedAfter.source.textRepairStats.reverted, 1);

  const revertedAll = revertTextRepairOverlays(doc);
  assert.deepEqual(revertedAll.source.lineRepairs, {});
  assert.equal(revertedAll.questions.find(question => question.no === 1)?.stem, '۱. گرامر اشتباه است');
  assert.equal(revertedAll.questions.find(question => question.no === 2)?.stem, '۲. پاسخ غلط است');
  assert.equal(revertedAll.source.textRepairStats?.reverted, 2);
});

test('Part B: disabled or unavailable repair never blocks parsing and marks stage skipped', async () => {
  const lines = [sourceLine('متن‌ مشکوک برای اصلاح', 'L0001', { garbled: true })];
  const disabled = await runTextRepairStage({ lines, enabled: false });
  assert.equal(disabled.stats.status, 'disabled');
  const unavailable = await runTextRepairStage({ lines, enabled: true });
  assert.equal(unavailable.stats.status, 'unavailable');
  assert.equal(unavailable.stats.calls, 0);
  assert.deepEqual(unavailable.lineRepairs, {});
});
