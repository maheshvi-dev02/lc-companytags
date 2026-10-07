const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');
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
  return {
    values,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])]));
    },
    async set(next) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, 1));
      Object.assign(values, structuredClone(next));
    }
  };
}

function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: new Headers(headers), async json() { return structuredClone(body); }, async text() { return body; } };
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
    csvByCompany: { Amazon: csv(['two-sum']), Google: csv(['two-sum', 'add-two-numbers']) }, csvByPath: {}, failures: {}, calls: [], active: 0, maxActive: 0 };
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
    assert.ok(url.startsWith(core.RAW_URL + '/' + source.commit + '/'), 'raw requests are pinned to the selected commit');
    const name = decodeURIComponent(url.split('/').at(-2));
    const path = url.split('/').slice(-2).map(decodeURIComponent).join('/');
    if (source.failures[path]) return source.failures[path]();
    if (source.failures[name]) return source.failures[name]();
    source.active += 1;
    source.maxActive = Math.max(source.active, source.maxActive);
    await new Promise((resolve) => setTimeout(resolve, 1));
    source.active -= 1;
    return response(source.csvByPath[path] || source.csvByCompany[name]);
  };
  return source;
}

function makeService(storage, source, extras = {}) {
  return createSyncService({ storage, fetch: source.fetch, now: () => FIXED_NOW, sleep: async () => {}, ...extras });
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
  assert.deepEqual(Object.keys(storage.values.lctStage.done), ['Amazon/5. All.csv']);
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
