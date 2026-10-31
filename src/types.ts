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
  /** #50 Part C: model-facing twin (Arabic-Indic/Persian digits → Latin; corrupt digit runs → U+FFFD).
   * Absent ⇒ identical to `text`. `text` itself is never rewritten by normalization. */
  normalized?: string;
  /** #50 Part C: a digit run contained a known-corrupt glyph (rendered as U+FFFD in `normalized`). */
  digitSuspect?: boolean;
  /** #50 Part C: watermark shape (one token/domain repeated ≥3×); furniture, excluded from model prompts. */
  watermark?: boolean;
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
  points?: number | null;
  /** Original package fields, retained verbatim and never used as model-authored provenance. */
  imported?: Record<string, any>;
  /** Offsets into the imported stem for inline image references. */
  packageSourceTextLength?: number;
  packageImagePositions?: Array<{ imageId: string; offset: number }>;
  tags?: string[];
  optionalGroupId?: string;
  optionalBranch?: string;
  enrichment?: QuestionEnrichment;
  explanation?: { text: string; source: 'model' };
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
    /** Standalone interchange references to option-owned picture assets. */
    imageRefs?: string[];
  }[];
  /** Map-proposed shared instructions applicable to this question. */
  instructionGroups?: string[];
  passageId?: string;
  /** Optional shared or inline word-bank items associated with fill-in-the-blank questions. */
  wordBank?: string[];
  subQuestions?: Question[];
  /** #57 Part A / #58 — sample answer for a descriptive (tashrihi) item.
   * `model` proposals are non-executing and may only travel while verified; `teacher` is the
   * explicit save; `paper`/`keyfile`/`manual` are genuine source samples (never labelled model).
   * `evidence` is the fingerprint of the material the judge actually saw (#58 Part B). */
  sampleAnswer?: { text: string; source: 'model' | 'teacher' | 'paper' | 'keyfile' | 'manual'; judged: 'verified' | 'uncertain' | 'rejected' | 'unjudged'; probability?: number; evidence?: string; stale?: boolean; reconfirm?: boolean };
  /** #57 Part A / #58 — 2–4 graded criteria (bank RubricCriterion shape) for the same item. */
  rubric?: { criteria: RubricCriterion[]; source: 'model' | 'teacher' | 'paper' | 'keyfile' | 'manual'; judged: 'verified' | 'uncertain' | 'rejected' | 'unjudged'; probability?: number; evidence?: string; stale?: boolean; reconfirm?: boolean };
  answer?: {
    spans?: LineSpan[];
    text?: string;
    source: 'paper' | 'keyfile' | 'manual' | 'ai';
    /** #58 — an AI Solve value is a proposal: it may never populate an executable field. */
    nonExecuting?: boolean;
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
  confidence: number; // 0..1 from model (package imports persist null when unjudged)
  difficulty?: { value: 1 | 2 | 3 | 4 | 5; source: 'model'; /** #50: flat level distribution (top level < 0.4). */ uncertain?: boolean };
  difficultyMode?: 'shadow' | 'active';
  curriculumHints?: import('./pipeline/curriculumHints').CurriculumHints;
  /** #57 Part E — 'inherited' marks a lesson that came from the factored passage judgement,
   * never from this question's own (abstaining) vote. Teacher/individual votes always win. */
  curriculumSource?: 'keyword' | 'decision' | 'inherited';
  /** Optional deterministic provenance; legacy persisted questions need not carry it. */
  receipt?: QuestionReceipt;
  flags?: string[];
}

/** #57 Part A — one rubric criterion in the Appendix-A bank shape. */
export interface RubricCriterion {
  criterion: string;
  /** Absent means retained text-only/unpriced proposal; never a scored rubric. */
  maxPoints?: number;
}

export interface QuestionEnrichment {
  source: 'model';
  verification: 'verified' | 'disagreed' | 'uncertain' | 'unjudged';
  /** #58 Part B — fingerprint of the evidence these verdicts were produced from. A mismatch
   * invalidates every judged state on this question (never silently reused as verified). */
  evidence?: string;
  verificationProbability?: number;
  checkerChoice?: string;
  /** #57 Part B — a proposal for a keyless auto-graded item. Review payload ONLY:
   * never copied into answer / answer_key / correctFillBlanks by any code path, including re-export.
   * Adoption is a teacher action in Step 4 (`adopted` marks their save). */
  proposedAnswer?: {
    text: string; source: 'model'; probability?: number; adopted?: boolean;
    /** #58 — the decision check of the proposal, still review-only and evidence-bound. */
    check?: { state: 'verified' | 'uncertain' | 'rejected' | 'unjudged'; probability?: number; evidence?: string };
  };
  difficultyUncertain?: boolean;
  explanationCheck?: { state: 'verified' | 'rejected' | 'uncertain' | 'unjudged'; probability?: number; evidence?: string };
  completeness?: { probability: number };
  lessons?: Array<{ lesson: string; probability: number }>;
  lessonDistribution?: Record<string, number>;
  origin?: 'single' | 'multi' | 'beyond-book' | 'unknown';
  demand?: { value: 'recall' | 'comprehension' | 'inference'; probability: number; distribution?: Record<string, number> };
  readingMode?: { value: 'direct-finding' | 'comprehension'; probability: number; distribution?: Record<string, number> };
  teacherLesson?: { lesson: string; source: 'teacher' };
  imagePlacement?: Array<{ imageId: string; state: 'verified' | 'disagreed' | 'uncertain' | 'skipped-no-evidence'; probability?: number; choice?: string }>;
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
    /** Part A: segment chosen by pre-structure vision (provisional; ownership is decided later). */
    segmentRef?: string;
    /** Part A: vision verdicts are provisional until Part B decides ownership. */
    provisional?: boolean;
    /** Local/vision/geometry provenance of the label. */
    source?: 'geometry' | 'vision' | 'user';
    /** Part B: assignment receipt (rule chain) shown in the image inspector. */
    assignment?: {
      questionId?: string;
      questionLabel?: string;
      groupId?: string;
      order?: number;
      ruleChain: string[];
      caption?: string;
      note?: string;
    };
  };
  blobKey: string; // Folder image key; binary is NEVER base64'd into JSON exports
  dataUrl?: string; // cached in-memory preview
  /** True when the image blob was missing or failed to write to local folder storage (recoverable from source). */
  storageMissing?: boolean;
  packageShared?: { ownerIds: string[]; structural: boolean };
  exportPath?: string; // relative path reference in JSON exports
  localUrl?: string; // local folder-storage endpoint reference (/api/images/<blobKey>)
}

export interface Flag {
  id: string;
  severity: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  questionId?: string;
  /** Set when the row is about one image asset (image tray/tests can jump straight to it). */
  imageId?: string;
  rootCauseId?: string;
}

/**
 * Canonical LLM request/usage roles. Server validation MUST use this list so
 * pipeline roles cannot drift out of the whitelist again.
 */
export const LLM_ROLES = [
  'fast',
  'standard',
  'escalation',
  'vision',
  'ocr',
  'patch',
  'agent',
  'critic',
  'consensus',
  'cleanup',
  'text-repair',
  /** Canonical #39 spine roles. Legacy roles remain accepted for old saved journals only. */
  'read',
  'meta',
  'cloud',
  'repair',
  /** #43 decision audit role: votes with probabilities, never authors or repairs text. */
  'decide',
  'classify',
] as const;
export type LLMRole = (typeof LLM_ROLES)[number];

export interface UsageRecord {
  ts: string;
  role: LLMRole;
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
  gradeDisplay?: string;
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
  /** Map-proposed shared text, with ranges retained for question-level ownership. */
  instructionGroups?: Array<{ appliesToFirst: number; appliesToLast: number; text: string }>;
  optionalGroups?: Array<{ id: string; rule: 'choose-one-branch' | 'choose-one-per-number' | 'unknown'; memberLabels: string[]; branches: Record<string, string[]>; printedTotal?: number }>;
  passages?: Array<{ id: string; sectionTitle: string; text: string; appliesToFirst?: number; appliesToLast?: number }>;
  questions: Question[];
  images: ImageAsset[];
  source: {
    kind?: 'package' | 'pdf' | 'word';
    packageBatchId?: string;
    /** #58 — part folders of a multipart native export (>50 questions) merged into this one exam. */
    packageParts?: string[];
    packageMultipartStatus?: 'complete' | 'partial-unverified';
    packageJsonHash?: string;
    packageBatchImport?: boolean;
    packageDataset?: string;
    packageIdentity?: { grade?: unknown; subject?: unknown; title?: unknown };
    packageSectionReceipt?: { rule: 'explicit' | 'title-suffix' | 'marker' | 'fallback'; sections: Array<{ title: string; questionNumbers: number[] }> };
    packageScriptReceipt?: Array<{ label: string; sectionId: string | null }>;
    packageStructureReceipt?: { labelsPreserved: number; optionalGroups: NonNullable<ExamDoc['optionalGroups']>; collisions: Array<{ number: number; labels: string[] }> };
    enrichmentStatus?: 'not run' | 'completed' | 'partial';
    enrichmentNotes?: string[];
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
    /** Stage 2.75 overlays keyed by 1-based source line number; source.lines always retain originals. */
    lineRepairs?: Record<string, string>;
    textRepairStats?: import('./pipeline/textRepair').TextRepairStats;
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
  /** Part A: set to 'PARTIAL-STORAGE' when metadata persisted but >=1 image blob write failed. */
  storageState?: 'PARTIAL-STORAGE';
  failedImageIds?: string[];
  exportMeta?: {
    binariesStripped: boolean;
    imageMode: string;
    imageCount: number;
    note: string;
  };
  usage: UsageRecord[];
  modelInfo?: { fast?: string; escalation?: string; vision?: string };
  /** Godlike-1 B1/B3: set when this exam was promoted to the local test corpus. */
  corpus?: { slug: string; promotedAt: string };
  /** 2B/2F: critic verdicts (last 3/question) + per-question provenance traces. */
  guidanceTokens?: number;
  verdicts?: Record<string, any[]>;
  traces?: any[];
  /** Legacy receipts remain readable; never produced by the #46 default path. */
  spine?: SpineRecord;
  /** #46/#51 raw authored working document, six-phase receipt, and comment-only verdicts. */
  loop?: import('./pipeline/localLoop').LoopReceipt;
}

export type SpinePageReadStatus = 'local ok' | 'cloud ok' | 'failed';

export interface SpinePageReadRecord {
  page: number;
  status: SpinePageReadStatus;
  cached?: boolean;
  /** Total read calls for this page (local attempts + retries + cloud rescue). */
  calls: number;
  /** Actual Global Read wire format used for this page. */
  format?: 'compact' | 'verbose';
  /** Output tokens spent on this page, including retries and any cloud rescue. */
  outputTokens?: number;
  /** Cloud rescue calls among `calls` (#41). */
  cloudCalls?: number;
  /** #42: cloud attempts spent on this page's rescue (1, or 2 after one transient-failure retry). */
  cloudAttempts?: number;
  /** #42: the provider/transport error (e.g. "503 Service Unavailable") — weather, distinguished from refusal. */
  cloudError?: string;
  /** Running total of read calls across the exam up to and including this page (#41). */
  runningCalls?: number;
  /** Validator complaint / error from EACH local attempt, kept even when cloud rescued the page (#41). */
  localComplaints?: string[];
  questions: number;
  reason?: string;
}

/** Global Read receipt. `fallback` is retained for old documents; #39/#40 never take a parser fallback. */
export interface SpineClassifyRecord {
  status: 'completed' | 'cached' | 'partial' | 'fallback' | 'unavailable' | 'skipped';
  provider?: string;
  model?: string;
  calls: number;
  cloudCalls?: number;
  labelledLines?: number;
  /** Plain reason when status is fallback/unavailable/skipped/partial. */
  reason?: string;
  /** #40: per-page Global Read status for every sheet. */
  pages?: SpinePageReadRecord[];
  /** Serialized validated proposals keyed by page number so single-page retry never re-reads other pages. */
  pageProposals?: Record<string, string>;
  /** #41: the Global Read's own per-exam call allowance (pages × 3 + 6). Not shared with Assistant limits. */
  readAllowance?: number;
}

export interface SpineRepairRecord {
  status: 'completed' | 'cached' | 'skipped' | 'no-defects';
  rounds: number;
  calls: number;
  /** #42: every well-formed operation the model proposed; equals accepted + rejected + deduped. */
  opsProposed?: number;
  opsAccepted: number;
  opsRejected: number;
  /** #42: identical operations (kind + targets) not re-validated or re-counted as fresh proposals. */
  opsDeduped?: number;
  /** #42: operation kinds abandoned for a round after 10 rejections of that kind. */
  abandonedKinds?: string[];
  /** #42: checked defects dropped before repair because they lie wholly on read-failed pages. */
  droppedReadFailedDefects?: number;
  escalations: number;
  defectsRemaining: number;
  remainingKinds: string[];
}

export type CompileStatus = 'ok' | 'ok-reconciled' | 'partial' | 'read-failed';

export interface CompileSpineRecord {
  reconciliations: number;
  byKind: Record<string, number>;
  pages: Array<{ page: number; status: CompileStatus }>;
  /** Targeted re-ask calls spent by the compiler (read + cloud), outside the read allowance and repair budget. */
  calls: number;
  /** Compile survivors that repair could not close — handed to the teacher. */
  defectsRemaining: number;
}

export type AuditMode = 'skipped' | 'shadow' | 'active';

export interface AuditSummary {
  mode: AuditMode;
  skipReason?: string; // set when mode === 'skipped'
  decisions: number; // catalogue items decided (cache hits count)
  catches: number; // confident-wrong items (<= 0.20) turned into defects
  uncertain: number; // items in the 0.20-0.80 band
  meanLatencyMs: number;
  inputTokens: number; // input-only token estimate
  estimatedCostUsd: number; // input-only cost at the model's rate
  transportError?: string; // configured but unreachable; nothing routed
  /** Shadow only: agreement with the generative pipeline's own outcome, per catalogue item. */
  agreementByItem?: Record<string, { agreements: number; decisions: number; rate: number }>;
}

export interface SpineRecord {
  classify: SpineClassifyRecord;
  repairLoop: SpineRepairRecord;
  /** #43 deterministic reconciliation of page proposals (compile → correct). */
  compile?: CompileSpineRecord;
  /** #43 decision audit summary (skipped when no decide role is configured). */
  audit?: AuditSummary;
  /** Shared executor budget accounting (model calls / weighted units) across classify + repair. */
  budget: { calls: number; units: number; maxCalls: number; maxUnits: number };
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
  const parts = [nonEmpty(meta?.subject), nonEmpty(meta?.gradeDisplay || meta?.grade)].filter(Boolean);
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
  /** #43: the decisions endpoint path on baseURL (e.g. /v1/decisions or /v1/systemone). Defaults to /v1/decisions. */
  decisionsPath?: string;
  /** Decision request dialect. Defaults to the existing JEV/OpenAI-shaped array protocol. */
  decideDialect?: 'jev' | 'thx';
  /** Maximum simultaneous decision requests. Local THX defaults to one. */
  decideConcurrency?: number;
  /** #46 mmproj-capable decisions build. Off means image decisions are skipped (no pixels, no vote). */
  multimodalDecisions?: boolean;
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
  /** #39: one whole-document semantic read; defaults to the fast mapping. */
  read?: RoleModelSelection;
  /** Tiny metadata reads; defaults to read. */
  meta?: RoleModelSelection;
  /** Defect-only escalation; defaults to escalation. */
  cloud?: RoleModelSelection;
  /** Local defect repair; defaults to read. */
  repair?: RoleModelSelection;
  /** #43 decision audit (base URL + model; POSTs to the provider's decisions path). Defaults to read. */
  decide?: RoleModelSelection;
  /** Legacy setting retained only so old settings JSON can migrate. Not used by the default path. */
  classify?: RoleModelSelection;
}

export interface CostRate {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export type CostTable = Record<string, CostRate>;

export interface TokenThriftSettings {
  latexNormalization: boolean;
  maxImagesPerVisionCall: number;
  /** #58 — per-request image limit for the local decision judge (defaults to 4 when unset). */
  maxImagesPerDecisionCall?: number;
  imageMaxLongEdge: number;
  jpegQuality: number;
  cacheEnabled: boolean;
}

export interface BudgetSettings {
  maxUsdPerRun: number; // display-only estimate threshold; never a parse/save gate
  maxOutputTokens: number;
}

export interface DocSettings {
  defaultLanguage: 'auto' | 'ltr' | 'rtl';
  paperSize: 'A4' | 'Letter';
  fontSize: 'small' | 'medium' | 'large';
}

export type ReadFormat = 'auto' | 'compact' | 'verbose';

export interface AppSettings {
  /** Global Read wire format; auto selects verbose for local endpoints and compact otherwise. */
  readFormat?: ReadFormat;
  providers: ProviderConfig[];
  roleMapping: RoleMapping;
  costTable: CostTable;
  thrift: TokenThriftSettings;
  budget: BudgetSettings;
  document: DocSettings;
  assistantMonthlySoftCapUsd?: number;
  /** 2E: bounded section parallelism (1–6, default 3). */
  parallelSections?: number;
  /** Report-only proving-ground tools. Both are off by default and never gate a parse. */
  consensusEnabled?: boolean;
  criticEnabled?: boolean;
  themeTokens?: Partial<Record<'primary' | 'background' | 'foreground', string>>;
  /** Manual light/dark override; system follows prefers-color-scheme. */
  themeMode?: 'system' | 'light' | 'dark';
  uiLanguage?: 'fa' | 'en';
  defaultExamMode?: 'exam' | 'review';
  livePanel?: boolean;
  agentLimits?: { maxModelCalls?: number; maxToolExecutions?: number };
  /** A4/F3: Stage 2.5 cleanup on/off (default on). Off ⇒ no tags, byte-identical pre-cleanup behaviour. */
  cleanupEnabled?: boolean;
  /** #38: AI-first line classification as the primary spine (default on). Off → legacy segmenter path with visible CLASSIFY_FALLBACK. */
  classifyEnabled?: boolean;
  /** Optional Stage 2.75 OCR/PDF text readability repair (default off; overlays only). */
  textRepairEnabled?: boolean;
  /** #43 decision audit mode: shadow (compute + report only, never routes) or active (routes confident-wrong catches to repair/teacher). Default shadow. */
  decideMode?: 'shadow' | 'active';
  /** Imported report-only calibration, scoped to this endpoint/model; never a promotion switch. */
  decideCalibration?: import('./pipeline/decisionCalibration').DecisionCalibrationReport;
  /** Send image pixels to the local decisions endpoint only when its mmproj build is enabled. */
  decideMultimodal?: boolean;
}

/**
 * LLM Request & Response Abstraction (§7)
 */
export interface LLMRequest {
  role: LLMRole;
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
  /** #50 Part A: set when the stream circuit-breaker cut the response. */
  breaker?: { kind: 'repetition' | 'counting'; completedItems: number };
}

/**
 * Pipeline Stage State
 */
/** #51: 'extract' | 'map' | 'parse' | 'check' | 'fix' | 'present' are the six loop phases; 'read' is kept as a
 * force-rerun alias for Map + Parse. The rest are legacy/tooling stage ids. */
export type PipelineStageId = 'extract' | 'map' | 'parse' | 'check' | 'fix' | 'read' | 'compile' | 'repair' | 'present' | 'ocr' | 'text-repair' | 'vision' | 'classify' | 'structure' | 'assemble' | 'cleanup';

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
