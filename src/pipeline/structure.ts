/**
 * Stage 2: Structure Pass Pipeline (§6.2)
 * Sends Line-Addressed Source (LAS) + image manifest to LLM with Prompt T1 and strict schema.
 */
import { ImageAsset, LLMRequest, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T1_GEMINI_SCHEMA, T1_STRUCTURE_SYSTEM } from './prompts';

export interface StructurePassResult {
  sections: any[];
  rawQuestions: any[];
  meta: any;
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  rawText: string;
}

export async function runStructurePass(params: {
  sourceLines: SourceLine[];
  images: ImageAsset[];
  languageHint?: string;
  latexEnabled: boolean;
  providerConfig: any;
}): Promise<StructurePassResult> {
  const { sourceLines, images, languageHint, latexEnabled, providerConfig } = params;

  // Format Line-Addressed Source (LAS)
  // Each line prefixed with [L0001], page markers === PAGE n ===
  let lasText = '';
  let currentPage = 0;

  for (const line of sourceLines) {
    if (line.page !== currentPage) {
      currentPage = line.page;
      lasText += `=== PAGE ${currentPage} ===\n`;
    }
    lasText += `[${line.id}] ${line.text}\n`;
  }

  // Format Image Manifest (IDs, page, near line — NO pixels!)
  const manifestEntries = images.map(img => ({
    id: img.id,
    page: img.page,
    nearLine: img.anchorLine || 'unknown',
  }));

  const userPrompt = `CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint: languageHint || null })}\n\nIMAGE MANIFEST:\n${JSON.stringify(manifestEntries, null, 2)}\n\nSOURCE:\n${lasText}`;

  // If source text > 120k characters, chunk by pages (rare for exams, but supported per §5.8 & §10)
  if (lasText.length > 120_000) {
    return await runChunkedStructurePass(params, lasText, manifestEntries);
  }

  // Estimate output tokens ≈ 10% of input + 20 tokens per section/question
  // §5.6: maxOutputTokens = estimate × 1.5
  const estimatedInput = Math.ceil(lasText.length / 3.2);
  const estimatedOutput = Math.max(300, Math.ceil(estimatedInput * 0.10));
  const maxOutput = Math.min(8192, Math.ceil(estimatedOutput * 1.5));

  const isGemini = providerConfig?.kind === 'gemini';
  const request: LLMRequest = {
    role: 'fast',
    system: T1_STRUCTURE_SYSTEM,
    text: userPrompt,
    jsonSchema: isGemini ? T1_GEMINI_SCHEMA : undefined,
    maxOutputTokens: maxOutput,
    label: 'Structure Pass',
    providerConfig,
  };

  const response = await LLMAdapter.execute(request);
  const data: any = response.json || {};

  // Token-Thrift Acceptance Check (§12 Test 1): expect output ≤ 12% of input
  const thriftRatio = response.usage.inputTokens > 0
    ? (response.usage.outputTokens / response.usage.inputTokens) * 100
    : 0;
  console.log(
    `[Token-Thrift Audit] Structure Pass: in=${response.usage.inputTokens}, out=${response.usage.outputTokens} (ratio: ${thriftRatio.toFixed(1)}%, target: <=12%)`
  );

  return {
    sections: Array.isArray(data.sections) ? data.sections : [],
    rawQuestions: Array.isArray(data.questions) ? data.questions : [],
    meta: data.meta || {},
    usage: response.usage,
    rawText: response.rawText,
  };
}

/**
 * Handle oversized documents (>120k chars) with page chunking & 2-line overlap
 */
async function runChunkedStructurePass(
  params: any,
  _fullLas: string,
  manifest: any[]
): Promise<StructurePassResult> {
  const { sourceLines, languageHint, latexEnabled, providerConfig } = params;
  const isGemini = providerConfig?.kind === 'gemini';

  // Split lines into chunks of ~50 lines with 2-line overlap
  const chunkSize = 150;
  const overlap = 2;
  const mergedSections: any[] = [];
  const mergedQuestions: any[] = [];
  let mergedMeta: any = {};
  let totalInTokens = 0;
  let totalOutTokens = 0;
  let totalCachedTokens = 0;

  for (let i = 0; i < sourceLines.length; i += chunkSize - overlap) {
    const chunkLines = sourceLines.slice(i, i + chunkSize);
    let chunkLas = '';
    for (const line of chunkLines) {
      chunkLas += `[${line.id}] ${line.text}\n`;
    }

    const chunkPrompt = `CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint })}\n\nIMAGE MANIFEST:\n${JSON.stringify(manifest)}\n\nSOURCE CHUNK:\n${chunkLas}`;

    const req: LLMRequest = {
      role: 'fast',
      system: T1_STRUCTURE_SYSTEM,
      text: chunkPrompt,
      jsonSchema: isGemini ? T1_GEMINI_SCHEMA : undefined,
      maxOutputTokens: 4096,
      label: `Structure Pass (Chunk ${Math.floor(i / chunkSize) + 1})`,
      providerConfig,
    };

    const resp = await LLMAdapter.execute(req);
    totalInTokens += resp.usage.inputTokens;
    totalOutTokens += resp.usage.outputTokens;
    totalCachedTokens += resp.usage.cachedTokens || 0;

    const data: any = resp.json || {};
    if (data.meta && Object.keys(mergedMeta).length === 0) mergedMeta = data.meta;
    if (Array.isArray(data.sections)) mergedSections.push(...data.sections);
    if (Array.isArray(data.questions)) mergedQuestions.push(...data.questions);
  }

  // Deduplicate questions by number
  const seenNos = new Set<number>();
  const dedupedQuestions: any[] = [];
  for (const q of mergedQuestions) {
    if (q && !seenNos.has(q.no)) {
      seenNos.add(q.no);
      dedupedQuestions.push(q);
    }
  }

  return {
    sections: mergedSections,
    rawQuestions: dedupedQuestions,
    meta: mergedMeta,
    usage: {
      inputTokens: totalInTokens,
      outputTokens: totalOutTokens,
      cachedTokens: totalCachedTokens,
    },
    rawText: 'Merged from chunks',
  };
}
