const test = require('node:test');
const assert = require('node:assert/strict');
const completion = require('../extension/completion.js');

const slugs = (count) => Array.from({ length: count }, (_, index) => `problem-${index}`);
const sender = (overrides = {}) => ({ id: 'company-lens', url: 'chrome-extension://company-lens/explore.html',
  tab: { id: 99, windowId: 7, incognito: false, ...overrides } });
const tab = (overrides = {}) => ({ id: 11, windowId: 7, incognito: false, active: true,
  lastAccessed: 100, url: 'https://leetcode.com/problems/two-sum/', ...overrides });
const runtime = { id: 'company-lens', getURL: (file) => `chrome-extension://company-lens/${file}` };
const plainCompleted = (result) => ({ ...result.completed });

function rawResponse(requested, statuses, { signedIn = true, username = 'mahesh', errors } = {}) {
  const data = { userStatus: { isSignedIn: signedIn, username } };
  requested.forEach((slug, index) => { data[`q${index}`] = { titleSlug: slug, status: statuses[index] }; });
  return { data, ...(errors === undefined ? {} : { errors }) };
}
function bridgeReply(requested, { state = 'ready', username = 'mahesh', value = true, site = 'https://leetcode.com' } = {}) {
  return { ok: true, state, username, site, completed: Object.fromEntries(requested.map((slug, index) =>
    [slug, typeof value === 'function' ? value(slug, index) : value])) };
}
function harness({ available = [tab()], handler, timeoutMs = 1000, overallTimeoutMs, snapshotTTL, now } = {}) {
  const handle = handler || ((id, message) => bridgeReply(message.slugs, { site: new URL(available.find((candidate) => candidate.id === id).url).origin }));
  const calls = { queries: [], messages: [], active: 0, maxActive: 0 };
  const tabs = {
    async query(options) { calls.queries.push(structuredClone(options)); return structuredClone(available); },
    async sendMessage(id, message, options) {
      calls.messages.push({ id, message: structuredClone(message), options: structuredClone(options) });
      calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
      try { return await handle(id, message, options, calls.messages.length - 1); }
      finally { calls.active--; }
    }
  };
  return { calls, service: completion.createCompletionService({ tabs, runtime, timeoutMs, overallTimeoutMs, snapshotTTL, now }) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected controlled asynchronous operation did not begin.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
function assertNoValues(result, state) {
  assert.equal(result.state, state);
  assert.deepEqual(plainCompleted(result), {});
  if (Object.hasOwn(result, 'sessionKey')) assert.equal(result.sessionKey, null);
}

test('completion slugs are copied and deduplicated while preserving valid strict identifiers', () => {
  const input = ['two-sum', 'valid-parentheses', 'two-sum', '1-test'];
  assert.deepEqual(completion.validateSlugs(input), ['two-sum', 'valid-parentheses', '1-test']);
  assert.deepEqual(input, ['two-sum', 'valid-parentheses', 'two-sum', '1-test']);
  assert.deepEqual(completion.validateSlugs([]), []);
  assert.equal(completion.validateSlugs(slugs(100)).length, 100);
  assert.equal(completion.validateSlugs(['a'.repeat(200)])[0].length, 200);
});

test('malformed completion identifiers and raw arrays above the limit are rejected', () => {
  for (const value of [undefined, null, false, 0, 'two-sum', {}, new Set(['two-sum'])]) {
    assert.throws(() => completion.validateSlugs(value), /slug|request|array|problem/i);
  }
  for (const value of ['', ' ', 'Two-Sum', 'two_sum', '-two', 'two-', 'two--sum', 'two sum',
    'https://leetcode.com/problems/two-sum/', 'a'.repeat(201), null, false, 1, {}, []]) {
    assert.throws(() => completion.validateSlugs([value]), /slug|request|problem/i);
  }
  assert.throws(() => completion.validateSlugs(Array(1)), /slug|request|problem/i);
  assert.throws(() => completion.validateSlugs(slugs(101)), /limit|100|many|slug|request|problem/i);
  assert.throws(() => completion.validateSlugs(Array(101).fill('two-sum')), /limit|100|many|slug|request|problem/i,
    'Raw input bounds apply before deduplication.');
  assert.throws(() => completion.validateSlugs(slugs(26), 25), /limit|25|many|slug|request|problem/i);
});

test('the fixed status query uses variables, aliases, and only identity and question-status fields', () => {
  const built = completion.buildQuery(['two-sum', 'valid-parentheses']);
  assert.equal(built.operationName, 'CompanyLensCompletion');
  assert.deepEqual(built.variables, { s0: 'two-sum', s1: 'valid-parentheses' });
  assert.match(built.query, /\$s0\s*:\s*String!/);
  assert.match(built.query, /\$s1\s*:\s*String!/);
  assert.match(built.query, /userStatus\s*\{\s*isSignedIn\s+username\s*\}/);
  assert.match(built.query, /q0\s*:\s*question\s*\(\s*titleSlug\s*:\s*\$s0\s*\)\s*\{\s*titleSlug\s+status\s*\}/);
  assert.match(built.query, /q1\s*:\s*question\s*\(\s*titleSlug\s*:\s*\$s1\s*\)\s*\{\s*titleSlug\s+status\s*\}/);
  assert.equal(built.query.includes('two-sum'), false);
  assert.equal(built.query.includes('valid-parentheses'), false);
  assert.doesNotMatch(built.query, /mutation|submission|solution|code|cookie|token|csrf/i);
  assert.throws(() => completion.buildQuery(slugs(26)), /limit|25|many|slug|request|problem/i);
});

test('an empty status request builds an identity-only query', () => {
  const built = completion.buildQuery([]);
  assert.equal(built.operationName, 'CompanyLensCompletion');
  assert.deepEqual(built.variables, {});
  assert.match(built.query, /userStatus\s*\{\s*isSignedIn\s+username\s*\}/);
  assert.doesNotMatch(built.query, /question\s*\(|\$s\d|q\d\s*:/);
});

test('signed-in parsing distinguishes accepted, not accepted, explicit null and unknown status', () => {
  const requested = slugs(8);
  const result = completion.parseBridgeResponse(rawResponse(requested,
    ['ac', 'AC', 'notac', 'NOTAC', null, 'NOT_STARTED', 'wa', true]), requested);
  assert.equal(result.state, 'ready');
  assert.equal(result.username, 'mahesh');
  assert.deepEqual(plainCompleted(result), Object.fromEntries(requested.map((slug, index) =>
    [slug, [true, true, false, false, false, null, null, null][index]])));
});

test('missing, malformed and mismatched alias records remain unknown rather than unsolved', () => {
  const requested = slugs(7);
  const raw = rawResponse(requested, ['ac', 'ac', 'ac', 'ac', 'ac', 'ac', 'ac']);
  delete raw.data.q0;
  raw.data.q1 = null;
  raw.data.q2 = { titleSlug: requested[2] };
  raw.data.q3 = { titleSlug: 'another-problem', status: 'ac' };
  raw.data.q4 = { status: null };
  raw.data.q5 = { titleSlug: requested[5], status: { status: 'ac' } };
  raw.data.q6 = [];
  const result = completion.parseBridgeResponse(raw, requested);
  assert.equal(result.state, 'ready');
  assert.deepEqual(plainCompleted(result), Object.fromEntries(requested.map((slug) => [slug, null])));
});

test('signed-out replies expose neither username nor per-problem values', () => {
  const result = completion.parseBridgeResponse(rawResponse(['two-sum'], ['ac'],
    { signedIn: false, username: 'previous-account' }), ['two-sum']);
  assertNoValues(result, 'signed-out');
  assert.equal(result.username, null);
});

test('GraphQL errors and invalid authentication cannot become completed or unsolved values', () => {
  const requested = ['two-sum'];
  const errors = rawResponse(requested, ['ac'], { errors: [{ message: 'Unavailable private submission body' }] });
  assertNoValues(completion.parseBridgeResponse(errors, requested), 'unavailable');
  for (const raw of [null, {}, { data: null }, { data: [] }, { data: {} }, { data: { userStatus: null } }]) {
    assertNoValues(completion.parseBridgeResponse(raw, requested), 'unavailable');
  }
  for (const signedIn of [undefined, null, 'true', 1, {}]) {
    const raw = rawResponse(requested, ['ac']);
    raw.data.userStatus.isSignedIn = signedIn;
    assertNoValues(completion.parseBridgeResponse(raw, requested), 'unavailable');
  }
  for (const username of ['', '   ', null, 1, {}, [], 'a'.repeat(201)]) {
    assertNoValues(completion.parseBridgeResponse(rawResponse(requested, ['ac'], { username }), requested), 'unavailable');
  }
});

test('parsed responses and identity-only replies contain no additional account or submission data', () => {
  const raw = rawResponse(['two-sum'], ['ac']);
  raw.data.userStatus.secret = 'private-cookie-value';
  raw.data.q0.solution = 'private-solution-body';
  const result = completion.parseBridgeResponse(raw, ['two-sum']);
  assert.deepEqual(Object.keys(result).sort(), ['completed', 'state', 'username']);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  const identity = completion.parseBridgeResponse(rawResponse([], []), []);
  assert.equal(identity.state, 'ready');
  assert.equal(identity.username, 'mahesh');
  assert.deepEqual(plainCompleted(identity), {});
});

test('completion service validates every requested slug before touching browser tabs', async () => {
  const { calls, service } = harness();
  for (const request of [null, 'two-sum', ['Two-Sum'], ['a'.repeat(201)], slugs(101), Array(101).fill('two-sum')]) {
    await assert.rejects(() => service.get(request, sender()), /slug|request|limit|100|many|array|problem/i);
  }
  assert.deepEqual(calls.queries, []);
  assert.deepEqual(calls.messages, []);
});

test('no matching LeetCode tab returns a clear state without sending any bridge message', async () => {
  const { calls, service } = harness({ available: [] });
  const result = await service.get(['two-sum'], sender());
  assert.equal(result.ok, true);
  assertNoValues(result, 'no-tab');
  assert.equal(calls.messages.length, 0);
  assert.deepEqual(new Set(calls.queries[0].url), new Set([
    'https://leetcode.com/*', 'https://www.leetcode.com/*', 'https://leetcode.cn/*', 'https://www.leetcode.cn/*'
  ]));
});

test('only exact HTTPS LeetCode origins without credentials or alternate ports can provide status', async () => {
  const invalid = ['http://leetcode.com/problems/two-sum/', 'https://leetcode.com.evil.test/',
    'https://evil.test/leetcode.com/', 'https://user@leetcode.com/', 'https://user:pass@leetcode.cn/',
    'https://leetcode.com:444/', 'ftp://leetcode.cn/', 'not a URL'];
  const { calls, service } = harness({ available: invalid.map((url, index) => tab({ id: index + 1, url })) });
  assertNoValues(await service.get(['two-sum'], sender()), 'no-tab');
  assert.equal(calls.messages.length, 0);
  for (const origin of ['https://leetcode.com', 'https://www.leetcode.com', 'https://leetcode.cn', 'https://www.leetcode.cn']) {
    const current = harness({ available: [tab({ url: origin + '/problemset/' })] });
    assert.equal((await current.service.get(['two-sum'], sender())).state, 'ready', origin);
    assert.equal(current.calls.messages[0].id, 11);
  }
});

test('tab selection favors the sender window and then active or most recently accessed tabs', async () => {
  const sameWindow = harness({ available: [tab({ id: 1, windowId: 8, active: true, lastAccessed: 999 }),
    tab({ id: 2, active: false, lastAccessed: 20 })] });
  await sameWindow.service.get(['two-sum'], sender());
  assert.equal(sameWindow.calls.messages[0].id, 2);
  const active = harness({ available: [tab({ id: 1, active: false, lastAccessed: 999 }),
    tab({ id: 2, active: true, lastAccessed: 1 })] });
  await active.service.get(['two-sum'], sender());
  assert.equal(active.calls.messages[0].id, 2);
  const recent = harness({ available: [tab({ id: 1, active: false, lastAccessed: 10 }),
    tab({ id: 2, active: false, lastAccessed: 20 })] });
  await recent.service.get(['two-sum'], sender());
  assert.equal(recent.calls.messages[0].id, 2);
});

test('completion reads never cross the sender private-browsing boundary', async () => {
  const ordinary = harness({ available: [tab({ id: 1, incognito: true }), tab({ id: 2, incognito: false, active: false })] });
  await ordinary.service.get(['two-sum'], sender());
  assert.equal(ordinary.calls.messages[0].id, 2);
  const privateWindow = harness({ available: [tab({ id: 1, incognito: false }), tab({ id: 2, incognito: true, active: false })] });
  await privateWindow.service.get(['two-sum'], sender({ incognito: true }));
  assert.equal(privateWindow.calls.messages[0].id, 2);
  const none = harness({ available: [tab({ incognito: true })] });
  assertNoValues(await none.service.get(['two-sum'], sender()), 'no-tab');
  assert.equal(none.calls.messages.length, 0);
});

test('session identity includes exact origin, tab, Firefox container, private mode and authenticated username', async () => {
  const { service } = harness({ available: [tab({ id: 23, url: 'https://www.leetcode.cn/problemset/',
    cookieStoreId: 'firefox-container-2', incognito: true })] });
  const result = await service.get(['two-sum'], sender({ incognito: true }));
  assert.equal(result.state, 'ready');
  assert.deepEqual(JSON.parse(result.sessionKey), ['https://www.leetcode.cn', 23, 'firefox-container-2', true, 'mahesh']);
  assert.match(result.site, /leetcode\.cn/);
});

test('large completion reads use deduplicated chunks of at most 25 in the top frame', async () => {
  const requested = slugs(61);
  const { calls, service } = harness();
  const result = await service.get([...requested, requested[0]], sender());
  assert.equal(result.state, 'ready');
  assert.equal(Object.keys(result.completed).length, 61);
  assert.deepEqual(calls.messages.map(({ message }) => message.slugs.length), [25, 25, 11]);
  assert.deepEqual(calls.messages.flatMap(({ message }) => message.slugs), requested);
  for (const call of calls.messages) {
    assert.deepEqual(Object.keys(call.message).sort(), ['slugs', 'type']);
    assert.equal(call.message.type, 'LCT_COMPLETION_QUERY');
    assert.deepEqual(call.options, { frameId: 0 });
  }
  assert.equal(calls.maxActive, 1);
});

test('empty completion reads still verify the account through one identity-only bridge request', async () => {
  const { calls, service } = harness();
  const result = await service.get([], sender());
  assert.equal(result.state, 'ready');
  assert.deepEqual(plainCompleted(result), {});
  assert.equal(calls.messages.length, 1);
  assert.deepEqual(calls.messages[0].message, { type: 'LCT_COMPLETION_QUERY', slugs: [] });
  assert.ok(result.sessionKey);
});

test('a signed-out bridge response removes identity and all completion values', async () => {
  const { service } = harness({ handler: () => bridgeReply(['two-sum'],
    { state: 'signed-out', username: null, value: true }) });
  assertNoValues(await service.get(['two-sum'], sender()), 'signed-out');
});

test('different identities across chunks discard all values instead of combining two accounts', async () => {
  const { calls, service } = harness({ handler: (id, message, options, index) =>
    bridgeReply(message.slugs, { username: index ? 'another-account' : 'mahesh' }) });
  const result = await service.get(slugs(26), sender());
  assertNoValues(result, 'unavailable');
  assert.equal(calls.messages.length, 2);
});

test('a failed or unsupported later chunk never publishes earlier partial completion data', async () => {
  for (const failure of [null, { ok: false }, { ok: true, state: 'unavailable' }, { ok: true, state: 'unsupported' }]) {
    const { service } = harness({ handler: (id, message, options, index) => index ? failure : bridgeReply(message.slugs) });
    assertNoValues(await service.get(slugs(26), sender()), 'unavailable');
  }
});

test('missing or non-boolean bridge values cannot become an accepted or unsolved mark', async () => {
  const { service } = harness({ handler: () => ({ ok: true, state: 'ready', username: 'mahesh', site: 'https://leetcode.com',
    completed: { 'two-sum': 'ac', 'valid-parentheses': 0 } }) });
  const result = await service.get(['two-sum', 'valid-parentheses', 'missing-status'], sender());
  if (result.state === 'ready') assert.deepEqual(plainCompleted(result), {
    'two-sum': null, 'valid-parentheses': null, 'missing-status': null
  });
  else assertNoValues(result, 'unavailable');
});

test('each successful read rechecks identity and status rather than reusing a completion cache', async () => {
  const { calls, service } = harness({ handler: (id, message, options, index) =>
    bridgeReply(message.slugs, { value: index === 0, username: index === 0 ? 'mahesh' : 'new-account' }) });
  const first = await service.get(['two-sum'], sender());
  const second = await service.get(['two-sum'], sender());
  assert.equal(first.completed['two-sum'], true);
  assert.equal(second.completed['two-sum'], false);
  assert.notEqual(first.sessionKey, second.sessionKey);
  assert.equal(calls.messages.length, 2);
  assert.equal(calls.queries.length, 2);
});

test('concurrent readers serialize actual bridge calls instead of racing account or status chunks', async () => {
  const gates = [deferred(), deferred()];
  const { calls, service } = harness({ handler: async (id, message, options, index) => {
    await gates[index].promise;
    return bridgeReply(message.slugs);
  } });
  const first = service.get(['two-sum'], sender());
  await until(() => calls.messages.length === 1);
  const second = service.get(['valid-parentheses'], sender());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.messages.length, 1);
  gates[0].resolve();
  await until(() => calls.messages.length === 2);
  gates[1].resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.state === 'ready'));
  assert.equal(calls.maxActive, 1);
});

test('a timed-out bridge remains serialized until its actual browser call settles', async () => {
  const gate = deferred();
  const { calls, service } = harness({ timeoutMs: 20, handler: async (id, message, options, index) => {
    if (index === 0) await gate.promise;
    return bridgeReply(message.slugs);
  } });
  const first = await service.get(['two-sum'], sender());
  assertNoValues(first, 'unavailable');
  const second = await service.get(['valid-parentheses'], sender());
  assertNoValues(second, 'unavailable');
  assert.equal(calls.messages.length, 1, 'Timeout cannot cancel the underlying tabs.sendMessage promise.');
  gate.resolve();
  await until(() => calls.active === 0);
  const third = await service.get(['two-sum'], sender());
  assert.equal(third.state, 'ready');
  assert.equal(calls.maxActive, 1);
});

test('tab and bridge failures return unavailable without publishing submission or secret data', async () => {
  const failure = harness({ handler: async () => { throw new Error('Browser bridge failed'); } });
  const result = await failure.service.get(['two-sum'], sender());
  assertNoValues(result, 'unavailable');
  assert.equal(JSON.stringify(result).includes('query'), false);
  assert.equal(JSON.stringify(result).includes('variables'), false);
  assert.equal(JSON.stringify(result).includes('username'), false);
  assert.equal(Object.hasOwn(result, 'cookies'), false);
  assert.equal(Object.hasOwn(result, 'tokens'), false);
  assert.equal(Object.hasOwn(result, 'submissions'), false);
});


test('a bridge navigation or missing origin cannot attach another site account to the selected tab', async () => {
  for (const site of [undefined, null, 'https://leetcode.cn', 'https://leetcode.com.evil.test', 'http://leetcode.com']) {
    const { service } = harness({ handler: (id, message) => {
      const reply = bridgeReply(message.slugs);
      reply.site = site;
      return reply;
    } });
    assertNoValues(await service.get(['two-sum'], sender()), 'unavailable');
  }
});

test('completion replies contain only requested own keys, including legitimate constructor slugs', async () => {
  const { service } = harness({ handler: (id, message) => ({ ...bridgeReply(message.slugs),
    completed: { 'two-sum': true, constructor: false, 'unrequested-problem': true } }) });
  const result = await service.get(['two-sum', 'constructor'], sender());
  assert.equal(result.state, 'ready');
  assert.deepEqual(plainCompleted(result), { 'two-sum': true, constructor: false });
  assert.equal(Object.hasOwn(result.completed, 'unrequested-problem'), false);
  const raw = rawResponse(['constructor'], ['ac']);
  assert.equal(completion.parseBridgeResponse(raw, ['constructor']).completed.constructor, true);
});


test('a sign-out between chunks clears all prior account values', async () => {
  const { service } = harness({ handler: (id, message, options, index) =>
    bridgeReply(message.slugs, index ? { state: 'signed-out', username: null } : {}) });
  const result = await service.get(slugs(26), sender());
  assert.ok(['signed-out', 'unavailable'].includes(result.state));
  assert.deepEqual(plainCompleted(result), {});
  assert.equal(result.sessionKey, null);
});

test('a rejected actual browser call does not poison the queue for later requests', async () => {
  const { service, calls } = harness({ handler: (id, message, options, index) => {
    if (index === 0) throw new Error('Tab disconnected');
    return bridgeReply(message.slugs);
  } });
  assertNoValues(await service.get(['two-sum'], sender()), 'unavailable');
  assert.equal((await service.get(['two-sum'], sender())).state, 'ready');
  assert.equal(calls.messages.length, 2);
  assert.equal(calls.maxActive, 1);
});

test('the overall deadline bounds tab lookup and never starts a late bridge request', async () => {
  const gate = deferred();
  const calls = [];
  const service = completion.createCompletionService({ runtime, timeoutMs: 1000, overallTimeoutMs: 20,
    tabs: { query: () => gate.promise, sendMessage: (id, message) => { calls.push(message); return Promise.resolve(bridgeReply(message.slugs)); } } });
  const result = await service.get(['two-sum'], sender());
  assertNoValues(result, 'unavailable');
  gate.resolve([tab()]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, []);
  assertNoValues(result, 'unavailable', 'Late lookup cannot modify a timed-out result.');
});

test('the overall deadline covers the whole chunk sequence and skips all remaining chunks', async () => {
  const gates = [deferred(), deferred()];
  const { calls, service } = harness({ timeoutMs: 1000, overallTimeoutMs: 50,
    handler: async (id, message, options, index) => {
      if (index < 2) await gates[index].promise;
      return bridgeReply(message.slugs);
    } });
  const pending = service.get(slugs(51), sender());
  await until(() => calls.messages.length === 1);
  gates[0].resolve();
  await until(() => calls.messages.length === 2);
  const result = await pending;
  assertNoValues(result, 'unavailable');
  assert.equal(calls.messages.length, 2);
  gates[1].resolve();
  await until(() => calls.active === 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.messages.length, 2, 'An expired read must never dispatch its final chunk.');
  assertNoValues(result, 'unavailable');
  assert.equal((await service.get(['two-sum'], sender())).state, 'ready');
});


function catalogRaw(questions, { signedIn = true, username = 'test-user', errors } = {}) {
  return { data: { userStatus: { isSignedIn: signedIn, username }, allQuestions: questions }, ...(errors === undefined ? {} : { errors }) };
}

test('the bulk catalog operation is fixed and requests only identity, slugs, and completion status', () => {
  assert.deepEqual(completion.buildSnapshotQuery(), {
    operationName: 'CompanyLensCompletionCatalog', variables: {},
    query: 'query CompanyLensCompletionCatalog { userStatus { isSignedIn username } allQuestions { titleSlug status } }'
  });
  assert.doesNotMatch(completion.buildSnapshotQuery().query, /mutation|submission|solution|cookie|token|csrf|code/i);
});

test('signed-in bulk catalog recognizes only verified solved and not-solved values, leaving missing or unknown data unknown', () => {
  const raw = catalogRaw([
    { titleSlug: 'accepted', status: 'ac' }, { titleSlug: 'accepted-upper', status: 'AC' },
    { titleSlug: 'attempted', status: 'notac' }, { titleSlug: 'not-started', status: 'NOT_STARTED' },
    { titleSlug: 'tried', status: 'TRIED' }, { titleSlug: 'null-status', status: null },
    { titleSlug: 'unknown', status: 'UNRECOGNIZED' }, { titleSlug: 'missing-status' },
    { titleSlug: 'numeric-status', status: 1 }, { titleSlug: 'constructor', status: 'ac' },
    { titleSlug: 'Invalid-Slug', status: 'ac' }, { titleSlug: '__proto__', status: 'ac' }, null
  ]);
  const result = completion.parseSnapshotResponse(raw);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.completed, { accepted: true, 'accepted-upper': true, attempted: false, 'not-started': false,
    tried: false, 'null-status': false, unknown: null, 'missing-status': null, 'numeric-status': null, constructor: true });
  assert.equal(Object.hasOwn(result.completed, 'absent-question'), false, 'Absent rows are unknown, never inferred not solved.');
  assert.equal(Object.hasOwn(result.completed, '__proto__'), false);
});

test('conflicting duplicate bulk rows remain unknown regardless of their order', () => {
  for (const values of [['ac', 'notac'], ['notac', 'ac'], ['ac', null], [null, 'ac'], ['ac', 'unexpected', 'ac']]) {
    const result = completion.parseSnapshotResponse(catalogRaw(values.map(status => ({ titleSlug: 'two-sum', status }))));
    assert.equal(result.completed['two-sum'], null);
  }
  assert.equal(completion.parseSnapshotResponse(catalogRaw([{ titleSlug: 'two-sum', status: 'ac' },
    { titleSlug: 'two-sum', status: 'AC' }])).completed['two-sum'], true);
});

test('anonymous or failed catalogs expose no account states and never turn anonymous defaults into not solved', () => {
  const questions = [{ titleSlug: 'two-sum', status: null }, { titleSlug: 'valid-parentheses', status: 'NOT_STARTED' }];
  assertNoValues(completion.parseSnapshotResponse(catalogRaw(questions, { signedIn: false, username: 'ignored-user' })), 'signed-out');
  for (const raw of [null, [], {}, { data: {} }, catalogRaw(questions, { username: '' }),
    catalogRaw(questions, { errors: [{ message: 'PRIVATE_DETAIL' }] }), catalogRaw(null), catalogRaw([]),
    catalogRaw(Array(25001).fill({ titleSlug: 'two-sum', status: 'ac' }))]) {
    const result = completion.parseSnapshotResponse(raw);
    assertNoValues(result, 'unavailable');
    assert.equal(JSON.stringify(result).includes('PRIVATE_DETAIL'), false);
  }
});

function snapshotHarness({ timeoutMs, overallTimeoutMs, now, available = [tab()], handler } = {}) {
  const state = { username: 'alpha-user', signedIn: true, completed: { 'two-sum': true, 'valid-parentheses': false }, fail: false };
  const fixture = harness({ available, timeoutMs, overallTimeoutMs, now, handler: async (id, message, options, index) => {
    if (handler) return handler(id, message, options, index, state);
    const site = new URL(available.find(item => item.id === id).url).origin;
    if (state.fail) throw new Error('PRIVATE_DETAIL');
    return { ok: true, site, state: state.signedIn ? 'ready' : 'signed-out', username: state.signedIn ? state.username : null,
      completed: message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY' ? { ...state.completed } : {} };
  } });
  return { ...fixture, state };
}

const catalogCalls = fixture => fixture.calls.messages.filter(call => call.message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY');
const probeCalls = fixture => fixture.calls.messages.filter(call => call.message.type === 'LCT_COMPLETION_QUERY');

test('snapshot reuse checks identity on every request without downloading the catalog again and keeps immutable revision data', async () => {
  const fixture = snapshotHarness();
  const first = await fixture.service.getSnapshot(sender());
  assert.equal(first.state, 'ready');
  assert.equal(typeof first.revision, 'string');
  assert.ok(first.revision);
  assert.equal(Number.isFinite(Date.parse(first.checkedAt)), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.completed), true);
  assert.deepEqual(first.completed, fixture.state.completed);
  const second = await fixture.service.getSnapshot(sender());
  assert.equal(second, first, 'All pages share one immutable snapshot until it changes.');
  assert.equal(probeCalls(fixture).length, 2);
  assert.equal(catalogCalls(fixture).length, 1);
  assert.deepEqual(catalogCalls(fixture)[0].message, { type: 'LCT_COMPLETION_SNAPSHOT_QUERY' });
  assert.deepEqual(catalogCalls(fixture)[0].options, { frameId: 0 });
  const visible = await fixture.service.get(['two-sum'], sender());
  assert.equal(visible.sessionKey, first.sessionKey, 'Visible checks and filtered queries use the same account fingerprint.');
});

test('force and expiration replace the catalog revision while an ordinary page retains its frozen membership', async () => {
  let clock = Date.parse('2026-10-13T12:00:00Z');
  const fixture = snapshotHarness({ now: () => clock });
  const first = await fixture.service.getSnapshot(sender());
  fixture.state.completed['valid-parentheses'] = true;
  const cached = await fixture.service.getSnapshot(sender());
  assert.equal(cached.completed['valid-parentheses'], false);
  assert.equal(cached.revision, first.revision);
  const forced = await fixture.service.getSnapshot(sender(), { force: true });
  assert.equal(forced.completed['valid-parentheses'], true);
  assert.notEqual(forced.revision, first.revision);
  clock += 60001;
  const expired = await fixture.service.getSnapshot(sender());
  assert.notEqual(expired.revision, forced.revision);
  assert.equal(catalogCalls(fixture).length, 3);
  assert.equal(first.completed['valid-parentheses'], false);
});

test('parallel topic pages coalesce their identity probe and catalog read', async () => {
  const gate = deferred();
  const fixture = snapshotHarness({ handler: async (_id, message, _options, _index, state) => {
    if (message.type === 'LCT_COMPLETION_QUERY') await gate.promise;
    return { ok: true, site: 'https://leetcode.com', state: 'ready', username: state.username,
      completed: message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY' ? { ...state.completed } : {} };
  } });
  const requests = Array.from({ length: 3 }, () => fixture.service.getSnapshot(sender(), { force: true }));
  await until(() => fixture.calls.messages.length === 1);
  gate.resolve();
  const results = await Promise.all(requests);
  assert.equal(probeCalls(fixture).length, 1);
  assert.equal(catalogCalls(fixture).length, 1);
  assert.equal(new Set(results.map(result => result.revision)).size, 1);
  assert.equal(fixture.calls.maxActive, 1);
});

test('changed account, sign-out, and failures clear snapshots instead of returning old progress', async () => {
  const fixture = snapshotHarness();
  const alpha = await fixture.service.getSnapshot(sender());
  fixture.state.username = 'beta-user';
  fixture.state.completed = { 'two-sum': false };
  const beta = await fixture.service.getSnapshot(sender());
  assert.notEqual(beta.sessionKey, alpha.sessionKey);
  assert.equal(beta.completed['two-sum'], false);
  fixture.state.signedIn = false;
  assertNoValues(await fixture.service.getSnapshot(sender()), 'signed-out');
  fixture.state.signedIn = true;
  fixture.state.fail = true;
  assertNoValues(await fixture.service.getSnapshot(sender()), 'unavailable');
  fixture.state.fail = false;
  const recovered = await fixture.service.getSnapshot(sender());
  assert.notEqual(recovered.revision, beta.revision);
  assert.equal(catalogCalls(fixture).length, 3);
});

test('a catalog account/site mismatch cannot publish a snapshot from a different session', async () => {
  for (const change of [{ username: 'another-account' }, { site: 'https://leetcode.cn' }]) {
    const fixture = snapshotHarness({ handler: async (_id, message) => ({ ok: true, state: 'ready', site: 'https://leetcode.com',
      username: 'alpha-user', completed: message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY' ? { 'two-sum': true } : {},
      ...(message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY' ? change : {}) }) });
    assertNoValues(await fixture.service.getSnapshot(sender()), 'unavailable');
  }
});

test('snapshot deadlines discard late catalogs and keep the real transport serialized until settlement', async () => {
  const gate = deferred();
  const fixture = snapshotHarness({ timeoutMs: 20, overallTimeoutMs: 50, handler: async (_id, message, _options, index) => {
    if (message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY' && index === 1) await gate.promise;
    return { ok: true, state: 'ready', site: 'https://leetcode.com', username: 'alpha-user',
      completed: message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY' ? { 'two-sum': true } : {} };
  } });
  assertNoValues(await fixture.service.getSnapshot(sender()), 'unavailable');
  const messagesAtTimeout = fixture.calls.messages.length;
  assertNoValues(await fixture.service.getSnapshot(sender()), 'unavailable');
  assert.equal(fixture.calls.messages.length, messagesAtTimeout, 'No new real query overlaps the stalled catalog.');
  gate.resolve();
  await until(() => fixture.calls.active === 0);
  const recovered = await fixture.service.getSnapshot(sender());
  assert.equal(recovered.state, 'ready');
  assert.equal(catalogCalls(fixture).length, 2, 'The late result was discarded, requiring a fresh catalog.');
  assert.equal(fixture.calls.maxActive, 1);
});

test('snapshot force options are validated before tab access', async () => {
  const fixture = snapshotHarness();
  for (const value of [null, false, 0, [], 'force']) await assert.rejects(fixture.service.getSnapshot(sender(), value), /refresh/i);
  for (const force of [null, 0, '', [], {}]) await assert.rejects(fixture.service.getSnapshot(sender(), { force }), /refresh/i);
  assert.equal(fixture.calls.queries.length, 0);
  assert.equal(fixture.calls.messages.length, 0);
});


test('an inherited completion deadline is validated and prevents expired account dispatch', async () => {
  const fixture = snapshotHarness();
  for (const deadlineAt of [null, 'soon', NaN, Infinity, false]) {
    await assert.rejects(fixture.service.getSnapshot(sender(), { deadlineAt }), /deadline/i);
  }
  assert.deepEqual(fixture.calls.queries, []);
  const expired = await fixture.service.getSnapshot(sender(), { deadlineAt: Date.now() - 1 });
  assertNoValues(expired, 'unavailable');
  assert.deepEqual(fixture.calls.queries, []);
  assert.deepEqual(fixture.calls.messages, []);
});
