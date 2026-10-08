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
        const needsRefresh = status.dataSource === 'bundled' || status.phase === 'syncing' ||
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
      'LCT_SEARCH_COMPANIES', 'LCT_OPEN_EXPLORER'].includes(message.type)) return false;
    (async () => {
      if (message.type === 'LCT_OPEN_EXPLORER') {
        const mode = message.mode === undefined ? 'problems' : message.mode;
        const query = message.query === undefined ? '' : message.query;
        if (!['problems', 'companies'].includes(mode) || typeof query !== 'string' || query.length > 200) throw new Error('Invalid explorer selection.');
        const params = new URLSearchParams({ mode, query });
        await api.tabs.create({ url: api.runtime.getURL('explore.html') + '?' + params.toString() });
        return { ok: true };
      }
      if (message.type === 'LCT_REFRESH') return { ok: true, status: await service.refresh() };
      if (message.type === 'LCT_GET') {
        const compact = await LCTLookup.readProblem(api.storage.local, message.slug, message.window);
        if (compact) return compact;
        const companies = await service.getCompanies(message.slug, message.window);
        const available = await service.windowAvailable(message.window);
        return { ok: true, companies, available, windowAvailable: available, status: await service.getStatus() };
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
