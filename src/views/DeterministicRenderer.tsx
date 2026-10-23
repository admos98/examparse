import React from 'react';
import { ExamDoc, Question, getDisplayName } from '../types';
import { decontaminateOptionMarkup, extractSafeTableRows } from '../pipeline/assemble';
import { formatSpans } from '../pipeline/spans';
import { toPersianDigits } from '../utils/numbers';
import { buildQuestionTree } from '../utils/questionTree';
import { ExamSheet } from '../design/ExamSheet';

export type ExamRenderMode = 'paper' | 'answer-key' | 'review';
interface Props { doc: ExamDoc; mode: ExamRenderMode }

function blockDirection(text: string, fallback: 'ltr' | 'rtl'): 'ltr' | 'rtl' {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const letters = (text.match(/[A-Za-z\p{Script=Arabic}]/gu) || []).length;
  return letters > 0 && latin / letters > 0.7 ? 'ltr' : fallback;
}

const DirectionalText: React.FC<{ text: string; fallback: 'ltr' | 'rtl'; className?: string }> = ({ text, fallback, className }) => {
  const dir = blockDirection(text, fallback);
  const fragments = text.split(/(\d+(?:[.)])?|[A-Za-z][A-Za-z0-9’'_-]*)/g);
  return <span dir={dir} className={className} style={{ unicodeBidi: 'plaintext', whiteSpace: 'pre-wrap' }}>{fragments.map((fragment, index) => /^(?:\d|[A-Za-z])/.test(fragment) ? <span key={index} dir="auto">{fragment}</span> : <React.Fragment key={index}>{fragment}</React.Fragment>)}</span>;
};

function rendererStem(q: Question): string {
  const stem = decontaminateOptionMarkup(q.stem || '');
  return stem.replace(new RegExp(`^\\s*${q.no}\\s*(?:[.)]\\s+|[-–—:：]\\s*)`), '').trim();
}

export const DeterministicRenderer: React.FC<Props> = ({ doc, mode }) => {
  const isRtl = doc.meta.direction === 'rtl';
  const fallbackDir: 'rtl' | 'ltr' = isRtl ? 'rtl' : 'ltr';
  const meta = doc.meta;
  const isPersian = /^fa|^ar/i.test(meta.language || '');
  const t = (en: string, fa: string) => isPersian ? fa : en;
  const formatNum = (value: number | string | undefined) => value === undefined ? '' : isRtl ? toPersianDigits(value) : String(value);
  const usedImages = new Set<string>();
  const renderImages = (refs: Question['images']) => refs?.map(ref => {
    if (usedImages.has(ref.imageId) || ref.role === 'decoration') return null;
    usedImages.add(ref.imageId);
    const asset = doc.images.find(image => image.id === ref.imageId);
    const anchor = ref.anchorLine ?? asset?.anchorLine;
    const line = anchor ? doc.source.lines.find(sourceLine => Number(sourceLine.id.replace(/\D/g, '')) === anchor) : undefined;
    const page = asset?.page ?? line?.page;
    if (!asset || !asset.dataUrl) {
      return <div key={ref.imageId} role="img" aria-label={t(`Missing image ${ref.imageId}`, `تصویر ${ref.imageId} موجود نیست`)} className="ep-image-fallback">
        {t(`Image ${ref.imageId} — open original page ${page ?? 'unknown'}`, `تصویر ${ref.imageId} — صفحه اصلی ${page ?? 'نامشخص'} را باز کنید`)}
      </div>;
    }
    return <figure key={ref.imageId} className="mx-auto my-1 text-center">
      <img loading="lazy" decoding="async" src={asset.dataUrl} alt={asset.label?.caption || asset.id} onError={event => { event.currentTarget.classList.add('hidden'); const fallback = event.currentTarget.nextElementSibling as HTMLElement | null; fallback?.classList.remove('hidden'); }} />
      <div hidden className="ep-image-fallback">{t(`Image ${ref.imageId} could not be loaded — open original page ${page ?? 'unknown'}.`, `بارگذاری تصویر ${ref.imageId} ممکن نشد — صفحه اصلی ${page ?? 'نامشخص'} را باز کنید.`)}</div>
      {asset.label?.caption && <figcaption>{asset.label.caption}</figcaption>}
    </figure>;
  });
  const descendants = (question: Question, children: Map<string, Question[]>, seen = new Set<string>()): Question[] => {
    if (seen.has(question.id)) return [];
    seen.add(question.id);
    const direct = children.get(question.id) || [];
    return [...direct, ...direct.flatMap(child => descendants(child, children, seen))];
  };
  const renderQuestion = (q: Question, children: Map<string, Question[]>, depth = 0, childIndex = 0): React.ReactNode => {
    const nested = children.get(q.id) || [];
    const stem = rendererStem(q);
    const nestedLabel = depth > 0 ? `${String.fromCharCode(97 + (childIndex % 26))})` : `${formatNum(q.label || q.no)}.`;
    if (mode === 'answer-key') {
      return <React.Fragment key={q.id}>
        <div className={`ep-answer ${depth ? 'ep-nested-question' : ''}`} data-answer-item="true">
          <strong className="ep-mono shrink-0">{depth ? nestedLabel : `${formatNum(q.label || q.no)}.`}</strong>
          <DirectionalText text={q.answer?.text || 'پاسخ درج نشده'} fallback={fallbackDir} className="ep-answer-text" />
        </div>
        {nested.map((child, index) => renderQuestion(child, children, depth + 1, index))}
      </React.Fragment>;
    }
    // Group images (including duplicate child references) render once beneath the parent only.
    const groupRefs = depth === 0 ? [q, ...descendants(q, children)].flatMap(item => item.images || []) : [];
    const groupImages = depth === 0 ? renderImages([...new Map(groupRefs.map(ref => [ref.imageId, ref])).values()]) : null;
    return <article key={q.id} data-qid={q.id} data-no={String(q.no)} className={`ep-question ${depth ? 'ep-nested-question' : ''}`}>
      <div className="ep-question-row">
        <div className="ep-question-body">
          <span className="ep-question-number">{nestedLabel}</span>
          <div className="ep-question-stem"><DirectionalText text={stem} fallback={fallbackDir} /></div>
        </div>
        {q.points !== undefined && <span className="ep-marginalia">({formatNum(q.points)} {t('points', 'نمره')})</span>}
      </div>
      {groupImages && groupImages.some(Boolean) && <div className="py-1 text-center">{groupImages}</div>}
      {q.tables?.length ? <div className="py-2 overflow-x-auto">{q.tables.map((table, index) => {
        const rows = (table as any).rows || extractSafeTableRows(table.html || '');
        return <table key={index} className="ep-exam-table"><tbody>{rows.map((row: string[], rowIndex: number) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><DirectionalText text={cell} fallback={fallbackDir} /></td>)}</tr>)}</tbody></table>;
      })}</div> : null}
      {q.options?.length ? <div className="ep-options">{q.options.map(option => <div key={option.key} className="ep-option">
        <span className="ep-option-key">{option.key}</span>
        <DirectionalText text={option.text || ''} fallback={fallbackDir} />
      </div>)}</div> : null}
      {mode === 'paper' && ['short', 'long', 'essay'].includes(q.type) && <div className="ep-writing-lines" style={{ height: q.type === 'essay' ? '80px' : '40px' }} />}
      {mode === 'review' && <div className="ep-review-note"><span>{t('Source lines', 'خطوط منبع')}: {formatSpans(q.spans)}</span><span>{t('Confidence', 'اطمینان')}: {(q.confidence * 100).toFixed(0)}%</span></div>}
      {nested.map((child, index) => renderQuestion(child, children, depth + 1, index))}
    </article>;
  };

  return <ExamSheet dir={isRtl ? 'rtl' : 'ltr'} lang={meta.language} className={mode === 'answer-key' ? 'answer-key' : ''}>
    <header className="ep-sheet-header">
      <div className="ep-sheet-meta">
        <div className="ep-sheet-meta-side" dir={fallbackDir}>
          {meta.school && <div><strong>{meta.school}</strong></div>}
          {meta.grade && <div className="ep-muted">{meta.grade}</div>}
        </div>
        <div>
          <h1 className="ep-sheet-title">{meta.title || getDisplayName(doc)}</h1>
          {meta.subject && <div className="ep-muted text-[length:var(--type-12)]">{meta.subject}{meta.term ? ` · ${meta.term}` : ''}</div>}
        </div>
        <div className="ep-sheet-meta-side" dir={fallbackDir}>
          {meta.year && <div>{t('Academic year', 'سال تحصیلی')}: <strong>{formatNum(meta.year)}</strong></div>}
          {meta.durationMinutes && <div>{t('Duration', 'مدت آزمون')}: <strong>{formatNum(meta.durationMinutes)}</strong> {t('minutes', 'دقیقه')}</div>}
        </div>
      </div>
      {meta.totalPoints !== undefined && <table className="ep-sheet-grid" data-sheet-header-grid="true" aria-label={t('Exam score summary', 'خلاصه نمره آزمون')}>
        <thead><tr><th>{t('Row', 'ردیف')}</th><th>{t('Questions', 'سؤالات')}</th><th>{t('Score', 'نمره')}</th></tr></thead>
        <tbody><tr><td>{t('Total', 'کل')}</td><td>{meta.title || meta.subject || getDisplayName(doc)}</td><td>{formatNum(meta.totalPoints)}</td></tr></tbody>
      </table>}
      <div className="ep-student-line">
        <span>{t('Name', 'نام و نام خانوادگی')}: ................................................</span>
        <span>{t('Candidate ID', 'شماره داوطلب')}: ..........................</span>
        {meta.totalPoints !== undefined && <strong>{t('Total score', 'نمره کل')}: {formatNum(meta.totalPoints)}</strong>}
      </div>
    </header>

    <div className="ep-sheet-content">
      {doc.sections.map((section, sectionIndex) => {
        const sectionQuestions = doc.questions.filter(q => q.sectionId === section.id || (!q.sectionId && sectionIndex === 0));
        const tree = buildQuestionTree(sectionQuestions);
        if (tree.roots.length === 0 && !section.passage) return null;
        const questionCount = sectionQuestions.length;
        return <section key={section.id} className="ep-section" data-sheet-section="true">
          <div className="ep-section-heading" data-sheet-section-head="true">
            <span className="ep-section-number">{formatNum(section.index)}</span>
            <h2 className="ep-section-title">{section.title || t(`Section ${section.index}`, `بخش ${formatNum(section.index)}`)}</h2>
            <span className="ep-section-meta">{section.points !== undefined ? `${formatNum(section.points)} ${t('pts', 'نمره')} · ` : ''}{questionCount} {t('questions', 'سؤال')}</span>
          </div>
          {section.instructions && <DirectionalText text={section.instructions} fallback={fallbackDir} className="block ep-muted italic text-[length:var(--type-13)]" />}
          {mode !== 'answer-key' && section.passage && <div dir={blockDirection(section.passage, fallbackDir)} className="ep-passage" data-sheet-passage="true"><DirectionalText text={section.passage} fallback={fallbackDir} /></div>}
          <div>{tree.roots.map(question => renderQuestion(question, tree.children))}</div>
        </section>;
      })}
    </div>
  </ExamSheet>;
};
