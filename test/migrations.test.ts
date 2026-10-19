import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateDoc, CURRENT_SCHEMA_V } from '../src/pipeline/migrations';

test('E4 data migrations framework from->to pure functions', ()=>{
  const v1 = { id:'exam', schemaV:1, meta:{title:'Old'} };
  const migrated = migrateDoc(v1);
  assert.equal(migrated.schemaV, CURRENT_SCHEMA_V);
  assert.ok(migrated.meta.migrated);
});

test('E4 unknown future schemaV -> read-only', ()=>{
  const future = { id:'exam', schemaV:99, meta:{} };
  const res = migrateDoc(future);
  assert.equal(res._readOnly, true);
  assert.match(res._readOnlyMessage, /newer version/);
});

test('E4 state current versions in summary', ()=>{
  assert.equal(typeof CURRENT_SCHEMA_V, 'number');
  assert.ok(CURRENT_SCHEMA_V >=3);
});
