import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Generate a release snapshot. Builds themselves stay offline/reproducible.
// An already verified local storage export can also be supplied explicitly.
const require = createRequire(import.meta.url);
const core = require('../extension/core.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let data;
async function request(url, binary = false) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(30000), headers: { Accept: binary ? 'application/zip' : 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`Source request failed: HTTP ${response.status}`);
  return binary ? new Uint8Array(await response.arrayBuffer()) : response.json();
}
if (args[0] === '--from-storage' && args.length === 2) {
  const storage = JSON.parse(await readFile(path.resolve(args[1]), 'utf8'));
  data = storage.lctData;
} else if (!args.length) {
  const archive = require('../extension/archive.js');
  const metadata = await request(core.API_URL + '/commits/main');
  const commit = metadata.sha;
  const treeSha = metadata.commit?.tree?.sha;
  const sourceUpdatedAt = metadata.commit?.committer?.date;
  assert.match(commit || '', core.SHA_PATTERN);
  assert.match(treeSha || '', core.SHA_PATTERN);
  assert.ok(Number.isFinite(Date.parse(sourceUpdatedAt)));
  const files = core.selectWindowFiles(await request(core.API_URL + '/git/trees/' + treeSha + '?recursive=1'));
  const bytes = await request('https://codeload.github.com/liquidslr/leetcode-company-wise-problems/zip/' + commit, true);
  const parsed = await archive.readCompanyArchive(bytes, { commit, files });
  data = core.buildData(files, parsed, commit, sourceUpdatedAt, sourceUpdatedAt);
} else {
  throw new Error('Usage: node scripts/snapshot.mjs [--from-storage <verified-storage.json>]');
}
assert.ok(data && data.version === core.DATA_VERSION && data.schema === core.DATA_SCHEMA, 'Expected a complete current-format dataset');
assert.match(data.commit || '', core.SHA_PATTERN);
assert.ok(Number.isFinite(Date.parse(data.sourceUpdatedAt)));
const files = core.selectWindowFiles({ tree: Object.entries(data.files).map(([filePath, file]) => ({ type: 'blob', path: filePath, sha: file.sha })) });
// Rebuild, rather than trusting a stored index or carrying sync/profile state.
data = core.buildData(files, data.files, data.commit, data.sourceUpdatedAt, data.sourceUpdatedAt);
for (const window of Object.keys(core.WINDOW_FILES)) {
  assert.ok(core.windowAvailable(data, window) && data.windows[window].companyCount === data.companyCount,
    `Expected every company in the ${window} window`);
}
const bytes = gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
const metadata = {
  version: 1, schema: data.schema, acceptanceVersion: data.acceptanceVersion, source: core.SOURCE_URL,
  commit: data.commit, sourceUpdatedAt: data.sourceUpdatedAt,
  bundledAt: new Date().toISOString(), companies: data.companyCount, problems: data.problemCount,
  files: files.length, windows: Object.fromEntries(Object.entries(data.windows).map(([key, value]) => [key, value.problemCount])),
  compressedBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
};
const out = path.join(root, 'extension/data');
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'snapshot.json.gz.tmp'), bytes);
await writeFile(path.join(out, 'snapshot-meta.json.tmp'), JSON.stringify(metadata, null, 2) + '\n');
await rename(path.join(out, 'snapshot.json.gz.tmp'), path.join(out, 'snapshot.json.gz'));
await rename(path.join(out, 'snapshot-meta.json.tmp'), path.join(out, 'snapshot-meta.json'));
console.log(JSON.stringify(metadata, null, 2));
