/** Memory types for A/B/C */
export interface DocTraits {
  pages: number;
  lines: number;
  expectedQs: number;
  languagesDetected: string[]; // e.g. ['en','fa']
  hasKeyPages: boolean;
  hasImages: number;
  sectionCount: number;
  rtl?: boolean;
  isLong?: boolean;
  weakModel?: boolean;
}

export interface RunJournalEntry {
  ts: string; // ISO
  jobId: string;
  kind: 'pipeline' | 'remediation' | 'assistant';
  examId?: string;
  docTraits: DocTraits;
  models: Record<string,string>; // role -> modelId
  outcome: {
    health: { expected:number; parsed:number; missing:number[]; duplicates:number[]; coveragePercent:number; state:string; complete:boolean; pointsParsed?:number; pointsExpected?:number };
    calls: number;
    tokens: { input:number; output:number; cached?:number };
    cost: number;
    wallMs: number;
    flagsRaised: string[];
  };
  ladderPath: string[]; // tools/steps in order
  flagsRaised: string[];
  userCorrections: number;
  /** D3 baseline for the 10-minute user-correction window. */
  baselineRevision?: string;
  baselineTs?: string;
  /** Which guidance was actually injected (B5 inspectability). */
  guidance?: { playbookEntries: number; playbookTokens: number; skills: string[]; skillsTokens: number; omittedByCap: number; draftShadowSkills?: string[] };
}

export type PlaybookKind = 'model-trait'|'doc-trait'|'strategy'|'user-pref';
export type PlaybookStatus = 'candidate'|'active'|'demoted';

export interface PlaybookEntry {
  id: string;
  kind: PlaybookKind;
  scope: { modelId?: string; docTrait?: string; role?: string };
  lesson: string; // ≤280 chars imperative
  evidence: { runIds: string[]; successes:number; failures:number; firstSeen:string; lastSeen:string; lastVerified?:string; consecutiveFailures?:number };
  status: PlaybookStatus;
  confidence: number; // 0..1
}

export interface PlaybookFile {
  version: 1;
  entries: PlaybookEntry[];
}

export interface SkillStats {
  injected: number;
  followed: number;
  greenAfter: number;
  redAfter: number;
  lastUsed?: string;
  lastInjected?: string;
}

export interface SkillMeta {
  name: string;
  slug: string;
  status: 'active'|'draft'|'archived';
  triggers: string[]; // keywords/patterns
  appliesTo?: { roles?: string[]; docTraits?: string[] };
  maxTokens: number;
  source: 'shipped'|'learned'|'user';
  stats: SkillStats;
  createdAt?: string;
}

export interface MemoryConfig {
  learningEnabled: boolean; // B5 default ON
  reflectionEnabled: boolean; // B5 default ON (separate toggle)
}

export interface GuidanceAssemblyResult {
  text: string; // delimited block or empty
  tokens: number;
  included: PlaybookEntry[];
  omitted: number; // count omitted by cap
  omittedIds?: string[];
}

export interface SkillAssemblyResult {
  texts: Array<{ slug:string; text:string; tokens:number; status:string }>;
  totalTokens: number;
  includedSlugs: string[];
  omittedCount: number;
}
