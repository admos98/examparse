import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, ExamSummary } from '../src/store';
import { ExamDoc } from '../src/types';
import { applyTheme, nextThemeMode, THEME_DEFAULTS } from '../src/pipeline/agentTheme';
import { buildPaletteItems, nextEnabledPaletteIndex, rankPaletteItems, PaletteItem } from '../src/design/CommandPalette';
import { DeterministicRenderer } from '../src/views/DeterministicRenderer';
import { StyleGuideView } from '../src/design/StyleGuideView';
import { printStyles } from '../src/utils/printCheck';

const tokenCss = readFileSync(new URL('../src/design/tokens.css', import.meta.url), 'utf8');
const styleGuideSource = readFileSync(new URL('../src/design/StyleGuideView.tsx', import.meta.url), 'utf8');
const examSheetSource = readFileSync(new URL('../src/design/ExamSheet.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const step4Source = readFileSync(new URL('../src/views/Step4Review.tsx', import.meta.url), 'utf8');
const step5Source = readFileSync(new URL('../src/views/Step5Exam.tsx', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const specimenDoc: ExamDoc = {
  id: 'design-specimen', fileHash: 'design-fixture', createdAt: '2026-01-01T00:00:00.000Z', displayName: 'نمونه برگه',
  meta: { language: 'fa', direction: 'rtl', title: 'آزمون نمونه', subject: 'ریاضی', school: 'مدرسه', grade: 'پایه دوازدهم', year: '۱۴۰۵', durationMinutes: 45, totalPoints: 2 },
  sections: [{ id: 'section-1', index: 1, title: 'پرسش‌ها', passage: 'متن پیوسته آزمون', spans: [[1, 4]] }],
  questions: [{ id: 'q-1', label: '۱', no: 1, sectionId: 'section-1', spans: [[2, 2]], stem: '1. گزینه درست را انتخاب کنید.', type: 'mcq', points: 2, options: [{ key: 'الف', spans: [[3, 3]], text: 'گزینه نخست' }], confidence: 0.98, images: [], answer: { text: 'الف', source: 'manual' } }],
  images: [], source: { lines: [{ id: 'L0001', page: 1, text: 'عنوان' }, { id: 'L0002', page: 1, text: '1. گزینه درست' }, { id: 'L0003', page: 1, text: 'الف) گزینه نخست' }, { id: 'L0004', page: 1, text: 'پایان' }], pages: 1, ocrUsed: false, fileName: 'specimen.pdf' },
  flags: [], usage: [],
};

test('PAPERWORK declares the required light/dark token set and no remote font source', () => {
  for (const token of ['paper', 'paper-raised', 'ink', 'ink-2', 'ink-3', 'rule', 'rule-strong', 'accent', 'accent-ink', 'ok', 'warn', 'danger', 'focus']) {
    assert.match(tokenCss, new RegExp(`--${token}\\s*:`));
  }
  assert.match(tokenCss, /prefers-color-scheme:\s*dark/);
  assert.match(tokenCss, /data-theme='dark'/);
  assert.match(tokenCss, /--type-12:\s*0\.75rem/);
  assert.match(tokenCss, /--radius-control:\s*6px/);
  assert.match(tokenCss, /--radius-card:\s*10px/);
  assert.match(tokenCss, /--radius-sheet:\s*2px/);
  assert.doesNotMatch(tokenCss, /--type-11|linear-gradient|radial-gradient|backdrop-filter/);
  const paintedShadows = [...tokenCss.matchAll(/box-shadow:\s*([^;]+);/g)].filter(([, value]) => value.trim() !== 'none');
  assert.equal(paintedShadows.length, 1, 'only the ExamSheet may cast a shadow');
  assert.match(tokenCss, /font-display:\s*optional/g);
  assert.doesNotMatch(tokenCss, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.equal(THEME_DEFAULTS.primary, '#B3402A');
  assert.equal(THEME_DEFAULTS.background, '#FAF7F2');
  assert.equal(THEME_DEFAULTS.foreground, '#1A1815');
  assert.equal(nextThemeMode('system', true), 'light');
  assert.equal(nextThemeMode('system', false), 'dark');
  assert.equal(nextThemeMode('dark', false), 'light');
  assert.equal(nextThemeMode('light', true), 'dark');
});

test('route-addressable styleguide covers all 21 primitives and is not linked from production navigation', () => {
  const visiblePrimitives = ['Button', 'Badge', 'Card', 'Checkbox', 'ConfirmCard', 'Disclosure', 'EmptyState', 'Input', 'Kbd', 'Modal', 'ProgressBar', 'Rule', 'Select', 'Skeleton', 'Stat', 'Switch', 'Tabs', 'Textarea', 'Toast', 'Tooltip'];
  for (const primitive of visiblePrimitives) assert.ok(styleGuideSource.includes(`<${primitive}`), `${primitive} should appear in the styleguide gallery`);
  assert.ok(styleGuideSource.includes('DeterministicRenderer'), 'the styleguide includes a real ExamSheet renderer specimen');
  assert.match(examSheetSource, /<Sheet\b/);
  assert.match(step5Source, /role="tabpanel" aria-labelledby=\{`tab-\$\{renderMode\}`\}/);
  assert.match(step4Source, /data-review-question=\{q\.id\}/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === 'j'/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === 'k'/);
  assert.match(appSource, /window\.location\.pathname === '\/styleguide'/);
  assert.doesNotMatch(appSource, /href=["']\/styleguide/);
  const english = renderToStaticMarkup(React.createElement(StyleGuideView, { language: 'en' }));
  const persian = renderToStaticMarkup(React.createElement(StyleGuideView, { language: 'fa' }));
  const pairs = [
    ['token and primitive reference', 'مرجع توکن‌ها و اجزا'],
    ['Color tokens', 'توکن‌های رنگ'], ['Primitive states', 'حالت‌های اجزا'],
    ['Controls', 'کنترل‌ها'], ['Data and feedback', 'داده و بازخورد'],
    ['Input', 'ورودی'], ['Select', 'گزینش'], ['Textarea', 'متن چندخطی'],
    ['Hide sheet', 'پنهان‌کردن برگه'], ['Review', 'بازبینی'], ['Exam', 'آزمون'],
  ];
  for (const [en, fa] of pairs) { assert.ok(english.includes(en), `missing English string: ${en}`); assert.ok(persian.includes(fa), `missing fa translation: ${fa}`); }
});

test('Assistant page navigation closes the page and deleting its active exam returns to Import', () => {
  assert.match(appSource, /const navigateToStep = useCallback\(\(step: StepNumber\) => \{\s*setAssistantMode\('closed'\);\s*setCurrentStep\(step\);/);
  assert.match(appSource, /const navigateToLibrary = useCallback\(\(\) => \{\s*setAssistantMode\('closed'\);\s*setIsLibraryOpen\(true\);/);
  assert.match(appSource, /onSelectStep=\{navigateToStep\}/);
  assert.ok((appSource.match(/onOpenLibrary=\{navigateToLibrary\}/g) || []).length >= 3, 'rail, header, and palette use the shared Library transition');
  const deleteHandler = appSource.slice(appSource.indexOf('const handleLibraryExamDeleted'), appSource.indexOf('const handleDocUpdated'));
  assert.match(deleteHandler, /setCurrentStep\(1\)/);
  assert.match(deleteHandler, /setMaxReachedStep\(1\)/);
  assert.match(deleteHandler, /setAssistantMode\('closed'\)/);
  const importHandler = appSource.slice(appSource.indexOf('const handleDocumentLoaded'), appSource.indexOf('const handleDemoLoaded'));
  assert.match(importHandler, /setExamDoc\(null\)/, 'a new upload must not keep the previous exam as the active review target');
  assert.match(importHandler, /setStages\(\[\]\)/);
  assert.match(importHandler, /setMaxReachedStep\(2\)/, 'new imports reset the workflow gate to the Source step');
});

test('deterministic exam output is a single RTL ExamSheet with stable screen/print structure', () => {
  const html = renderToStaticMarkup(React.createElement(DeterministicRenderer, { doc: specimenDoc, mode: 'paper' }));
  assert.equal((html.match(/class="ep-sheet exam-sheet"/g) || []).length, 1);
  assert.equal((html.match(/<main\b/g) || []).length, 0, 'the sheet does not nest a second main landmark inside the app main');
  assert.match(html, /dir="rtl"/);
  assert.match(html, /lang="fa"/);
  assert.match(html, /class="ep-sheet-header"/);
  assert.match(html, /data-sheet-header-grid="true"/);
  assert.equal((html.match(/data-sheet-section="true"/g) || []).length, 1);
  assert.match(html, /data-qid="q-1" data-no="1"/);
  assert.match(html, /data-sheet-passage="true"/);
  assert.match(tokenCss, /\.ep-question\s*\{[^}]*break-inside:\s*avoid;[^}]*page-break-inside:\s*avoid/s);
  assert.match(tokenCss, /\.answer-key\s*\{[^}]*break-before:\s*page;[^}]*page-break-before:\s*always/s);
  assert.match(tokenCss, /@media print\s*\{\s*:root\s*\{[^}]*--paper:\s*#FFFFFF/s);
  assert.match(indexCss, /@page\s*\{\s*size:\s*A4 portrait;\s*margin:\s*18mm;/);
  assert.match(printStyles, /@page \{ size: A4 portrait; margin: 18mm; \}/);
  assert.match(printStyles, /\.ep-sheet \{ break-inside: auto; page-break-inside: auto; \}/);
});

test('legacy assistant theme tokens map to PAPERWORK aliases and themeMode persists', () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as unknown as Storage;
  const properties = new Map<string, string>();
  const style = {
    setProperty: (key: string, value: string) => properties.set(key, value),
    removeProperty: (key: string) => { properties.delete(key); },
  } as unknown as CSSStyleDeclaration;
  try {
    const seeded = { ...structuredClone(DEFAULT_SETTINGS), themeTokens: { primary: '#EAB308', background: '#FFFDFC', foreground: '#191715' }, themeMode: 'dark' as const };
    globalThis.localStorage.setItem('examparse_settings_v1', JSON.stringify(seeded));
    const loaded = loadSettings();
    assert.equal(loaded.themeTokens?.primary, '#EAB308');
    assert.equal(loaded.themeMode, 'dark');
    applyTheme(loaded, style);
    assert.equal(properties.get('--app-primary'), '#EAB308');
    assert.equal(properties.get('--legacy-accent'), '#EAB308');
    assert.equal(properties.get('--legacy-paper'), '#FFFDFC');
    assert.equal(properties.get('--legacy-ink'), '#191715');
    saveSettings({ ...loaded, themeMode: 'light' });
    assert.equal(loadSettings().themeMode, 'light');
    assert.equal(JSON.parse(values.get('examparse_settings_v1') || '{}').themeMode, 'light');
    assert.match(tokenCss, /:root\[data-theme='dark'\]/);
    assert.match(tokenCss, /@media \(prefers-color-scheme: dark\)/);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test('palette registry actions invoke the expected workflow, workspace, settings, export, retry, and theme callbacks', async () => {
  const calls: string[] = [];
  const summary = { id: 'saved-1', displayName: 'Physics final', fileName: 'physics.pdf', subject: 'Physics', grade: '12', createdAt: '2026-01-01T00:00:00.000Z' } as ExamSummary;
  const items = buildPaletteItems({
    summaries: [summary], language: 'fa', currentStep: 2, maxReachedStep: 5, hasExam: true, canRetry: true,
    onNavigateStep: step => { calls.push(`step:${step}`); },
    onOpenExam: exam => { calls.push(`exam:${exam.id}`); },
    onOpenLibrary: () => calls.push('library'),
    onAskAssistant: verify => calls.push(`assistant:${Boolean(verify)}`),
    onOpenSettings: tab => calls.push(`settings:${tab || 'providers'}`),
    onRetry: () => calls.push('retry'), onExport: () => calls.push('export'), onToggleTheme: () => calls.push('theme'),
  });
  const run = async (id: string) => { const item = items.find(candidate => candidate.id === id); assert.ok(item, `missing palette action ${id}`); await item.run(); };
  await run('step-4'); await run('library'); await run('assistant'); await run('check-exam');
  await run('settings'); await run('diagnostics'); await run('memory'); await run('retry-coverage'); await run('export-json'); await run('toggle-theme'); await run('exam-saved-1');
  assert.deepEqual(calls, ['step:4', 'library', 'assistant:false', 'assistant:true', 'settings:providers', 'settings:diagnostics', 'settings:assistant', 'retry', 'export', 'theme', 'exam:saved-1']);
  assert.equal(items.find(item => item.id === 'step-4')?.title, '4. بازبینی');
  const disabled = buildPaletteItems({
    summaries: [], language: 'en', currentStep: 1, maxReachedStep: 1, hasExam: false, canRetry: false,
    onNavigateStep: () => undefined, onOpenExam: () => undefined, onOpenLibrary: () => undefined,
    onAskAssistant: () => undefined, onOpenSettings: () => undefined, onRetry: () => undefined,
    onExport: () => undefined, onToggleTheme: () => undefined,
  });
  assert.equal(disabled.find(item => item.id === 'assistant')?.disabled, true);
  assert.equal(disabled.find(item => item.id === 'retry-coverage')?.disabled, true);
  assert.equal(disabled.find(item => item.id === 'step-5')?.disabled, true, 'unreached workflow steps cannot route to empty views');
  const reviewOnly = buildPaletteItems({
    summaries: [], language: 'en', currentStep: 4, maxReachedStep: 4, hasExam: true, canRetry: true,
    onNavigateStep: () => undefined, onOpenExam: () => undefined, onOpenLibrary: () => undefined,
    onAskAssistant: () => undefined, onOpenSettings: () => undefined, onRetry: () => undefined,
    onExport: () => undefined, onToggleTheme: () => undefined,
  });
  assert.equal(reviewOnly.find(item => item.id === 'step-4')?.disabled, false);
  assert.equal(reviewOnly.find(item => item.id === 'step-5')?.disabled, true);
  assert.equal(reviewOnly.find(item => item.id === 'export-json')?.disabled, true, 'export must not bypass the review-to-exam workflow transition');
});

test('palette keyboard navigation skips disabled actions and remains bounded at both ends', () => {
  const items = [{ disabled: false }, { disabled: true }, { disabled: false }, { disabled: true }];
  assert.equal(nextEnabledPaletteIndex(items, 0, 1), 2);
  assert.equal(nextEnabledPaletteIndex(items, 2, 1), 2);
  assert.equal(nextEnabledPaletteIndex(items, 2, -1), 0);
  assert.equal(nextEnabledPaletteIndex(items, -1, 1), 0);
  assert.equal(nextEnabledPaletteIndex([{ disabled: false }, { disabled: true }], 1, 1), 0);
  assert.equal(nextEnabledPaletteIndex([{ disabled: true }], -1, 1), -1);
});

test('palette ranks cached exam summaries and common actions under 50ms', () => {
  const items: PaletteItem[] = Array.from({ length: 100 }, (_, index) => ({
    id: `exam-${index}`,
    title: index === 61 ? 'Physics final — Grade 12' : `Saved exam ${index}`,
    keywords: 'subject exam local summary',
    group: 'exams',
    run: () => undefined,
  }));
  items.unshift({ id: 'toggle-theme', title: 'Toggle dark mode', keywords: 'theme appearance', group: 'actions', run: () => undefined });
  const start = performance.now();
  const ranked = rankPaletteItems(items, 'physics final', ['exam-4']);
  const elapsed = performance.now() - start;
  assert.equal(ranked[0].id, 'exam-61');
  assert.ok(elapsed < 50, `cached 101-item fuzzy ranking took ${elapsed.toFixed(2)}ms`);
  assert.equal(rankPaletteItems(items, 'dark theme')[0].id, 'toggle-theme');
});
