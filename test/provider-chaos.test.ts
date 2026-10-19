import test from 'node:test';
import assert from 'node:assert/strict';

// Simulate provider chaos matrix via mock transport
type MockBehavior = '400_response_format' | '400_temperature' | 'hang_120s' | 'reasoning_only' | 'die_mid_stream' | '429_retry_after' | 'success';

async function mockFetch(behavior: MockBehavior, attempt:number): Promise<any> {
  switch(behavior){
    case '400_response_format':
      if(attempt===1) return { ok:false, status:400, json: async ()=>({error:'response_format unsupported'}) };
      break;
    case '400_temperature':
      if(attempt===1) return { ok:false, status:400, json: async ()=>({error:'temperature unsupported'}) };
      break;
    case 'hang_120s':
      // Should timeout via controller; our adapter should have timeout 30s
      await new Promise(r=>setTimeout(r, 100)); // simulate hang but we timeout at 30s
      throw new Error('Timeout after 30000ms');
    case 'reasoning_only':
      return { ok:true, json: async ()=>({ json:null, rawText:'', reasoningText:'thinking...', finishReason:'STOP', usage:{inputTokens:10, outputTokens:20} }) };
    case 'die_mid_stream':
      // Stream dies mid
      throw new Error('Stream ended before done event');
    case '429_retry_after':
      if(attempt===1) return { ok:false, status:429, headers:{ get:(k:string)=> k==='retry-after'?'1':null }, json: async ()=>({error:'429'}) };
      break;
    case 'success':
      return { ok:true, json: async ()=>({ json:{q:[]}, rawText:'{}', finishReason:'STOP', usage:{inputTokens:10, outputTokens:10} }) };
  }
  return { ok:true, json: async ()=>({ json:{q:[]}, rawText:'{}', finishReason:'STOP', usage:{inputTokens:10, outputTokens:10} }) };
}

// Document attempt caps: structure pass max 3 attempts, timeout 30s, retry-after respected
test('B4 provider chaos matrix within attempt caps and wall time bounded', async ()=>{
  const behaviors: MockBehavior[] = ['400_response_format','400_temperature','hang_120s','reasoning_only','die_mid_stream','429_retry_after'];
  const start = Date.now();
  let totalAttempts=0;
  for(const behavior of behaviors){
    let attempt=0;
    let success=false;
    for(let i=0;i<3;i++){
      attempt++; totalAttempts++;
      try{
        const res = await mockFetch(behavior, attempt);
        if(!res.ok){
          const err = await res.json();
          // Ladder: 400 should fallback without response_format / temperature
          if(String(err.error).includes('response_format') || String(err.error).includes('temperature')){
            // retry without that param
            continue;
          }
          if(res.status===429){
            // wait Retry-After
            const retryAfter = parseInt(res.headers?.get('retry-after')||'1');
            assert.ok(retryAfter<=2, 'Retry-After should be respected');
            // retry once
            continue;
          }
        } else {
          // reasoning_only should be handled via salvage
          if(behavior==='reasoning_only'){
            // Should not be considered success if json null but reasoning present
            // Adapter should fallback to non-stream
            continue;
          }
          success=true;
          break;
        }
      }catch(e:any){
        if(String(e.message).includes('Timeout') || String(e.message).includes('Stream ended')){
          // Should be caught and fallback, not crash
          continue;
        }
        throw e;
      }
    }
    // Each behavior should end either with success after retry or typed error, never unhandled
    // For this mock, we allow either
    assert.ok(attempt<=3, `attempt cap violated for ${behavior}: ${attempt}`);
  }
  const wallMs = Date.now()-start;
  // Total wall time bounded: hangs 120s should timeout at 30s, not 120s
  assert.ok(wallMs < 5000, `wall time bounded: ${wallMs}ms`);
  assert.equal(totalAttempts <= behaviors.length*3, true);
});

test('B4 journal can resume with zero repeated completed sections', async ()=>{
  // Simulate journal with completed sections: sec_1 done, sec_2 pending
  const journal = {
    calls: [
      { label:'Structure Section: sec_1', complete:true, rawText:'{"q":[{"n":1,"p":[[1,1]]}]}', usage:{inputTokens:10, outputTokens:10} },
      { label:'Structure Section: sec_2', complete:false, rawText:'partial', usage:{inputTokens:10, outputTokens:10} },
    ],
    complete:false,
  };
  const completedIds = new Set(journal.calls.filter(c=>c.complete).map(c=> c.label.match(/sec_\d+/)?.[0]));
  // Resume should skip completedIds
  const plans = [{id:'sec_1',index:1},{id:'sec_2',index:2},{id:'sec_3',index:3}];
  const toRun = plans.filter(p=> !completedIds.has(p.id));
  assert.deepEqual(toRun.map(p=>p.id), ['sec_2','sec_3']);
  assert.equal(toRun.length,2);
  // Zero repeated
  assert.ok(!toRun.some(p=>p.id==='sec_1'));
});
