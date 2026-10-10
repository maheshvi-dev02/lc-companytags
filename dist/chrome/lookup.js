(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.LCTCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LCTLookup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const VERSION = 2;
  const META_KEY = 'lctLookupMeta';
  const SHARD_PREFIX = 'lctLookup:';
  const SHARD_COUNT = 64;
  const WINDOWS = Object.keys(core.WINDOW_FILES);

  function selectedWindow(value) {
    const window = value === undefined || value === null ? 'all' : value;
    if (typeof window !== 'string' || !Object.prototype.hasOwnProperty.call(core.WINDOW_FILES, window)) {
      throw new Error('Invalid company time window.');
    }
    return window;
  }
  function validSlug(slug) {
    if (typeof slug !== 'string' || !core.SLUG_PATTERN.test(slug)) throw new Error('Invalid LeetCode problem slug.');
  }
  function bucket(slug) {
    let hash = 2166136261;
    for (let index = 0; index < slug.length; index++) hash = Math.imul(hash ^ slug.charCodeAt(index), 16777619);
    return (hash >>> 0) % SHARD_COUNT;
  }
  function keyForBucket(window, index) {
    return SHARD_PREFIX + window + ':' + String(index).padStart(2, '0');
  }
  function shardKey(slug, window) {
    validSlug(slug);
    return keyForBucket(selectedWindow(window), bucket(slug));
  }
  function revisionFor(data) {
    return data.commit + ':' + data.lastSyncedAt;
  }
  function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }
  function isCount(value) {
    return Number.isInteger(value) && value >= 0;
  }
  function isDate(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
  }
  function provenance(meta) {
    return { hasData: true, commit: meta.commit, sourceUpdatedAt: meta.sourceUpdatedAt,
      lastSyncedAt: meta.lastSyncedAt, acceptanceVersion: meta.acceptanceVersion, companyCount: meta.companyCount, problemCount: meta.problemCount };
  }
  function validMeta(meta) {
    if (!isObject(meta) || meta.version !== VERSION || typeof meta.commit !== 'string' || !core.SHA_PATTERN.test(meta.commit) ||
        !isDate(meta.sourceUpdatedAt) || !isDate(meta.lastSyncedAt) || meta.revision !== revisionFor(meta) ||
        !Array.isArray(meta.companies) || !meta.companies.length || meta.companyCount !== meta.companies.length ||
        !isCount(meta.problemCount) || ![0, core.ACCEPTANCE_VERSION].includes(meta.acceptanceVersion) || !isObject(meta.windows) || !isObject(meta.status)) return false;
    const names = new Set();
    for (const name of meta.companies) {
      if (typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..' || names.has(name)) return false;
      names.add(name);
    }
    for (const window of WINDOWS) {
      const value = Object.prototype.hasOwnProperty.call(meta.windows, window) && meta.windows[window];
      if (!isObject(value) || typeof value.available !== 'boolean' || !Array.isArray(value.questionCounts) ||
          value.questionCounts.length !== names.size ||
          !value.questionCounts.every((count) => count === null || isCount(count))) return false;
    }
    return true;
  }
  function matchesData(meta, data) {
    return validMeta(meta) && data && data.version === core.DATA_VERSION && data.schema === core.DATA_SCHEMA &&
      meta.revision === revisionFor(data) && meta.sourceUpdatedAt === data.sourceUpdatedAt &&
      meta.acceptanceVersion === (core.hasAcceptanceData(data) ? core.ACCEPTANCE_VERSION : 0) &&
      meta.companyCount === data.companyCount && meta.problemCount === data.problemCount;
  }

  function buildStorage(data, status) {
    if (!data || data.version !== core.DATA_VERSION || data.schema !== core.DATA_SCHEMA ||
        !Array.isArray(data.companies) || !isObject(data.files) || !isObject(data.windows)) return null;
    const meta = { version: VERSION, acceptanceVersion: core.hasAcceptanceData(data) ? core.ACCEPTANCE_VERSION : 0, revision: revisionFor(data), commit: data.commit,
      sourceUpdatedAt: data.sourceUpdatedAt, lastSyncedAt: data.lastSyncedAt,
      companyCount: data.companyCount, problemCount: data.problemCount,
      companies: data.companies.map((company) => company && company.name), windows: {},
      status: Object.assign({}, isObject(status) ? status : {}, provenance(data)) };
    const values = Object.create(null);
    for (const window of WINDOWS) {
      const questionCounts = meta.companies.map((name) => {
        const path = name + '/' + core.WINDOW_FILES[window];
        const file = Object.prototype.hasOwnProperty.call(data.files, path) && data.files[path];
        return file && Array.isArray(file.records) ? file.records.length : null;
      });
      meta.windows[window] = { available: core.windowAvailable(data, window), questionCounts };
      for (let index = 0; index < SHARD_COUNT; index++) {
        values[keyForBucket(window, index)] = { revision: meta.revision, index: Object.create(null), problems: Object.create(null) };
      }
    }
    if (!validMeta(meta)) return null;
    if (core.hasAcceptanceData(data)) for (const slug of Object.keys(data.problems)) {
      if (!core.SLUG_PATTERN.test(slug)) continue;
      const problem = core.problemForSlug(data, slug);
      if (problem) for (const window of WINDOWS) values[shardKey(slug, window)].problems[slug] = problem;
    }
    const companyIds = new Map(meta.companies.map((name, index) => [name, index]));
    for (const window of WINDOWS) {
      if (!meta.windows[window].available) continue;
      const index = data.windows[window].index;
      if (!isObject(index)) return null;
      for (const slug of Object.keys(index)) {
        if (!core.SLUG_PATTERN.test(slug)) continue;
        const tuples = core.companiesForSlug(data, slug, window).map((company) =>
          [companyIds.get(company.name), company.frequency, company.rank]);
        if (tuples.length) values[shardKey(slug, window)].index[slug] = tuples;
      }
    }
    values[META_KEY] = meta;
    return values;
  }

  function statusFor(meta, storedStatus) {
    if (storedStatus !== undefined && storedStatus !== null && !isObject(storedStatus)) return null;
    // A known newer publication must fall back to its full cache rather than
    // letting an older compact revision override the current source commit.
    if (storedStatus && typeof storedStatus.commit === 'string' && core.SHA_PATTERN.test(storedStatus.commit) && storedStatus.commit !== meta.commit) return null;
    // Progress and live verification change without republishing source rows.
    // Published provenance always comes from the matching metadata and shard.
    return Object.assign({}, meta.status, storedStatus || {}, provenance(meta));
  }
  function validTuple(tuple, meta, window) {
    if (!Array.isArray(tuple) || tuple.length !== 3 || !isCount(tuple[0]) || tuple[0] >= meta.companies.length) return false;
    const count = meta.windows[window].questionCounts[tuple[0]];
    if (!isCount(count) || count === 0) return false;
    if (tuple[1] === null) return tuple[2] === null;
    return typeof tuple[1] === 'number' && Number.isFinite(tuple[1]) && tuple[1] >= 0 &&
      Number.isInteger(tuple[2]) && tuple[2] > 0 && tuple[2] <= count;
  }
  function validShard(shard, meta, window, selectedBucket) {
    if (!isObject(shard) || shard.revision !== meta.revision || !isObject(shard.index) || !isObject(shard.problems)) return false;
    for (const [slug, tuples] of Object.entries(shard.index)) {
      if (!core.SLUG_PATTERN.test(slug) || bucket(slug) !== selectedBucket || !Array.isArray(tuples) ||
          !tuples.every((tuple) => validTuple(tuple, meta, window))) return false;
    }
    for (const [slug, problem] of Object.entries(shard.problems)) {
      if (!core.SLUG_PATTERN.test(slug) || bucket(slug) !== selectedBucket || !isObject(problem) ||
          typeof problem.title !== 'string' || !problem.title ||
          (problem.difficulty !== null && !['Easy', 'Medium', 'Hard'].includes(problem.difficulty)) ||
          (problem.acceptanceRate !== null && core.validAcceptanceRate(problem.acceptanceRate) === null)) return false;
    }
    return true;
  }
  async function readStatus(storage) {
    const stored = await storage.get([META_KEY, 'lctStatus']);
    const meta = stored[META_KEY];
    return validMeta(meta) ? statusFor(meta, stored.lctStatus) : null;
  }
  async function readProblem(storage, slug, window) {
    validSlug(slug);
    const selected = selectedWindow(window);
    const key = shardKey(slug, selected);
    const stored = await storage.get([META_KEY, key, 'lctStatus']);
    const meta = stored[META_KEY], shard = stored[key];
    if (!validMeta(meta) || !validShard(shard, meta, selected, bucket(slug))) return null;
    const status = statusFor(meta, stored.lctStatus);
    if (!status) return null;
    const available = meta.windows[selected].available;
    const seen = new Set(), companies = [];
    const tuples = Object.prototype.hasOwnProperty.call(shard.index, slug) ? shard.index[slug] : [];
    if (available) for (const [id, frequency, rank] of tuples) {
      if (seen.has(id)) continue;
      seen.add(id);
      const name = meta.companies[id];
      companies.push({ name, sourceUrl: core.sourceFileURL(meta.commit, name + '/' + core.WINDOW_FILES[selected]),
        frequency, rank, problemCount: meta.windows[selected].questionCounts[id] });
    }
    return { ok: true, problem: Object.prototype.hasOwnProperty.call(shard.problems, slug) ? Object.assign({}, shard.problems[slug]) : null,
      companies: core.sortCompanies(companies), available, windowAvailable: available, status };
  }

  return { VERSION, META_KEY, SHARD_PREFIX, SHARD_COUNT, shardKey, buildStorage, readProblem, readStatus, matchesData };
});
