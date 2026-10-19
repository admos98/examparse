import { AppSettingsSchema } from './validation';

export function exportSettingsProfile(settings:any): string {
  const copy = JSON.parse(JSON.stringify(settings));
  // Export providers sans keys + role mapping + thresholds
  if(copy.providers) for(const p of copy.providers) delete p.apiKey;
  // Keep only relevant fields
  const profile = {
    providers: copy.providers?.map((p:any)=>({ id:p.id, name:p.name, kind:p.kind, baseURL:p.baseURL })),
    roleMapping: copy.roleMapping,
    thrift: copy.thrift,
    budget: copy.budget,
    exportAt: new Date().toISOString(),
    schemaV: 3,
  };
  return JSON.stringify(profile, null, 2);
}

export function importSettingsProfile(json:string, existing:any): any {
  const parsed = JSON.parse(json);
  // Validate through existing schemas (reuse AppSettingsSchema for relevant parts)
  // For profile, we validate subset
  if(!parsed.providers || !parsed.roleMapping) throw new Error('Invalid profile: missing providers or roleMapping');
  // Merge with existing, keep keys if existing has them
  const merged = {
    ...existing,
    providers: parsed.providers.map((p:any)=>{
      const existingProv = existing.providers?.find((e:any)=> e.id===p.id);
      return { ...p, apiKey: existingProv?.apiKey || '' };
    }),
    roleMapping: parsed.roleMapping,
    thrift: parsed.thrift || existing.thrift,
    budget: parsed.budget || existing.budget,
  };
  // Validate via AppSettingsSchema (will throw if invalid)
  AppSettingsSchema.parse(merged);
  return merged;
}
