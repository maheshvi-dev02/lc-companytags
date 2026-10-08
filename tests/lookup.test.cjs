const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const path = require('node:path');
const core = require('../extension/core.js');
const lookup = require('../extension/lookup.js');

const COMMIT = 'a'.repeat(40);
const SYNCED_AT = '2026-10-08T12:00:00Z';
const SOURCE_AT = '2026-08-16T22:18:35Z';

function compactStorage(values) {
  return {
    values: structuredClone(values), reads: [],
    async get(keys) {
      this.reads.push(keys);
      assert.ok(Array.isArray(keys), 'lookup must request explicit keys instead of the entire storage cache');
      assert.ok(!keys.includes('lctData') && !keys.includes('lctCache'), 'no full question records are deserialized');
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, structuredClone(this.values[key])]));
    }
  };
}

function fixture() {
  const files = [];
  const parsed = {};
  const add = (name, window, rows) => {
    const filename = name + '/' + core.WINDOW_FILES[window];
    const file = { name, window, path: filename, sha: 'b'.repeat(40) };
    const text = 'Difficulty,Title,Frequency,Link,Topics\n' + rows.map(([slug, score]) =>
      ['Easy', core.formatProblemTitle(slug), score === null ? '' : score, 'https://leetcode.com/problems/' + slug + '/', 'Array'].join(',')).join('\n');
    files.push(file);
    parsed[filename] = { sha: file.sha, records: core.parseCompanyRecords(text) };
  };
  add('Alpha & Co', 'all', [['two-sum', 100], ['alpha', 100], ['zero', 0], ['unknown', null]]);
  add('Beta', 'all', [['two-sum', 40]]);
  add('Empty', 'all', []);
  add('Alpha & Co', '30d', [['two-sum', 5], ['recent', 90]]);
  add('Beta', '30d', []);
  add('Empty', '30d', []);
  const data = core.buildData(files, parsed, COMMIT, SOURCE_AT, SYNCED_AT);
  const status = { phase: 'idle', dataSource: 'live', completed: files.length, total: files.length,
    hasData: true, commit: COMMIT, lastSyncedAt: SYNCED_AT, sourceUpdatedAt: SOURCE_AT,
    companyCount: data.companyCount, problemCount: data.problemCount };
  const values = lookup.buildStorage(data, status);
  return { data, status, values, storage: compactStorage({ ...values, lctStatus: status }) };
}

test('compact lookup preserves exact bundled tags for Two Sum and Score of Parentheses in every window', async () => {
  const data = JSON.parse(gunzipSync(readFileSync(path.join(__dirname, '../extension/data/snapshot.json.gz'))));
  const status = { phase: 'syncing', dataSource: 'bundled', message: 'Refreshing source data.' };
  const values = lookup.buildStorage(data, status);
  assert.equal(Object.keys(values).length, 1 + 5 * lookup.SHARD_COUNT, 'every shard is replaced, including empty buckets');
  const storage = compactStorage({ ...values, lctStatus: status });
  for (const slug of ['two-sum', 'score-of-parentheses']) for (const window of Object.keys(core.WINDOW_FILES)) {
    const result = await lookup.readProblem(storage, slug, window);
    assert.equal(result.ok, true);
    assert.equal(result.available, true);
    assert.equal(result.windowAvailable, true);
    assert.deepEqual(result.companies, core.companiesForSlug(data, slug, window), slug + ' ' + window);
    assert.equal(result.status.commit, data.commit);
    assert.equal(result.status.sourceUpdatedAt, data.sourceUpdatedAt);
    assert.equal(result.status.phase, 'syncing');
    assert.deepEqual(storage.reads.at(-1).slice().sort(), [lookup.META_KEY, lookup.shardKey(slug, window), 'lctStatus'].sort());
  }
  assert.equal((await lookup.readProblem(storage, 'score-of-parentheses', 'all')).companies.length > 0, true, 'known tags cannot appear as an empty successful result');
});

test('problem and status reads touch only their small explicit keys and retain pinned source metadata', async () => {
  const { data, status, storage } = fixture();
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; throw new Error('Lookup unexpectedly requested the network.'); };
  try {
    storage.values.lctStatus = { ...status, phase: 'error', message: 'Offline. Showing cached results.',
      commit: COMMIT, lastSyncedAt: '2026-10-08T14:00:00Z',
      sourceUpdatedAt: '2026-10-08T14:00:00Z', companyCount: 999, problemCount: 999 };
    const all = await lookup.readProblem(storage, 'two-sum', 'all');
    assert.deepEqual(all.companies, core.companiesForSlug(data, 'two-sum', 'all'));
    assert.deepEqual(all.companies.map((company) => [company.name, company.frequency, company.rank, company.problemCount]), [
      ['Alpha & Co', 100, 1, 4], ['Beta', 40, 1, 1]
    ]);
    assert.match(all.companies[0].sourceUrl, new RegExp('/blob/' + COMMIT + '/Alpha%20%26%20Co/5\\.%20All\\.csv$'));
    assert.equal(all.status.commit, COMMIT, 'refresh metadata never relabels the published rows');
    assert.equal(all.status.sourceUpdatedAt, SOURCE_AT);
    assert.equal(all.status.lastSyncedAt, SYNCED_AT);
    assert.equal(all.status.companyCount, data.companyCount);
    assert.equal(all.status.problemCount, data.problemCount);
    assert.equal(all.status.phase, 'error');
    assert.equal(all.status.message, 'Offline. Showing cached results.');
    const recent = await lookup.readProblem(storage, 'two-sum', '30d');
    assert.deepEqual(recent.companies.map((company) => [company.name, company.frequency, company.rank, company.problemCount]), [['Alpha & Co', 5, 2, 2]]);
    const statusResult = await lookup.readStatus(storage);
    assert.equal(statusResult.commit, COMMIT);
    assert.equal(statusResult.phase, 'error');
    assert.deepEqual(storage.reads.at(-1).slice().sort(), [lookup.META_KEY, 'lctStatus'].sort());
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('unknown problems are distinct from unavailable windows, missing shards, and invalid requests', async () => {
  const { storage } = fixture();
  const unknown = await lookup.readProblem(storage, 'not-in-source', 'all');
  assert.deepEqual(unknown.companies, []);
  assert.equal(unknown.available, true);
  assert.equal(unknown.windowAvailable, true);
  const unavailable = await lookup.readProblem(storage, 'two-sum', 'older');
  assert.deepEqual(unavailable.companies, []);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.windowAvailable, false);
  delete storage.values[lookup.shardKey('two-sum', 'all')];
  assert.equal(await lookup.readProblem(storage, 'two-sum', 'all'), null, 'missing shard must trigger the full-cache fallback');
  delete storage.values[lookup.META_KEY];
  assert.equal(await lookup.readProblem(storage, 'not-in-source', 'all'), null);
  assert.equal(await lookup.readStatus(storage), null);
  const reads = storage.reads.length;
  for (const slug of ['__proto__', 'Two-Sum', 'bad/slug', null]) await assert.rejects(lookup.readProblem(storage, slug, 'all'), /slug|problem|invalid/i);
  for (const window of ['week', '__proto__', 0]) await assert.rejects(lookup.readProblem(storage, 'two-sum', window), /window|invalid/i);
  assert.equal(storage.reads.length, reads, 'invalid requests fail before storage reads');
});

test('incompatible metadata and a cross-revision shard never return a false complete lookup', async () => {
  const { values, status } = fixture();
  const key = lookup.shardKey('two-sum', 'all');
  const mutations = [
    (state) => { state[lookup.META_KEY].version = 2; },
    (state) => { state[lookup.META_KEY].commit = 'invalid'; },
    (state) => { state[lookup.META_KEY].revision += '-stale'; },
    (state) => { state[lookup.META_KEY].windows.all.available = 'yes'; },
    (state) => { state[lookup.META_KEY].windows.all.questionCounts[0] = -1; },
    (state) => { state[lookup.META_KEY].companies[1] = state[lookup.META_KEY].companies[0]; },
    (state) => { state[key].revision = 'c'.repeat(40) + ':' + SYNCED_AT; },
    (state) => { state[key].revision = COMMIT + ':2026-10-08T12:01:00Z'; },
    (state) => { state[key].index['two-sum'] = {}; }
  ];
  for (const mutate of mutations) {
    const state = structuredClone({ ...values, lctStatus: status });
    mutate(state);
    assert.equal(await lookup.readProblem(compactStorage(state), 'two-sum', 'all'), null);
  }
  assert.equal(lookup.buildStorage({ version: 1, index: {}, companies: [] }, status), null, 'legacy caches retain the existing fallback');
});

test('invalid compact tuples fail closed while duplicate valid companies are suppressed', async () => {
  const { values, status } = fixture();
  const key = lookup.shardKey('two-sum', 'all');
  const tuples = values[key].index['two-sum'];
  const [id, score, rank] = tuples[0];
  const invalid = [null, {}, [-1, score, rank], [999, score, rank], [String(id), score, rank],
    [id, -1, rank], [id, Infinity, rank], [id, '100', rank], [id, score, 0],
    [id, score, 1.5], [id, score, 999], [id, null, rank], [id, score]];
  for (const tuple of invalid) {
    const state = structuredClone({ ...values, lctStatus: status });
    state[key].index['two-sum'].push(tuple);
    assert.equal(await lookup.readProblem(compactStorage(state), 'two-sum', 'all'), null, JSON.stringify(tuple));
  }
  const duplicated = structuredClone({ ...values, lctStatus: status });
  duplicated[key].index['two-sum'].push(tuples[0].slice());
  const deduplicated = await lookup.readProblem(compactStorage(duplicated), 'two-sum', 'all');
  assert.equal(deduplicated.companies.length, 2);
  const unknown = await lookup.readProblem(compactStorage({ ...values, lctStatus: status }), 'unknown', 'all');
  assert.deepEqual(unknown.companies.map((company) => [company.frequency, company.rank]), [[null, null]]);
});


test('a newer published status commit rejects stale compact problem rows and status', async () => {
  const { values, status } = fixture();
  const storage = compactStorage({ ...values, lctStatus: { ...status, commit: 'c'.repeat(40) } });
  assert.equal(await lookup.readProblem(storage, 'two-sum', 'all'), null,
    'old compact rows must not override a newer published dataset');
  assert.equal(await lookup.readStatus(storage), null,
    'old compact provenance must not override a newer published status');
  storage.values.lctStatus.commit = COMMIT;
  assert.equal((await lookup.readProblem(storage, 'two-sum', 'all')).companies.length, 2,
    'matching commit restores the valid lookup');
  assert.equal((await lookup.readStatus(storage)).commit, COMMIT);
});
