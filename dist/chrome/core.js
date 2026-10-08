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
  const SORT_OPTIONS = Object.freeze({
    searchProblems: Object.freeze(['relevance', 'name-asc', 'name-desc', 'difficulty-asc', 'difficulty-desc', 'companies-desc', 'companies-asc']),
    searchCompanies: Object.freeze(['name-asc', 'name-desc', 'questions-desc', 'questions-asc']),
    practiceQuestions: Object.freeze(['frequency-desc', 'frequency-asc', 'name-asc', 'name-desc', 'difficulty-asc', 'difficulty-desc', 'companies-desc', 'companies-asc']),
    sortCompanies: Object.freeze(['frequency-desc', 'frequency-asc', 'name-asc', 'name-desc', 'questions-desc', 'questions-asc'])
  });
  const DIFFICULTY_ORDER = Object.freeze({ Easy: 0, Medium: 1, Hard: 2 });

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

  function selectedSort(value, endpoint, fallback) {
    return SORT_OPTIONS[endpoint].includes(value) ? value : fallback;
  }

  function compareText(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'en');
  }

  function compareNullableNumbers(a, b, direction) {
    const first = typeof a === 'number' && Number.isFinite(a) && a >= 0 ? a : null;
    const second = typeof b === 'number' && Number.isFinite(b) && b >= 0 ? b : null;
    if (first === null && second !== null) return 1;
    if (first !== null && second === null) return -1;
    return first === null ? 0 : direction * (first - second);
  }

  function compareCompanyRows(a, b, sort) {
    const byName = compareText(a.name, b.name), bySlug = compareText(a.slug, b.slug);
    if (sort === 'name-asc') return byName || bySlug;
    if (sort === 'name-desc') return -byName || bySlug;
    const field = sort.startsWith('questions-') ? 'problemCount' : 'frequency';
    return compareNullableNumbers(a[field], b[field], sort.endsWith('-asc') ? 1 : -1) || byName || bySlug;
  }

  function sortCompanies(companies, sort = 'frequency-desc') {
    if (!Array.isArray(companies)) return [];
    const mode = selectedSort(sort, 'sortCompanies', 'frequency-desc');
    return companies.filter((company) => company && typeof company.name === 'string')
      .map((company) => Object.assign({}, company, { frequency: validFrequency(company.frequency) }))
      .sort((a, b) => compareCompanyRows(a, b, mode));
  }

  function problemRelevance(problem, query) {
    if (!query) return 2;
    const title = normalizedSearchText(problem.title), slug = normalizedSearchText(problem.slug);
    if (title === query || slug === query) return 0;
    return title.startsWith(query) || slug.startsWith(query) ? 1 : 2;
  }

  function compareProblemRows(a, b, sort, query = '') {
    const byTitle = compareText(a.title, b.title), bySlug = compareText(a.slug, b.slug);
    if (sort === 'name-asc') return byTitle || bySlug;
    if (sort === 'name-desc') return -byTitle || bySlug;
    let byMetric;
    if (sort === 'relevance') byMetric = problemRelevance(a, query) - problemRelevance(b, query);
    else {
      const difficulty = sort.startsWith('difficulty-');
      const field = sort.startsWith('companies-') ? 'companyCount' : 'frequency';
      const first = difficulty && Object.prototype.hasOwnProperty.call(DIFFICULTY_ORDER, a.difficulty) ? DIFFICULTY_ORDER[a.difficulty] : difficulty ? null : a[field];
      const second = difficulty && Object.prototype.hasOwnProperty.call(DIFFICULTY_ORDER, b.difficulty) ? DIFFICULTY_ORDER[b.difficulty] : difficulty ? null : b[field];
      byMetric = compareNullableNumbers(first, second, sort.endsWith('-asc') ? 1 : -1);
    }
    return byMetric || byTitle || bySlug;
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

  // Count only associations whose company and selected-window record still
  // match the requested slug. Duplicate or malformed reverse-index entries
  // must never inflate a popularity count or expose stale company tags.
  function matchingCompanyRecords(data, slug, window) {
    const index = data.windows && data.windows[window] && data.windows[window].index;
    const matches = new Map();
    if (!index || !Object.prototype.hasOwnProperty.call(index, slug) || !Array.isArray(index[slug])) return [];
    for (const entry of index[slug]) {
      if (!Array.isArray(entry) || !Number.isInteger(entry[0]) || entry[0] < 0 || !Number.isInteger(entry[1]) || entry[1] < 0) continue;
      const company = data.companies[entry[0]];
      if (!company || typeof company.name !== 'string' || !company.name || typeof company.sourceUrl !== 'string' || matches.has(company.name)) continue;
      const path = company.name + '/' + WINDOW_FILES[window];
      const file = data.files && Object.prototype.hasOwnProperty.call(data.files, path) && data.files[path];
      const record = file && Array.isArray(file.records) && file.records[entry[1]];
      if (!record || record.slug !== slug) continue;
      matches.set(company.name, { company, path, file, record });
    }
    return Array.from(matches.values());
  }

  function companiesForSlug(data, slug, window = 'all') {
    if (!windowAvailable(data, window) || !Array.isArray(data.companies) || !SLUG_PATTERN.test(slug || '')) return [];
    if (data.schema === DATA_SCHEMA) {
      return sortCompanies(matchingCompanyRecords(data, slug, window).map(({ company, path, file, record }) => ({
        name: company.name, sourceUrl: sourceFileURL(data.commit, path), frequency: validFrequency(record.frequency),
        rank: record.rank, problemCount: file.records.length
      })));
    }
    if (!Object.prototype.hasOwnProperty.call(data.index, slug) || !Array.isArray(data.index[slug])) return [];
    const companies = data.index[slug].map((entry) => {
      const id = data.version === DATA_VERSION && Array.isArray(entry) ? entry[0] : entry;
      const company = Number.isInteger(id) && id >= 0 ? data.companies[id] : null;
      if (!company || typeof company.name !== 'string' || typeof company.sourceUrl !== 'string') return null;
      const frequency = data.version === DATA_VERSION && Array.isArray(entry) ? validFrequency(entry[1]) : null;
      return { name: company.name, sourceUrl: company.sourceUrl, frequency, rank: null, problemCount: null };
    });
    return sortCompanies(companies);
  }

  function normalizedSearchText(value) {
    return String(value || '').toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function queryTerms(value) {
    const query = normalizedSearchText(typeof value === 'string' ? value : '');
    return { query, terms: query ? query.split(' ') : [] };
  }

  function matchesProblem(record, terms) {
    const text = normalizedSearchText(record.title) + ' ' + normalizedSearchText(record.slug);
    return terms.every((term) => text.includes(term));
  }

  function pagination(options, defaultLimit) {
    return {
      offset: Number.isInteger(options.offset) && options.offset >= 0 ? Math.min(options.offset, 1000000) : 0,
      limit: Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : defaultLimit
    };
  }

  function searchAvailability(data, window) {
    return Boolean(data && data.schema === DATA_SCHEMA && windowAvailable(data, window) &&
      Array.isArray(data.companies) && data.files);
  }

  function searchProblems(data, options = {}) {
    const window = options.window || 'all';
    const available = searchAvailability(data, window);
    const { offset, limit } = pagination(options, 50);
    const empty = { problems: [], total: 0, offset, limit, hasMore: false, available, windowAvailable: available };
    if (!available) return empty;
    const { query, terms } = queryTerms(options.query);
    const difficulty = typeof options.difficulty === 'string' ? options.difficulty.toLowerCase() : '';
    const sort = selectedSort(options.sort, 'searchProblems', 'relevance');
    const problems = [];
    for (const [slug, entries] of Object.entries(data.windows[window].index)) {
      if (!SLUG_PATTERN.test(slug) || !Array.isArray(entries)) continue;
      let representative = null, knownDifficulty = null;
      const companies = new Set();
      for (const { company, record } of matchingCompanyRecords(data, slug, window)) {
        companies.add(company.name);
        if (!representative) representative = record;
        if (!knownDifficulty && ['Easy', 'Medium', 'Hard'].includes(record.difficulty)) knownDifficulty = record.difficulty;
      }
      if (!representative || !companies.size) continue;
      const problem = { slug, title: typeof representative.title === 'string' && representative.title.trim() ?
        representative.title : formatProblemTitle(slug), difficulty: knownDifficulty,
        companyCount: companies.size, url: 'https://leetcode.com/problems/' + slug + '/' };
      if ((!difficulty || (problem.difficulty || '').toLowerCase() === difficulty) && matchesProblem(problem, terms)) problems.push(problem);
    }
    problems.sort((a, b) => compareProblemRows(a, b, sort, query));
    const page = problems.slice(offset, offset + limit);
    return { problems: page, total: problems.length, offset, limit, hasMore: offset + page.length < problems.length,
      available: true, windowAvailable: true };
  }

  function searchCompanies(data, options = {}) {
    const window = options.window || 'all';
    const available = searchAvailability(data, window);
    const { offset, limit } = pagination(options, 50);
    const empty = { companies: [], total: 0, offset, limit, hasMore: false, available, windowAvailable: available };
    if (!available) return empty;
    const query = typeof options.query === 'string' ? options.query.toLowerCase().trim() : '';
    const terms = query ? query.split(/\s+/) : [];
    const names = new Set();
    const companies = [];
    for (const company of data.companies) {
      if (!company || typeof company.name !== 'string' || names.has(company.name)) continue;
      const path = company.name + '/' + WINDOW_FILES[window];
      const file = Object.prototype.hasOwnProperty.call(data.files, path) && data.files[path];
      if (!file || !Array.isArray(file.records) || !terms.every((term) => company.name.toLowerCase().includes(term))) continue;
      names.add(company.name);
      companies.push({ name: company.name, problemCount: file.records.length, sourceUrl: sourceFileURL(data.commit, path) });
    }
    const sort = selectedSort(options.sort, 'searchCompanies', 'name-asc');
    companies.sort((a, b) => compareCompanyRows(a, b, sort));
    const page = companies.slice(offset, offset + limit);
    return { companies: page, total: companies.length, offset, limit, hasMore: offset + page.length < companies.length,
      available: true, windowAvailable: true };
  }

  function practiceQuestions(data, options = {}) {
    const window = options.window || 'all';
    const available = searchAvailability(data, window);
    const { offset, limit } = pagination(options, 20);
    const empty = { questions: [], total: 0, topics: [], offset, limit, hasMore: false, available, windowAvailable: available };
    if (!available || typeof options.company !== 'string') return empty;
    const path = options.company + '/' + WINDOW_FILES[window];
    const file = data.files && Object.prototype.hasOwnProperty.call(data.files, path) && data.files[path];
    if (!file || !Array.isArray(file.records)) return empty;
    const topics = Array.from(new Set(file.records.flatMap((record) => record.topics))).sort((a, b) => a.localeCompare(b, 'en'));
    const difficulty = typeof options.difficulty === 'string' ? options.difficulty.toLowerCase() : '';
    const topic = typeof options.topic === 'string' ? options.topic.toLowerCase() : '';
    const { terms } = queryTerms(options.query);
    const sort = selectedSort(options.sort, 'practiceQuestions', 'frequency-desc');
    const filtered = file.records.filter((record) => record.slug !== options.excludeSlug &&
      (!difficulty || (record.difficulty || '').toLowerCase() === difficulty) &&
      (!topic || record.topics.some((value) => value.toLowerCase() === topic)) && matchesProblem(record, terms))
      .map((record) => Object.assign({}, record, { topics: record.topics.slice(),
        companyCount: matchingCompanyRecords(data, record.slug, window).length,
        url: 'https://leetcode.com/problems/' + record.slug + '/' }));
    filtered.sort((a, b) => compareProblemRows(a, b, sort));
    const questions = filtered.slice(offset, offset + limit);
    return { questions, total: filtered.length, topics, offset, limit, hasMore: offset + questions.length < filtered.length,
      available: true, windowAvailable: true, sourceUrl: sourceFileURL(data.commit, path) };
  }

  return { SOURCE_URL, API_URL, RAW_URL, DATA_VERSION, DATA_SCHEMA, WINDOW_FILES, SHA_PATTERN, SLUG_PATTERN, SORT_OPTIONS, getProblemSlug, formatProblemTitle,
    parseCSV, parseCompanyCSV, parseCompanyRecords, sortCompanies, selectCompanyFiles, selectWindowFiles, encodedPath, sourceFileURL, rawFileURL,
    reusableFile, buildData, companiesForSlug, windowAvailable, practiceQuestions, searchProblems, searchCompanies };
});
