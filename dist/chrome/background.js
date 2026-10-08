/* global LCTCore, LCTSync, LCTSeed */
'use strict';

if (typeof importScripts === 'function' && typeof LCTSync === 'undefined') {
  importScripts('core.js', 'archive.js', 'seed.js', 'sync.js');
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

  async function boot() {
    await service.initialize();
    if (!(await api.alarms.get(DAILY_ALARM))) {
      await api.alarms.create(DAILY_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
    }
    await service.startAutomatic();
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== api.runtime.id) return false;
    if (!message || !['LCT_GET', 'LCT_STATUS', 'LCT_REFRESH', 'LCT_PRACTICE'].includes(message.type)) return false;
    (async () => {
      if (message.type === 'LCT_REFRESH') return { ok: true, status: await service.refresh() };
      if (message.type === 'LCT_GET') {
        const companies = await service.getCompanies(message.slug, message.window);
        const available = await service.windowAvailable(message.window);
        return { ok: true, companies, available, windowAvailable: available, status: await service.getStatus() };
      }
      if (message.type === 'LCT_PRACTICE') return Object.assign({ ok: true, status: await service.getStatus() }, await service.getPractice(message));
      return { ok: true, status: await service.getStatus() };
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || 'Could not read company data.' }));
    return true;
  });

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DAILY_ALARM) service.refresh().catch(console.error);
    if (alarm.name === RESUME_ALARM) service.resume().catch(console.error);
  });
  api.runtime.onInstalled.addListener(() => { boot().catch(console.error); });
  api.runtime.onStartup.addListener(() => { boot().catch(console.error); });
  boot().catch(console.error);
})();
