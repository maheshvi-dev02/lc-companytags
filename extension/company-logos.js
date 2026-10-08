(function (root, factory) {
  const catalog = typeof module === 'object' && module.exports ? require('./logo-catalog.js') : root.LCTLogoCatalog;
  const api = factory(catalog);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LCTCompanyLogos = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (catalog) {
  'use strict';

  const SAFE_FILENAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*\.(?:svg|png)$/;
  const assets = new Map();
  const conflicts = new Set();

  function normalizedName(name) {
    return typeof name === 'string' ? name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
  }

  // Only explicitly catalogued companies have brand images. Names never become
  // filenames, and punctuation remains significant to avoid guessing identities.
  if (catalog && typeof catalog === 'object') for (const [name, filename] of Object.entries(catalog)) {
    const key = normalizedName(name);
    if (!key || typeof filename !== 'string' || !SAFE_FILENAME.test(filename) || conflicts.has(key)) continue;
    if (assets.has(key) && assets.get(key) !== filename) {
      assets.delete(key);
      conflicts.add(key);
    } else assets.set(key, filename);
  }

  function getAsset(name) {
    const filename = assets.get(normalizedName(name));
    return filename ? 'logos/' + filename : null;
  }

  function initials(name) {
    if (typeof name !== 'string') return '?';
    const words = name.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
    if (!words.length) return '?';
    const value = words.length > 1 ? Array.from(words[0])[0] + Array.from(words[words.length - 1])[0] :
      Array.from(words[0]).slice(0, 2).join('');
    return Array.from(value.toUpperCase()).slice(0, 2).join('') || '?';
  }

  function createBadge(name, options = {}) {
    const document = options.document || globalThis.document;
    const runtime = options.runtime === undefined ? (globalThis.browser || globalThis.chrome)?.runtime : options.runtime;
    if (!document || typeof document.createElement !== 'function') throw new Error('Company logo badges need a document.');
    const badge = document.createElement('span');
    badge.className = 'company-logo';
    badge.setAttribute('aria-hidden', 'true');
    const fallback = document.createElement('span');
    fallback.className = 'company-logo-fallback';
    fallback.textContent = initials(name);
    badge.append(fallback);
    const asset = getAsset(name);
    if (!asset || !runtime || typeof runtime.getURL !== 'function') return badge;
    let src;
    try {
      src = runtime.getURL(asset);
      const url = new URL(src);
      if (!['chrome-extension:', 'moz-extension:'].includes(url.protocol) || !url.hostname || url.username || url.password) return badge;
    } catch (_) { return badge; }
    const image = document.createElement('img');
    image.className = 'company-logo-image';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.width = 20;
    image.height = 20;
    image.decoding = 'async';
    image.addEventListener('load', () => {
      if (image.parentNode === badge) badge.setAttribute('data-loaded', '');
    }, { once: true });
    image.addEventListener('error', () => {
      badge.removeAttribute('data-loaded');
      image.remove();
    }, { once: true });
    badge.append(image);
    image.src = src;
    return badge;
  }

  return { getAsset, initials, createBadge };
});
