const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const EXTENSION_ID = 'company-lens-test';

function harness({ openPopup = () => Promise.resolve(), actionAvailable = true, chrome = false, createTab } = {}) {
  const calls = { createdTabs: [], openPopup: [], initialize: 0, automatic: 0, lookup: 0, storage: 0, fetch: 0, tabs: 0 };
  let listener;
  const fail = (name) => () => { calls[name] += 1; throw new Error('Unexpected ' + name + ' work.'); };
  const api = {
    runtime: {
      id: EXTENSION_ID, getURL: (file) => 'chrome-extension://' + EXTENSION_ID + '/' + file,
      onMessage: { addListener: (handler) => { listener = handler; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} }
    },
    // Deliberately leave startup pending. Opening the popup must succeed even
    // when initialization has not begun and no cache/network work can finish.
    alarms: { get: () => new Promise(() => {}), create() {}, clear() {}, onAlarm: { addListener() {} } },
    storage: { local: { get: fail('storage') } },
    tabs: { create: createTab ? (options) => { calls.tabs++; calls.createdTabs.push(structuredClone(options)); return createTab(options); } : fail('tabs') }
  };
  if (actionAvailable) api.action = {
    openPopup: typeof openPopup === 'function' ? (options) => {
      calls.openPopup.push(structuredClone(options));
      return openPopup(options);
    } : openPopup
  };
  const context = {
    [chrome ? 'chrome' : 'browser']: api,
    LCTSync: { DAY: 24 * 60 * 60 * 1000, createSyncService: () => ({
      initialize: fail('initialize'), startAutomatic: fail('automatic'),
      getStatus: fail('initialize'), refresh: fail('initialize'), resume: fail('initialize')
    }) },
    LCTCore: require('../extension/core.js'),
    LCTLookup: { readStatus: fail('lookup'), readProblem: fail('lookup') },
    LCTSeed: { loadBundledSnapshot: fail('storage') },
    fetch: fail('fetch'), URL, URLSearchParams, console: { error() {} }
  };
  vm.runInNewContext(source, context, { filename: 'background.js' });
  assert.equal(typeof listener, 'function');
  return {
    calls,
    dispatch(message, sender) {
      const replies = [];
      let respond;
      const response = new Promise((resolve) => { respond = resolve; });
      const accepted = listener(message, sender, (result) => {
        const copy = structuredClone(result);
        replies.push(copy);
        respond(copy);
      });
      return { accepted, response, replies };
    }
  };
}

function sender(url = 'https://leetcode.com/problems/two-sum/', windowId = 7) {
  return { id: EXTENSION_ID, url, origin: new URL(url).origin, tab: { id: 19, windowId } };
}

function noDataWork(calls) {
  for (const name of ['initialize', 'automatic', 'lookup', 'storage', 'fetch', 'tabs']) {
    assert.equal(calls[name], 0, 'Native opening must not perform ' + name + ' work.');
  }
}

test('native popup is invoked synchronously in the sender window and replies only after success', async () => {
  let finish;
  const fixture = harness({ openPopup: () => new Promise((resolve) => { finish = resolve; }) });
  const route = fixture.dispatch({ type: 'LCT_OPEN_POPUP', windowId: 999 }, sender());
  assert.equal(route.accepted, true, 'Keep the response channel open for the native API promise.');
  assert.deepEqual(fixture.calls.openPopup, [{ windowId: 7 }], 'Ignore message-supplied window IDs.');
  assert.deepEqual(route.replies, [], 'Do not announce success before native opening fulfills.');
  noDataWork(fixture.calls);
  finish();
  assert.deepEqual(await route.response, { ok: true });
  assert.equal(route.replies.length, 1);
  noDataWork(fixture.calls);
});

test('native popup supports both browser namespaces and the authorized HTTPS LeetCode origins', async () => {
  for (const chrome of [false, true]) for (const host of ['leetcode.com', 'www.leetcode.com', 'leetcode.cn', 'www.leetcode.cn']) {
    const fixture = harness({ chrome });
    const trusted = sender('https://' + host + '/contest/weekly-contest-400/problems/two-sum/', 0);
    delete trusted.origin; // Firefox/Chrome sender metadata may omit this field.
    const route = fixture.dispatch({ type: 'LCT_OPEN_POPUP' }, trusted);
    assert.equal(route.accepted, true);
    assert.deepEqual(fixture.calls.openPopup, [{ windowId: 0 }]);
    assert.deepEqual(await route.response, { ok: true });
    noDataWork(fixture.calls);
  }
});

test('native popup rejects unrelated, spoofed, or malformed senders before calling the API', () => {
  const invalid = [
    undefined,
    { ...sender(), id: 'another-extension' },
    sender('https://example.com/problems/two-sum/'),
    sender('https://leetcode.com.evil.example/problems/two-sum/'),
    sender('http://leetcode.com/problems/two-sum/'),
    sender('https://leetcode.com:8443/problems/two-sum/'),
    sender('https://user:pass@leetcode.com/problems/two-sum/'),
    sender('chrome-extension://company-lens-test/popup.html'),
    { ...sender(), origin: 'https://example.com' },
    { ...sender(), url: 'invalid-url' },
    { ...sender(), url: undefined },
    { ...sender(), tab: undefined },
    ...[-1, 1.5, '7', null, undefined].map((windowId) => ({ ...sender(), tab: { windowId } }))
  ];
  const fixture = harness();
  for (const untrusted of invalid) {
    const route = fixture.dispatch({ type: 'LCT_OPEN_POPUP' }, untrusted);
    assert.equal(route.accepted, false);
    assert.deepEqual(route.replies, []);
  }
  assert.deepEqual(fixture.calls.openPopup, []);
  noDataWork(fixture.calls);
});

test('missing or unsupported native popup API returns toolbar guidance without opening another page', async () => {
  for (const options of [{ actionAvailable: false }, { openPopup: false }, { openPopup: null }]) {
    const fixture = harness(options);
    const route = fixture.dispatch({ type: 'LCT_OPEN_POPUP' }, sender());
    assert.equal(route.accepted, true);
    const response = await route.response;
    assert.equal(response.ok, false);
    assert.match(response.error, /cannot open the toolbar popup.*Click Company Lens in the browser toolbar/);
    assert.deepEqual(fixture.calls.openPopup, []);
    noDataWork(fixture.calls);
  }
});

test('native rejection and synchronous errors return useful failures with no cache or explorer fallback', async () => {
  for (const [openPopup, expectedDetail] of [
    [() => Promise.reject(new Error('User gesture required')), 'User gesture required'],
    [() => { throw new Error('Window is not focused'); }, 'Window is not focused'],
    [() => Promise.reject(null), null]
  ]) {
    const fixture = harness({ openPopup });
    const route = fixture.dispatch({ type: 'LCT_OPEN_POPUP' }, sender());
    assert.equal(route.accepted, true);
    assert.deepEqual(fixture.calls.openPopup, [{ windowId: 7 }]);
    const response = await route.response;
    assert.equal(response.ok, false);
    assert.match(response.error, /Could not open the toolbar popup.*Click Company Lens in the browser toolbar/);
    if (expectedDetail) assert.ok(response.error.includes(expectedDetail));
    assert.equal(route.replies.length, 1);
    noDataWork(fixture.calls);
  }
});

test('unknown messages and unauthorized extension senders remain ignored', () => {
  const fixture = harness();
  for (const message of [null, {}, { type: 'UNRELATED' }]) {
    assert.equal(fixture.dispatch(message, sender()).accepted, false);
  }
  assert.equal(fixture.dispatch({ type: 'LCT_OPEN_EXPLORER' }, { ...sender(), id: 'another-extension' }).accepted, false);
  assert.deepEqual(fixture.calls.openPopup, []);
  noDataWork(fixture.calls);
});


test('problem Explorer opens an active tab in the sender window before startup/data work finishes', async () => {
  let finish;
  const fixture = harness({ actionAvailable: false, createTab: () => new Promise(resolve => { finish = resolve; }) });
  const route = fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', mode: 'problems', slug: 'two-sum', windowId: 999 }, sender());
  assert.equal(route.accepted, true);
  assert.deepEqual(fixture.calls.createdTabs, [{
    url: 'chrome-extension://company-lens-test/explore.html?mode=problems&query=&slug=two-sum',
    active: true, windowId: 7
  }], 'Use only browser-supplied window details and a local extension URL.');
  assert.deepEqual(route.replies, [], 'Success must wait for tab creation.');
  assert.deepEqual(fixture.calls.openPopup, []);
  noDataWork({ ...fixture.calls, tabs: 0 });
  finish({ id: 21 });
  assert.deepEqual(await route.response, { ok: true });
  assert.equal(route.replies.length, 1);
  noDataWork({ ...fixture.calls, tabs: 0 });
});

test('ordinary Explorer search routes retain encoded mode/query without a problem deep link', async () => {
  for (const chrome of [false, true]) {
    const fixture = harness({ chrome, createTab: () => Promise.resolve({ id: 21 }) });
    const trusted = { id: EXTENSION_ID, url: 'chrome-extension://company-lens-test/popup.html' };
    const route = fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', mode: 'companies', query: 'Acko & Co', windowId: 999 }, trusted);
    assert.deepEqual(await route.response, { ok: true });
    const [options] = fixture.calls.createdTabs;
    const url = new URL(options.url);
    assert.equal(url.pathname, '/explore.html');
    assert.equal(url.searchParams.get('mode'), 'companies');
    assert.equal(url.searchParams.get('query'), 'Acko & Co');
    assert.equal(url.searchParams.has('slug'), false);
    assert.equal(options.active, true);
    assert.equal(Object.hasOwn(options, 'windowId'), false);
    assert.deepEqual(fixture.calls.openPopup, []);
    noDataWork({ ...fixture.calls, tabs: 0 });
  }
});

test('invalid problem deep links cannot create a tab or trigger data work', async () => {
  const invalid = [
    ...['', '../two-sum', 'two-sum?mode=companies', 'Two-Sum', 'a'.repeat(201), null, 2, []].map(slug => ({ type: 'LCT_OPEN_EXPLORER', slug })),
    { type: 'LCT_OPEN_EXPLORER', mode: 'companies', slug: 'two-sum' },
    { type: 'LCT_OPEN_EXPLORER', mode: 'invalid', slug: 'two-sum' },
    { type: 'LCT_OPEN_EXPLORER', query: {}, slug: 'two-sum' }
  ];
  const fixture = harness({ createTab: () => Promise.resolve({ id: 21 }) });
  for (const message of invalid) {
    const route = fixture.dispatch(message, sender());
    assert.equal(route.accepted, true);
    const response = await route.response;
    assert.equal(response.ok, false);
    assert.match(response.error, /Invalid explorer/);
  }
  assert.deepEqual(fixture.calls.createdTabs, []);
  assert.deepEqual(fixture.calls.openPopup, []);
  noDataWork(fixture.calls);
});

test('Explorer tab creation failures return an error without falling back to the native popup', async () => {
  for (const createTab of [
    () => Promise.reject(new Error('Tab creation failed')),
    () => { throw new Error('Tab creation failed'); }
  ]) {
    const fixture = harness({ createTab });
    const route = fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', slug: 'two-sum' }, sender());
    const response = await route.response;
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Tab creation failed');
    assert.equal(route.replies.length, 1);
    assert.deepEqual(fixture.calls.openPopup, []);
    assert.equal(fixture.calls.tabs, 1);
    noDataWork({ ...fixture.calls, tabs: 0 });
  }
});


test('company practice expansion preserves encoded filters and sort in a local active Explorer tab', async () => {
  for (const chrome of [false, true]) {
    const fixture = harness({ chrome, createTab: () => Promise.resolve({ id: 21 }) });
    const options = { mode: 'companies', company: 'A&B / Labs #1', window: '3m', difficulty: 'Medium', topic: 'Array & String', sort: 'name-desc' };
    const route = fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', ...options, windowId: 999 }, sender());
    assert.deepEqual(await route.response, { ok: true });
    const [tab] = fixture.calls.createdTabs, url = new URL(tab.url);
    assert.equal(url.origin, 'null'); // Node treats the extension scheme as an opaque origin.
    assert.equal(url.protocol, 'chrome-extension:');
    assert.equal(url.host, EXTENSION_ID);
    assert.equal(url.pathname, '/explore.html');
    assert.equal(url.hash, '');
    assert.equal(url.searchParams.get('query'), '');
    assert.equal(url.searchParams.has('slug'), false);
    for (const [key, value] of Object.entries(options)) assert.equal(url.searchParams.get(key), value);
    assert.equal(tab.active, true);
    assert.equal(tab.windowId, 7);
    assert.deepEqual(fixture.calls.openPopup, []);
    noDataWork({ ...fixture.calls, tabs: 0 });
  }
});

test('company deep links support stored preferences when optional context is omitted', async () => {
  const fixture = harness({ createTab: () => Promise.resolve({ id: 21 }) });
  const route = fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', mode: 'companies', company: 'Uber' }, sender());
  assert.deepEqual(await route.response, { ok: true });
  const url = new URL(fixture.calls.createdTabs[0].url);
  assert.equal(url.searchParams.get('company'), 'Uber');
  for (const key of ['window', 'difficulty', 'topic', 'sort']) assert.equal(url.searchParams.has(key), false);
  noDataWork({ ...fixture.calls, tabs: 0 });
});

test('invalid or ambiguous company practice routes cannot create a tab or touch data', async () => {
  const base = { type: 'LCT_OPEN_EXPLORER', mode: 'companies', company: 'Uber' };
  const invalid = [
    ...['', ' ', ' Uber', 'Uber ', 'a'.repeat(201), null, 2, []].map(company => ({ ...base, company })),
    { ...base, mode: 'problems' }, { ...base, slug: 'two-sum' },
    ...['recent', '__proto__', null, 3, {}].map(window => ({ ...base, window })),
    ...['medium', 'Impossible', null, 3, {}].map(difficulty => ({ ...base, difficulty })),
    ...['a'.repeat(201), null, 3, {}].map(topic => ({ ...base, topic })),
    ...['questions-desc', 'relevance', null, 3, {}].map(sort => ({ ...base, sort })),
    ...['window', 'difficulty', 'topic', 'sort'].map(key => ({ type: 'LCT_OPEN_EXPLORER', [key]: '' }))
  ];
  const fixture = harness({ createTab: () => Promise.resolve({ id: 21 }) });
  for (const message of invalid) {
    const route = fixture.dispatch(message, sender());
    assert.equal(route.accepted, true);
    const response = await route.response;
    assert.equal(response.ok, false);
    assert.match(response.error, /Invalid explorer/);
    assert.equal(route.replies.length, 1);
  }
  assert.deepEqual(fixture.calls.createdTabs, []);
  assert.deepEqual(fixture.calls.openPopup, []);
  noDataWork(fixture.calls);
});
