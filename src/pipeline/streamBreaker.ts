/**
 * Follow-up #50 Part A — generalized stream circuit-breaker.
 *
 * Incrementally scans a streamed JSON response (strings and escapes respected, chunk boundaries anywhere)
 * and hashes every COMPLETED top-level array element that is an object or array:
 *   - root is an array      → its elements;
 *   - root is an object     → the elements of its array-valued properties (map lists, questions, corrections…).
 * Deeper arrays (e.g. a question's options) are not tracked: identical `{"key":"a","text":"True"}` options
 * in different questions are legitimate. When the same element (whitespace-normalized) completes
 * REPEAT_LIMIT times, the breaker trips. The ≥40 ascending-integers rule (hasCountingLoop) stays separate.
 */
export const REPEAT_LIMIT = 3;

export interface BreakerTrip { kind: 'repetition'; completedItems: number; repeats: number; element: string }

const normalizeElement = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** 32-bit FNV-1a; collisions are harmless (the full string is compared on a hash hit). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export class RepetitionBreaker {
  private text = '';
  private pos = 0;
  private quoted = false;
  private escaped = false;
  /** Container stack: '{' or '['. */
  private stack: string[] = [];
  /** Start offsets of tracked elements (aligned with the stack depth at which they opened). */
  private starts = new Map<number, number>();
  private seen = new Map<number, Array<{ element: string; count: number }>>();
  private rootSeen = false;
  completedItems = 0;
  tripped?: BreakerTrip;

  constructor(private readonly limit = REPEAT_LIMIT) {}

  /** Feed the next streamed chunk. Returns the trip once the same element completes `limit` times. */
  push(chunk: string): BreakerTrip | undefined {
    if (this.tripped) return this.tripped;
    this.text += chunk;
    for (; this.pos < this.text.length; this.pos++) {
      const c = this.text[this.pos];
      // Prose or a code fence before the JSON root is skipped (its quotes must not desync the scanner).
      if (!this.rootSeen && c !== '{' && c !== '[') continue;
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.quoted = false;
        continue;
      }
      if (c === '"') { this.quoted = true; continue; }
      if (c === '{' || c === '[') {
        if (!this.stack.length) { if (this.rootSeen) continue; this.rootSeen = true; }
        if (this.isTrackedParent()) this.starts.set(this.stack.length, this.pos);
        this.stack.push(c);
        continue;
      }
      if ((c === '}' || c === ']') && this.stack.length) {
        this.stack.pop();
        const start = this.starts.get(this.stack.length);
        if (start !== undefined) {
          this.starts.delete(this.stack.length);
          const trip = this.complete(this.text.slice(start, this.pos + 1));
          if (trip) { this.pos++; return trip; }
        }
      }
    }
    return undefined;
  }

  /** An element opening now is tracked when its parent is a top-level array. */
  private isTrackedParent(): boolean {
    const depth = this.stack.length;
    if (depth === 1) return this.stack[0] === '[';
    if (depth === 2) return this.stack[0] === '{' && this.stack[1] === '[';
    return false;
  }

  private complete(raw: string): BreakerTrip | undefined {
    this.completedItems++;
    const element = normalizeElement(raw);
    const hash = fnv1a(element);
    const bucket = this.seen.get(hash) || [];
    let row = bucket.find(r => r.element === element);
    if (!row) { row = { element, count: 0 }; bucket.push(row); this.seen.set(hash, bucket); }
    row.count++;
    if (row.count >= this.limit) {
      this.tripped = { kind: 'repetition', completedItems: this.completedItems, repeats: row.count, element: element.slice(0, 200) };
      return this.tripped;
    }
    return undefined;
  }
}

/** Convenience for non-streamed text (tests, salvage audits). */
export function findRepetition(text: string, limit = REPEAT_LIMIT): BreakerTrip | undefined {
  return new RepetitionBreaker(limit).push(text);
}
