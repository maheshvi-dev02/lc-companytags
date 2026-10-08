// Optional integration check. Downloads the real public repository into an ignored
// local verification cache, using the same sync engine shipped in the extension.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { createSyncService } = require('../extension/sync.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'live-source');
await mkdir(output, { recursive: true });
const fresh = process.argv.includes('--fresh');
const cachePath = path.join(output, fresh ? 'fresh-storage.json' : 'storage.json');
let state = {};
try { if (!fresh) state = JSON.parse(await readFile(cachePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let lastPrinted = -1, requests = 0, storageWrites = 0, storagePayloadBytes = 0;
const started = performance.now();
const service = createSyncService({
  storage: {
    async get(keys) { return Object.fromEntries(keys.filter(key => key in state).map(key => [key, structuredClone(state[key])])); },
    async set(values) {
      Object.assign(state, structuredClone(values));
      storageWrites++; storagePayloadBytes += Buffer.byteLength(JSON.stringify(values));
      // The integration harness keeps checkpoints in memory; runtime browser
      // storage and worker-restart persistence are exercised separately.
      if (values.lctData) await writeFile(cachePath, JSON.stringify(state));
      const status = values.lctStatus;
      if (status && (status.phase !== 'syncing' || status.completed >= lastPrinted + 60)) {
        console.log(`${status.phase}: ${status.completed}/${status.total} ${status.message}`);
        lastPrinted = status.completed;
      }
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; }
  },
  fetch: async (...args) => { requests++; return fetch(...args); },
  onError: (error) => console.error(error.message)
});
await service.refresh();
await service.waitForIdle();
const status = await service.getStatus();
assert.equal(status.phase, 'idle', status.message);
assert.ok(status.hasData, 'Expected a complete live dataset');
assert.ok(status.companyCount > 100, 'Unexpectedly small company coverage');
assert.ok(status.problemCount > 1000, 'Unexpectedly small problem coverage');
const companies = await service.getCompanies('two-sum');
assert.ok(companies.some(company => company.name === 'Amazon'), 'Expected real Two Sum/Amazon source association');
await writeFile(cachePath, JSON.stringify(state));
const result = { status, requests, elapsedMs: Math.round(performance.now() - started), storageWrites, storagePayloadBytes, twoSumCompanies: companies.length, checkedAt: new Date().toISOString(), storageBytes: Buffer.byteLength(JSON.stringify(state)) };
await writeFile(path.join(output, fresh ? 'fresh-result.json' : 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
