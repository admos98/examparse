/** Section-only, two-phase reparse. Preparing never writes exam content; commit is pure and revalidates. */
import { z } from "zod";
import { AppSettings, ExamDoc, Question, UsageRecord } from "../types";
import { ExamDocImportSchema, SAFE_STORAGE_KEY } from "../utils/validation";
import { calculateActualCost } from "../utils/budget";
import { sha256 } from "../utils/hash";
import {
  RawQuestionSchema,
  assembleAndValidateQuestions,
  assembleAndValidateSections,
  spanLineNumbers,
} from "./assemble";
import { spanEndLine, spansContainLine, spanStartLine } from "./spans";
import {
  enumerateExpectedQuestionNos,
  evaluateCoverage,
  examContentRevision,
  lineNumber,
} from "./quality";
import { runStructurePass, StructurePassResult } from "./structure";
import { PARSER_VERSION } from "./prompts";
import { AgentOperationError } from "./agentI18n";
import { canonicalizeForms } from "./forms";

const UsageSchema = z
  .object({
    ts: z.string(),
    role: z.literal("agent"),
    provider: z.string().max(200),
    model: z.string().max(300),
    inputTokens: z.number().finite().nonnegative(),
    outputTokens: z.number().finite().nonnegative(),
    cachedTokens: z.number().finite().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative(),
    label: z.string().max(1000),
  })
  .strict();
export const SectionCandidateSchema = z
  .object({
    sectionId: z.string().regex(SAFE_STORAGE_KEY),
    rawQuestions: z.array(RawQuestionSchema.strict()).min(1).max(5000),
    usage: z.array(UsageSchema).max(6),
  })
  .strict();
export type SectionCandidate = z.infer<typeof SectionCandidateSchema>;
export function sectionSource(doc: ExamDoc, sectionId: string) {
  const section = doc.sections.find((s) => s.id === sectionId);
  if (!section) throw new AgentOperationError("noSection");
  const key = new Set([
    ...(doc.source.keyTerritoryLineNos || []),
    ...enumerateExpectedQuestionNos(doc.source.lines).keyTerritory.lineNos,
  ]);
  const lines = doc.source.lines.filter(
    (l) =>
      !key.has(lineNumber(l)) &&
      spansContainLine(section.spans, lineNumber(l)),
  );
  const safe = new Set(lines.filter((l) => !l.furniture).map(lineNumber));
  if (!safe.size) throw new AgentOperationError("emptySection");
  return { section, lines, safe, available: new Set(lines.map(lineNumber)) };
}

/** Same assembly/quality funnel as normal parsing. Never trusts candidate stems, ids, meta or section bounds. */
export function applySectionCandidate(doc: ExamDoc, input: unknown): ExamDoc {
  const candidate = SectionCandidateSchema.parse(input);
  const { section, safe, available } = sectionSource(doc, candidate.sectionId);
  const old = doc.questions.filter((q) => q.sectionId === section.id);
  const outside = doc.questions.filter((q) => q.sectionId !== section.id);
  const oldIds = new Set(old.map((q) => q.id));
  // Overlapping source ownership is ambiguous; do not silently steal another section's content.
  if (outside.some((q) => spanLineNumbers(q.spans).some((n) => safe.has(n))))
    throw new AgentOperationError("invalidCandidate");
  const allowedImages = new Set(
    doc.images
      .filter(
        (img) =>
          safe.has(img.anchorLine ?? -1) ||
          old.some((q) => q.images.some((r) => r.imageId === img.id)),
      )
      .map((img) => img.id),
  );
  const outsideImages = new Set(
    outside.flatMap((q) => q.images.map((i) => i.imageId)),
  );
  for (const raw of candidate.rawQuestions) {
    const spans = [
      ...raw.spans,
      ...(raw.options || []).flatMap((o) => o.spans),
      ...(raw.tables || []).flatMap((t) => t.spans),
      ...(raw.answer?.spans || []),
    ];
    if (
      !raw.spans.length ||
      spans.some((sp) => {
        const a = spanStartLine(sp);
        const b = spanEndLine(sp);
        return (
          b < a ||
          b - a > 5000 ||
          spanLineNumbers([sp]).some((n) => !available.has(n))
        );
      }) ||
      !spanLineNumbers(raw.spans).some((n) => safe.has(n)) ||
      raw.rewrites?.length ||
      raw.images?.some(
        (i) => !allowedImages.has(i.imageId) || outsideImages.has(i.imageId),
      )
    )
      throw new AgentOperationError("invalidCandidate");
  }
  const assembled = assembleAndValidateQuestions(
    candidate.rawQuestions.map((q) => ({ ...q, sectionId: section.id })),
    doc.source.lines,
    undefined,
    {
      keyTerritoryLineNos:
        doc.source.keyTerritoryLineNos ||
        enumerateExpectedQuestionNos(doc.source.lines).keyTerritory.lineNos,
      imageIds: doc.images.map((i) => i.id),
      // Hollow/option findings stay as question flags; they do not invalidate a user-consented candidate.
      semanticErrorsToRepair: false,
    },
  );
  if (
    !assembled.questions.length ||
    assembled.failingQuestions.length ||
    assembled.questions.length !== candidate.rawQuestions.length
  )
    throw new AgentOperationError("invalidCandidate");
  // Fix 2 (Marvel Batch 6) — ADOPTION-TIME CANONICALIZATION (defense in depth).
  // A section reparse replaces questions wholesale, so replacements pass the same deterministic
  // registry the assembler uses (with their group parent context) BEFORE they are inserted.
  const reparsedCanonical = canonicalizeForms({
    questions: [
      ...doc.questions.filter((question) => question.sectionId === section.id),
      ...assembled.questions,
    ],
    sourceLines: doc.source.lines,
    sections: doc.sections,
    scopeQuestionIds: new Set(assembled.questions.map((question) => question.id)),
  });
  const canonicalById = new Map(reparsedCanonical.questions.map((question) => [question.id, question]));
  const adoptedReplacements = assembled.questions
    .map((question) => canonicalById.get(question.id))
    .filter((question): question is Question => Boolean(question))
    .filter((question) => !(question.parentId && question.parentId === question.id));

  const used = new Set(outside.map((q) => q.id));
  const remap = new Map<string, string>();
  const replacements = adoptedReplacements
    .map((q, i) => {
      const previous =
        old.find(
          (p) =>
            !used.has(p.id) &&
            p.no === q.no &&
            JSON.stringify(p.spans) === JSON.stringify(q.spans),
        ) || old.find((p) => !used.has(p.id) && p.no === q.no);
      let id =
        previous?.id || `q_reparse_${section.id.slice(0, 60)}_${q.no}_${i}`;
      while (used.has(id)) id += "_r";
      used.add(id);
      remap.set(q.id, id);
      return {
        ...q,
        id,
        sectionId: section.id,
        // A section-only span reparse does not re-price unchanged existing items. New point values
        // still come only from source key/header evidence in assembly; the prior accepted value is
        // retained when re-identifying the same printed question.
        points: previous?.points ?? q.points,
        answer: q.answer || previous?.answer,
        images: q.images.length ? q.images : previous?.images || [],
      };
    })
    .map((q) => ({
      ...q,
      parentId: q.parentId ? remap.get(q.parentId) : undefined,
    }));
  const retainedIds = new Set(replacements.map((q) => q.id));
  if (
    outside.some(
      (q) =>
        q.parentId && oldIds.has(q.parentId) && !retainedIds.has(q.parentId),
    )
  )
    throw new AgentOperationError("invalidCandidate");
  // Insert in place; outside questions/sections keep their exact values and relative order.
  const insertion = doc.questions.findIndex((q) => q.sectionId === section.id);
  const questions: Question[] = [];
  for (let i = 0; i < doc.questions.length; i++) {
    if (i === insertion) questions.push(...replacements);
    if (doc.questions[i].sectionId !== section.id)
      questions.push(doc.questions[i]);
  }
  if (insertion < 0) questions.push(...replacements);
  const sectionResult = assembleAndValidateSections(
    [section],
    doc.source.lines,
    questions,
    doc.source.keyTerritoryLineNos || [],
  );
  const sections = doc.sections.map((s) =>
    s.id === section.id ? sectionResult.sections[0] : s,
  );
  const images = doc.images.map((image) => {
    const owner = replacements.find((q) =>
      q.images.some((i) => i.imageId === image.id),
    );
    if (
      owner &&
      (!image.label?.questionRef || oldIds.has(image.label.questionRef))
    )
      return {
        ...image,
        label: {
          ...image.label,
          role: owner.images.find((ref) => ref.imageId === image.id)!.role,
          questionRef: owner.id,
        },
      };
    if (
      image.label?.questionRef &&
      oldIds.has(image.label.questionRef) &&
      !retainedIds.has(image.label.questionRef)
    )
      return { ...image, label: { ...image.label, questionRef: undefined } };
    return image;
  });
  const coverage = evaluateCoverage(
    doc.source.expectedQuestionNos ||
      enumerateExpectedQuestionNos(doc.source.lines).numbers,
    questions,
    doc.meta.totalPoints,
  );
  const replacedCodes = new Set([
    "COVERAGE_MISSING",
    "COVERAGE_DUPLICATE",
    "PARTIAL_COVERAGE",
    "POINTS_MISMATCH",
  ]);
  const flags = [
    ...doc.flags.filter(
      (f) =>
        !replacedCodes.has(f.code) &&
        (!f.questionId || !oldIds.has(f.questionId)),
    ),
    ...assembled.flags.map((f) =>
      f.questionId
        ? { ...f, questionId: remap.get(f.questionId) || f.questionId }
        : f,
    ),
    ...sectionResult.flags,
  ];
  if (coverage.missing.length)
    flags.push({
      id: "reparse_missing",
      code: "COVERAGE_MISSING",
      severity: "error",
      message: `Missing printed question numbers: ${coverage.missing.join(", ")}.`,
    });
  if (!coverage.pointsMatch)
    flags.push({
      id: "reparse_points",
      code: "POINTS_MISMATCH",
      severity: "warn",
      message: `Points ${coverage.pointsParsed}/${coverage.pointsExpected}.`,
    });
  if (coverage.duplicates.length)
    flags.push({
      id: "reparse_duplicates",
      code: "COVERAGE_DUPLICATE",
      severity: "warn",
      message: `Duplicate printed question numbers: ${coverage.duplicates.join(", ")}.`,
    });
  const updated = { ...doc, questions, sections, images, flags };
  ExamDocImportSchema.parse(updated);
  return updated;
}

export function sectionDiffView(doc: ExamDoc, sectionId: string) {
  return {
    flags: doc.flags,
    section: doc.sections.find((s) => s.id === sectionId),
    questions: doc.questions.filter((q) => q.sectionId === sectionId),
    imageLabels: doc.images.map((i) => ({ id: i.id, label: i.label })),
  };
}
export async function prepareSectionReparse(params: {
  doc: ExamDoc;
  sectionId: string;
  settings: AppSettings;
  agentBudgetId: string;
  onLiveText?: (
    label: string,
    channel: "output" | "reasoning" | "info",
    text: string,
  ) => void;
  recordUsage: (usage: UsageRecord) => Promise<void>;
  runStructure?: typeof runStructurePass;
}): Promise<SectionCandidate> {
  const { doc, sectionId, settings } = params;
  const { lines, safe } = sectionSource(doc, sectionId);
  const role = settings.roleMapping.fast;
  const provider = settings.providers.find((p) => p.id === role.providerId);
  if (!provider) throw new AgentOperationError("prepareUnavailable");
  const providerConfig = {
    ...provider,
    model: role.model,
    agentBudgetId: params.agentBudgetId,
    agentMaxCalls: settings.agentLimits?.maxModelCalls ?? 30,
  };
  const journalKey = await sha256(
    JSON.stringify([
      PARSER_VERSION,
      "section-overwrite",
      doc.fileHash,
      sectionId,
      examContentRevision(doc),
      provider.id,
      role.model,
    ]),
  );
  const usage: UsageRecord[] = [];
  const recordCall = async (call: {
    label: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  }) => {
    const record: UsageRecord = {
      ts: new Date().toISOString(),
      role: "agent",
      provider: provider.name,
      model: role.model,
      label: call.label,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cachedTokens: call.cachedTokens,
      costUsd: calculateActualCost(
        call.inputTokens,
        call.outputTokens,
        role.model,
        settings.costTable,
      ),
    };
    usage.push(record);
    await params.recordUsage(record);
  };
  const result: StructurePassResult = await (
    params.runStructure || runStructurePass
  )({
    sourceLines: lines,
    images: doc.images.filter((img) => safe.has(img.anchorLine ?? -1)),
    providerConfig,
    languageHint: doc.meta.language,
    latexEnabled: settings.thrift.latexNormalization,
    maxBudgetTokens: settings.budget.maxOutputTokens,
    forceSectionMode: true,
    journalEnabled: settings.thrift.cacheEnabled,
    journalKey,
    onLiveText: params.onLiveText,
    onCallUsage: recordCall,
  });
  if (
    result.rawQuestions.some((q) =>
      ["stem", "stemText", "fullStem", "questionText"].some((key) =>
        Object.hasOwn(q, key),
      ),
    )
  )
    throw new AgentOperationError("invalidCandidate");
  const candidate = SectionCandidateSchema.parse({
    sectionId,
    rawQuestions: result.rawQuestions,
    usage,
  });
  applySectionCandidate(doc, candidate); // validate before displaying a confirmation, and again on commit
  return candidate;
}
