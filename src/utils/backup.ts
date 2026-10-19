import JSZip from 'jszip';

export async function createBackup(dataDir: { exams: Record<string,any>, images: Record<string,{sha:string, data:Uint8Array}>, dossiers: Record<string,any>, settings: any }): Promise<Uint8Array> {
  const zip = new JSZip();
  // Whole data dir (exams, images by sha, dossiers, settings sans keys)
  for(const [id, exam] of Object.entries(dataDir.exams)){
    zip.file(`exams/${id}.json`, JSON.stringify(exam,null,2));
  }
  for(const [sha, blob] of Object.entries(dataDir.images)){
    zip.file(`images/${sha}`, blob.data);
  }
  for(const [id, dossier] of Object.entries(dataDir.dossiers)){
    zip.file(`dossiers/${id}.json`, JSON.stringify(dossier,null,2));
  }
  // Settings sans keys
  const settingsSansKeys = JSON.parse(JSON.stringify(dataDir.settings || {}));
  if(settingsSansKeys.providers){
    for(const p of settingsSansKeys.providers) delete p.apiKey;
  }
  zip.file('settings.json', JSON.stringify(settingsSansKeys,null,2));
  const buf = await zip.generateAsync({type:'uint8array'});
  return buf;
}

export async function restoreBackup(buffer: Uint8Array | Buffer, validate: (exam:any)=>boolean = ()=>true): Promise<{ exams: Record<string,any>, images:Record<string,any>, dossiers:Record<string,any>, settings:any, counts:{exams:number, images:number, dossiers:number} }>{
  const zip = await JSZip.loadAsync(buffer);
  const exams:Record<string,any>={};
  const images:Record<string,any>={};
  const dossiers:Record<string,any>={};
  let settings:any=null;
  for(const [path, entry] of Object.entries(zip.files)){
    if(entry.dir) continue;
    if(path.startsWith('exams/')){
      const content = await entry.async('string');
      const parsed = JSON.parse(content);
      if(!validate(parsed)) throw new Error(`Validation failed for ${path}`);
      const id = path.replace('exams/','').replace('.json','');
      exams[id]=parsed;
    } else if(path.startsWith('images/')){
      const data = await entry.async('uint8array');
      const sha = path.replace('images/','');
      images[sha]=data;
    } else if(path.startsWith('dossiers/')){
      const content = await entry.async('string');
      dossiers[path.replace('dossiers/','').replace('.json','')] = JSON.parse(content);
    } else if(path==='settings.json'){
      settings = JSON.parse(await entry.async('string'));
    }
  }
  // Snapshot current state first would be done by caller
  return { exams, images, dossiers, settings, counts:{exams:Object.keys(exams).length, images:Object.keys(images).length, dossiers:Object.keys(dossiers).length} };
}
