const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const EXTENSION_ID = 'company-lens-test';

function harness({ openPopup = () => Promise.resolve(), actionAvailable = true, chrome = false, createTab, queryTabs, completionReply, querySource, completionDeadlineMs } = {}) {
  const calls = { queriedTabs: [], completionMessages: [], sourceQueries: [], status: 0, createdTabs: [], openPopup: [], initialize: 0, automatic: 0, lookup: 0, storage: 0, fetch: 0, tabs: 0 };
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
    tabs: {
      create: createTab ? (options) => { calls.tabs++; calls.createdTabs.push(structuredClone(options)); return createTab(options); } : fail('tabs'),
      query: async (options) => { calls.queriedTabs.push(structuredClone(options)); return queryTabs ? queryTabs(options) : []; },
      sendMessage: async (id, message, options) => {
        calls.completionMessages.push({ id, message: structuredClone(message), options: structuredClone(options) });
        return completionReply ? completionReply(id, message, options) : { ok: true, site: 'https://leetcode.com', state: 'ready',
          username: 'test-user', completed: Object.fromEntries(message.slugs.map(slug => [slug, true])) };
      }
    }
  };
  if (actionAvailable) api.action = {
    openPopup: typeof openPopup === 'function' ? (options) => {
      calls.openPopup.push(structuredClone(options));
      return openPopup(options);
    } : openPopup
  };
  const sourceQuery = async (options, snapshot) => {
    calls.sourceQueries.push({ options: structuredClone(options), snapshot });
    if (!querySource) throw new Error('Unexpected source query.');
    return querySource(options, snapshot);
  };
  const context = {
    [chrome ? 'chrome' : 'browser']: api,
    LCTSync: { DAY: 24 * 60 * 60 * 1000, createSyncService: () => ({
      initialize: fail('initialize'), startAutomatic: fail('automatic'),
      getStatus: querySource ? async () => { calls.status++; return { phase: 'ready', hasData: true }; } : fail('initialize'),
      searchProblems: sourceQuery, getPractice: sourceQuery, refresh: fail('initialize'), resume: fail('initialize')
    }) },
    LCTTargetCollection: require('../extension/target-collection.js'),
    LCTCore: require('../extension/core.js'),
    LCTCompletion: { ...require('../extension/completion.js'),
      createCompletionService: options => require('../extension/completion.js').createCompletionService({ ...options, fetch: undefined }),
      ...(completionDeadlineMs === undefined ? {} : { OVERALL_TIMEOUT_MS: completionDeadlineMs }) },
    LCTLookup: { readStatus: fail('lookup'), readProblem: fail('lookup') },
    LCTSeed: { loadBundledSnapshot: fail('storage') },
    fetch: fail('fetch'), URL, URLSearchParams, setTimeout, clearTimeout, console: { error() {} }
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
    ...['Easy,Impossible', 'Impossible', null, 3, {}].map(difficulty => ({ ...base, difficulty })),
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


function explorerSender(overrides = {}) {
  return { id: EXTENSION_ID, url: 'chrome-extension://' + EXTENSION_ID + '/explore.html?mode=companies&company=Alpha#questions',
    origin: 'chrome-extension://' + EXTENSION_ID, tab: { id: 20, windowId: 7, incognito: false }, ...overrides };
}

test('completion routing accepts the exact Explorer page including deep links and never initializes dataset or network', async () => {
  for (const chrome of [false, true]) {
    const fixture = harness({ chrome, queryTabs: () => [{ id: 51, windowId: 7, url: 'https://leetcode.com/problems/two-sum/' }] });
    const route = fixture.dispatch({ type: 'LCT_COMPLETION', slugs: ['two-sum', 'two-sum'], url: 'https://example.com/', tabId: 999 }, explorerSender());
    assert.equal(route.accepted, true);
    const response = await route.response;
    assert.equal(response.ok, true);
    assert.equal(response.state, 'ready');
    assert.deepEqual(response.completed, { 'two-sum': true });
    assert.equal(response.site, 'https://leetcode.com');
    assert.deepEqual(fixture.calls.completionMessages, [{ id: 51, message: { type: 'LCT_COMPLETION_QUERY', slugs: ['two-sum'] }, options: { frameId: 0 } }]);
    assert.equal(fixture.calls.queriedTabs.length, 1);
    noDataWork(fixture.calls);
  }
});

test('Target popup completion uses browser-verified window context and rejects invalid slugs first', async () => {
  for (const chrome of [false, true]) {
    const active = { id: 9, windowId: 7, incognito: false, url: 'https://example.com/' };
    const fixture = harness({ chrome, queryTabs: options => options.active ? [active] : [
      { id: 51, windowId: 7, incognito: false, url: 'https://leetcode.com/problems/two-sum/' },
      { id: 52, windowId: 8, incognito: true, url: 'https://leetcode.com/problems/two-sum/' }
    ] });
    const sender = explorerSender({ url: 'chrome-extension://' + EXTENSION_ID + '/popup.html', tab: undefined });
    const invalid = await fixture.dispatch({ type: 'LCT_COMPLETION', slugs: ['Invalid'] }, sender).response;
    assert.equal(invalid.ok, false); assert.deepEqual(fixture.calls.queriedTabs, []);
    const result = await fixture.dispatch({ type: 'LCT_COMPLETION', slugs: ['two-sum'], tabId: 52 }, sender).response;
    assert.equal(result.state, 'ready'); assert.deepEqual(result.completed, { 'two-sum': true });
    assert.deepEqual(fixture.calls.queriedTabs[0], { active: true, lastFocusedWindow: true });
    assert.equal(fixture.calls.completionMessages[0].id, 51); noDataWork(fixture.calls);
  }
});

test('completion routing rejects every unrelated document before tab or account access', () => {
  const fixture = harness();
  const invalid = [
    undefined,
    explorerSender({ id: 'another-extension' }),
    explorerSender({ url: 'https://leetcode.com/explore.html', origin: 'https://leetcode.com' }),
    explorerSender({ url: 'chrome-extension://' + EXTENSION_ID + '/folder/popup.html' }),
    explorerSender({ url: 'chrome-extension://' + EXTENSION_ID + '/folder/explore.html' }),
    explorerSender({ url: 'chrome-extension://' + EXTENSION_ID + '/explore.html/extra' }),
    explorerSender({ url: 'chrome-extension://another-extension/explore.html' }),
    explorerSender({ url: 'chrome-extension://user:pass@' + EXTENSION_ID + '/explore.html' }),
    explorerSender({ origin: 'https://example.com' }),
    explorerSender({ url: undefined })
  ];
  for (const caller of invalid) {
    const route = fixture.dispatch({ type: 'LCT_COMPLETION', slugs: ['two-sum'] }, caller);
    assert.equal(route.accepted, false);
    assert.deepEqual(route.replies, []);
  }
  assert.deepEqual(fixture.calls.queriedTabs, []);
  assert.deepEqual(fixture.calls.completionMessages, []);
  noDataWork(fixture.calls);
});

test('completion routing validates slug inputs before tab access and returns explicit no-tab guidance', async () => {
  const fixture = harness();
  for (const slugs of [undefined, null, 'two-sum', ['Two-Sum'], ['two-sum?query=x'], Array(101).fill('two-sum')]) {
    const route = fixture.dispatch({ type: 'LCT_COMPLETION', slugs }, explorerSender());
    const response = await route.response;
    assert.equal(response.ok, false);
    assert.match(response.error, /completion problem/i);
  }
  assert.deepEqual(fixture.calls.queriedTabs, []);
  const empty = await fixture.dispatch({ type: 'LCT_COMPLETION', slugs: [] }, explorerSender()).response;
  assert.equal(empty.state, 'no-tab');
  assert.equal(empty.sessionKey, null);
  assert.deepEqual(empty.completed, {});
  assert.match(empty.message, /Open a signed-in LeetCode tab/);
  assert.deepEqual(fixture.calls.completionMessages, []);
  noDataWork(fixture.calls);
});

const bridgeSource = readFileSync(path.join(__dirname, '../extension/completion-content.js'), 'utf8');
function bridgeHarness({ href = 'https://leetcode.com/problems/two-sum/', fetchReply, timeoutMs = 30 } = {}) {
  const completion = require('../extension/completion.js');
  let listener;
  const calls = [];
  const context = {
    chrome: { runtime: { id: EXTENSION_ID, getURL: (file) => 'chrome-extension://' + EXTENSION_ID + '/' + file,
      onMessage: { addListener: (handler) => { listener = handler; } } } },
    LCTCompletion: { ...completion, FETCH_TIMEOUT_MS: timeoutMs },
    location: { href }, URL, AbortController, setTimeout, clearTimeout,
    // The account bridge is independent of the inline bar's lifecycle/settings.
    __companyLensActive: true,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchReply) return fetchReply(url, options, context);
      return { ok: true, json: async () => ({ data: { userStatus: { isSignedIn: true, username: 'test-user' },
        q0: { titleSlug: 'two-sum', status: 'ac' }, q1: { titleSlug: 'valid-parentheses', status: null } } }) };
    }
  };
  Object.defineProperty(context, 'document', { get() { throw new Error('The bridge must not inspect page credentials or code.'); } });
  vm.runInNewContext(bridgeSource, context, { filename: 'completion-content.js' });
  assert.equal(typeof listener, 'function');
  return {
    calls, context,
    dispatch(slugs, sender = { id: EXTENSION_ID, url: 'chrome-extension://' + EXTENSION_ID + '/background.js' }, type = 'LCT_COMPLETION_QUERY') {
      let respond;
      const response = new Promise((resolve) => { respond = resolve; });
      const accepted = listener({ type, slugs }, sender, result => respond(structuredClone(result)));
      return { accepted, response };
    }
  };
}

test('independent content bridge sends only fixed same-origin credentialed read-only status queries', async () => {
  const fixture = bridgeHarness();
  const route = fixture.dispatch(['two-sum', 'valid-parentheses', 'two-sum']);
  assert.equal(route.accepted, true);
  const response = await route.response;
  assert.deepEqual(response, { ok: true, site: 'https://leetcode.com', state: 'ready', username: 'test-user',
    completed: { 'two-sum': true, 'valid-parentheses': false } });
  const [{ url, options }] = fixture.calls;
  assert.equal(url, 'https://leetcode.com/graphql/');
  assert.equal(new URL(url, 'https://unrelated.example/forged-base/').origin, 'https://leetcode.com',
    'A document base URL cannot redirect the fixed status request.');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.deepEqual({ ...options.headers }, { 'Content-Type': 'application/json' });
  const payload = JSON.parse(options.body);
  assert.deepEqual(payload.variables, { s0: 'two-sum', s1: 'valid-parentheses' });
  assert.equal(payload.operationName, 'CompanyLensCompletion');
  assert.doesNotMatch(payload.query, /mutation|submission|solution|cookie|token|csrf|code/i);
});

test('content bridge trusts only our background sender and validates identifiers before fetch', async () => {
  const fixture = bridgeHarness();
  for (const sender of [
    { id: 'another-extension' },
    { id: EXTENSION_ID, tab: { id: 1 } },
    { id: EXTENSION_ID, url: 'https://leetcode.com/problems/two-sum/' },
    { id: EXTENSION_ID, url: 'chrome-extension://' + EXTENSION_ID + '/explore.html' },
    { id: EXTENSION_ID, documentId: 'document-without-url' },
    { id: EXTENSION_ID, origin: 'https://example.com' }
  ]) assert.equal(fixture.dispatch(['two-sum'], sender).accepted, false);
  for (const slugs of [null, ['Two-Sum'], Array(26).fill('two-sum')]) {
    const rejected = fixture.dispatch(slugs);
    assert.equal(rejected.accepted, false);
    assert.equal((await rejected.response).ok, false);
  }
  assert.equal(fixture.calls.length, 0);
  const worker = fixture.dispatch([],{ id: EXTENSION_ID });
  assert.equal(worker.accepted, true);
  const response = await worker.response;
  assert.equal(response.state, 'ready');
  assert.deepEqual(response.completed, {});
  const payload = JSON.parse(fixture.calls[0].options.body);
  assert.deepEqual(payload.variables, {});
  assert.doesNotMatch(payload.query, /question\(/);
});

test('content bridge stays unknown on signed-out, malformed, failed, or cross-origin responses', async () => {
  for (const fetchReply of [
    async () => ({ ok: true, json: async () => ({ data: { userStatus: { isSignedIn: false, username: '' }, q0: { titleSlug: 'two-sum', status: 'ac' } } }) }),
    async () => ({ ok: true, json: async () => ({ errors: [{ message: 'PRIVATE_SERVER_DETAIL' }], data: null }) }),
    async () => ({ ok: false, json: async () => { throw new Error('Do not parse rejected requests.'); } }),
    async () => { throw new Error('PRIVATE_SERVER_DETAIL'); },
    async () => ({ ok: true, json: async () => { throw new Error('PRIVATE_SERVER_DETAIL'); } }),
    async (_url, _options, context) => { context.location.href = 'https://example.com/'; return { ok: true, json: async () => ({}) }; },
    async (_url, _options, context) => ({ ok: true, json: async () => {
      context.location.href = 'https://leetcode.cn/';
      return { data: { userStatus: { isSignedIn: true, username: 'test-user' }, q0: { titleSlug: 'two-sum', status: 'ac' } } };
    } })
  ]) {
    const fixture = bridgeHarness({ fetchReply });
    const response = await fixture.dispatch(['two-sum']).response;
    assert.ok(['signed-out', 'unavailable'].includes(response.state));
    assert.deepEqual(response.completed, {});
    assert.equal(response.username, null);
    assert.equal(JSON.stringify(response).includes('PRIVATE_SERVER_DETAIL'), false);
  }
  const invalidOrigin = bridgeHarness({ href: 'https://example.com/' });
  assert.equal((await invalidOrigin.dispatch(['two-sum']).response).state, 'unavailable');
  assert.equal(invalidOrigin.calls.length, 0);
});

test('content bridge serializes real fetches and aborts an expired request before starting another', async () => {
  let active = 0, maximum = 0;
  const fixture = bridgeHarness({ timeoutMs: 10, fetchReply: (_url, options) => {
    active++; maximum = Math.max(maximum, active);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      active--; reject(new Error('Aborted'));
    }, { once: true }));
  } });
  const first = fixture.dispatch(['two-sum']);
  const second = fixture.dispatch(['valid-parentheses']);
  const results = await Promise.all([first.response, second.response]);
  assert.equal(fixture.calls.length, 2);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  for (const result of results) {
    assert.equal(result.state, 'unavailable');
    assert.deepEqual(result.completed, {});
  }
  assert.equal(fixture.calls.every(({ options }) => options.signal.aborted), true);
});


function filteredSource(options, snapshot) {
  if (options.completionFilter !== undefined && !['all', 'solved', 'not-solved'].includes(options.completionFilter)) throw new Error('Invalid completion filter.');
  if (options.query !== undefined && typeof options.query !== 'string') throw new Error('Invalid search query.');
  const field = options.type === 'LCT_PRACTICE' ? 'questions' : 'problems';
  const candidates = ['two-sum', 'valid-parentheses', 'missing-from-catalog'];
  const response = { [field]: [], topics: ['Array', 'Stack'], topicGroups: [], total: 3,
    available: true, windowAvailable: true, sourceRevision: 'a'.repeat(40), hasMore: false };
  if (options.completionFilter === undefined || options.completionFilter === 'all') {
    response[field] = candidates.map(slug => ({ slug }));
    return response;
  }
  if (snapshot.state !== 'ready') return { ...response, total: null, completionUnknownCount: null };
  const wanted = options.completionFilter === 'solved';
  let unknown = 0;
  for (const slug of candidates) {
    const value = Object.hasOwn(snapshot.completed, slug) ? snapshot.completed[slug] : null;
    if (value !== true && value !== false) unknown++;
    else if (value === wanted) response[field].push({ slug, completed: value });
  }
  return { ...response, total: response[field].length, completionUnknownCount: unknown };
}
function snapshotReply(_id, message, _options) {
  return { ok: true, state: 'ready', site: 'https://leetcode.com', username: 'test-user',
    completed: message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY' ? { 'two-sum': true, 'valid-parentheses': false } : {} };
}
function popupSender(overrides = {}) {
  return { id: EXTENSION_ID, url: 'chrome-extension://' + EXTENSION_ID + '/popup.html?practice=1',
    origin: 'chrome-extension://' + EXTENSION_ID, ...overrides };
}
function statusTab(overrides = {}) {
  return { id: 51, windowId: 7, incognito: false, active: true, lastAccessed: 100,
    url: 'https://leetcode.com/problems/two-sum/', ...overrides };
}

test('All filters preserve source results without private tab, account, or catalog work', async () => {
  for (const type of ['LCT_SEARCH_PROBLEMS', 'LCT_PRACTICE']) for (const completionFilter of [undefined, 'all']) {
    const fixture = harness({ querySource: filteredSource });
    const message = { type, company: 'Alpha', completionFilter, refreshCompletion: true, completed: { 'two-sum': true } };
    const response = await fixture.dispatch(message, sender()).response;
    assert.equal(response.ok, true);
    assert.equal(response.total, 3);
    assert.equal(Object.hasOwn(response, 'completion'), false);
    assert.equal(fixture.calls.sourceQueries.length, 1);
    assert.equal(fixture.calls.sourceQueries[0].snapshot, undefined);
    assert.deepEqual(fixture.calls.queriedTabs, []);
    assert.deepEqual(fixture.calls.completionMessages, []);
    noDataWork(fixture.calls);
  }
});

test('refresh options and full source preflight reject malformed queries before account work', async () => {
  const fixture = harness({ querySource: filteredSource });
  for (const refreshCompletion of [null, 0, 'true', [], {}]) {
    const response = await fixture.dispatch({ type: 'LCT_SEARCH_PROBLEMS', completionFilter: 'solved', refreshCompletion }, explorerSender()).response;
    assert.equal(response.ok, false);
    assert.match(response.error, /completion refresh/i);
  }
  assert.equal(fixture.calls.sourceQueries.length, 0, 'Refresh validation must happen before storage-backed source validation.');
  for (const message of [
    { type: 'LCT_SEARCH_PROBLEMS', completionFilter: 'unsolved' },
    { type: 'LCT_SEARCH_PROBLEMS', completionFilter: 'solved', query: [] },
    { type: 'LCT_PRACTICE', completionFilter: 'not-solved', company: 'Alpha', query: false }
  ]) {
    assert.equal((await fixture.dispatch(message, explorerSender()).response).ok, false);
  }
  assert.equal(fixture.calls.sourceQueries.length, 3);
  assert.ok(fixture.calls.sourceQueries.every(call => call.snapshot.state === 'checking'));
  assert.deepEqual(fixture.calls.queriedTabs, []);
  assert.deepEqual(fixture.calls.completionMessages, []);
  noDataWork(fixture.calls);
});

test('filtered results authorize only the exact local Explorer or popup before private/source access', () => {
  const fixture = harness({ querySource: filteredSource });
  for (const caller of [
    sender(), explorerSender({ id: 'other' }), explorerSender({ url: 'chrome-extension://other/explore.html' }),
    explorerSender({ url: 'chrome-extension://' + EXTENSION_ID + '/folder/explore.html' }),
    popupSender({ url: 'https://leetcode.com/popup.html', origin: 'https://leetcode.com' }),
    popupSender({ origin: 'https://example.com' }), popupSender({ url: undefined })
  ]) for (const type of ['LCT_SEARCH_PROBLEMS', 'LCT_PRACTICE']) {
    assert.equal(fixture.dispatch({ type, company: 'Alpha', completionFilter: 'solved' }, caller).accepted, false);
  }
  assert.equal(fixture.calls.sourceQueries.length, 0);
  assert.deepEqual(fixture.calls.queriedTabs, []);
  noDataWork(fixture.calls);
});

test('unavailable company data keeps source metadata and skips all private account work', async () => {
  const fixture = harness({ querySource: (options, snapshot) => ({ ...filteredSource(options, snapshot),
    available: false, windowAvailable: false, topics: ['Array'] }) });
  const response = await fixture.dispatch({ type: 'LCT_SEARCH_PROBLEMS', completionFilter: 'not-solved', window: '3m' }, explorerSender()).response;
  assert.equal(response.ok, true);
  assert.equal(response.available, false);
  assert.equal(response.total, null);
  assert.deepEqual(response.topics, ['Array']);
  assert.deepEqual(response.problems, []);
  assert.equal(response.completion.state, 'unavailable');
  assert.equal(response.completion.unknownCount, null);
  assert.equal(response.completion.sessionKey, null);
  assert.deepEqual(fixture.calls.queriedTabs, []);
  assert.equal(fixture.calls.sourceQueries.length, 1);
});

test('filtered routes inject only verified snapshots and publish metadata without the full personal map', async () => {
  for (const type of ['LCT_SEARCH_PROBLEMS', 'LCT_PRACTICE']) {
    const fixture = harness({ querySource: filteredSource, queryTabs: () => [statusTab()], completionReply: snapshotReply });
    const callerMap = { 'two-sum': false, 'valid-parentheses': true, 'unrelated-private-question': true };
    const response = await fixture.dispatch({ type, company: 'Alpha', completionFilter: 'solved', completed: callerMap,
      sessionKey: 'forged', windowId: 999 }, explorerSender()).response;
    assert.equal(response.ok, true);
    assert.deepEqual(response[type === 'LCT_PRACTICE' ? 'questions' : 'problems'], [{ slug: 'two-sum', completed: true }]);
    assert.equal(response.total, 1);
    assert.equal(response.completion.state, 'ready');
    assert.equal(response.completion.unknownCount, 1);
    assert.match(response.completion.revision, /\S/);
    assert.equal(Number.isFinite(Date.parse(response.completion.checkedAt)), true);
    assert.equal(response.completion.site, 'https://leetcode.com');
    assert.equal(Object.hasOwn(response.completion, 'completed'), false);
    assert.equal(Object.hasOwn(response.completion, 'username'), false);
    assert.equal(JSON.stringify(response).includes('unrelated-private-question'), false);
    const [preflight, published] = fixture.calls.sourceQueries;
    assert.equal(preflight.snapshot.state, 'checking');
    assert.equal(published.snapshot.state, 'ready');
    assert.notDeepEqual(published.snapshot.completed, callerMap);
    assert.equal(Object.isFrozen(published.snapshot.completed), true);
    assert.deepEqual(fixture.calls.completionMessages.map(call => call.message), [
      { type: 'LCT_COMPLETION_QUERY', slugs: [] }, { type: 'LCT_COMPLETION_SNAPSHOT_QUERY' }
    ]);
    noDataWork(fixture.calls);
  }
});

test('filtered pages verify identity each time, reuse the same snapshot, and force a new revision only on refresh', async () => {
  const fixture = harness({ querySource: filteredSource, queryTabs: () => [statusTab()], completionReply: snapshotReply });
  const base = { type: 'LCT_SEARCH_PROBLEMS', completionFilter: 'solved' };
  const first = await fixture.dispatch(base, explorerSender()).response;
  const page = await fixture.dispatch({ ...base, offset: 50 }, explorerSender()).response;
  assert.equal(page.completion.revision, first.completion.revision);
  assert.equal(page.completion.sessionKey, first.completion.sessionKey);
  assert.equal(fixture.calls.completionMessages.filter(call => call.message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY').length, 1);
  assert.equal(fixture.calls.completionMessages.filter(call => call.message.type === 'LCT_COMPLETION_QUERY').length, 2);
  const fresh = await fixture.dispatch({ ...base, refreshCompletion: true }, explorerSender()).response;
  assert.notEqual(fresh.completion.revision, first.completion.revision);
  assert.equal(fixture.calls.completionMessages.filter(call => call.message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY').length, 2);
});

test('signed-out and missing-account routes retain a null total rather than claiming zero not-solved matches', async () => {
  for (const state of ['signed-out', 'no-tab', 'unavailable']) {
    const fixture = harness({ querySource: filteredSource,
      queryTabs: () => state === 'no-tab' ? [] : [statusTab()],
      completionReply: () => ({ ok: true, state, site: 'https://leetcode.com', username: null, completed: {} }) });
    const response = await fixture.dispatch({ type: 'LCT_PRACTICE', company: 'Alpha', completionFilter: 'not-solved' }, explorerSender()).response;
    assert.equal(response.ok, true);
    assert.equal(response.total, null);
    assert.equal(response.available, true);
    assert.deepEqual(response.questions, []);
    assert.deepEqual(response.topicGroups, []);
    assert.deepEqual(response.topics, ['Array', 'Stack']);
    assert.equal(response.completion.state, state);
    assert.equal(response.completion.sessionKey, null);
    assert.equal(response.completion.revision, null);
    assert.equal(response.completion.unknownCount, null);
  }
});

test('popup filtering uses trusted current-window and private-mode metadata even when active-tab host details are unavailable', async () => {
  for (const incognito of [false, true]) {
    const active = { id: 91, windowId: 42, incognito }; // URL is unavailable without that host's permission.
    const candidates = [statusTab({ id: 51, windowId: 7 }), statusTab({ id: 52, windowId: 42, incognito: true }),
      statusTab({ id: 53, windowId: 42, incognito: false })];
    const fixture = harness({ querySource: filteredSource, completionReply: snapshotReply,
      queryTabs: options => options.active ? [active] : candidates });
    const response = await fixture.dispatch({ type: 'LCT_PRACTICE', company: 'Alpha', completionFilter: 'solved',
      windowId: 7, incognito: !incognito }, popupSender()).response;
    assert.equal(response.completion.state, 'ready');
    assert.deepEqual(fixture.calls.queriedTabs[0], { active: true, lastFocusedWindow: true });
    assert.equal(fixture.calls.completionMessages[0].id, incognito ? 52 : 53);
    assert.equal(JSON.parse(response.completion.sessionKey)[3], incognito);
  }
});

test('missing, invalid, or rejected popup window metadata fails explicitly without guessing another account context', async () => {
  for (const active of [[], [{ id: 1 }], [{ id: 1, windowId: 7 }], [{ id: 1, windowId: 7, incognito: 'false' }],
    [{ id: -1, windowId: 7, incognito: false }], new Error('PRIVATE_LOOKUP_DETAIL')]) {
    const fixture = harness({ querySource: filteredSource, queryTabs: options => {
      if (options.active) { if (active instanceof Error) throw active; return active; }
      throw new Error('Must not query unrelated account tabs after losing popup context.');
    } });
    const response = await fixture.dispatch({ type: 'LCT_PRACTICE', company: 'Alpha', completionFilter: 'solved' }, popupSender()).response;
    assert.equal(response.total, null);
    assert.equal(response.completion.state, 'unavailable');
    assert.equal(response.completion.sessionKey, null);
    assert.equal(fixture.calls.queriedTabs.length, 1);
    assert.deepEqual(fixture.calls.completionMessages, []);
    assert.equal(JSON.stringify(response).includes('PRIVATE_LOOKUP_DETAIL'), false);
  }
});

test('company practice deep links preserve valid completion filters and reject invalid or non-company context', async () => {
  const fixture = harness({ createTab: () => Promise.resolve({ id: 21 }) });
  for (const completionFilter of ['all', 'solved', 'not-solved']) {
    const response = await fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', mode: 'companies', company: 'Alpha', completionFilter }, popupSender()).response;
    assert.equal(response.ok, true);
    assert.equal(new URL(fixture.calls.createdTabs.at(-1).url).searchParams.get('completionFilter'), completionFilter);
  }
  const count = fixture.calls.createdTabs.length;
  for (const completionFilter of ['', 'unsolved', null, false, [], {}]) {
    assert.equal((await fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', mode: 'companies', company: 'Alpha', completionFilter }, popupSender()).response).ok, false);
  }
  assert.equal((await fixture.dispatch({ type: 'LCT_OPEN_EXPLORER', mode: 'problems', completionFilter: 'solved' }, popupSender()).response).ok, false);
  assert.equal(fixture.calls.createdTabs.length, count);
});

test('catalog content bridge emits only the fixed account-status operation on the official current origin', async () => {
  for (const href of ['https://leetcode.com/problems/two-sum/', 'https://leetcode.cn/problemset/']) {
    const fixture = bridgeHarness({ href, fetchReply: async () => ({ ok: true, json: async () => ({ data: {
      userStatus: { isSignedIn: true, username: 'test-user' }, allQuestions: [
        { titleSlug: 'two-sum', status: 'AC' }, { titleSlug: 'valid-parentheses', status: null },
        { titleSlug: 'unknown-question', status: 'unexpected' }
      ], secret: 'PRIVATE_TOKEN_DATA' } }) }) });
    const response = await fixture.dispatch(['ignored-caller-slug'], undefined, 'LCT_COMPLETION_SNAPSHOT_QUERY').response;
    assert.deepEqual(response.completed, { 'two-sum': true, 'valid-parentheses': false, 'unknown-question': null });
    assert.equal(response.site, new URL(href).origin);
    assert.equal(JSON.stringify(response).includes('PRIVATE_TOKEN_DATA'), false);
    const [{ url, options }] = fixture.calls;
    assert.equal(url, new URL(href).origin + '/graphql/');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload, require('../extension/completion.js').buildSnapshotQuery());
    assert.doesNotMatch(payload.query, /mutation|submission|solution|cookie|token|csrf|code/i);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
  }
});

test('catalog bridge denies page callers and clears anonymous or cross-origin account results', async () => {
  const denied = bridgeHarness();
  for (const caller of [explorerSender(), popupSender(), sender(), { id: 'other' }]) {
    assert.equal(denied.dispatch([], caller, 'LCT_COMPLETION_SNAPSHOT_QUERY').accepted, false);
  }
  assert.equal(denied.calls.length, 0);
  for (const fetchReply of [
    async () => ({ ok: true, json: async () => ({ data: { userStatus: { isSignedIn: false, username: 'private-user' },
      allQuestions: [{ titleSlug: 'two-sum', status: null }] } }) }),
    async (_url, _options, context) => ({ ok: true, json: async () => {
      context.location.href = 'https://leetcode.cn/';
      return { data: { userStatus: { isSignedIn: true, username: 'private-user' }, allQuestions: [{ titleSlug: 'two-sum', status: 'ac' }] } };
    } })
  ]) {
    const fixture = bridgeHarness({ fetchReply });
    const response = await fixture.dispatch([], undefined, 'LCT_COMPLETION_SNAPSHOT_QUERY').response;
    assert.ok(['signed-out', 'unavailable'].includes(response.state));
    assert.equal(response.username, null);
    assert.deepEqual(response.completed, {});
  }
});


test('one completion deadline includes popup context lookup and expired context never dispatches an account request', async () => {
  let finish;
  const active = new Promise(resolve => { finish = resolve; });
  const fixture = harness({ querySource: filteredSource, completionDeadlineMs: 15,
    queryTabs: options => options.active ? active : [statusTab()] });
  const started = Date.now();
  const response = await fixture.dispatch({ type: 'LCT_PRACTICE', company: 'Alpha', completionFilter: 'solved' }, popupSender()).response;
  assert.equal(response.completion.state, 'unavailable');
  assert.equal(response.total, null);
  assert.ok(Date.now() - started < 250, 'A timed-out popup context must not start a fresh 20-second account budget.');
  assert.equal(fixture.calls.queriedTabs.length, 1);
  assert.deepEqual(fixture.calls.completionMessages, []);
  finish([{ id: 1, windowId: 7, incognito: false }]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fixture.calls.queriedTabs.length, 1, 'Late context metadata cannot revive a timed-out account request.');
  assert.deepEqual(fixture.calls.completionMessages, []);
});

test('Target collection messages reject content pages and unrelated senders before storage access', async () => {
  const fixture = harness();
  for (const type of ['LCT_TARGET_LIST', 'LCT_TARGET_SAVE', 'LCT_TARGET_REMOVE', 'LCT_TARGET_UPDATE', 'LCT_TARGET_CLONE']) {
    for (const caller of [sender(), { ...sender(), url: 'chrome-extension://' + EXTENSION_ID + '/other.html' }, { ...sender(), id: 'another-extension' }]) {
      assert.equal(fixture.dispatch({ type }, caller).accepted, false);
    }
  }
  noDataWork(fixture.calls);
});

test('cached completion is limited to extension interfaces and an empty cache needs no account request', async () => {
  const fixture = harness();
  for (const caller of [sender(), explorerSender({ id: 'other-extension' }), explorerSender({ url: 'https://leetcode.com/explore.html' })]) {
    assert.equal(fixture.dispatch({ type: 'LCT_COMPLETION_CACHED' }, caller).accepted, false);
  }
  assert.deepEqual(fixture.calls.queriedTabs, []);
  const result = await fixture.dispatch({ type: 'LCT_COMPLETION_CACHED' }, explorerSender()).response;
  assert.equal(result.state, 'empty'); assert.deepEqual(fixture.calls.completionMessages, []);
});
