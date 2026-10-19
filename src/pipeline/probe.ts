import { LLMRequest } from '../types';
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

const PROBE_MAX_TOKENS = 300;
const STORE_FILE = 'memory/providers.json'; // relative to DATA_DIR, handled via /api/cache

export function shouldUseV1(cap: CapabilityRecord | undefined): boolean {
  if (!cap) return false; // fallback to weak-model heuristic
  return !cap.wireV2Ok;
}

export async function runProbe(
  providerConfig: any,
  execute: (req:LLMRequest)=>Promise<any>,
): Promise<CapabilityRecord> {
  const start = Date.now();
  // Probe 1: ask for counted list to verify max-output behaviour
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
    sse = !!res1.sse || !!res1.stream;
    reasoningChannel = !!res1.reasoningText;
    // Check v2: ask for compact wire v2 and see if it parses
    const v2Req: LLMRequest = {
      role: 'fast',
      system: 'Probe wire v2: compact JSON v2 {q:[{n:1,p:[[1,1]]}]}',
      text: 'Return wire v2 for 1 question',
      maxOutputTokens: PROBE_MAX_TOKENS,
      label: 'Probe wire v2',
      providerConfig,
      jsonSchema: { type:'object' } as any,
    };
    const res2 = await execute(v2Req).catch(()=>null);
    if (res2?.json && Array.isArray(res2.json.q)) wireV2Ok=true;
    if (res1?.json?.list) approxMaxOut = res1.json.list.length===10 ? 10000 : 1000;
    // Tool calls: check if native tool_calls present
    toolCalls = !!(res1.tool_calls || res2?.tool_calls);
  } catch {}
  return {
    sse, reasoningChannel, wireV2Ok, toolCalls, probedAt: new Date().toISOString(), approxMaxOut: approxMaxOut || 4000, model: providerConfig.model, providerId: providerConfig.id
  };
}

export async function getProbeRecord(providerId:string, model:string): Promise<CapabilityRecord|undefined> {
  try{
    const res = await fetch(`/api/cache/${encodeURIComponent('probe_'+providerId+'_'+model)}`);
    if(!res.ok) return undefined;
    return await res.json();
  }catch{ return undefined; }
}
export async function saveProbeRecord(rec:CapabilityRecord){
  await fetch(`/api/cache/${encodeURIComponent('probe_'+rec.providerId+'_'+rec.model)}`,{
    method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(rec)
  });
}

// Cost display
export function probeCostEstimate(): string {
  return `~${PROBE_MAX_TOKENS} tokens`;
}
