// D3 Print/PDF fidelity: page breaks never inside question, headers keep-with-next, answer-key starts fresh page, RTL/LTR, images max-height keep-together, header/footer
// Print preview check: reports questions that would split by DOM measurement (no new deps)

export interface PrintRisk { questionId:string, no:number, wouldSplit:boolean, reason?:string }

export function checkPrintLayout(container?: HTMLElement): PrintRisk[] {
  if(!container) return [];
  const risks:PrintRisk[]=[];
  // DeterministicRenderer marks questions as <article> with break-inside avoid; also accept .question if present
  const questions = container.querySelectorAll('article, .question');
  for(const el of Array.from(questions) as HTMLElement[]){
    const rect = el.getBoundingClientRect();
    // If element crosses page boundary (approx 1050px per A4), it would split
    const pageHeight = 1050; // px approx
    const topPage = Math.floor(rect.top / pageHeight);
    const bottomPage = Math.floor(rect.bottom / pageHeight);
    if(topPage !== bottomPage){
      risks.push({ questionId: el.dataset.qid||'', no: parseInt(el.dataset.no||'0'), wouldSplit:true, reason:'Question crosses page break' });
    }
  }
  return risks;
}

export const printStyles = `
@media print {
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .question, article { break-inside: avoid; page-break-inside: avoid; }
  .section-header, header, section > div:first-child { break-after: avoid; page-break-after: avoid; break-inside: avoid; }
  .answer-key { break-before: page; page-break-before: always; }
  figure, img { break-inside: avoid; page-break-inside: avoid; }
  table { break-inside: avoid; }
  @page { size: A4; margin: 12mm 14mm; }
  .print\\:hidden { display: none !important; }
}
`;
