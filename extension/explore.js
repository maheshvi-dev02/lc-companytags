(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.LCTCore;
  const logos = globalThis.LCTCompanyLogos;
  const $ = id => document.getElementById(id);
  const labels = { all: 'All time', '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months', older: 'Older than 6 months' };
  const defaults = { enabled: true, collapsed: false, window: 'all' };
  const sortDefaults = { problems: 'relevance', companies: 'name-asc', companyQuestions: 'frequency-desc', problemCompanies: 'frequency-desc' };
  const sortOptions = {
    problems: [['relevance','Relevance'],['name-asc','A–Z'],['name-desc','Z–A'],['difficulty-asc','Easy → hard'],['difficulty-desc','Hard → easy'],['companies-desc','Most companies'],['companies-asc','Fewest companies']],
    companies: [['name-asc','A–Z'],['name-desc','Z–A'],['questions-desc','Most questions'],['questions-asc','Fewest questions']],
    companyQuestions: [['frequency-desc','Highest frequency'],['frequency-asc','Lowest frequency'],['name-asc','A–Z'],['name-desc','Z–A'],['difficulty-asc','Easy → hard'],['difficulty-desc','Hard → easy'],['companies-desc','Most companies'],['companies-asc','Fewest companies']],
    problemCompanies: [['frequency-desc','Highest frequency'],['frequency-asc','Lowest frequency'],['name-asc','A–Z'],['name-desc','Z–A'],['questions-desc','Most questions'],['questions-asc','Fewest questions']],
  };
  const sortNames = { problems: 'Sort problems', companies: 'Sort companies', companyQuestions: 'Sort company questions', problemCompanies: 'Sort problem companies' };
  let sorts = { ...sortDefaults };
  let sortSave = Promise.resolve();
  const problemViewDefaults = { difficulty: '', topics: [], topicMatch: 'any', view: 'list' };
  let problemView = { ...problemViewDefaults, topics: [] };
  let problemViewSave = Promise.resolve();
  let problemViewDirty = false;
  let topicCatalog = [];
  let pickerOpen = false;
  let pickerFrame = null;
  let pickerTrigger = null;
  let detailGroupOwner = null;
  let draftTopics = [];
  const topicGroups = new Map();
  let groupsContext = '';
  let groupsRevision = null;
  let groupSequence = 0;
  let groupRunning = 0;
  const groupQueue = [];
  const params = new URLSearchParams(location.search);
  const requestedSlug = params.get('slug');
  const requestedCompany = params.get('company');
  const companyRoute = params.get('mode') === 'companies' && !params.has('slug') &&
    typeof requestedCompany === 'string' && Boolean(requestedCompany.trim()) && requestedCompany === requestedCompany.trim() && requestedCompany.length <= 200 &&
    (!params.has('window') || Object.hasOwn(core.WINDOW_FILES, params.get('window'))) &&
    (!params.has('difficulty') || ['', 'Easy', 'Medium', 'Hard'].includes(params.get('difficulty'))) &&
    (!params.has('topic') || params.get('topic').length <= 200) &&
    (!params.has('sort') || core.SORT_OPTIONS.practiceQuestions.includes(params.get('sort')));
  const problemRoute = !params.has('company') && typeof requestedSlug === 'string' && requestedSlug.length <= 200 && requestedSlug === requestedSlug.trim() && core.SLUG_PATTERN.test(requestedSlug);
  let pendingDetail = companyRoute ? { kind: 'company', name: requestedCompany, title: requestedCompany,
    window: params.get('window'), sort: params.get('sort'),
    filters: { difficulty: params.get('difficulty') || '', topic: params.get('topic') || '', query: '' }
  } : problemRoute ? { kind: 'problem', slug: requestedSlug, title: core.formatProblemTitle(requestedSlug) } : null;
  let mode = problemRoute ? 'problems' : params.get('mode') === 'companies' ? 'companies' : 'problems';
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
  const detailSortKey = frame => frame.kind === 'company' ? 'companyQuestions' : 'problemCompanies';
  const problemContext = () => JSON.stringify([windowKey(), queries.problems, sorts.problems, problemView.difficulty, problemView.topics.map(topic => topic.toLocaleLowerCase()).sort(), problemView.topicMatch]);
  const grouped = () => mode === 'problems' && problemView.view === 'topics';
  const listVersion = () => JSON.stringify([version(), queries[mode], sorts[mode], mode === 'problems' ? problemContext() : null, mode === 'problems' ? problemView.view : null]);
  const detailVersion = frame => JSON.stringify([version(), frame.kind, frame.slug || frame.name, frame.sort, frame.filters]);
  const invalidate = () => {
    closeSelectMenu();
    closeAcceptanceHelp();
    closeTopicPicker();
    groupQueue.length = 0;
    for (const groups of [topicGroups, ...stack.filter(frame => frame.kind === 'company').map(frame => frame.topicGroups)]) {
      for (const group of groups.values()) { group.request++; group.loading = false; group.queued = false; renderTopicGroupState(group); }
    }
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

  let acceptanceHelpId = 0;
  function closeAcceptanceHelp(except = null) {
    document.querySelectorAll('.acceptance-rate[aria-expanded="true"]').forEach(button => {
      if (button === except) return;
      button.setAttribute('aria-expanded', 'false');
      const help = document.getElementById(button.getAttribute('aria-controls'));
      if (help) help.hidden = true;
    });
  }
  function acceptanceInfo(value) {
    const formatted = core.formatAcceptanceRate(value);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'acceptance-rate';
    button.textContent = formatted === null ? 'Acceptance unavailable' : `Acceptance ${formatted}`;
    const help = document.createElement('span');
    help.className = 'acceptance-help';
    help.id = `acceptance-help-${++acceptanceHelpId}`;
    help.textContent = core.ACCEPTANCE_TOOLTIP + (formatted === null ? ' No valid acceptance rate is available in the saved dataset.' : '');
    help.hidden = true;
    button.title = help.textContent;
    button.dataset.acceptanceControl = '';
    help.dataset.acceptanceControl = '';
    button.setAttribute('aria-describedby', help.id);
    button.setAttribute('aria-controls', help.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => {
      const show = help.hidden;
      closeAcceptanceHelp(button);
      help.hidden = !show;
      button.setAttribute('aria-expanded', String(show));
    });
    return { button, help };
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-acceptance-control]')) closeAcceptanceHelp();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAcceptanceHelp();
  });

  const selectMenus = globalThis.LCTSelectControls.create();
  const closeSelectMenu = returnFocus => selectMenus.close(returnFocus);
  const syncSelectControl = select => selectMenus.sync(select);
  function enhanceSelects() {
    selectMenus.enhance(['sort-select', 'detail-sort-select', 'window-select', 'difficulty-select', 'problem-difficulty-select', 'topic-match-select', 'detail-topic-match-select'],
      { iconIds: ['sort-select', 'detail-sort-select'] });
  }
  function validatedProblemView(value) {
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const seen = new Set();
    const topics = (Array.isArray(stored.topics) ? stored.topics : []).filter(topic => {
      if (typeof topic !== 'string' || !topic.trim() || topic.trim().length > 200 || seen.has(topic.trim().toLocaleLowerCase())) return false;
      seen.add(topic.trim().toLocaleLowerCase()); return true;
    }).slice(0, 256).map(topic => topic.trim());
    return { difficulty: ['', 'Easy', 'Medium', 'Hard'].includes(stored.difficulty) ? stored.difficulty : '',
      topics, topicMatch: stored.topicMatch === 'all' ? 'all' : 'any', view: stored.view === 'topics' ? 'topics' : 'list' };
  }
  function saveProblemView() {
    problemViewDirty = true;
    const value = { ...problemView, topics: [...problemView.topics] };
    problemViewSave = problemViewSave.then(() => api.storage.local.set({ lctExplorerProblemView: value })).catch(() => {
      refreshError = 'Could not save your problem view preference. The current view still works.';
      renderStatus();
    });
  }
  function closeTopicPicker(returnFocus = false) {
    if (!pickerOpen) return;
    const trigger = pickerTrigger;
    pickerOpen = false; draftTopics = []; pickerFrame = null; pickerTrigger = null;
    $('topic-picker-menu').hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    if (returnFocus && trigger?.isConnected) trigger.focus();
  }
  function positionTopicPicker() {
    if (!pickerOpen || !pickerTrigger) return;
    const menu = $('topic-picker-menu'), rect = pickerTrigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 340), Math.max(0, document.documentElement.clientWidth - 16));
    const below = window.innerHeight - rect.bottom - 14, above = rect.top - 14;
    const upward = below < 270 && above > below;
    menu.style.width = width + 'px';
    menu.style.maxHeight = Math.max(0, Math.min(440, upward ? above : below)) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8)) + 'px';
    menu.style.top = (upward ? Math.max(8, rect.top - 6 - menu.getBoundingClientRect().height) : rect.bottom + 6) + 'px';
  }
  function topicPickerValues() {
    const catalog = pickerFrame ? pickerFrame.topics : topicCatalog;
    const selected = pickerFrame ? pickerFrame.filters.topics : problemView.topics;
    const values = new Map(catalog.map(topic => [topic.toLocaleLowerCase(), topic]));
    for (const topic of [...selected, ...draftTopics]) if (!values.has(topic.toLocaleLowerCase())) values.set(topic.toLocaleLowerCase(), topic);
    return [...values.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  function syncTopicDraft() {
    const selected = new Set(draftTopics.map(topic => topic.toLocaleLowerCase()));
    $('topic-picker-options').querySelectorAll('input[data-topic]').forEach(input => {
      input.checked = selected.has(input.dataset.topic.toLocaleLowerCase());
      input.disabled = !input.checked && selected.size >= 256;
    });
    $('topic-picker-hint').textContent = selected.size >= 256 ? '256 topics selected. Remove a topic to select another.' : 'Select topics, then apply. No selection includes all topics.';
  }
  function renderTopicOptions() {
    const focused = document.activeElement?.dataset.topic;
    const query = $('topic-picker-search').value.trim().toLocaleLowerCase();
    const values = topicPickerValues().filter(topic => topic.toLocaleLowerCase().includes(query));
    $('topic-picker-options').replaceChildren(...values.map(topic => {
      const label = node('label', 'topic-picker-option');
      const input = node('input'); input.type = 'checkbox'; input.dataset.topic = topic;
      input.addEventListener('change', () => {
        draftTopics = draftTopics.filter(value => value.toLocaleLowerCase() !== topic.toLocaleLowerCase());
        if (input.checked) draftTopics.push(topic);
        syncTopicDraft();
      });
      label.append(input, node('span', '', topic)); return label;
    }));
    $('topic-picker-empty').hidden = values.length > 0;
    $('topic-picker-empty').textContent = query ? 'No topics match your search.' : 'No topics are available in this time window.';
    syncTopicDraft();
    if (focused) Array.from($('topic-picker-options').querySelectorAll('input')).find(input => input.dataset.topic === focused)?.focus();
    positionTopicPicker();
  }
  function openTopicPicker(frame = null) {
    if (frame ? frame.kind !== 'company' || frame !== activeDetail() : mode !== 'problems' || activeDetail()) return;
    closeSelectMenu();
    pickerFrame = frame; pickerTrigger = $(frame ? 'detail-topic-picker-trigger' : 'topic-picker-trigger');
    pickerOpen = true; draftTopics = [...(frame ? frame.filters.topics : problemView.topics)];
    $('topic-picker-search').value = '';
    $('topic-picker-menu').setAttribute('aria-label', frame ? 'Select topics for ' + frame.name : 'Select problem topics');
    $('topic-picker-menu').hidden = false;
    pickerTrigger.setAttribute('aria-expanded', 'true');
    renderTopicOptions(); positionTopicPicker();
    $('topic-picker-search').focus();
  }
  function renderTopicSelection(frame = null) {
    const selected = frame ? frame.filters.topics : problemView.topics;
    const prefix = frame ? 'detail-' : '';
    const trigger = $(prefix + 'topic-picker-trigger');
    $(prefix + 'topic-picker-value').textContent = selected.length ? selected.length + ' selected' : 'All topics';
    trigger.title = selected.length ? 'Selected topics: ' + selected.join(', ') : frame ? 'Select company topics' : 'Select problem topics';
    trigger.setAttribute('aria-label', (frame ? 'Select company topics' : 'Select problem topics') + (selected.length ? ', ' + selected.length + ' selected' : ', all topics'));
    $(prefix + 'selected-topic-tools').hidden = !selected.length;
    $(prefix + 'topic-picker-selected').replaceChildren(...selected.map(topic => {
      const item = node('li'), button = node('button');
      button.type = 'button'; button.dataset.topic = topic; button.setAttribute('aria-label', 'Remove topic ' + topic);
      button.append(node('span', '', topic)); const remove = node('span', '', '×'); remove.setAttribute('aria-hidden', 'true'); button.append(remove);
      button.addEventListener('click', () => {
        if (frame) { frame.filters.topics = frame.filters.topics.filter(value => value !== topic); companyFiltersChanged(frame); }
        else { problemView.topics = problemView.topics.filter(value => value !== topic); problemFiltersChanged(); }
        trigger.focus();
      });
      item.append(button); return item;
    }));
  }
  function renderProblemControls() {
    $('problem-filters').hidden = mode !== 'problems' || Boolean(activeDetail());
    $('problem-difficulty-select').value = problemView.difficulty;
    $('topic-match-select').value = problemView.topicMatch;
    syncSelectControl($('problem-difficulty-select')); syncSelectControl($('topic-match-select'));
    renderTopicSelection();
    $('problem-view-list').setAttribute('aria-pressed', String(problemView.view === 'list'));
    $('problem-view-topics').setAttribute('aria-pressed', String(problemView.view === 'topics'));
    $('results').hidden = grouped();
    $('topic-groups').hidden = !grouped();
    $('topic-group-tools').hidden = !grouped();
  }
  const scopeGroups = frame => frame ? frame.topicGroups : topicGroups;
  const scopeContext = frame => frame ? JSON.stringify([frame.name, windowKey(), frame.filters.query, frame.sort, frame.filters.difficulty,
    frame.filters.topics.map(topic => topic.toLocaleLowerCase()).sort(), frame.filters.topicMatch]) : problemContext();
  const scopeGrouped = frame => frame ? frame.kind === 'company' && frame.filters.view === 'topics' : grouped();
  const scopeActive = frame => frame ? frame === activeDetail() && scopeGrouped(frame) : grouped() && !activeDetail();
  const scopeElement = (frame, suffix) => $((frame ? 'detail-' : '') + suffix);
  function resetTopicGroups(frame = null) {
    for (let index = groupQueue.length - 1; index >= 0; index--) if (groupQueue[index].frame === frame) groupQueue.splice(index, 1);
    scopeGroups(frame).clear();
    if (frame) { frame.groupsContext = ''; frame.groupsRevision = null; }
    else { groupsContext = ''; groupsRevision = null; }
    if (!frame || detailGroupOwner === frame) scopeElement(frame, 'topic-groups').replaceChildren();
    renderTopicGroupProgress(frame);
  }
  function problemFiltersChanged(debounce = false, save = true) {
    pendingDetail = null;
    invalidate(); resetTopicGroups();
    list.version = null; list.rows = []; list.total = 0; list.hasMore = false; list.loading = true; list.error = '';
    renderListRows([]); renderProblemControls(); renderListSummary(); if (save) saveProblemView();
    if (debounce) searchTimer = setTimeout(() => void loadList(), 150); else void loadList();
  }
  function baseProblemRequest() {
    return { type: 'LCT_SEARCH_PROBLEMS', query: queries.problems, window: windowKey(), sort: sorts.problems,
      difficulty: problemView.difficulty, topics: [...problemView.topics], topicMatch: problemView.topicMatch };
  }
  function baseCompanyRequest(frame) {
    return { type: 'LCT_PRACTICE', company: frame.name, window: windowKey(), sort: frame.sort, query: frame.filters.query,
      difficulty: frame.filters.difficulty, topics: [...frame.filters.topics], topicMatch: frame.filters.topicMatch };
  }
  function companyFiltersChanged(frame, debounce = false) {
    if (frame !== activeDetail() || frame.kind !== 'company') return;
    frame.filters.topic = frame.filters.topics.length === 1 ? frame.filters.topics[0] : '';
    invalidate(); resetTopicGroups(frame);
    frame.rows = []; frame.total = 0; frame.hasMore = false; frame.version = null; frame.error = ''; frame.loading = true;
    renderDetailRows([]); renderDetailShell(); renderDetailSummary();
    if (debounce) questionTimer = setTimeout(() => void loadDetail(), 150); else void loadDetail();
  }
  function validatedSorts(value) {
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(Object.entries(sortDefaults).map(([key, fallback]) => [key, sortOptions[key].some(([sort]) => sort === stored[key]) ? stored[key] : fallback]));
  }
  function orderLabel(key, sort) {
    if (sort === 'relevance') return queries.problems.trim() ? 'Best match first' : 'A–Z';
    return sortOptions[key].find(([value]) => value === sort)?.[1] || '';
  }
  function renderSortSelect(select, key, selected) {
    if (select.dataset.sortKind !== key) {
      select.replaceChildren(...sortOptions[key].map(([value, label]) => { const option = node('option', '', label); option.value = value; return option; }));
      select.dataset.sortKind = key;
    }
    select.value = selected;
    select.setAttribute('aria-label', sortNames[key]);
    syncSelectControl(select);
  }
  function renderSortControls() {
    renderSortSelect($('sort-select'), mode, sorts[mode]);
    $('result-order').textContent = orderLabel(mode, sorts[mode]);
    const frame = activeDetail();
    if (frame) {
      const key = detailSortKey(frame);
      renderSortSelect($('detail-sort-select'), key, frame.sort);
      $('detail-order').textContent = orderLabel(key, frame.sort);
    }
  }
  function saveSorts() {
    // Serialize saves; delayed storage events must not roll back the active view.
    sortSave = sortSave.then(() => api.storage.local.set({ lctExplorerSorts: { ...sorts } })).catch(() => {
      refreshError = 'Could not save your sort preference. The current view still works.';
      renderStatus();
    });
  }
  function changeSort(key, value) {
    const frame = activeDetail();
    const current = frame && detailSortKey(frame) === key ? frame.sort : sorts[key];
    if (!sortOptions[key].some(([allowed]) => allowed === value) || current === value) return;
    sorts[key] = value;
    invalidate();
    if (!activeDetail() && key === 'problems') resetTopicGroups();
    for (const item of stack) if (detailSortKey(item) === key && (key !== 'companyQuestions' || item === activeDetail())) {
      item.sort = value; item.version = null; item.hasMore = false;
      if (item.kind === 'company') resetTopicGroups(item);
    }
    renderSortControls();
    if (activeDetail()) void loadDetail(); else void loadList();
    saveSorts();
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
    $('dataset-state').textContent = status.phase === 'syncing' ? 'Syncing' : failure ? 'Needs attention' : stale ? 'Saved data' : status.hasData ? 'Ready' : 'Not synced';
    $('dataset-state').dataset.state = status.phase === 'syncing' ? 'syncing' : failure || stale ? 'warning' : status.hasData ? 'ready' : 'idle';
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
    syncSelectControl($('window-select'));
    $('search-view').hidden = Boolean(activeDetail());
    $('detail-view').hidden = !activeDetail();
    $('results').setAttribute('aria-label', mode === 'problems' ? 'Problem search results' : 'Company search results');
    $('load-more').textContent = `Load more ${mode}`;
    renderSortControls(); renderProblemControls();
  }

  function problemRow(problem, companyView = false) {
    const row = node('li', 'result-row question-row');
    row.dataset.slug = problem.slug;
    const info = node('div', 'result-info');
    info.append(node('h3', companyView ? 'question-title' : 'result-title', problem.title || core.formatProblemTitle(problem.slug)));
    if (companyView) {
      const score = Number.isFinite(problem.frequency) && problem.frequency >= 0 ? String(problem.frequency) : 'unavailable';
      const rank = Number.isInteger(problem.rank) && problem.rank > 0 ? `company rank #${problem.rank}` : 'rank unavailable';
      const companies = Number.isInteger(problem.companyCount) && problem.companyCount >= 0 ? `${count(problem.companyCount)} ${problem.companyCount === 1 ? 'company' : 'companies'} in this window` : 'Company count unavailable';
      const meta = node('span', 'question-meta');
      const acceptance = acceptanceInfo(problem.acceptanceRate);
      meta.append(document.createTextNode(`${problem.difficulty || 'Difficulty unavailable'} · `), acceptance.button, document.createTextNode(` · score ${score} · ${rank} · ${companies}`));
      info.append(meta, acceptance.help);
      if (Array.isArray(problem.topics) && problem.topics.length) info.append(node('span', 'question-topics', problem.topics.join(' · ')));
    } else {
      const meta = node('span', 'result-meta');
      const acceptance = acceptanceInfo(problem.acceptanceRate);
      meta.append(document.createTextNode(`${problem.difficulty || 'Difficulty unavailable'} · `), acceptance.button, document.createTextNode(` · ${count(problem.companyCount)} ${problem.companyCount === 1 ? 'company' : 'companies'}`));
      info.append(meta, acceptance.help);
      if (Array.isArray(problem.topics) && problem.topics.length) info.append(node('span', 'question-topics', problem.topics.join(' · ')));
    }
    const actions = node('div', 'result-actions');
    const button = action('problem', problem.slug, 'View companies');
    button.setAttribute('aria-label', `View companies for ${problem.title || core.formatProblemTitle(problem.slug)}`);
    button.addEventListener('click', () => openDetail({ kind: 'problem', slug: problem.slug, title: problem.title || core.formatProblemTitle(problem.slug), difficulty: problem.difficulty, acceptanceRate: problem.acceptanceRate }));
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
      if (Number.isInteger(company.problemCount) && company.problemCount >= 0) info.append(node('span', 'company-question-count result-meta', `${count(company.problemCount)} ${company.problemCount === 1 ? 'question' : 'questions'} in this window`));
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

  const topicGroupKey = topic => JSON.stringify(topic === null ? null : topic.toLocaleLowerCase());
  function sourceRevision(result) {
    return core.SHA_PATTERN.test(result.sourceRevision || '') ? result.sourceRevision.toLowerCase() : null;
  }
  function renderTopicGroupProgress(frame = null) {
    if (frame && frame !== activeDetail()) return;
    const opened = [...scopeGroups(frame).values()].filter(group => group.open);
    const busy = opened.filter(group => group.loading || group.queued).length;
    const ready = opened.filter(group => group.rows.length || group.total === 0).length;
    scopeElement(frame, 'topic-group-progress').hidden = !busy;
    scopeElement(frame, 'topic-group-progress').textContent = busy ? 'Loading topic groups · ' + count(ready) + ' of ' + count(opened.length) + ' opened groups ready' : '';
  }
  function renderTopicGroupState(group) {
    if (!group.dom) return;
    const frame = group.frame || null;
    const noun = frame ? 'questions' : 'problems';
    const dom = group.dom, busy = group.loading || group.queued;
    dom.toggle.setAttribute('aria-expanded', String(group.open));
    dom.toggle.setAttribute('aria-busy', String(busy));
    dom.body.hidden = !group.open;
    dom.count.textContent = count(group.total) + (group.total === 1 ? frame ? ' question' : ' problem' : ' ' + noun);
    const shown = count(group.rows.length) + ' of ' + count(group.total) + ' ' + noun;
    dom.summary.textContent = group.error ? shown + ' · ' + group.error : busy ? (group.rows.length ? shown + ' · Loading more…' : 'Loading saved ' + noun + '…') : group.total ? shown : 'No ' + noun + ' in this group match your filters.';
    dom.summary.toggleAttribute('data-error', Boolean(group.error));
    dom.list.setAttribute('aria-busy', String(busy));
    dom.more.hidden = !group.hasMore || Boolean(group.error);
    dom.retry.hidden = !group.error;
    dom.more.disabled = dom.retry.disabled = busy;
    dom.more.textContent = busy ? 'Loading…' : 'Load more';
    renderTopicGroupProgress(frame);
  }
  function createTopicGroupCard(group, frame = null) {
    group.frame = frame;
    const card = node('section', 'topic-group');
    card.dataset.topic = group.topic === null ? '' : group.topic;
    card.dataset.untagged = String(group.topic === null);
    const heading = node('h3', 'topic-group-heading'), toggle = node('button', 'topic-group-toggle');
    toggle.type = 'button';
    const name = group.topic === null ? 'No topics' : group.topic;
    const id = 'topic-group-' + (++groupSequence);
    const chevron = node('span', 'select-chevron'); chevron.setAttribute('aria-hidden', 'true');
    const total = node('span', 'topic-group-count');
    toggle.append(chevron, node('span', 'topic-group-name', name), total);
    toggle.setAttribute('aria-controls', id);
    toggle.addEventListener('click', () => {
      group.open = !group.open;
      if (!group.open && group.queued) { group.queued = false; group.request++; }
      renderTopicGroupState(group);
      if (group.open && !group.rows.length && !group.error && group.total > 0) queueTopicGroup(group);
    });
    heading.append(toggle);
    const body = node('div', 'topic-group-body'); body.id = id;
    const summary = node('p', 'topic-group-summary'); summary.setAttribute('role', 'status');
    const rows = node('ul', 'topic-group-results results'); rows.tabIndex = 0; rows.setAttribute('aria-label', name + (frame ? ' questions from ' + frame.name : ' problems'));
    rows.append(...group.rows.map(problem => problemRow(problem, Boolean(frame))));
    const actions = node('div', 'topic-group-buttons');
    const more = node('button', 'topic-group-load-more secondary', 'Load more');
    const retry = node('button', 'topic-group-retry secondary', 'Try again');
    more.type = retry.type = 'button';
    more.addEventListener('click', () => queueTopicGroup(group, true));
    retry.addEventListener('click', () => queueTopicGroup(group, group.rows.length > 0));
    actions.append(more, retry); body.append(summary, rows, actions); card.append(heading, body);
    group.dom = { card, toggle, count: total, body, summary, list: rows, more, retry };
    renderTopicGroupState(group);
    return card;
  }
  function renderTopicGroupCards(frame = null) {
    if (frame) detailGroupOwner = frame;
    scopeElement(frame, 'topic-groups').replaceChildren(...Array.from(scopeGroups(frame).values(), group => createTopicGroupCard(group, frame)));
  }
  function syncTopicGroups(result, frame = null) {
    const context = scopeContext(frame), revision = sourceRevision(result);
    const previousContext = frame ? frame.groupsContext : groupsContext;
    const previousRevision = frame ? frame.groupsRevision : groupsRevision;
    if (previousContext && (previousContext !== context || previousRevision !== revision)) resetTopicGroups(frame);
    if (frame) { frame.groupsContext = context; frame.groupsRevision = revision; }
    else { groupsContext = context; groupsRevision = revision; }
    const groups = scopeGroups(frame);
    const catalog = new Map();
    for (const topic of Array.isArray(result.topics) ? result.topics : []) {
      if (typeof topic === 'string' && topic.trim() && topic.length <= 200) catalog.set(topic.toLocaleLowerCase(), topic);
    }
    const values = [...catalog.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    if (frame) frame.topics = values; else topicCatalog = values;
    const metadata = new Map();
    for (const entry of Array.isArray(result.topicGroups) ? result.topicGroups : []) {
      if (!entry || (entry.topic !== null && (typeof entry.topic !== 'string' || !entry.topic.trim())) ||
          !Number.isInteger(entry.total) || entry.total < 0) continue;
      metadata.set(topicGroupKey(entry.topic), { topic: entry.topic, total: entry.total });
    }
    // Absent selected headings have zero matches; their selections stay visible
    // so an unknown or no-longer-present topic can be removed deliberately.
    const selection = frame ? frame.filters.topics : problemView.topics;
    const selected = result.available === false ? [] : selection.length ? selection.map(topic => metadata.get(topicGroupKey(topic)) ||
      { topic: catalog.get(topic.toLocaleLowerCase()) || topic, total: 0 }) : [...metadata.values()];
    selected.sort((a, b) => a.topic === null ? 1 : b.topic === null ? -1 : a.topic.localeCompare(b.topic, undefined, { sensitivity: 'base' }));
    const next = new Map();
    for (const entry of selected) {
      const key = topicGroupKey(entry.topic);
      const group = groups.get(key) || { topic: entry.topic, rows: [], total: entry.total, hasMore: false, open: false,
        queued: false, loading: false, error: '', request: 0, revision, dom: null };
      group.topic = entry.topic; group.total = entry.total;
      next.set(key, group);
    }
    groups.clear(); for (const [key, group] of next) groups.set(key, group);
    renderTopicGroupCards(frame);
    if (frame) renderCompanyTopicControls(frame); else renderProblemControls();
    if (pickerOpen && pickerFrame === frame) renderTopicOptions();
    resumeTopicGroups(frame);
  }
  function resumeTopicGroups(frame = null) {
    if (!scopeActive(frame)) return;
    for (const group of scopeGroups(frame).values()) if (group.open && group.total > 0 && !group.rows.length && !group.error) queueTopicGroup(group);
  }
  function queueTopicGroup(group, append = false) {
    const frame = group.frame || null;
    if (!scopeActive(frame) || !group.open || !group.total || group.loading || group.queued ||
        (append && !group.hasMore) || (frame ? frame.groupsContext : groupsContext) !== scopeContext(frame)) return;
    group.queued = true; group.error = '';
    const task = { frame, group, append, request: ++group.request, stamp: generation, context: scopeContext(frame), message: frame ? baseCompanyRequest(frame) : baseProblemRequest() };
    const retryFocused = document.activeElement === group.dom.retry;
    groupQueue.push(task); renderTopicGroupState(group);
    if (retryFocused && group.dom.retry.hidden) group.dom.list.focus({ preventScroll: true });
    pumpTopicGroups();
  }
  function currentGroupTask(task) {
    return task.stamp === generation && task.request === task.group.request &&
      scopeGroups(task.frame).get(topicGroupKey(task.group.topic)) === task.group &&
      task.context === scopeContext(task.frame) && scopeActive(task.frame);
  }
  function pumpTopicGroups() {
    while (groupRunning < 3 && groupQueue.length) {
      const task = groupQueue.shift(), group = task.group;
      if (!currentGroupTask(task) || !group.open || !group.queued) continue;
      group.queued = false; group.loading = true; groupRunning++; renderTopicGroupState(group);
      void loadTopicGroup(task).finally(() => { groupRunning--; pumpTopicGroups(); });
    }
  }
  function restartProblemResults(frame = null) {
    invalidate(); resetTopicGroups(frame);
    if (frame) {
      frame.rows = []; frame.total = 0; frame.hasMore = false; frame.version = null; frame.error = '';
      if (frame === activeDetail()) { renderDetailRows([]); renderDetailSummary(); void loadDetail(); }
      return;
    }
    list.rows = []; list.total = 0; list.hasMore = false; list.version = null; list.error = '';
    renderListRows([]); renderListSummary();
    if (!activeDetail() && mode === 'problems') void loadList();
  }
  async function loadTopicGroup(task) {
    const frame = task.frame;
    const group = task.group, offset = task.append ? group.rows.length : 0;
    try {
      const result = await api.runtime.sendMessage({ ...task.message, groupTopic: group.topic, offset, limit: 20 });
      if (!currentGroupTask(task)) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load this topic. Try again.');
      if (sourceRevision(result) !== (frame ? frame.groupsRevision : groupsRevision)) {
        status = result.status || status; restartProblemResults(frame); return;
      }
      if (result.available === false) throw new Error('This time window is unavailable. Refresh the dataset.');
      const resultRows = frame ? result.questions : result.problems;
      const rows = Array.isArray(resultRows) ? resultRows : [], total = Number(result.total);
      const known = new Set(task.append ? group.rows.map(row => row.slug) : []);
      const invalid = rows.some(row => {
        if (!row || typeof row.slug !== 'string' || !core.SLUG_PATTERN.test(row.slug) || known.has(row.slug)) return true;
        known.add(row.slug); return false;
      });
      if (!Number.isInteger(total) || total < offset + rows.length || total !== group.total || invalid ||
          (result.offset !== undefined && result.offset !== offset) || Boolean(result.hasMore) !== (offset + rows.length < total) ||
          (!rows.length && total > offset)) throw new Error('Could not continue this topic list. Try again.');
      const focused = [group.dom.more, group.dom.retry].includes(document.activeElement);
      group.rows = task.append ? group.rows.concat(rows) : rows;
      group.total = total; group.hasMore = Boolean(result.hasMore); group.revision = frame ? frame.groupsRevision : groupsRevision;
      if (task.append) group.dom.list.append(...rows.map(row => problemRow(row, Boolean(frame))));
      else group.dom.list.replaceChildren(...rows.map(row => problemRow(row, Boolean(frame))));
      if (focused && !group.hasMore) group.dom.list.focus({ preventScroll: true });
    } catch (cause) {
      if (currentGroupTask(task)) group.error = cause.message || 'Could not load this topic. Try again.';
    } finally {
      if (currentGroupTask(task)) {
        const focused = document.activeElement;
        group.loading = false; renderTopicGroupState(group);
        if ([group.dom.more, group.dom.retry].includes(focused) && focused.hidden) {
          (group.error ? group.dom.retry : group.hasMore ? group.dom.more : group.dom.list).focus({ preventScroll: true });
        }
      }
    }
  }

  function renderListRows(rows, append = false) {
    const nodes = rows.map(row => mode === 'problems' ? problemRow(row) : companyRow(row));
    if (append) $('results').append(...nodes); else $('results').replaceChildren(...nodes);
  }
  function renderListSummary() {
    $('results').setAttribute('aria-busy', String(list.loading));
    $('topic-groups').setAttribute('aria-busy', String(list.loading));
    const filtered = queries[mode].trim() || (mode === 'problems' && (problemView.difficulty || problemView.topics.length));
    const appearances = Array.from(topicGroups.values()).reduce((sum, group) => sum + group.total, 0);
    $('result-summary').textContent = list.loading ? 'Loading saved ' + mode + '…' : grouped()
      ? count(list.total) + ' unique problems · ' + count(topicGroups.size) + ' topic groups · ' + count(appearances) + ' grouped appearances'
      : count(list.rows.length) + ' of ' + count(list.total) + ' ' + mode + (filtered ? ' matching your filters' : '');
    const message = list.error || (!list.loading && !list.available ? unavailable() : !list.loading && !list.total ? 'No ' + mode + ' match your filters in this time window.' : '');
    $('search-message').textContent = message;
    $('search-message').hidden = !message;
    $('search-message').toggleAttribute('data-error', Boolean(list.error));
    $('search-retry').hidden = !list.error; $('search-retry').disabled = list.loading;
    $('load-more').hidden = grouped() || !list.hasMore;
    $('load-more').disabled = list.loading;
    $('expand-topic-groups').disabled = $('collapse-topic-groups').disabled = list.loading || !topicGroups.size;
    $('result-order').textContent = orderLabel(mode, sorts[mode]);
    const unavailableFilters = mode === 'problems' && !list.loading && list.version !== null && !list.available;
    $('problem-difficulty-select').disabled = unavailableFilters; syncSelectControl($('problem-difficulty-select'));
    $('topic-match-select').disabled = unavailableFilters; syncSelectControl($('topic-match-select'));
    $('topic-picker-trigger').disabled = unavailableFilters;
  }
  async function loadList(append = false) {
    if (activeDetail() || (append && (list.loading || !list.hasMore || grouped()))) return;
    if (append && list.version !== listVersion()) append = false;
    const id = ++listRequest, stamp = generation;
    const requestedMode = mode, requestedWindow = windowKey(), requestedSort = sorts[requestedMode];
    const context = requestedMode === 'problems' ? problemContext() : null;
    const offset = append ? list.rows.length : 0;
    if (!append) { list.rows = []; list.total = 0; list.hasMore = false; list.version = null; renderListRows([]); }
    list.loading = true; list.error = ''; renderListSummary();
    try {
      const message = requestedMode === 'problems' ? baseProblemRequest()
        : { type: 'LCT_SEARCH_COMPANIES', query: queries.companies, window: requestedWindow, sort: requestedSort };
      const result = await api.runtime.sendMessage({ ...message, offset, limit: grouped() ? 1 : 50 });
      if (id !== listRequest || stamp !== generation || activeDetail() || requestedMode !== mode || (context && context !== problemContext())) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not search the saved dataset. Try again.');
      const next = Array.isArray(requestedMode === 'problems' ? result.problems : result.companies)
        ? requestedMode === 'problems' ? result.problems : result.companies : [];
      if (requestedMode === 'problems' && append && list.sourceRevision !== sourceRevision(result)) {
        status = result.status || status; restartProblemResults(); return;
      }
      const total = Number(result.total), known = new Set(append ? list.rows.map(row => requestedMode === 'problems' ? row.slug : row.name) : []);
      const invalid = next.some(row => {
        const key = requestedMode === 'problems' ? row?.slug : row?.name;
        if (typeof key !== 'string' || known.has(key)) return true;
        known.add(key); return false;
      });
      if (!Number.isInteger(total) || total < offset + next.length || invalid ||
          (result.offset !== undefined && result.offset !== offset) ||
          (result.available !== false && Boolean(result.hasMore) !== (offset + next.length < total)) ||
          (result.available !== false && !next.length && total > offset)) throw new Error('Could not continue these results. Try again.');
      status = result.status || status;
      list.rows = append ? list.rows.concat(next) : next; list.total = total;
      list.available = result.available !== false; list.hasMore = Boolean(result.hasMore); list.sourceRevision = sourceRevision(result);
      list.version = listVersion();
      renderListRows(next, append);
      if (requestedMode === 'problems') syncTopicGroups(result);
      renderStatus();
    } catch (cause) {
      if (id === listRequest && stamp === generation) list.error = cause.message || 'Could not load the saved dataset.';
    } finally {
      if (id === listRequest && stamp === generation && !activeDetail()) { list.loading = false; renderListSummary(); }
    }
  }

  function renderCompanyTopicControls(frame) {
    if (!frame || frame.kind !== 'company' || frame !== activeDetail()) return;
    renderTopicSelection(frame);
    $('detail-topic-match-select').value = frame.filters.topicMatch; syncSelectControl($('detail-topic-match-select'));
    $('detail-view-list').setAttribute('aria-pressed', String(frame.filters.view === 'list'));
    $('detail-view-topics').setAttribute('aria-pressed', String(frame.filters.view === 'topics'));
    $('detail-results').hidden = scopeGrouped(frame);
    $('detail-topic-groups').hidden = !scopeGrouped(frame);
    $('detail-topic-group-tools').hidden = !scopeGrouped(frame);
    if (detailGroupOwner !== frame) renderTopicGroupCards(frame);
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
    const context = $('detail-context');
    context.replaceChildren();
    if (frame.kind === 'problem') {
      const acceptance = acceptanceInfo(frame.acceptanceRate);
      context.append(document.createTextNode(`${frame.difficulty || 'Difficulty unavailable'} · `), acceptance.button, document.createTextNode(` · ${labels[windowKey()].toLowerCase()}`), acceptance.help);
    } else context.textContent = `Every question listed for ${frame.name} · ${labels[windowKey()].toLowerCase()}`;
    $('detail-filters').hidden = frame.kind !== 'company';
    $('detail-results').setAttribute('aria-label', frame.kind === 'problem' ? 'Companies listed for this problem' : `Company questions sorted by ${orderLabel(detailSortKey(frame), frame.sort).toLocaleLowerCase()}`);
    renderSortControls();
    $('detail-source').hidden = !frame.sourceUrl;
    if (frame.sourceUrl) $('detail-source').href = sourceURL(frame.sourceUrl);
    if (frame.kind === 'company') {
      $('difficulty-select').value = frame.filters.difficulty;
      syncSelectControl($('difficulty-select'));
      $('question-search').value = frame.filters.query;
      renderCompanyTopicControls(frame);
    } else {
      $('detail-results').hidden = false; $('detail-topic-groups').hidden = true; $('detail-topic-group-tools').hidden = true;
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
    const byTopic = frame.kind === 'company' && scopeGrouped(frame);
    const appearances = frame.kind === 'company' ? [...frame.topicGroups.values()].reduce((sum, group) => sum + group.total, 0) : 0;
    $('detail-results').setAttribute('aria-busy', String(frame.loading));
    $('detail-topic-groups').setAttribute('aria-busy', String(frame.loading));
    $('detail-summary').textContent = frame.loading ? 'Loading saved ' + noun + '…' : byTopic
      ? count(frame.total) + ' unique questions · ' + count(frame.topicGroups.size) + ' topic groups · ' + count(appearances) + ' grouped appearances'
      : count(frame.rows.length) + ' of ' + count(frame.total) + ' ' + noun +
        (frame.kind === 'company' && (frame.filters.query || frame.filters.topics.length || frame.filters.difficulty) ? ' matching your filters' : '');
    const message = frame.error || (!frame.loading && !frame.available ? unavailable() : !frame.loading && !frame.total
      ? frame.kind === 'company' ? 'No questions match these filters in this time window.' : 'No company matches in this dataset. Coverage may be incomplete.' : '');
    $('detail-message').textContent = message; $('detail-message').hidden = !message;
    $('detail-message').toggleAttribute('data-error', Boolean(frame.error));
    $('detail-retry').hidden = !frame.error; $('detail-retry').disabled = frame.loading;
    $('detail-load-more').hidden = frame.kind !== 'company' || byTopic || !frame.hasMore;
    $('detail-load-more').disabled = frame.loading;
    $('detail-order').textContent = orderLabel(detailSortKey(frame), frame.sort);
    if (frame.kind === 'company') {
      $('expand-detail-topic-groups').disabled = $('collapse-detail-topic-groups').disabled = frame.loading || !frame.topicGroups.size;
      const unavailableFilters = !frame.loading && frame.version !== null && !frame.available;
      $('difficulty-select').disabled = unavailableFilters; syncSelectControl($('difficulty-select'));
      $('detail-topic-match-select').disabled = unavailableFilters; syncSelectControl($('detail-topic-match-select'));
      $('detail-topic-picker-trigger').disabled = unavailableFilters;
    }
  }
  async function loadDetail(append = false) {
    const frame = activeDetail();
    if (!frame || (append && (frame.loading || !frame.hasMore || (frame.kind === 'company' && scopeGrouped(frame))))) return;
    if (append && frame.version !== detailVersion(frame)) append = false;
    const id = ++detailRequest, stamp = generation;
    const offset = append ? frame.rows.length : 0;
    if (!append) {
      frame.rows = []; frame.total = 0; frame.hasMore = false; frame.version = null;
      if (frame.kind === 'problem') { frame.acceptanceRate = null; renderDetailShell(); }
      renderDetailRows([]);
    }
    frame.loading = true; frame.error = ''; renderDetailSummary();
    try {
      const message = frame.kind === 'problem' ? { type: 'LCT_GET', slug: frame.slug, window: windowKey() }
        : { ...baseCompanyRequest(frame), offset, limit: scopeGrouped(frame) ? 1 : 50 };
      const result = await api.runtime.sendMessage(message);
      if (id !== detailRequest || stamp !== generation || frame !== activeDetail()) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load these details. Try again.');
      if (frame.kind === 'company' && append && frame.sourceRevision !== sourceRevision(result)) {
        status = result.status || status; restartProblemResults(frame); return;
      }
      const next = frame.kind === 'problem' ? core.sortCompanies(Array.isArray(result.companies) ? result.companies : [], frame.sort)
        : Array.isArray(result.questions) ? result.questions : [];
      if (frame.kind === 'company') {
        const total = Number(result.total), known = new Set(append ? frame.rows.map(row => row.slug) : []);
        const invalid = next.some(row => {
          if (!row || typeof row.slug !== 'string' || !core.SLUG_PATTERN.test(row.slug) || known.has(row.slug)) return true;
          known.add(row.slug); return false;
        });
        if (!Number.isInteger(total) || total < offset + next.length || invalid ||
            (result.offset !== undefined && result.offset !== offset) ||
            (result.available !== false && Boolean(result.hasMore) !== (offset + next.length < total)) ||
            (result.available !== false && !next.length && total > offset)) throw new Error('Could not continue these questions. Try again.');
      }
      status = result.status || status;
      if (frame.kind === 'problem') {
        const problem = result.problem && typeof result.problem === 'object' ? result.problem : null;
        frame.acceptanceRate = problem?.acceptanceRate ?? null;
        if (typeof problem?.title === 'string' && problem.title.trim()) frame.title = problem.title;
        if (typeof problem?.difficulty === 'string') frame.difficulty = problem.difficulty;
      }
      frame.rows = append ? frame.rows.concat(next) : next;
      frame.total = frame.kind === 'problem' ? next.length : Number(result.total) || 0;
      frame.available = result.available !== false;
      frame.hasMore = frame.kind === 'company' && Boolean(result.hasMore);
      frame.sourceRevision = sourceRevision(result);
      frame.sourceUrl = typeof result.sourceUrl === 'string' ? result.sourceUrl : null;
      frame.version = detailVersion(frame);
      renderDetailRows(next, append);
      if (frame.kind === 'company') syncTopicGroups(result, frame);
      renderDetailShell(); renderStatus();
    } catch (cause) {
      if (id === detailRequest && stamp === generation && frame === activeDetail()) frame.error = cause.message || 'Could not load these details.';
    } finally {
      if (id === detailRequest && stamp === generation && frame === activeDetail()) { frame.loading = false; renderDetailSummary(); }
    }
  }

  function openDetail(value) {
    pendingDetail = null;
    invalidate();
    const filters = { difficulty: '', topic: '', query: '', ...value.filters };
    if (value.kind === 'company') {
      const legacy = typeof filters.topic === 'string' && filters.topic.trim() ? [filters.topic.trim()] : [];
      const selected = validatedProblemView({ ...filters, topics: Array.isArray(filters.topics) ? filters.topics : legacy });
      Object.assign(filters, selected);
      filters.topic = filters.topics.length === 1 ? filters.topics[0] : '';
    }
    stack.push({ ...value, sort: value.sort || sorts[value.kind === 'company' ? 'companyQuestions' : 'problemCompanies'],
      rows: [], total: 0, hasMore: false, available: false, loading: false, error: '', topics: [], version: null,
      topicGroups: new Map(), groupsContext: '', groupsRevision: null, filters });
    renderShell(); renderDetailShell();
    $('detail-back').focus();
    void loadDetail();
  }
  function focusResult(container, frame) {
    const button = Array.from(container.querySelectorAll('button[data-action]')).filter(item => item.getClientRects().length).find(item => frame.kind === 'problem' ? item.dataset.slug === frame.slug : item.dataset.company === frame.name);
    (button || (activeDetail() ? $('detail-back') : $('global-search'))).focus();
  }
  function back() {
    pendingDetail = null;
    const previous = stack.pop();
    invalidate(); renderShell();
    const frame = activeDetail();
    if (frame) {
      renderDetailShell(); renderDetailRows(frame.rows); renderDetailSummary();
      if (frame.version !== detailVersion(frame)) void loadDetail();
      focusResult(frame.kind === 'company' && scopeGrouped(frame) ? $('detail-topic-groups') : $('detail-results'), previous);
      if (frame.kind === 'company') resumeTopicGroups(frame);
    } else {
      renderListRows(list.rows); renderListSummary();
      if (list.version !== listVersion()) void loadList();
      focusResult(grouped() ? $('topic-groups') : $('results'), previous);
      resumeTopicGroups();
    }
  }
  function switchMode(next) {
    pendingDetail = null;
    invalidate(); mode = next; stack.length = 0;
    list = { rows: [], total: 0, hasMore: false, available: false, loading: false, error: '', version: null };
    renderShell(); $('global-search').focus(); void loadList();
  }
  function reloadCurrent() {
    invalidate(); resetTopicGroups(); topicCatalog = [];
    list.version = null;
    for (const frame of stack) {
      frame.version = null; frame.sourceUrl = null; frame.acceptanceRate = null;
      if (frame.kind === 'company') { resetTopicGroups(frame); frame.topics = []; }
    }
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
    pendingDetail = null;
    queries[mode] = $('global-search').value.slice(0, 200);
    if (mode === 'problems') { problemFiltersChanged(true, false); return; }
    invalidate();
    list.version = null; list.hasMore = false; list.loading = true;
    renderListSummary();
    searchTimer = setTimeout(() => void loadList(), 150);
  });
  $('problem-difficulty-select').addEventListener('change', () => {
    problemView.difficulty = $('problem-difficulty-select').value; problemFiltersChanged();
  });
  $('topic-match-select').addEventListener('change', () => {
    problemView.topicMatch = $('topic-match-select').value === 'all' ? 'all' : 'any'; problemFiltersChanged();
  });
  $('topic-picker-trigger').addEventListener('click', () => pickerOpen ? closeTopicPicker() : openTopicPicker());
  $('topic-picker-trigger').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if (!pickerOpen) openTopicPicker(); }
  });
  $('topic-picker-search').addEventListener('input', renderTopicOptions);
  $('topic-picker-search').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); $('topic-picker-options').querySelector('input:not(:disabled)')?.focus(); }
  });
  $('topic-picker-options').addEventListener('keydown', event => {
    if (!event.target.matches('input') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const inputs = Array.from($('topic-picker-options').querySelectorAll('input:not(:disabled)'));
    const index = inputs.indexOf(event.target);
    event.preventDefault();
    inputs[event.key === 'Home' ? 0 : event.key === 'End' ? inputs.length - 1 : Math.max(0, Math.min(inputs.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  $('topic-picker-reset').addEventListener('click', () => { draftTopics = []; syncTopicDraft(); });
  $('topic-picker-apply').addEventListener('click', () => {
    if (!pickerOpen) return;
    const frame = pickerFrame, topics = [...draftTopics];
    if (frame ? frame !== activeDetail() : activeDetail() || mode !== 'problems') { closeTopicPicker(); return; }
    closeTopicPicker(true);
    if (frame) { frame.filters.topics = topics; companyFiltersChanged(frame); }
    else { problemView.topics = topics; problemFiltersChanged(); }
  });
  $('topic-picker-clear').addEventListener('click', () => {
    problemView.topics = []; problemFiltersChanged(); $('topic-picker-trigger').focus();
  });
  document.addEventListener('keydown', event => {
    if (pickerOpen && event.key === 'Escape') { event.preventDefault(); closeTopicPicker(true); }
  });
  document.addEventListener('pointerdown', event => {
    if (pickerOpen && !pickerTrigger?.contains(event.target) && !$('topic-picker-menu').contains(event.target)) closeTopicPicker();
  });
  document.addEventListener('focusin', event => {
    if (pickerOpen && !pickerTrigger?.contains(event.target) && !$('topic-picker-menu').contains(event.target)) closeTopicPicker();
  });
  window.addEventListener('resize', () => closeTopicPicker($('topic-picker-menu').contains(document.activeElement)));
  window.addEventListener('scroll', event => {
    if (pickerOpen && !$('topic-picker-menu').contains(event.target)) closeTopicPicker($('topic-picker-menu').contains(document.activeElement));
  }, true);
  for (const view of ['list', 'topics']) $('problem-view-' + view).addEventListener('click', () => {
    if (problemView.view === view) return;
    pendingDetail = null; invalidate(); problemView.view = view;
    list.version = null; renderProblemControls(); renderListSummary(); saveProblemView(); void loadList();
  });
  function expandTopicGroups(frame = null) {
    if (!scopeActive(frame)) return;
    for (const group of scopeGroups(frame).values()) {
      group.open = true; renderTopicGroupState(group);
      if (!group.rows.length && !group.error && group.total > 0) queueTopicGroup(group);
    }
  }
  function collapseTopicGroups(frame = null) {
    if (!scopeActive(frame)) return;
    for (let index = groupQueue.length - 1; index >= 0; index--) if (groupQueue[index].frame === frame) groupQueue.splice(index, 1);
    for (const group of scopeGroups(frame).values()) {
      group.open = false;
      if (group.queued) { group.queued = false; group.request++; }
      renderTopicGroupState(group);
    }
  }
  $('expand-topic-groups').addEventListener('click', () => expandTopicGroups());
  $('collapse-topic-groups').addEventListener('click', () => collapseTopicGroups());
  $('expand-detail-topic-groups').addEventListener('click', () => expandTopicGroups(activeDetail()));
  $('collapse-detail-topic-groups').addEventListener('click', () => collapseTopicGroups(activeDetail()));
  $('detail-topic-picker-trigger').addEventListener('click', () => {
    const frame = activeDetail();
    if (!frame || frame.kind !== 'company') return;
    if (pickerOpen && pickerFrame === frame) closeTopicPicker();
    else { closeTopicPicker(); openTopicPicker(frame); }
  });
  $('detail-topic-picker-trigger').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const frame = activeDetail(); if (frame?.kind === 'company' && !pickerOpen) openTopicPicker(frame);
    }
  });
  $('detail-topic-picker-clear').addEventListener('click', () => {
    const frame = activeDetail(); if (frame?.kind !== 'company') return;
    frame.filters.topics = []; companyFiltersChanged(frame); $('detail-topic-picker-trigger').focus();
  });
  $('detail-topic-match-select').addEventListener('change', () => {
    const frame = activeDetail(); if (frame?.kind !== 'company') return;
    frame.filters.topicMatch = $('detail-topic-match-select').value === 'all' ? 'all' : 'any';
    companyFiltersChanged(frame);
  });
  for (const view of ['list', 'topics']) $('detail-view-' + view).addEventListener('click', () => {
    const frame = activeDetail(); if (frame?.kind !== 'company' || frame.filters.view === view) return;
    invalidate(); frame.filters.view = view; frame.version = null;
    renderCompanyTopicControls(frame); renderDetailSummary(); void loadDetail();
  });
  $('sort-select').addEventListener('change', () => changeSort(mode, $('sort-select').value));
  $('detail-sort-select').addEventListener('change', () => { const frame = activeDetail(); if (frame) changeSort(detailSortKey(frame), $('detail-sort-select').value); });
  $('load-more').addEventListener('click', () => void loadList(true));
  $('search-retry').addEventListener('click', () => void loadList());
  $('detail-load-more').addEventListener('click', () => void loadDetail(true));
  $('detail-retry').addEventListener('click', () => void loadDetail());
  $('detail-back').addEventListener('click', back);
  function filterChanged(debounce = false) {
    const frame = activeDetail();
    if (!frame || frame.kind !== 'company') return;
    frame.filters.difficulty = $('difficulty-select').value;
    frame.filters.query = $('question-search').value.slice(0, 200);
    companyFiltersChanged(frame, debounce);
  }
  $('difficulty-select').addEventListener('change', () => filterChanged());
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
      const stored = await api.storage.local.get(['lctSettings', 'lctStatus', 'lctExplorerSorts', 'lctExplorerProblemView']);
      settings = { ...defaults, ...stored.lctSettings }; status = stored.lctStatus || {};
      sorts = validatedSorts(stored.lctExplorerSorts);
      if (!problemViewDirty) problemView = validatedProblemView(stored.lctExplorerProblemView);
    } catch (_) { /* The cache request below reports a usable connection error. */ }
    // Consume the initial route once. User navigation can cancel it while the
    // preferences load; automatic storage updates cannot reopen it later.
    const initialDetail = pendingDetail;
    pendingDetail = null;
    if (initialDetail?.window) settings.window = initialDetail.window;
    renderShell(); renderStatus();
    if (initialDetail) openDetail(initialDetail);
    else if (activeDetail()) { renderDetailShell(); void loadDetail(); }
    else await loadList();
  }
  enhanceSelects();
  void start();
})();
