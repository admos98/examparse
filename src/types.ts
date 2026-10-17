/**
 * ExamParse Data Model & Type Definitions
 * Strictly implements §4 and §7 of specifications
 */

export type SourceLine = {
  id: string; // e.g. "L0001"
  page: number;
  text: string;
  y?: number;
};

export type LineSpan = [number, number]; // inclusive start/end, 1-based (e.g. [41, 45])

export interface ExamSection {
  id: string;
  index: number;
  title?: string;
  instructions?: string;
  spans: LineSpan[];
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
    source: 'paper' | 'keyfile' | 'manual';
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
  duplicateOf?: string; // dedupe by sha or perceptual hash
  label?: {
    role: Question['images'][number]['role'];
    questionRef?: string;
    caption?: string;
    kind?: 'photo' | 'diagram' | 'chart' | 'table' | 'formula' | 'handwriting' | 'decoration';
    needsText?: boolean;
  };
  blobKey: string; // IndexedDB key; binary is NEVER base64'd into JSON exports
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
  role: 'fast' | 'standard' | 'escalation' | 'vision' | 'ocr' | 'patch';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  label: string;
  isCachedHit?: boolean;
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
  meta: ExamMeta;
  sections: ExamSection[];
  questions: Question[];
  images: ImageAsset[];
  source: {
    lines: SourceLine[];
    pages: number;
    ocrUsed: boolean;
    fileName: string;
    pageImages?: string[]; // rendered page preview data URLs
  };
  flags: Flag[];
  usage: UsageRecord[];
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
}

/**
 * LLM Request & Response Abstraction (§7)
 */
export interface LLMRequest {
  role: 'fast' | 'standard' | 'escalation' | 'vision' | 'ocr' | 'patch';
  system: string;
  text: string;
  images?: {
    id: string;
    mime: string;
    data: string; // base64 string without data prefix
  }[];
  jsonSchema?: object;
  maxOutputTokens?: number;
  label: string; // for the usage log
  providerConfig?: {
    id: string;
    name: string;
    kind: ProviderKind;
    baseURL?: string;
    apiKey?: string;
    defaultHeaders?: Record<string, string>;
    model: string;
  };
}

export interface LLMResponse {
  json: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
  rawText: string;
}

/**
 * Pipeline Stage State
 */
export type PipelineStageId = 'extract' | 'ocr' | 'structure' | 'vision' | 'assemble' | 'repair';

export interface StageStatus {
  id: PipelineStageId;
  name: string;
  status: 'idle' | 'running' | 'completed' | 'skipped' | 'failed' | 'cached';
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  message?: string;
}
