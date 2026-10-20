/** 2E — Task-graph engine. Refactors orchestration, not stage logic.
 * Bounded concurrency, per-node journal/resume, per-node timeout, branch-local
 * failure (dependents skipped, PARTIAL names failed sections), and deterministic
 * merge order independent of completion order. */

export interface GraphNode<T = unknown> {
  id: string;
  label?: string;          // e.g. section title — shown in Step 3 node list
  deps?: string[];
  timeoutMs?: number;      // default 180_000
  run: () => Promise<T>;
}

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'resumed';
export interface NodeRecord { id: string; label?: string; status: NodeStatus; tokens?: number; error?: string; ms?: number }

export interface GraphResult<T = unknown> {
  results: Record<string, T>;
  nodes: NodeRecord[];
  partial: boolean;
  failedNodes: string[];
  /** Human PARTIAL naming, e.g. "PARTIAL: sections failed — Grammar, Reading" */
  partialMessage?: string;
  callsExecuted: string[]; // node ids actually executed this run (resume assertion)
}

export const DEFAULT_NODE_TIMEOUT_MS = 180_000;

function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`NODE_TIMEOUT ${id} after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * @param resumed  journal of completed node results (existing key scheme + node id).
 *                 Completed nodes NEVER re-execute.
 */
export async function runTaskGraph<T = unknown>(
  nodes: GraphNode<T>[],
  opts: { concurrency?: number; resumed?: Record<string, T>; onNode?: (rec: NodeRecord) => void; defaultTimeoutMs?: number } = {},
): Promise<GraphResult<T>> {
  const concurrency = Math.max(1, Math.min(6, opts.concurrency ?? 3));
  const results: Record<string, T> = { ...(opts.resumed || {}) };
  const records = new Map<string, NodeRecord>();
  const callsExecuted: string[] = [];
  for (const n of nodes) records.set(n.id, { id: n.id, label: n.label, status: results[n.id] !== undefined ? 'resumed' : 'pending' });
  const emit = (r: NodeRecord) => { try { opts.onNode?.({ ...r }); } catch { /* observer never breaks the graph */ } };
  for (const r of records.values()) if (r.status === 'resumed') emit(r);

  const byId = new Map(nodes.map(n => [n.id, n]));
  const remaining = new Set(nodes.filter(n => results[n.id] === undefined).map(n => n.id));
  const failed = new Set<string>();

  const depsState = (n: GraphNode<T>): 'ready' | 'blocked' | 'waiting' => {
    for (const d of n.deps || []) {
      if (failed.has(d) || records.get(d)?.status === 'skipped') return 'blocked';
      if (results[d] === undefined) return 'waiting';
    }
    return 'ready';
  };

  async function worker(): Promise<void> {
    for (;;) {
      // Skip blocked nodes deterministically.
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const id of [...remaining]) {
          const n = byId.get(id)!;
          if (depsState(n) === 'blocked') {
            remaining.delete(id);
            const rec = records.get(id)!; rec.status = 'skipped'; emit(rec);
            progressed = true;
          }
        }
      }
      const next = [...remaining].map(id => byId.get(id)!).find(n => depsState(n) === 'ready');
      if (!next) {
        if (!remaining.size) return;
        // Nothing ready but work remains: another worker is running a dependency. Yield.
        await new Promise(r => setTimeout(r, 1));
        if (![...records.values()].some(r => r.status === 'running')) {
          // Deadlock (cycle/missing dep): skip the rest rather than hang the UI.
          for (const id of [...remaining]) { remaining.delete(id); const rec = records.get(id)!; rec.status = 'skipped'; rec.error = 'unresolvable dependencies'; emit(rec); }
          return;
        }
        continue;
      }
      remaining.delete(next.id);
      const rec = records.get(next.id)!;
      rec.status = 'running'; emit(rec);
      callsExecuted.push(next.id);
      const t0 = Date.now();
      try {
        const value = await withTimeout(Promise.resolve().then(next.run), next.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS, next.id);
        results[next.id] = value;
        rec.status = 'done'; rec.ms = Date.now() - t0;
        const tok = (value as any)?.tokens;
        if (typeof tok === 'number') rec.tokens = tok;
      } catch (err: any) {
        failed.add(next.id);
        rec.status = 'failed'; rec.ms = Date.now() - t0; rec.error = String(err?.message || err).slice(0, 200);
      }
      emit(rec);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const nodeList = nodes.map(n => records.get(n.id)!);
  const failedNodes = nodeList.filter(r => r.status === 'failed').map(r => r.id);
  const partial = failedNodes.length > 0 || nodeList.some(r => r.status === 'skipped');
  const failedLabels = nodeList.filter(r => r.status === 'failed' || r.status === 'skipped').map(r => r.label || r.id);
  return {
    results, nodes: nodeList, partial, failedNodes, callsExecuted,
    partialMessage: partial ? `PARTIAL: sections failed — ${failedLabels.join(', ')}` : undefined,
  };
}

/** Deterministic merge: output order follows the declared key order, never completion order. */
export function mergeInOrder<T>(results: Record<string, T>, order: string[]): T[] {
  return order.filter(id => results[id] !== undefined).map(id => results[id]);
}
