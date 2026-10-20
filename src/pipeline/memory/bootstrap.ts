import type { PlaybookFile } from './types';

/** Bootstrap entries derived from real incident history — ≤5, marked active, evidence bootstrap */
export const BOOTSTRAP_PLAYBOOK: PlaybookFile = {
  version: 1,
  entries: [
    {
      id: 'bootstrap_001_sectioned_mode',
      kind: 'strategy',
      scope: { docTrait: 'long' },
      lesson: 'On docs >220 lines or >25 expected questions, force sectioned parsing: one call per header-derived section; truncated 40k-token ramble indicates mode missing.',
      evidence: { runIds: ['bootstrap'], successes: 3, failures: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), lastVerified: new Date().toISOString() },
      status: 'active',
      confidence: 0.8,
    },
    {
      id: 'bootstrap_002_arabic_key',
      kind: 'doc-trait',
      scope: { docTrait: 'rtl-key-pages' },
      lesson: 'On RTL docs with a key page (Arabic ی U+064A vs Persian ی U+06CC), normalize ye/kaf before splitting grouped answers; never parse questions from key lines.',
      evidence: { runIds: ['bootstrap'], successes: 2, failures: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), lastVerified: new Date().toISOString() },
      status: 'active',
      confidence: 0.75,
    },
    {
      id: 'bootstrap_003_group_children',
      kind: 'strategy',
      scope: { docTrait: 'sectioned' },
      lesson: 'When stem enumerates (15) (16) (17) (18) on one line, emit parent+children with g=parent; retry alone cannot create children — use group diagnosis.',
      evidence: { runIds: ['bootstrap'], successes: 4, failures: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), lastVerified: new Date().toISOString() },
      status: 'active',
      confidence: 0.82,
    },
    {
      id: 'bootstrap_004_option_shared',
      kind: 'doc-trait',
      scope: { docTrait: 'image-heavy' },
      lesson: 'Option lines shared across adjacent questions are stems, not gaps — keep option spans local to each question; do not drop shared lines.',
      evidence: { runIds: ['bootstrap'], successes: 2, failures: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), lastVerified: new Date().toISOString() },
      status: 'active',
      confidence: 0.7,
    },
    {
      id: 'bootstrap_005_free_model_wire',
      kind: 'model-trait',
      scope: { modelId: 'free', role: 'fast' },
      lesson: 'On free/lite/mini models, enforce compact wire v2 spans-only and strict JSON; wire fallback + bisection prevents prose ramble and 400 errors.',
      evidence: { runIds: ['bootstrap'], successes: 3, failures: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), lastVerified: new Date().toISOString() },
      status: 'active',
      confidence: 0.78,
    },
  ],
};

export function isBootstrapId(id:string): boolean {
  return id.startsWith('bootstrap_');
}
