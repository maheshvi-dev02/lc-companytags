const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompletionService } = require('../extension/completion.js');
const sender = { tab: { id: 1, windowId: 1, incognito: false } };
function fixture() {
  const state = { account: 'alpha', statuses: { 'two-sum': 'ac', 'add-two-numbers': null }, available: [], error: false };
  const calls = [];
  const service = createCompletionService({ tabs: { query: async () => state.available,
    sendMessage: async () => { throw new Error('No tab should be needed.'); } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(url, 'https://leetcode.com/graphql/'); assert.equal(options.credentials, 'include');
      assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
      if (state.error) throw new Error('Unavailable');
      const query = JSON.parse(options.body);
      assert.deepEqual(query.variables, {});
      const data = { userStatus: { isSignedIn: Boolean(state.account), username: state.account } };
      if (query.operationName === 'CompanyLensCompletionCatalog') data.allQuestions = Object.entries(state.statuses).map(([titleSlug, status]) => ({ titleSlug, status }));
      else assert.equal(query.operationName, 'CompanyLensCompletion');
      return { ok: true, json: async () => ({ data }) };
    } });
  return { state, calls, service };
}
test('background completion reads never-visited problems with no LeetCode tabs and reuses a session-verified catalog', async () => {
  const { service, calls, state } = fixture();
  const first = await service.get(['two-sum', 'add-two-numbers', 'missing-problem'], sender);
  assert.equal(first.state, 'ready');
  assert.deepEqual(first.completed, { 'two-sum': true, 'add-two-numbers': false, 'missing-problem': null });
  const next = await service.get(['two-sum'], sender);
  assert.equal(next.sessionKey, first.sessionKey); assert.equal(calls.length, 3);
  state.statuses['add-two-numbers'] = 'ac';
  assert.equal((await service.get(['add-two-numbers'], sender, { force: true })).completed['add-two-numbers'], true);
  assert.equal(calls.length, 5);
});
test('direct account changes, sign-out and failures cannot reuse another account progress', async () => {
  const { service, state } = fixture();
  const first = await service.get(['two-sum'], sender);
  state.account = 'beta'; state.statuses['two-sum'] = null;
  const changed = await service.get(['two-sum'], sender);
  assert.notEqual(changed.sessionKey, first.sessionKey); assert.equal(changed.completed['two-sum'], false);
  state.account = null;
  const signedOut = await service.get(['two-sum'], sender);
  assert.equal(signedOut.state, 'signed-out'); assert.deepEqual(signedOut.completed, {});
  state.account = 'alpha'; state.error = true;
  const failed = await service.get(['two-sum'], sender);
  assert.equal(failed.state, 'unavailable'); assert.deepEqual(failed.completed, {});
});
test('parallel direct readers share catalog work and reject invalid inputs before any request', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.get(['bad slug'], sender));
  await assert.rejects(service.get(['two-sum'], sender, { force: 'yes' })); assert.equal(calls.length, 0);
  const results = await Promise.all([service.get(['two-sum'], sender), service.get(['add-two-numbers'], sender)]);
  assert.equal(results[0].sessionKey, results[1].sessionKey);
  assert.equal(calls.filter(call => JSON.parse(call.options.body).operationName === 'CompanyLensCompletionCatalog').length, 1);
});
test('container and private sessions stay on their own tab rather than using the default background session', async () => {
  for (const extra of [{ cookieStoreId: 'firefox-container-1' }, { incognito: true }]) {
    const tab = { id: 15, windowId: 1, url: 'https://leetcode.com/', incognito: false, ...extra };
    let direct = 0;
    const service = createCompletionService({ fetch: async () => { direct++; throw new Error('Wrong cookie store'); },
      tabs: { query: async () => [tab], sendMessage: async id => {
        assert.equal(id, 15); return { ok: true, site: 'https://leetcode.com', state: 'ready', username: 'container-user', completed: { 'two-sum': true } };
      } } });
    const result = await service.get(['two-sum'], { tab });
    assert.equal(result.completed['two-sum'], true); assert.equal(direct, 0);
  }
});
test('failed direct requests can use any same-store LeetCode tab without visiting the requested problem', async () => {
  let bridged = 0;
  const service = createCompletionService({ fetch: async () => ({ ok: false }),
    tabs: { query: async () => [{ id: 12, incognito: false, url: 'https://leetcode.com/discuss/' }], sendMessage: async (id, message) => {
      assert.equal(id, 12); bridged++; return { ok: true, site: 'https://leetcode.com', state: 'ready', username: 'alpha', completed: message.type.includes('SNAPSHOT') ? { 'two-sum': true } : {} };
    } } });
  assert.equal((await service.get(['two-sum'], sender)).completed['two-sum'], true); assert.equal(bridged, 2);
});
