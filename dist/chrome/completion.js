(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.LCTCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LCTCompletion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const ORIGINS = Object.freeze(['https://leetcode.com', 'https://www.leetcode.com', 'https://leetcode.cn', 'https://www.leetcode.cn']);
  const MATCHES = Object.freeze(ORIGINS.map((origin) => origin + '/*'));
  const BATCH_SIZE = 25;
  const FETCH_TIMEOUT_MS = 12000;
  const RESPONSE_TIMEOUT_MS = 13000;
  const OVERALL_TIMEOUT_MS = 20000;

  function validateSlugs(slugs, maximum = 100) {
    if (!Array.isArray(slugs) || slugs.length > maximum) throw new Error('Invalid completion problems.');
    const unique = new Set();
    for (const slug of slugs) {
      if (typeof slug !== 'string' || slug.length > 200 || !core.SLUG_PATTERN.test(slug)) throw new Error('Invalid completion problem slug.');
      unique.add(slug);
    }
    return Array.from(unique);
  }

  function officialOrigin(value) {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.port && ORIGINS.includes(url.origin) ? url.origin : null;
    } catch (_) { return null; }
  }

  function isExplorerSender(sender, runtime) {
    if (!sender || sender.id !== runtime.id || typeof sender.url !== 'string') return false;
    try {
      const actual = new URL(sender.url), expected = new URL(runtime.getURL('explore.html'));
      return !actual.username && !actual.password && actual.protocol === expected.protocol &&
        actual.host === expected.host && actual.pathname === expected.pathname &&
        (sender.origin === undefined || sender.origin === expected.protocol + '//' + expected.host || sender.origin === expected.origin);
    } catch (_) { return false; }
  }

  function isBackgroundSender(sender, runtime) {
    if (!sender || sender.id !== runtime.id || sender.tab) return false;
    const backgroundURL = new URL(runtime.getURL('background.js'));
    if (sender.origin !== undefined && sender.origin !== backgroundURL.protocol + '//' + backgroundURL.host &&
        sender.origin !== backgroundURL.origin) return false;
    const known = [backgroundURL.href, runtime.getURL('_generated_background_page.html')];
    // Service workers can omit their URL. Document-based callers always carry
    // a URL; do not accept a URL-less document as a background worker.
    if (sender.url === undefined) return sender.documentId === undefined;
    return known.includes(sender.url);
  }

  function buildQuery(slugs) {
    const requested = validateSlugs(slugs, BATCH_SIZE);
    const variables = {}, declarations = [], aliases = [];
    requested.forEach((slug, index) => {
      variables['s' + index] = slug;
      declarations.push('$s' + index + ': String!');
      aliases.push('q' + index + ': question(titleSlug: $s' + index + ') { titleSlug status }');
    });
    return { operationName: 'CompanyLensCompletion', variables,
      query: 'query CompanyLensCompletion' + (declarations.length ? '(' + declarations.join(', ') + ')' : '') +
        ' { userStatus { isSignedIn username } ' + aliases.join(' ') + ' }' };
  }

  function validUsername(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim();
  }

  function unavailableBridge() { return { state: 'unavailable', username: null, completed: {} }; }

  function parseBridgeResponse(raw, slugs) {
    const requested = validateSlugs(slugs, BATCH_SIZE);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        (raw.errors !== undefined && (!Array.isArray(raw.errors) || raw.errors.length))) return unavailableBridge();
    const data = raw.data;
    const user = data && typeof data === 'object' && !Array.isArray(data) && data.userStatus;
    if (!user || typeof user !== 'object' || typeof user.isSignedIn !== 'boolean') return unavailableBridge();
    if (!user.isSignedIn) return { state: 'signed-out', username: null, completed: {} };
    if (!validUsername(user.username)) return unavailableBridge();
    const completed = {};
    requested.forEach((slug, index) => {
      const question = Object.hasOwn(data, 'q' + index) ? data['q' + index] : null;
      let value = null;
      if (question && typeof question === 'object' && !Array.isArray(question) && question.titleSlug === slug && Object.hasOwn(question, 'status')) {
        if (question.status === null) value = false;
        else if (typeof question.status === 'string') {
          const status = question.status.toLowerCase();
          if (status === 'ac') value = true;
          else if (status === 'notac') value = false;
        }
      }
      completed[slug] = value;
    });
    return { state: 'ready', username: user.username, completed };
  }

  function result(state, site = null) {
    const messages = {
      'signed-out': 'Sign in to LeetCode in an open tab to show completed problems.',
      'no-tab': 'Open a signed-in LeetCode tab to check completed problems.',
      unavailable: 'Could not check completed problems. Refresh your LeetCode tab after updating the extension, then try again.'
    };
    return { ok: true, state, sessionKey: null, site, completed: {}, ...(messages[state] ? { message: messages[state] } : {}) };
  }

  function createCompletionService(options) {
    const tabs = options.tabs;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : RESPONSE_TIMEOUT_MS;
    const overallTimeoutMs = Number.isFinite(options.overallTimeoutMs) && options.overallTimeoutMs > 0 ? options.overallTimeoutMs : OVERALL_TIMEOUT_MS;
    let requestQueue = Promise.resolve();

    function bounded(promise, duration) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Completion request timed out.')), Math.max(0, duration));
        Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); },
          (error) => { clearTimeout(timer); reject(error); });
      });
    }

    function request(tab, slugs, deadline) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };
        const timer = setTimeout(() => finish(reject, new Error('Completion request timed out.')),
          Math.max(0, Math.min(timeoutMs, deadline - Date.now())));
        const actual = requestQueue.then(() => {
          if (settled || Date.now() >= deadline) {
            finish(reject, new Error('Completion request timed out.'));
            return null;
          }
          return tabs.sendMessage(tab.id, { type: 'LCT_COMPLETION_QUERY', slugs }, { frameId: 0 });
        });
        // A caller timeout never unlocks the actual transport. Wait for the
        // browser message to settle, and skip queued callers that expired.
        requestQueue = actual.catch(() => {});
        actual.then((value) => finish(resolve, value), (error) => finish(reject, error));
      });
    }

    function chooseTab(candidates, sender) {
      const source = sender?.tab;
      const incognito = typeof source?.incognito === 'boolean' ? source.incognito : options.incognito === true;
      const eligible = Array.isArray(candidates) ? candidates.filter((tab) => tab && Number.isInteger(tab.id) && tab.id >= 0 &&
        !tab.discarded && (tab.incognito === true) === incognito && officialOrigin(tab.url)) : [];
      const usedAt = (tab) => typeof tab.lastAccessed === 'number' && Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0;
      eligible.sort((a, b) => Number(b.windowId === source?.windowId) - Number(a.windowId === source?.windowId) ||
        Number(b.active === true) - Number(a.active === true) || usedAt(b) - usedAt(a) || b.id - a.id);
      return eligible[0] || null;
    }

    async function get(slugs, sender) {
      const requested = validateSlugs(slugs);
      const deadline = Date.now() + overallTimeoutMs;
      let tab;
      try { tab = chooseTab(await bounded(tabs.query({ url: MATCHES.slice() }), deadline - Date.now()), sender); }
      catch (_) { return result('unavailable'); }
      if (!tab) return result('no-tab');
      const site = officialOrigin(tab.url);
      const chunks = requested.length ? Array.from({ length: Math.ceil(requested.length / BATCH_SIZE) }, (_, index) =>
        requested.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE)) : [[]];
      const completed = {};
      let sessionKey = null;
      for (const chunk of chunks) {
        if (Date.now() >= deadline) return result('unavailable', site);
        let reply;
        try { reply = await request(tab, chunk, deadline); }
        catch (_) { return result('unavailable', site); }
        if (Date.now() >= deadline || !reply || reply.ok !== true || reply.site !== site) return result('unavailable', site);
        if (reply.state === 'signed-out') return result('signed-out', site);
        if (reply.state !== 'ready' || !validUsername(reply.username) || !reply.completed ||
            typeof reply.completed !== 'object' || Array.isArray(reply.completed)) return result('unavailable', site);
        const key = JSON.stringify([site, tab.id, typeof tab.cookieStoreId === 'string' ? tab.cookieStoreId : null,
          tab.incognito === true, reply.username]);
        if (sessionKey !== null && key !== sessionKey) return result('unavailable', site);
        sessionKey = key;
        for (const slug of chunk) {
          const value = Object.hasOwn(reply.completed, slug) ? reply.completed[slug] : null;
          completed[slug] = value === true || value === false ? value : null;
        }
      }
      return { ok: true, state: 'ready', sessionKey, site, completed };
    }

    return { get };
  }

  return { ORIGINS, BATCH_SIZE, FETCH_TIMEOUT_MS, RESPONSE_TIMEOUT_MS, OVERALL_TIMEOUT_MS, validateSlugs, officialOrigin, isExplorerSender,
    isBackgroundSender, buildQuery, parseBridgeResponse, createCompletionService };
});
