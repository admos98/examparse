import React from 'react';
import { ExamDoc, Question, getDisplayName } from '../types';
import { decontaminateOptionMarkup, extractSafeTableRows } from '../pipeline/assemble';
import { toPersianDigits } from '../utils/numbers';
import { buildQuestionTree } from '../utils/questionTree';

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
      return <div key={ref.imageId} role="img" aria-label={`Missing image ${ref.imageId}`} className="mx-auto my-2 max-w-xl rounded-lg border-2 border-dashed border-amber-500 bg-amber-50 p-4 text-left text-xs text-amber-900 print:border-black">
        🖼 image {ref.imageId} — open the original page {page ?? 'unknown'}
      </div>;
    }
    return <figure key={ref.imageId} className="inline-block mx-auto my-1 text-center">
      <img src={asset.dataUrl} alt={asset.label?.caption || asset.id} onError={event => { event.currentTarget.classList.add('hidden'); const fallback = event.currentTarget.nextElementSibling as HTMLElement | null; fallback?.classList.remove('hidden'); }} className="max-w-[70%] max-h-56 mx-auto rounded border border-slate-300 object-contain" />
      <div hidden className="rounded-lg border-2 border-dashed border-amber-500 bg-amber-50 p-3 text-left text-xs text-amber-900">Image {ref.imageId} could not be loaded — open original page {page ?? 'unknown'}.</div>
      {asset.label?.caption && <figcaption className="text-[10px] text-slate-500 mt-1 italic">{asset.label.caption}</figcaption>}
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
        <div className={`${depth ? 'ml-5 text-[11px]' : ''} flex gap-2 py-1 border-b border-slate-100`}>
          <strong className="font-mono shrink-0">{depth ? nestedLabel : `${formatNum(q.label || q.no)}.`}</strong>
          <DirectionalText text={q.answer?.text || 'پاسخ درج نشده'} fallback={fallbackDir} />
        </div>
        {nested.map((child, index) => renderQuestion(child, children, depth + 1, index))}
      </React.Fragment>;
    }
    // Group images (including duplicate child references) render once beneath the parent only.
    const groupRefs = depth === 0 ? [q, ...descendants(q, children)].flatMap(item => item.images || []) : [];
    const groupImages = depth === 0 ? renderImages([...new Map(groupRefs.map(ref => [ref.imageId, ref])).values()]) : null;
    return <article key={q.id} className={`space-y-2 pb-3 border-b border-slate-200/80 last:border-0 ${depth ? 'ml-6 pl-3 border-l-2 border-slate-300 text-[0.92em]' : ''}`} style={{ breakInside: 'avoid' }}>
      <div className="flex items-start justify-between gap-3 text-xs leading-relaxed">
        <div className="flex items-start gap-2">
          <span className="font-bold text-slate-900 text-sm font-mono shrink-0">{nestedLabel}</span>
          <div className="text-slate-900 whitespace-pre-wrap font-medium"><DirectionalText text={stem} fallback={fallbackDir} /></div>
        </div>
        {q.points !== undefined && <span className="text-[11px] font-bold text-slate-700 shrink-0 border border-slate-400 px-2 py-0.5 rounded font-mono">({formatNum(q.points)} نمره)</span>}
      </div>
      {groupImages && groupImages.some(Boolean) && <div className="py-1 text-center">{groupImages}</div>}
      {q.tables?.length ? <div className="py-2 overflow-x-auto space-y-2">{q.tables.map((table, index) => {
        const rows = (table as any).rows || extractSafeTableRows(table.html || '');
        return <table key={index} className="border-collapse w-full text-xs"><tbody>{rows.map((row: string[], rowIndex: number) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border border-slate-400 px-2 py-1"><DirectionalText text={cell} fallback={fallbackDir} /></td>)}</tr>)}</tbody></table>;
      })}</div> : null}
      {q.options?.length ? <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">{q.options.map(option => <div key={option.key} className="flex items-start gap-1.5">
        <span className="w-5 h-5 rounded-full border border-slate-800 font-bold flex items-center justify-center text-[10px] shrink-0 font-mono">{option.key}</span>
        <DirectionalText text={option.text || ''} fallback={fallbackDir} className="text-slate-900" />
      </div>)}</div> : null}
      {mode === 'paper' && ['short', 'long', 'essay'].includes(q.type) && <div className="border-b border-dotted border-slate-300" style={{ height: q.type === 'essay' ? '80px' : '40px' }} />}
      {mode === 'review' && <div className="text-[10px] font-mono text-slate-500 bg-slate-50 p-2 rounded flex items-center justify-between border border-slate-200"><span>Source Lines: {q.spans.map(([start, end]) => `L${start}..L${end}`).join(', ')}</span><span>Confidence: {(q.confidence * 100).toFixed(0)}%</span></div>}
      {nested.map((child, index) => renderQuestion(child, children, depth + 1, index))}
    </article>;
  };

  return <div dir={isRtl ? 'rtl' : 'ltr'} className={`bg-white text-slate-900 mx-auto font-sans shadow-lg print:shadow-none print:w-full max-w-[210mm] min-h-[297mm] p-[18mm] space-y-6 ${isRtl ? 'font-vazir' : ''}`} style={{ boxSizing: 'border-box' }}>
    <header className="border-2 border-slate-900 rounded-xl p-4 space-y-3 print:border-black">
      <div className="flex items-center justify-between text-center border-b border-slate-300 pb-3">
        <div className="text-right w-1/4 text-xs space-y-1">{meta.school && <div className="font-bold">{meta.school}</div>}{meta.grade && <div className="text-slate-600 text-[11px]">{meta.grade}</div>}</div>
        <div className="w-2/4 space-y-1"><h1 className="text-base font-extrabold tracking-tight">{meta.title || getDisplayName(doc)}</h1>{meta.subject && <div className="text-xs font-semibold text-slate-700">{meta.subject} {meta.term ? `• ${meta.term}` : ''}</div>}</div>
        <div className="text-left w-1/4 text-xs space-y-1">{meta.year && <div>سال تحصیلی / Year: <span className="font-semibold">{formatNum(meta.year)}</span></div>}{meta.durationMinutes && <div>مدت آزمون: <span className="font-semibold">{formatNum(meta.durationMinutes)}</span> دقیقه</div>}</div>
      </div>
      <div className="flex items-center justify-between text-xs pt-1"><div className="flex-1 flex gap-6 text-[11px]"><span>نام و نام خانوادگی / Name: ................................................</span><span>شماره داوطلب / ID: ..........................</span></div>{meta.totalPoints !== undefined && <div className="border border-slate-900 px-3 py-1 rounded font-bold text-xs shrink-0">نمره کل: {formatNum(meta.totalPoints)}</div>}</div>
    </header>

    <main className="space-y-6">
      {doc.sections.map((section, sectionIndex) => {
        const sectionQuestions = doc.questions.filter(q => q.sectionId === section.id || (!q.sectionId && sectionIndex === 0));
        const tree = buildQuestionTree(sectionQuestions);
        if (tree.roots.length === 0 && !section.passage) return null;
        const questionCount = sectionQuestions.length;
        return <section key={section.id} className="space-y-4" style={{ breakBefore: sectionIndex > 0 ? 'auto' : 'avoid' }}>
          <div className="bg-slate-100 p-2 rounded-lg border-s-4 border-slate-800 space-y-1">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-900">{formatNum(section.index)} · {section.title || `Section ${section.index}`}</h2>
              <span className="text-[10px] font-mono text-slate-600">{section.points !== undefined ? `${formatNum(section.points)} pts · ` : ''}${questionCount} question(s)</span>
            </div>
            {section.instructions && <DirectionalText text={section.instructions} fallback={fallbackDir} className="block text-[11px] text-slate-600 italic" />}
          </div>
          {mode !== 'answer-key' && section.passage && <div dir={blockDirection(section.passage, fallbackDir)} className="border border-slate-300 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed whitespace-pre-wrap"><DirectionalText text={section.passage} fallback={fallbackDir} /></div>}
          <div className="space-y-4">{tree.roots.map(question => renderQuestion(question, tree.children))}</div>
        </section>;
      })}
    </main>
  </div>;
};
