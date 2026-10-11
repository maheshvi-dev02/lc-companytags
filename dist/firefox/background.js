/* global LCTCore, LCTSync, LCTSeed, LCTLookup */
'use strict';

if (typeof importScripts === 'function' && typeof LCTSync === 'undefined') {
  importScripts('core.js', 'archive.js', 'seed.js', 'lookup.js', 'sync.js');
}

(function () {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const DAILY_ALARM = 'lct-daily-sync';
  const RESUME_ALARM = 'lct-resume-sync';
  const service = LCTSync.createSyncService({
    storage: api.storage.local,
    fetch: globalThis.fetch.bind(globalThis),
    loadSnapshot: () => LCTSeed.loadBundledSnapshot({ url: api.runtime.getURL('data/snapshot.json.gz') }),
    onPending: async (hasPending) => {
      if (hasPending) await api.alarms.create(RESUME_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
      else await api.alarms.clear(RESUME_ALARM);
    },
    onError: (error) => console.error('LeetCode Company Tags storage/snapshot error:', error.message)
  });

  async function boot(force = false) {
    if (!(await api.alarms.get(DAILY_ALARM))) {
      await api.alarms.create(DAILY_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
    }
    if (!force) {
      const status = await LCTLookup.readStatus(api.storage.local);
      if (status) {
        const checked = Date.parse(status.lastCheckedAt || '');
        const needsRefresh = status.acceptanceVersion !== LCTCore.ACCEPTANCE_VERSION || status.dataSource === 'bundled' || status.phase === 'syncing' ||
          !Number.isFinite(checked) || Date.now() - checked >= LCTSync.DAY;
        if (needsRefresh && !(await api.alarms.get(RESUME_ALARM))) {
          // Leave existing alarm deadlines untouched. The normal resume path
          // applies persisted retry budgets and GitHub rate-limit deadlines.
          await api.alarms.create(RESUME_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
        }
        return;
      }
    }
    await service.initialize();
    await service.startAutomatic();
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== api.runtime.id) return false;
    if (!message || !['LCT_GET', 'LCT_STATUS', 'LCT_REFRESH', 'LCT_PRACTICE', 'LCT_SEARCH_PROBLEMS',
      'LCT_SEARCH_COMPANIES', 'LCT_OPEN_EXPLORER', 'LCT_OPEN_POPUP'].includes(message.type)) return false;
    if (message.type === 'LCT_OPEN_POPUP') {
      // Use browser-supplied sender details, never a window or origin from the
      // message. Only our content script on an authorized LeetCode page may
      // open the native popup in that page's browser window.
      let page;
      try { page = new URL(sender.url); } catch { return false; }
      if (!['https://leetcode.com', 'https://www.leetcode.com', 'https://leetcode.cn',
        'https://www.leetcode.cn'].includes(page.origin) || page.username || page.password ||
        (sender.origin !== undefined && sender.origin !== page.origin) ||
        !Number.isInteger(sender.tab?.windowId) || sender.tab.windowId < 0) return false;
    }
    (async () => {
      if (message.type === 'LCT_OPEN_POPUP') {
        if (typeof api.action?.openPopup !== 'function') {
          throw new Error('This browser cannot open the toolbar popup from the page. Click Company Lens in the browser toolbar.');
        }
        // Invoke before any cache, network, or asynchronous preparation. Older
        // Firefox versions may reject this call when messaging loses a gesture.
        try { await api.action.openPopup({ windowId: sender.tab.windowId }); }
        catch (error) {
          const detail = error?.message ? ' (' + error.message + ')' : '';
          throw new Error('Could not open the toolbar popup' + detail + '. Click Company Lens in the browser toolbar.');
        }
        return { ok: true };
      }
      if (message.type === 'LCT_OPEN_EXPLORER') {
        const mode = message.mode === undefined ? 'problems' : message.mode;
        const query = message.query === undefined ? '' : message.query;
        if (!['problems', 'companies'].includes(mode) || typeof query !== 'string' || query.length > 200) throw new Error('Invalid explorer selection.');
        const slug = message.slug;
        if (slug !== undefined && (mode !== 'problems' || typeof slug !== 'string' || slug.length > 200 || slug !== slug.trim() || !LCTCore.SLUG_PATTERN.test(slug))) throw new Error('Invalid explorer problem.');
        const params = new URLSearchParams({ mode, query });
        if (slug !== undefined) params.set('slug', slug);
        const tab = { url: api.runtime.getURL('explore.html') + '?' + params.toString(), active: true };
        // Keep the full page in the browser window that requested it. Never use
        // a caller-supplied window ID.
        if (Number.isInteger(sender.tab?.windowId) && sender.tab.windowId >= 0) tab.windowId = sender.tab.windowId;
        await api.tabs.create(tab);
        return { ok: true };
      }
      if (message.type === 'LCT_REFRESH') return { ok: true, status: await service.refresh() };
      if (message.type === 'LCT_GET') {
        const compact = await LCTLookup.readProblem(api.storage.local, message.slug, message.window);
        if (compact) return compact;
        const companies = await service.getCompanies(message.slug, message.window);
        const available = await service.windowAvailable(message.window);
        return { ok: true, problem: await service.getProblem(message.slug), companies, available, windowAvailable: available, status: await service.getStatus() };
      }
      if (message.type === 'LCT_PRACTICE') return Object.assign({ ok: true, status: await service.getStatus() }, await service.getPractice(message));
      if (message.type === 'LCT_SEARCH_PROBLEMS') return Object.assign({ ok: true }, await service.searchProblems(message), { status: await service.getStatus() });
      if (message.type === 'LCT_SEARCH_COMPANIES') return Object.assign({ ok: true }, await service.searchCompanies(message), { status: await service.getStatus() });
      return { ok: true, status: await LCTLookup.readStatus(api.storage.local) || await service.getStatus() };
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || 'Could not read company data.' }));
    return true;
  });

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DAILY_ALARM) service.refresh().catch(console.error);
    if (alarm.name === RESUME_ALARM) service.resume().catch(console.error);
  });
  api.runtime.onInstalled.addListener(() => { boot(true).catch(console.error); });
  api.runtime.onStartup.addListener(() => { boot(true).catch(console.error); });
  boot().catch(console.error);
})();
