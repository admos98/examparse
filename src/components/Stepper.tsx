import React from 'react';
import { Upload, FileCode2, PlayCircle, Edit3, Printer, CheckCircle2 } from 'lucide-react';

export type StepNumber = 1 | 2 | 3 | 4 | 5;

interface Props {
  currentStep: StepNumber;
  maxReachedStep: StepNumber;
  onSelectStep: (step: StepNumber) => void;
}

const STEPS: { step: StepNumber; title: string; subtitle: string; icon: any }[] = [
  { step: 1, title: 'Import', subtitle: 'PDF, DOCX, Images', icon: Upload },
  { step: 2, title: 'Source', subtitle: 'Line IDs & Gutter', icon: FileCode2 },
  { step: 3, title: 'Analyze', subtitle: 'Token-Thrift Run', icon: PlayCircle },
  { step: 4, title: 'Review', subtitle: 'Questions & Patches', icon: Edit3 },
  { step: 5, title: 'Exam View', subtitle: 'A4 & Export', icon: Printer },
];

export const Stepper: React.FC<Props> = ({ currentStep, maxReachedStep, onSelectStep }) => {
  return (
    <nav className="w-full bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800 px-4 py-2.5">
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        {STEPS.map((s, idx) => {
          const Icon = s.icon;
          const isActive = currentStep === s.step;
          const isCompleted = maxReachedStep >= s.step && currentStep !== s.step;
          const isAccessible = maxReachedStep >= s.step;

          return (
            <React.Fragment key={s.step}>
              <button
                disabled={!isAccessible}
                onClick={() => onSelectStep(s.step)}
                className={`flex items-center gap-2 sm:gap-3 py-1.5 px-2.5 sm:px-3 rounded-xl transition text-left cursor-pointer ${
                  isActive
                    ? 'bg-white dark:bg-slate-800 shadow-xs border border-slate-200 dark:border-slate-700'
                    : isAccessible
                    ? 'hover:bg-slate-200/60 dark:hover:bg-slate-800/60 opacity-90'
                    : 'opacity-40 cursor-not-allowed'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs transition ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : isCompleted
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                  }`}
                >
                  {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : <Icon className="w-3.5 h-3.5" />}
                </div>

                <div className="hidden md:block">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-xs font-semibold ${
                        isActive
                          ? 'text-blue-600 dark:text-blue-400'
                          : isCompleted
                          ? 'text-slate-800 dark:text-slate-200'
                          : 'text-slate-500'
                      }`}
                    >
                      {s.step}. {s.title}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 leading-none mt-0.5">{s.subtitle}</p>
                </div>
              </button>

              {idx < STEPS.length - 1 && (
                <div className="w-4 sm:w-8 h-[2px] bg-slate-200 dark:bg-slate-800 hidden sm:block" />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </nav>
  );
};
