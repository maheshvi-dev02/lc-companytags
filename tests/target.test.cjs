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

const collection = require('../extension/target-collection.js');
test('company-filtered random Target combines company, window, difficulty and topic', () => {
  const options = { targetMode: 'random', company: 'Microsoft', window: '6m', difficulty: 'Medium', topics: ['Array'] };
  const pool = core.practiceQuestions(data, { ...options, limit: 100 });
  assert.ok(pool.total > 0);
  const all = [...pool.questions];
  for (let offset = all.length; offset < pool.total; offset += 100) all.push(...core.practiceQuestions(data, { ...options, offset, limit: 100 }).questions);
  for (const fraction of [0, .5, .999999]) {
    const result = core.targetQuestions(data, options, undefined, () => fraction);
    assert.equal(result.total, pool.total);
    assert.ok(all.some(row => row.slug === result.questions[0].slug));
    assert.equal(result.questions[0].difficulty, 'Medium');
    assert.ok(result.questions[0].topics.includes('Array'));
  }
});
function savedExample(title = 'Two Sum') {
  return { context: { targetMode: 'plan', company: 'Microsoft', window: 'all', difficulty: '', completionFilter: 'not-solved', topics: [] },
    questions: [{ slug: 'two-sum', title, difficulty: 'Easy', topics: ['Array', 'Hash Table'], frequency: 93.1, rank: 3, acceptanceRate: 55.2, completed: false }],
    coveredTopics: ['Array', 'Hash Table'], availableTopicCount: 3, completion: { username: 'private-user', completed: { 'two-sum': false } } };
}
test('saved Target writes are serialized, survive reopening, and omit account progress', async () => {
  const state = {}, storage = { get: async () => structuredClone(state), set: async value => { await new Promise(resolve => setTimeout(resolve, 2)); Object.assign(state, structuredClone(value)); } };
  const service = collection.create(storage);
  const [a, b] = await Promise.all([service.save(savedExample()), service.save(savedExample('Another title'))]);
  assert.notEqual(a.id, b.id);
  const reopened = await collection.create(storage).list();
  assert.equal(reopened.length, 2);
  assert.deepEqual(reopened.find(item => item.id === a.id).questions, a.questions);
  assert.ok(!JSON.stringify(state).includes('private-user'));
  assert.ok(!Object.hasOwn(a.questions[0], 'completed'));
  await service.remove(a.id);
  assert.deepEqual((await service.list()).map(item => item.id), [b.id]);
  await assert.rejects(service.save({ ...savedExample(), questions: [] }));
});
test('Target CSV preserves exact rows, quotes embedded text, blanks unknown metrics, and neutralizes formulas', () => {
  const target = savedExample('=HYPERLINK("x"),\nnext');
  target.questions[0].frequency = null;
  const csv = collection.csv(target);
  const rows = core.parseCSV(csv.replace(/^\uFEFF/, ''));
  assert.equal(rows.length, 2);
  assert.equal(rows[1][3], "'" + target.questions[0].title);
  assert.equal(rows[1][5], 'Array; Hash Table');
  assert.equal(rows[1][7], '');
  assert.equal(rows[1][9], 'https://leetcode.com/problems/two-sum/');
});

test('named collection rename, filtered update and clone preserve identity and protect against stale or empty changes', async () => {
  const state = {}, storage = { get: async () => structuredClone(state), set: async value => Object.assign(state, structuredClone(value)) };
  const service = collection.create(storage), original = await service.save(savedExample());
  const renamed = await service.update(original.id, 'Microsoft warmup', original.revision);
  assert.equal(renamed.id, original.id);
  assert.equal(renamed.createdAt, original.createdAt);
  assert.equal(renamed.name, 'Microsoft warmup');
  assert.deepEqual(renamed.questions, original.questions);
  const cloned = await service.clone(renamed.id, 'Microsoft next week', renamed.revision);
  assert.notEqual(cloned.id, original.id);
  assert.deepEqual(cloned.questions, original.questions);
  const options = { targetMode: 'plan', company: 'Microsoft', window: 'all', difficulty: 'Medium', completionFilter: 'all', topics: [], count: 12 };
  const generated = core.targetQuestions(data, options);
  const updated = await service.update(renamed.id, renamed.name, renamed.revision, { ...generated, context: options });
  assert.equal(updated.id, original.id);
  assert.equal(updated.questions.length, 12);
  assert.ok(updated.questions.every(row => row.difficulty === 'Medium'));
  assert.equal(updated.context.count, 12);
  assert.equal((await service.list()).length, 2);
  assert.deepEqual((await service.list()).find(row => row.id === cloned.id).questions, original.questions);
  const before = JSON.stringify(state);
  await assert.rejects(service.update(renamed.id, 'Stale edit', renamed.revision), /changed in another view/);
  await assert.rejects(service.update(updated.id, updated.name, updated.revision, { ...generated, context: options, questions: [] }), /Invalid saved Target/);
  await assert.rejects(service.clone(updated.id, ' ', updated.revision), /collection name/);
  assert.equal(JSON.stringify(state), before);
});
test('older unnamed collections retain their exact questions and acquire a default name without regeneration', async () => {
  const old = { ...savedExample(), id: 'legacy-target', createdAt: '2026-10-13T10:00:00.000Z' };
  const service = collection.create({ get: async () => ({ lctTargetCollection: [old] }) });
  const [entry] = await service.list();
  assert.equal(entry.id, old.id);
  assert.equal(entry.name, 'Microsoft prep');
  assert.equal(entry.revision, 1);
  assert.equal(entry.questions[0].slug, 'two-sum');
});


test('multiple companies combine distinct problems and preserve company-specific scores, topic match and difficulty filters', async () => {
  const options = { targetMode: 'plan', companies: ['Microsoft', 'Google'], window: 'all', difficulty: 'Easy,Medium', topics: ['Array', 'Linked List'], topicMatch: 'any', count: 50 };
  const union = new Set(options.companies.flatMap(company => data.files[company + '/' + core.WINDOW_FILES.all].records.filter(r => ['Easy','Medium'].includes(r.difficulty) && r.topics.some(t => options.topics.includes(t))).map(r => r.slug)));
  const result = core.targetQuestions(data, options);
  assert.equal(result.total, union.size);
  assert.equal(new Set(result.questions.map(r => r.slug)).size, result.questions.length);
  assert.ok(result.questions.every(row => union.has(row.slug) && ['Easy','Medium'].includes(row.difficulty)));
  assert.deepEqual(new Set(result.questions.flatMap(row => row.companyMatches.map(m => m.name))), new Set(options.companies));
  for (const row of result.questions) for (const match of row.companyMatches) {
    const record = data.files[match.name + '/' + core.WINDOW_FILES.all].records.find(r => r.slug === row.slug);
    assert.equal(match.frequency, record.frequency); assert.equal(match.rank, record.rank);
  }
  const all = core.targetQuestions(data, { ...options, topics: ['Array','Hash Table'], topicMatch: 'all' });
  assert.ok(all.questions.length > 0);
  assert.ok(all.questions.every(row => ['Array','Hash Table'].every(t => row.topics.includes(t))));
  const chosen = result.questions[0].slug;
  const status = core.targetQuestions(data, {...options, completionFilter:'solved'}, {state:'ready',completed:{[chosen]:true}});
  assert.deepEqual(status.questions.map(r => r.slug), [chosen]);
  const state={}, service=collection.create({get:async()=>state,set:async value=>Object.assign(state,value)});
  const saved=await service.save({...result,context:options});
  const clone=await service.clone(saved.id,'Combined prep copy',saved.revision);
  assert.deepEqual(clone.context.companies, options.companies);
  assert.deepEqual(clone.context.topics, options.topics); assert.equal(clone.context.difficulty,'Easy,Medium');
  assert.deepEqual(clone.questions,saved.questions);
  assert.match(collection.csv(clone), /Microsoft:|Google:/);
});

test('difficulty combinations work in problem and company lists; invalid multi filters reject before reading data', async () => {
  for (const query of [core.searchProblems, core.practiceQuestions]) {
    const result=query(data,{company:'Microsoft',difficulty:'Easy,Medium',limit:100});
    const rows=result.questions || result.problems;
    assert.ok(rows.length);assert.ok(rows.every(row=>['Easy','Medium'].includes(row.difficulty)));
  }
  let reads=0;
  const service=sync.createSyncService({storage:{get:async()=>{reads++;return {lctData:data};},set:async()=>{}},fetch:async()=>{throw new Error('No network');}});
  for (const bad of [{companies:'Google'}, {companies:['']}, {companies:Array(501).fill('Google')}, {company:42}, {difficulty:'Easy,Impossible'}]) await assert.rejects(service.getTarget(bad));
  assert.equal(reads,0);
});
