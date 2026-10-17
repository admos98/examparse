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
export async function appendJournalCall(key: string, entry: JournalCall): Promise<void> {
  const journal = (await loadJournal(key)) || { updatedAt: new Date().toISOString(), complete: false, calls: [] };
  journal.updatedAt = new Date().toISOString();
  journal.complete = false;
  journal.calls.push({ ...entry, rawText: (entry.rawText || '').slice(0, 200_000), reasoningText: entry.reasoningText?.slice(0, 200_000) });
  journal.calls = journal.calls.slice(-6);
  await setPipelineCache(`journal:structure:${key}`, journal);
}
export async function markJournalComplete(key: string): Promise<void> {
  const journal = await loadJournal(key);
  if (journal) await setPipelineCache(`journal:structure:${key}`, { ...journal, updatedAt: new Date().toISOString(), complete: true });
}
