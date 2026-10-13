(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const completion = globalThis.LCTCompletion;
  if (!api?.runtime || !completion || globalThis.__companyLensCompletionBridgeActive) return;
  globalThis.__companyLensCompletionBridgeActive = true;
  let queue = Promise.resolve();

  async function check(slugs, catalog) {
    const site = completion.officialOrigin(location.href);
    if (!site) return { ok: true, state: 'unavailable', site: null, username: null, completed: {} };
    const payload = catalog ? completion.buildSnapshotQuery() : completion.buildQuery(slugs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), completion.FETCH_TIMEOUT_MS);
    try {
      // Browser-managed same-origin credentials retain the tab's existing
      // account/container. This never reads cookies, tokens, code or solutions.
      const response = await fetch(site + '/graphql/', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok || completion.officialOrigin(location.href) !== site) throw new Error('Completion unavailable.');
      const raw = await response.json();
      if (completion.officialOrigin(location.href) !== site) throw new Error('Completion unavailable.');
      return { ok: true, site, ...(catalog ? completion.parseSnapshotResponse(raw) : completion.parseBridgeResponse(raw, slugs)) };
    } catch (_) {
      return { ok: true, state: 'unavailable', site, username: null, completed: {} };
    } finally { clearTimeout(timer); }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!['LCT_COMPLETION_QUERY', 'LCT_COMPLETION_SNAPSHOT_QUERY'].includes(message?.type) ||
        !completion.isBackgroundSender(sender, api.runtime)) return false;
    const catalog = message.type === 'LCT_COMPLETION_SNAPSHOT_QUERY';
    let slugs;
    try { slugs = catalog ? [] : completion.validateSlugs(message.slugs, completion.BATCH_SIZE); }
    catch (_) {
      sendResponse({ ok: false, error: 'Invalid completion problems.' });
      return false;
    }
    const task = queue.then(() => check(slugs, catalog));
    queue = task.catch(() => {});
    task.then(sendResponse, () => sendResponse({ ok: true, state: 'unavailable', site: null, username: null, completed: {} }));
    return true;
  });
})();
