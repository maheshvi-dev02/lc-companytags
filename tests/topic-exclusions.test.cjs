const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const core = require('../extension/core.js');
const { createSyncService } = require('../extension/sync.js');
const collection = require('../extension/target-collection.js');
const data = JSON.parse(gunzipSync(readFileSync(require('node:path').join(__dirname, '../extension/data/snapshot.json.gz'))));
const hasExcluded = row => row.topics.some(topic => ['database', 'shell'].includes(topic.toLowerCase()));
function allRows(query, options = {}, snapshot) {
  const first = query(data, { ...options, limit: 100 }, snapshot);
  const rows = first.problems || first.questions;
  for (let offset = 100; offset < first.total; offset += 100) {
    const page = query(data, { ...options, limit: 100, offset }, snapshot);
    rows.push(...(page.problems || page.questions));
  }
  return { ...first, rows };
}
test('excluded topics remove whole problems before pagination and grouping, while retaining the catalog', () => {
  for (const [query, options] of [[core.searchProblems, {}], [core.practiceQuestions, { company: 'Amazon' }]]) {
    const baseline = allRows(query, options);
    const expected = baseline.rows.filter(row => !hasExcluded(row));
    assert.ok(expected.length < baseline.rows.length);
    const filtered = allRows(query, { ...options, excludedTopics: [' database ', 'sHeLl'] });
    assert.equal(filtered.total, expected.length);
    assert.deepEqual(filtered.rows.map(row => row.slug), expected.map(row => row.slug));
    assert.deepEqual(filtered.topics, baseline.topics);
    assert.ok(!filtered.topicGroups.some(group => ['Database', 'Shell'].includes(group.topic)));
    for (const group of filtered.topicGroups) {
      assert.equal(group.total, expected.filter(row => group.topic === null ? !row.topics.length : row.topics.includes(group.topic)).length);
    }
    const arrayGroup = allRows(query, { ...options, excludedTopics: ['Database', 'Shell'], groupTopic: 'Array' });
    assert.deepEqual(arrayGroup.rows.map(row => row.slug), expected.filter(row => row.topics.includes('Array')).map(row => row.slug));
  }
});
test('exclusion wins over include-any and include-all and combines with completion/difficulty', () => {
  for (const query of [core.searchProblems, core.practiceQuestions]) {
    for (const topicMatch of ['any', 'all']) {
      assert.equal(query(data, { company: 'Amazon', topics: ['Array'], excludedTopics: ['array'], topicMatch }).total, 0);
    }
    const options = { company: 'Amazon', difficulty: 'Medium', topics: ['Array'], excludedTopics: ['Hash Table'] };
    const baseline = allRows(query, options);
    assert.ok(baseline.rows.length);
    assert.ok(baseline.rows.every(row => row.difficulty === 'Medium' && !row.topics.includes('Hash Table')));
    const accepted = baseline.rows.filter((_, i) => i % 2 === 0).map(row => row.slug);
    const snapshot = { state: 'ready', completed: Object.fromEntries(accepted.map(slug => [slug, true])) };
    assert.deepEqual(allRows(query, { ...options, completionFilter: 'solved' }, snapshot).rows.map(row => row.slug), accepted);
  }
});
test('random and multi-company prep exclude topics from both questions and coverage', () => {
  for (const companies of [[], ['Amazon'], ['Amazon', 'Microsoft']]) {
    for (const targetMode of companies.length ? ['random', 'plan'] : ['random']) {
      const options = { targetMode, companies, excludedTopics: ['Database', 'Shell', 'Array'], count: 20 };
      const result = core.targetQuestions(data, options, undefined, () => .99);
      assert.ok(result.questions.length);
      assert.ok(result.questions.every(row => !hasExcluded(row) && !row.topics.includes('Array')));
      assert.ok(result.coveredTopics.every(topic => !options.excludedTopics.includes(topic)));
    }
  }
});
test('invalid exclusions fail before data access on each query endpoint', async () => {
  let reads = 0;
  const service = createSyncService({ storage: { get: async () => { reads++; return {}; }, set: async () => {} }, fetch: async () => { throw new Error('No network expected'); } });
  for (const excludedTopics of ['Shell', [null], [''], ['x'.repeat(201)], Array(257).fill('Array')]) {
    await assert.rejects(service.searchProblems({ excludedTopics }), /topic filter/i);
    await assert.rejects(service.getPractice({ company: 'Amazon', excludedTopics }), /topic filter/i);
    await assert.rejects(service.getTarget({ targetMode: 'random', excludedTopics }), /topic filter/i);
  }
  assert.equal(reads, 0);
});
test('saved targets preserve excluded topics when reopened, edited and cloned; older collections default to none', async () => {
  const options = { targetMode: 'plan', company: 'Amazon', window: 'all', excludedTopics: ['Database', 'Shell'], count: 12 };
  const result = core.targetQuestions(data, options);
  const state = {}, service = collection.create({ get: async () => structuredClone(state), set: async values => Object.assign(state, structuredClone(values)) });
  const saved = await service.save({ ...result, context: options });
  const edited = await service.update(saved.id, 'My prep', saved.revision);
  const cloned = await service.clone(edited.id, 'My copy', edited.revision);
  assert.deepEqual(cloned.context.excludedTopics, options.excludedTopics);
  assert.deepEqual((await service.list())[0].context.excludedTopics, options.excludedTopics);
  const old = { ...result, context: { ...options } }; delete old.context.excludedTopics;
  assert.deepEqual(collection.cleanTarget(old).context.excludedTopics, []);
});
