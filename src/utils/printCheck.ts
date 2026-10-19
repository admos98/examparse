// D3 Print/PDF fidelity: page breaks never inside question, headers keep-with-next, answer-key starts fresh page, RTL/LTR, images max-height keep-together, header/footer
// Print preview check: reports questions that would split by DOM measurement (no new deps)

export interface PrintRisk { questionId:string, no:number, wouldSplit:boolean, reason?:string }

export function checkPrintLayout(container?: HTMLElement): PrintRisk[] {
  if(!container) return [];
  const risks:PrintRisk[]=[];
  const questions = container.querySelectorAll('.question');
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
  .question { break-inside: avoid; page-break-inside: avoid; }
  .section-header { break-after: avoid; page-break-after: avoid; keep-with-next: always; }
  .answer-key { break-before: page; page-break-before: always; }
  .image { max-height: 200px; break-inside: avoid; }
  @page { margin: 1in; @top-center { content: attr(data-header); } @bottom-center { content: "Page " counter(page) " of " counter(pages); } }
}
`;
