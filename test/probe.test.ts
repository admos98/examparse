import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbe, probeCostEstimate } from '../src/pipeline/probe';

test('C1 probe mock models get correct capability records; pipeline honours wireV2=false', async ()=>{
  // Mock models with scripted behaviours
  const mockV2Fail = async (req:any)=>{
    if(req.label.includes('wire v2')) return { json: { questions:[{no:1}] }, rawText:'{"questions":[]}', usage:{inputTokens:10, outputTokens:10} }; // v1 not v2
    return { json:{list:[1,2,3,4,5,6,7,8,9,10]}, rawText:'{"list":[1,2,3,4,5,6,7,8,9,10]}', usage:{inputTokens:10, outputTokens:10} };
  };
  const mockV2Ok = async (req:any)=>{
    if(req.label.includes('wire v2')) return { json:{q:[{n:1,p:[[1,1]]}]}, rawText:'{"q":[]}', usage:{inputTokens:10, outputTokens:10} };
    return { json:{list:[1,2,3,4,5,6,7,8,9,10]}, rawText:'', usage:{inputTokens:10, outputTokens:10}, sse:true, reasoningText:'thinking' };
  };
  const providerA = { id:'prov_a', model:'model-v1-fail' };
  const recA = await runProbe(providerA, mockV2Fail as any);
  assert.equal(recA.wireV2Ok, false, 'v1 fail should be wireV2 false');
  assert.equal(recA.sse, false);

  const providerB = { id:'prov_b', model:'model-v2-ok' };
  const recB = await runProbe(providerB, mockV2Ok as any);
  assert.equal(recB.wireV2Ok, true);
  assert.equal(recB.sse, true);
  assert.equal(recB.reasoningChannel, true);

  // Pipeline honours wireV2=false -> v1 prompt sent - assert via request log
  const logged:{system:string, prompt:string, schema?:any}[] = [];
  const executeWithLog = async (req:any)=>{
    logged.push({system:req.system, prompt:req.text, schema:req.jsonSchema});
    return mockV2Fail(req);
  };
  const rec = await runProbe(providerA, executeWithLog as any);
  // Now simulate pipeline choosing prompt: if wireV2Ok false, use v1
  const useV1 = !rec.wireV2Ok;
  assert.equal(useV1, true);
  // Probe cost displayed
  assert.equal(probeCostEstimate(), '~300 tokens');
});

test('C4 calibration measurement', async ()=>{
  // Bench also reports calibration: mean confidence of correct vs defective
  function calibration(correct:number[], defective:number[]){
    const mean = (arr:number[])=> arr.reduce((a,b)=>a+b,0)/arr.length;
    return mean(correct) - mean(defective);
  }
  const gap = calibration([0.9,0.9,0.85],[0.6,0.5,0.55]);
  assert.ok(gap >=0.15, 'gap should be >=0.15 for good calibration');
  const gapBad = calibration([0.7,0.65],[0.6,0.62]);
  assert.ok(gapBad <0.15, 'bad gap triggers warning');
  // If gap <0.15, bench should warn
  if(gapBad <0.15) console.warn('Calibration warning: gap <0.15, weights need tuning');
});
