import React from 'react';
import { ExamDoc, Question } from '../types';
import { toPersianDigits } from '../utils/numbers';

export type ExamRenderMode = 'paper' | 'answer-key' | 'review';

interface Props {
  doc: ExamDoc;
  mode: ExamRenderMode;
}

export const DeterministicRenderer: React.FC<Props> = ({ doc, mode }) => {
  const isRtl = doc.meta.direction === 'rtl';
  const meta = doc.meta;

  const formatNum = (val: number | string | undefined): string => {
    if (val === undefined) return '';
    return isRtl ? toPersianDigits(val) : String(val);
  };

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className={`bg-white text-slate-900 mx-auto font-sans shadow-lg print:shadow-none print:w-full max-w-[210mm] min-h-[297mm] p-[18mm] space-y-6 ${
        isRtl ? 'font-vazir' : ''
      }`}
      style={{
        boxSizing: 'border-box',
      }}
    >
      {/* Printable Exam Header Block (§9) */}
      <header className="border-2 border-slate-900 rounded-xl p-4 space-y-3 print:border-black">
        {/* Title & School Header */}
        <div className="flex items-center justify-between text-center border-b border-slate-300 pb-3">
          <div className="text-right w-1/4 text-xs space-y-1">
            {meta.school && <div className="font-bold">{meta.school}</div>}
            {meta.grade && <div className="text-slate-600 text-[11px]">{meta.grade}</div>}
          </div>

          <div className="w-2/4 space-y-1">
            <h1 className="text-base font-extrabold tracking-tight">
              {meta.title || 'Official Exam Paper'}
            </h1>
            {meta.subject && (
              <div className="text-xs font-semibold text-slate-700">
                {meta.subject} {meta.term ? `• ${meta.term}` : ''}
              </div>
            )}
          </div>

          <div className="text-left w-1/4 text-xs space-y-1">
            {meta.year && <div>سال تحصیلی / Year: <span className="font-semibold">{formatNum(meta.year)}</span></div>}
            {meta.durationMinutes && (
              <div>
                مدت آزمون: <span className="font-semibold">{formatNum(meta.durationMinutes)}</span> دقیقه
              </div>
            )}
          </div>
        </div>

        {/* Student Details & Points Box */}
        <div className="flex items-center justify-between text-xs pt-1">
          <div className="flex-1 flex gap-6 text-[11px]">
            <span>نام و نام خانوادگی / Name: ................................................</span>
            <span>شماره داوطلب / ID: ..........................</span>
          </div>

          {meta.totalPoints !== undefined && (
            <div className="border border-slate-900 px-3 py-1 rounded font-bold text-xs shrink-0">
              نمره کل: {formatNum(meta.totalPoints)}
            </div>
          )}
        </div>
      </header>

      {/* Sections and Questions */}
      <main className="space-y-6">
        {doc.sections.map((sec, secIdx) => {
          const secQuestions = doc.questions.filter(
            q => q.sectionId === sec.id || (!q.sectionId && secIdx === 0)
          );

          if (secQuestions.length === 0) return null;

          return (
            <section
              key={sec.id}
              className="space-y-4"
              style={{ breakBefore: secIdx > 0 ? 'auto' : 'avoid' }}
            >
              {/* Section Header */}
              {sec.title && (
                <div className="bg-slate-100 dark:bg-slate-100 p-2 rounded-lg border-s-4 border-slate-800 flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                    {sec.title}
                  </h2>
                  {sec.instructions && (
                    <span className="text-[11px] text-slate-600 italic">
                      {sec.instructions}
                    </span>
                  )}
                </div>
              )}

              {/* Questions List */}
              <div className="space-y-4">
                {secQuestions.map(q => (
                  <article
                    key={q.id}
                    className="space-y-2 pb-3 border-b border-slate-200/80 last:border-0"
                    style={{ breakInside: 'avoid' }}
                  >
                    {/* Stem Row with Number & Points Badge */}
                    <div className="flex items-start justify-between gap-3 text-xs leading-relaxed">
                      <div className="flex items-start gap-2">
                        <span className="font-bold text-slate-900 text-sm font-mono shrink-0">
                          {q.label}.
                        </span>
                        <div className="text-slate-900 whitespace-pre-wrap font-medium">
                          {q.stem}
                        </div>
                      </div>

                      {q.points !== undefined && (
                        <span className="text-[11px] font-bold text-slate-700 shrink-0 border border-slate-400 px-2 py-0.5 rounded font-mono">
                          ({formatNum(q.points)} نمره)
                        </span>
                      )}
                    </div>

                    {/* Anchored Images */}
                    {q.images && q.images.length > 0 && (
                      <div className="py-2 text-center">
                        {q.images.map(imgRef => {
                          const asset = doc.images.find(i => i.id === imgRef.imageId);
                          if (!asset || !asset.dataUrl) return null;
                          return (
                            <figure key={imgRef.imageId} className="inline-block mx-auto">
                              <img
                                src={asset.dataUrl}
                                alt={asset.label?.caption || asset.id}
                                className="max-w-[70%] max-h-56 mx-auto rounded border border-slate-300 object-contain"
                              />
                              {asset.label?.caption && (
                                <figcaption className="text-[10px] text-slate-500 mt-1 italic">
                                  {asset.label.caption}
                                </figcaption>
                              )}
                            </figure>
                          );
                        })}
                      </div>
                    )}

                    {/* Options (MCQ) - Compact 2-column or 1-column grid */}
                    {q.options && q.options.length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">
                        {q.options.map(opt => (
                          <div key={opt.key} className="flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full border border-slate-800 font-bold flex items-center justify-center text-[10px] shrink-0 font-mono">
                              {opt.key}
                            </span>
                            <span className="text-slate-900">{opt.text}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Spacing for Handwritten Answers in Paper Mode */}
                    {mode === 'paper' && (q.type === 'short' || q.type === 'long' || q.type === 'essay') && (
                      <div
                        className="border-b border-dotted border-slate-300"
                        style={{ height: q.type === 'essay' ? '80px' : '40px' }}
                      />
                    )}

                    {/* Answer Key Mode Display */}
                    {mode === 'answer-key' && q.answer && (
                      <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs">
                        <span className="font-bold">کلید پاسخ / Answer:</span> {q.answer.text}
                      </div>
                    )}

                    {/* Review Mode: Source Line Anchors & Flags */}
                    {mode === 'review' && (
                      <div className="text-[10px] font-mono text-slate-500 bg-slate-50 p-2 rounded flex items-center justify-between border border-slate-200">
                        <span>Source Lines: {q.spans.map(([s, e]) => `L${s}..L${e}`).join(', ')}</span>
                        <span>Confidence: {(q.confidence * 100).toFixed(0)}%</span>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </main>

      {/* Answer Key Mode: Consolidated Solutions Summary at Bottom */}
      {mode === 'answer-key' && (
        <footer className="pt-6 border-t-2 border-slate-800 space-y-2" style={{ breakBefore: 'always' }}>
          <h2 className="text-sm font-bold text-slate-900">
            کلید جامع پاسخ‌ها / Complete Exam Answer Key
          </h2>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {doc.questions.map(q => (
              <div key={q.id} className="p-1.5 rounded bg-slate-50 border border-slate-200">
                <span className="font-bold font-mono text-slate-800">{q.label}: </span>
                <span className="text-emerald-800 font-medium">
                  {q.answer?.text || 'پاسخ تشریحی درج نشده'}
                </span>
              </div>
            ))}
          </div>
        </footer>
      )}
    </div>
  );
};
