(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./core.js') : root.LCTCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LCTSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;
  const MAX_RUN_FAILURES = 3;
  // Three attempts plus backoff fit below the MV3 worker's 30-second idle
  // window, allowing the next real progress/error checkpoint to be persisted.
  const REQUEST_TIMEOUT_MS = 8000;
  const KEYS = ['lctData', 'lctStatus', 'lctSettings', 'lctCache', 'lctStage'];

  class SyncError extends Error {
    constructor(message, retryAt, transient) {
      super(message);
      this.name = 'SyncError';
      this.retryAt = retryAt || 0;
      this.transient = Boolean(transient);
    }
  }

  function createSyncService(options) {
    const storage = options.storage;
    const fetchFn = options.fetch;
    const now = options.now || Date.now;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pending = options.onPending || (async () => {});
    const concurrency = Math.min(8, Math.max(1, options.concurrency || 6));
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, options.timeoutMs || REQUEST_TIMEOUT_MS);
    let state = {}, initialized, running = null, launching = null;

    function iso() { return new Date(now()).toISOString(); }

    function dataStatus(data = state.lctData) {
      return { hasData: Boolean(data), lastSyncedAt: data ? data.lastSyncedAt : null,
        commit: data ? data.commit : null, sourceUpdatedAt: data ? data.sourceUpdatedAt : null,
        problemCount: data ? data.problemCount : 0, companyCount: data ? data.companyCount : 0 };
    }

    async function write(values) {
      await storage.set(values);
      Object.assign(state, values);
    }

    async function updateStatus(values) {
      const status = Object.assign({ phase: 'idle', completed: 0, total: 0, message: '', lastCheckedAt: null },
        state.lctStatus || {}, dataStatus(), values);
      await write({ lctStatus: status });
      return status;
    }

    async function initialize() {
      if (!initialized) initialized = (async () => {
        state = await storage.get(KEYS);
        if (!state.lctSettings) await write({ lctSettings: { enabled: true, collapsed: false } });
        // Retain the last complete v1 index while its frequency-aware replacement
        // downloads. Legacy blob caches and partial stages lack frequency values.
        if (state.lctStage && (state.lctStage.version !== core.DATA_VERSION || state.lctStage.schema !== core.DATA_SCHEMA)) {
          await write({ lctStage: null });
        }
        if (state.lctData && (![1, core.DATA_VERSION].includes(state.lctData.version) || !Array.isArray(state.lctData.companies) ||
            !(state.lctData.index || (state.lctData.schema === core.DATA_SCHEMA && state.lctData.windows && state.lctData.files)))) {
          state.lctData = null;
        }
        if (!state.lctStatus) await updateStatus({ message: 'Company data has not been downloaded yet.' });
      })().catch((error) => { initialized = null; throw error; });
      await initialized;
    }

    async function request(url, asJson) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let retryError;
        try {
          const response = await fetchFn(url, {
            method: 'GET', credentials: 'omit', cache: 'no-cache', redirect: 'error', signal: controller.signal,
            headers: asJson ? { Accept: 'application/vnd.github+json' } : { Accept: 'text/csv,text/plain' }
          });
          if (!response.ok) {
            if (response.status === 429 || (response.status === 403 &&
                (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after')))) {
              const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
              const rawRetry = response.headers.get('retry-after');
              const seconds = Number(rawRetry);
              const retryDate = rawRetry && !Number.isFinite(seconds) ? Date.parse(rawRetry) : 0;
              const retryAt = Math.max(now() + 60000, Number.isFinite(reset) ? reset : 0,
                rawRetry && Number.isFinite(seconds) ? now() + seconds * 1000 : retryDate || 0);
              throw new SyncError('GitHub rate limit reached. Retry after ' +
                new Date(retryAt).toISOString() + '.', retryAt, true);
            }
            throw new SyncError('GitHub request failed (HTTP ' + response.status + ').', 0, response.status >= 500 || response.status === 408);
          }
          return asJson ? await response.json() : await response.text();
        } catch (error) {
          retryError = error instanceof SyncError ? error : new SyncError(
            error && error.name === 'AbortError' ? 'GitHub request timed out. Check your connection and retry.' :
              'Could not download company data. Check your connection and retry.', 0, true);
          if (retryError.retryAt || !retryError.transient || attempt === 2) throw retryError;
        } finally {
          clearTimeout(timer);
        }
        await sleep(400 * (2 ** attempt));
      }
      throw new SyncError('Company data could not be downloaded.');
    }

    async function prepareStage() {
      const metadata = await request(core.API_URL + '/commits/main', true);
      const commit = metadata && metadata.sha;
      const sourceUpdatedAt = metadata && metadata.commit && metadata.commit.committer && metadata.commit.committer.date;
      const treeSha = metadata && metadata.commit && metadata.commit.tree && metadata.commit.tree.sha;
      if (!core.SHA_PATTERN.test(commit || '') || !core.SHA_PATTERN.test(treeSha || '') || !sourceUpdatedAt || !Number.isFinite(Date.parse(sourceUpdatedAt))) {
        throw new Error('GitHub returned invalid source commit metadata.');
      }
      await updateStatus({ lastCheckedAt: iso() });
      if (state.lctData && state.lctData.schema === core.DATA_SCHEMA && state.lctData.commit === commit) return null;
      const tree = await request(core.API_URL + '/git/trees/' + treeSha + '?recursive=1', true);
      const files = core.selectWindowFiles(tree);
      const done = Object.create(null);
      const previousFiles = state.lctData && state.lctData.schema === core.DATA_SCHEMA ? state.lctData.files : {};
      for (const file of files) {
        const cached = core.reusableFile(file, previousFiles);
        if (cached) done[file.path] = cached;
      }
      const stage = { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, commit, sourceUpdatedAt, files, done, failureCount: 0, retryAt: 0 };
      await write({ lctStage: stage });
      return stage;
    }

    async function performSync() {
      let stage = state.lctStage;
      try {
        await pending(true);
        if (!stage || !stage.files) stage = await prepareStage();
        if (!stage) {
          const status = Object.assign({}, state.lctStatus, dataStatus(), {
            phase: 'idle', completed: Object.keys(state.lctData.files).length, total: Object.keys(state.lctData.files).length,
            message: 'Company data is up to date.' });
          await write({ lctStage: null, lctStatus: status });
          await pending(false);
          return;
        }
        const remaining = stage.files.filter((file) => !core.reusableFile(file, stage.done));
        await updateStatus({ phase: 'syncing', total: stage.files.length,
          completed: stage.files.length - remaining.length, message: 'Downloading company data from GitHub…' });
        for (let offset = 0; offset < remaining.length; offset += concurrency) {
          const batch = remaining.slice(offset, offset + concurrency);
          const results = await Promise.allSettled(batch.map(async (file) => {
            const csv = await request(core.rawFileURL(stage.commit, file.path), false);
            return { sha: file.sha, records: core.parseCompanyRecords(csv) };
          }));
          let failure;
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') stage.done[batch[index].path] = result.value;
            else if (!failure) failure = result.reason;
          });
          // Persist successful members even when another request in this batch fails.
          await write({ lctStage: stage });
          await updateStatus({ completed: Object.keys(stage.done).length, total: stage.files.length });
          if (failure) throw failure;
        }
        const data = core.buildData(stage.files, stage.done, stage.commit, stage.sourceUpdatedAt, iso());
        // One storage operation publishes the complete index and its matching cache.
        // The old index remains readable throughout every preceding checkpoint.
        const status = Object.assign({}, state.lctStatus, dataStatus(data), {
          phase: 'idle', completed: stage.files.length, total: stage.files.length,
          lastCheckedAt: iso(), message: 'Company data is up to date.' });
        // data.files is also the parsed-file cache; avoid storing a duplicate
        // metadata-rich dataset under lctCache after the migration completes.
        await write({ lctData: data, lctCache: null, lctStage: null, lctStatus: status });
        await pending(false);
      } catch (error) {
        stage = stage || state.lctStage || { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, failureCount: 0 };
        stage.failureCount = (stage.failureCount || 0) + 1;
        stage.retryAt = error.retryAt || now() + Math.min(15 * 60000, 60000 * (2 ** (stage.failureCount - 1)));
        await write({ lctStage: stage });
        const canRetry = stage.failureCount < MAX_RUN_FAILURES;
        const savedMessage = state.lctData ? ' The last complete download is still shown.' : ' No complete download is available yet.';
        await updateStatus({ phase: 'error', message: (error.message || 'Company data sync failed.') + savedMessage +
          (canRetry ? ' An automatic retry is scheduled.' : ' Use Refresh to try again.') });
        await pending(canRetry);
      }
    }

    async function start(optionsForRun) {
      await initialize();
      if (running) return state.lctStatus;
      if (launching) return launching;
      // Reserve this lock before any storage await: boot, onInstalled and popup
      // refresh can otherwise start duplicate downloads in the same worker.
      launching = (async () => {
        const manual = optionsForRun && optionsForRun.manual;
        let stage = state.lctStage;
        if (stage) {
          if (manual) {
            stage.failureCount = 0;
            stage.retryAt = 0;
            await write({ lctStage: stage });
          } else if (stage.failureCount >= MAX_RUN_FAILURES || stage.retryAt > now()) {
            await pending(stage.failureCount < MAX_RUN_FAILURES);
            return state.lctStatus;
          }
        } else {
          // Checkpoint before metadata requests too: a suspended worker must
          // resume even when a recent lastCheckedAt was already saved.
          stage = { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, failureCount: 0, retryAt: 0 };
          await write({ lctStage: stage });
        }
        await updateStatus({ phase: 'syncing', message: stage && stage.files ? 'Resuming company data download…' : 'Checking the latest GitHub source…' });
        running = performSync().finally(() => { running = null; });
        // Keep unexpected storage failures from becoming unhandled rejections.
        running.catch((error) => { if (options.onError) options.onError(error); });
        return state.lctStatus;
      })();
      try { return await launching; }
      finally { launching = null; }
    }

    async function startAutomatic() {
      await initialize();
      const checked = Date.parse(state.lctStatus.lastCheckedAt || '');
      if (state.lctStage || !state.lctData || state.lctData.schema !== core.DATA_SCHEMA || !Number.isFinite(checked) || now() - checked >= DAY) return start();
      return state.lctStatus;
    }

    function selectedWindow(value) {
      const window = value === undefined || value === null ? 'all' : value;
      if (typeof window !== 'string' || !Object.prototype.hasOwnProperty.call(core.WINDOW_FILES, window)) {
        throw new Error('Invalid company time window.');
      }
      return window;
    }

    return {
      initialize, startAutomatic,
      refresh: () => start({ manual: true }),
      resume: () => start(),
      async getStatus() { await initialize(); return Object.assign({}, state.lctStatus, dataStatus()); },
      async getCompanies(slug, window) {
        await initialize();
        if (typeof slug !== 'string' || !core.SLUG_PATTERN.test(slug)) throw new Error('Invalid LeetCode problem slug.');
        return core.companiesForSlug(state.lctData, slug, selectedWindow(window));
      },
      async windowAvailable(window) {
        await initialize();
        return core.windowAvailable(state.lctData, selectedWindow(window));
      },
      async getPractice(options) {
        await initialize();
        if (!options || typeof options.company !== 'string' || !options.company || options.company.length > 200) {
          throw new Error('Invalid company name.');
        }
        const window = selectedWindow(options.window);
        if (options.difficulty && (typeof options.difficulty !== 'string' || !['easy', 'medium', 'hard'].includes(options.difficulty.toLowerCase()))) {
          throw new Error('Invalid difficulty filter.');
        }
        if (options.topic && (typeof options.topic !== 'string' || options.topic.length > 200)) throw new Error('Invalid topic filter.');
        if (options.excludeSlug && (typeof options.excludeSlug !== 'string' || !core.SLUG_PATTERN.test(options.excludeSlug))) {
          throw new Error('Invalid excluded problem slug.');
        }
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
          throw new Error('Practice limit must be between 1 and 100.');
        }
        return core.practiceQuestions(state.lctData, Object.assign({}, options, { window }));
      },
      // Exposed for deterministic tests; UI never awaits the complete network job.
      async waitForIdle() { if (launching) await launching; if (running) await running; }
    };
  }

  return { createSyncService, SyncError, DAY, MAX_RUN_FAILURES, REQUEST_TIMEOUT_MS };
});
