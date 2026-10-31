/** Recover a valid JSON prefix from a truncated object/array without cutting inside strings. */
export function repairTruncatedJson(rawText: string): unknown | null {
  const start = rawText.search(/[\[{]/);
  if (start < 0) return null;
  const text = rawText.slice(start);
  const stack: Array<{ open: string; lastSafe: number }> = [];
  let quoted = false, escaped = false, safe = -1;
  const completeArrayCuts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === '{' || c === '[') stack.push({ open: c, lastSafe: -1 });
    else if (c === '}' || c === ']') {
      const frame = stack.pop();
      if (!frame) return null;
      if (stack.length === 0) safe = i + 1;
      else stack[stack.length - 1].lastSafe = i + 1;
    } else if (c === ',' && stack.length) {
      stack[stack.length - 1].lastSafe = i;
      if (stack[stack.length - 1].open === '[') completeArrayCuts.push(i);
    } else if (c === ',' && !stack.length) safe = i;
    if (!stack.length && (c === '}' || c === ']')) {
      try { return JSON.parse(text.slice(0, i + 1)); } catch { /* continue scanning */ }
    }
  }
  // Try successively shorter structural boundaries, closing the nesting stack.
  const candidates = [...new Set<number>([...completeArrayCuts.reverse(), safe, ...stack.map(frame => frame.lastSafe)])];
  for (let cut of candidates.filter(n => n > 0)) {
    let prefix = text.slice(0, cut).replace(/[,\s]+$/, '');
    // Only retain boundaries after a complete composite value. Closing the stack
    // must not turn a cut-off scalar (for example the `11` in `[11,`) into data.
    if (!/[}\]]$/.test(prefix)) continue;
    // A trailing key/value separator cannot form a valid entry.
    if (/:\s*$/.test(prefix)) continue;
    let inString = false, esc = false;
    for (const c of prefix) { if (inString) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inString = false; } else if (c === '"') inString = true; }
    if (inString) continue;
    const opens: string[] = []; inString = false; esc = false;
    for (const c of prefix) { if (inString) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inString = false; } else if (c === '"') inString = true; else if (c === '{' || c === '[') opens.push(c); else if (c === '}' || c === ']') opens.pop(); }
    prefix += opens.reverse().map(c => c === '{' ? '}' : ']').join('');
    try { return JSON.parse(prefix); } catch { /* try smaller boundary */ }
  }
  return null;
}

/**
 * #58 — nested-aware salvage for a truncated batch of question objects.
 *
 * The old flat `/\{[^{}]*\}/g` cannot recover a complete question object that contains a nested
 * rubric object. This scanner tracks string/escape state and brace depth, so every COMPLETE
 * top-level object is recovered; a partially written object is never guessed. A truncated envelope
 * is first attempted with the existing prefix repair.
 */
export function salvageJsonObjects(rawText: string): any[] {
  if (!rawText?.trim()) return [];
  const repaired = repairTruncatedJson(rawText);
  if (repaired && typeof repaired === 'object') {
    const envelope = repaired as { corrections?: unknown };
    if (Array.isArray(envelope.corrections)) return envelope.corrections;
    if (Array.isArray(repaired)) return repaired;
  }
  const out: any[] = [];
  let depth = 0, start = -1, quoted = false, escaped = false;
  for (let i = 0; i < rawText.length; i++) {
    const c = rawText[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = rawText.slice(start, i + 1);
        try {
          const value = JSON.parse(slice);
          // Skip the response envelope; keep per-question rows.
          if (!(value && typeof value === 'object' && Array.isArray((value as { corrections?: unknown }).corrections) && Object.keys(value).length === 1)) out.push(value);
        } catch { /* incomplete or malformed object */ }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}
