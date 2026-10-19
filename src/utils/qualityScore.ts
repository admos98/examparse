import { ExamDoc } from '../types';
import { getExamHealth, enumerateExpectedQuestionNos } from '../pipeline/quality';

export interface QualityBreakdown {
  coverage: number; // 0-30
  points: number; // 0-15
  optionsCleanliness: number; // 0-15
  imagePlacement: number; // 0-15
  numbering: number; // 0-10
  confidence: number; // 0-10
  passage: number; // 0-5
  total: number; // 0-100
  details: {
    coveragePercent: number;
    pointDeficit: number;
    optionBlobCount: number;
    unplacedImages: number;
    duplicateNumbers: number;
    missingNumbers: number;
    lowConfidenceCount: number;
    passageMissing: boolean;
  };
}

function clamp(n:number, min:number, max:number){ return Math.max(min, Math.min(max, n)); }

export function computeQualityScore(doc: ExamDoc): QualityBreakdown {
  const health = getExamHealth(doc);
  const expected = health.expectedCount || 1;
  const coveragePercent = health.coveragePercent;
  // 30 pts for coverage
  const coverageScore = Math.round((coveragePercent / 100) * 30);

  // points 15 pts: 15 if match, 0 if deficit >0
  const pointsScore = health.pointsExpected !== undefined
    ? (health.pointDeficit === 0 ? 15 : Math.max(0, 15 - Math.abs(health.pointDeficit) * 3))
    : (health.pointsParsed > 0 ? 10 : 0);

  // options cleanliness 15 pts: blob = option text found in stem
  let optionBlobCount = 0;
  for (const q of doc.questions || []) {
    if (!q.options || !q.stem) continue;
    for (const opt of q.options) {
      if (opt.text && q.stem.includes(opt.text) && opt.text.length > 4) optionBlobCount++;
    }
  }
  const optionsCleanliness = clamp(15 - optionBlobCount * 3, 0, 15);

  // image placement 15 pts
  const unplaced = health.unplacedImages.length;
  const unresolved = health.unresolvedImageRefs.length;
  const imagePlacement = clamp(15 - unplaced * 3 - unresolved * 3, 0, 15);

  // numbering 10 pts: duplicates + missing
  const numberingPenalty = health.duplicates.length * 3 + health.missing.length * 2;
  const numbering = clamp(10 - numberingPenalty, 0, 10);

  // confidence 10 pts
  const low = health.lowConfidenceCount;
  const totalQ = doc.questions?.length || 1;
  const confidenceRatio = 1 - low / totalQ;
  const confidence = Math.round(confidenceRatio * 10);

  // passage presence 5 pts: if any reading/listening section exists, check passage
  const hasReadingListening = (doc.sections || []).some(s => /reading|listening|درک|شنیداری/i.test(s.title || '') || (s as any).kind?.match(/Reading|Listening/));
  let passage = 5;
  if (hasReadingListening) {
    const anyPassage = (doc.sections || []).some(s => s.passage && s.passage.trim().length > 20);
    passage = anyPassage ? 5 : 0;
  }

  const total = clamp(coverageScore + pointsScore + optionsCleanliness + imagePlacement + numbering + confidence + passage, 0, 100);

  return {
    coverage: coverageScore,
    points: Math.round(pointsScore),
    optionsCleanliness,
    imagePlacement,
    numbering,
    confidence,
    passage,
    total,
    details: {
      coveragePercent,
      pointDeficit: health.pointDeficit,
      optionBlobCount,
      unplacedImages: unplaced,
      duplicateNumbers: health.duplicates.length,
      missingNumbers: health.missing.length,
      lowConfidenceCount: low,
      passageMissing: hasReadingListening && passage === 0,
    },
  };
}

export function qualityColor(score: number): string {
  if (score >= 80) return 'green';
  if (score >= 60) return 'amber';
  return 'red';
}
