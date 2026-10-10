(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(commonJS ? require('./core.js') : root.LCTCore,
    commonJS ? require('./archive.js') : root.LCTArchive, commonJS ? require('./seed.js') : root.LCTSeed,
    commonJS ? require('./lookup.js') : root.LCTLookup);
  if (commonJS) module.exports = api;
  root.LCTSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, defaultArchive, seed, lookup) {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;
  const MAX_RUN_FAILURES = 3;
  const REQUEST_TIMEOUT_MS = 8000;
  const ARCHIVE_TIMEOUT_MS = 25000;
  const CHECKPOINT_FILES = 64;
  const CHUNK_PREFIX = 'lctChunk:';
  const MANIFEST_PREFIX = 'lctManifest:';
  const KEYS = ['lctData', 'lctStatus', 'lctSettings', 'lctStage', lookup.META_KEY];

  class SyncError extends Error {
    constructor(message, retryAt, transient) {
      super(message);
      this.name = 'SyncError';
      this.retryAt = retryAt || 0;
      this.transient = Boolean(transient);
    }
  }
  class StorageError extends Error {
    constructor(error) { super(error && error.message || 'Company data could not be saved.'); this.name = 'StorageError'; }
  }

  function chunkKey(commit, path) { return CHUNK_PREFIX + commit + ':' + path; }
  function archiveURL(commit) {
    if (!core.SHA_PATTERN.test(commit || '')) throw new Error('Invalid source commit.');
    return 'https://codeload.github.com/liquidslr/leetcode-company-wise-problems/zip/' + commit;
  }

  function createSyncService(options) {
    const storage = options.storage, fetchFn = options.fetch;
    const archive = options.archive === false ? null : options.archive || defaultArchive;
    const now = options.now || Date.now;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pending = options.onPending || (async () => {});
    const concurrency = Math.min(8, Math.max(1, options.concurrency || 6));
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, options.timeoutMs || REQUEST_TIMEOUT_MS);
    const progressInterval = options.progressIntervalMs === undefined ? 1000 : Math.max(0, options.progressIntervalMs);
    let state = {}, initialized, running = null, launching = null;

    function iso() { return new Date(now()).toISOString(); }
    function dataStatus(data = state.lctData) {
      return { hasData: Boolean(data), acceptanceVersion: core.hasAcceptanceData(data) ? core.ACCEPTANCE_VERSION : 0, lastSyncedAt: data ? data.lastSyncedAt : null,
        commit: data ? data.commit : null, sourceUpdatedAt: data ? data.sourceUpdatedAt : null,
        problemCount: data ? data.problemCount : 0, companyCount: data ? data.companyCount : 0 };
    }
    async function write(values) {
      try { await storage.set(values); }
      catch (error) { throw new StorageError(error); }
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
        if (state.lctStage && (state.lctStage.version !== core.DATA_VERSION || state.lctStage.schema !== core.DATA_SCHEMA)) {
          await write({ lctStage: null });
        }
        if (state.lctData && (![1, core.DATA_VERSION].includes(state.lctData.version) || !Array.isArray(state.lctData.companies) ||
            !(state.lctData.index || (state.lctData.schema === core.DATA_SCHEMA && state.lctData.windows && state.lctData.files)))) {
          state.lctData = null;
        }
        // A packaged snapshot is ready before any GitHub request. An older
        // records format can be enriched offline from the exact same commit;
        // a snapshot must never replace data from a different source revision.
        const loadSnapshot = options.loadSnapshot || options.loadBundledSnapshot;
        if (loadSnapshot && (!state.lctData || (state.lctData.schema === core.DATA_SCHEMA && !core.hasAcceptanceData(state.lctData)))) {
          try {
            const loaded = await loadSnapshot();
            let data = seed.validatedSnapshot(loaded) || seed.validateSnapshot(loaded);
            if (state.lctData && state.lctData.commit === data.commit) {
              data = core.buildData(Object.entries(data.files).map(([path, file]) => ({ path, sha: file.sha, name: path.split('/')[0],
                window: Object.keys(core.WINDOW_FILES).find((window) => path.endsWith('/' + core.WINDOW_FILES[window])) })),
                data.files, state.lctData.commit, state.lctData.sourceUpdatedAt, state.lctData.lastSyncedAt);
              const status = Object.assign({}, state.lctStatus || {}, dataStatus(data));
              await write(Object.assign({ lctData: data, lctStatus: status }, lookup.buildStorage(data, status) || {}));
            } else if (!state.lctData) {
              const status = Object.assign({}, dataStatus(data), { phase: 'idle', completed: Object.keys(data.files).length,
                total: Object.keys(data.files).length, lastCheckedAt: null, dataSource: 'bundled',
                message: 'Bundled company snapshot is ready.' });
              await write(Object.assign({ lctData: data, lctStatus: status }, lookup.buildStorage(data, status) || {}));
            }
          } catch (error) {
            if (error instanceof StorageError) throw error;
            if (options.onError) options.onError(error);
          }
        }
        if (!state.lctStatus) await updateStatus({ message: 'Company data has not been downloaded yet.' });
        // Existing installations migrate once. Tags can then read one small
        // shard on a cold worker wake without deserializing practice records.
        if (state.lctData && state.lctData.schema === core.DATA_SCHEMA &&
            !lookup.matchesData(state[lookup.META_KEY], state.lctData)) {
          const compact = lookup.buildStorage(state.lctData, state.lctStatus);
          if (compact) await write(compact);
        }
      })().catch((error) => { initialized = null; throw error; });
      await initialized;
    }

    async function binaryBody(response, limit) {
      if (!response.body || !response.body.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) throw new Error('GitHub archive is too large.');
        return bytes;
      }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > limit) throw new Error('GitHub archive is too large.');
          chunks.push(result.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    }
    async function request(url, format, config = {}) {
      const attempts = config.attempts || 3;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs || timeoutMs);
        let retryError;
        try {
          const response = await fetchFn(url, {
            method: 'GET', credentials: 'omit', cache: 'no-cache', redirect: 'error', signal: controller.signal,
            headers: { Accept: format === 'json' ? 'application/vnd.github+json' : format === 'bytes' ? 'application/zip' : 'text/csv,text/plain' }
          });
          if (!response.ok) {
            if (response.status === 429 || (response.status === 403 &&
                (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after')))) {
              const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
              const rawRetry = response.headers.get('retry-after'), seconds = Number(rawRetry);
              const retryDate = rawRetry && !Number.isFinite(seconds) ? Date.parse(rawRetry) : 0;
              const retryAt = Math.max(now() + 60000, Number.isFinite(reset) ? reset : 0,
                rawRetry && Number.isFinite(seconds) ? now() + seconds * 1000 : retryDate || 0);
              throw new SyncError('GitHub rate limit reached. Retry after ' + new Date(retryAt).toISOString() + '.', retryAt, true);
            }
            throw new SyncError('GitHub request failed (HTTP ' + response.status + ').', 0, response.status >= 500 || response.status === 408);
          }
          return format === 'json' ? await response.json() : format === 'bytes' ?
            await binaryBody(response, defaultArchive.MAX_ARCHIVE_BYTES) : await response.text();
        } catch (error) {
          retryError = error instanceof SyncError ? error : new SyncError(
            error && error.name === 'AbortError' ? 'GitHub request timed out. Check your connection and retry.' :
              'Could not download company data. Check your connection and retry.', 0, true);
          if (retryError.retryAt || !retryError.transient || attempt === attempts - 1) throw retryError;
        } finally { clearTimeout(timer); }
        await sleep(400 * (2 ** attempt));
      }
      throw new SyncError('Company data could not be downloaded.');
    }

    function compactStage(stage, completed = stage.completed) {
      const value = { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, checkpointVersion: 2,
        commit: stage.commit, sourceUpdatedAt: stage.sourceUpdatedAt, manifestKey: stage.manifestKey,
        completed: Array.isArray(completed) ? completed : [], useArchive: Boolean(stage.useArchive),
        archiveAttempted: Boolean(stage.archiveAttempted), failureCount: stage.failureCount || 0, retryAt: stage.retryAt || 0 };
      // A pre-metadata checkpoint deliberately has no commit or manifest yet.
      return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
    }
    async function saveStage(stage, extra = {}, completed) {
      const saved = compactStage(stage, completed);
      await write(Object.assign({}, extra, { lctStage: saved }));
      stage.completed = saved.completed;
    }
    async function removeStageFiles(stage) {
      if (!stage || !stage.commit) return;
      const keys = (stage.completed || []).map((path) => chunkKey(stage.commit, path));
      if (stage.manifestKey) keys.push(stage.manifestKey);
      if (!keys.length) return;
      if (typeof storage.remove === 'function') await storage.remove(keys);
      else await storage.set(Object.fromEntries(keys.map((key) => [key, null])));
    }
    function validManifest(files) {
      if (!Array.isArray(files) || !files.length) return false;
      try {
        const selected = core.selectWindowFiles({ truncated: false,
          tree: files.map((file) => ({ type: 'blob', path: file.path, sha: file.sha })) });
        return selected.length === files.length && selected.every((file, index) =>
          file.path === files[index].path && file.name === files[index].name && file.window === (files[index].window || 'all'));
      } catch (_) { return false; }
    }
    async function hydrateStage(saved) {
      if (!saved || !saved.commit) return null;
      if (!core.SHA_PATTERN.test(saved.commit) || !Number.isFinite(Date.parse(saved.sourceUpdatedAt || ''))) return null;
      if (saved.checkpointVersion === 2 && saved.manifestKey === MANIFEST_PREFIX + saved.commit) {
        const stored = await storage.get([saved.manifestKey]);
        if (validManifest(stored[saved.manifestKey])) return Object.assign({}, saved, { files: stored[saved.manifestKey] });
        await removeStageFiles(saved);
        await write({ lctStage: null });
        return null;
      }
      if (!validManifest(saved.files)) return null;
      // Preserve usable old v2 checkpoints, moving each parsed file only once.
      const completed = [], chunks = {};
      for (const file of saved.files) {
        const value = core.reusableFile(file, saved.done);
        if (value) { completed.push(file.path); chunks[chunkKey(saved.commit, file.path)] = value; }
      }
      const stage = Object.assign({}, saved, { manifestKey: MANIFEST_PREFIX + saved.commit,
        completed, useArchive: Boolean(saved.useArchive) && !completed.length });
      chunks[stage.manifestKey] = stage.files;
      await saveStage(stage, chunks);
      return stage;
    }
    async function prepareStage() {
      const metadata = await request(core.API_URL + '/commits/main', 'json');
      const commit = metadata && metadata.sha;
      const sourceUpdatedAt = metadata && metadata.commit && metadata.commit.committer && metadata.commit.committer.date;
      const treeSha = metadata && metadata.commit && metadata.commit.tree && metadata.commit.tree.sha;
      if (!core.SHA_PATTERN.test(commit || '') || !core.SHA_PATTERN.test(treeSha || '') || !sourceUpdatedAt || !Number.isFinite(Date.parse(sourceUpdatedAt))) {
        throw new Error('GitHub returned invalid source commit metadata.');
      }
      await updateStatus({ lastCheckedAt: iso() });
      if (state.lctData && state.lctData.schema === core.DATA_SCHEMA && core.hasAcceptanceData(state.lctData) && state.lctData.commit === commit) return null;
      const tree = await request(core.API_URL + '/git/trees/' + treeSha + '?recursive=1', 'json');
      const files = core.selectWindowFiles(tree);
      const useArchive = !state.lctData || state.lctData.schema !== core.DATA_SCHEMA || !core.hasAcceptanceData(state.lctData) || state.lctStatus.dataSource === 'bundled';
      const stage = { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, checkpointVersion: 2, commit, sourceUpdatedAt, files,
        manifestKey: MANIFEST_PREFIX + commit, completed: [], useArchive, archiveAttempted: false, failureCount: 0, retryAt: 0 };
      await saveStage(stage, { [stage.manifestKey]: files });
      return stage;
    }
    async function completedRecords(stage) {
      const records = Object.create(null);
      const previous = state.lctData && state.lctData.schema === core.DATA_SCHEMA ? state.lctData.files : {};
      const completed = new Set(stage.completed || []);
      const missing = [];
      for (const file of stage.files) {
        const value = core.reusableFile(file, previous);
        if (value) records[file.path] = value;
        else if (completed.has(file.path)) missing.push(file);
      }
      // Bound reads too; browser storage results should not deserialize the
      // entire staging dataset in a single IPC operation on every progress tick.
      for (let offset = 0; offset < missing.length; offset += CHECKPOINT_FILES) {
        const group = missing.slice(offset, offset + CHECKPOINT_FILES);
        const stored = await storage.get(group.map((file) => chunkKey(stage.commit, file.path)));
        for (const file of group) {
          const cache = { [file.path]: stored[chunkKey(stage.commit, file.path)] };
          const value = core.reusableFile(file, cache);
          if (value) records[file.path] = value;
        }
      }
      return records;
    }

    async function performSync() {
      let stage = state.lctStage;
      try {
        await pending(true);
        stage = await hydrateStage(stage);
        if (!stage) stage = await prepareStage();
        if (!stage) {
          const count = Object.keys(state.lctData.files).length;
          await write({ lctStage: null, lctStatus: Object.assign({}, state.lctStatus, dataStatus(), {
            phase: 'idle', completed: count, total: count, dataSource: 'live', message: 'Company data is up to date.' }) });
          await pending(false);
          return;
        }
        const records = await completedRecords(stage);
        let queued = {}, queuedPaths = [], flushing = null, lastCheckpoint = now(), lastProgress = 0;
        const completeCount = () => Object.keys(records).length;
        async function progress(message, force) {
          if (!force && now() - lastProgress < progressInterval) return;
          await updateStatus({ phase: 'syncing', total: stage.files.length, completed: completeCount(),
            message: message || 'Downloading company data from GitHub…' });
          lastProgress = now();
        }
        async function flush(force) {
          if (flushing) {
            await flushing;
            if (force && queuedPaths.length) return flush(true);
            return;
          }
          if (!queuedPaths.length || (!force && queuedPaths.length < CHECKPOINT_FILES && now() - lastCheckpoint < 1000)) return;
          const patch = queued, paths = queuedPaths;
          queued = {}; queuedPaths = [];
          const completed = Array.from(new Set((stage.completed || []).concat(paths)));
          flushing = saveStage(stage, patch, completed).then(() => { lastCheckpoint = now(); });
          try { await flushing; } finally { flushing = null; }
          await progress();
        }
        async function received(file, value) {
          if (records[file.path]) return;
          records[file.path] = value;
          queued[chunkKey(stage.commit, file.path)] = value;
          queuedPaths.push(file.path);
          await flush(false);
        }
        await progress(stage.useArchive && !stage.archiveAttempted ? 'Downloading the pinned GitHub company archive…' :
          'Downloading changed company lists from GitHub…', true);
        if (stage.useArchive && !stage.archiveAttempted && archive && typeof archive.readCompanyArchive === 'function' && completeCount() < stage.files.length) {
          try {
            // One attempt remains within the MV3 idle window. If unavailable,
            // use resumable CSV downloads instead of blocking the first sync.
            const bytes = await request(archiveURL(stage.commit), 'bytes', {
              attempts: 1, timeoutMs: Math.min(ARCHIVE_TIMEOUT_MS, options.archiveTimeoutMs || ARCHIVE_TIMEOUT_MS)
            });
            await progress('Validating the pinned GitHub company archive…', true);
            await archive.readCompanyArchive(bytes, { commit: stage.commit, files: stage.files, onFile: received });
            await flush(true);
          } catch (error) {
            if (error instanceof StorageError) throw error;
            await flush(true);
            stage.archiveAttempted = true;
            await saveStage(stage);
            await progress('Archive unavailable. Downloading remaining company lists…', true);
          }
        }
        const remaining = stage.files.filter((file) => !records[file.path]);
        let next = 0, failure = null;
        const workers = Array.from({ length: Math.min(concurrency, remaining.length) }, async () => {
          while (!failure && next < remaining.length) {
            const file = remaining[next++];
            try {
              const text = await request(core.rawFileURL(stage.commit, file.path), 'text');
              await received(file, { sha: file.sha, records: core.parseCompanyRecords(text, { commit: stage.commit }) });
            } catch (error) { if (!failure) failure = error; }
          }
        });
        await Promise.all(workers);
        await flush(true);
        if (failure) throw failure;
        const data = core.buildData(stage.files, records, stage.commit, stage.sourceUpdatedAt, iso());
        const status = Object.assign({}, state.lctStatus, dataStatus(data), {
          phase: 'idle', completed: stage.files.length, total: stage.files.length,
          lastCheckedAt: iso(), dataSource: 'live', message: 'Company data is up to date.' });
        await write(Object.assign({ lctData: data, lctCache: null, lctStage: null, lctStatus: status }, lookup.buildStorage(data, status) || {}));
        await pending(false);
        // Cleanup follows publication; a cleanup problem must never turn a
        // successful complete refresh back into an interrupted download.
        try { await removeStageFiles(stage); }
        catch (error) { if (options.onError) options.onError(error); }
      } catch (error) {
        stage = stage || state.lctStage || { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, failureCount: 0 };
        stage.failureCount = (stage.failureCount || 0) + 1;
        stage.retryAt = error.retryAt || now() + Math.min(15 * 60000, 60000 * (2 ** (stage.failureCount - 1)));
        await saveStage(stage);
        const canRetry = stage.failureCount < MAX_RUN_FAILURES;
        const savedMessage = state.lctData ? ' The last complete download is still shown.' : ' No complete download is available yet.';
        await updateStatus({ phase: 'error', message: (error.message || 'Company data sync failed.') + savedMessage +
          (canRetry ? ' An automatic retry is scheduled.' : ' Use Refresh to try again.') });
        await pending(canRetry);
      }
    }

    async function start(runOptions) {
      await initialize();
      if (running) return state.lctStatus;
      if (launching) return launching;
      launching = (async () => {
        let stage = state.lctStage;
        if (stage) {
          if (runOptions && runOptions.manual) {
            stage.failureCount = 0; stage.retryAt = 0;
            // Keep legacy v2 done/files until hydrateStage migrates them.
            if (stage.checkpointVersion === 2 || !stage.files) await saveStage(stage);
            else await write({ lctStage: stage });
          } else if (stage.failureCount >= MAX_RUN_FAILURES || stage.retryAt > now()) {
            await pending(stage.failureCount < MAX_RUN_FAILURES);
            return state.lctStatus;
          }
        } else {
          stage = { version: core.DATA_VERSION, schema: core.DATA_SCHEMA, failureCount: 0, retryAt: 0 };
          await saveStage(stage);
        }
        await updateStatus({ phase: 'syncing', message: stage.manifestKey || stage.files ? 'Resuming company data download…' : 'Checking the latest GitHub source…' });
        running = performSync().finally(() => { running = null; });
        running.catch((error) => { if (options.onError) options.onError(error); });
        return state.lctStatus;
      })();
      try { return await launching; } finally { launching = null; }
    }
    async function startAutomatic() {
      await initialize();
      const checked = Date.parse(state.lctStatus.lastCheckedAt || '');
      if (state.lctStage || !state.lctData || state.lctData.schema !== core.DATA_SCHEMA || !core.hasAcceptanceData(state.lctData) || state.lctStatus.dataSource === 'bundled' ||
          !Number.isFinite(checked) || now() - checked >= DAY) return start();
      return state.lctStatus;
    }
    function selectedWindow(value) {
      const window = value === undefined || value === null ? 'all' : value;
      if (typeof window !== 'string' || !Object.prototype.hasOwnProperty.call(core.WINDOW_FILES, window)) throw new Error('Invalid company time window.');
      return window;
    }
    function queryOptions(value, defaultLimit, endpoint, defaultSort) {
      const optionsForQuery = value === undefined ? {} : value;
      if (!optionsForQuery || typeof optionsForQuery !== 'object' || Array.isArray(optionsForQuery)) throw new Error('Invalid search options.');
      const query = optionsForQuery.query === undefined ? '' : optionsForQuery.query;
      if (typeof query !== 'string' || query.length > 200) throw new Error('Search query must be text with at most 200 characters.');
      const offset = optionsForQuery.offset === undefined ? 0 : optionsForQuery.offset;
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new Error('Search offset must be an integer between 0 and 1000000.');
      const limit = optionsForQuery.limit === undefined ? defaultLimit : optionsForQuery.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be between 1 and 100.');
      if (optionsForQuery.difficulty !== undefined && optionsForQuery.difficulty !== '' &&
          (typeof optionsForQuery.difficulty !== 'string' || !['easy', 'medium', 'hard'].includes(optionsForQuery.difficulty.toLowerCase()))) {
        throw new Error('Invalid difficulty filter.');
      }
      const sort = optionsForQuery.sort === undefined ? defaultSort : optionsForQuery.sort;
      if (typeof sort !== 'string' || !core.SORT_OPTIONS[endpoint].includes(sort)) throw new Error('Invalid sort option.');
      return Object.assign({}, optionsForQuery, { query, offset, limit, sort, window: selectedWindow(optionsForQuery.window) });
    }
    return {
      initialize, startAutomatic, refresh: () => start({ manual: true }), resume: () => start(),
      async getStatus() { await initialize(); return Object.assign({}, state.lctStatus, dataStatus()); },
      async getCompanies(slug, window) {
        await initialize();
        if (typeof slug !== 'string' || !core.SLUG_PATTERN.test(slug)) throw new Error('Invalid LeetCode problem slug.');
        return core.companiesForSlug(state.lctData, slug, selectedWindow(window));
      },
      async getProblem(slug) {
        await initialize();
        if (typeof slug !== 'string' || !core.SLUG_PATTERN.test(slug)) throw new Error('Invalid LeetCode problem slug.');
        return core.problemForSlug(state.lctData, slug);
      },
      async windowAvailable(window) { await initialize(); return core.windowAvailable(state.lctData, selectedWindow(window)); },
      async searchProblems(searchOptions) {
        const validated = queryOptions(searchOptions, 50, 'searchProblems', 'relevance');
        await initialize();
        return core.searchProblems(state.lctData, validated);
      },
      async searchCompanies(searchOptions) {
        const validated = queryOptions(searchOptions, 50, 'searchCompanies', 'name-asc');
        await initialize();
        return core.searchCompanies(state.lctData, validated);
      },
      async getPractice(practiceOptions) {
        const validated = queryOptions(practiceOptions, 20, 'practiceQuestions', 'frequency-desc');
        if (typeof validated.company !== 'string' || !validated.company || validated.company.length > 200) throw new Error('Invalid company name.');
        if (validated.topic !== undefined && validated.topic !== '' &&
            (typeof validated.topic !== 'string' || validated.topic.length > 200)) throw new Error('Invalid topic filter.');
        if (validated.excludeSlug !== undefined && validated.excludeSlug !== '' &&
            (typeof validated.excludeSlug !== 'string' || !core.SLUG_PATTERN.test(validated.excludeSlug))) throw new Error('Invalid excluded problem slug.');
        await initialize();
        return core.practiceQuestions(state.lctData, validated);
      },
      async waitForIdle() { if (launching) await launching; if (running) await running; }
    };
  }
  return { createSyncService, SyncError, DAY, MAX_RUN_FAILURES, REQUEST_TIMEOUT_MS, ARCHIVE_TIMEOUT_MS, CHECKPOINT_FILES, chunkKey, archiveURL };
});
