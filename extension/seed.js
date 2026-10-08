(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./core.js') : root.LCTCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LCTSeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
  const validatedSnapshots = new WeakSet();

  function validateSnapshot(data) {
    if (!data || data.version !== core.DATA_VERSION || data.schema !== core.DATA_SCHEMA ||
        !core.SHA_PATTERN.test(data.commit || '') || !Number.isFinite(Date.parse(data.sourceUpdatedAt || '')) ||
        !Array.isArray(data.companies) || !data.companies.length || !data.files || !data.windows) {
      throw new Error('Bundled company snapshot metadata is invalid.');
    }
    const names = new Set();
    for (const company of data.companies) {
      if (!company || typeof company.name !== 'string' || !company.name || company.name.includes('/') ||
          company.name === '.' || company.name === '..' || names.has(company.name)) throw new Error('Bundled company snapshot has invalid companies.');
      names.add(company.name);
    }
    const files = [];
    for (const name of names) for (const [window, filename] of Object.entries(core.WINDOW_FILES)) {
      const path = name + '/' + filename;
      const value = Object.prototype.hasOwnProperty.call(data.files, path) && data.files[path];
      const file = { path, sha: value && value.sha, name, window };
      if (!core.SHA_PATTERN.test(file.sha || '') || !core.reusableFile(file, data.files)) throw new Error('Bundled company snapshot is incomplete.');
      let previous = Infinity, rank = null;
      let unknown = false;
      value.records.forEach((record, index) => {
        if (record.frequency === null) { unknown = true; return; }
        if (unknown || record.frequency > previous) throw new Error('Bundled company snapshot frequency order is invalid.');
        if (record.frequency !== previous) rank = index + 1;
        if (record.rank !== rank) throw new Error('Bundled company snapshot ranks are invalid.');
        previous = record.frequency;
      });
      files.push(file);
    }
    if (Object.keys(data.files).length !== files.length) throw new Error('Bundled company snapshot contains unexpected files.');
    for (const window of Object.keys(core.WINDOW_FILES)) {
      if (!data.windows[window] || data.windows[window].available !== true ||
          data.windows[window].companyCount !== names.size) throw new Error('Bundled company snapshot has an incomplete time window.');
    }
    // Rebuild the associations from validated records instead of trusting any
    // serialized reverse index. This also creates correctly pinned source links.
    const rebuilt = core.buildData(files, data.files, data.commit, data.sourceUpdatedAt,
      Number.isFinite(Date.parse(data.lastSyncedAt || '')) ? data.lastSyncedAt : data.sourceUpdatedAt);
    validatedSnapshots.add(rebuilt);
    return rebuilt;
  }

  async function loadBundledSnapshot(options) {
    const fetchFn = options && options.fetch || globalThis.fetch.bind(globalThis);
    const Compression = options && options.DecompressionStream || globalThis.DecompressionStream;
    if (!options || typeof options.url !== 'string' || typeof Compression !== 'function') throw new Error('Bundled snapshot loader is unavailable.');
    const response = await fetchFn(options.url, { credentials: 'omit' });
    if (!response.ok) throw new Error('Bundled company snapshot could not be read.');
    let reader;
    if (response.body && response.body.pipeThrough) reader = response.body.pipeThrough(new Compression('gzip')).getReader();
    else reader = new Blob([await response.arrayBuffer()]).stream().pipeThrough(new Compression('gzip')).getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_SNAPSHOT_BYTES) throw new Error('Bundled company snapshot is too large.');
        chunks.push(result.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return validateSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }

  function validatedSnapshot(data) { return data && validatedSnapshots.has(data) ? data : null; }
  return { validateSnapshot, loadBundledSnapshot, validatedSnapshot };
});
