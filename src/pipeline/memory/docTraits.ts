import type { SourceLine, ImageAsset } from '../../types';
import { enumerateExpectedQuestionNos, detectKeyTerritory, detectSectionHeaders } from '../quality';

export function deriveDocTraits(params: {
  sourceLines?: SourceLine[];
  pages?: number;
  images?: ImageAsset[];
  sections?: any[];
  languageHint?: string;
}): import('./types').DocTraits {
  const lines = params.sourceLines || [];
  const pages = params.pages || new Set(lines.map(l=>l.page)).size || 1;
  const expected = enumerateExpectedQuestionNos(lines);
  const keyTerritory = expected.keyTerritory || detectKeyTerritory(lines);
  const headers = detectSectionHeaders(lines);
  // languages detected: simple heuristic
  const sample = lines.slice(0,60).map(l=>l.text).join(' ');
  const langs: string[] = [];
  if (/[ء-ي\u0600-\u06FF]/.test(sample)) {
    if (/شنیداری|بخش|واژگان|درک/.test(sample)) langs.push('fa');
    else if (/ي|ك/.test(sample)) langs.push('ar');
    else langs.push('fa');
  }
  if (/[a-zA-Z]/.test(sample)) langs.push('en');
  if (/Listening|Reading|Vocabulary/i.test(sample)) langs.push('en');
  const cleanLangs = [...new Set(langs)];
  return {
    pages,
    lines: lines.length,
    expectedQs: expected.numbers.length,
    languagesDetected: cleanLangs,
    hasKeyPages: keyTerritory.lineNos.size>0,
    hasImages: params.images?.length || 0,
    sectionCount: params.sections?.length || headers.length || 1,
    rtl: cleanLangs.includes('fa') || cleanLangs.includes('ar'),
    isLong: lines.length>220 || expected.numbers.length>25,
  };
}

export function docTraitsKey(t: import('./types').DocTraits): string {
  // simplified key for matching
  return `${t.languagesDetected.join(',')}|pg${t.pages}|sec${t.sectionCount}|img${t.hasImages>0?'1':'0'}|key${t.hasKeyPages?'1':'0'}`;
}
