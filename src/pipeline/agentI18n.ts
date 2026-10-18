/** Human-facing harness copy. Tool names, JSON fields and diagnostic details remain machine-readable. */
export type AssistantLanguage = "en" | "fa";
const messages = {
  working: [
    "Assistant is working on this exam.",
    "دستیار در حال کار روی این آزمون است.",
  ],
  noModel: [
    "Configure a model to chat. Health checks above are local, with zero model calls.",
    "برای گفت‌وگو مدل را تنظیم کنید. گزارش سلامت محلی است و هیچ فراخوانی مدل انجام نشده است.",
  ],
  resumed: [
    "Resumed from local state; an interrupted action was not replayed.",
    "ادامه از وضعیت محلی؛ عمل قطع‌شده دوباره اجرا نشد.",
  ],
  closed: [
    "Assistant view closed; paused safely.",
    "نمای دستیار بسته شد؛ کار با ایمنی متوقف شد.",
  ],
  closedProposal: [
    "Assistant view closed; no proposed actions executed.",
    "نمای دستیار بسته شد؛ هیچ عمل پیشنهادی اجرا نشد.",
  ],
  humanEdit: [
    "Human edits detected. Paused at a fresh observation; send a message to continue.",
    "ویرایش کاربر شناسایی شد. پس از بررسی تازه متوقف شد؛ برای ادامه پیام بفرستید.",
  ],
  humanEditModel: [
    "Human edits detected during model call. Paused; no proposed mutations executed.",
    "هنگام فراخوانی مدل، ویرایش کاربر شناسایی شد؛ هیچ تغییر پیشنهادی اجرا نشد.",
  ],
  malformed: [
    "Malformed tool output; the model can correct it. {details}",
    "خروجی ابزار نامعتبر است؛ مدل می‌تواند آن را اصلاح کند. جزئیات فنی: {details}",
  ],
  forbidden: [
    "Forbidden/unknown tool: {name}. No action executed.",
    "ابزار غیرمجاز یا ناشناخته: {name}. هیچ عملی اجرا نشد.",
  ],
  invalid: [
    "Invalid {name}: {details}",
    "ورودی ابزار {name} نامعتبر است. جزئیات فنی: {details}",
  ],
  readOnly: [
    "Monthly assistant soft cap reached. READ-ONLY tools only; no mutation executed.",
    "سقف ماهانه دستیار رسیده است. فقط ابزارهای خواندنی مجازند؛ هیچ تغییری اجرا نشد.",
  ],
  confirm: ["Confirm {name}: {args}", "عمل {name} را تایید کنید: {args}"],
  toolBound: [
    "Tool bound reached; mutation not executed.",
    "سقف اجرای ابزار رسیده است؛ تغییر اجرا نشد.",
  ],
  stopped: [
    "Assistant stopped safely: {details}. Check health before retrying.",
    "دستیار با ایمنی متوقف شد. پیش از تلاش دوباره سلامت آزمون را بررسی کنید. جزئیات فنی: {details}",
  ],
  preparation: [
    "Preparing a section candidate; the exam is unchanged until you review and confirm the exact diff.",
    "نسخه پیشنهادی بخش در حال آماده‌سازی است؛ تا بررسی تفاوت‌ها و تایید شما آزمون تغییر نمی‌کند.",
  ],
  preparationInterrupted: [
    "Section preparation was interrupted. No candidate was applied; ask again to prepare a new one.",
    "آماده‌سازی بخش قطع شد. هیچ نسخه پیشنهادی اعمال نشد؛ برای آماده‌سازی دوباره پیام بفرستید.",
  ],
  stale: [
    "Exam changed after preparation. Nothing was applied; prepare a new diff.",
    "آزمون پس از آماده‌سازی تغییر کرده است. هیچ تغییری اعمال نشد؛ تفاوت‌ها باید دوباره آماده شوند.",
  ],
  retryFirst: [
    "Missing questions remain. Run retry_missing_questions before an overwrite reparse.",
    "هنوز سوال جاافتاده وجود دارد. پیش از بازتحلیل جایگزین، ابزار retry_missing_questions را اجرا کنید.",
  ],
  prepareUnavailable: [
    "Section reparse is unavailable in this context.",
    "بازتحلیل بخش در این وضعیت در دسترس نیست.",
  ],
  questionMissing: ["Question not found.", "سوال پیدا نشد."],
  noSection: ["Section not found.", "بخش پیدا نشد."],
  emptySection: [
    "Section has no safe source lines to reparse.",
    "بخش، خط منبع امنی برای بازتحلیل ندارد.",
  ],
  invalidCandidate: [
    "Section candidate failed local validation. Nothing was changed.",
    "نسخه پیشنهادی بخش در اعتبارسنجی محلی رد شد. چیزی تغییر نکرد.",
  ],
  noPrepared: [
    "No prepared candidate exists. Prepare and review a new diff first.",
    "نسخه پیشنهادی آماده‌ای وجود ندارد. ابتدا تفاوت‌های تازه را آماده و بررسی کنید.",
  ],
  folderUsage: [
    "Could not read folder usage totals; assistant paused safely.",
    "مجموع مصرف پوشه خوانده نشد؛ دستیار با ایمنی متوقف شد.",
  ],
  examMissing: [
    "Exam no longer exists in folder.",
    "آزمون دیگر در پوشه وجود ندارد.",
  ],
  usageWrite: [
    "Could not persist assistant usage in the exam audit trail.",
    "ثبت مصرف دستیار در گزارش آزمون انجام نشد.",
  ],
  snapshotExpired: [
    "Undo snapshot expired (last 10 retained). Use Versions in Step 4.",
    "نسخه بازگشت منقضی شده است (۱۰ نسخه آخر نگه‌داری می‌شوند). از نسخه‌های گام ۴ استفاده کنید.",
  ],
  deletePreview: [
    "Delete exactly 1 question: {no}. {stem} ({points} points). Images retained. Children become roots. Questions {before} → {after}.",
    "حذف دقیقاً ۱ سوال: {no}. {stem} (نمره {points}). تصاویر نگه داشته می‌شوند و زیرسوال‌ها مستقل می‌شوند. تعداد سوال‌ها {before} ← {after}.",
  ],
  sectionPreview: [
    "Replace section {title}: {before} → {after} questions; {removed} removed, {added} added, {changed} changed; points {beforePoints} → {afterPoints}. Review the complete before/after diff below. No changes yet.",
    "جایگزینی بخش {title}: تعداد سوال‌ها از {before} به {after}؛ {removed} حذف، {added} اضافه و {changed} تغییر؛ نمره از {beforePoints} به {afterPoints}. تفاوت کامل پیش و پس را در پایین بررسی کنید. هنوز تغییری اعمال نشده است.",
  ],
} as const;
export type AgentMessageKey = keyof typeof messages;
export function agentText(
  key: AgentMessageKey,
  language: AssistantLanguage,
  values: Record<string, string | number> = {},
): string {
  const template: string = messages[key][language === "fa" ? 1 : 0];
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(values[name] ?? ""),
  );
}
export class AgentOperationError extends Error {
  constructor(
    public readonly code: AgentMessageKey,
    public readonly values: Record<string, string | number> = {},
  ) {
    super(agentText(code, "en", values));
  }
}
export function assistantError(
  error: unknown,
  language: AssistantLanguage,
): string {
  if (error instanceof AgentOperationError)
    return agentText(error.code, language, error.values);
  const detail = String(error)
    .replace(/^Error:\s*/, "")
    .slice(0, 500);
  // Proxy/lease/CAS errors are deterministic English diagnostics, not source text.
  if (detail.includes("another tab") || detail.includes("Lease owner"))
    return language === "fa"
      ? "دستیار در زبانه دیگری در حال کار است؛ پس از پایان دوباره تلاش کنید. قفل رهاشده پس از ۹۰ ثانیه آزاد می‌شود."
      : detail;
  if (detail.includes("bound reached") || detail.includes("budget"))
    return language === "fa"
      ? "سقف فراخوانی مدل رسیده است؛ دستیار با ایمنی متوقف شد. سلامت آزمون را بررسی کنید."
      : detail;
  if (detail.includes("HTTP 409") || detail.includes("Human edits changed"))
    return agentText("stale", language);
  return language === "fa" ? `عمل انجام نشد. جزئیات فنی: ${detail}` : detail;
}
export function verificationText(
  before: {
    expected: number;
    parsed: number;
    missing: number[];
    points: number;
    totalPoints?: number;
  },
  after: typeof before & { state: string },
  bounded: boolean,
  language: AssistantLanguage,
): string {
  return language === "fa"
    ? `${bounded ? "سقف اجرا رسیده است؛ متوقف شد. " : ""}${after.state === "green" ? "سلامت کامل به‌صورت محلی تایید شد" : "ناقص — نیازمند بررسی"}: انتظار از ${before.expected} به ${after.expected}، استخراج از ${before.parsed} به ${after.parsed}، جاافتاده از ${before.missing.length} به ${after.missing.length}، نمره از ${before.points}/${before.totalPoints ?? "نامشخص"} به ${after.points}/${after.totalPoints ?? "نامشخص"}.`
    : `${bounded ? "Bounds reached; stopped. " : ""}${after.state === "green" ? "Verified green" : "Partial — needs review"}: expected ${before.expected} → ${after.expected}, parsed ${before.parsed} → ${after.parsed}, missing ${before.missing.length} → ${after.missing.length}, points ${before.points}/${before.totalPoints ?? "?"} → ${after.points}/${after.totalPoints ?? "?"}.`;
}
