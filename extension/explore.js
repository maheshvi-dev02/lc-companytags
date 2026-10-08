(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.LCTCore;
  const logos = globalThis.LCTCompanyLogos;
  const $ = id => document.getElementById(id);
  const labels = { all: 'All time', '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months', older: 'Older than 6 months' };
  const defaults = { enabled: true, collapsed: false, window: 'all' };
  const params = new URLSearchParams(location.search);
  let mode = params.get('mode') === 'companies' ? 'companies' : 'problems';
  const queries = { problems: '', companies: '' };
  queries[mode] = (params.get('query') || '').slice(0, 200);
  let settings = { ...defaults };
  let status = {};
  let refreshError = '';
  let generation = 0;
  let listRequest = 0;
  let detailRequest = 0;
  let searchTimer;
  let questionTimer;
  let list = { rows: [], total: 0, hasMore: false, available: false, loading: false, error: '', version: null };
  const stack = [];
  const windowKey = () => Object.hasOwn(labels, settings.window) ? settings.window : 'all';
  const activeDetail = () => stack[stack.length - 1];
  const version = () => `${mode}|${windowKey()}|${status.commit || ''}`;
  const count = value => Number(value || 0).toLocaleString();
  const listVersion = () => `${version()}|${queries[mode]}`;
  const invalidate = () => {
    generation++; clearTimeout(searchTimer); clearTimeout(questionTimer);
    list.loading = false;
    for (const frame of stack) frame.loading = false;
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function date(value) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  function sourceURL(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/liquidslr/leetcode-company-wise-problems/')) return url.href;
    } catch (_) { /* Use the known public dataset. */ }
    return core.SOURCE_URL;
  }
  function sourceLink(url, text = 'Source ↗') {
    const link = node('a', 'source-link', text);
    link.href = sourceURL(url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function problemLink(slug) {
    const link = node('a', 'leetcode-link');
    const icon = node('img', 'leetcode-icon');
    icon.src = api.runtime.getURL('icons/leetcode.svg');
    icon.alt = '';
    icon.width = 20; icon.height = 20;
    icon.setAttribute('aria-hidden', 'true');
    link.append(icon);
    link.href = `https://leetcode.com/problems/${encodeURIComponent(slug)}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open ${core.formatProblemTitle(slug)} on LeetCode`);
    link.title = `Open ${core.formatProblemTitle(slug)} on LeetCode`;
    return link;
  }
  function action(kind, value, text) {
    const button = node('button', '', text);
    button.type = 'button';
    button.dataset.action = kind;
    button.dataset[kind === 'problem' ? 'slug' : 'company'] = value;
    return button;
  }
  function unavailable() {
    if (!status.hasData) return 'The saved dataset is not available. Refresh the dataset to try again.';
    return status.phase === 'syncing' ? 'This time window is being updated. Your saved dataset will appear when it is ready.' : 'This time window is not available in the saved dataset. Refresh to load it.';
  }

  function renderStatus() {
    const bundled = status.dataSource === 'bundled' ? 'Bundled snapshot · ' : '';
    const failure = refreshError || (status.phase === 'error' ? status.message || 'Refresh failed. Your saved data is still available.' : '');
    const stale = status.lastCheckedAt && Date.now() - new Date(status.lastCheckedAt).getTime() > 48 * 60 * 60 * 1000;
    $('dataset-state').textContent = status.phase === 'syncing' ? 'Syncing' : failure ? 'Saved data' : status.hasData ? 'Ready' : 'Not synced';
    $('dataset-state').toggleAttribute('data-warning', Boolean(failure || stale));
    $('dataset-summary').textContent = status.hasData ? `${count(status.companyCount)} companies · ${count(status.problemCount)} problems indexed` : '';
    $('window-note').textContent = status.sourceUpdatedAt ? `${bundled}Windows relative to source updated ${date(status.sourceUpdatedAt)}` : 'Time windows follow the dates in the source dataset.';
    const revision = /^[a-f0-9]{40}$/i.test(status.commit || '') ? status.commit : '';
    $('source').href = revision ? `${core.SOURCE_URL}/tree/${revision}` : core.SOURCE_URL;
    $('source').title = revision ? `Dataset revision ${revision.slice(0, 7)}` : 'Public company dataset';
    $('status').toggleAttribute('data-warning', Boolean(failure || stale));
    if (failure) $('status').textContent = `${status.hasData ? 'Showing saved data. ' : ''}${failure}`;
    else if (status.phase === 'syncing') $('status').textContent = status.total > 0 ? `${bundled}Updating in the background · ${count(status.completed)} of ${count(status.total)}` : `${bundled}Checking the latest dataset…`;
    else if (status.sourceUpdatedAt) $('status').textContent = `${bundled}Source updated ${date(status.sourceUpdatedAt)}${revision ? ` · revision ${revision.slice(0, 7)}` : ''}`;
    else $('status').textContent = status.hasData ? 'Saved dataset ready for offline use.' : 'Preparing the saved dataset…';
    $('refresh').disabled = status.phase === 'syncing';
    $('refresh').textContent = status.phase === 'syncing' ? 'Updating…' : 'Refresh dataset';
    $('progress').hidden = status.phase !== 'syncing';
    if (status.total > 0) { $('progress').max = status.total; $('progress').value = Math.min(status.completed || 0, status.total); }
    else $('progress').removeAttribute('value');
  }

  function renderShell() {
    for (const key of ['problems', 'companies']) {
      const selected = key === mode;
      $(`mode-${key}`).setAttribute('aria-selected', String(selected));
      $(`mode-${key}`).tabIndex = selected ? 0 : -1;
    }
    $('global-search').value = queries[mode];
    $('global-search').placeholder = mode === 'problems' ? 'Search problems by title or slug' : 'Search all source companies';
    $('global-search').setAttribute('aria-label', mode === 'problems' ? 'Search problems' : 'Search all source companies');
    $('search-label').textContent = mode === 'problems' ? 'Search problems' : 'Search companies';
    $('search-heading').textContent = mode === 'problems' ? 'Find a problem. See its companies.' : 'Choose a company. Explore its questions.';
    $('search-help').textContent = mode === 'problems' ? 'Search the saved dataset by problem title or slug.' : 'Search every source company, including companies with no questions in this window.';
    $('window-select').value = windowKey();
    $('search-view').hidden = Boolean(activeDetail());
    $('detail-view').hidden = !activeDetail();
    $('results').setAttribute('aria-label', mode === 'problems' ? 'Problem search results' : 'Company search results');
    $('load-more').textContent = `Load more ${mode}`;
    $('result-order').textContent = 'A–Z';
  }

  function problemRow(problem, companyView = false) {
    const row = node('li', 'result-row question-row');
    row.dataset.slug = problem.slug;
    const info = node('div', 'result-info');
    info.append(node('h3', companyView ? 'question-title' : 'result-title', problem.title || core.formatProblemTitle(problem.slug)));
    if (companyView) {
      const score = Number.isFinite(problem.frequency) && problem.frequency >= 0 ? String(problem.frequency) : 'unavailable';
      const rank = Number.isInteger(problem.rank) && problem.rank > 0 ? `company rank #${problem.rank}` : 'rank unavailable';
      info.append(node('span', 'question-meta', `${problem.difficulty || 'Difficulty unavailable'} · score ${score} · ${rank}`));
      if (Array.isArray(problem.topics) && problem.topics.length) info.append(node('span', 'question-topics', problem.topics.join(' · ')));
    } else info.append(node('span', 'result-meta', `${problem.difficulty || 'Difficulty unavailable'} · ${count(problem.companyCount)} ${problem.companyCount === 1 ? 'company' : 'companies'}`));
    const actions = node('div', 'result-actions');
    const button = action('problem', problem.slug, 'View companies');
    button.setAttribute('aria-label', `View companies for ${problem.title || core.formatProblemTitle(problem.slug)}`);
    button.addEventListener('click', () => openDetail({ kind: 'problem', slug: problem.slug, title: problem.title || core.formatProblemTitle(problem.slug), difficulty: problem.difficulty }));
    actions.append(button, problemLink(problem.slug));
    row.append(info, actions);
    return row;
  }
  function companyRow(company, problemView = false) {
    const row = node('li', 'result-row company-row');
    row.dataset.company = company.name;
    const info = node('div', 'result-info');
    const button = action('company', company.name, company.name);
    button.className = 'company-title';
    button.replaceChildren(logos.createBadge(company.name), node('span', 'company-name', company.name));
    button.setAttribute('aria-label', `View questions for ${company.name}`);
    button.addEventListener('click', () => openDetail({ kind: 'company', name: company.name, title: company.name, sourceUrl: company.sourceUrl }));
    info.append(button);
    if (problemView) {
      info.append(node('span', 'company-rank', Number.isInteger(company.rank) && company.rank > 0 ? `Company rank #${company.rank}` : 'Rank unavailable'));
      const score = node('div', 'company-score');
      score.append(node('span', 'frequency-score', Number.isFinite(company.frequency) && company.frequency >= 0 ? String(company.frequency) : '—'), node('span', 'score-label', 'Frequency score'));
      row.append(info, score, sourceLink(company.sourceUrl));
    } else {
      info.append(node('span', 'result-meta', `${count(company.problemCount)} ${company.problemCount === 1 ? 'question' : 'questions'} in this window`));
      const actions = node('div', 'result-actions');
      const questions = action('company', company.name, 'View questions');
      questions.setAttribute('aria-label', `Browse ${company.name} questions`);
      questions.addEventListener('click', () => openDetail({ kind: 'company', name: company.name, title: company.name, sourceUrl: company.sourceUrl }));
      actions.append(questions, sourceLink(company.sourceUrl));
      row.append(info, actions);
    }
    return row;
  }

  function renderListRows(rows, append = false) {
    const nodes = rows.map(row => mode === 'problems' ? problemRow(row) : companyRow(row));
    if (append) $('results').append(...nodes); else $('results').replaceChildren(...nodes);
  }
  function renderListSummary() {
    $('results').setAttribute('aria-busy', String(list.loading));
    $('result-summary').textContent = list.loading ? `Loading saved ${mode}…` : `${count(list.rows.length)} of ${count(list.total)} ${mode}${queries[mode].trim() ? ' matching your search' : ''}`;
    const message = list.error || (!list.loading && !list.available ? unavailable() : !list.loading && !list.total ? `No ${mode} match your search in this time window.` : '');
    $('search-message').textContent = message;
    $('search-message').hidden = !message;
    $('search-message').toggleAttribute('data-error', Boolean(list.error));
    $('search-retry').hidden = !list.error;
    $('load-more').hidden = !list.hasMore;
    $('load-more').disabled = list.loading;
  }
  async function loadList(append = false) {
    if (activeDetail()) return;
    if (append && list.version !== listVersion()) append = false;
    const id = ++listRequest;
    const stamp = generation;
    const requestedMode = mode;
    const requestedWindow = windowKey();
    if (!append) { list.rows = []; list.total = 0; list.hasMore = false; list.version = null; renderListRows([]); }
    list.loading = true; list.error = '';
    renderListSummary();
    try {
      const result = await api.runtime.sendMessage({ type: requestedMode === 'problems' ? 'LCT_SEARCH_PROBLEMS' : 'LCT_SEARCH_COMPANIES', query: queries[requestedMode], window: requestedWindow, offset: append ? list.rows.length : 0, limit: 50 });
      if (id !== listRequest || stamp !== generation || activeDetail()) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not search the saved dataset. Try again.');
      const rows = requestedMode === 'problems' ? result.problems : result.companies;
      const next = Array.isArray(rows) ? rows : [];
      status = result.status || status;
      list.rows = append ? list.rows.concat(next) : next;
      list.total = Number(result.total) || 0;
      list.available = result.available !== false;
      list.hasMore = Boolean(result.hasMore);
      list.version = listVersion();
      renderListRows(next, append);
      renderStatus();
    } catch (cause) { if (id === listRequest && stamp === generation) list.error = cause.message || 'Could not load the saved dataset.'; }
    finally { if (id === listRequest && stamp === generation && !activeDetail()) { list.loading = false; renderListSummary(); } }
  }

  function renderTopics(frame) {
    const selected = frame.filters.topic;
    const topics = Array.isArray(frame.topics) ? frame.topics : [];
    const values = selected && !topics.includes(selected) ? [selected, ...topics] : topics;
    const all = node('option', '', 'All topics'); all.value = '';
    $('topic-select').replaceChildren(all, ...values.map(topic => { const option = node('option', '', topic); option.value = topic; return option; }));
    $('topic-select').value = selected;
  }
  function renderDetailShell() {
    const frame = activeDetail();
    if (!frame) return;
    const previous = stack[stack.length - 2];
    $('detail-back').textContent = previous ? `← Back to ${previous.title}` : `← Back to ${mode === 'problems' ? 'problem' : 'company'} results`;
    $('detail-kind').textContent = frame.kind === 'problem' ? 'Problem companies' : 'Company questions';
    $('detail-title').textContent = frame.title;
    $('detail-name').classList.toggle('company-heading', frame.kind === 'company');
    $('detail-name').replaceChildren(...(frame.kind === 'company' ? [logos.createBadge(frame.name), $('detail-title')] : [$('detail-title')]));
    $('detail-context').textContent = frame.kind === 'problem' ? `${frame.difficulty || 'Difficulty unavailable'} · ${labels[windowKey()].toLowerCase()}` : `Every question listed for ${frame.name} · ${labels[windowKey()].toLowerCase()}`;
    $('detail-filters').hidden = frame.kind !== 'company';
    $('detail-results').setAttribute('aria-label', frame.kind === 'problem' ? 'Companies listed for this problem' : 'Company questions sorted by frequency');
    $('detail-source').hidden = !frame.sourceUrl;
    if (frame.sourceUrl) $('detail-source').href = sourceURL(frame.sourceUrl);
    if (frame.kind === 'company') {
      $('difficulty-select').value = frame.filters.difficulty;
      $('question-search').value = frame.filters.query;
      renderTopics(frame);
    }
  }
  function renderDetailRows(rows, append = false) {
    const frame = activeDetail();
    if (!frame) return;
    const nodes = rows.map(row => frame.kind === 'problem' ? companyRow(row, true) : problemRow(row, true));
    if (append) $('detail-results').append(...nodes); else $('detail-results').replaceChildren(...nodes);
  }
  function renderDetailSummary() {
    const frame = activeDetail();
    if (!frame) return;
    const noun = frame.kind === 'problem' ? 'companies' : 'questions';
    $('detail-results').setAttribute('aria-busy', String(frame.loading));
    $('detail-summary').textContent = frame.loading ? `Loading saved ${noun}…` : `${count(frame.rows.length)} of ${count(frame.total)} ${noun}${frame.kind === 'company' && (frame.filters.query || frame.filters.topic || frame.filters.difficulty) ? ' matching your filters' : ''}`;
    const message = frame.error || (!frame.loading && !frame.available ? unavailable() : !frame.loading && !frame.total ? frame.kind === 'company' ? 'No questions match these filters in this time window.' : 'No company matches in this dataset. Coverage may be incomplete.' : '');
    $('detail-message').textContent = message;
    $('detail-message').hidden = !message;
    $('detail-message').toggleAttribute('data-error', Boolean(frame.error));
    $('detail-retry').hidden = !frame.error;
    $('detail-load-more').hidden = frame.kind !== 'company' || !frame.hasMore;
    $('detail-load-more').disabled = frame.loading;
    $('detail-order').textContent = frame.rows.some(row => Number.isFinite(row.frequency) && row.frequency >= 0) || frame.loading ? 'Highest frequency first' : 'Frequency unavailable · A–Z';
  }
  async function loadDetail(append = false) {
    const frame = activeDetail();
    if (!frame) return;
    if (append && frame.version !== version()) append = false;
    const id = ++detailRequest;
    const stamp = generation;
    if (!append) { frame.rows = []; frame.total = 0; frame.hasMore = false; frame.version = null; renderDetailRows([]); }
    frame.loading = true; frame.error = '';
    renderDetailSummary();
    try {
      const message = frame.kind === 'problem' ? { type: 'LCT_GET', slug: frame.slug, window: windowKey() } : { type: 'LCT_PRACTICE', company: frame.name, window: windowKey(), query: frame.filters.query, difficulty: frame.filters.difficulty, topic: frame.filters.topic, offset: append ? frame.rows.length : 0, limit: 50 };
      const result = await api.runtime.sendMessage(message);
      if (id !== detailRequest || stamp !== generation || frame !== activeDetail()) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load these details. Try again.');
      status = result.status || status;
      const next = frame.kind === 'problem' ? core.sortCompanies(Array.isArray(result.companies) ? result.companies : []) : Array.isArray(result.questions) ? result.questions : [];
      frame.rows = append ? frame.rows.concat(next) : next;
      frame.total = frame.kind === 'problem' ? next.length : Number(result.total) || 0;
      frame.available = result.available !== false;
      frame.hasMore = frame.kind === 'company' && Boolean(result.hasMore);
      frame.topics = result.topics || frame.topics;
      frame.sourceUrl = typeof result.sourceUrl === 'string' ? result.sourceUrl : null;
      frame.version = version();
      renderDetailRows(next, append);
      renderDetailShell();
      renderStatus();
    } catch (cause) { if (id === detailRequest && stamp === generation && frame === activeDetail()) frame.error = cause.message || 'Could not load these details.'; }
    finally { if (id === detailRequest && stamp === generation && frame === activeDetail()) { frame.loading = false; renderDetailSummary(); } }
  }

  function openDetail(value) {
    invalidate();
    stack.push({ ...value, rows: [], total: 0, hasMore: false, available: false, loading: false, error: '', topics: [], version: null, filters: { difficulty: '', topic: '', query: '' } });
    renderShell(); renderDetailShell();
    $('detail-back').focus();
    void loadDetail();
  }
  function focusResult(container, frame) {
    const button = Array.from(container.querySelectorAll('button[data-action]')).find(item => frame.kind === 'problem' ? item.dataset.slug === frame.slug : item.dataset.company === frame.name);
    (button || (activeDetail() ? $('detail-back') : $('global-search'))).focus();
  }
  function back() {
    const previous = stack.pop();
    invalidate(); renderShell();
    const frame = activeDetail();
    if (frame) {
      renderDetailShell(); renderDetailRows(frame.rows); renderDetailSummary();
      if (frame.version !== version()) void loadDetail();
      focusResult($('detail-results'), previous);
    } else {
      renderListRows(list.rows); renderListSummary();
      if (list.version !== listVersion()) void loadList();
      focusResult($('results'), previous);
    }
  }
  function switchMode(next) {
    invalidate(); mode = next; stack.length = 0;
    list = { rows: [], total: 0, hasMore: false, available: false, loading: false, error: '', version: null };
    renderShell(); $('global-search').focus(); void loadList();
  }
  function reloadCurrent() {
    invalidate();
    list.version = null;
    for (const frame of stack) { frame.version = null; frame.sourceUrl = null; }
    renderShell();
    if (activeDetail()) { renderDetailShell(); void loadDetail(); } else void loadList();
  }

  for (const key of ['problems', 'companies']) $(`mode-${key}`).addEventListener('click', () => switchMode(key));
  document.querySelector('.mode-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'problems' : event.key === 'End' ? 'companies' : mode === 'problems' ? 'companies' : 'problems';
    switchMode(next); $(`mode-${next}`).focus();
  });
  $('global-search').addEventListener('input', () => {
    queries[mode] = $('global-search').value.slice(0, 200);
    invalidate();
    list.version = null; list.hasMore = false; list.loading = true;
    renderListSummary();
    searchTimer = setTimeout(() => void loadList(), 150);
  });
  $('load-more').addEventListener('click', () => void loadList(true));
  $('search-retry').addEventListener('click', () => void loadList());
  $('detail-load-more').addEventListener('click', () => void loadDetail(true));
  $('detail-retry').addEventListener('click', () => void loadDetail());
  $('detail-back').addEventListener('click', back);
  function filterChanged(debounce = false) {
    const frame = activeDetail();
    if (!frame || frame.kind !== 'company') return;
    frame.filters = { difficulty: $('difficulty-select').value, topic: $('topic-select').value, query: $('question-search').value.slice(0, 200) };
    frame.version = null;
    invalidate();
    frame.hasMore = false; frame.loading = true;
    renderDetailSummary();
    if (debounce) questionTimer = setTimeout(() => void loadDetail(), 150); else void loadDetail();
  }
  $('difficulty-select').addEventListener('change', () => filterChanged());
  $('topic-select').addEventListener('change', () => filterChanged());
  $('question-search').addEventListener('input', () => filterChanged(true));
  $('window-select').addEventListener('change', () => {
    settings.window = $('window-select').value;
    reloadCurrent();
    api.storage.local.set({ lctSettings: settings }).catch(() => { refreshError = 'Could not save your time window preference.'; renderStatus(); });
  });
  $('refresh').addEventListener('click', async () => {
    refreshError = ''; status = { ...status, phase: 'syncing', total: 0, completed: 0 }; renderStatus();
    try {
      const result = await api.runtime.sendMessage({ type: 'LCT_REFRESH' });
      if (!result?.ok) throw new Error(result?.error || 'Refresh failed. Your saved data is still available.');
      status = result.status || status; renderStatus();
    } catch (cause) { refreshError = cause.message || 'Refresh failed. Your saved data is still available.'; status = { ...status, phase: 'error' }; renderStatus(); }
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.lctSettings && !changes.lctStatus && !changes.lctData)) return;
    let reload = Boolean(changes.lctData?.newValue);
    if (changes.lctSettings) {
      const oldWindow = windowKey(); settings = { ...defaults, ...changes.lctSettings.newValue };
      reload ||= oldWindow !== windowKey();
    }
    if (changes.lctStatus) {
      const previous = status; status = changes.lctStatus.newValue || {};
      if (status.phase !== 'error') refreshError = '';
      reload ||= Boolean(status.hasData && (!previous.hasData || previous.commit !== status.commit || previous.lastSyncedAt !== status.lastSyncedAt));
      renderStatus();
    }
    if (reload) reloadCurrent();
  });
  async function start() {
    try {
      const stored = await api.storage.local.get(['lctSettings', 'lctStatus']);
      settings = { ...defaults, ...stored.lctSettings }; status = stored.lctStatus || {};
    } catch (_) { /* The cache request below reports a usable connection error. */ }
    renderShell(); renderStatus(); await loadList();
  }
  void start();
})();
