import type { CostTable, LLMRequest, LLMResponse, ProviderConfig } from '../types';

export interface CapabilityRecord {
  sse: boolean;
  reasoningChannel: boolean;
  wireV2Ok: boolean;
  toolCalls: boolean;
  probedAt: string;
  approxMaxOut: number;
  model: string;
  providerId: string;
}

export type ProbeProviderConfig = ProviderConfig & { model: string };
type ProbeResponse = LLMResponse & { sse?: boolean; stream?: boolean };
type ProbeExecutor = (request: LLMRequest) => Promise<ProbeResponse>;
type ProviderCapabilityStore = Record<string, CapabilityRecord>;

const PROBE_MAX_TOKENS = 300;
const PROBE_REQUEST_COUNT = 2;
const PROVIDERS_MEMORY_ID = 'providers'; // DATA_DIR/memory/providers.json via /api/memory/providers

export function shouldUseV1(cap: CapabilityRecord | undefined): boolean {
  if (!cap) return false; // fallback to weak-model heuristic
  return !cap.wireV2Ok;
}

function probeRecordKey(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

function isCapabilityRecord(value: unknown): value is CapabilityRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CapabilityRecord>;
  return typeof candidate.providerId === 'string' && typeof candidate.model === 'string';
}

async function loadCapabilityStore(): Promise<ProviderCapabilityStore> {
  const response = await fetch(`/api/memory/${PROVIDERS_MEMORY_ID}`);
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Could not load provider capability records (HTTP ${response.status})`);
  const stored: unknown = await response.json();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  // Read the initial single-record shape too, so existing probe records are not lost.
  if (isCapabilityRecord(stored)) {
    return { [probeRecordKey(stored.providerId, stored.model)]: stored };
  }
  const records: ProviderCapabilityStore = {};
  for (const [key, record] of Object.entries(stored)) {
    if (isCapabilityRecord(record)) records[key] = record;
  }
  return records;
}

export async function runProbe(
  providerConfig: ProbeProviderConfig,
  execute: ProbeExecutor,
): Promise<CapabilityRecord> {
  // Probe 1: ask for counted list to verify max-output behaviour.
  const countedListReq: LLMRequest = {
    role: 'fast',
    system: 'Probe: output JSON array of 10 numbers 1..10',
    text: 'Return JSON {"list":[1,2,3,4,5,6,7,8,9,10]}',
    maxOutputTokens: PROBE_MAX_TOKENS,
    label: 'Probe counted list',
    providerConfig,
  };
  let wireV2Ok = false;
  let sse = false;
  let reasoningChannel = false;
  let toolCalls = false;
  let approxMaxOut = 0;
  try {
    const res1 = await execute(countedListReq);
    sse = Boolean(res1.sse || res1.stream);
    reasoningChannel = Boolean(res1.reasoningText);
    // Check v2: ask for compact wire v2 and see if it parses.
    const v2Req: LLMRequest = {
      role: 'fast',
      system: 'Probe wire v2: compact JSON v2 {q:[{n:1,p:[[1,1]]}]}',
      text: 'Return wire v2 for 1 question',
      maxOutputTokens: PROBE_MAX_TOKENS,
      label: 'Probe wire v2',
      providerConfig,
      jsonSchema: { type: 'object' },
    };
    const res2 = await execute(v2Req).catch(() => undefined);
    const v2Data = res2?.json;
    if (v2Data && typeof v2Data === 'object' && Array.isArray((v2Data as { q?: unknown }).q)) wireV2Ok = true;
    const firstData = res1.json;
    if (firstData && typeof firstData === 'object' && Array.isArray((firstData as { list?: unknown }).list)) {
      approxMaxOut = (firstData as { list: unknown[] }).list.length === 10 ? 10_000 : 1_000;
    }
    // Tool calls: check if native tool_calls are present.
    toolCalls = Boolean(res1.tool_calls || res2?.tool_calls);
  } catch {
    // A capability record is still useful after a transport failure: all unproven capabilities remain false.
  }
  return {
    sse,
    reasoningChannel,
    wireV2Ok,
    toolCalls,
    probedAt: new Date().toISOString(),
    approxMaxOut: approxMaxOut || 4_000,
    model: providerConfig.model,
    providerId: providerConfig.id,
  };
}

export async function getProbeRecord(providerId: string, model: string): Promise<CapabilityRecord | undefined> {
  try {
    const store = await loadCapabilityStore();
    return store[probeRecordKey(providerId, model)];
  } catch {
    return undefined;
  }
}

export async function saveProbeRecord(record: CapabilityRecord): Promise<void> {
  const store = await loadCapabilityStore();
  store[probeRecordKey(record.providerId, record.model)] = record;
  const response = await fetch(`/api/memory/${PROVIDERS_MEMORY_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(store),
  });
  if (!response.ok) throw new Error(`Could not save provider capability record (HTTP ${response.status})`);
}

/** The two short requests each allow up to PROBE_MAX_TOKENS of output. */
export function probeCostEstimate(model?: string, costTable?: CostTable): string {
  // Preserve the original compact estimate for callers that have not selected a model.
  if (!model && !costTable) return `~${PROBE_MAX_TOKENS} tokens`;
  const outputTokens = PROBE_MAX_TOKENS * PROBE_REQUEST_COUNT;
  const rate = model ? costTable?.[model] : undefined;
  if (!rate) return `~${outputTokens} output tokens (cost not configured)`;
  const estimatedInputTokens = 120;
  const cost = (
    (estimatedInputTokens * rate.inputCostPerMillion) +
    (outputTokens * rate.outputCostPerMillion)
  ) / 1_000_000;
  return `~${outputTokens} output tokens · ~$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}
