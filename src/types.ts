/**
 * ExamParse Data Model & Type Definitions
 * Strictly implements §4 and §7 of specifications
 */

/**
 * Stage 2.5 cleanup tags. Tags are JUDGMENTS applied to line objects by deterministic
 * code: the line's id, text and position are never changed, so tagging is reversible.
 */
export type LineTag =
  | 'keep' | 'junk' | 'suspect-junk' | 'furniture' | 'pagenum' | 'key'
  | 'header' | 'instruction' | 'question' | 'option' | 'passage' | 'dialogue' | 'table-row';
export type LineTagSource = 'local' | 'ai' | 'user';

export type SourceLine = {
  id: string; // e.g. "L0001"
  page: number;
  text: string;
  y?: number;
  pageHeight?: number; // PDF coordinate height, for conservative header/footer-only furniture
  furniture?: boolean;
  layoutWarning?: string;
  /** Cleanup verdict (A2/A3). Absent ⇒ untagged ⇒ behaves exactly like the pre-cleanup pipeline. */
  tag?: LineTag;
  tagSource?: LineTagSource;
  /** AI confidence digit 0–9 for the verdict (local tags omit it). */
  tagConf?: number;
  /** Local readability signal (D1): ≥30% tokens with mixed-script glue / U+FFFD / watermark residue. */
  garbled?: boolean;
};

export interface OffsetSpan {
  line: number;
  /** Optional 0-based start offset (inclusive) in normalized line text. */
  start?: number;
  /** Optional 0-based end offset (exclusive) in normalized line text. */
  end?: number;
}

export type LineSpan = [number, number] | OffsetSpan; // inclusive start/end, 1-based (e.g. [41, 45]) or sub-line offset span

export interface ExamSection {
  id: string;
  index: number;
  title?: string;
  instructions?: string;
  /** Section total parsed from the section header when available. */
  points?: number;
  /** Locally sliced reading passage / listening dialogue; never copied from model output. */
  passage?: string;
  spans: LineSpan[];
}

export interface QuestionReceipt {
  lineStart: number;
  lineEnd: number;
  /** Deterministic rule ids in firing order; optional for legacy documents. */
  ruleChain: string[];
  /** Local rule score on a 0–100 scale, never a model confidence value. */
  ruleConfidence: number;
}

export interface Question {
  id: string;
  label: string; // original label, e.g. "۱", "1.", "Q1"
  no: number; // numeric order
  parentId?: string; // for sub-questions
  sectionId?: string;
  spans: LineSpan[]; // stem location(s) in source
  stem?: string; // assembled locally from spans + rewrites
  points?: number;
  type:
    | 'mcq'
    | 'truefalse'
    | 'short'
    | 'long'
    | 'fillblank'
    | 'matching'
    | 'multi'
    | 'numeric'
    | 'diagram'
    | 'essay'
    | 'unknown';
  options?: {
    key: string;
    spans: LineSpan[];
    text?: string;
  }[];
  subQuestions?: Question[];
  answer?: {
    spans?: LineSpan[];
    text?: string;
    source: 'paper' | 'keyfile' | 'manual' | 'ai';
  };
  tables?: {
    html: string;
    spans: LineSpan[];
  }[];
  images: {
    imageId: string;
    role: 'stem' | 'option' | 'table' | 'decoration';
    anchorLine?: number;
  }[];
  rewrites?: {
    line: number;
    text: string;
  }[]; // only normalized lines
  confidence: number; // 0..1 from model
  /** Optional deterministic provenance; legacy persisted questions need not carry it. */
  receipt?: QuestionReceipt;
  flags?: string[];
}

export interface ImageAsset {
  id: string;
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
  mime: string;
  sha: string;
  width: number;
  height: number;
  anchorLine?: number; // nearest source line computed from coordinates
  imageFlags?: string[]; // deterministic extraction warnings (e.g. suspicious strip)
  duplicateOf?: string; // dedupe by sha or perceptual hash
  dHash?: string; // stable perceptual hash, used to identify repeated page furniture locally
  label?: {
    role: Question['images'][number]['role'];
    questionRef?: string;
    caption?: string;
    /** Short local/model justification required when marked as decoration. */
    reason?: string;
    kind?: 'photo' | 'diagram' | 'chart' | 'table' | 'formula' | 'handwriting' | 'decoration';
    needsText?: boolean;
  };
  blobKey: string; // Folder image key; binary is NEVER base64'd into JSON exports
  dataUrl?: string; // cached in-memory preview
}

export interface Flag {
  id: string;
  severity: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  questionId?: string;
}

export interface UsageRecord {
  ts: string;
  role: 'fast' | 'standard' | 'escalation' | 'vision' | 'ocr' | 'patch' | 'agent' | 'critic' | 'consensus' | 'cleanup';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  label: string;
  isCachedHit?: boolean;
  /** Optional dedupe key: at most one global-log record per key (cached hits replace their timestamp). */
  dedupeKey?: string;
}

export interface ExamMeta {
  title?: string;
  subject?: string;
  grade?: string;
  school?: string;
  term?: string;
  year?: string;
  durationMinutes?: number;
  totalPoints?: number;
  language: string; // 'fa' | 'ar' | 'en' | etc.
  direction: 'ltr' | 'rtl';
  headerLines?: [number, number][];
}

export interface ExamDoc {
  id: string;
  fileHash: string;
  createdAt: string;
  /** Human-facing exam name derived from AI meta (or set manually via Library rename). */
  displayName: string;
  nameSource?: 'ai' | 'manual';
  meta: ExamMeta;
  sections: ExamSection[];
  questions: Question[];
  images: ImageAsset[];
  source: {
    diagnostics?: import('./pipeline/extractionQuality').ExtractionDiagnostics;
    lines: SourceLine[];
    pages: number;
    ocrUsed: boolean;
    fileName: string;
    pageImages?: string[]; // rendered page preview data URLs (legacy / in-memory only; stripped on persist)
    pageThumbKeys?: string[]; // blob keys (thumb_{fileHash}_{page}) for saved page renders
    /** Deterministic pre-key printed-number tripwire, persisted for health banners and retry. */
    expectedQuestionNos?: number[];
    /** 1-based LAS line numbers belonging to official key territory. */
    keyTerritoryLineNos?: number[];
    /** B3: lines that belong to nothing after gap completion (excluding furniture/pagenum/key/junk). */
    orphanLineNos?: number[];
    /** A4: user-flipped cleanup verdicts (line → tag); respected by re-runs via the pipeline cache. */
    cleanupOverrides?: Record<string, LineTag>;
    /** Stage 2.5 summary for the stage card / bench (lines judged, junk, tokens saved). */
    cleanupStats?: { judged: number; junk: number; suspect: number; fenceSaved: number; aiSkipped: boolean; linesBefore: number; linesAfter: number; tokensBefore: number; tokensAfter: number; source: 'off' | 'local' | 'ai' | 'cached' };
    /** Marvel Batch 6 Fix 1c: final-pass shape audit counts, persisted for `getExamHealth`/banner. */
    finalShapeAudit?: { optionIncludesStem: number; duplicateSiblingStems: number; overlongStems: number };
  };
  flags: Flag[];
  /**
   * Persisted demotion marker: true when the save boundary found error-severity
   * invariant violations. Persistence is never refused for this — completeness and
   * export affordances read this + the PARTIAL_EXAM flag.
   */
  partial?: boolean;
  usage: UsageRecord[];
  modelInfo?: { fast?: string; escalation?: string; vision?: string };
  /** 2B/2F: critic verdicts (last 3/question) + per-question provenance traces. */
  guidanceTokens?: number;
  verdicts?: Record<string, any[]>;
  traces?: any[];
}

/** Strip a trailing file extension, e.g. "exam.pdf" -> "exam". */
export function fileNameWithoutExtension(fileName?: string | null): string {
  return (fileName || '').replace(/\.[^/.]+$/, '');
}

function nonEmpty(value?: string | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Compute a display name from AI-extracted meta + file name (no API call):
 * [subject, grade] joined with " — " -> subject alone -> meta.title -> file name (no extension).
 */
export function computeDisplayName(
  meta?: Partial<ExamMeta> | null,
  fileName?: string | null
): string {
  const parts = [nonEmpty(meta?.subject), nonEmpty(meta?.grade)].filter(Boolean);
  if (parts.length > 0) return parts.join(' \u2014 ');
  const title = nonEmpty(meta?.title);
  if (title) return title;
  return fileNameWithoutExtension(fileName) || 'Exam';
}

/**
 * Display name for any ExamDoc, applying the AI-meta fallback chain for
 * legacy docs that lack the displayName field.
 */
export function getDisplayName(
  doc?: (Partial<ExamDoc> & { meta?: Partial<ExamMeta>; source?: { fileName?: string } }) | null
): string {
  if (!doc) return 'Exam';
  const stored = nonEmpty((doc as ExamDoc).displayName);
  if (stored) return stored;
  return computeDisplayName(doc.meta as Partial<ExamMeta>, doc.source?.fileName);
}

/** Make a string safe to use as a download file name (keeps Unicode letters such as Persian/Arabic). */
export function sanitizeFileName(name: string): string {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || 'Exam';
}

/**
 * Provider & Settings Types (§7 & §3)
 */
export type ProviderKind = 'gemini' | 'openai-compatible';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  apiKey: string; // stored locally
  defaultHeaders?: Record<string, string>;
  /** When true (default), reasoning/thinking is disabled (or minimised for the solver) on OpenAI-compatible calls. */
  disableReasoning?: boolean;
  /** Send OpenAI-compatible response_format JSON mode unless explicitly disabled. */
  structuredOutputs?: boolean;
  /** Raw JSON object string shallow-merged last into chat-completions bodies (user keys win). */
  extraBodyJson?: string;
}

export interface RoleModelSelection {
  providerId: string;
  model: string;
}

export interface RoleMapping {
  fast: RoleModelSelection;
  standard: RoleModelSelection;
  escalation: RoleModelSelection;
  vision: RoleModelSelection;
  agent?: RoleModelSelection;
  /** 2B/2C: optional roles; defaults — critic→escalation, consensus→distinct model else escalation. */
  critic?: RoleModelSelection;
  consensus?: RoleModelSelection;
  /** A2: cleanup role (defaults to the fast/structure model). */
  cleanup?: RoleModelSelection;
}

export interface CostRate {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export type CostTable = Record<string, CostRate>;

export interface TokenThriftSettings {
  latexNormalization: boolean;
  maxImagesPerVisionCall: number;
  imageMaxLongEdge: number;
  jpegQuality: number;
  cacheEnabled: boolean;
}

export interface BudgetSettings {
  maxUsdPerRun: number; // hard stop if estimate exceeds
  maxOutputTokens: number;
}

export interface DocSettings {
  defaultLanguage: 'auto' | 'ltr' | 'rtl';
  paperSize: 'A4' | 'Letter';
  fontSize: 'small' | 'medium' | 'large';
}

export interface AppSettings {
  providers: ProviderConfig[];
  roleMapping: RoleMapping;
  costTable: CostTable;
  thrift: TokenThriftSettings;
  budget: BudgetSettings;
  document: DocSettings;
  assistantMonthlySoftCapUsd?: number;
  /** 2E: bounded section parallelism (1–6, default 3). */
  parallelSections?: number;
  /** 2C: consensus toggle (default ON only when a distinct consensus model exists). */
  consensusEnabled?: boolean;
  themeTokens?: Partial<Record<'primary' | 'background' | 'foreground', string>>;
  /** Manual light/dark override; system follows prefers-color-scheme. */
  themeMode?: 'system' | 'light' | 'dark';
  uiLanguage?: 'fa' | 'en';
  defaultExamMode?: 'exam' | 'review';
  livePanel?: boolean;
  agentLimits?: { maxModelCalls?: number; maxToolExecutions?: number };
  /** A4/F3: Stage 2.5 cleanup on/off (default on). Off ⇒ no tags, byte-identical pre-cleanup behaviour. */
  cleanupEnabled?: boolean;
}

/**
 * LLM Request & Response Abstraction (§7)
 */
export interface LLMRequest {
  role: 'fast' | 'standard' | 'escalation' | 'vision' | 'ocr' | 'patch' | 'agent' | 'critic' | 'consensus' | 'cleanup';
  system: string;
  text: string;
  images?: {
    id: string;
    mime: string;
    data: string; // base64 string without data prefix
  }[];
  jsonSchema?: object;
  maxOutputTokens?: number;
  stream?: boolean;
  label: string; // for the usage log
  providerConfig?: {
    id: string;
    name: string;
    kind: ProviderKind;
    baseURL?: string;
    apiKey?: string;
    defaultHeaders?: Record<string, string>;
    model: string;
    agentBudgetId?: string;
    agentMaxCalls?: number;
    disableReasoning?: boolean;
    structuredOutputs?: boolean;
    extraBodyJson?: string;
  };
}

export interface LLMResponse {
  json: unknown;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  /** Request label, with a ladder suffix (e.g. " [r-min]") when a reasoning fallback rung succeeded. */
  label?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
  rawText: string;
  reasoningText?: string;
  finishReason?: string;
}

/**
 * Pipeline Stage State
 */
export type PipelineStageId = 'extract' | 'ocr' | 'cleanup' | 'structure' | 'vision' | 'assemble' | 'repair';

export interface StageStatus {
  id: PipelineStageId;
  name: string;
  status: 'idle' | 'running' | 'completed' | 'completed-with-problems' | 'partial' | 'skipped' | 'failed' | 'cached';
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  message?: string;
  /** Number of attempts made for this stage (>1 when a retry fired). */
  attempts?: number;
}
