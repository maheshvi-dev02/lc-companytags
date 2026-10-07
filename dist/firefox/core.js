(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LCTCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SOURCE_URL = 'https://github.com/liquidslr/leetcode-company-wise-problems';
  const API_URL = 'https://api.github.com/repos/liquidslr/leetcode-company-wise-problems';
  const RAW_URL = 'https://raw.githubusercontent.com/liquidslr/leetcode-company-wise-problems';
  const DATA_VERSION = 2;
  const DATA_SCHEMA = 'company-windows-v1';
  const WINDOW_FILES = Object.freeze({
    all: '5. All.csv', '30d': '1. Thirty Days.csv', '3m': '2. Three Months.csv',
    '6m': '3. Six Months.csv', older: '4. More Than Six Months.csv'
  });
  const SHA_PATTERN = /^[a-f0-9]{40}$/i;
  const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function getProblemSlug(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !['leetcode.com', 'www.leetcode.com', 'leetcode.cn', 'www.leetcode.cn'].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/(?:contest\/[^/]+\/)?problems\/([^/]+)(?:\/|$)/);
      if (!match) return null;
      const slug = decodeURIComponent(match[1]);
      return SLUG_PATTERN.test(slug) ? slug : null;
    } catch (_) {
      return null;
    }
  }

  function formatProblemTitle(slug) {
    return String(slug || '').split('-').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  // A strict RFC-4180-style parser: embedded newlines, commas and escaped quotes
  // are all data inside quoted fields. Broken downloads never become a full index.
  function parseCSV(input) {
    if (typeof input !== 'string') throw new Error('CSV response was not text.');
    const text = input.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', quoted = false, closed = false;
    const pushField = () => { row.push(field); field = ''; closed = false; };
    const pushRow = () => {
      pushField();
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    };
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1; }
          else { quoted = false; closed = true; }
        } else field += char;
      } else if (char === ',') pushField();
      else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        pushRow();
      } else if (char === '"') {
        if (field || closed) throw new Error('Malformed CSV: unexpected quote.');
        quoted = true;
      } else {
        if (closed) {
          if (char === ' ' || char === '\t') continue;
          throw new Error('Malformed CSV: text after closing quote.');
        }
        field += char;
      }
    }
    if (quoted) throw new Error('Malformed CSV: unterminated quoted field.');
    if (field || closed || row.length) pushRow();
    return rows;
  }

  function validFrequency(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function parseFrequency(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return validFrequency(Number(value.trim()));
  }

  function parseCompanyRecords(text) {
    const rows = parseCSV(text);
    if (!rows.length) throw new Error('Company CSV is empty.');
    const header = rows[0].map((value) => value.trim().toLowerCase());
    const linkColumn = header.indexOf('link');
    const frequencyColumn = header.indexOf('frequency');
    const titleColumn = header.indexOf('title');
    const difficultyColumn = header.indexOf('difficulty');
    const topicsColumn = header.indexOf('topics');
    if (linkColumn === -1) throw new Error('Company CSV is missing its Link column.');
    const records = new Map();
    for (const row of rows.slice(1)) {
      if (row.length !== header.length) throw new Error('Company CSV has an incomplete or malformed row.');
      const slug = getProblemSlug(row[linkColumn].trim());
      if (!slug) throw new Error('Company CSV contains an invalid LeetCode problem URL.');
      const frequency = frequencyColumn === -1 ? null : parseFrequency(row[frequencyColumn]);
      const previous = records.get(slug);
      // Duplicate source rows retain their highest known frequency. Missing
      // scores never erase a known zero or invent a score for an unknown value.
      if (!records.has(slug) || (frequency !== null && (previous.frequency === null || frequency > previous.frequency))) {
        const difficulty = difficultyColumn === -1 ? '' : row[difficultyColumn].trim().toLowerCase();
        records.set(slug, { slug,
          title: titleColumn === -1 ? formatProblemTitle(slug) : row[titleColumn].trim() || formatProblemTitle(slug),
          difficulty: ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty[0].toUpperCase() + difficulty.slice(1) : null,
          topics: topicsColumn === -1 ? [] : Array.from(new Set(row[topicsColumn].split(',').map((topic) => topic.trim()).filter(Boolean))).sort(),
          frequency, rank: null });
      }
    }
    const ranked = Array.from(records.values()).sort((a, b) => {
      if (a.frequency === null && b.frequency !== null) return 1;
      if (a.frequency !== null && b.frequency === null) return -1;
      if (a.frequency !== b.frequency) return b.frequency - a.frequency;
      return a.title.localeCompare(b.title, 'en') || a.slug.localeCompare(b.slug, 'en');
    });
    let previousFrequency = null, rank = null;
    ranked.forEach((record, index) => {
      if (record.frequency === null) return;
      if (record.frequency !== previousFrequency) rank = index + 1;
      record.rank = rank;
      previousFrequency = record.frequency;
    });
    return ranked;
  }

  function parseCompanyCSV(text) {
    return parseCompanyRecords(text).map((record) => record.slug).sort();
  }

  function sortCompanies(companies) {
    if (!Array.isArray(companies)) return [];
    return companies.filter((company) => company && typeof company.name === 'string')
      .map((company) => Object.assign({}, company, { frequency: validFrequency(company.frequency) }))
      .sort((a, b) => {
        if (a.frequency === null && b.frequency !== null) return 1;
        if (a.frequency !== null && b.frequency === null) return -1;
        if (a.frequency !== b.frequency) return b.frequency - a.frequency;
        return a.name.localeCompare(b.name, 'en');
      });
  }

  function selectWindowFiles(treeResponse, allTimeOnly) {
    if (!treeResponse || treeResponse.truncated || !Array.isArray(treeResponse.tree)) {
      throw new Error('GitHub returned an incomplete repository tree.');
    }
    const files = [];
    const paths = new Set();
    for (const entry of treeResponse.tree) {
      if (entry.type !== 'blob' || typeof entry.path !== 'string') continue;
      const match = entry.path.match(/^([^/]+)\/([^/]+)$/);
      if (!match) continue;
      const window = Object.keys(WINDOW_FILES).find((key) => WINDOW_FILES[key] === match[2]);
      if (!window || (allTimeOnly && window !== 'all')) continue;
      if (match[1] === '.' || match[1] === '..' || !SHA_PATTERN.test(entry.sha || '') || paths.has(entry.path)) {
        throw new Error('GitHub returned invalid company file metadata.');
      }
      paths.add(entry.path);
      files.push({ path: entry.path, sha: entry.sha, name: match[1], window });
    }
    if (!files.length) throw new Error('No all-time or time-window company CSV files were found in the source repository.');
    return files.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.path.localeCompare(b.path, 'en'));
  }

  function selectCompanyFiles(treeResponse) {
    return selectWindowFiles(treeResponse, true);
  }

  function encodedPath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  function sourceFileURL(commit, path) {
    if (!SHA_PATTERN.test(commit)) throw new Error('Invalid source commit.');
    return SOURCE_URL + '/blob/' + commit + '/' + encodedPath(path);
  }

  function rawFileURL(commit, path) {
    if (!SHA_PATTERN.test(commit)) throw new Error('Invalid source commit.');
    return RAW_URL + '/' + commit + '/' + encodedPath(path);
  }

  function reusableFile(file, cache) {
    const cached = cache && Object.prototype.hasOwnProperty.call(cache, file.path) && cache[file.path];
    return cached && cached.sha === file.sha && Array.isArray(cached.records) &&
      cached.records.every((record) => record && typeof record.slug === 'string' && SLUG_PATTERN.test(record.slug) &&
        typeof record.title === 'string' && (record.difficulty === null || ['Easy', 'Medium', 'Hard'].includes(record.difficulty)) &&
        Array.isArray(record.topics) && record.topics.every((topic) => typeof topic === 'string') &&
        (record.frequency === null ? record.rank === null : validFrequency(record.frequency) !== null && Number.isInteger(record.rank) && record.rank > 0)) &&
      new Set(cached.records.map((record) => record.slug)).size === cached.records.length ? cached : null;
  }

  function buildData(files, parsedFiles, commit, sourceUpdatedAt, lastSyncedAt) {
    const companies = [];
    const companyIds = new Map();
    const windows = Object.fromEntries(Object.keys(WINDOW_FILES).map((window) => [window, {
      index: Object.create(null), companyCount: 0, problemCount: 0, available: false
    }]));
    const storedFiles = Object.create(null);
    const allSlugs = new Set();
    for (const file of files) {
      const cached = reusableFile(file, parsedFiles);
      if (!cached) throw new Error('Cannot publish an incomplete company index.');
      const window = file.window || 'all';
      if (!Object.prototype.hasOwnProperty.call(WINDOW_FILES, window)) throw new Error('Invalid source time window.');
      let companyId = companyIds.get(file.name);
      if (companyId === undefined) {
        companyId = companies.length;
        companyIds.set(file.name, companyId);
        companies.push({ name: file.name, sourceUrl: sourceFileURL(commit, file.name + '/' + WINDOW_FILES.all) });
      }
      const windowData = windows[window];
      windowData.available = true;
      windowData.companyCount += 1;
      storedFiles[file.path] = cached;
      cached.records.forEach((record, recordIndex) => {
        if (!windowData.index[record.slug]) windowData.index[record.slug] = [];
        windowData.index[record.slug].push([companyId, recordIndex]);
        allSlugs.add(record.slug);
      });
    }
    for (const windowData of Object.values(windows)) windowData.problemCount = Object.keys(windowData.index).length;
    return { version: DATA_VERSION, schema: DATA_SCHEMA, commit, sourceUpdatedAt, lastSyncedAt, companies, windows, files: storedFiles,
      companyCount: companies.length, problemCount: allSlugs.size };
  }

  function windowAvailable(data, window = 'all') {
    if (!data || !Object.prototype.hasOwnProperty.call(WINDOW_FILES, window)) return false;
    if (data.schema !== DATA_SCHEMA) return window === 'all' && Boolean(data.index);
    return Boolean(data.windows && data.windows[window] && data.windows[window].index && data.windows[window].available !== false);
  }

  function companiesForSlug(data, slug, window = 'all') {
    if (!windowAvailable(data, window) || !Array.isArray(data.companies) || !SLUG_PATTERN.test(slug || '')) return [];
    const index = data.schema === DATA_SCHEMA ? data.windows[window].index : data.index;
    if (!Object.prototype.hasOwnProperty.call(index, slug) || !Array.isArray(index[slug])) return [];
    const companies = index[slug].map((entry) => {
      const id = data.version === DATA_VERSION && Array.isArray(entry) ? entry[0] : entry;
      const company = Number.isInteger(id) && id >= 0 ? data.companies[id] : null;
      if (!company || typeof company.name !== 'string' || typeof company.sourceUrl !== 'string') return null;
      if (data.schema === DATA_SCHEMA) {
        const path = company.name + '/' + WINDOW_FILES[window];
        const file = data.files && data.files[path];
        const record = file && Array.isArray(file.records) && file.records[entry[1]];
        if (!record || record.slug !== slug) return null;
        return { name: company.name, sourceUrl: sourceFileURL(data.commit, path), frequency: validFrequency(record.frequency), rank: record.rank };
      }
      const frequency = data.version === DATA_VERSION && Array.isArray(entry) ? validFrequency(entry[1]) : null;
      return { name: company.name, sourceUrl: company.sourceUrl, frequency, rank: null };
    });
    return sortCompanies(companies);
  }

  function practiceQuestions(data, options) {
    const window = options.window || 'all';
    const available = windowAvailable(data, window) && data.schema === DATA_SCHEMA;
    const empty = { questions: [], total: 0, topics: [], available, windowAvailable: available };
    if (!available || typeof options.company !== 'string') return empty;
    const path = options.company + '/' + WINDOW_FILES[window];
    const file = data.files && Object.prototype.hasOwnProperty.call(data.files, path) && data.files[path];
    if (!file || !Array.isArray(file.records)) return empty;
    const topics = Array.from(new Set(file.records.flatMap((record) => record.topics))).sort((a, b) => a.localeCompare(b, 'en'));
    const difficulty = typeof options.difficulty === 'string' ? options.difficulty.toLowerCase() : '';
    const topic = typeof options.topic === 'string' ? options.topic.toLowerCase() : '';
    const filtered = file.records.filter((record) => record.slug !== options.excludeSlug &&
      (!difficulty || (record.difficulty || '').toLowerCase() === difficulty) &&
      (!topic || record.topics.some((value) => value.toLowerCase() === topic)));
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 20;
    const questions = filtered.slice(0, limit).map((record) => Object.assign({}, record, {
      topics: record.topics.slice(), url: 'https://leetcode.com/problems/' + record.slug + '/'
    }));
    return { questions, total: filtered.length, topics, available: true, windowAvailable: true,
      sourceUrl: sourceFileURL(data.commit, path) };
  }

  return { SOURCE_URL, API_URL, RAW_URL, DATA_VERSION, DATA_SCHEMA, WINDOW_FILES, SHA_PATTERN, SLUG_PATTERN, getProblemSlug, formatProblemTitle,
    parseCSV, parseCompanyCSV, parseCompanyRecords, sortCompanies, selectCompanyFiles, selectWindowFiles, encodedPath, sourceFileURL, rawFileURL,
    reusableFile, buildData, companiesForSlug, windowAvailable, practiceQuestions };
});
