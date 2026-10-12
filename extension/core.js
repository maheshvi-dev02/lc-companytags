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
  const ACCEPTANCE_VERSION = 1;
  const ACCEPTANCE_TOOLTIP = 'Percentage of LeetCode submissions accepted for this problem, across all users.';
  // This pinned source revision has the verified upstream 100x fraction scale
  // bug (issue #49). Unknown revisions never inherit the correction by magnitude.
  const SCALED_ACCEPTANCE_COMMITS = new Set(['03850eb5d16892514491cf1381c32ec0330a2719']);
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

  function validAcceptanceRate(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  }

  function formatAcceptanceRate(value) {
    const rate = validAcceptanceRate(value);
    return rate === null ? null : rate.toFixed(1) + '%';
  }

  function acceptanceNumber(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const text = value.trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function acceptanceFormat(rows, column, options) {
    if (['fraction', 'percent', 'scaled-fraction'].includes(options.acceptanceFormat)) return options.acceptanceFormat;
    if (SCALED_ACCEPTANCE_COMMITS.has(options.commit)) return 'scaled-fraction';
    const numbers = rows.slice(1).map((row) => acceptanceNumber(row[column])).filter((value) => value !== null && value <= 100);
    const maximum = numbers.length ? Math.max(...numbers) : null;
    // Infer one scale for the whole column, never a different scale per row.
    // All-tiny values could be legitimate low fractions or an unknown source
    // scale regression; keep them unavailable without verified provenance.
    if (maximum !== null && maximum > 1) return 'percent';
    if (maximum !== null && maximum > 0.01) return 'fraction';
    return null;
  }

  function parseAcceptanceRate(value, format) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    const percent = text.endsWith('%');
    const number = acceptanceNumber(percent ? text.slice(0, -1) : text);
    if (number === null) return null;
    if (percent) return validAcceptanceRate(number);
    const multiplier = format === 'fraction' ? 100 : format === 'scaled-fraction' ? 10000 : format === 'percent' ? 1 : null;
    return multiplier === null ? null : validAcceptanceRate(number * multiplier);
  }

  function parseCompanyRecords(text, options = {}) {
    const rows = parseCSV(text);
    if (!rows.length) throw new Error('Company CSV is empty.');
    const header = rows[0].map((value) => value.trim().toLowerCase());
    const linkColumn = header.indexOf('link');
    const frequencyColumn = header.indexOf('frequency');
    const titleColumn = header.indexOf('title');
    const difficultyColumn = header.indexOf('difficulty');
    const topicsColumn = header.indexOf('topics');
    const acceptanceColumn = header.indexOf('acceptance rate');
    const acceptanceUnit = acceptanceColumn === -1 ? null : acceptanceFormat(rows, acceptanceColumn, options);
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
          acceptanceRate: acceptanceColumn === -1 ? null : parseAcceptanceRate(row[acceptanceColumn], acceptanceUnit),
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
        Object.prototype.hasOwnProperty.call(record, 'acceptanceRate') &&
        (record.acceptanceRate === null || validAcceptanceRate(record.acceptanceRate) !== null) &&
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
    const problems = Object.create(null);
    // Acceptance belongs to a problem. Prefer all-time rows and then a stable
    // company order so every company/window view shows the same source value.
    const orderedFiles = files.slice().sort((a, b) => ((a.window || 'all') === 'all' ? 0 : 1) -
      ((b.window || 'all') === 'all' ? 0 : 1) || a.name.localeCompare(b.name, 'en') || a.path.localeCompare(b.path, 'en'));
    for (const file of orderedFiles) for (const record of storedFiles[file.path].records) {
      let problem = problems[record.slug];
      if (!problem) problem = problems[record.slug] = { title: record.title, difficulty: record.difficulty, acceptanceRate: null };
      if (!problem.difficulty && record.difficulty) problem.difficulty = record.difficulty;
      if (problem.acceptanceRate === null) problem.acceptanceRate = validAcceptanceRate(record.acceptanceRate);
    }
    return { version: DATA_VERSION, schema: DATA_SCHEMA, acceptanceVersion: ACCEPTANCE_VERSION, commit, sourceUpdatedAt, lastSyncedAt, companies, windows, files: storedFiles, problems,
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

  function hasAcceptanceData(data) {
    return Boolean(data && data.acceptanceVersion === ACCEPTANCE_VERSION && data.problems && typeof data.problems === 'object' && !Array.isArray(data.problems));
  }

  function problemForSlug(data, slug) {
    if (!hasAcceptanceData(data) || !SLUG_PATTERN.test(slug || '') || !Object.prototype.hasOwnProperty.call(data.problems, slug)) return null;
    const problem = data.problems[slug];
    if (!problem || typeof problem.title !== 'string') return null;
    return { title: problem.title, difficulty: ['Easy', 'Medium', 'Hard'].includes(problem.difficulty) ? problem.difficulty : null,
      acceptanceRate: validAcceptanceRate(problem.acceptanceRate) };
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

  function compareTopicLabels(a, b) {
    return compareText(a, b) || (a < b ? -1 : a > b ? 1 : 0);
  }

  function searchProblems(data, options = {}) {
    const window = options.window || 'all';
    const available = searchAvailability(data, window);
    const { offset, limit } = pagination(options, 50);
    const sourceRevision = data && typeof data.commit === 'string' && SHA_PATTERN.test(data.commit) ? data.commit : null;
    const empty = { problems: [], total: 0, topics: [], topicGroups: [], offset, limit, hasMore: false,
      available, windowAvailable: available, sourceRevision };
    if (!available) return empty;
    const { query, terms } = queryTerms(options.query);
    const difficulty = typeof options.difficulty === 'string' ? options.difficulty.toLowerCase() : '';
    const sort = selectedSort(options.sort, 'searchProblems', 'relevance');
    const selectedTopics = Array.isArray(options.topics) ? Array.from(new Set(options.topics
      .filter((topic) => typeof topic === 'string').map((topic) => topic.trim().toLowerCase()).filter(Boolean))) : [];
    const topicMatch = options.topicMatch === 'all' ? 'all' : 'any';
    const groupTopic = typeof options.groupTopic === 'string' ? options.groupTopic.trim().toLowerCase() : options.groupTopic;
    const catalog = new Map();
    const candidates = [];
    for (const [slug, entries] of Object.entries(data.windows[window].index)) {
      if (!SLUG_PATTERN.test(slug) || !Array.isArray(entries)) continue;
      let representative = null, knownDifficulty = null;
      const companies = new Set(), topicKeys = new Set();
      for (const { company, record } of matchingCompanyRecords(data, slug, window)) {
        companies.add(company.name);
        if (!representative) representative = record;
        if (!knownDifficulty && ['Easy', 'Medium', 'Hard'].includes(record.difficulty)) knownDifficulty = record.difficulty;
        for (const topic of Array.isArray(record.topics) ? record.topics : []) {
          if (typeof topic !== 'string' || !topic.trim()) continue;
          const label = topic.trim(), key = label.toLowerCase();
          topicKeys.add(key);
          if (!catalog.has(key) || compareTopicLabels(label, catalog.get(key)) < 0) catalog.set(key, label);
        }
      }
      if (!representative || !companies.size) continue;
      const problem = { slug, title: typeof representative.title === 'string' && representative.title.trim() ?
        representative.title : formatProblemTitle(slug), difficulty: knownDifficulty,
        acceptanceRate: problemForSlug(data, slug)?.acceptanceRate ?? null,
        companyCount: companies.size, url: 'https://leetcode.com/problems/' + slug + '/' };
      candidates.push({ problem, topicKeys });
    }
    // Derive the catalog from the complete selected window before applying any
    // filters. Reuse its deterministic labels in every row and group.
    const topics = Array.from(catalog.values()).sort(compareTopicLabels);
    const groups = new Map(), problems = [];
    for (const { problem, topicKeys } of candidates) {
      if ((difficulty && (problem.difficulty || '').toLowerCase() !== difficulty) || !matchesProblem(problem, terms)) continue;
      if (selectedTopics.length && !(topicMatch === 'all' ? selectedTopics.every((topic) => topicKeys.has(topic)) :
        selectedTopics.some((topic) => topicKeys.has(topic)))) continue;
      problem.topics = Array.from(topicKeys, (key) => catalog.get(key)).sort(compareTopicLabels);
      // Count each unique matching problem once per source topic, before the
      // selected group and pagination narrow the returned rows.
      for (const key of topicKeys.size ? topicKeys : [null]) groups.set(key, (groups.get(key) || 0) + 1);
      if (groupTopic === null ? topicKeys.size > 0 : groupTopic !== undefined && !topicKeys.has(groupTopic)) continue;
      problems.push(problem);
    }
    const topicGroups = Array.from(groups, ([key, total]) => ({ topic: key === null ? null : catalog.get(key), total }))
      .sort((a, b) => a.topic === null ? (b.topic === null ? 0 : 1) : b.topic === null ? -1 : compareTopicLabels(a.topic, b.topic));
    problems.sort((a, b) => compareProblemRows(a, b, sort, query));
    const page = problems.slice(offset, offset + limit);
    return { problems: page, total: problems.length, topics, topicGroups, offset, limit, hasMore: offset + page.length < problems.length,
      available: true, windowAvailable: true, sourceRevision };
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
    const sourceRevision = data && typeof data.commit === 'string' && SHA_PATTERN.test(data.commit) ? data.commit : null;
    const empty = { questions: [], total: 0, topics: [], topicGroups: [], offset, limit, hasMore: false,
      available, windowAvailable: available, sourceRevision };
    if (!available || typeof options.company !== 'string') return empty;
    const path = options.company + '/' + WINDOW_FILES[window];
    const file = data.files && Object.prototype.hasOwnProperty.call(data.files, path) && data.files[path];
    if (!file || !Array.isArray(file.records)) return empty;
    const catalog = new Map();
    const candidates = file.records.map((record) => {
      const topicKeys = new Set();
      for (const topic of Array.isArray(record.topics) ? record.topics : []) {
        if (typeof topic !== 'string' || !topic.trim()) continue;
        const label = topic.trim(), key = label.toLowerCase();
        topicKeys.add(key);
        if (!catalog.has(key) || compareTopicLabels(label, catalog.get(key)) < 0) catalog.set(key, label);
      }
      return { record, topicKeys };
    });
    // Keep the complete company-window catalog available while filters narrow
    // the rows. Company topics never inherit another company's source tags.
    const topics = Array.from(catalog.values()).sort(compareTopicLabels);
    const difficulty = typeof options.difficulty === 'string' ? options.difficulty.toLowerCase() : '';
    const topic = typeof options.topic === 'string' ? options.topic.toLowerCase() : '';
    const selectedTopics = Array.isArray(options.topics) ? Array.from(new Set(options.topics
      .filter((value) => typeof value === 'string').map((value) => value.trim().toLowerCase()).filter(Boolean))) : [];
    const topicMatch = options.topicMatch === 'all' ? 'all' : 'any';
    const groupTopic = typeof options.groupTopic === 'string' ? options.groupTopic.trim().toLowerCase() : options.groupTopic;
    const { terms } = queryTerms(options.query);
    const sort = selectedSort(options.sort, 'practiceQuestions', 'frequency-desc');
    const filtered = [], groups = new Map();
    for (const { record, topicKeys } of candidates) {
      if (record.slug === options.excludeSlug || (difficulty && (record.difficulty || '').toLowerCase() !== difficulty) ||
          (topic && !record.topics.some((value) => value.toLowerCase() === topic)) || !matchesProblem(record, terms)) continue;
      if (selectedTopics.length && !(topicMatch === 'all' ? selectedTopics.every((value) => topicKeys.has(value)) :
        selectedTopics.some((value) => topicKeys.has(value)))) continue;
      for (const key of topicKeys.size ? topicKeys : [null]) {
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(record.slug);
      }
      if (groupTopic === null ? topicKeys.size > 0 : groupTopic !== undefined && !topicKeys.has(groupTopic)) continue;
      filtered.push(Object.assign({}, record, { topics: Array.from(topicKeys, (key) => catalog.get(key)).sort(compareTopicLabels),
        acceptanceRate: problemForSlug(data, record.slug)?.acceptanceRate ?? null,
        companyCount: matchingCompanyRecords(data, record.slug, window).length,
        url: 'https://leetcode.com/problems/' + record.slug + '/' }));
    }
    const topicGroups = Array.from(groups, ([key, slugs]) => ({ topic: key === null ? null : catalog.get(key), total: slugs.size }))
      .sort((a, b) => a.topic === null ? (b.topic === null ? 0 : 1) : b.topic === null ? -1 : compareTopicLabels(a.topic, b.topic));
    filtered.sort((a, b) => compareProblemRows(a, b, sort));
    const questions = filtered.slice(offset, offset + limit);
    return { questions, total: filtered.length, topics, topicGroups, offset, limit, hasMore: offset + questions.length < filtered.length,
      available: true, windowAvailable: true, sourceUrl: sourceFileURL(data.commit, path), sourceRevision };
  }

  return { SOURCE_URL, API_URL, RAW_URL, DATA_VERSION, DATA_SCHEMA, ACCEPTANCE_VERSION, ACCEPTANCE_TOOLTIP, WINDOW_FILES, SHA_PATTERN, SLUG_PATTERN, SORT_OPTIONS, getProblemSlug, formatProblemTitle,
    parseCSV, parseCompanyCSV, parseCompanyRecords, sortCompanies, selectCompanyFiles, selectWindowFiles, encodedPath, sourceFileURL, rawFileURL,
    validAcceptanceRate, formatAcceptanceRate, hasAcceptanceData, problemForSlug, reusableFile, buildData, companiesForSlug, windowAvailable, practiceQuestions, searchProblems, searchCompanies };
});
