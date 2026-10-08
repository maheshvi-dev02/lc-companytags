const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deflateRawSync, gzipSync } = require('node:zlib');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const core = require('../extension/core.js');
const { readCompanyArchive } = require('../extension/archive.js');
const { validateSnapshot, loadBundledSnapshot } = require('../extension/seed.js');

const COMMIT = 'a'.repeat(40);
const ROOT = 'leetcode-company-wise-problems-' + COMMIT + '/';
const csv = (slug = 'two-sum', frequency = 100) => 'Difficulty,Title,Frequency,Acceptance Rate,Link,Topics\nEasy,Two Sum,' + frequency + ',0.5,https://leetcode.com/problems/' + slug + '/,"Array, Hash Table"\n';
const blobSHA = (bytes) => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZIP(entries) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name === undefined ? ROOT + entry.path : entry.name);
    const body = Buffer.from(entry.body);
    const method = entry.method === undefined ? 8 : entry.method;
    const packed = method === 8 ? deflateRawSync(body) : body;
    const crc = entry.crc === undefined ? crc32(body) : entry.crc;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags === undefined ? 0x800 : entry.flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags === undefined ? 0x800 : entry.flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, packed);
    centralParts.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function fixture() {
  const entries = Object.entries(core.WINDOW_FILES).map(([window, filename], index) => ({
    path: 'Société & Co/' + filename, body: window === 'older' ? csv().split('\n')[0] + '\n' : csv('two-sum', 100 - index),
    method: index % 2 ? 0 : 8
  }));
  const files = core.selectWindowFiles({ truncated: false, tree: entries.map((entry) => ({
    type: 'blob', path: entry.path, sha: blobSHA(Buffer.from(entry.body))
  })) });
  return { entries, files };
}

function read(entries, files) {
  return readCompanyArchive(buildZIP(entries), { commit: COMMIT, files });
}

test('local ZIP decoder reads stored and deflated UTF-8 CSVs, empty company lists, and complete windows', async () => {
  const { entries, files } = fixture();
  entries.push({ path: 'README.md', body: 'ignored non-company content' });
  entries.push({ path: '', body: '', method: 0 });
  const seen = [];
  const parsed = await readCompanyArchive(buildZIP(entries), { commit: COMMIT, files,
    onFile: async (file, value) => { seen.push(file.path); assert.equal(value.sha, file.sha); } });
  assert.deepEqual(new Set(Object.keys(parsed)), new Set(files.map((file) => file.path)));
  assert.deepEqual(new Set(seen), new Set(files.map((file) => file.path)));
  for (const file of files) {
    const entry = entries.find((value) => value.path === file.path);
    assert.deepEqual(parsed[file.path], { sha: file.sha, records: core.parseCompanyRecords(entry.body) });
  }
  assert.deepEqual(parsed['Société & Co/4. More Than Six Months.csv'].records, []);
  const data = core.buildData(files, parsed, COMMIT, '2026-08-16T22:18:35Z', '2026-10-08T00:00:00Z');
  for (const window of Object.keys(core.WINDOW_FILES)) assert.equal(core.windowAvailable(data, window), true);
  assert.equal(core.companiesForSlug(data, 'two-sum', 'all')[0].frequency, 100);
});

test('archive completeness and duplicate selected paths are validated before returning an index', async () => {
  const { entries, files } = fixture();
  await assert.rejects(read(entries.slice(1), files), /missing|incomplete|not contain/i);
  await assert.rejects(read([...entries, entries[0]], files), /duplicate/i);
});

test('selected CSV bytes must pass both ZIP CRC and the commit-tree Git blob hash', async () => {
  const { entries, files } = fixture();
  const badCRC = entries.map((entry, index) => index === 0 ? { ...entry, crc: crc32(Buffer.from(entry.body)) ^ 1 } : entry);
  // Buffer.writeUInt32LE requires the unsigned representation of CRC-32.
  badCRC[0].crc >>>= 0;
  await assert.rejects(read(badCRC, files), /CRC|checksum|integrity/i);
  const otherBytes = entries.map((entry, index) => index === 0 ? { ...entry, body: csv('binary-search') } : entry);
  await assert.rejects(read(otherBytes, files), /SHA|blob|integrity|checksum/i);
});

test('unsafe ZIP paths and a different source root are rejected', async () => {
  const { entries, files } = fixture();
  for (const name of [ROOT + '../escape.csv', ROOT + 'nested/../../escape.csv', ROOT + '\\escape.csv', '/absolute.csv']) {
    await assert.rejects(read([...entries, { name, body: 'bad' }], files), /path|root|archive|ZIP/i, name);
  }
  const differentRoot = entries.map((entry) => ({ ...entry, name: 'different-repository-' + COMMIT + '/' + entry.path }));
  await assert.rejects(read(differentRoot, files), /root|path|commit|archive/i);
});

test('truncated or inconsistent ZIP headers fail safely', async () => {
  const { entries, files } = fixture();
  const valid = buildZIP(entries);
  for (const invalid of [Buffer.alloc(0), valid.subarray(0, 10), valid.subarray(0, valid.length - 8)]) {
    await assert.rejects(readCompanyArchive(invalid, { commit: COMMIT, files }), /ZIP|archive|truncat|directory/i);
  }
  const badOffset = Buffer.from(valid);
  badOffset.writeUInt32LE(0xffffffff, badOffset.length - 6);
  await assert.rejects(readCompanyArchive(badOffset, { commit: COMMIT, files }), /ZIP|archive|bound|directory/i);
  const badLocalName = Buffer.from(valid);
  badLocalName[30] ^= 1;
  await assert.rejects(readCompanyArchive(badLocalName, { commit: COMMIT, files }), /ZIP|archive|header|name|path/i);
});

test('encrypted or unsupported selected ZIP entries cannot be treated as company CSVs', async () => {
  const { entries, files } = fixture();
  for (const changed of [{ flags: 0x801 }, { method: 99 }]) {
    await assert.rejects(read(entries.map((entry, index) => index === 0 ? { ...entry, ...changed } : entry), files), /encrypt|method|compression|unsupported|ZIP/i);
  }
});

test('a CSV with a matching source hash still has to satisfy the company schema', async () => {
  const { entries, files } = fixture();
  entries[0].body = 'Title,URL\nBroken,x';
  files.find((file) => file.path === entries[0].path).sha = blobSHA(Buffer.from(entries[0].body));
  await assert.rejects(read(entries, files), /Link column|CSV|company/i);
});

function preparedSnapshot() {
  const { entries, files } = fixture();
  const parsed = Object.fromEntries(files.map((file) => [file.path, {
    sha: file.sha, records: core.parseCompanyRecords(entries.find((entry) => entry.path === file.path).body)
  }]));
  return core.buildData(files, parsed, COMMIT, '2026-08-16T22:18:35Z', '2026-10-08T00:00:00Z');
}

test('bundled snapshot loader reads local gzip without network hosts and validates every time window', async () => {
  const data = preparedSnapshot();
  const packed = gzipSync(Buffer.from(JSON.stringify(data)));
  const url = 'chrome-extension://test/data/snapshot.json.gz';
  const calls = [];
  const loaded = await loadBundledSnapshot({ url, fetch: async (target) => {
    calls.push(target);
    return new Response(packed, { status: 200 });
  } });
  assert.deepEqual(calls, [url]);
  assert.deepEqual(loaded, data);
  validateSnapshot(loaded);
  for (const window of Object.keys(core.WINDOW_FILES)) assert.equal(core.windowAvailable(loaded, window), true);
});

test('invalid packaged snapshots are rejected instead of exposing incorrect indexes', async () => {
  const data = preparedSnapshot();
  const badData = [
    {},
    { ...data, commit: 'invalid' },
    { ...data, sourceUpdatedAt: 'invalid date' },
    { ...data, windows: { ...data.windows, '30d': { ...data.windows['30d'], available: false } } },
    { ...data, files: {} }
  ];
  for (const invalid of badData) assert.throws(() => validateSnapshot(invalid), /snapshot|data|window|commit|index|file|company|count/i);
  const invalidReference = structuredClone(data);
  invalidReference.windows.all.index['two-sum'][0] = [999, 0];
  invalidReference.companyCount = 999;
  const rebuilt = validateSnapshot(invalidReference);
  assert.deepEqual(rebuilt, data, 'untrusted serialized associations and totals are rebuilt from validated source records');
  const invalidRank = structuredClone(data);
  invalidRank.files['Société & Co/5. All.csv'].records[0].rank = 9;
  assert.throws(() => validateSnapshot(invalidRank), /snapshot|rank/i);
  await assert.rejects(loadBundledSnapshot({ url: 'moz-extension://test/data/snapshot.json.gz', fetch: async () => new Response('bad gzip') }), (error) => error instanceof Error);
});

test('actual packaged snapshot is complete and usable for tags, ranks, and practice offline', async () => {
  const file = path.resolve(__dirname, '../extension/data/snapshot.json.gz');
  assert.ok(existsSync(file), 'release must include the prepared first-install snapshot');
  const loaded = await loadBundledSnapshot({ url: 'moz-extension://test/data/snapshot.json.gz', fetch: async () => new Response(readFileSync(file)) });
  validateSnapshot(loaded);
  assert.ok(loaded.companyCount >= 400);
  assert.ok(loaded.problemCount >= 3000);
  for (const window of Object.keys(core.WINDOW_FILES)) {
    assert.equal(core.windowAvailable(loaded, window), true);
    assert.ok(loaded.windows[window].companyCount >= 400);
    assert.ok(loaded.windows[window].problemCount > 0);
  }
  const companies = core.companiesForSlug(loaded, 'two-sum');
  assert.ok(companies.length > 50);
  assert.ok(companies.some((company) => typeof company.frequency === 'number' && company.rank >= 1));
  assert.ok(companies.every((company) => company.frequency === null ? company.rank === null : Number.isFinite(company.frequency) && company.rank >= 1));
  const practice = core.practiceQuestions(loaded, { company: 'Amazon', window: 'all', excludeSlug: 'two-sum' });
  assert.equal(practice.available, true);
  assert.ok(practice.questions.length > 0);
  assert.ok(practice.questions.every((question) => question.slug !== 'two-sum'));
});
