import { z } from "zod";
import { AppSettings, ExamDoc } from "../types";
import { healthSummary, ToolRegistry } from "./agent";
import {
  applyValidatedQuestionPatch,
  QuestionMergePatchSchema,
  applyExamMutation,
} from "./patch";
import { ColorSchema, ThemeTokenSchema } from "./agentTheme";
import { lineNumber, examContentRevision } from "./quality";
import { agentText, AgentOperationError } from "./agentI18n";
import {
  applySectionCandidate,
  SectionCandidate,
  sectionDiffView,
} from "./reparseSection";
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
  updateDoc: (doc: ExamDoc) => Promise<void>;
  updateSettings: (s: AppSettings) => Promise<void>;
  retryMissing: (doc: ExamDoc) => Promise<ExamDoc>;
  reparseSection?: (
    doc: ExamDoc,
    sectionId: string,
  ) => Promise<SectionCandidate>;
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
      description: "{} → local counts/points/images/health",
      schema: empty,
      access: "read",
      execute: () => healthSummary(ctx.getDoc()),
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
    retry_missing_questions: {
      description: "{} → additive existing coverage retry (no OCR/vision)",
      schema: empty,
      access: "mutate",
      execute: async () => {
        const doc = await ctx.retryMissing(ctx.getDoc());
        await ctx.updateDoc(doc);
        return healthSummary(doc);
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
        return { assigned: imageId, questionId };
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
        return { decoration: imageId, reason };
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
          payload,
        };
      },
      execute: async ({ sectionId }, prepared) => {
        if (!prepared) throw new AgentOperationError("noPrepared");
        if (prepared.baseRevision !== examContentRevision(ctx.getDoc()))
          throw new AgentOperationError("stale");
        const payload = prepared.payload as SectionCandidate;
        if (payload.sectionId !== sectionId)
          throw new AgentOperationError("invalidCandidate");
        await ctx.updateDoc(applySectionCandidate(ctx.getDoc(), payload));
        return {
          replacedSection: sectionId,
          health: healthSummary(ctx.getDoc()),
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
        return { deleted: 1 };
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
        return { name };
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
        return { meta: args };
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
        return { language };
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
        return { key, value };
      },
    },
  };
}
