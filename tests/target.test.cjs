const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const core = require('../extension/core.js');
const sync = require('../extension/sync.js');
const data = JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname, '../extension/data/snapshot.json.gz'))));

test('random Target uses the entire filtered pool and avoids the previous pick when a pool cycles', () => {
  const first = core.searchProblems(data, { difficulty: 'Medium', topics: ['Array'] });
  assert.ok(first.total > 100);
  const last = core.searchProblems(data, { difficulty: 'Medium', topics: ['Array'], offset: first.total - 1, limit: 1 });
  const picked = core.targetQuestions(data, { targetMode: 'random', difficulty: 'Medium', topics: ['Array'] }, undefined, () => .99999999);
  assert.equal(picked.questions[0].slug, last.problems[0].slug);
  assert.equal(picked.questions[0].difficulty, 'Medium');
  assert.ok(picked.questions[0].topics.includes('Array'));
  const snapshot = { state: 'ready', completed: { [first.problems[0].slug]: false, [first.problems[1].slug]: false } };
  const cycled = core.targetQuestions(data, { targetMode: 'random', completionFilter: 'not-solved', excludeSlugs: first.problems.slice(0, 2).map(p => p.slug) }, snapshot, () => 0);
  assert.equal(cycled.questions[0].slug, first.problems[0].slug);
});

test('Microsoft prep stays company-specific, diverse, deterministic, and preserves source ranks', () => {
  const original = JSON.stringify(data);
  const result = core.targetQuestions(data, { targetMode: 'plan', company: 'Microsoft', count: 20 });
  assert.equal(result.questions.length, 20);
  assert.equal(new Set(result.questions.map(p => p.slug)).size, 20);
  assert.ok(result.coveredTopics.length >= 8);
  assert.deepEqual(core.targetQuestions(data, { targetMode: 'plan', company: 'Microsoft', count: 20 }).questions, result.questions);
  const source = data.files['Microsoft/' + core.WINDOW_FILES.all].records;
  for (const question of result.questions) {
    const record = source.find(row => row.slug === question.slug);
    assert.ok(record);
    assert.equal(question.rank, record.rank);
    assert.equal(question.frequency, record.frequency);
  }
  assert.equal(JSON.stringify(data), original);
});

test('Target service validates options and uses only the trusted account snapshot', async () => {
  let reads = 0;
  const state = { lctData: data, lctStatus: { phase: 'ready', commit: data.commit } };
  const service = sync.createSyncService({ storage: { get: async () => { reads++; return state; }, set: async value => Object.assign(state, value) }, fetch: async () => { throw new Error('No network expected'); } });
  for (const options of [{ targetMode: 'plan' }, { targetMode: 'bad' }, { count: 51 }, { excludeSlugs: ['../secret'] }, { completionFilter: 'not-solved', completed: {} }]) {
    await assert.rejects(service.getTarget(options));
  }
  assert.equal(reads, 0);
  const rows = core.practiceQuestions(data, { company: 'Microsoft' }).questions;
  const snapshot = { state: 'ready', completed: { [rows[0].slug]: true, [rows[1].slug]: false } };
  const result = await service.getTarget({ targetMode: 'plan', company: 'Microsoft', completionFilter: 'not-solved', count: 20, completed: { [rows[0].slug]: false } }, snapshot);
  assert.deepEqual(result.questions.map(p => p.slug), [rows[1].slug]);
  const unavailable = await service.getTarget({ targetMode: 'random', completionFilter: 'not-solved' }, { state: 'signed-out' });
  assert.equal(unavailable.total, null);
  assert.deepEqual(unavailable.questions, []);
});
