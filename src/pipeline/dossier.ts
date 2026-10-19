import { ExamDoc } from '../types';
import { getExamHealth, lineNumber, detectSectionHeaders } from './quality';
import { PARSER_VERSION } from './prompts';

export interface DossierQuestionIndex { no: number; label: string; sectionId?: string; type: string; points?: number; spanRange: [number, number] | null; hasImages: boolean; answerPresent: boolean; confidence: number; }
export interface DossierImageIndex { id: string; page: number; anchorLine?: number; assignedTo?: string; role?: string; suspectStrip: boolean; }
export interface DossierSectionMap { id: string; title: string; kind?: string; lineRange: [number, number]; questionNos: number[]; points?: number; }
export interface DossierLedgerEntry { ts: string; turnId: string; tool: string; argsSummary: string; outcome: { added?: number; removed?: number; changed?: number; error?: string; addedCount?: number; stillMissing?: number[] }; healthBefore?: any; healthAfter?: any; modelCallsUsed: number; }
export interface Dossier {
  identity: { id: string; fileHash: string; title: string; subject?: string; grade?: string; createdAt: string; parserVersion: string };
  structureMap: DossierSectionMap[];
  questionIndex: DossierQuestionIndex[];
  imageIndex: DossierImageIndex[];
  healthSnapshot: any;
  knownIssues: Record<string, { count: number; questionRefs: string[] }>;
  ledger: DossierLedgerEntry[];
  userNotes: string[];
  task?: any;
  updatedAt: string;
  fileHash: string;
  qualityScore?: any;
}

export function buildDossier(doc: ExamDoc, existing?: Dossier): Dossier {
  const health = getExamHealth(doc);
  // Structure map
  const structureMap: DossierSectionMap[] = (doc.sections || []).map(sec => {
    const start = sec.spans?.length ? Math.min(...sec.spans.map(s=>s[0])) : 0;
    const end = sec.spans?.length ? Math.max(...sec.spans.map(s=>s[1])) : 0;
    const qNos = doc.questions.filter(q=>q.sectionId===sec.id).map(q=>q.no).sort((a,b)=>a-b);
    const points = doc.questions.filter(q=>q.sectionId===sec.id).reduce((s,q)=>s+(q.points||0),0) || sec.points;
    return { id: sec.id, title: sec.title || `Section ${sec.index}`, kind: (sec as any).kind, lineRange: [start,end] as [number,number], questionNos: qNos, points };
  });
  // Question index
  const questionIndex: DossierQuestionIndex[] = doc.questions.map(q=>{
    const spanRange = q.spans?.length ? [Math.min(...q.spans.map(s=>s[0])), Math.max(...q.spans.map(s=>s[1]))] as [number,number] : null;
    return { no: q.no, label: q.label, sectionId: q.sectionId, type: q.type, points: q.points, spanRange, hasImages: (q.images||[]).length>0, answerPresent: !!q.answer, confidence: q.confidence };
  }).sort((a,b)=>a.no-b.no);
  // Image index
  const imageIndex: DossierImageIndex[] = (doc.images||[]).map(img=>{
    const assignedTo = doc.questions.find(q=> q.images.some(r=>r.imageId===img.id))?.label || img.label?.questionRef;
    return { id: img.id, page: img.page, anchorLine: img.anchorLine, assignedTo, role: img.label?.role, suspectStrip: !!(img.imageFlags?.includes('IMAGE_SUSPECT_STRIP')) };
  });
  // Known issues grouped
  const knownIssues: Record<string, {count:number; questionRefs:string[]}> = {};
  for (const flag of doc.flags||[]) {
    const entry = knownIssues[flag.code] || { count:0, questionRefs: [] };
    entry.count++;
    if (flag.questionId) entry.questionRefs.push(flag.questionId);
    knownIssues[flag.code]=entry;
  }
  const ledger = existing?.ledger ? [...existing.ledger].slice(-100) : [];
  const userNotes = existing?.userNotes ? [...existing.userNotes] : (doc as any).userFacts ? [...(doc as any).userFacts] : [];
  // Also pull from doc.flags that are user facts? For now use existing
  // Quality score stored in dossier for Library sort/filter (local only, not gate)
  let qualityScore: any = undefined;
  try{
    const coverageScore = Math.round((health.coveragePercent/100)*30);
    const pointsScore = health.pointsExpected!==undefined ? (health.pointDeficit===0?15:Math.max(0,15-Math.abs(health.pointDeficit)*3)) : (health.pointsParsed>0?10:0);
    let optionBlobCount=0;
    for(const q of doc.questions||[]){ if(q.options&&q.stem) for(const opt of q.options) if(opt.text&&q.stem.includes(opt.text)&&opt.text.length>4) optionBlobCount++; }
    const optionsCleanliness = Math.max(0,15-optionBlobCount*3);
    const imagePlacement = Math.max(0,15 - health.unplacedImages.length*3 - health.unresolvedImageRefs.length*3);
    const numbering = Math.max(0,10 - health.duplicates.length*3 - health.missing.length*2);
    const confidence = Math.round((1 - health.lowConfidenceCount/(doc.questions?.length||1))*10);
    const hasReadingListening = (doc.sections||[]).some(s=>/reading|listening|درک|شنیداری/i.test(s.title||''));
    const passage = hasReadingListening ? ((doc.sections||[]).some(s=>s.passage && s.passage.trim().length>20) ?5:0) :5;
    const total = Math.max(0,Math.min(100, coverageScore+Math.round(pointsScore)+optionsCleanliness+imagePlacement+numbering+confidence+passage));
    qualityScore = { total, coverage:coverageScore, points:Math.round(pointsScore), optionsCleanliness, imagePlacement, numbering, confidence, passage };
  }catch{}
  const dossier: Dossier = {
    identity: { id: doc.id, fileHash: doc.fileHash, title: doc.displayName, subject: doc.meta.subject, grade: doc.meta.grade, createdAt: doc.createdAt, parserVersion: PARSER_VERSION },
    structureMap,
    questionIndex,
    imageIndex,
    healthSnapshot: { expected: health.expectedCount, parsed: health.parsedCount, missing: health.missing, duplicates: health.duplicates, pointsParsed: health.pointsParsed, pointsExpected: health.pointsExpected, pointDeficit: health.pointDeficit, coveragePercent: health.coveragePercent, state: health.state, complete: health.complete, lowConfidence: health.lowConfidenceCount, unplacedImages: health.unplacedImages.length, parentLinkIssues: health.parentLinkIssueCount },
    knownIssues,
    ledger,
    userNotes,
    task: existing?.task,
    updatedAt: new Date().toISOString(),
    fileHash: doc.fileHash,
    qualityScore,
  };
  return dossier;
}

export function dossierSizeBytes(dossier: Dossier): number {
  return new TextEncoder().encode(JSON.stringify(dossier)).length;
}

export function isDossierStale(dossier: Dossier, doc: ExamDoc): boolean {
  return dossier.fileHash !== doc.fileHash || dossier.identity.id !== doc.id;
}

// Build dossier digest for state pack (≤ ~400 tokens)
export function dossierDigest(dossier: Dossier): string {
  const digest = {
    id: dossier.identity.id.slice(0,40),
    title: dossier.identity.title.slice(0,60),
    health: dossier.healthSnapshot,
    sections: dossier.structureMap.map(s=>({id:s.id, title:s.title, count: s.questionNos.length})),
    missing: dossier.healthSnapshot.missing?.slice(0,15),
    issues: Object.keys(dossier.knownIssues).slice(0,6),
    notes: dossier.userNotes.slice(-3).map(n=>n.slice(0,80)),
    ledger: dossier.ledger.slice(-5).map(e=>({tool:e.tool, outcome:e.outcome, healthAfter:e.healthAfter?.missing?.length})),
  };
  return JSON.stringify(digest);
}

export function addLedgerEntry(dossier: Dossier, entry: DossierLedgerEntry): Dossier {
  const ledger = [...(dossier.ledger||[]), entry].slice(-100);
  return { ...dossier, ledger, updatedAt: new Date().toISOString() };
}
