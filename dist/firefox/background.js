/* global LCTCore, LCTSync, LCTSeed, LCTLookup, LCTCompletion */
'use strict';

if (typeof importScripts === 'function' && typeof LCTSync === 'undefined') {
  importScripts('core.js', 'archive.js', 'seed.js', 'lookup.js', 'sync.js', 'completion.js', 'target-collection.js');
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

  const completionService = LCTCompletion.createCompletionService({ tabs: api.tabs, runtime: api.runtime,
    incognito: api.extension?.inIncognitoContext === true });

  const targetCollection = LCTTargetCollection.create(api.storage.local);

  const checkingCompletion = Object.freeze({ state: 'checking', sessionKey: null, revision: null, site: null,
    completed: Object.freeze({}) });

  function completionMetadata(snapshot, unknownCount) {
    const metadata = { state: snapshot.state, sessionKey: snapshot.sessionKey || null, revision: snapshot.revision || null,
      site: snapshot.site || null, unknownCount: Number.isInteger(unknownCount) && unknownCount >= 0 ? unknownCount : null };
    if (typeof snapshot.checkedAt === 'string') metadata.checkedAt = snapshot.checkedAt;
    if (typeof snapshot.message === 'string') metadata.message = snapshot.message;
    return metadata;
  }

  async function privateQuerySender(sender, deadlineAt) {
    if (Date.now() >= deadlineAt) throw new Error('Tab lookup timed out.');
    if (sender.tab || !new URL(sender.url).pathname.endsWith('/popup.html')) return sender;
    // A toolbar popup may not have sender.tab. Obtain its current window and
    // private-mode context from the browser rather than a caller-supplied ID.
    const active = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tab lookup timed out.')),
        Math.max(0, Math.min(LCTCompletion.RESPONSE_TIMEOUT_MS, deadlineAt - Date.now())));
      Promise.resolve().then(() => {
        if (Date.now() >= deadlineAt) throw new Error('Tab lookup timed out.');
        return api.tabs.query({ active: true, lastFocusedWindow: true });
      })
        .then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const tab = Array.isArray(active) && active.find(item => Number.isInteger(item?.id) && item.id >= 0 &&
      Number.isInteger(item.windowId) && typeof item.incognito === 'boolean');
    if (!tab) throw new Error('Could not verify the popup window.');
    return { ...sender, tab };
  }

  async function queryWithCompletion(message, sender, query) {
    const force = LCTCompletion.validateRefresh(message.refreshCompletion);
    const deadlineAt = Date.now() + LCTCompletion.OVERALL_TIMEOUT_MS;
    if (message.completionFilter === undefined || message.completionFilter === 'all') {
      return { ok: true, ...await query(message), status: await service.getStatus() };
    }
    // Preflight runs full option validation and checks source availability
    // before any account request. Never inject a map from the message itself.
    const preflight = await query(message, checkingCompletion);
    let snapshot;
    if (preflight.available === false) {
      snapshot = { ...checkingCompletion, state: 'unavailable', message: 'Company data is unavailable for this time window.' };
      return { ok: true, ...preflight, status: await service.getStatus(),
        completion: completionMetadata(snapshot, preflight.completionUnknownCount) };
    }
    try { snapshot = await completionService.getSnapshot(await privateQuerySender(sender, deadlineAt), { force, deadlineAt }); }
    catch (_) { snapshot = { ...checkingCompletion, state: 'unavailable', message: 'Could not verify your LeetCode tab. Try again.' }; }
    const response = await query(message, snapshot);
    return { ok: true, ...response, status: await service.getStatus(),
      completion: completionMetadata(snapshot, response.completionUnknownCount) };
  }

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
      'LCT_SEARCH_COMPANIES', 'LCT_OPEN_EXPLORER', 'LCT_OPEN_POPUP', 'LCT_COMPLETION', 'LCT_TARGET', 'LCT_TARGET_LIST', 'LCT_TARGET_SAVE', 'LCT_TARGET_REMOVE', 'LCT_TARGET_UPDATE', 'LCT_TARGET_CLONE'].includes(message.type)) return false;
    if (['LCT_TARGET_LIST', 'LCT_TARGET_SAVE', 'LCT_TARGET_REMOVE', 'LCT_TARGET_UPDATE', 'LCT_TARGET_CLONE'].includes(message.type) && !LCTCompletion.isInterfaceSender(sender, api.runtime)) return false;
    if (message.type === 'LCT_COMPLETION' && !LCTCompletion.isInterfaceSender(sender, api.runtime)) return false;
    if (['LCT_PRACTICE', 'LCT_SEARCH_PROBLEMS', 'LCT_TARGET'].includes(message.type) && message.completionFilter !== undefined &&
        message.completionFilter !== 'all' && !LCTCompletion.isInterfaceSender(sender, api.runtime)) return false;
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
      if (message.type === 'LCT_COMPLETION') {
        const slugs = LCTCompletion.validateSlugs(message.slugs);
        return completionService.get(slugs, await privateQuerySender(sender, Date.now() + LCTCompletion.OVERALL_TIMEOUT_MS));
      }
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
        if (!['problems', 'companies', 'target'].includes(mode) || typeof query !== 'string' || query.length > 200) throw new Error('Invalid explorer selection.');
        const slug = message.slug;
        if (slug !== undefined && (mode !== 'problems' || typeof slug !== 'string' || slug.length > 200 || slug !== slug.trim() || !LCTCore.SLUG_PATTERN.test(slug))) throw new Error('Invalid explorer problem.');
        const company = message.company;
        if (company !== undefined && (mode !== 'companies' || slug !== undefined || typeof company !== 'string' || !company.trim() || company !== company.trim() || company.length > 200)) throw new Error('Invalid explorer company.');
        const contextKeys = ['window', 'difficulty', 'topic', 'sort', 'completionFilter'];
        if (company === undefined && contextKeys.some(key => message[key] !== undefined)) throw new Error('Invalid explorer practice context.');
        if (company !== undefined && (
          (message.window !== undefined && (typeof message.window !== 'string' || !Object.hasOwn(LCTCore.WINDOW_FILES, message.window))) ||
          (message.difficulty !== undefined && !LCTCore.validDifficultyFilter(message.difficulty)) ||
          (message.topic !== undefined && (typeof message.topic !== 'string' || message.topic.length > 200)) ||
          (message.sort !== undefined && !LCTCore.SORT_OPTIONS.practiceQuestions.includes(message.sort)) ||
          (message.completionFilter !== undefined && !['all', 'solved', 'not-solved'].includes(message.completionFilter))
        )) throw new Error('Invalid explorer practice context.');
        const params = new URLSearchParams({ mode, query });
        if (slug !== undefined) params.set('slug', slug);
        if (company !== undefined) {
          params.set('company', company);
          for (const key of contextKeys) if (message[key] !== undefined) params.set(key, message[key]);
        }
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
      if (message.type === 'LCT_TARGET_LIST') return { ok: true, targets: await targetCollection.list() };
      if (message.type === 'LCT_TARGET_SAVE') return { ok: true, target: await targetCollection.save(message.target) };
      if (message.type === 'LCT_TARGET_UPDATE') return { ok: true, target: await targetCollection.update(message.id, message.name, message.revision, message.target) };
      if (message.type === 'LCT_TARGET_CLONE') return { ok: true, target: await targetCollection.clone(message.id, message.name, message.revision, message.target) };
      if (message.type === 'LCT_TARGET_REMOVE') { await targetCollection.remove(message.id); return { ok: true }; }
      if (message.type === 'LCT_TARGET') return queryWithCompletion(message, sender, (options, snapshot) => service.getTarget(options, snapshot));
      if (message.type === 'LCT_PRACTICE') return queryWithCompletion(message, sender, (options, snapshot) => service.getPractice(options, snapshot));
      if (message.type === 'LCT_SEARCH_PROBLEMS') return queryWithCompletion(message, sender, (options, snapshot) => service.searchProblems(options, snapshot));
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
