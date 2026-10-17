/**
 * External Answer Key File Parser & Matcher (§3 Step 1 & §6)
 * Matches attached answer key lines to questions by question number or label.
 */
import { Question } from '../types';
import { getOrExtractDocument } from './extractCache';
import { normalizeDigitsToAscii } from '../utils/numbers';

export interface KeyFileMatchResult {
  updatedQuestions: Question[];
  matchedCount: number;
}

export async function mergeAnswerKeyFile(
  keyFile: File,
  questions: Question[]
): Promise<KeyFileMatchResult> {
  const { extracted } = await getOrExtractDocument(keyFile);
  const textLines = extracted.lines.map(l => l.text);

  // Match question numbers from lines
  // e.g. "1. B", "1- Option A", "سؤال ۱: گزینه ب", "(1) c"
  const answerMap = new Map<number, string>();

  for (const line of textLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const norm = normalizeDigitsToAscii(trimmed);

    // Look for lines starting with question number e.g. "1. B", "1) False", "Q1: A"
    const match = norm.match(/^(?:(?:[Qq]uestion|[Qq]|[Ss]ؤال|سوال|Ans|Answer)\s*)?\(?(\d{1,3})\)?[\.\-\:\)]\s*(.+)$/i);
    if (match) {
      const qNum = parseInt(match[1], 10);
      const ansText = match[2].trim();
      answerMap.set(qNum, ansText);
    } else {
      // Check simple "1 B" or "1: B"
      const matchSimple = norm.match(/^(\d{1,3})\s*[:\-\s]\s*([A-Za-z0-9\u0600-\u06FF].+)$/);
      if (matchSimple) {
        const qNum = parseInt(matchSimple[1], 10);
        const ansText = matchSimple[2].trim();
        answerMap.set(qNum, ansText);
      }
    }
  }

  let matchedCount = 0;
  const updatedQuestions = questions.map(q => {
    const matchedText = answerMap.get(q.no);

    // Key-file answers must NOT overwrite an existing in-paper answer.
    if (matchedText && q.answer?.source !== 'paper') {
      matchedCount++;
      return {
        ...q,
        answer: {
          text: matchedText,
          source: 'keyfile' as const,
        },
      };
    }
    return q;
  });

  return {
    updatedQuestions,
    matchedCount,
  };
}
