export const CURRENT_SCHEMA_V = 3;
export interface Migration { from:number, to:number, migrate:(doc:any)=>any }
export const migrations: Migration[] = [
  { from:1, to:2, migrate:(doc:any)=> ({...doc, schemaV:2, meta:{...doc.meta, migrated:true}}) },
  { from:2, to:3, migrate:(doc:any)=> ({...doc, schemaV:3, dossier:{...doc.dossier, updated:true}}) },
];
export function migrateDoc(doc:any):any{
  let v = doc.schemaV || 1;
  let out = {...doc};
  while(v < CURRENT_SCHEMA_V){
    const mig = migrations.find(m=>m.from===v);
    if(!mig) break;
    out = mig.migrate(out);
    v = mig.to;
  }
  if(doc.schemaV && doc.schemaV > CURRENT_SCHEMA_V){
    // unknown future -> read-only
    out._readOnly = true;
    out._readOnlyMessage = `This exam was created with a newer version (v${doc.schemaV}) — open as read-only.`;
  }
  return out;
}
