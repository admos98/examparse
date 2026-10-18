import { getPipelineCache, setPipelineCache } from '../store';

export interface JournalCall {
  ts: string;
  label: string;
  rawText: string;
  reasoningText?: string;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  complete: boolean;
}
export interface SessionJournal { updatedAt: string; complete: boolean; calls: JournalCall[] }

export async function loadJournal(key: string): Promise<SessionJournal | undefined> {
  return getPipelineCache<SessionJournal>(`journal:structure:${key}`);
}
const appendQueues = new Map<string, Promise<void>>();

export async function appendJournalCall(key: string, entry: JournalCall): Promise<void> {
  const previous = appendQueues.get(key) || Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const journal = (await loadJournal(key)) || { updatedAt: new Date().toISOString(), complete: false, calls: [] };
    journal.updatedAt = new Date().toISOString();
    journal.complete = false;
    const storedEntry = { ...entry, rawText: (entry.rawText || '').slice(0, 200_000), reasoningText: entry.reasoningText?.slice(0, 200_000) };
    let inFlightIndex = -1;
    for (let i = journal.calls.length - 1; i >= 0; i--) {
      if (journal.calls[i].label === entry.label && !journal.calls[i].complete) {
        inFlightIndex = i;
        break;
      }
    }
    if (inFlightIndex >= 0) journal.calls[inFlightIndex] = storedEntry;
    else journal.calls.push(storedEntry);
    journal.calls = journal.calls.slice(-6);
    await setPipelineCache(`journal:structure:${key}`, journal);
  });
  appendQueues.set(key, write);
  try {
    await write;
  } finally {
    if (appendQueues.get(key) === write) appendQueues.delete(key);
  }
}
export async function markJournalComplete(key: string): Promise<void> {
  const journal = await loadJournal(key);
  if (journal) await setPipelineCache(`journal:structure:${key}`, { ...journal, updatedAt: new Date().toISOString(), complete: true });
}
