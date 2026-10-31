/**
 * Follow-up #58 Part C — one addressed image bundle per question, never one call per image.
 *
 * The local decision endpoint has a real image limit (the Lightning endpoint accepts up to four
 * images per request). ExamParse sends the WHOLE bundle or nothing: it never silently splits into
 * per-image calls, sends to a cloud model, or guesses a picture from a caption. When the bundle
 * cannot be addressed, the affected visual checks stay unjudged with one honest explanation.
 */
import type { AppSettings, ExamDoc, Question } from '../types';
import { getReviewImageBlob } from '../store';
import { isPackageListeningQuestion } from './packageListening';

export interface ImageBundle {
  /** Base64 payloads (no data prefix), in question order. */
  payloads: Array<{ id: string; mime: string; data: string }>;
  /** Image ids whose pixels were unavailable. */
  missing: string[];
  /** Images the question owns that must be visible to judge it. */
  required: number;
  limit: number;
  /** True only when every required image is present AND the whole bundle fits the endpoint. */
  complete: boolean;
  /** Concise teacher-facing reason when `complete` is false. */
  reason?: string;
}

/** Configured per-request image limit for the local judge (defaults to the Lightning limit: 4). */
export function decisionImageLimit(settings: AppSettings): number {
  const configured = settings.thrift?.maxImagesPerDecisionCall;
  return Number.isFinite(configured) && configured! > 0 ? Math.floor(configured!) : 4;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/**
 * Load the addressed bundle for one question.
 * @param overrides optional preloaded bytes (tests / callers that already hold the pixels)
 */
export async function loadImageBundle(
  doc: ExamDoc,
  q: Question,
  limit: number,
  loadBlob: (blobKey: string) => Promise<Blob | undefined> = getReviewImageBlob,
): Promise<ImageBundle> {
  const payloads: ImageBundle['payloads'] = [];
  const missing: string[] = [];
  for (const ref of q.images || []) {
    const image = (doc.images || []).find(candidate => candidate.id === ref.imageId);
    if (!image) { missing.push(ref.imageId); continue; }
    try {
      let data = image.dataUrl?.startsWith('data:') ? image.dataUrl.split(',')[1] : undefined;
      if (!data) {
        const blob = await loadBlob(image.blobKey);
        if (blob) data = toBase64(new Uint8Array(await blob.arrayBuffer()));
      }
      if (data) payloads.push({ id: image.id, mime: image.mime, data });
      else missing.push(image.id);
    } catch { missing.push(image.id); }
  }
  const required = (q.images || []).length;
  const overLimit = payloads.length > limit;
  const complete = required > 0 && missing.length === 0 && !overLimit;
  return {
    payloads, missing, required, limit, complete,
    ...(complete ? {} : {
      reason: missing.length
        ? `the picture${missing.length > 1 ? 's' : ''} attached to this question ${missing.length > 1 ? 'are' : 'is'} unavailable, so visual checks are not judged`
        : overLimit
          ? `this question's ${payloads.length} pictures exceed the local endpoint's ${limit}-image limit, so visual checks are not judged (nothing was split or sent elsewhere)`
          : required === 0 ? undefined : `visual evidence could not be addressed, so visual checks are not judged`,
    }),
  };
}

/** Does this question's task depend on listening evidence at all? */
export function listeningEvidence(doc: ExamDoc, q: Question): { listening: boolean; script?: string } {
  const section = (doc.sections || []).find(candidate => candidate.id === q.sectionId);
  const listening = isPackageListeningQuestion(q, section?.title);
  if (!listening) return { listening: false };
  const script = typeof q.imported?.script === 'string' ? q.imported.script : typeof q.imported?.transcript === 'string' ? q.imported.transcript : undefined;
  return { listening: true, ...(script?.trim() ? { script: script.trim() } : {}) };
}
