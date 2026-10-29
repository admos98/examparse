import React from 'react';
import { seenMark, type LoopMapReceipt, type MapStatus } from '../pipeline/mapFirst';

const label = (status: MapStatus) => status === 'counted' ? 'counted ✓' : status === 'audited' ? 'audited ✓' : status === 'uncertain' ? 'uncertain' : 'disputed';
/** #51 Part A: visual confirmation marker. Shown only when a visual audit ran; otherwise nothing changes. */
const Seen: React.FC<{ map: LoopMapReceipt; id: string }> = ({ map, id }) => {
  if (!map.visualAudit) return null;
  const mark = seenMark(map, id);
  const text = mark === 'pass' ? 'seen ✓' : mark === 'uncertain' ? 'seen ?' : mark === 'catch' ? 'seen ✗' : 'text only';
  return <span data-seen={mark || 'text-only'} className={mark === 'catch' ? 'text-[var(--danger)]' : mark === 'pass' ? 'text-[var(--ok)]' : 'text-[var(--ink-2)]'}> · {text}</span>;
};
/** Shared by live Step 3 and the persisted receipt. Never hides map disagreements. */
export const MapOutline: React.FC<{ map: LoopMapReceipt }> = ({ map }) => <div data-testid="map-outline" className="rounded-[6px] border border-[var(--rule)] bg-[var(--paper)] p-3 text-xs space-y-2">
  <div><strong>Exam map</strong> <span className="text-[var(--ink-2)]">{map.phase === 'parse' ? `· Parse: section ${map.parsedSections}/${map.totalSections}${map.currentSection ? ` · ${map.currentSection}` : ''}` : `· ${map.phase}`}</span></div>
  <ul className="space-y-1">{map.sections.map((s,i) => <li key={`s${i}`}><strong>{s.title}</strong> · Q{s.firstQuestion}–{s.lastQuestion} · {s.questionCount} expected · {s.kind} · {label(s.status)}<Seen map={map} id={`section:${i}`} /></li>)}</ul>
  {map.instructionGroups.length > 0 && <div><strong>Instructions</strong><ul>{map.instructionGroups.map((g,i)=><li key={`g${i}`}>Q{g.appliesToFirst}–{g.appliesToLast} · {g.text} · {label(g.status)}</li>)}</ul></div>}
  {map.passages.length > 0 && <div><strong>Passages</strong><ul>{map.passages.map((p,i)=><li key={`p${i}`}>{p.id} · {p.sectionTitle} · Q{p.appliesToFirst}–{p.appliesToLast} · {p.text.slice(0,100)}{p.text.length > 100 ? '…' : ''} · {label(p.status)}<Seen map={map} id={`passage:${i}`} /></li>)}</ul></div>}
  {map.images.length > 0 && <div><strong>Images</strong><ul>{map.images.map((image,i)=><li key={`i${i}`}>{image.imageId} · {image.sectionTitle}{image.aboutQuestion ? ` · Q${image.aboutQuestion}` : ''} · {label(image.status)}<Seen map={map} id={`image:${i}`} /></li>)}</ul></div>}
  {map.auditCalls > 0 && <div>Map audit: {map.auditCalls} decision calls · {map.auditVotes.length} votes · {map.auditErrors} endpoint errors · {map.agreement.agree} agree · {map.agreement.disagree} disagree · {map.agreement.uncertain} uncertain{map.visualAudit ? ` · visual: ${map.visualAudit.voted}/${map.visualAudit.items} page-image votes, ${map.visualAudit.skipped} skipped` : ''}</div>}
  {map.answerKey && <div>Answer key: {map.answerKey.present ? `present${map.answerKey.firstQuestion ? ` · Q${map.answerKey.firstQuestion}–${map.answerKey.lastQuestion ?? '?'}` : ''}` : 'not found'}</div>}
  {map.codeVerdicts.length > 0 && <div><strong>Map findings</strong><ul>{map.codeVerdicts.map(v=><li key={v.id}>{v.message}</li>)}</ul></div>}
  {(map.sectionFindings || []).map(v=><p key={v.id}>{v.message}</p>)}
  {map.remaps.length > 0 && <div><strong>Re-maps</strong><ul>{map.remaps.map((r,i)=><li key={i}>{r.entryId} · {r.applied ? 'applied' : 'disputed; original retained'} · {r.reason}</li>)}</ul></div>}
  {map.notes.map((n,i)=><p key={i}>{n}</p>)}
</div>;
