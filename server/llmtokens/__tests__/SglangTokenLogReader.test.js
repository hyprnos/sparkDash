import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmTokenLedger } from '../LlmTokenLedger.js';
import { readSglangTokenLogs, parsePrefillLog } from '../SglangTokenLogReader.js';
const source = { sparkId: 's', port: 8888, modelId: 'm', containerName: 'head' };
const line = (computed, cached, rank = 0) => JSON.stringify({ time: '2026-10-23T01:00:01Z', log: `[2026-10-23 01:00:01 TP${rank}] Prefill batch, #new-seq: 1, #new-token: ${computed}, #cached-token: ${cached}, test` }) + '\n';
test('only head logging rank is counted; chunk continuation adds compute without repeated cache', () => {
 assert.deepEqual(parsePrefillLog(line(100, 900)), { at: Date.parse('2026-10-23T01:00:01Z'), computed: 100, cached: 900 });
 assert.equal(parsePrefillLog(line(100, 900, 1)), null);
 assert.equal(parsePrefillLog('not json'), null);
});
test('backfill, timestamps, partial lines, restart, idempotency and reset persist together', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-token-'));
 const configPath = path.join(root, 'sources.json');
 fs.writeFileSync(configPath, JSON.stringify([source]));
 const id = 'a'.repeat(64), dir = path.join(root, id);
 fs.mkdirSync(dir);fs.writeFileSync(path.join(dir, 'config.v2.json'), JSON.stringify({Name:'/head'}));
 const log = path.join(dir, id+'-json.log');
 fs.writeFileSync(log, line(100,900)+line(50,0)+line(999,999,1)+'{"time":');
 const store = path.join(root, 'ledger.json');
 let ledger = new LlmTokenLedger(store);
 // Unknown pre-existing traffic must not be represented as cache misses.
 ledger.record([{...source, output:0,prompt:0,cached:null}], Date.parse('2026-10-23T00:00Z'));
 ledger.record([{...source, output:1,prompt:1000,cached:null}], Date.parse('2026-10-23T00:01Z'));
 const read = () => readSglangTokenLogs(ledger, {configPath, dockerRoot:root});
 read();read();ledger.close();ledger = new LlmTokenLedger(store);read();
 let model = ledger.snapshot('all').series[0].models[0];
 assert.equal(model.promptTokens,2050);assert.equal(model.cachedTokens,900);assert.equal(model.cacheObservedPromptTokens,1050);
 assert.equal(ledger.history().hour.find(r => r.t.endsWith('T01')).cachedTokens,900);
 fs.appendFileSync(log, '"2026-10-23T01:01Z","log":"ignore"}\n'+line(1,99));read();
 model=ledger.snapshot().series[0].models[0];assert.equal(model.cachedTokens,999);
 ledger.reset();read();assert.equal(ledger.snapshot().series[0].models.length,0);
 fs.appendFileSync(log,line(2,98));read();assert.equal(ledger.snapshot().series[0].models[0].cachedTokens,98);
 ledger.close();
});
