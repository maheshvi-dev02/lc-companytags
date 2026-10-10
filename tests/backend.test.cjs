const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
const core = require('../extension/core.js');
const lookup = require('../extension/lookup.js');
const { createSyncService, MAX_RUN_FAILURES, REQUEST_TIMEOUT_MS } = require('../extension/sync.js');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const TREE_SHA = 'd'.repeat(40);
const BLOB_A = '1'.repeat(40);
const BLOB_B = '2'.repeat(40);
const BLOB_C = '3'.repeat(40);
const FIXED_NOW = Date.parse('2026-10-07T12:00:00Z');

function memoryStorage(initial = {}, delay = false) {
  const values = structuredClone(initial);
  const writes = [];
  const removals = [];
  return {
    values, writes, removals,
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(values);
      const requested = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(requested.filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])]));
    },
    async set(next) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, 1));
      writes.push(structuredClone(next));
      Object.assign(values, structuredClone(next));
    },
    async remove(keys) {
      const requested = typeof keys === 'string' ? [keys] : keys;
      removals.push(requested.slice());
      for (const key of requested) delete values[key];
    }
  };
}

function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: new Headers(headers), async json() { return structuredClone(body); }, async text() { return body; },
    async arrayBuffer() { const bytes = Buffer.from(body); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
}

function csv(slugs) {
  return 'Difficulty,Title,Frequency,Acceptance Rate,Link,Topics\r\n' + slugs.map((slug) =>
    'EASY,Example,20,0.5,https://leetcode.com/problems/' + slug + '/,"Array, Hash Table"').join('\r\n');
}

function recordsCSV(rows) {
  const field = (value) => '"' + String(value === null || value === undefined ? '' : value).replaceAll('"', '""') + '"';
  return 'Difficulty,Title,Frequency,Acceptance Rate,Link,Topics\n' + rows.map((row) => [
    row.difficulty || 'Easy', row.title || core.formatProblemTitle(row.slug), row.frequency,
    '0.5', 'https://leetcode.com/problems/' + row.slug + '/', (row.topics || []).join(', ')
  ].map(field).join(',')).join('\n');
}

function company(name, sha) {
  return { type: 'blob', path: name + '/5. All.csv', sha };
}

function sourceFixture() {
  const source = { commit: SHA_A, files: [company('Amazon', BLOB_A), company('Google', BLOB_B)],
    csvByCompany: { Amazon: csv(['two-sum']), Google: csv(['two-sum', 'add-two-numbers']) }, csvByPath: {}, failures: {}, delays: {}, calls: [], active: 0, maxActive: 0 };
  source.fetch = async (url, options) => {
    source.calls.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (url.endsWith('/commits/main')) {
      if (source.failures.metadata) return source.failures.metadata();
      return response({ sha: source.commit, commit: { committer: { date: '2026-08-16T22:18:35Z' }, tree: { sha: TREE_SHA } } });
    }
    if (url.includes('/git/trees/')) return response({ truncated: false, tree: source.files });
    if (url.startsWith('https://codeload.github.com/')) {
      assert.ok(url.endsWith('/zip/' + source.commit), 'archive is pinned to the selected commit');
      if (source.failures.archive) return source.failures.archive();
      return response(source.archive || '', source.archive ? 200 : 404);
    }
    assert.ok(url.startsWith(core.RAW_URL + '/' + source.commit + '/'), 'raw requests are pinned to the selected commit');
    const name = decodeURIComponent(url.split('/').at(-2));
    const path = url.split('/').slice(-2).map(decodeURIComponent).join('/');
    if (source.failures[path]) return source.failures[path]();
    if (source.failures[name]) return source.failures[name]();
    source.active += 1;
    source.maxActive = Math.max(source.active, source.maxActive);
    if (source.delays[path] || source.delays[name]) await (source.delays[path] || source.delays[name]);
    else await new Promise((resolve) => setTimeout(resolve, 1));
    source.active -= 1;
    return response(source.csvByPath[path] || source.csvByCompany[name]);
  };
  return source;
}

function makeService(storage, source, extras = {}) {
  // Most original regressions intentionally exercise the CSV fallback/incremental path.
  // Archive-specific tests below enable the production decoder explicitly.
  return createSyncService({ storage, fetch: source.fetch, now: () => FIXED_NOW, sleep: async () => {}, archive: false, ...extras });
}

test('CSV parser supports BOM, commas, escaped quotes, CRLF and embedded newlines', () => {
  assert.deepEqual(core.parseCSV('\uFEFFTitle,Link\r\n"Pow(x, n)",a\r\n"A ""quoted""\nname",b\r\n'), [
    ['Title', 'Link'], ['Pow(x, n)', 'a'], ['A "quoted"\nname', 'b']
  ]);
  assert.deepEqual(core.parseCSV('a,b,\n\n'), [['a', 'b', '']]);
  assert.throws(() => core.parseCSV('a,"broken'), /unterminated/);
  assert.throws(() => core.parseCSV('a,"good"bad'), /closing quote/);
  assert.throws(() => core.parseCSV('un"quoted,x'), /unexpected quote/);
});

test('problem slug normalization strictly validates origins and both problem path forms', () => {
  for (const url of [
    'https://leetcode.com/problems/two-sum/',
    'https://www.leetcode.com/problems/two-sum/description/?envType=company',
    'https://leetcode.cn/problems/two-sum/?a=b#solution',
    'https://www.leetcode.cn/contest/weekly-contest-400/problems/two-sum/',
    'https://leetcode.com:443/problems/two-sum',
    'https://leetcode.com/problems/two%2Dsum/'
  ]) assert.equal(core.getProblemSlug(url), 'two-sum', url);
  for (const url of [
    '/problems/two-sum', 'http://leetcode.com/problems/two-sum',
    'https://leetcode.com.evil.test/problems/two-sum', 'https://evil.test/leetcode.com/problems/two-sum',
    'https://user:secret@leetcode.com/problems/two-sum', 'https://leetcode.com:8080/problems/two-sum',
    'https://leetcode.com/problems/../../foo', 'https://leetcode.com/problems/%2Fbad',
    'https://leetcode.com/problems/%ZZ', 'https://leetcode.com/problemset/',
    'https://leetcode.com/problems/Two-Sum', 'https://leetcode.com/problems/two_sum',
    'https://leetcode.com/problems/__proto__'
  ]) assert.equal(core.getProblemSlug(url), null, url);
  assert.equal(core.formatProblemTitle('add-two-numbers'), 'Add Two Numbers');
});

test('company CSV validates schema, rejects broken rows, deduplicates links, and accepts header-only files', () => {
  assert.deepEqual(core.parseCompanyCSV(csv(['two-sum', 'two-sum'])), ['two-sum']);
  assert.deepEqual(core.parseCompanyCSV(csv([])), []);
  assert.throws(() => core.parseCompanyCSV('Title,URL\nName,x'), /Link column/);
  assert.throws(() => core.parseCompanyCSV('Title,Link\nName'), /malformed row/);
  assert.throws(() => core.parseCompanyCSV('Title,Link\nName,https://evil.test/problems/x'), /invalid LeetCode/);
  assert.throws(() => core.parseCompanyCSV(''), /empty/);
});

test('only complete all-time company files are selected and source links are pinned and escaped', () => {
  const files = core.selectCompanyFiles({ truncated: false, tree: [
    company('A & B', BLOB_A), company('Google', BLOB_B),
    { type: 'blob', path: 'Google/1. Thirty Days.csv', sha: BLOB_C },
    { type: 'tree', path: 'Not a file/5. All.csv', sha: BLOB_C },
    { type: 'blob', path: 'nested/company/5. All.csv', sha: BLOB_C }
  ] });
  assert.deepEqual(files.map((file) => file.name), ['A & B', 'Google']);
  assert.match(core.sourceFileURL(SHA_A, files[0].path), /\/blob\/a{40}\/A%20%26%20B\/5\.%20All\.csv$/);
  assert.throws(() => core.selectCompanyFiles({ truncated: true, tree: [] }), /incomplete/);
  assert.throws(() => core.selectCompanyFiles({ truncated: false, tree: [] }), /No all-time/);
  assert.throws(() => core.buildData(files, {}, SHA_A, '', ''), /incomplete/);
});

test('initial sync publishes a complete compact index with bounded parallel fetches', async () => {
  const source = sourceFixture();
  source.files.push(company('Header Only', BLOB_C));
  source.csvByCompany['Header Only'] = csv([]);
  const storage = memoryStorage();
  const pending = [];
  const service = makeService(storage, source, { concurrency: 2, onPending: async (value) => pending.push(value) });
  const initial = await service.refresh();
  assert.equal(initial.phase, 'syncing');
  await service.waitForIdle();
  const status = await service.getStatus();
  assert.equal(status.phase, 'idle');
  assert.equal(status.companyCount, 3);
  assert.equal(status.problemCount, 2);
  assert.equal(status.hasData, true);
  assert.equal(status.commit, SHA_A);
  assert.equal(status.sourceUpdatedAt, '2026-08-16T22:18:35Z');
  assert.equal(source.maxActive, 2);
  assert.deepEqual((await service.getCompanies('two-sum')).map((company) => company.name), ['Amazon', 'Google']);
  assert.deepEqual(await service.getCompanies('not-in-source'), []);
  await assert.rejects(service.getCompanies('__proto__'), /Invalid/);
  assert.equal(storage.values.lctStage, null);
  assert.equal(storage.values.lctCache, null);
  assert.deepEqual(storage.values.lctData.files['Header Only/5. All.csv'].records, []);
  assert.deepEqual(pending, [true, false]);
});

test('same commit only checks metadata and changed commits reuse unchanged blob data', async () => {
  const source = sourceFixture();
  const storage = memoryStorage();
  const service = makeService(storage, source);
  await service.refresh();
  await service.waitForIdle();
  source.calls.length = 0;
  await service.refresh();
  await service.waitForIdle();
  assert.deepEqual(source.calls, [core.API_URL + '/commits/main']);
  source.commit = SHA_B;
  source.files[1].sha = BLOB_C;
  source.csvByCompany.Google = csv(['reverse-linked-list']);
  source.calls.length = 0;
  await service.refresh();
  await service.waitForIdle();
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 1);
  assert.match(source.calls.at(-1), /Google/);
  assert.deepEqual((await service.getCompanies('two-sum')).map((company) => company.name), ['Amazon']);
  assert.deepEqual(await service.getCompanies('add-two-numbers'), []);
  assert.match((await service.getCompanies('two-sum'))[0].sourceUrl, new RegExp('/' + SHA_B + '/'));
});

test('a failed file never replaces the previous full index; restart resumes completed checkpoints', async () => {
  const source = sourceFixture();
  const storage = memoryStorage();
  const service = makeService(storage, source);
  await service.refresh();
  await service.waitForIdle();
  const previous = structuredClone(storage.values.lctData);
  source.commit = SHA_B;
  source.files = [company('Amazon', BLOB_C), company('Google', BLOB_C)];
  source.csvByCompany.Amazon = csv(['reverse-linked-list']);
  source.csvByCompany.Google = csv(['binary-search']);
  source.failures.Google = () => response('', 503);
  await service.refresh();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'error');
  assert.deepEqual(storage.values.lctData, previous);
  assert.ok(storage.values.lctStage.completed.includes('Amazon/5. All.csv'));
  assert.equal(storage.values.lctStage.done, undefined, 'parsed records are stored in separate checkpoint chunks');
  assert.ok(storage.values['lctChunk:' + SHA_B + ':Amazon/5. All.csv']);
  assert.deepEqual((await service.getCompanies('two-sum')).map((company) => company.name), ['Amazon', 'Google']);
  delete source.failures.Google;
  source.calls.length = 0;
  const restarted = makeService(storage, source, { now: () => FIXED_NOW + 5 * 60000 });
  await restarted.resume();
  await restarted.waitForIdle();
  assert.equal((await restarted.getStatus()).phase, 'idle');
  assert.equal(source.calls.length, 1);
  assert.match(source.calls[0], /Google/);
  assert.equal((await restarted.getStatus()).commit, SHA_B);
  assert.deepEqual(await restarted.getCompanies('two-sum'), []);
});

test('rate limits retain cached data, schedule reset-aware retries and recover on refresh', async () => {
  const source = sourceFixture();
  const storage = memoryStorage();
  const service = makeService(storage, source);
  await service.refresh();
  await service.waitForIdle();
  const previous = structuredClone(storage.values.lctData);
  const retryAt = FIXED_NOW + 60 * 60000;
  source.failures.metadata = () => response({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(retryAt / 1000) });
  await service.refresh();
  await service.waitForIdle();
  assert.match((await service.getStatus()).message, /rate limit/);
  assert.equal((await service.getStatus()).hasData, true);
  assert.equal(storage.values.lctStage.retryAt, retryAt);
  assert.deepEqual(storage.values.lctData, previous);
  source.calls.length = 0;
  await service.resume();
  await service.waitForIdle();
  assert.equal(source.calls.length, 0);
  delete source.failures.metadata;
  await service.refresh();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'idle');
  assert.equal(storage.values.lctStage, null);
});

test('retry attempts are capped, survive restart, and manual refresh recovers', async () => {
  const source = sourceFixture();
  const storage = memoryStorage();
  source.failures.metadata = () => response({}, 500);
  let time = FIXED_NOW;
  for (let attempt = 0; attempt < MAX_RUN_FAILURES; attempt += 1) {
    const service = makeService(storage, source, { now: () => time });
    await service.resume();
    await service.waitForIdle();
    time += 60 * 60000;
  }
  assert.equal(storage.values.lctStage.failureCount, MAX_RUN_FAILURES);
  assert.equal(storage.values.lctStatus.hasData, false);
  const stopped = makeService(storage, source, { now: () => time });
  source.calls.length = 0;
  await stopped.startAutomatic();
  await stopped.waitForIdle();
  assert.equal(source.calls.length, 0);
  delete source.failures.metadata;
  await stopped.refresh();
  await stopped.waitForIdle();
  assert.equal((await stopped.getStatus()).phase, 'idle');
});

test('simultaneous boot and refresh calls launch one network job', async () => {
  const source = sourceFixture();
  const service = makeService(memoryStorage({}, true), source);
  await Promise.all([service.startAutomatic(), service.startAutomatic(), service.refresh(), service.refresh()]);
  await service.waitForIdle();
  assert.equal(source.calls.filter((url) => url.endsWith('/commits/main')).length, 1);
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 2);
});

test('deleted companies are removed on a complete changed-commit sync', async () => {
  const source = sourceFixture();
  const service = makeService(memoryStorage(), source);
  await service.refresh();
  await service.waitForIdle();
  source.commit = SHA_C;
  source.files = [company('Amazon', BLOB_A)];
  source.calls.length = 0;
  await service.refresh();
  await service.waitForIdle();
  assert.deepEqual((await service.getCompanies('two-sum')).map((company) => company.name), ['Amazon']);
  assert.equal((await service.getStatus()).companyCount, 1);
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 0);
});

test('request timeouts finish within the MV3 idle window and persist a failure checkpoint', async () => {
  assert.ok(REQUEST_TIMEOUT_MS * 3 + 1200 < 30000);
  const storage = memoryStorage();
  let attempts = 0;
  const service = makeService(storage, { fetch: (url, options) => {
    attempts += 1;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }));
  } }, { timeoutMs: 5 });
  await service.refresh();
  await service.waitForIdle();
  assert.equal(attempts, 3);
  assert.equal(storage.values.lctStage.failureCount, 1);
  assert.equal((await service.getStatus()).phase, 'error');
  assert.match((await service.getStatus()).message, /timed out/);
});

test('pending metadata is checkpointed and complete data/status are published together', async () => {
  const storage = memoryStorage();
  const source = sourceFixture();
  const fetchSource = source.fetch;
  source.fetch = async (url, options) => {
    assert.ok(storage.values.lctStage, 'restart checkpoint exists before any network operation');
    return fetchSource(url, options);
  };
  const writes = [];
  const writeStorage = storage.set;
  storage.set = async (values) => { writes.push(structuredClone(values)); await writeStorage(values); };
  const service = makeService(storage, source);
  await service.refresh();
  await service.waitForIdle();
  const publication = writes.find((values) => values.lctData);
  assert.ok(publication);
  assert.equal(publication.lctStage, null);
  assert.equal(publication.lctStatus.phase, 'idle');
  assert.equal(publication.lctStatus.commit, publication.lctData.commit);
  assert.equal(publication.lctStatus.hasData, true);
});

test('frequency parsing preserves zero, treats invalid values as unknown, and deduplicates by highest known score', () => {
  const records = core.parseCompanyRecords(recordsCSV([
    { slug: 'two-sum', frequency: '' }, { slug: 'two-sum', frequency: 0 },
    { slug: 'two-sum', frequency: '80.5', title: 'Two Sum maximum' }, { slug: 'two-sum', frequency: 40 },
    { slug: 'zero-score', frequency: 0 }, { slug: 'negative-score', frequency: -1 },
    { slug: 'infinite-score', frequency: 'Infinity' }, { slug: 'missing-score', frequency: null },
    { slug: 'bad-score', frequency: 'not a number' }, { slug: 'nan-score', frequency: 'NaN' }
  ]));
  assert.equal(records.find((record) => record.slug === 'two-sum').frequency, 80.5);
  assert.equal(records.find((record) => record.slug === 'two-sum').title, 'Two Sum maximum');
  assert.equal(records.find((record) => record.slug === 'zero-score').frequency, 0);
  for (const slug of ['negative-score', 'infinite-score', 'missing-score', 'bad-score', 'nan-score']) {
    assert.equal(records.find((record) => record.slug === slug).frequency, null);
    assert.equal(records.find((record) => record.slug === slug).rank, null);
  }
  const legacyColumn = core.parseCompanyRecords('Title,Link\nTwo Sum,https://leetcode.com/problems/two-sum/');
  assert.equal(legacyColumn[0].frequency, null);
  assert.equal(legacyColumn[0].rank, null);
});

test('sorting companies is pure with descending frequencies, alphabetical ties and unknown values last', () => {
  const companies = [
    { name: 'Zebra', frequency: 50 }, { name: 'Missing' }, { name: 'Amazon', frequency: 50 },
    { name: 'Google', frequency: 90 }, { name: 'Zero', frequency: 0 },
    { name: 'Invalid', frequency: Infinity }, { name: 'Negative', frequency: -5 }
  ];
  const original = structuredClone(companies);
  const sorted = core.sortCompanies(companies);
  assert.deepEqual(sorted.map((company) => company.name), ['Google', 'Amazon', 'Zebra', 'Zero', 'Invalid', 'Missing', 'Negative']);
  assert.deepEqual(sorted.map((company) => company.frequency), [90, 50, 50, 0, null, null, null]);
  assert.deepEqual(companies, original);
  assert.notEqual(sorted[0], companies[3]);
});

test('company question ranks use competition ties and retain source metadata', () => {
  const ranked = core.parseCompanyRecords(recordsCSV([
    { slug: 'fourth', frequency: 40, difficulty: 'EASY', topics: ['Array', 'Hash Table', 'Array'] },
    { slug: 'second-b', frequency: 80, difficulty: 'MEDIUM' },
    { slug: 'unknown', frequency: null, difficulty: 'HARD' },
    { slug: 'first', frequency: 100, difficulty: 'HARD' },
    { slug: 'second-a', frequency: 80, difficulty: 'MEDIUM' },
    { slug: 'zero', frequency: 0 }
  ]));
  assert.deepEqual(ranked.map((record) => [record.slug, record.rank]), [
    ['first', 1], ['second-a', 2], ['second-b', 2], ['fourth', 4], ['zero', 5], ['unknown', null]
  ]);
  assert.equal(ranked[3].difficulty, 'Easy');
  assert.deepEqual(ranked[3].topics, ['Array', 'Hash Table']);
});

test('all five exact CSV windows are selected, while unrelated files remain excluded', () => {
  const tree = Object.entries(core.WINDOW_FILES).map(([window, filename]) => ({ type: 'blob', path: 'Google/' + filename, sha: BLOB_A }));
  tree.push({ type: 'blob', path: 'Google/README.md', sha: BLOB_A });
  const files = core.selectWindowFiles({ truncated: false, tree });
  assert.equal(files.length, 5);
  assert.deepEqual(new Set(files.map((file) => file.window)), new Set(['all', '30d', '3m', '6m', 'older']));
  assert.equal(core.selectCompanyFiles({ truncated: false, tree }).length, 1);
});

function addWindow(source, name, window, records, sha = BLOB_C) {
  const path = name + '/' + core.WINDOW_FILES[window];
  source.files.push({ type: 'blob', path, sha });
  source.csvByPath[path] = recordsCSV(records);
}

test('window-specific frequency, ranking, provenance, and practice filters remain isolated', async () => {
  const source = sourceFixture();
  source.csvByCompany.Amazon = recordsCSV([
    { slug: 'hard-problem', frequency: 100, difficulty: 'Hard', topics: ['Graph'] },
    { slug: 'two-sum', frequency: 90, difficulty: 'Easy', topics: ['Array', 'Hash Table'] },
    { slug: 'add-two-numbers', frequency: 90, difficulty: 'Medium', topics: ['Linked List'] },
    { slug: 'binary-search', frequency: 50, difficulty: 'Easy', topics: ['Binary Search'] },
    { slug: 'zero-score', frequency: 0, difficulty: 'Medium', topics: ['Array'] },
    { slug: 'unknown', frequency: null, difficulty: 'Hard', topics: ['Tree'] }
  ]);
  source.csvByCompany.Google = recordsCSV([{ slug: 'two-sum', frequency: 95 }]);
  addWindow(source, 'Amazon', '30d', [{ slug: 'two-sum', frequency: 10 }, { slug: 'binary-search', frequency: 100 }]);
  addWindow(source, 'Google', '30d', [{ slug: 'two-sum', frequency: 5 }]);
  const storage = memoryStorage();
  const service = makeService(storage, source);
  await service.refresh();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).companyCount, 2, 'company count is unique across window files');
  assert.equal((await service.getStatus()).total, 4, 'sync progress counts source files');
  assert.deepEqual((await service.getCompanies('two-sum', 'all')).map((company) => [company.name, company.frequency, company.rank]), [
    ['Google', 95, 1], ['Amazon', 90, 2]
  ]);
  const recent = await service.getCompanies('two-sum', '30d');
  assert.deepEqual(recent.map((company) => [company.name, company.frequency, company.rank]), [['Amazon', 10, 2], ['Google', 5, 1]]);
  assert.match(recent[0].sourceUrl, /1\.%20Thirty%20Days\.csv$/);
  assert.equal(await service.windowAvailable('older'), false);
  assert.deepEqual(await service.getCompanies('two-sum', 'older'), []);
  const practice = await service.getPractice({ company: 'Amazon', window: 'all', excludeSlug: 'two-sum', limit: 2 });
  assert.equal(practice.total, 5);
  assert.deepEqual(practice.questions.map((question) => [question.slug, question.rank]), [['hard-problem', 1], ['add-two-numbers', 2]]);
  assert.equal(practice.questions[0].url, 'https://leetcode.com/problems/hard-problem/');
  const filtered = await service.getPractice({ company: 'Amazon', window: 'all', difficulty: 'Medium', topic: 'Array', excludeSlug: 'two-sum' });
  assert.deepEqual(filtered.questions.map((question) => [question.slug, question.rank, question.frequency]), [['zero-score', 5, 0]]);
  assert.ok(filtered.topics.includes('Linked List'), 'topic choices are not narrowed by active filters');
  assert.equal((await service.getPractice({ company: 'Amazon', window: 'older' })).available, false);
  await assert.rejects(service.getCompanies('two-sum', 'invalid'), /time window/);
  await assert.rejects(service.getPractice({ company: 'Amazon', difficulty: 'Impossible' }), /difficulty/);
  await assert.rejects(service.getPractice({ company: 'Amazon', limit: 101 }), /limit/);
  assert.equal(storage.values.lctCache, null, 'the completed file cache is stored once inside data.files');
});

function legacyState() {
  const companies = ['Amazon', 'Google'].map((name) => ({ name, sourceUrl: core.sourceFileURL(SHA_A, name + '/' + core.WINDOW_FILES.all) }));
  return {
    lctData: { version: 1, commit: SHA_A, lastSyncedAt: new Date(FIXED_NOW).toISOString(), sourceUpdatedAt: '2026-08-16T22:18:35Z',
      companies, index: { 'two-sum': [0, 1], 'add-two-numbers': [1] }, companyCount: 2, problemCount: 2 },
    lctStatus: { phase: 'idle', completed: 2, total: 2, lastCheckedAt: new Date(FIXED_NOW).toISOString(), hasData: true },
    lctCache: { version: 1, files: {
      'Amazon/5. All.csv': { sha: BLOB_A, slugs: ['two-sum'], records: core.parseCompanyRecords(csv(['wrong-old-cache'])) },
      'Google/5. All.csv': { sha: BLOB_B, slugs: ['two-sum', 'add-two-numbers'] }
    } },
    lctStage: { version: 1, commit: SHA_B, files: [company('Amazon', BLOB_C)], done: {}, failureCount: 3, retryAt: FIXED_NOW + 999999 }
  };
}

test('v1 migration automatically refetches unchanged-commit data and ignores legacy cache/staging', async () => {
  const source = sourceFixture();
  addWindow(source, 'Amazon', '30d', [{ slug: 'two-sum', frequency: 80 }]);
  const storage = memoryStorage(legacyState());
  const service = makeService(storage, source);
  assert.deepEqual((await service.getCompanies('two-sum')).map((company) => [company.name, company.frequency, company.rank]), [
    ['Amazon', null, null], ['Google', null, null]
  ]);
  assert.equal(await service.windowAvailable('all'), true);
  assert.equal(await service.windowAvailable('30d'), false);
  assert.equal((await service.getPractice({ company: 'Amazon', window: 'all' })).available, false);
  await service.startAutomatic();
  await service.waitForIdle();
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 3);
  assert.equal(storage.values.lctData.version, 2);
  assert.equal(storage.values.lctData.schema, core.DATA_SCHEMA);
  assert.equal(storage.values.lctData.commit, SHA_A);
  assert.equal(storage.values.lctCache, null);
  assert.equal(storage.values.lctStage, null);
  assert.equal(await service.windowAvailable('30d'), true);
  assert.equal((await service.getCompanies('two-sum', '30d'))[0].frequency, 80);
  assert.deepEqual(await service.getCompanies('wrong-old-cache'), []);
});

test('failed migration preserves old tags and resumes v2 checkpoints without publishing partial windows', async () => {
  const source = sourceFixture();
  addWindow(source, 'Amazon', '30d', [{ slug: 'two-sum', frequency: 80 }]);
  source.failures.Google = () => response('', 503);
  const storage = memoryStorage(legacyState());
  const previous = structuredClone(storage.values.lctData);
  const service = makeService(storage, source);
  await service.startAutomatic();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'error');
  assert.equal((await service.getStatus()).hasData, true);
  assert.deepEqual(storage.values.lctData, previous);
  assert.equal(await service.windowAvailable('30d'), false, 'completed stage fragments are not presented as published window data');
  assert.equal((await service.getCompanies('two-sum'))[0].frequency, null);
  assert.equal(storage.values.lctStage.version, 2);
  assert.equal(storage.values.lctStage.schema, core.DATA_SCHEMA);
  delete source.failures.Google;
  source.calls.length = 0;
  const restarted = makeService(storage, source, { now: () => FIXED_NOW + 5 * 60000 });
  await restarted.startAutomatic();
  await restarted.waitForIdle();
  assert.equal(source.calls.length, 1);
  assert.match(source.calls[0], /Google/);
  assert.equal((await restarted.getStatus()).phase, 'idle');
  assert.equal(await restarted.windowAvailable('30d'), true);
  assert.equal((await restarted.getCompanies('two-sum'))[0].frequency, 20);
});

test('changed frequency in one window reuses other file blobs and reranks only that window', async () => {
  const source = sourceFixture();
  addWindow(source, 'Amazon', '30d', [{ slug: 'two-sum', frequency: 80 }, { slug: 'binary-search', frequency: 50 }]);
  const service = makeService(memoryStorage(), source);
  await service.refresh();
  await service.waitForIdle();
  source.commit = SHA_B;
  source.files.find((file) => file.path === 'Amazon/1. Thirty Days.csv').sha = '4'.repeat(40);
  source.csvByPath['Amazon/1. Thirty Days.csv'] = recordsCSV([{ slug: 'two-sum', frequency: 40 }, { slug: 'binary-search', frequency: 50 }]);
  source.calls.length = 0;
  await service.refresh();
  await service.waitForIdle();
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 1);
  assert.deepEqual((await service.getCompanies('two-sum', '30d')).map((company) => [company.frequency, company.rank]), [[40, 2]]);
  assert.deepEqual((await service.getCompanies('two-sum', 'all')).map((company) => company.frequency), [20, 20]);
});
// ZIP fixtures are constructed locally from known CSV bytes. Matching Git blob
// hashes make these tests exercise the actual production archive integrity checks.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(entries, commit = SHA_A) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from('leetcode-company-wise-problems-' + commit + '/' + entry.path);
    const body = Buffer.from(entry.body);
    const method = entry.method === undefined ? 8 : entry.method;
    const packed = method === 8 ? deflateRawSync(body) : body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(body), 16);
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

function enableArchive(source, omit = []) {
  const entries = source.files.map((file) => {
    const name = file.path.split('/')[0];
    const body = source.csvByPath[file.path] || source.csvByCompany[name];
    file.sha = createHash('sha1').update('blob ' + Buffer.byteLength(body) + '\0').update(body).digest('hex');
    return { path: file.path, body };
  });
  source.archive = zipEntries(entries.filter((entry) => !omit.includes(entry.path)), source.commit);
}

function snapshotFixture() {
  const source = sourceFixture();
  source.csvByCompany.Amazon = recordsCSV([
    { slug: 'two-sum', frequency: 100, topics: ['Array'], difficulty: 'Easy' },
    { slug: 'add-two-numbers', frequency: 70, topics: ['Linked List'], difficulty: 'Medium' }
  ]);
  source.csvByCompany.Google = recordsCSV([{ slug: 'two-sum', frequency: 90 }]);
  for (const window of ['30d', '3m', '6m', 'older']) {
    addWindow(source, 'Amazon', window, [{ slug: 'two-sum', frequency: 80 }, { slug: 'binary-search', frequency: 40 }]);
    addWindow(source, 'Google', window, [{ slug: 'two-sum', frequency: 60 }]);
  }
  const files = core.selectWindowFiles({ truncated: false, tree: source.files });
  const parsed = Object.fromEntries(files.map((file) => [file.path, {
    sha: file.sha, records: core.parseCompanyRecords(source.csvByPath[file.path] || source.csvByCompany[file.name])
  }]));
  return { source, data: core.buildData(files, parsed, SHA_A, '2026-08-16T22:18:35Z', new Date(FIXED_NOW).toISOString()) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleUntil(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'expected asynchronous progress without releasing the held request');
}

test('a fresh install publishes every bundled window before starting remote refresh', async () => {
  const { source, data } = snapshotFixture();
  const gate = deferred();
  source.failures.metadata = async () => { await gate.promise; return response({}, 503); };
  const storage = memoryStorage();
  let seedLoads = 0;
  const service = makeService(storage, source, { loadSnapshot: async () => { seedLoads += 1; return data; } });
  await service.initialize();
  assert.equal(seedLoads, 1);
  assert.equal(source.calls.length, 0, 'publishing the packaged seed needs no network');
  assert.equal((await service.getStatus()).dataSource, 'bundled');
  assert.equal((await service.getStatus()).hasData, true);
  for (const window of Object.keys(core.WINDOW_FILES)) {
    assert.equal(await service.windowAvailable(window), true);
    assert.equal((await service.getCompanies('two-sum', window)).length, 2);
  }
  const practice = await service.getPractice({ company: 'Amazon', excludeSlug: 'two-sum' });
  assert.deepEqual(practice.questions.map((question) => [question.slug, question.frequency, question.rank]), [['add-two-numbers', 70, 2]]);
  const saved = structuredClone(storage.values.lctData);
  await service.startAutomatic();
  await settleUntil(() => source.calls.some((url) => url.endsWith('/commits/main')));
  assert.equal((await service.getStatus()).phase, 'syncing');
  assert.equal((await service.getCompanies('two-sum'))[0].frequency, 100, 'tags stay available while metadata is pending');
  gate.resolve();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'error');
  assert.equal((await service.getStatus()).hasData, true);
  assert.equal((await service.getStatus()).dataSource, 'bundled');
  assert.deepEqual(storage.values.lctData, saved, 'an offline refresh preserves the complete packaged seed');
});

test('bundled data never replaces an existing cache and boot does not reload it', async () => {
  const { source, data } = snapshotFixture();
  const existing = structuredClone(data);
  existing.commit = SHA_B;
  existing.files['Amazon/5. All.csv'].records[0].frequency = 97;
  const storage = memoryStorage({ lctData: existing, lctStatus: { phase: 'idle', lastCheckedAt: new Date(FIXED_NOW).toISOString(), dataSource: 'live' } });
  let loads = 0;
  const service = makeService(storage, source, { loadSnapshot: async () => { loads += 1; return data; } });
  await service.startAutomatic();
  assert.equal(loads, 0);
  assert.equal(source.calls.length, 0);
  assert.equal((await service.getStatus()).commit, SHA_B);
  assert.equal((await service.getCompanies('two-sum'))[0].frequency, 97);
  assert.deepEqual(storage.values.lctData, existing);
});

test('automatic refresh checks the latest commit immediately after seeding and only downloads changed blobs', async () => {
  const { source, data } = snapshotFixture();
  source.commit = SHA_B;
  source.files.find((file) => file.path === 'Google/5. All.csv').sha = '4'.repeat(40);
  source.csvByCompany.Google = recordsCSV([{ slug: 'two-sum', frequency: 99 }, { slug: 'reverse-linked-list', frequency: 100 }]);
  const storage = memoryStorage();
  const service = makeService(storage, source, { loadSnapshot: async () => data });
  await service.startAutomatic();
  await service.waitForIdle();
  assert.equal(source.calls.filter((url) => url.endsWith('/commits/main')).length, 1);
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 1);
  assert.equal((await service.getStatus()).dataSource, 'live');
  assert.equal((await service.getStatus()).commit, SHA_B);
  assert.deepEqual((await service.getCompanies('reverse-linked-list')).map((company) => company.name), ['Google']);
  for (const window of Object.keys(core.WINDOW_FILES)) assert.equal(await service.windowAvailable(window), true);
});

test('an invalid or unreadable bundled snapshot falls through to a complete remote sync', async () => {
  for (const loadSnapshot of [async () => { throw new Error('damaged gzip'); }, async () => ({ version: 2, schema: core.DATA_SCHEMA, files: {} })]) {
    const source = sourceFixture();
    enableArchive(source);
    const service = makeService(memoryStorage(), source, { loadSnapshot, archive: undefined });
    await service.startAutomatic();
    await service.waitForIdle();
    assert.equal((await service.getStatus()).phase, 'idle');
    assert.deepEqual((await service.getCompanies('two-sum')).map((company) => company.name), ['Amazon', 'Google']);
    assert.equal(source.calls.filter((url) => url.startsWith('https://codeload.github.com/')).length, 1);
    assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 0);
  }
});

test('initial archive sync publishes all five windows with one pinned archive download', async () => {
  const { source } = snapshotFixture();
  enableArchive(source);
  const storage = memoryStorage();
  const service = makeService(storage, source, { archive: undefined });
  await service.refresh();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'idle');
  assert.equal(source.calls.filter((url) => url.startsWith('https://codeload.github.com/')).length, 1);
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 0);
  for (const window of Object.keys(core.WINDOW_FILES)) {
    assert.equal(await service.windowAvailable(window), true);
    assert.equal((await service.getCompanies('two-sum', window)).length, 2);
  }
  const published = storage.writes.filter((values) => values.lctData);
  assert.equal(published.length, 1, 'only the validated complete index is published');
  assert.equal(published[0].lctStatus.phase, 'idle');
  assert.equal(storage.values.lctStage, null);
  assert.equal(Object.keys(storage.values).some((key) => key.startsWith('lctChunk:') || key.startsWith('lctManifest:')), false, 'completed checkpoints are cleaned up');
});

test('missing or corrupt archive data falls back to individual CSV files without publishing partial data', async () => {
  for (const kind of ['missing', 'corrupt', 'unavailable']) {
    const { source } = snapshotFixture();
    enableArchive(source, kind === 'missing' ? ['Google/4. More Than Six Months.csv'] : []);
    if (kind === 'corrupt') source.archive = Buffer.from('not a ZIP file');
    if (kind === 'unavailable') source.failures.archive = () => response('', 404);
    const storage = memoryStorage();
    const service = makeService(storage, source, { archive: undefined });
    await service.refresh();
    await service.waitForIdle();
    assert.equal((await service.getStatus()).phase, 'idle', kind);
    assert.ok(source.calls.some((url) => url.startsWith(core.RAW_URL)), kind + ' uses CSV fallback');
    assert.equal(storage.writes.filter((values) => values.lctData).length, 1, kind);
    for (const window of Object.keys(core.WINDOW_FILES)) assert.equal(await service.windowAvailable(window), true, kind);
    assert.equal((await service.getCompanies('two-sum', 'older')).length, 2, kind);
  }
});

test('migration uses the archive fast path and removes legacy cache without partial publication', async () => {
  const { source } = snapshotFixture();
  enableArchive(source);
  const storage = memoryStorage(legacyState());
  const service = makeService(storage, source, { archive: undefined });
  assert.equal(await service.windowAvailable('30d'), false);
  await service.startAutomatic();
  await service.waitForIdle();
  assert.equal(source.calls.filter((url) => url.startsWith('https://codeload.github.com/')).length, 1);
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 0);
  assert.equal(storage.values.lctCache, null);
  assert.equal(await service.windowAvailable('30d'), true);
  assert.equal((await service.getCompanies('two-sum'))[0].frequency, 100);
});

test('the rolling CSV queue launches the next file while an earlier request is still pending', async () => {
  const source = sourceFixture();
  source.files.push(company('Zebra', BLOB_C));
  source.csvByCompany.Zebra = csv(['binary-search']);
  const gate = deferred();
  source.delays.Amazon = gate.promise;
  const service = makeService(memoryStorage(), source, { concurrency: 2 });
  await service.refresh();
  try {
    await settleUntil(() => source.calls.some((url) => url.includes('/Zebra/')) && source.active === 1);
    assert.equal(source.maxActive, 2);
    assert.equal(source.active, 1, 'the slow request is still held while another queue slot has progressed');
  } finally {
    gate.resolve();
    await service.waitForIdle();
  }
  assert.equal((await service.getStatus()).phase, 'idle');
});

test('fallback checkpoints persist compact manifests and new chunks instead of rewriting accumulated records', async () => {
  const source = sourceFixture();
  source.files = [];
  source.csvByCompany = {};
  for (let index = 0; index < 80; index += 1) {
    const name = 'Company ' + String(index).padStart(3, '0');
    source.files.push(company(name, BLOB_A));
    source.csvByCompany[name] = recordsCSV(Array.from({ length: 100 }, (_, number) => ({
      slug: 'question-' + number, title: 'Question ' + number + ' for ' + name,
      frequency: 100 - number, topics: ['Array', 'Hash Table']
    })));
  }
  const storage = memoryStorage();
  const service = makeService(storage, source);
  await service.refresh();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'idle');
  const stageWrites = storage.writes.filter((values) => values.lctStage);
  assert.ok(stageWrites.length > 0);
  for (const values of stageWrites) {
    assert.equal(values.lctStage.done, undefined);
    assert.equal(values.lctStage.files, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(values.lctStage)) < 10000, 'stage contains only progress metadata');
  }
  const manifestWrites = storage.writes.filter((values) => Object.keys(values).some((key) => key.startsWith('lctManifest:')));
  assert.equal(manifestWrites.length, 1, 'immutable manifest is saved once');
  const chunkCounts = new Map();
  for (const values of storage.writes) for (const key of Object.keys(values).filter((key) => key.startsWith('lctChunk:'))) {
    chunkCounts.set(key, (chunkCounts.get(key) || 0) + 1);
  }
  assert.equal(chunkCounts.size, 80);
  assert.ok([...chunkCounts.values()].every((count) => count === 1), 'completed CSV records are checkpointed once');
  const checkpointBytes = storage.writes.filter((values) => !values.lctData).reduce((sum, values) => sum + Buffer.byteLength(JSON.stringify(values)), 0);
  assert.ok(checkpointBytes < 2 * Buffer.byteLength(JSON.stringify(storage.values.lctData)), 'checkpoint traffic scales with dataset size');
});

test('an unchanged source commit confirms bundled data as live without downloading or rewriting it', async () => {
  const { source, data } = snapshotFixture();
  const storage = memoryStorage();
  const service = makeService(storage, source, { loadSnapshot: async () => data, archive: undefined });
  await service.initialize();
  const dataWrites = storage.writes.filter((values) => values.lctData).length;
  await service.startAutomatic();
  await service.waitForIdle();
  assert.deepEqual(source.calls, [core.API_URL + '/commits/main']);
  assert.equal((await service.getStatus()).dataSource, 'live');
  assert.equal((await service.getStatus()).commit, SHA_A);
  assert.equal(storage.writes.filter((values) => values.lctData).length, dataWrites, 'confirming freshness does not rewrite the full snapshot');
});

test('old v2 stages migrate completed records once and resume without metadata or duplicate downloads', async () => {
  const source = sourceFixture();
  const storage = memoryStorage();
  const first = makeService(storage, source);
  await first.refresh();
  await first.waitForIdle();
  source.commit = SHA_B;
  source.files = [company('Amazon', BLOB_C), company('Google', BLOB_C)];
  source.csvByCompany.Amazon = csv(['reverse-linked-list']);
  source.csvByCompany.Google = csv(['binary-search']);
  const selected = core.selectWindowFiles({ truncated: false, tree: source.files });
  storage.values.lctStage = {
    version: core.DATA_VERSION, schema: core.DATA_SCHEMA, commit: SHA_B,
    sourceUpdatedAt: '2026-08-16T22:18:35Z', files: selected,
    done: { 'Amazon/5. All.csv': { sha: BLOB_C, records: core.parseCompanyRecords(source.csvByCompany.Amazon) } },
    failureCount: 1, retryAt: 0
  };
  source.calls.length = 0;
  storage.writes.length = 0;
  const restarted = makeService(storage, source);
  await restarted.resume();
  await restarted.waitForIdle();
  assert.equal((await restarted.getStatus()).phase, 'idle');
  assert.equal(source.calls.length, 1);
  assert.match(source.calls[0], /Google/);
  assert.equal((await restarted.getStatus()).commit, SHA_B);
  assert.deepEqual((await restarted.getCompanies('reverse-linked-list')).map((company) => company.name), ['Amazon']);
  const savedAmazon = storage.writes.filter((values) => Object.hasOwn(values, 'lctChunk:' + SHA_B + ':Amazon/5. All.csv'));
  assert.equal(savedAmazon.length, 1, 'legacy completed records are migrated to a chunk once');
  assert.equal(storage.values.lctStage, null);
});

function globalExplorerFixture() {
  const source = sourceFixture();
  source.files = [];
  source.csvByPath = {};
  const acko = [
    { slug: 'group-anagrams', title: 'Group Anagrams', frequency: 90, difficulty: 'Medium', topics: ['Array', 'Hash Table'] },
    { slug: 'longest-substring-without-repeating-characters', title: 'Longest Substring Without Repeating Characters', frequency: 90, difficulty: 'Medium', topics: ['String'] },
    { slug: 'minimum-window-substring', title: 'Minimum Window Substring', frequency: 0, difficulty: 'Hard', topics: ['String'] },
    { slug: 'valid-anagram', title: 'Valid Anagram', frequency: null, difficulty: 'Easy', topics: ['String'] }
  ];
  const amazon = [
    { slug: 'two-sum', title: 'Two Sum', frequency: 100, difficulty: 'Easy', topics: ['Array', 'Hash Table'] },
    { slug: 'two-sum-ii-input-array-is-sorted', title: 'Two Sum II - Input Array Is Sorted', frequency: 80, difficulty: 'Easy', topics: ['Two Pointers'] },
    { slug: 'advanced-two-sum-variant', title: 'Advanced Two Sum Variant', frequency: 60, difficulty: 'Hard', topics: ['Graph'] },
    { slug: 'group-anagrams', title: 'Group Anagrams', frequency: 40, difficulty: 'Medium', topics: ['Array', 'Hash Table'] },
    { slug: 'contains-duplicate', title: 'Contains Duplicate', frequency: 0, difficulty: 'Easy', topics: ['Array'] }
  ];
  const large = Array.from({ length: 153 }, (_, index) => ({
    slug: 'exercise-' + String(index).padStart(3, '0'), title: 'Exercise ' + String(index).padStart(3, '0'),
    frequency: index < 150 ? 100 - Math.floor(index / 2) : index === 150 ? 0 : null,
    difficulty: ['Easy', 'Medium', 'Hard'][index % 3], topics: [index % 2 ? 'Graph' : 'Array']
  }));
  const add = (name, window, rows) => addWindow(source, name, window, rows, BLOB_A);
  add('Acko', 'all', acko);
  add('Amazon', 'all', amazon);
  add('Acko Labs', 'all', []);
  add('Zeta Practice', 'all', large);
  add('Acko', '30d', [acko[3]]);
  add('Amazon', '30d', [amazon[0]]);
  add('Acko Labs', '30d', []);
  add('Zeta Practice', '30d', []);
  add('Recent Only', '30d', [{ slug: 'recent-question', title: 'Recent Question', frequency: 55, difficulty: 'Hard', topics: ['Graph'] }]);
  const files = core.selectWindowFiles({ truncated: false, tree: source.files });
  const parsed = Object.fromEntries(files.map((file) => [file.path, {
    sha: file.sha, records: core.parseCompanyRecords(source.csvByPath[file.path])
  }]));
  const data = core.buildData(files, parsed, SHA_A, '2026-08-16T22:18:35Z', new Date(FIXED_NOW).toISOString());
  const storage = memoryStorage({ lctData: data, lctStatus: { phase: 'idle', lastCheckedAt: new Date(FIXED_NOW).toISOString(), dataSource: 'live' } });
  return { source, data, storage, service: makeService(storage, source) };
}

test('global company lookup finds Acko beyond the active problem and exposes all four questions', async () => {
  const { service, source } = globalExplorerFixture();
  assert.deepEqual((await service.getCompanies('two-sum')).map((company) => company.name), ['Amazon']);
  const found = await service.searchCompanies({ query: 'aCKo' });
  assert.equal(found.available, true);
  assert.equal(found.total, 2);
  assert.deepEqual(found.companies.map((company) => [company.name, company.problemCount]), [['Acko', 4], ['Acko Labs', 0]]);
  const practice = await service.getPractice({ company: 'Acko' });
  assert.equal(practice.total, 4);
  assert.deepEqual(practice.questions.map((question) => question.slug), [
    'group-anagrams', 'longest-substring-without-repeating-characters', 'minimum-window-substring', 'valid-anagram'
  ]);
  assert.ok(practice.questions.some((question) => question.slug === 'minimum-window-substring'), 'global lists retain a question even when it is the active problem');
  assert.equal(source.calls.length, 0, 'global lookup uses only the already loaded cache');
});

test('problem lookup matches titles, slugs and all query tokens, ranking exact and prefix results first', async () => {
  const { service, source } = globalExplorerFixture();
  const expected = ['two-sum', 'two-sum-ii-input-array-is-sorted', 'advanced-two-sum-variant'];
  for (const query of ['Two Sum', 'TWO-SUM', '  two   SUM  ']) {
    const result = await service.searchProblems({ query });
    assert.equal(result.total, 3);
    assert.deepEqual(result.problems.map((problem) => problem.slug), expected);
  }
  const tokens = await service.searchProblems({ query: 'SUM TWO' });
  assert.deepEqual(new Set(tokens.problems.map((problem) => problem.slug)), new Set(expected), 'every token may match independently of its order');
  assert.deepEqual((await service.searchProblems({ query: 'INPUT sorted' })).problems.map((problem) => problem.slug), ['two-sum-ii-input-array-is-sorted']);
  const easy = await service.searchProblems({ query: 'two sum', difficulty: 'eAsY' });
  assert.deepEqual(easy.problems.map((problem) => problem.slug), expected.slice(0, 2));
  const row = (await service.searchProblems({ query: 'group-anagrams' })).problems[0];
  assert.deepEqual([row.title, row.difficulty, row.companyCount, row.url], ['Group Anagrams', 'Medium', 2, 'https://leetcode.com/problems/group-anagrams/']);
  assert.equal(source.calls.length, 0);
});

test('company search follows the selected window, includes empty source files, and omits missing source files', async () => {
  const { service, source } = globalExplorerFixture();
  const all = await service.searchCompanies();
  assert.equal(all.total, 4);
  assert.deepEqual(all.companies.map((company) => company.name), ['Acko', 'Acko Labs', 'Amazon', 'Zeta Practice']);
  assert.deepEqual(all.companies.map((company) => company.problemCount), [4, 0, 5, 153]);
  assert.equal((await service.searchCompanies({ query: 'labs ACK' })).companies[0].name, 'Acko Labs');
  assert.equal((await service.searchCompanies({ query: 'recent' })).total, 0);
  const recent = await service.searchCompanies({ window: '30d' });
  assert.equal(recent.total, 5);
  assert.deepEqual(recent.companies.map((company) => [company.name, company.problemCount]), [
    ['Acko', 1], ['Acko Labs', 0], ['Amazon', 1], ['Recent Only', 1], ['Zeta Practice', 0]
  ]);
  assert.match(recent.companies.find((company) => company.name === 'Recent Only').sourceUrl, /1\.%20Thirty%20Days\.csv$/);
  assert.equal((await service.searchProblems({ window: '30d' })).total, 3);
  const noQuestions = await service.getPractice({ company: 'Acko Labs' });
  assert.equal(noQuestions.available, true);
  assert.equal(noQuestions.total, 0);
  assert.deepEqual(noQuestions.questions, []);
  assert.equal(source.calls.length, 0);
});

test('global problem and company pages cover the entire cache without duplicate or skipped results', async () => {
  const { service, source } = globalExplorerFixture();
  const slugs = [];
  let offset = 0;
  while (true) {
    const page = await service.searchProblems({ offset, limit: 37 });
    assert.equal(page.total, 161);
    assert.equal(page.offset, offset);
    assert.equal(page.limit, 37);
    slugs.push(...page.problems.map((problem) => problem.slug));
    if (!page.hasMore) break;
    assert.equal(page.problems.length, 37);
    offset += 37;
  }
  const expected = [
    'two-sum', 'two-sum-ii-input-array-is-sorted', 'advanced-two-sum-variant', 'contains-duplicate',
    'group-anagrams', 'longest-substring-without-repeating-characters', 'minimum-window-substring', 'valid-anagram',
    ...Array.from({ length: 153 }, (_, index) => 'exercise-' + String(index).padStart(3, '0'))
  ];
  assert.equal(slugs.length, expected.length);
  assert.deepEqual(new Set(slugs), new Set(expected));
  assert.equal(new Set(slugs).size, slugs.length);
  const first = await service.searchCompanies({ offset: 0, limit: 2 });
  const second = await service.searchCompanies({ offset: 2, limit: 2 });
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.deepEqual([...first.companies, ...second.companies].map((company) => company.name), ['Acko', 'Acko Labs', 'Amazon', 'Zeta Practice']);
  const pastEnd = await service.searchProblems({ offset: 1000, limit: 37 });
  assert.deepEqual(pastEnd.problems, []);
  assert.equal(pastEnd.total, 161);
  assert.equal(pastEnd.hasMore, false);
  assert.equal(source.calls.length, 0);
});

test('company question pagination reveals all records while preserving source ranks, ties, zero and unknown scores', async () => {
  const { service, source } = globalExplorerFixture();
  const questions = [];
  for (let offset = 0; ; offset += 37) {
    const page = await service.getPractice({ company: 'Zeta Practice', offset, limit: 37 });
    assert.equal(page.total, 153);
    assert.equal(page.offset, offset);
    questions.push(...page.questions);
    if (!page.hasMore) break;
  }
  assert.deepEqual(questions.map((question) => question.slug), Array.from({ length: 153 }, (_, index) => 'exercise-' + String(index).padStart(3, '0')));
  assert.equal(new Set(questions.map((question) => question.slug)).size, 153);
  assert.deepEqual(questions.slice(0, 4).map((question) => [question.frequency, question.rank]), [[100, 1], [100, 1], [99, 3], [99, 3]]);
  assert.deepEqual(questions.slice(-3).map((question) => [question.frequency, question.rank]), [[0, 151], [null, null], [null, null]]);
  const acko = await service.getPractice({ company: 'Acko' });
  assert.deepEqual(acko.questions.map((question) => [question.frequency, question.rank]), [[90, 1], [90, 1], [0, 3], [null, null]]);
  assert.equal(source.calls.length, 0);
});

test('query, difficulty, topic and offset filters compose without renumbering company ranks', async () => {
  const { service, source } = globalExplorerFixture();
  const result = await service.getPractice({ company: 'Zeta Practice', query: 'exercise 1', difficulty: 'medium', topic: 'ARRAY', offset: 2, limit: 3 });
  assert.equal(result.total, 11, 'substring tokens also match Exercise 010 and Exercise 016');
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.questions.map((question) => [question.slug, question.rank]), [
    ['exercise-100', 101], ['exercise-106', 107], ['exercise-112', 113]
  ]);
  const acko = await service.getPractice({ company: 'Acko', query: 'SUBSTRING', difficulty: 'hard', topic: 'String' });
  assert.deepEqual(acko.questions.map((question) => [question.slug, question.frequency, question.rank]), [['minimum-window-substring', 0, 3]]);
  assert.deepEqual(acko.topics, ['Array', 'Hash Table', 'String'], 'topic choices remain usable when a filter narrows results');
  assert.equal((await service.getPractice({ company: 'Acko', topic: 'Hash' })).total, 0, 'topic filtering matches exact topic names');
  assert.equal((await service.getPractice({ company: 'Acko', excludeSlug: 'minimum-window-substring' })).total, 3, 'active-problem exclusion remains available to the compact practice panel');
  acko.questions[0].topics.push('Injected Topic');
  assert.equal((await service.getPractice({ company: 'Acko' })).topics.includes('Injected Topic'), false, 'returned rows cannot mutate the cache');
  assert.equal(source.calls.length, 0);
});

test('global explorer distinguishes no matches from missing windows, no cache, and legacy caches', async () => {
  const { service, source } = globalExplorerFixture();
  for (const method of ['searchProblems', 'searchCompanies']) {
    const empty = await service[method]({ query: 'no such matching result' });
    assert.equal(empty.available, true);
    assert.equal(empty.windowAvailable, true);
    assert.equal(empty.total, 0);
    assert.equal(empty.hasMore, false);
    const unavailable = await service[method]({ window: '3m' });
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.windowAvailable, false);
    assert.equal(unavailable.total, 0);
    for (const storage of [memoryStorage(), memoryStorage(legacyState())]) {
      const cold = makeService(storage, source);
      const missing = await cold[method]({});
      assert.equal(missing.available, false);
      assert.equal(missing.total, 0);
      assert.equal(missing.hasMore, false);
    }
  }
  assert.equal(source.calls.length, 0);
});

test('global search and paged practice validate option types and bounds before querying the cache', async () => {
  const { service, source } = globalExplorerFixture();
  const invalidCommon = [
    null, 'query', 7, [],
    { query: false }, { query: 0 }, { query: null }, { query: 'x'.repeat(201) },
    { offset: -1 }, { offset: 0.5 }, { offset: '1' }, { offset: Infinity }, { offset: 1000001 },
    { limit: 0 }, { limit: 101 }, { limit: -1 }, { limit: 1.5 }, { limit: '10' }, { limit: NaN },
    { window: 'week' }, { window: '' }, { window: '__proto__' }, { window: 0 }
  ];
  for (const method of ['searchProblems', 'searchCompanies']) for (const options of invalidCommon) {
    await assert.rejects(service[method](options), /Invalid|query|offset|limit|window|options/i, method + ' ' + JSON.stringify(options));
  }
  for (const difficulty of [false, 0, 'Impossible', {}]) await assert.rejects(service.searchProblems({ difficulty }), /difficulty/i);
  for (const options of invalidCommon.filter((value) => value && typeof value === 'object' && !Array.isArray(value))) {
    await assert.rejects(service.getPractice({ company: 'Acko', ...options }), /Invalid|query|offset|limit|window|options/i, JSON.stringify(options));
  }
  for (const options of [{ company: '' }, { company: false }, { company: 'x'.repeat(201) }, { company: 'Acko', topic: false },
    { company: 'Acko', topic: 0 }, { company: 'Acko', difficulty: false }, { company: 'Acko', excludeSlug: 0 }]) {
    await assert.rejects(service.getPractice(options), /company|topic|difficulty|slug|Invalid/i, JSON.stringify(options));
  }
  for (const query of ['__proto__', 'constructor']) {
    assert.equal((await service.searchCompanies({ query })).total, 0);
    assert.equal((await service.searchProblems({ query })).total, 0);
    assert.equal((await service.getPractice({ company: query })).total, 0);
  }
  assert.equal(source.calls.length, 0);
});

test('global searches retain the complete previous dataset during refresh and switch to the new complete cache', async () => {
  const { service, source } = globalExplorerFixture();
  const previous = await service.getPractice({ company: 'Acko' });
  const gate = deferred();
  source.commit = SHA_B;
  source.files.find((file) => file.path === 'Acko/5. All.csv').sha = BLOB_B;
  source.csvByPath['Acko/5. All.csv'] = recordsCSV([
    { slug: 'group-anagrams', title: 'Group Anagrams', frequency: 90, difficulty: 'Medium', topics: ['Array', 'Hash Table'] },
    { slug: 'longest-substring-without-repeating-characters', frequency: 90, difficulty: 'Medium', topics: ['String'] },
    { slug: 'minimum-window-substring', frequency: 0, difficulty: 'Hard', topics: ['String'] },
    { slug: 'valid-anagram', frequency: null, difficulty: 'Easy', topics: ['String'] },
    { slug: 'find-all-anagrams-in-a-string', title: 'Find All Anagrams in a String', frequency: 70, difficulty: 'Medium', topics: ['String'] }
  ]);
  source.delays['Acko/5. All.csv'] = gate.promise;
  await service.refresh();
  try {
    await settleUntil(() => source.calls.some((url) => url.startsWith(core.RAW_URL)));
    assert.equal((await service.searchCompanies({ query: 'Acko' })).companies.find((company) => company.name === 'Acko').problemCount, 4);
    assert.equal((await service.searchProblems({ query: 'find all anagrams' })).total, 0);
  } finally {
    gate.resolve();
    await service.waitForIdle();
  }
  assert.equal((await service.getStatus()).phase, 'idle');
  assert.equal((await service.searchCompanies({ query: 'Acko' })).companies.find((company) => company.name === 'Acko').problemCount, 5);
  assert.equal((await service.searchProblems({ query: 'find all anagrams' })).problems[0].slug, 'find-all-anagrams-in-a-string');
  assert.equal(previous.total, 4);
  assert.equal(previous.questions.some((question) => question.slug === 'find-all-anagrams-in-a-string'), false);
  const calls = source.calls.length;
  await service.searchCompanies({ query: 'Acko' });
  await service.searchProblems({ query: 'find all anagrams' });
  await service.getPractice({ company: 'Acko', offset: 2, limit: 2 });
  assert.equal(source.calls.length, calls, 'post-refresh search remains cache-only');
});


function sortingFixture() {
  const source = sourceFixture();
  source.files = [];
  source.csvByPath = {};
  const rows = [
    { slug: 'alpha-easy', title: 'Alpha Problem', difficulty: 'Easy', frequency: 40, topics: ['Array'] },
    { slug: 'beta-hard', title: 'Beta Problem', difficulty: 'Hard', frequency: 100, topics: ['Graph'] },
    { slug: 'gamma-medium', title: 'Gamma Problem', difficulty: 'Medium', frequency: 40, topics: ['Array'] },
    { slug: 'delta-easy', title: 'Delta Problem', difficulty: 'Easy', frequency: 0, topics: ['Array'] },
    { slug: 'omega-unknown', title: 'Omega Problem', difficulty: 'Unknown', frequency: null, topics: ['Array'] },
    { slug: 'alpha-twin', title: 'Alpha Problem', difficulty: 'Easy', frequency: 10, topics: ['Array'] }
  ];
  addWindow(source, 'Alpha', 'all', [...rows, { ...rows[0], frequency: 20 }]);
  addWindow(source, 'Beta', 'all', rows.slice(0, 3));
  addWindow(source, 'Gamma', 'all', [rows[2]]);
  addWindow(source, 'Empty', 'all', []);
  addWindow(source, 'Alpha', '30d', [rows[0], rows[2], rows[4]]);
  addWindow(source, 'Beta', '30d', [rows[0]]);
  addWindow(source, 'Gamma', '30d', []);
  addWindow(source, 'Empty', '30d', []);
  const files = core.selectWindowFiles({ truncated: false, tree: source.files });
  const parsed = Object.fromEntries(files.map((file) => [file.path, {
    sha: file.sha, records: core.parseCompanyRecords(source.csvByPath[file.path])
  }]));
  const storage = memoryStorage({
    lctData: core.buildData(files, parsed, SHA_A, '2026-08-16T22:18:35Z', new Date(FIXED_NOW).toISOString()),
    lctStatus: { phase: 'idle', lastCheckedAt: new Date(FIXED_NOW).toISOString(), dataSource: 'live' }
  });
  return { source, storage, data: storage.values.lctData, service: makeService(storage, source) };
}

test('company sort modes order the whole filtered selected-window list before paging', async () => {
  const { service, source } = sortingFixture();
  const expected = {
    'name-asc': ['Alpha', 'Beta', 'Empty', 'Gamma'],
    'name-desc': ['Gamma', 'Empty', 'Beta', 'Alpha'],
    'questions-desc': ['Alpha', 'Beta', 'Gamma', 'Empty'],
    'questions-asc': ['Empty', 'Gamma', 'Beta', 'Alpha']
  };
  for (const [sort, names] of Object.entries(expected)) {
    const first = await service.searchCompanies({ sort, limit: 2 });
    const second = await service.searchCompanies({ sort, offset: 2, limit: 2 });
    assert.deepEqual([...first.companies, ...second.companies].map((company) => company.name), names, sort);
    assert.equal(first.total, 4);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
  }
  const filtered = await service.searchCompanies({ query: 'a', sort: 'questions-asc', offset: 1, limit: 1 });
  assert.equal(filtered.total, 3);
  assert.equal(filtered.companies[0].name, 'Beta', 'search filters are applied before count sorting and pagination');
  const recent = await service.searchCompanies({ window: '30d', sort: 'questions-desc' });
  assert.deepEqual(recent.companies.map((company) => [company.name, company.problemCount]), [
    ['Alpha', 3], ['Beta', 1], ['Empty', 0], ['Gamma', 0]
  ]);
  assert.equal(source.calls.length, 0);
});

test('problem sort modes preserve deterministic ties and keep unknown difficulty last in both directions', async () => {
  const { service, source } = sortingFixture();
  const expected = {
    relevance: ['alpha-easy', 'alpha-twin', 'beta-hard', 'delta-easy', 'gamma-medium', 'omega-unknown'],
    'name-asc': ['alpha-easy', 'alpha-twin', 'beta-hard', 'delta-easy', 'gamma-medium', 'omega-unknown'],
    'name-desc': ['omega-unknown', 'gamma-medium', 'delta-easy', 'beta-hard', 'alpha-easy', 'alpha-twin'],
    'difficulty-asc': ['alpha-easy', 'alpha-twin', 'delta-easy', 'gamma-medium', 'beta-hard', 'omega-unknown'],
    'difficulty-desc': ['beta-hard', 'gamma-medium', 'alpha-easy', 'alpha-twin', 'delta-easy', 'omega-unknown'],
    'companies-desc': ['gamma-medium', 'alpha-easy', 'beta-hard', 'alpha-twin', 'delta-easy', 'omega-unknown'],
    'companies-asc': ['alpha-twin', 'delta-easy', 'omega-unknown', 'alpha-easy', 'beta-hard', 'gamma-medium']
  };
  for (const [sort, slugs] of Object.entries(expected)) {
    const pages = [];
    for (let offset = 0; offset < slugs.length; offset += 2) {
      const page = await service.searchProblems({ sort, query: 'problem', offset, limit: 2 });
      assert.equal(page.total, 6);
      assert.equal(page.hasMore, offset + 2 < slugs.length);
      pages.push(...page.problems);
    }
    assert.deepEqual(pages.map((problem) => problem.slug), slugs, sort);
  }
  const filtered = await service.searchProblems({ query: 'problem', difficulty: 'easy', sort: 'companies-desc', offset: 1, limit: 1 });
  assert.equal(filtered.total, 3);
  assert.equal(filtered.problems[0].slug, 'alpha-twin');
  const recent = await service.searchProblems({ window: '30d', sort: 'companies-desc' });
  assert.deepEqual(recent.problems.map((problem) => [problem.slug, problem.companyCount]), [
    ['alpha-easy', 2], ['gamma-medium', 1], ['omega-unknown', 1]
  ]);
  assert.equal(source.calls.length, 0);
});

test('explicit problem ordering overrides search relevance while the omitted sort preserves it', async () => {
  const { service } = globalExplorerFixture();
  const defaultResult = await service.searchProblems({ query: 'two sum' });
  const explicitRelevance = await service.searchProblems({ query: 'two sum', sort: 'relevance' });
  assert.deepEqual(explicitRelevance, defaultResult);
  const alphabetical = await service.searchProblems({ query: 'two sum', sort: 'name-asc', limit: 1 });
  assert.equal(alphabetical.total, 3);
  assert.equal(alphabetical.problems[0].slug, 'advanced-two-sum-variant');
  assert.equal(defaultResult.problems[0].slug, 'two-sum');
});

test('practice sort modes reorder filtered full results without changing source scores and competition ranks', async () => {
  const { service, source } = sortingFixture();
  const expected = {
    'frequency-desc': ['beta-hard', 'alpha-easy', 'gamma-medium', 'alpha-twin', 'delta-easy', 'omega-unknown'],
    'frequency-asc': ['delta-easy', 'alpha-twin', 'alpha-easy', 'gamma-medium', 'beta-hard', 'omega-unknown'],
    'name-asc': ['alpha-easy', 'alpha-twin', 'beta-hard', 'delta-easy', 'gamma-medium', 'omega-unknown'],
    'name-desc': ['omega-unknown', 'gamma-medium', 'delta-easy', 'beta-hard', 'alpha-easy', 'alpha-twin'],
    'difficulty-asc': ['alpha-easy', 'alpha-twin', 'delta-easy', 'gamma-medium', 'beta-hard', 'omega-unknown'],
    'difficulty-desc': ['beta-hard', 'gamma-medium', 'alpha-easy', 'alpha-twin', 'delta-easy', 'omega-unknown'],
    'companies-desc': ['gamma-medium', 'alpha-easy', 'beta-hard', 'alpha-twin', 'delta-easy', 'omega-unknown'],
    'companies-asc': ['alpha-twin', 'delta-easy', 'omega-unknown', 'alpha-easy', 'beta-hard', 'gamma-medium']
  };
  const sourceValues = {
    'alpha-easy': [40, 2, 2], 'beta-hard': [100, 1, 2], 'gamma-medium': [40, 2, 3],
    'delta-easy': [0, 5, 1], 'omega-unknown': [null, null, 1], 'alpha-twin': [10, 4, 1]
  };
  for (const [sort, slugs] of Object.entries(expected)) {
    const pages = [];
    for (let offset = 0; offset < slugs.length; offset += 2) {
      const page = await service.getPractice({ company: 'Alpha', sort, offset, limit: 2 });
      assert.equal(page.total, 6, 'duplicate CSV rows do not create extra questions');
      assert.equal(page.hasMore, offset + 2 < slugs.length);
      pages.push(...page.questions);
    }
    assert.deepEqual(pages.map((question) => question.slug), slugs, sort);
    for (const question of pages) {
      assert.deepEqual([question.frequency, question.rank, question.companyCount], sourceValues[question.slug], sort + ' ' + question.slug);
    }
  }
  const filtered = await service.getPractice({ company: 'Alpha', query: 'problem', topic: 'Array', excludeSlug: 'alpha-easy', sort: 'frequency-asc', offset: 1, limit: 1 });
  assert.equal(filtered.total, 4);
  assert.equal(filtered.questions[0].slug, 'alpha-twin');
  assert.deepEqual([filtered.questions[0].frequency, filtered.questions[0].rank], [10, 4]);
  const defaultResult = await service.getPractice({ company: 'Alpha' });
  assert.deepEqual((await service.getPractice({ company: 'Alpha', sort: 'frequency-desc' })).questions, defaultResult.questions);
  assert.equal(source.calls.length, 0);
});

test('current-problem company sorting exposes selected-window question counts and leaves cached records unchanged', () => {
  const { data } = sortingFixture();
  const original = structuredClone(data);
  const companies = core.companiesForSlug(data, 'gamma-medium');
  assert.deepEqual(companies.map((company) => [company.name, company.problemCount, company.frequency, company.rank]), [
    ['Alpha', 6, 40, 2], ['Beta', 3, 40, 2], ['Gamma', 1, 40, 1]
  ]);
  assert.deepEqual(core.companiesForSlug(data, 'gamma-medium', '30d').map((company) => [company.name, company.problemCount]), [['Alpha', 3]]);
  const modes = {
    'name-asc': ['Alpha', 'Beta', 'Gamma'], 'name-desc': ['Gamma', 'Beta', 'Alpha'],
    'questions-desc': ['Alpha', 'Beta', 'Gamma'], 'questions-asc': ['Gamma', 'Beta', 'Alpha']
  };
  for (const [sort, names] of Object.entries(modes)) assert.deepEqual(core.sortCompanies(companies, sort).map((company) => company.name), names, sort);
  const frequencies = [{ name: 'High', frequency: 90 }, { name: 'Missing', frequency: null },
    { name: 'Zero', frequency: 0 }, { name: 'Tie B', frequency: 20 }, { name: 'Tie A', frequency: 20 }];
  const originalCompanies = structuredClone(frequencies);
  assert.deepEqual(core.sortCompanies(frequencies, 'frequency-asc').map((company) => company.name), ['Zero', 'Tie A', 'Tie B', 'High', 'Missing']);
  assert.deepEqual(frequencies, originalCompanies);
  const practice = core.practiceQuestions(data, { company: 'Alpha', sort: 'companies-desc' });
  const alpha = practice.questions.find((question) => question.slug === 'alpha-easy');
  alpha.topics.push('Injected');
  alpha.rank = 999;
  companies[0].name = 'Changed';
  core.searchProblems(data, { sort: 'difficulty-desc' });
  core.searchCompanies(data, { sort: 'questions-asc' });
  assert.deepEqual(data, original, 'query sorting and returned row edits do not mutate the source cache');
});

test('question company counts deduplicate valid selected-window index matches and ignore stale entries', () => {
  const { data } = sortingFixture();
  const id = (name) => data.companies.findIndex((company) => company.name === name);
  const alphaRecord = data.files['Alpha/' + core.WINDOW_FILES.all].records.findIndex((record) => record.slug === 'alpha-easy');
  const betaRecord = data.files['Beta/' + core.WINDOW_FILES.all].records.findIndex((record) => record.slug === 'alpha-easy');
  const duplicateBetaId = data.companies.push({ ...data.companies[id('Beta')] }) - 1;
  const missingFileId = data.companies.push({ name: 'Missing File', sourceUrl: core.SOURCE_URL }) - 1;
  data.windows.all.index['alpha-easy'].push(
    [id('Alpha'), alphaRecord], [id('Beta'), betaRecord], [duplicateBetaId, betaRecord],
    [missingFileId, 0], [id('Gamma'), 0], [id('Alpha'), -1], [id('Alpha'), 999],
    [-1, 0], [999, 0], [String(id('Beta')), betaRecord], null
  );
  const global = core.searchProblems(data, { query: 'alpha-easy', sort: 'companies-desc' });
  assert.equal(global.problems[0].companyCount, 2);
  const practice = core.practiceQuestions(data, { company: 'Alpha', sort: 'companies-desc' });
  assert.equal(practice.questions.find((question) => question.slug === 'alpha-easy').companyCount, 2);
  assert.equal(practice.questions.find((question) => question.slug === 'gamma-medium').companyCount, 3);
  const recent = core.practiceQuestions(data, { company: 'Alpha', window: '30d', sort: 'companies-desc' });
  assert.deepEqual(recent.questions.map((question) => [question.slug, question.companyCount]), [
    ['alpha-easy', 2], ['gamma-medium', 1], ['omega-unknown', 1]
  ]);
});

test('each query endpoint rejects malformed and irrelevant sort modes before touching storage or the network', async () => {
  const source = sourceFixture();
  let storageReads = 0;
  const storage = memoryStorage();
  const originalGet = storage.get;
  storage.get = async (...args) => { storageReads += 1; return originalGet(...args); };
  const service = makeService(storage, source);
  for (const sort of [null, '', false, 0, [], {}, 'unknown', '__proto__', 'NAME-ASC']) {
    for (const method of ['searchProblems', 'searchCompanies', 'getPractice']) {
      await assert.rejects(service[method]({ company: 'Alpha', sort }), /sort/i, method + ' ' + JSON.stringify(sort));
    }
  }
  for (const sort of ['frequency-desc', 'frequency-asc', 'questions-desc', 'questions-asc']) {
    await assert.rejects(service.searchProblems({ sort }), /sort/i, sort);
  }
  for (const sort of ['relevance', 'frequency-desc', 'difficulty-asc', 'companies-desc']) {
    await assert.rejects(service.searchCompanies({ sort }), /sort/i, sort);
  }
  for (const sort of ['relevance', 'questions-desc', 'questions-asc']) {
    await assert.rejects(service.getPractice({ company: 'Alpha', sort }), /sort/i, sort);
  }
  assert.equal(storageReads, 0, 'invalid requests fail before loading the cache');
  assert.equal(source.calls.length, 0);
});


function savedLookup(storage) {
  return Object.fromEntries(Object.entries(storage.values).filter(([key]) => key === lookup.META_KEY || key.startsWith(lookup.SHARD_PREFIX)));
}

function assertAtomicLookupPublication(publication) {
  assert.ok(publication.lctData, 'complete records are part of the publication');
  assert.ok(publication.lctStatus, 'status is part of the same storage write');
  assert.ok(publication[lookup.META_KEY], 'lookup metadata is part of the same storage write');
  assert.equal(publication[lookup.META_KEY].commit, publication.lctData.commit);
  assert.equal(publication[lookup.META_KEY].revision, publication.lctData.commit + ':' + publication.lctData.lastSyncedAt);
  assert.equal(publication.lctStatus.commit, publication.lctData.commit);
  const shards = Object.entries(publication).filter(([key]) => key.startsWith(lookup.SHARD_PREFIX));
  assert.equal(shards.length, 5 * lookup.SHARD_COUNT, 'all old buckets are replaced together, including empty ones');
  for (const [, shard] of shards) assert.equal(shard.revision, publication[lookup.META_KEY].revision);
}

test('bundled seed atomically publishes compact lookups before remote requests', async () => {
  const { source, data } = snapshotFixture();
  const storage = memoryStorage();
  const service = makeService(storage, source, { loadSnapshot: async () => data });
  await service.initialize();
  assert.equal(source.calls.length, 0);
  const publications = storage.writes.filter((write) => write.lctData);
  assert.equal(publications.length, 1);
  assertAtomicLookupPublication(publications[0]);
  for (const window of Object.keys(core.WINDOW_FILES)) {
    const result = await lookup.readProblem(storage, 'two-sum', window);
    assert.equal(result.status.dataSource, 'bundled');
    assert.deepEqual(result.companies, core.companiesForSlug(storage.values.lctData, 'two-sum', window));
  }
});

test('failed refresh preserves the previous compact revision and completed refresh replaces data and every shard atomically', async () => {
  const source = sourceFixture();
  const storage = memoryStorage();
  const service = makeService(storage, source);
  await service.refresh();
  await service.waitForIdle();
  const firstPublication = storage.writes.find((write) => write.lctData);
  assertAtomicLookupPublication(firstPublication);
  const previous = structuredClone(savedLookup(storage));
  source.commit = SHA_B;
  source.files = [company('Amazon', BLOB_C), company('Google', BLOB_C)];
  source.csvByCompany.Amazon = csv(['reverse-linked-list']);
  source.failures.Google = () => response('', 503);
  await service.refresh();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'error');
  assert.deepEqual(savedLookup(storage), previous, 'a partial sync never changes the published tags');
  const offline = await lookup.readProblem(storage, 'two-sum', 'all');
  assert.equal(offline.status.commit, SHA_A);
  assert.equal(offline.status.phase, 'error');
  assert.deepEqual(offline.companies.map((entry) => entry.name), ['Amazon', 'Google']);
  assert.deepEqual((await lookup.readProblem(storage, 'reverse-linked-list', 'all')).companies, []);
  delete source.failures.Google;
  await service.refresh();
  await service.waitForIdle();
  const publications = storage.writes.filter((write) => write.lctData);
  assert.equal(publications.length, 2, 'only complete datasets are published');
  assertAtomicLookupPublication(publications[1]);
  assert.notEqual(storage.values[lookup.META_KEY].revision, previous[lookup.META_KEY].revision);
  const result = await lookup.readProblem(storage, 'reverse-linked-list', 'all');
  assert.equal(result.status.commit, SHA_B);
  assert.deepEqual(result.companies, core.companiesForSlug(storage.values.lctData, 'reverse-linked-list'));
  assert.deepEqual((await lookup.readProblem(storage, 'two-sum', 'all')).companies.map((entry) => entry.name), ['Google']);
});

test('existing complete caches backfill compact lookup once while warm queries and worker restarts never rewrite it', async () => {
  const { source, data } = snapshotFixture();
  const storage = memoryStorage({ lctData: data,
    lctStatus: { phase: 'idle', lastCheckedAt: new Date(FIXED_NOW).toISOString(), dataSource: 'live' } });
  const originalData = structuredClone(storage.values.lctData);
  const service = makeService(storage, source);
  await service.initialize();
  assert.ok(storage.values[lookup.META_KEY]);
  assert.equal(storage.writes.filter((write) => write[lookup.META_KEY]).length, 1);
  assert.deepEqual(storage.values.lctData, originalData, 'backfill does not republish or alter full records');
  const writes = storage.writes.length;
  const previousLookup = structuredClone(savedLookup(storage));
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const compact = await lookup.readProblem(storage, 'two-sum', '30d');
    assert.deepEqual(compact.companies, await service.getCompanies('two-sum', '30d'));
    await service.getStatus();
    await service.initialize();
  }
  const restarted = makeService(storage, source);
  await restarted.initialize();
  await restarted.getCompanies('two-sum');
  assert.equal(storage.writes.length, writes);
  assert.deepEqual(savedLookup(storage), previousLookup);
  assert.equal(source.calls.length, 0);
  const legacy = memoryStorage(legacyState());
  const legacyService = makeService(legacy, source);
  await legacyService.initialize();
  assert.equal(legacy.values[lookup.META_KEY], undefined, 'legacy tags continue to use the full-cache fallback until migration completes');
  assert.equal((await legacyService.getCompanies('two-sum')).length, 2);
});


test('unchanged-commit confirmation updates compact read status to live without rewriting the bundled revision', async () => {
  const { source, data } = snapshotFixture();
  const storage = memoryStorage();
  const service = makeService(storage, source, { loadSnapshot: async () => data });
  await service.initialize();
  const previousLookup = structuredClone(savedLookup(storage));
  const previousData = structuredClone(storage.values.lctData);
  assert.equal((await lookup.readStatus(storage)).dataSource, 'bundled');
  await service.startAutomatic();
  await service.waitForIdle();
  assert.deepEqual(source.calls, [core.API_URL + '/commits/main']);
  assert.deepEqual(storage.values.lctData, previousData);
  assert.deepEqual(savedLookup(storage), previousLookup);
  assert.equal(storage.writes.filter((write) => write.lctData).length, 1);
  assert.equal(storage.writes.filter((write) => write[lookup.META_KEY]).length, 1);
  const result = await lookup.readProblem(storage, 'two-sum', 'all');
  const status = await lookup.readStatus(storage);
  for (const value of [result.status, status]) {
    assert.equal(value.phase, 'idle');
    assert.equal(value.dataSource, 'live');
    assert.equal(value.commit, data.commit);
    assert.equal(value.sourceUpdatedAt, data.sourceUpdatedAt);
    assert.equal(value.lastSyncedAt, data.lastSyncedAt);
    assert.equal(value.companyCount, data.companyCount);
    assert.equal(value.problemCount, data.problemCount);
  }
  assert.deepEqual(result.companies, core.companiesForSlug(previousData, 'two-sum'));
});


test('a newer full cache and status repair stale compact rows before answering a fallback query', async () => {
  const { source, data } = snapshotFixture();
  const oldStatus = { phase: 'idle', dataSource: 'bundled', commit: SHA_A,
    lastSyncedAt: data.lastSyncedAt, sourceUpdatedAt: data.sourceUpdatedAt };
  const oldLookup = lookup.buildStorage(data, oldStatus);
  const newer = structuredClone(data);
  newer.commit = SHA_B;
  newer.lastSyncedAt = new Date(FIXED_NOW + 60000).toISOString();
  newer.files['Amazon/5. All.csv'].records[0].frequency = 97;
  const storage = memoryStorage({ ...oldLookup, lctData: newer,
    lctStatus: { phase: 'idle', dataSource: 'live', commit: SHA_B,
      lastSyncedAt: newer.lastSyncedAt, sourceUpdatedAt: newer.sourceUpdatedAt,
      lastCheckedAt: new Date(FIXED_NOW).toISOString() } });
  assert.equal(await lookup.readProblem(storage, 'two-sum', 'all'), null);
  assert.equal(await lookup.readStatus(storage), null);
  const service = makeService(storage, source);
  const companies = await service.getCompanies('two-sum');
  assert.deepEqual(companies, core.companiesForSlug(newer, 'two-sum'));
  assert.equal(companies[0].frequency, 97, 'the fallback returns newly published scores instead of the stale bundled value');
  assert.equal(storage.values[lookup.META_KEY].commit, SHA_B);
  assert.equal(storage.writes.filter((write) => write[lookup.META_KEY]).length, 1);
  assert.equal(storage.writes.filter((write) => write.lctData).length, 0, 'repair derives from existing full records without republishing them');
  const repaired = await lookup.readProblem(storage, 'two-sum', 'all');
  assert.deepEqual(repaired.companies, companies);
  assert.equal(repaired.status.commit, SHA_B);
  assert.equal((await lookup.readStatus(storage)).dataSource, 'live');
  assert.deepEqual(storage.values.lctData, newer);
  assert.equal(source.calls.length, 0);
});


const VERIFIED_ACCEPTANCE_COMMIT = '03850eb5d16892514491cf1381c32ec0330a2719';
function acceptanceCSV(values) {
  return 'Difficulty,Title,Frequency,Acceptance Rate,Link,Topics\n' + values.map((value, index) =>
    'Easy,Problem ' + index + ',100,' + value + ',https://leetcode.com/problems/problem-' + index + '/,Array').join('\n');
}
function acceptanceValues(values, options) {
  return core.parseCompanyRecords(acceptanceCSV(values), options).map((record) => record.acceptanceRate);
}
function oldAcceptanceData(data) {
  const old = structuredClone(data);
  delete old.acceptanceVersion;
  delete old.problems;
  for (const file of Object.values(old.files)) for (const record of file.records) delete record.acceptanceRate;
  return old;
}

test('acceptance normalization corrects only verified source scale and otherwise infers one unit per file', () => {
  const corrected = acceptanceValues(['0.0058009183274', '0.004786834', '0.00680278'], { commit: VERIFIED_ACCEPTANCE_COMMIT });
  assert.deepEqual(corrected.map(core.formatAcceptanceRate), ['58.0%', '47.9%', '68.0%']);
  assert.deepEqual(acceptanceValues(['0.0058', '0.009']), [null, null], 'unknown all-tiny values cannot assume the verified bug');
  assert.deepEqual(acceptanceValues(['0.5', '0.005', '0', '1']), [50, 0.5, 0, 100], 'a valid low fraction keeps the column scale');
  assert.deepEqual(acceptanceValues(['48.2', '0.5', '0', '100']), [48.2, 0.5, 0, 100], 'a valid low percentage keeps the column scale');
  assert.deepEqual(acceptanceValues(['0.005', '0'], { acceptanceFormat: 'fraction' }), [0.5, 0]);
  assert.deepEqual(acceptanceValues(['0.005', '0'], { acceptanceFormat: 'percent' }), [0.005, 0]);
  assert.deepEqual(acceptanceValues(['0.005', '0'], { acceptanceFormat: 'scaled-fraction' }), [50, 0]);
  assert.deepEqual(acceptanceValues(['48.2%', '0.5%', '100%', '0%']), [48.2, 0.5, 100, 0]);
});

test('acceptance parsing and formatting preserve unavailable data and reject malformed or out-of-range values', () => {
  const unknowns = ['', 'NaN', 'Infinity', '-1', '100.1%', '101', '0x10', 'bad', '48%bad'];
  assert.deepEqual(acceptanceValues(unknowns, { acceptanceFormat: 'percent' }), unknowns.map(() => null));
  assert.deepEqual(acceptanceValues(['0.0101', '1'], { commit: VERIFIED_ACCEPTANCE_COMMIT }), [null, null], 'scaled values above100 are unavailable');
  assert.deepEqual(acceptanceValues(['5e-3'], { acceptanceFormat: 'fraction' }), [0.5]);
  const missing = core.parseCompanyRecords('Title,Link\nTwo Sum,https://leetcode.com/problems/two-sum/')[0];
  assert.equal(missing.acceptanceRate, null);
  assert.equal(Object.hasOwn(missing, 'acceptanceRate'), true);
  for (const value of [null, undefined, NaN, Infinity, -1, 101, '58']) assert.equal(core.formatAcceptanceRate(value), null);
  assert.equal(core.formatAcceptanceRate(0), '0.0%');
  assert.equal(core.formatAcceptanceRate(100), '100.0%');
  assert.equal(core.formatAcceptanceRate(48.23), '48.2%');
});

test('problem acceptance is shared across companies, practice, search, and windows', async () => {
  const { source } = snapshotFixture();
  source.csvByCompany.Amazon = source.csvByCompany.Amazon.replaceAll('"0.5"', '"58.1%"');
  source.csvByCompany.Google = source.csvByCompany.Google.replaceAll('"0.5"', '"60.0%"');
  for (const path of Object.keys(source.csvByPath)) source.csvByPath[path] = source.csvByPath[path].replaceAll('"0.5"', '"72.0%"');
  const service = makeService(memoryStorage(), source);
  await service.refresh();
  await service.waitForIdle();
  assert.deepEqual(await service.getProblem('two-sum'), { title: 'Two Sum', difficulty: 'Easy', acceptanceRate: 58.1 });
  for (const window of Object.keys(core.WINDOW_FILES)) {
    const result = await service.searchProblems({ query: 'two sum', window });
    assert.equal(result.problems[0].acceptanceRate, 58.1);
    for (const company of ['Amazon', 'Google']) {
      const practice = await service.getPractice({ company, query: 'two sum', window });
      assert.equal(practice.questions[0].acceptanceRate, 58.1, company + ' ' + window);
    }
  }
  assert.equal(await service.getProblem('not-in-source'), null);
  await assert.rejects(service.getProblem('__proto__'), /slug/i);
});

test('raw and archive sync carry the pinned acceptance format through parsing', async () => {
  for (const archiveMode of [false, true]) {
    const source = sourceFixture();
    source.commit = VERIFIED_ACCEPTANCE_COMMIT;
    for (const name of Object.keys(source.csvByCompany)) source.csvByCompany[name] = source.csvByCompany[name].replaceAll(',0.5,', ',0.0058,');
    if (archiveMode) enableArchive(source);
    const service = makeService(memoryStorage(), source, archiveMode ? { archive: require('../extension/archive.js') } : {});
    await service.refresh();
    await service.waitForIdle();
    assert.equal((await service.getStatus()).phase, 'idle');
    assert.equal(core.formatAcceptanceRate((await service.getProblem('two-sum')).acceptanceRate), '58.0%');
  }
});

test('an old same-commit cache reparses source rows instead of forever reusing missing acceptance fields', async () => {
  const { source, data } = snapshotFixture();
  const old = oldAcceptanceData(data);
  const status = { phase: 'idle', dataSource: 'live', lastCheckedAt: new Date(FIXED_NOW).toISOString() };
  const storage = memoryStorage({ lctData: old, lctStatus: status });
  const service = makeService(storage, source);
  assert.equal(await service.getProblem('two-sum'), null);
  assert.equal(core.reusableFile({ path: 'Amazon/5. All.csv', sha: BLOB_A }, old.files), null);
  await service.startAutomatic();
  await service.waitForIdle();
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, Object.keys(data.files).length);
  assert.equal(storage.values.lctData.acceptanceVersion, core.ACCEPTANCE_VERSION);
  assert.equal((await service.getProblem('two-sum')).acceptanceRate, 50);
  assert.equal((await lookup.readProblem(storage, 'two-sum', 'all')).problem.acceptanceRate, 50);
});

test('an enriched same-commit bundle migrates existing records offline with one atomic publication', async () => {
  const { source, data } = snapshotFixture();
  const old = oldAcceptanceData(data);
  const status = { phase: 'idle', dataSource: 'live', lastCheckedAt: new Date(FIXED_NOW).toISOString(), commit: old.commit };
  const storage = memoryStorage({ lctData: old, lctStatus: status });
  const service = makeService(storage, source, { loadSnapshot: async () => data });
  assert.equal((await service.getProblem('two-sum')).acceptanceRate, 50);
  assert.equal(source.calls.length, 0);
  assert.equal(storage.values.lctData.commit, old.commit);
  assert.equal(storage.values.lctData.lastSyncedAt, old.lastSyncedAt);
  assert.equal(storage.values.lctStatus.lastCheckedAt, status.lastCheckedAt);
  assert.equal(storage.values.lctStatus.dataSource, 'live');
  const publications = storage.writes.filter((value) => value.lctData);
  assert.equal(publications.length, 1);
  assert.ok(publications[0][lookup.META_KEY]);
  assert.ok(publications[0][lookup.shardKey('two-sum', 'all')]);
  assert.equal((await lookup.readProblem(storage, 'two-sum', '30d')).problem.acceptanceRate, 50);
});

test('a different-commit bundle never replaces or relabels a newer cache while migrating acceptance', async () => {
  const { source, data } = snapshotFixture();
  const existing = oldAcceptanceData(data);
  existing.commit = SHA_B;
  existing.sourceUpdatedAt = '2026-09-16T22:18:35Z';
  existing.files['Amazon/5. All.csv'].records[0].frequency = 97;
  const storage = memoryStorage({ lctData: existing, lctStatus: { phase: 'idle', dataSource: 'live', commit: SHA_B } });
  const service = makeService(storage, source, { loadSnapshot: async () => data });
  assert.equal(await service.getProblem('two-sum'), null);
  assert.equal((await service.getCompanies('two-sum'))[0].frequency, 97);
  assert.deepEqual(storage.values.lctData, existing);
  assert.equal(storage.writes.filter((value) => value.lctData).length, 0);
  assert.equal(source.calls.length, 0);
  const compact = await lookup.readProblem(storage, 'two-sum', 'all');
  assert.equal(compact.problem, null);
  assert.equal(compact.status.commit, SHA_B);
  assert.equal(compact.status.acceptanceVersion, 0);
});

test('old completed checkpoints without acceptance are downloaded again before complete publication', async () => {
  const source = sourceFixture();
  const files = core.selectWindowFiles({ truncated: false, tree: source.files });
  const records = core.parseCompanyRecords(source.csvByCompany.Amazon);
  for (const record of records) delete record.acceptanceRate;
  const manifestKey = 'lctManifest:' + SHA_A;
  const storage = memoryStorage({
    [manifestKey]: files,
    ['lctChunk:' + SHA_A + ':Amazon/5. All.csv']: { sha: BLOB_A, records },
    lctStage: { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, checkpointVersion: 2, commit: SHA_A,
      sourceUpdatedAt: '2026-08-16T22:18:35Z', manifestKey, completed: ['Amazon/5. All.csv'], useArchive: false, failureCount: 0, retryAt: 0 }
  });
  const service = makeService(storage, source);
  await service.resume();
  await service.waitForIdle();
  assert.equal((await service.getStatus()).phase, 'idle');
  assert.equal(source.calls.filter((url) => url.startsWith(core.RAW_URL)).length, 2);
  assert.equal((await service.getProblem('two-sum')).acceptanceRate, 50);
});
