import { z } from "zod";
import { AppSettings, ExamDoc } from "../types";
import {
  ActionLedger,
  ActionQueueItem,
  computeActionFingerprint,
  getActiveTurnLedger,
  healthSummary,
  missingSetFingerprint,
  ToolRegistry,
} from "./agent";
import {
  applyValidatedQuestionPatch,
  QuestionMergePatchSchema,
  applyExamMutation,
} from "./patch";
import { ColorSchema, ThemeTokenSchema } from "./agentTheme";
import {
  lineNumber,
  examContentRevision,
  enumerateExpectedQuestionNos,
  getExamHealth,
  parsePrintedNumberFromStem,
  computeImageQuestionHints,
  computeLearnedWatermarks,
  exciseWatermarksWithLearned,
} from "./quality";
import {
  canonicalizeSections,
  normalizeOptionText,
  splitInlineOptions,
  stripLeadingOptionMarker,
  trimOptionInstructionResidue,
} from "./assemble";
import { agentText, AgentOperationError } from "./agentI18n";
import {
  applySectionCandidate,
  SectionCandidate,
  sectionDiffView,
} from "./reparseSection";
import { buildDossier } from "./dossier";
import { traceForAgent } from "./provenance";
const empty = z.object({}).strict();
const id = z.string().min(1).max(128);
const questionId = z.object({ questionId: id }).strict();
const page = {
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(10).default(5),
};
export interface ToolContext {
  getDoc: () => ExamDoc;
  getSettings: () => AppSettings;
  getDossier?: () => any;
  updateDoc: (doc: ExamDoc) => Promise<void>;
  updateSettings: (s: AppSettings) => Promise<void>;
  updateDossier?: (d: any) => Promise<void>;
  retryMissing: (doc: ExamDoc) => Promise<ExamDoc>;
  reparseSection?: (
    doc: ExamDoc,
    sectionId: string,
  ) => Promise<SectionCandidate>;
  remediationPipeline?: (doc: ExamDoc) => Promise<any>;
  actionLedger?: ActionLedger;
}

export function resolveGroupRootParent(doc: ExamDoc, startIdOrQuestion: string | ExamDoc["questions"][number]) {
  const byId = new Map(doc.questions.map((q) => [q.id, q]));
  let cur = typeof startIdOrQuestion === "string" ? byId.get(startIdOrQuestion) : startIdOrQuestion;
  const visited = new Set<string>();
  while (cur?.parentId && byId.has(cur.parentId) && !visited.has(cur.id)) {
    visited.add(cur.id);
    cur = byId.get(cur.parentId)!;
  }
  return cur;
}

export function splitGroupChildrenInDoc(doc: ExamDoc, parentQuestionId: string): {
  ok: boolean;
  summary: string;
  added: number[];
  doc: ExamDoc;
  residueTrimmed: boolean;
} {
  const start = doc.questions.find((q) => q.id === parentQuestionId);
  if (!start) throw new AgentOperationError("questionMissing");
  const root = resolveGroupRootParent(doc, start)!;

  const lineByNo = new Map((doc.source?.lines || []).map((l) => [lineNumber(l), l]));
  const pagesCount = new Set((doc.source?.lines || []).map((l) => l.page)).size;
  const learnedWatermarks = computeLearnedWatermarks(doc.source?.lines || [], pagesCount);

  const rootSpanLines = (root.spans || [])
    .flatMap(([s, e]) => {
      const acc: typeof doc.source.lines = [];
      for (let ln = s; ln <= e; ln++) {
        const line = lineByNo.get(ln);
        if (line && !line.furniture) acc.push(line);
      }
      return acc;
    });

  // Collect all enumerated numbers on the group (from root.stem and source span lines)
  const parenMatches = [
    ...[...(root.stem || "").matchAll(/\((\d{1,3})\)/g)].map((m) => Number(m[1])),
    ...rootSpanLines.flatMap((l) => [...l.text.matchAll(/\((\d{1,3})\)/g)].map((m) => Number(m[1]))),
  ];
  const spanEnumerated = enumerateExpectedQuestionNos(rootSpanLines).numbers;
  const enumeratedAll: number[] = [];
  for (const n of [...parenMatches, ...spanEnumerated]) {
    if (Number.isInteger(n) && n > 0 && !enumeratedAll.includes(n)) enumeratedAll.push(n);
  }
  const existingNos = new Set(doc.questions.map((q) => q.no));
  const toAdd = enumeratedAll.filter((n) => n !== root.no && !existingNos.has(n));
  if (!enumeratedAll.filter((n) => n !== root.no).length) {
    return { ok: false, summary: "No enumerated child numbers in parent stem", added: [], doc, residueTrimmed: false };
  }
  if (!toAdd.length) {
    return { ok: true, summary: "Children already exist", added: [], doc, residueTrimmed: false };
  }

  // Raw parent instruction text from source spans (excised of watermarks)
  const rawSourceSlice = rootSpanLines
    .map((l) => exciseWatermarksWithLearned(l.text, learnedWatermarks).text.trim())
    .filter(Boolean)
    .join("\n");
  const parentInstructionRef = [rawSourceSlice, root.stem || ""].filter(Boolean).join("\n");

  // Clean shared instruction line from source (first instruction line without inline option list or raw `(15)(16)` run)
  const rawFirstInstructionLine =
    rootSpanLines
      .map((l) => exciseWatermarksWithLearned(l.text, learnedWatermarks).text.trim())
      .find((t) => t.length >= 6 && !/^\s*(?:\([a-j]\)|[a-j][).:])\s+/i.test(t)) ||
    exciseWatermarksWithLearned(root.stem || "", learnedWatermarks).text.trim();
  const cleanSharedInstruction = rawFirstInstructionLine
    .replace(/(?:\(\d{1,3}\)\s*){2,}/g, " ")
    .replace(/^\s*\d{1,3}\s*[.):-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  // Re-slice shared options through: watermark exciser -> inline option splitter -> parent instruction residue trimmer
  const optionSpans = (root.options || []).flatMap((o) => o.spans || []);
  const optionSourceText = optionSpans.length
    ? optionSpans
        .flatMap(([s, e]) => {
          const lines: string[] = [];
          for (let ln = s; ln <= e; ln++) {
            const line = lineByNo.get(ln);
            if (line && !line.furniture) lines.push(exciseWatermarksWithLearned(line.text, learnedWatermarks).text);
          }
          return lines;
        })
        .join("\n")
    : (root.options || [])
        .map((o, idx) => {
          const exc = exciseWatermarksWithLearned(o.text || "", learnedWatermarks).text;
          return `${o.key || String.fromCharCode(97 + idx)}) ${stripLeadingOptionMarker(exc)}`;
        })
        .join("\n");

  let reSlicedOptions: NonNullable<ExamDoc["questions"][number]["options"]> = [];
  if (optionSourceText.trim()) {
    const inlineParts = splitInlineOptions(optionSourceText);
    if (inlineParts && inlineParts.length >= 2) {
      reSlicedOptions = inlineParts.map((p, idx) => ({
        key: p.key || String.fromCharCode(97 + idx),
        spans: optionSpans.length ? [[optionSpans[0][0], optionSpans[optionSpans.length - 1][1]]] : root.spans,
        text: p.text,
      }));
    } else if ((root.options || []).length >= 2) {
      reSlicedOptions = (root.options || [])
        .map((o, idx) => ({
          key: o.key || String.fromCharCode(97 + idx),
          spans: o.spans?.length ? o.spans : root.spans,
          text: stripLeadingOptionMarker(exciseWatermarksWithLearned(o.text || "", learnedWatermarks).text),
        }))
        .filter((o) => Boolean(o.text));
    }
  }

  let residueTrimmed = false;
  reSlicedOptions = reSlicedOptions.map((opt) => {
    const tr = trimOptionInstructionResidue(opt.text || "", parentInstructionRef);
    if (tr.trimmed) residueTrimmed = true;
    return { ...opt, text: normalizeOptionText(tr.text) };
  });
  // Deduplicate any identical normalized options so I2 / I9 never trip
  const seenOptText = new Set<string>();
  reSlicedOptions = reSlicedOptions.filter((opt) => {
    const keyNorm = (opt.text || "").trim().toLowerCase();
    if (!keyNorm || seenOptText.has(keyNorm)) return false;
    seenOptText.add(keyNorm);
    return true;
  });

  // Resolve picture captions for group images (by child ref first, else by slot index in group images)
  const imageById = new Map((doc.images || []).map((img) => [img.id, img]));
  const rootAttachedImages = (root.images || [])
    .map((ref) => imageById.get(ref.imageId))
    .filter((img): img is NonNullable<typeof img> => Boolean(img && img.label?.role !== "decoration" && img.label?.kind !== "decoration"));
  const rootPages = new Set(rootSpanLines.map((l) => l.page));
  const candidateGroupImages = rootAttachedImages.length
    ? rootAttachedImages
    : (doc.images || []).filter(
        (img) =>
          rootPages.has(img.page) &&
          img.label?.role !== "decoration" &&
          img.label?.kind !== "decoration" &&
          (img.label?.questionRef === root.id || img.label?.questionRef === String(root.no)),
      );

  const usedIds = new Set(doc.questions.map((q) => q.id));
  const slotList = enumeratedAll.includes(root.no) ? enumeratedAll : toAdd;

  const newQuestions = toAdd.map((n, addIdx) => {
    let childId = `${root.id}_c${n}`;
    let suffix = 2;
    while (usedIds.has(childId)) {
      childId = `${root.id}_c${n}_${suffix++}`;
    }
    usedIds.add(childId);

    const directImg = (doc.images || []).find(
      (img) => img.label?.questionRef === String(n) && img.label?.role !== "decoration",
    );
    const slotIdx = slotList.indexOf(n);
    const candidateAtSlot =
      slotIdx >= 0 && slotIdx < candidateGroupImages.length ? candidateGroupImages[slotIdx] : undefined;
    // Never steal an image explicitly labeled for a different child question number
    const belongsToOtherChild =
      candidateAtSlot?.label?.questionRef &&
      candidateAtSlot.label.questionRef !== String(n) &&
      candidateAtSlot.label.questionRef !== root.id &&
      candidateAtSlot.label.questionRef !== String(root.no);
    const slotImg = directImg || (belongsToOtherChild ? undefined : candidateAtSlot);
    const caption = String(slotImg?.label?.caption || "").trim();
    const childStem = caption
      ? `${n}. ${caption}`
      : `${n}. ${cleanSharedInstruction || `Item ${n}`}`;

    // I9: shared pool lives cleanly on root parent (`root.options`); children inherit pool via `parentId = root.id` with no duplicate per-child pool options
    const childType = root.type === "mcq" ? "matching" : root.type;
    const childFlags = ["GROUP_CHILD_CREATED", ...(residueTrimmed ? ["OPTION_RESIDUE_TRIMMED"] : [])];
    const childImages = slotImg
      ? [{ imageId: slotImg.id, role: slotImg.label?.role || "stem", anchorLine: slotImg.anchorLine }]
      : (root.images || []);

    return {
      id: childId,
      label: String(n),
      no: n,
      parentId: root.id,
      sectionId: root.sectionId,
      spans: root.spans,
      stem: childStem,
      points: 0,
      type: childType,
      options: undefined,
      images: childImages,
      confidence: 0.85,
      flags: childFlags,
    } as ExamDoc["questions"][number];
  });

  const updatedQuestions = doc.questions
    .map((q) => {
      if (q.id !== root.id) return q;
      const rootFlags = [...(q.flags || [])];
      if (residueTrimmed && !rootFlags.includes("OPTION_RESIDUE_TRIMMED")) {
        rootFlags.push("OPTION_RESIDUE_TRIMMED");
      }
      const cleanedRootStem = exciseWatermarksWithLearned(q.stem || "", learnedWatermarks).text;
      return {
        ...q,
        stem: cleanedRootStem,
        options: reSlicedOptions.length >= 2 ? reSlicedOptions : q.options,
        flags: rootFlags,
      };
    })
    .concat(newQuestions)
    .sort((a, b) => a.no - b.no);

  const nextDocFlags = [...(doc.flags || [])];
  if (residueTrimmed && !nextDocFlags.some((f) => f.code === "OPTION_RESIDUE_TRIMMED" && f.questionId === root.id)) {
    nextDocFlags.push({
      id: `flag_residue_${root.id}`,
      code: "OPTION_RESIDUE_TRIMMED",
      severity: "info",
      questionId: root.id,
      message: `Trimmed duplicated parent instruction fragment from shared options of group Q${root.no}.`,
    });
  }

  return {
    ok: true,
    summary: `Split group: added ${toAdd.length} children (${toAdd.join(",")})`,
    added: toAdd,
    doc: { ...doc, questions: updatedQuestions, flags: nextDocFlags },
    residueTrimmed,
  };
}

function diagnoseMissingWithLedger(
  doc: ExamDoc,
  numbers: number[],
  ledger?: ActionLedger,
) {
  const enumRes = enumerateExpectedQuestionNos(doc.source.lines);
  const result = numbers.map((n: number) => {
    const expectedLine = enumRes.lineByNumber.get(n);
    const lineText = expectedLine ? doc.source.lines.find((l) => lineNumber(l) === expectedLine)?.text : undefined;
    const sortedQs = [...doc.questions].sort((a, b) => a.no - b.no);
    const idx = sortedQs.findIndex((q) => q.no >= n);
    const neighbours = [];
    if (idx > 0) neighbours.push(sortedQs[idx - 1]);
    if (idx >= 0 && idx < sortedQs.length) neighbours.push(sortedQs[idx]);
    if (idx >= 0 && idx + 1 < sortedQs.length) neighbours.push(sortedQs[idx + 1]);
    const sec = doc.sections.find((s) => s.spans.some(([a, b]) => expectedLine && expectedLine >= a && expectedLine <= b));
    let cause = "unknown";
    if (!expectedLine) cause = "gap between sections or key-territory leak";
    else {
      const line = doc.source.lines.find((l) => lineNumber(l) === expectedLine);
      if (line && /\(\d+\)/.test(line.text) && line.text.match(/\(\d+\)/g)!.length >= 2)
        cause = "group-parent? (multiple (N) on one line) — parent may need children via split_group_children";
      else if (
        (line && /[a-h][).:]\s*$/.test(line.text.slice(0, 60))) ||
        (line && /^[a-z]\).*64\./i.test(doc.source.lines.find((l) => lineNumber(l) === expectedLine + 1)?.text || ""))
      )
        cause = "sub-part line? (lettered a-d under previous number) — should be one question with sub-prompts";
      else if (enumRes.keyTerritory.lineNos.has(expectedLine)) cause = "key-territory leak";
      else cause = "section swallowed or not emitted";
    }
    return {
      number: n,
      expectedLine,
      lineText: lineText?.slice(0, 120),
      neighbours: neighbours.map((q) => ({ no: q.no, label: q.label, sectionId: q.sectionId })),
      section: sec?.title,
      sectionId: sec?.id,
      cause,
      sourceSlice: lineText,
    };
  });

  const rawQueue: ActionQueueItem[] = [];
  const splitParents = new Set<string>();
  const acceptByParent = new Map<string, number[]>();
  const reparseSections = new Set<string>();
  for (const r of result) {
    if (r.cause.startsWith("group-parent")) {
      const matched =
        doc.questions.find(
          (q) =>
            q.spans.some(([a, b]) => r.expectedLine !== undefined && r.expectedLine >= a && r.expectedLine <= b) &&
            new RegExp(`\\(${r.number}\\)`).test(q.stem || ""),
        ) || doc.questions.find((q) => new RegExp(`\\(${r.number}\\)`).test(q.stem || ""));
      const rootParent = matched ? resolveGroupRootParent(doc, matched) : undefined;
      if (rootParent && !splitParents.has(rootParent.id)) {
        splitParents.add(rootParent.id);
        rawQueue.push({
          tool: "split_group_children",
          args: { parentQuestionId: rootParent.id },
          rationale: `Q${rootParent.no} enumerates (${r.number}) on its number line — children are deterministic shells`,
          riskClass: "mutate",
        });
      }
    } else if (r.cause.startsWith("sub-part")) {
      const prev = r.neighbours.find((q: { no: number }) => q.no < r.number);
      const prevQ = prev ? doc.questions.find((q) => q.no === prev.no) : undefined;
      if (prevQ) acceptByParent.set(prevQ.id, [...(acceptByParent.get(prevQ.id) || []), r.number]);
    } else if (r.cause.startsWith("section swallowed") && r.sectionId) {
      reparseSections.add(r.sectionId);
    }
  }
  for (const [parentQuestionId, childNumbers] of acceptByParent) {
    const parent = doc.questions.find((q) => q.id === parentQuestionId)!;
    rawQueue.push({
      tool: "accept_group_representation",
      args: { parentQuestionId, childNumbers },
      rationale: `${childNumbers.join(",")} are lettered sub-parts of Q${parent.no}; represent them by the parent`,
      riskClass: "mutate",
    });
  }
  for (const sectionId of reparseSections) {
    const sec = doc.sections.find((s) => s.id === sectionId);
    rawQueue.push({
      tool: "reparse_section",
      args: { sectionId },
      rationale: `Section ${sec?.title || sectionId} swallowed its numbers; a validated candidate needs confirmation`,
      riskClass: "destructive",
    });
  }

  // Filter actionQueue against executed/refused (action + target + docHash) fingerprints so already-tried items never re-queue
  const filteredOut: string[] = [];
  const queue = rawQueue.filter((item) => {
    const fp = computeActionFingerprint(item.tool, item.args, doc);
    if (ledger?.executedFingerprints.has(fp) || ledger?.refusedFingerprints.has(fp)) {
      filteredOut.push(fp);
      return false;
    }
    return true;
  });

  return {
    ok: true,
    summary: `Diagnosed ${numbers.length} missing numbers: ${result.map((r: { number: number; cause: string }) => `${r.number}=${r.cause.split("?")[0].split(" (")[0]}`).join("; ").slice(0, 200)}`,
    data: result,
    actionQueue: queue,
    filteredFingerprints: filteredOut,
  };
}
/** No filesystem, import, OCR, vision, provider, budget or arbitrary-code capability is registered. */
export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const question = (questionId: string) => {
    const q = ctx.getDoc().questions.find((q) => q.id === questionId);
    if (!q) throw new AgentOperationError("questionMissing");
    return q;
  };
  const patch = async (qid: string, value: unknown) => {
    const doc = ctx.getDoc();
    const q = question(qid);
    const updated = applyValidatedQuestionPatch(
      q,
      value,
      doc.source.lines,
      doc.source.keyTerritoryLineNos,
    );
    await ctx.updateDoc({
      ...doc,
      questions: doc.questions.map((old) => (old.id === qid ? updated : old)),
    });
    return { updated: qid, health: healthSummary(ctx.getDoc()) };
  };
  return {
    get_exam_health: {
      description: "{} or {fresh:true} → local counts/points/images/health (cached unless fresh or mutation)",
      schema: z.object({ fresh: z.boolean().optional() }).strict(),
      access: "read",
      execute: (args: any) => {
        const h = healthSummary(ctx.getDoc());
        const dossier = ctx.getDossier?.();
        // If dossier exists, include digest? But we return health
        return { ...h, cached: false, ageMs: 0, dossier: dossier?.healthSnapshot ? { digest: dossier.healthSnapshot } : undefined };
      },
    },
    list_missing: {
      description: "{offset?,limit?} → missing printed numbers",
      schema: z.object(page).strict(),
      access: "read",
      execute: ({ offset, limit }) => {
        const all = healthSummary(ctx.getDoc()).missing;
        return {
          numbers: all.slice(offset, offset + limit),
          remaining: Math.max(0, all.length - offset - limit),
          nextOffset: offset + limit,
        };
      },
    },
    get_questions: {
      description:
        "{sectionId?,numbers?:number[],offset?,limit?} stems ≤120 chars",
      schema: z
        .object({
          sectionId: id.optional(),
          numbers: z.array(z.number().int().min(1).max(300)).max(20).optional(),
          ...page,
        })
        .strict(),
      access: "read",
      execute: ({ sectionId, numbers, offset, limit }) => {
        const all = ctx
          .getDoc()
          .questions.filter(
            (q) =>
              (!sectionId || q.sectionId === sectionId) &&
              (!numbers || numbers.includes(q.no)),
          );
        return {
          questions: all.slice(offset, offset + limit).map((q) => ({
            id: q.id,
            no: q.no,
            stem: q.stem?.slice(0, 120),
            points: q.points,
          })),
          remaining: Math.max(0, all.length - offset - limit),
          nextOffset: offset + limit,
        };
      },
    },
    get_source_lines: {
      description: "{start,end} inclusive line numbers, ≤40 lines",
      schema: z
        .object({
          start: z.number().int().positive(),
          end: z.number().int().positive(),
        })
        .strict()
        .refine(
          (v) => v.end >= v.start && v.end - v.start < 40,
          "Range must contain 1–40 lines",
        ),
      access: "read",
      execute: ({ start, end }) =>
        ctx
          .getDoc()
          .source.lines.filter(
            (l) => lineNumber(l) >= start && lineNumber(l) <= end,
          )
          .map((l) => ({
            id: l.id,
            page: l.page,
            text: l.text,
            furniture: l.furniture,
          })),
    },
    get_question: {
      description:
        "{questionId} full one question; oversized results request smaller source slices",
      schema: questionId,
      access: "read",
      execute: ({ questionId }) => question(questionId),
    },
    get_verdicts: {
      description: "{questionId?} → 2B critic verdicts (last 3 per question) from the dossier",
      schema: z.object({ questionId: id.optional() }).strict(),
      access: "read",
      execute: ({ questionId }) => {
        const verdicts = ctx.getDossier?.()?.verdicts || {};
        return questionId ? { questionId, verdicts: verdicts[questionId] || [] } : { verdicts };
      },
    },
    get_trace: {
      description: "{questionId} → 2F provenance trace JSON (≤600 tok): origin, transforms, guidance, confidence math, verdicts",
      schema: questionId,
      access: "read",
      execute: ({ questionId }) => {
        const q = question(questionId);
        const dossier = ctx.getDossier?.();
        const stored = (dossier?.traces || []).find((t: any) => t.questionId === questionId);
        const trace = stored || {
          questionId: q.id, no: q.no,
          origin: { callLabel: "structure", model: "unknown", journalResumed: false },
          transforms: [], guidance: { playbookIds: [], skillIds: [] },
          confidenceMath: { base: q.confidence, deductions: [], final: q.confidence },
          verdicts: (dossier?.verdicts || {})[questionId] || [],
        };
        return traceForAgent(trace);
      },
    },
    list_images: {
      description: "{placed?:boolean,offset?,limit?} labels, no image bytes",
      schema: z.object({ placed: z.boolean().optional(), ...page }).strict(),
      access: "read",
      execute: ({ placed, offset, limit }) => {
        const doc = ctx.getDoc();
        const all = doc.images
          .map((i) => ({
            id: i.id,
            page: i.page,
            label: i.label,
            placed:
              doc.questions.some((q) =>
                q.images.some((r) => r.imageId === i.id),
              ) || Boolean(i.label?.questionRef),
            anchorLine: i.anchorLine,
          }))
          .filter((i) => placed === undefined || i.placed === placed);
        return {
          images: all.slice(offset, offset + limit),
          remaining: Math.max(0, all.length - offset - limit),
          nextOffset: offset + limit,
        };
      },
    },
    get_settings_summary: {
      description: "{} → safe UI settings only, never keys or providers",
      schema: empty,
      access: "read",
      execute: () => {
        const s = ctx.getSettings();
        return {
          language: s.uiLanguage || "en",
          themeTokens: s.themeTokens || {},
          livePanel: s.livePanel ?? true,
          defaultExamMode: s.defaultExamMode || "review",
        };
      },
    },
    // READ (dossier-backed)
    get_exam_map: {
      description: "{} → sections+counts+ranges in one call (dossier-backed)",
      schema: empty,
      access: "read",
      execute: () => {
        const doc = ctx.getDoc();
        const dossier = ctx.getDossier?.() || buildDossier(doc);
        return {
          ok: true,
          summary: `Sections ${dossier.structureMap.length}, questions ${dossier.questionIndex.length}`,
          data: { sections: dossier.structureMap, health: dossier.healthSnapshot }
        };
      },
    },
    get_question_index: {
      description: "{sectionId?, missing?:boolean, lowConf?:boolean} → B1 index rows",
      schema: z.object({ sectionId: id.optional(), missing: z.boolean().optional(), lowConf: z.boolean().optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }).strict(),
      access: "read",
      execute: ({ sectionId, missing, lowConf, limit, offset }) => {
        const doc = ctx.getDoc();
        const dossier = ctx.getDossier?.() || buildDossier(doc);
        let rows = dossier.questionIndex as any[];
        if (sectionId) rows = rows.filter((r:any)=>r.sectionId===sectionId);
        if (missing) {
          const missSet = new Set(dossier.healthSnapshot.missing);
          rows = rows.filter((r:any)=>missSet.has(r.no));
          // If missing requested but no index rows match, also return missing numbers as pseudo rows
          if (rows.length===0 && dossier.healthSnapshot.missing.length) {
            rows = dossier.healthSnapshot.missing.map((n:number)=>({no:n, label:String(n), missing:true}));
          }
        }
        if (lowConf) rows = rows.filter((r:any)=> r.confidence < 0.6);
        const slice = rows.slice(offset, offset+limit);
        return { ok:true, summary:`Found ${rows.length} rows, returning ${slice.length}`, data: slice, delta:{added:0} };
      },
    },
    diagnose_missing: {
      description: "{numbers: number[]} → for given numbers: expected line, neighbouring parsed questions, section, likely cause (group-parent? sub-part? gap? key-territory?) with source slice",
      schema: z.object({ numbers: z.array(z.number().int().min(1).max(300)).min(1).max(20) }).strict(),
      access: "read",
      execute: ({ numbers }) => {
        const doc = ctx.getDoc();
        const ledger = ctx.actionLedger ?? getActiveTurnLedger();
        return diagnoseMissingWithLedger(doc, numbers, ledger);
      },
    },
    get_open_issues: {
      description: "{} → flags grouped, with affected questions",
      schema: empty,
      access: "read",
      execute: () => {
        const doc = ctx.getDoc();
        const dossier = ctx.getDossier?.() || buildDossier(doc);
        return { ok:true, summary:`${Object.keys(dossier.knownIssues).length} issue codes`, data: dossier.knownIssues };
      },
    },
    // MEMORY
    remember_fact: {
      description: "{fact:string} exam-scoped user note (e.g. 'Q15-18 is one group, don't split')",
      schema: z.object({ fact: z.string().min(1).max(500) }).strict(),
      access: "mutate",
      execute: async ({ fact }) => {
        const doc = ctx.getDoc();
        const dossier = ctx.getDossier?.() || buildDossier(doc);
        const newNotes = [...(dossier.userNotes||[]), fact];
        // Also store in doc for health adjustment
        (doc as any).userFacts = newNotes;
        if (ctx.updateDossier) {
          const updated = { ...dossier, userNotes: newNotes };
          await ctx.updateDossier(updated);
        }
        await ctx.updateDoc({ ...doc, flags: [...doc.flags, { id:`fact_${Date.now()}`, code:'USER_FACT', severity:'info', message: fact }] } as any);
        return { ok:true, summary:`Remembered fact: ${fact.slice(0,60)}`, delta:{added:0} };
      },
    },
    forget_fact: {
      description: "{fact:string} remove exam-scoped note",
      schema: z.object({ fact: z.string().min(1).max(500) }).strict(),
      access: "mutate",
      execute: async ({ fact }) => {
        const doc = ctx.getDoc();
        const dossier = ctx.getDossier?.() || buildDossier(doc);
        const newNotes = (dossier.userNotes||[]).filter((n:string)=> n!==fact);
        (doc as any).userFacts = newNotes;
        if (ctx.updateDossier) await ctx.updateDossier({ ...dossier, userNotes: newNotes });
        await ctx.updateDoc({ ...doc } as any);
        return { ok:true, summary:`Forgot fact`, delta:{added:0} };
      },
    },
    remember_preference: {
      description: "{key:string, value:string} global preference (language, theme, etc.)",
      schema: z.object({ key: z.string().min(1).max(50), value: z.string().min(1).max(200) }).strict(),
      access: "mutate",
      execute: async ({ key, value }) => {
        // Use localStorage global memory
        try {
          const raw = (globalThis as any).localStorage?.getItem('examparse_user_prefs');
          const prefs = raw ? JSON.parse(raw) : {};
          prefs[key]=value;
          (globalThis as any).localStorage?.setItem('examparse_user_prefs', JSON.stringify(prefs));
        } catch {}
        // Also via store
        try {
          const { getUserMemory, saveUserMemory } = await import('../store');
          const mem = await getUserMemory();
          mem.preferences = { ...(mem.preferences||{}), [key]: value };
          await saveUserMemory(mem);
        } catch {}
        return { ok:true, summary:`Preference ${key}=${value}` };
      },
    },
    forget_preference: {
      description: "{key:string} remove global preference",
      schema: z.object({ key: z.string().min(1).max(50) }).strict(),
      access: "mutate",
      execute: async ({ key }) => {
        try {
          const raw = (globalThis as any).localStorage?.getItem('examparse_user_prefs');
          if (raw) { const prefs=JSON.parse(raw); delete prefs[key]; (globalThis as any).localStorage?.setItem('examparse_user_prefs', JSON.stringify(prefs)); }
        } catch {}
        try {
          const { getUserMemory, saveUserMemory } = await import('../store');
          const mem = await getUserMemory();
          if (mem.preferences) { delete mem.preferences[key]; await saveUserMemory(mem); }
        } catch {}
        return { ok:true, summary:`Forgot preference ${key}` };
      },
    },
    recall: {
      description: "{} → returns notes+prefs relevant here (auto-included in state pack, so mostly for explicit asks)",
      schema: empty,
      access: "read",
      execute: async () => {
        const dossier = ctx.getDossier?.() || buildDossier(ctx.getDoc());
        let prefs: any = {};
        try { const { getUserMemory } = await import('../store'); prefs = (await getUserMemory()).preferences; } catch {}
        try { const raw=(globalThis as any).localStorage?.getItem('examparse_user_prefs'); if(raw) prefs={...prefs, ...JSON.parse(raw)}; } catch {}
        return { ok:true, summary:`Recall ${dossier.userNotes.length} facts`, data:{ notes: dossier.userNotes, prefs } };
      },
    },
    // ACTION
    retry_missing_questions: {
      description: "{} → additive existing coverage retry (no OCR/vision)",
      schema: empty,
      access: "mutate",
      execute: async () => {
        const beforeDoc = ctx.getDoc();
        const beforeHealth = healthSummary(beforeDoc);
        const beforeMissing = [...beforeHealth.missing];
        const docAfter = await ctx.retryMissing(beforeDoc);
        const afterHealth = healthSummary(docAfter);
        const attempted = beforeMissing;
        const added = beforeMissing.filter(n=> !afterHealth.missing.includes(n));
        const stillMissing = afterHealth.missing;
        const addedCount = docAfter.questions.length - beforeDoc.questions.length;
        // Determine sectionsTried from missing numbers' expected lines
        const enumRes = enumerateExpectedQuestionNos(beforeDoc.source.lines);
        const sectionsTried = [...new Set(attempted.map(n=>{
          const ln = enumRes.lineByNumber.get(n);
          if (!ln) return 'unknown';
          const sec = beforeDoc.sections.find(s=> s.spans.some(([a,b])=> ln>=a && ln<=b));
          return sec?.title || sec?.id || 'unknown';
        }))];
        const result = {
          ok: addedCount>0,
          summary: `Attempted ${attempted.length}, added ${addedCount} (${added.join(',')||'none'}), still missing ${stillMissing.length} (${stillMissing.join(',')||'none'})`,
          delta: { added: added, addedCount, stillMissing, attempted, sectionsTried, callsUsed: 1 },
          data: { attempted, added, stillMissing, addedCount, sectionsTried, callsUsed: 1, healthBefore: beforeHealth, healthAfter: afterHealth },
          suggestedNext: addedCount===0 ? 'L2 inspect: get_source_lines + get_question_index — zero-add, try next rung' : 'Check health; if still missing, inspect or reparse_section',
          health: afterHealth,
          attempted, added, stillMissing, addedCount, sectionsTried, callsUsed:1, // for backward compat
        };
        const ledger = ctx.actionLedger ?? getActiveTurnLedger();
        if (ledger) {
          ledger.retriedMissingKeys.add(missingSetFingerprint(beforeMissing, beforeDoc));
          ledger.retriedMissingKeys.add(missingSetFingerprint(stillMissing, docAfter));
        }
        await ctx.updateDoc(docAfter);
        return result;
      },
    },
    run_remediation_pipeline: {
      description: "{} → deterministic remediation pipeline: health → L0 locals → retry_missing → per-section recheck → reparse candidates → final health. Returns compact report with per-step deltas.",
      schema: empty,
      access: "mutate",
      execute: async () => {
        const ledger = ctx.actionLedger ?? getActiveTurnLedger();
        const startDoc = ctx.getDoc();
        const steps: any[] = [];
        let current = startDoc;
        const health0 = healthSummary(current);
        steps.push({ step: "health", healthBefore: health0, delta: { addedCount: 0 } });

        // L0 locals: deterministic section canonicalization + strict same-page geometry hints
        const canon = canonicalizeSections(current.sections || [], current.questions || []);
        const hints = computeImageQuestionHints(current.images || [], canon.questions, current.source?.lines || []);
        let l0Mutated = canon.changed;
        const nextImages = (current.images || []).map((img) => {
          const h = hints[img.id];
          if (!h || h.page !== img.page || img.label?.questionRef) return img;
          l0Mutated = true;
          return {
            ...img,
            label: { role: "stem" as const, questionRef: h.questionRef, kind: "photo" as const, source: "geometry" } as any,
          };
        });
        if (l0Mutated) {
          const nextFlags = canon.changed && !(current.flags || []).some((f) => f.code === "SECTION_ORDER_CANONICALIZED")
            ? [
                ...(current.flags || []),
                {
                  id: "flag_section_order_canonicalized",
                  code: "SECTION_ORDER_CANONICALIZED",
                  severity: "info" as const,
                  message: "Section order and indices canonicalized by first span line.",
                },
              ]
            : current.flags;
          current = { ...current, sections: canon.sections, questions: canon.questions, images: nextImages, flags: nextFlags };
          await ctx.updateDoc(current);
        }
        steps.push({
          step: "L0 locals",
          summary: "L0 checked deterministic splits/numbering/image assignment",
          canonicalizedSections: canon.changed,
          delta: { addedCount: 0 },
        });

        // L1 retry (satisfies reparse_section retry precondition even when addedCount === 0)
        const beforeMissing = healthSummary(current).missing;
        let retryResult: any = null;
        if (beforeMissing.length) {
          const before = healthSummary(current);
          const afterDoc = await ctx.retryMissing(current);
          const after = healthSummary(afterDoc);
          const added = beforeMissing.filter((n) => !after.missing.includes(n));
          const addedCount = afterDoc.questions.length - current.questions.length;
          retryResult = { attempted: beforeMissing, added, stillMissing: after.missing, addedCount, callsUsed: 1 };
          steps.push({ step: "retry_missing", ...retryResult, healthBefore: before, healthAfter: after });
          if (ledger) {
            ledger.retriedMissingKeys.add(missingSetFingerprint(beforeMissing, current));
            ledger.retriedMissingKeys.add(missingSetFingerprint(after.missing, afterDoc));
          }
          if (addedCount > 0) {
            await ctx.updateDoc(afterDoc);
            current = afterDoc;
          } else {
            steps.push({ step: "retry_missing zero-add", summary: "Zero added, advancing to L2 inspect", delta: { addedCount: 0 } });
          }
        }

        // L2 inspect: diagnose remaining missing numbers + build filtered actionQueue
        const healthMid = healthSummary(current);
        steps.push({ step: "per-section recheck", health: healthMid, missing: healthMid.missing });
        let pipelineQueue: ActionQueueItem[] = [];
        if (healthMid.missing.length) {
          const diag = diagnoseMissingWithLedger(current, healthMid.missing.slice(0, 20), ledger);
          pipelineQueue = diag.actionQueue;
          steps.push({
            step: "L2 inspect",
            summary: diag.summary,
            diagnosed: diag.data,
            queued: pipelineQueue.map((q) => ({ tool: q.tool, args: q.args })),
            filteredFingerprints: diag.filteredFingerprints,
            delta: { addedCount: 0 },
          });
        }

        // L3 reparse: surface candidate diff preview (autoConfirm strictly false — never auto-applied!)
        const reparseCandidates: any[] = [];
        if (healthMid.missing.length && ctx.reparseSection) {
          const enumRes = enumerateExpectedQuestionNos(current.source.lines);
          const sectionsForMissing = current.sections
            .filter((s) =>
              s.spans.some(([a, b]) =>
                healthMid.missing.some((m) => {
                  const ln = enumRes.lineByNumber.get(m);
                  return ln && ln >= a && ln <= b;
                }),
              ),
            )
            .slice(0, 2);
          for (const sec of sectionsForMissing) {
            let diffPreview: any = undefined;
            if (!getActiveTurnLedger()) {
              // Direct tool invocation: compute diff preview cleanly without auto-applying
              try {
                const candidate = await ctx.reparseSection(current, sec.id);
                const previewDoc = applySectionCandidate(current, candidate);
                diffPreview = {
                  before: sectionDiffView(current, sec.id),
                  after: sectionDiffView(previewDoc, sec.id),
                };
              } catch {}
            }
            const entry = {
              step: "reparse_candidate",
              sectionId: sec.id,
              title: sec.title,
              autoConfirm: false,
              diff: diffPreview,
              summary: `Candidate prepared for ${sec.title} awaiting confirmation`,
              delta: { addedCount: 0 },
            };
            reparseCandidates.push(entry);
            steps.push(entry);
            // Ensure reparse_section is also queued when not filtered so agent executor advances to L3 confirm card in one call
            const fp = computeActionFingerprint("reparse_section", { sectionId: sec.id }, current);
            const alreadyQueued = pipelineQueue.some((i) => i.tool === "reparse_section" && i.args.sectionId === sec.id);
            const alreadyTried = ledger?.executedFingerprints.has(fp) || ledger?.refusedFingerprints.has(fp);
            if (!alreadyQueued && !alreadyTried) {
              pipelineQueue.push({
                tool: "reparse_section",
                args: { sectionId: sec.id },
                rationale: `L3 reparse candidate for ${sec.title} (auto-confirm off; requires UI confirmation)`,
                riskClass: "destructive",
              });
            }
          }
        }

        const finalHealth = healthSummary(current);
        steps.push({ step: "final health", health: finalHealth });
        const totalAdded = steps.reduce((sum, s) => sum + (s.addedCount || s.delta?.addedCount || 0), 0);
        return {
          ok: finalHealth.state === "green" || finalHealth.missing.length === 0,
          summary: `Pipeline: health ${health0.missing.length}→${finalHealth.missing.length} missing, added ${totalAdded}, state ${finalHealth.state}`,
          data: { steps, reparseCandidates, autoConfirm: false, healthBefore: health0, healthAfter: finalHealth, totalAdded },
          delta: { addedCount: totalAdded, stillMissing: finalHealth.missing },
          actionQueue: pipelineQueue,
          suggestedNext: finalHealth.missing.length ? "Confirm reparse candidates or L4 escalate" : "Complete",
        };
      },
    },
    accept_group_representation: {
      description: "{parentQuestionId:string, childNumbers:number[]} mark parent's enumerated children as covered-by-group (writes fact + adjusts coverage inputs locally so health stops crying wolf, questions unchanged)",
      schema: z.object({ parentQuestionId: id, childNumbers: z.array(z.number().int().min(1).max(300)).min(1).max(20) }).strict(),
      access: "mutate",
      execute: async ({ parentQuestionId, childNumbers }) => {
        const doc = ctx.getDoc();
        const parent = doc.questions.find(q=>q.id===parentQuestionId);
        if (!parent) throw new AgentOperationError("questionMissing");
        // Store coverage override
        const overrides = new Set((doc as any).coverageOverrides ? [...(doc as any).coverageOverrides] : []);
        for (const n of childNumbers) if (n!==parent.no) overrides.add(n);
        (doc as any).coverageOverrides = [...overrides];
        // Add flag for health to filter expected
        const flag = { id:`group_cover_${Date.now()}`, code:'GROUP_COVERAGE_ACCEPTED', severity:'info' as const, message:`Group ${parent.no} covers ${childNumbers.join(',')} via ${parentQuestionId}` };
        const newDoc = { ...doc, flags: [...doc.flags, flag] };
        // Also add user fact
        const dossier = ctx.getDossier?.();
        if (dossier && ctx.updateDossier) {
          const fact = `Q${parent.no} group covers ${childNumbers.join(',')}`;
          const updated = { ...dossier, userNotes: [...(dossier.userNotes||[]), fact] };
          await ctx.updateDossier(updated);
        }
        await ctx.updateDoc(newDoc);
        const health = healthSummary(newDoc);
        return { ok:true, summary:`Accepted group ${parent.no} covering ${childNumbers.join(',')}, missing now ${health.missing.length}`, delta:{addedCount:0}, data:{ health } };
      },
    },
    split_group_children: {
      description: "{parentQuestionId:string} deterministically create real child questions from group's enumerated numbers with own id, parentId = root parent id, points = 0, real stem, and clean shared options",
      schema: z.object({ parentQuestionId: id }).strict(),
      access: "mutate",
      execute: async ({ parentQuestionId }) => {
        const doc = ctx.getDoc();
        const res = splitGroupChildrenInDoc(doc, parentQuestionId);
        if (!res.ok || !res.added.length) {
          return { ok: res.ok, summary: res.summary, delta: { addedCount: 0 } };
        }
        await ctx.updateDoc(res.doc);
        const health = healthSummary(res.doc);
        return {
          ok: true,
          summary: res.summary,
          delta: { addedCount: res.added.length, added: res.added },
          data: { added: res.added, health, residueTrimmed: res.residueTrimmed },
        };
      },
    },
    patch_question: {
      description:
        "{questionId,patch:{spans?,points?,type?,options?,rewrites?}} RFC7386 validated patch, no stem text",
      schema: z
        .object({ questionId: id, patch: QuestionMergePatchSchema })
        .strict(),
      access: "mutate",
      execute: ({ questionId, patch: value }) => patch(questionId, value),
    },
    set_question_points: {
      description: "{questionId,points:number>=0}",
      schema: z
        .object({
          questionId: id,
          points: z.number().finite().min(0).max(100000),
        })
        .strict(),
      access: "mutate",
      execute: ({ questionId, points }) => patch(questionId, { points }),
    },
    set_question_type: {
      description:
        "{questionId,type:mcq|truefalse|short|long|fillblank|matching|multi|numeric|diagram|essay|unknown}",
      schema: z
        .object({
          questionId: id,
          type: z.enum([
            "mcq",
            "truefalse",
            "short",
            "long",
            "fillblank",
            "matching",
            "multi",
            "numeric",
            "diagram",
            "essay",
            "unknown",
          ]),
        })
        .strict(),
      access: "mutate",
      execute: ({ questionId, type }) => patch(questionId, { type }),
    },
    assign_image: {
      description: "{imageId,questionId,role:stem|option|table|decoration}",
      schema: z
        .object({
          imageId: id,
          questionId: id,
          role: z.enum(["stem", "option", "table", "decoration"]),
        })
        .strict(),
      access: "mutate",
      execute: async ({ imageId, questionId, role }) => {
        await ctx.updateDoc(
          applyExamMutation(ctx.getDoc(), {
            name: "assign_image",
            imageId,
            questionId,
            role,
          }),
        );
        return { assigned: imageId, questionId, ok:true, summary:`Assigned ${imageId} to ${questionId} as ${role}` };
      },
    },
    mark_image_decoration: {
      description: "{imageId,reason} retained visible, not question content",
      schema: z
        .object({ imageId: id, reason: z.string().min(1).max(300) })
        .strict(),
      access: "mutate",
      execute: async ({ imageId, reason }) => {
        await ctx.updateDoc(
          applyExamMutation(ctx.getDoc(), {
            name: "mark_image_decoration",
            imageId,
            reason,
          }),
        );
        return { decoration: imageId, reason, ok:true, summary:`Marked ${imageId} as decoration` };
      },
    },
    reparse_section: {
      description:
        "{sectionId} DESTRUCTIVE: prepare/validate only this section, show exact diff, wait for explicit confirmation; retry_missing_questions first when coverage is missing",
      schema: z.object({ sectionId: id }).strict(),
      access: "destructive",
      prepare: async ({ sectionId }) => {
        if (!ctx.reparseSection)
          throw new AgentOperationError("prepareUnavailable");
        const before = ctx.getDoc();
        const payload = await ctx.reparseSection(before, sectionId);
        if (payload.sectionId !== sectionId)
          throw new AgentOperationError("invalidCandidate");
        const after = applySectionCandidate(before, payload);
        const old = before.questions.filter((q) => q.sectionId === sectionId);
        const next = after.questions.filter((q) => q.sectionId === sectionId);
        const values = {
          title:
            before.sections.find((s) => s.id === sectionId)?.title || sectionId,
          before: old.length,
          after: next.length,
          removed: old.filter((q) => !next.some((n) => n.id === q.id)).length,
          added: next.filter((q) => !old.some((n) => n.id === q.id)).length,
          changed: next.filter((q) =>
            old.some(
              (n) => n.id === q.id && JSON.stringify(n) !== JSON.stringify(q),
            ),
          ).length,
          beforePoints: old.reduce((n, q) => n + (q.points || 0), 0),
          afterPoints: next.reduce((n, q) => n + (q.points || 0), 0),
        };
        // Compute delta by numbers
        const beforeNos = old.map(q=>q.no);
        const afterNos = next.map(q=>q.no);
        const addedNos = afterNos.filter(n=>!beforeNos.includes(n));
        const removedNos = beforeNos.filter(n=>!afterNos.includes(n));
        const changedNos = next.filter(q=>{
          const o = old.find(x=>x.id===q.id);
          return o && JSON.stringify(o)!==JSON.stringify(q);
        }).map(q=>q.no);
        return {
          baseRevision: examContentRevision(before),
          summary: {
            en: agentText("sectionPreview", "en", values),
            fa: agentText("sectionPreview", "fa", values),
          },
          diff: {
            before: sectionDiffView(before, sectionId),
            after: sectionDiffView(after, sectionId),
          },
          delta: { added: addedNos, removed: removedNos, changed: changedNos, addedCount: addedNos.length, removedCount: removedNos.length, changedCount: changedNos.length },
          payload,
        } as any;
      },
      execute: async ({ sectionId }, prepared) => {
        if (!prepared) throw new AgentOperationError("noPrepared");
        if (prepared.baseRevision !== examContentRevision(ctx.getDoc()))
          throw new AgentOperationError("stale");
        const payload = (prepared as any).payload as SectionCandidate;
        if (payload.sectionId !== sectionId)
          throw new AgentOperationError("invalidCandidate");
        await ctx.updateDoc(applySectionCandidate(ctx.getDoc(), payload));
        const health = healthSummary(ctx.getDoc());
        const delta = (prepared as any).delta;
        return {
          replacedSection: sectionId,
          health,
          ok:true,
          summary: `Replaced section ${sectionId}: added ${delta.addedCount}, removed ${delta.removedCount}, changed ${delta.changedCount}`,
          delta,
        };
      },
    },
    delete_question: {
      description: "{questionId} DESTRUCTIVE requires user confirmation",
      schema: questionId,
      access: "destructive",
      preview: ({ questionId }) => {
        const q = question(questionId);
        return agentText(
          "deletePreview",
          ctx.getSettings().uiLanguage === "fa" ? "fa" : "en",
          {
            no: q.no,
            stem: q.stem || "",
            points: q.points ?? 0,
            before: ctx.getDoc().questions.length,
            after: ctx.getDoc().questions.length - 1,
          },
        );
      },
      execute: async ({ questionId }) => {
        await ctx.updateDoc(
          applyExamMutation(ctx.getDoc(), {
            name: "delete_question",
            questionId,
          }),
        );
        return { deleted: 1, ok:true, summary:`Deleted question ${questionId}` };
      },
    },
    rename_exam: {
      description: "{name} change display name",
      schema: z.object({ name: z.string().min(1).max(200) }).strict(),
      access: "mutate",
      execute: async ({ name }) => {
        await ctx.updateDoc(
          applyExamMutation(ctx.getDoc(), { name: "rename_exam", value: name }),
        );
        return { name, ok:true, summary:`Renamed to ${name}` };
      },
    },
    set_meta: {
      description: "{subject?,grade?,totalPoints?} exam metadata only",
      schema: z
        .object({
          subject: z.string().max(200).optional(),
          grade: z.string().max(100).optional(),
          totalPoints: z.number().finite().min(0).max(100000).optional(),
        })
        .strict(),
      access: "mutate",
      execute: async (args) => {
        await ctx.updateDoc(
          applyExamMutation(ctx.getDoc(), { name: "set_meta", meta: args }),
        );
        return { meta: args, ok:true, summary:`Updated meta ${JSON.stringify(args)}` };
      },
    },
    set_theme_token: {
      description:
        "{token:primary|background|foreground,value:hex or named color}",
      schema: z
        .object({ token: ThemeTokenSchema, value: ColorSchema })
        .strict(),
      access: "mutate",
      execute: async ({ token, value }) => {
        const s = ctx.getSettings();
        await ctx.updateSettings({
          ...s,
          themeTokens: { ...s.themeTokens, [token]: value },
        });
        return {
          applied: token,
          value,
          reset: "Settings → Storage & Privacy → Reset theme",
          ok:true, summary:`Applied theme ${token}=${value}`
        };
      },
    },
    set_language: {
      description: "{language:fa|en} UI language",
      schema: z.object({ language: z.enum(["fa", "en"]) }).strict(),
      access: "mutate",
      execute: async ({ language }) => {
        await ctx.updateSettings({
          ...ctx.getSettings(),
          uiLanguage: language,
        });
        return { language, ok:true, summary:`Language ${language}` };
      },
    },
    set_setting: {
      description:
        "{key:defaultExamMode|livePanel,value:exam|review|boolean}; no provider/key/budget changes",
      schema: z.discriminatedUnion("key", [
        z
          .object({
            key: z.literal("defaultExamMode"),
            value: z.enum(["exam", "review"]),
          })
          .strict(),
        z.object({ key: z.literal("livePanel"), value: z.boolean() }).strict(),
      ]),
      access: "mutate",
      execute: async ({ key, value }) => {
        await ctx.updateSettings({ ...ctx.getSettings(), [key]: value });
        return { key, value, ok:true, summary:`Set ${key}=${value}` };
      },
    },
  };
}
