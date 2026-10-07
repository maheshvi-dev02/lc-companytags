(() => {
  'use strict';

  if (globalThis.__companyLensActive) return;
  globalThis.__companyLensActive = true;
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.LCTCore;
  const defaults = { enabled: true, collapsed: false, window: 'all' };
  const windowLabels = { all: 'All time', '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months', older: 'Older than 6 months' };
  let settings = { ...defaults };
  let slug = null;
  let lastUrl = '';
  let host = null;
  let view = null;
  let companies = [];
  let status = {};
  let error = '';
  let loading = false;
  let requestId = 0;
  let disposed = false;
  let companiesExpanded = false;
  let windowAvailable = false;
  let practiceCompany = null;
  let practiceQuestions = [];
  let practiceTotal = 0;
  let practiceAvailable = false;
  let practiceLoading = false;
  let practiceError = '';
  let practiceRequestId = 0;
  let topicTimer;
  const previewCount = 5;
  const frequencyHelp = 'Scores come from the selected source window. They are not interview counts and may not be directly comparable between companies.';
  const selectedWindow = () => Object.hasOwn(windowLabels, settings.window) ? settings.window : 'all';

  const css = `
    :host { all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; width: min(344px, calc(100vw - 24px)); font: 13px/1.5 "Segoe UI", sans-serif; color-scheme: light; --paper:#fff; --ink:#162b3b; --muted:#617480; --line:#dfE8eb; --wash:#f4f8f9; --teal:#007b77; --tag:#eaf6f3; --warn:#855815; --warn-bg:#fff7e5; }
    :host([data-dark]) { color-scheme: dark; --paper:#19252f; --ink:#e6f0f3; --muted:#a4b5bf; --line:#35454e; --wash:#22323c; --teal:#73d8c8; --tag:#203e40; --warn:#f0cd89; --warn-bg:#3a3325; }
    * { box-sizing: border-box; }
    .card { background:var(--paper); color:var(--ink); border:1px solid var(--line); border-radius:16px; box-shadow:0 12px 44px #10233329, 0 2px 8px #10233312; overflow:hidden; }
    .header { display:flex; align-items:center; gap:10px; padding:13px 15px; }
    .mark { position:relative; width:22px; height:22px; flex:none; border:2px solid var(--teal); border-radius:8px; }
    .mark::before { content:""; position:absolute; width:6px; height:6px; top:4px; left:4px; border:1.5px solid var(--teal); border-radius:50%; }
    .mark::after { content:""; position:absolute; width:5px; height:2px; background:var(--teal); top:12px; left:11px; transform:rotate(45deg); }
    .brand { font-size:14px; font-weight:700; letter-spacing:-.2px; flex:1; }
    .badge { color:var(--teal); font:11px/1.4 Consolas, monospace; white-space:nowrap; }
    button, input, select { font:inherit; }
    button { cursor:pointer; }
    .collapse { display:grid; place-items:center; width:27px; height:27px; padding:0; color:var(--muted); background:transparent; border:1px solid transparent; border-radius:7px; font-size:18px; line-height:1; }
    button:hover { background:var(--wash); }
    button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline:2px solid var(--teal); outline-offset:3px; }
    .body { border-top:1px solid var(--line); padding:15px; max-height: min(560px, calc(100vh - 105px)); overflow:auto; overscroll-behavior:contain; }
    [hidden] { display:none !important; }
    .eyebrow { color:var(--muted); text-transform:uppercase; letter-spacing:1.1px; font:10px/1.5 Consolas, monospace; margin:0 0 6px; }
    h2 { font-size:16px; font-weight:650; line-height:1.35; margin:0 0 5px; overflow-wrap:anywhere; }
    .count { color:var(--muted); font-size:12px; margin:0 0 13px; }
    .window-filter { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 5px; font-size:11px; color:var(--muted); }
    select { color:var(--ink); background:var(--wash); border:1px solid var(--line); border-radius:7px; padding:6px 8px; max-width:180px; min-height:32px; }
    .window-note { margin:0 0 14px; font-size:10px; color:var(--muted); }
    .search { display:block; margin:0 0 12px; }
    .search input { width:100%; border:1px solid var(--line); color:var(--ink); background:var(--wash); border-radius:8px; padding:8px 10px; min-height:35px; }
    .search input::placeholder { color:var(--muted); opacity:1; }
    .frequency-heading { color:var(--muted); font:10px/1.5 Consolas,monospace; margin:0 0 7px; cursor:help; }
    .frequency-heading:focus-visible { outline:2px solid var(--teal); outline-offset:3px; }
    .companies { display:grid; gap:4px; margin:0; padding:1px 0; list-style:none; }
    .companies[data-scrollable] { max-height:250px; overflow:auto; }
    .companies li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px; margin:0; padding:0; max-width:100%; }
    .companies a { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid transparent; border-radius:6px; padding:4px 9px; font-size:12px; font-weight:600; color:var(--teal); background:var(--tag); text-decoration:none; overflow-wrap:anywhere; }
    .companies a:hover { border-color:var(--teal); }
    .frequency-score { flex:none; color:var(--muted); font:11px/1.5 Consolas,monospace; font-variant-numeric:tabular-nums; }
    .company-name, .company-rank { display:block; }
    .company-rank { margin-top:1px; color:var(--muted); font-size:9px; font-weight:400; }
    .practice-company { align-self:stretch; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--teal); padding:4px 7px; font-size:10px; }
    .show-companies { display:flex; align-items:center; justify-content:space-between; width:100%; color:var(--teal); border:1px solid var(--line); background:transparent; border-radius:7px; padding:7px 9px; margin-top:8px; font-size:11px; font-weight:600; }
    .chevron { width:7px; height:7px; margin-right:2px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(45deg) translateY(-2px); }
    [aria-expanded="true"] .chevron { transform:rotate(225deg) translate(-1px,-1px); }
    .empty { margin:6px 0 12px; color:var(--muted); font-size:13px; }
    .status { margin-top:14px; border-top:1px solid var(--line); padding-top:11px; }
    .status-message { font-size:12px; color:var(--muted); margin:0; overflow-wrap:anywhere; }
    .status[data-warning] .status-message { color:var(--warn); background:var(--warn-bg); padding:8px; border-radius:6px; }
    progress { display:block; accent-color:var(--teal); width:100%; height:4px; margin:10px 0 4px; border:0; }
    .actions { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:9px 0 0; }
    .source { color:var(--muted); font-size:11px; text-decoration:none; text-underline-offset:3px; }
    .source:hover { color:var(--teal); text-decoration:underline; }
    .refresh { color:var(--teal); border:1px solid var(--line); background:transparent; border-radius:6px; padding:4px 9px; font-size:11px; }
    button:disabled { opacity:.55; cursor:wait; }
    .note { color:var(--muted); font-size:10px; line-height:1.5; margin:11px 0 0; }
    .back-companies { border:0; background:transparent; color:var(--teal); padding:0; margin:0 0 11px; font-size:11px; }
    .practice-filters { display:grid; grid-template-columns:1fr; gap:8px; margin:12px 0; }
    .practice-filters label { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--muted); font-size:11px; }
    .practice-filters input { width:180px; min-height:32px; padding:6px 8px; color:var(--ink); background:var(--wash); border:1px solid var(--line); border-radius:7px; }
    .practice-summary { font-size:11px; color:var(--muted); margin:0 0 8px; }
    .practice-questions { list-style:none; margin:0; padding:0; max-height:230px; overflow:auto; }
    .practice-questions li + li { border-top:1px solid var(--line); }
    .practice-questions a { display:block; padding:9px 1px; color:var(--teal); text-decoration:none; font-size:12px; font-weight:600; }
    .practice-questions a:hover .question-title { text-decoration:underline; text-underline-offset:3px; }
    .question-meta, .question-topics { display:block; font-size:10px; color:var(--muted); font-weight:400; margin-top:3px; }
    @media (max-width:480px) { :host { right:12px; bottom:12px; } .body { max-height: min(420px, calc(100vh - 90px)); } }
    @media (prefers-reduced-motion:no-preference) { .card { animation:arrive .16s ease-out; } @keyframes arrive { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } } }
  `;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sourceLink(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith('/liquidslr/leetcode-company-wise-problems/')) return parsed.href;
    } catch (_) { /* Fall back to the public dataset. */ }
    return core.SOURCE_URL;
  }

  function updateTheme() {
    if (!host) return;
    const html = document.documentElement;
    const explicitDark = html.classList.contains('dark') || html.dataset.theme === 'dark';
    const explicitLight = html.classList.contains('light') || html.dataset.theme === 'light';
    const dark = explicitDark || (!explicitLight && matchMedia('(prefers-color-scheme: dark)').matches);
    host.toggleAttribute('data-dark', dark);
  }

  function mount() {
    if (host || !slug || !settings.enabled) return;
    host = element('div');
    host.id = 'company-lens-root';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = element('style', null, css);
    const card = element('section', 'card');
    card.setAttribute('aria-label', 'Company Lens company tags');
    const header = element('div', 'header');
    const mark = element('span', 'mark');
    mark.setAttribute('aria-hidden', 'true');
    const badge = element('span', 'badge');
    const collapse = element('button', 'collapse');
    collapse.type = 'button';
    collapse.setAttribute('aria-controls', 'company-lens-body');
    header.append(mark, element('span', 'brand', 'Company Lens'), badge, collapse);
    const body = element('div', 'body');
    body.id = 'company-lens-body';
    const windowFilter = element('label', 'window-filter', 'Time window');
    const windowSelect = element('select', 'window-select');
    windowSelect.setAttribute('aria-label', 'Time window');
    for (const [value, label] of Object.entries(windowLabels)) {
      const option = element('option', null, label);
      option.value = value;
      windowSelect.append(option);
    }
    windowFilter.append(windowSelect);
    const windowNote = element('p', 'window-note');
    const companyView = element('div', 'company-view');
    const title = element('h2');
    const count = element('p', 'count');
    const searchWrap = element('label', 'search');
    const search = element('input');
    search.type = 'search';
    search.placeholder = 'Find a company';
    search.setAttribute('aria-label', 'Filter company names');
    search.autocomplete = 'off';
    searchWrap.append(search);
    const frequencyHeading = element('p', 'frequency-heading');
    frequencyHeading.tabIndex = 0;
    const list = element('ul', 'companies');
    list.id = 'company-lens-companies';
    list.setAttribute('aria-label', 'Companies listed for this problem');
    const showCompanies = element('button', 'show-companies');
    showCompanies.type = 'button';
    showCompanies.setAttribute('aria-controls', list.id);
    const showCompaniesLabel = element('span');
    const chevron = element('span', 'chevron');
    chevron.setAttribute('aria-hidden', 'true');
    showCompanies.append(showCompaniesLabel, chevron);
    const empty = element('p', 'empty');
    const statusBox = element('div', 'status');
    const statusMessage = element('p', 'status-message');
    statusMessage.setAttribute('role', 'status');
    const progress = element('progress');
    progress.setAttribute('aria-label', 'Dataset sync progress');
    const actions = element('div', 'actions');
    const source = element('a', 'source', 'View dataset ↗');
    source.href = core.SOURCE_URL;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    const refresh = element('button', 'refresh', 'Refresh');
    refresh.type = 'button';
    refresh.setAttribute('aria-label', 'Refresh company dataset');
    actions.append(source, refresh);
    statusBox.append(statusMessage, progress, actions);
    companyView.append(element('p', 'eyebrow', 'Problem companies'), title, count, searchWrap, frequencyHeading, list, showCompanies, empty);
    const practiceView = element('section', 'practice-view');
    practiceView.setAttribute('aria-label', 'Company practice questions');
    const backCompanies = element('button', 'back-companies', '← Back to companies');
    backCompanies.type = 'button';
    const practiceTitle = element('h2', 'practice-title');
    const practiceFilters = element('div', 'practice-filters');
    const difficultyLabel = element('label', null, 'Difficulty');
    const difficultySelect = element('select', 'difficulty-select');
    difficultySelect.setAttribute('aria-label', 'Difficulty');
    for (const difficulty of ['', 'Easy', 'Medium', 'Hard']) {
      const option = element('option', null, difficulty || 'All difficulties');
      option.value = difficulty;
      difficultySelect.append(option);
    }
    difficultyLabel.append(difficultySelect);
    const topicLabel = element('label', null, 'Topic');
    const topicInput = element('input', 'topic-input');
    topicInput.type = 'search';
    topicInput.placeholder = 'e.g. Array';
    topicInput.setAttribute('aria-label', 'Topic filter');
    topicLabel.append(topicInput);
    practiceFilters.append(difficultyLabel, topicLabel);
    const practiceSummary = element('p', 'practice-summary');
    practiceSummary.setAttribute('role', 'status');
    const practiceList = element('ul', 'practice-questions');
    practiceList.setAttribute('aria-label', 'Practice questions sorted by frequency');
    practiceView.append(backCompanies, element('p', 'eyebrow', 'Company practice'), practiceTitle, practiceFilters, practiceSummary, practiceList);
    body.append(windowFilter, windowNote, companyView, practiceView, statusBox,
      element('p', 'note', 'Community company reports from liquidslr. Coverage may be incomplete. Company links open the source.'));
    card.append(header, body);
    shadow.append(style, card);
    document.documentElement.append(host);
    view = { body, title, count, badge, collapse, windowSelect, windowNote, companyView, search, searchWrap, frequencyHeading, list, showCompanies, showCompaniesLabel, empty, practiceView, backCompanies, practiceTitle, difficultySelect, topicInput, practiceSummary, practiceList, statusBox, statusMessage, progress, source, refresh };
    collapse.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      render();
      api.storage.local.set({ lctSettings: settings }).catch(() => { /* Keep the current session usable. */ });
    });
    showCompanies.addEventListener('click', () => {
      companiesExpanded = !companiesExpanded;
      renderCompanies();
      if (!companiesExpanded) view.list.scrollTop = 0;
    });
    search.addEventListener('input', renderCompanies);
    windowSelect.addEventListener('change', () => {
      settings.window = windowSelect.value;
      resetWindow();
      api.storage.local.set({ lctSettings: settings }).catch(() => { /* The selection still works for this page. */ });
    });
    backCompanies.addEventListener('click', () => {
      const previousCompany = practiceCompany;
      practiceCompany = null;
      practiceRequestId++;
      clearTimeout(topicTimer);
      render();
      const returnButton = Array.from(view.list.querySelectorAll('.practice-company')).find(button => button.dataset.company === previousCompany);
      (returnButton || view.windowSelect).focus();
    });
    difficultySelect.addEventListener('change', loadPractice);
    topicInput.addEventListener('input', () => {
      clearTimeout(topicTimer);
      practiceRequestId++;
      practiceQuestions = [];
      practiceLoading = true;
      renderPractice();
      topicTimer = setTimeout(loadPractice, 250);
    });
    refresh.addEventListener('click', refreshData);
    updateTheme();
    render();
  }

  function unmount() {
    if (host) host.remove();
    host = null;
    view = null;
  }

  function dateLabel(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderCompanies() {
    if (!view) return;
    const query = view.search.value.trim().toLocaleLowerCase();
    const ordered = core.sortCompanies(companies);
    const filtered = ordered.filter(company => company.name.toLocaleLowerCase().includes(query));
    const shown = query || companiesExpanded ? filtered : filtered.slice(0, previewCount);
    view.list.toggleAttribute('data-scrollable', shown.length > previewCount);
    const hasFrequency = companies.some(company => Number.isFinite(company.frequency) && company.frequency >= 0);
    view.frequencyHeading.hidden = companies.length === 0;
    view.frequencyHeading.textContent = hasFrequency ? 'Frequency score · high to low' : 'Frequency unavailable · A–Z';
    view.frequencyHeading.title = hasFrequency ? frequencyHelp : `Refresh to check for frequency scores. ${frequencyHelp}`;
    view.frequencyHeading.setAttribute('aria-label', `${view.frequencyHeading.textContent}. ${view.frequencyHeading.title}`);
    view.showCompanies.hidden = Boolean(query) || companies.length <= previewCount;
    view.showCompanies.setAttribute('aria-expanded', String(companiesExpanded));
    view.showCompaniesLabel.textContent = companiesExpanded ? 'Show fewer' : `Show all ${companies.length} companies`;
    view.list.replaceChildren(...shown.map((company, index) => {
      const item = element('li');
      const link = element('a');
      const knownFrequency = Number.isFinite(company.frequency) && company.frequency >= 0;
      const frequency = element('span', 'frequency-score', knownFrequency ? String(company.frequency) : '—');
      frequency.id = `company-lens-frequency-${index}`;
      frequency.title = knownFrequency ? `Frequency score: ${company.frequency}` : 'Frequency score unavailable';
      frequency.setAttribute('aria-label', frequency.title);
      const companyInfo = element('span', 'company-info');
      const rank = element('span', 'company-rank', Number.isInteger(company.rank) && company.rank > 0 ? `Company rank #${company.rank}` : 'Rank unavailable');
      rank.title = `This problem’s frequency rank within ${company.name} for ${windowLabels[selectedWindow()].toLowerCase()}. Equal scores share a rank.`;
      companyInfo.append(element('span', 'company-name', company.name), rank);
      link.append(companyInfo, frequency);
      link.href = sourceLink(company.sourceUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${company.name}, view source`);
      link.setAttribute('aria-describedby', frequency.id);
      const practiceButton = element('button', 'practice-company', 'Practice');
      practiceButton.type = 'button';
      practiceButton.setAttribute('aria-label', `Practice ${company.name}`);
      practiceButton.dataset.company = company.name;
      practiceButton.addEventListener('click', () => openPractice(company.name));
      item.append(link, practiceButton);
      return item;
    }));
    view.searchWrap.hidden = companies.length < 6 && !query;
    view.empty.hidden = filtered.length > 0;
    if (query && companies.length) view.empty.textContent = 'No company names match your search.';
    else if (loading && !status.hasData) view.empty.textContent = 'Loading company tags…';
    else if (!status.hasData && status.phase === 'syncing') view.empty.textContent = 'Building your company index. The first sync may take a minute.';
    else if (!status.hasData && (error || status.phase === 'error')) view.empty.textContent = 'Company data is unavailable. Check your connection, then refresh.';
    else if (!windowAvailable) view.empty.textContent = status.phase === 'syncing' ? 'This time window is syncing. It will appear when the updated dataset is ready.' : 'This time window is not downloaded yet. Refresh to load it.';
    else view.empty.textContent = 'No company matches in this dataset. This does not mean the problem has never been asked.';
  }

  function render() {
    if (!view) return;
    const total = companies.length;
    const revision = /^[a-f0-9]{40}$/i.test(status.commit || '') ? status.commit : '';
    view.source.href = revision ? `${core.SOURCE_URL.replace(/\/$/, '')}/tree/${revision}` : core.SOURCE_URL;
    view.source.title = revision ? `Dataset revision ${revision.slice(0, 7)}` : 'Public company dataset';
    const syncedDate = new Date(status.lastSyncedAt);
    view.statusMessage.title = status.lastSyncedAt && Number.isFinite(syncedDate.getTime()) ? `Last synced: ${syncedDate.toLocaleString()}` : '';
    view.title.textContent = core.formatProblemTitle(slug);
    view.count.textContent = `${total} ${total === 1 ? 'company' : 'companies'} · ${windowLabels[selectedWindow()].toLowerCase()}`;
    view.windowSelect.value = selectedWindow();
    view.windowNote.textContent = status.sourceUpdatedAt ? `Windows relative to source updated ${dateLabel(status.sourceUpdatedAt)}` : 'Time windows follow the dates in the source dataset.';
    view.companyView.hidden = Boolean(practiceCompany);
    view.practiceView.hidden = !practiceCompany;
    view.badge.textContent = status.phase === 'syncing' ? 'syncing' : `${total} ${total === 1 ? 'company' : 'companies'}`;
    view.body.hidden = settings.collapsed;
    view.collapse.textContent = settings.collapsed ? '+' : '−';
    view.collapse.setAttribute('aria-expanded', String(!settings.collapsed));
    view.collapse.setAttribute('aria-label', settings.collapsed ? 'Expand Company Lens' : 'Collapse Company Lens');
    view.collapse.title = settings.collapsed ? 'Expand' : 'Collapse';
    view.refresh.disabled = status.phase === 'syncing';
    view.refresh.textContent = status.phase === 'syncing' ? 'Syncing…' : 'Refresh';
    view.progress.hidden = status.phase !== 'syncing';
    if (status.total > 0) {
      view.progress.max = status.total;
      view.progress.value = Math.min(status.completed || 0, status.total);
    } else view.progress.removeAttribute('value');
    const failure = error || (status.phase === 'error' ? status.message || 'Refresh failed. Check your connection and try again.' : '');
    const stale = status.lastCheckedAt && Date.now() - new Date(status.lastCheckedAt).getTime() > 48 * 60 * 60 * 1000;
    view.statusBox.toggleAttribute('data-warning', Boolean(failure || stale));
    if (failure) view.statusMessage.textContent = `${status.hasData ? 'Showing saved data. ' : ''}${failure}`;
    else if (status.phase === 'syncing') view.statusMessage.textContent = status.total > 0 ? `Syncing dataset · ${status.completed || 0} of ${status.total}` : 'Checking the latest dataset…';
    else if (stale) view.statusMessage.textContent = `Saved data · last checked ${dateLabel(status.lastCheckedAt)}. Refresh for updates.`;
    else if (status.sourceUpdatedAt) view.statusMessage.textContent = `Source updated ${dateLabel(status.sourceUpdatedAt)}`;
    else if (status.lastCheckedAt || status.lastSyncedAt) view.statusMessage.textContent = `Last checked ${dateLabel(status.lastCheckedAt || status.lastSyncedAt)}`;
    else view.statusMessage.textContent = loading ? 'Connecting to the company dataset…' : 'Live source · saved locally after sync';
    renderCompanies();
    renderPractice();
  }

  function resetWindow() {
    requestId++;
    companies = [];
    windowAvailable = false;
    companiesExpanded = false;
    error = '';
    render();
    void loadCompanies();
    if (practiceCompany) void loadPractice();
  }

  function openPractice(company) {
    practiceCompany = company;
    view.difficultySelect.value = '';
    view.topicInput.value = '';
    render();
    view.backCompanies.focus();
    void loadPractice();
  }

  function renderPractice() {
    if (!view || !practiceCompany) return;
    view.practiceTitle.textContent = practiceCompany;
    if (practiceError) view.practiceSummary.textContent = practiceError;
    else if (practiceLoading) view.practiceSummary.textContent = 'Loading practice questions…';
    else if (!practiceAvailable) view.practiceSummary.textContent = status.phase === 'syncing' ? 'Practice questions are syncing for this window.' : 'Practice questions are not downloaded for this window. Refresh the dataset.';
    else if (!practiceTotal) view.practiceSummary.textContent = 'No questions match these filters in this time window.';
    else {
      const order = practiceQuestions.some(question => Number.isFinite(question.frequency) && question.frequency >= 0) ? 'highest frequency first' : 'frequency unavailable';
      view.practiceSummary.textContent = `${practiceQuestions.length} of ${practiceTotal} questions · ${order}`;
    }
    view.practiceList.replaceChildren(...practiceQuestions.map(question => {
      const item = element('li');
      const link = element('a');
      link.href = `https://leetcode.com/problems/${encodeURIComponent(question.slug)}/`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(element('span', 'question-title', question.title));
      const score = Number.isFinite(question.frequency) && question.frequency >= 0 ? String(question.frequency) : 'unavailable';
      const rank = Number.isInteger(question.rank) && question.rank > 0 ? `company rank #${question.rank}` : 'rank unavailable';
      link.append(element('span', 'question-meta', `${question.difficulty || 'Difficulty unavailable'} · score ${score} · ${rank}`));
      if (Array.isArray(question.topics) && question.topics.length) {
        const topics = element('span', 'question-topics', question.topics.slice(0, 3).join(' · '));
        topics.title = question.topics.join(', ');
        link.append(topics);
      }
      item.append(link);
      return item;
    }));
  }

  async function loadPractice() {
    if (!practiceCompany || !view) return;
    const id = ++practiceRequestId;
    practiceQuestions = [];
    practiceLoading = true;
    practiceError = '';
    renderPractice();
    try {
      const message = { type: 'LCT_PRACTICE', company: practiceCompany, window: selectedWindow(), limit: 20 };
      if (slug) message.excludeSlug = slug;
      if (view.difficultySelect.value) message.difficulty = view.difficultySelect.value;
      if (view.topicInput.value.trim()) message.topic = view.topicInput.value.trim();
      const result = await api.runtime.sendMessage(message);
      if (id !== practiceRequestId || !practiceCompany) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load practice questions. Try again.');
      practiceQuestions = Array.isArray(result.questions) ? result.questions : [];
      practiceTotal = Number(result.total) || 0;
      practiceAvailable = result.available !== false;
    } catch (cause) {
      if (id !== practiceRequestId) return;
      practiceError = cause.message || 'Could not load practice questions. Try again.';
    } finally {
      if (id === practiceRequestId) { practiceLoading = false; renderPractice(); }
    }
  }

  async function loadCompanies() {
    const currentSlug = slug;
    const currentRequest = ++requestId;
    if (!currentSlug || !settings.enabled) return;
    loading = true;
    error = '';
    render();
    try {
      const result = await api.runtime.sendMessage({ type: 'LCT_GET', slug: currentSlug, window: selectedWindow() });
      if (currentRequest !== requestId || currentSlug !== slug) return;
      if (!result?.ok) throw new Error(result?.error || 'The company dataset could not be loaded. Try Refresh.');
      companies = Array.isArray(result.companies) ? result.companies : [];
      windowAvailable = result.available ?? Boolean(result.status?.hasData && selectedWindow() === 'all');
      status = result.status || status;
    } catch (cause) {
      if (currentRequest !== requestId || currentSlug !== slug) return;
      error = /context invalidated/i.test(cause.message) ? 'Extension updated. Reload this page to reconnect.' : cause.message || 'Could not connect. Check your connection, then refresh.';
    } finally {
      if (currentRequest === requestId && currentSlug === slug) {
        loading = false;
        render();
      }
    }
  }

  async function refreshData() {
    const currentSlug = slug;
    error = '';
    status = { ...status, phase: 'syncing', completed: 0, total: 0 };
    render();
    try {
      const result = await api.runtime.sendMessage({ type: 'LCT_REFRESH' });
      if (!result?.ok) throw new Error(result?.error || 'Refresh failed. Check your connection and try again.');
      if (slug !== currentSlug) return;
      status = result.status || status;
      await loadCompanies();
      if (practiceCompany) await loadPractice();
    } catch (cause) {
      if (slug !== currentSlug) return;
      status = { ...status, phase: 'error' };
      error = cause.message || 'Refresh failed. Check your connection and try again.';
      render();
    }
  }

  function checkNavigation(force = false) {
    if (disposed) return;
    const nextUrl = location.href;
    if (!force && nextUrl === lastUrl && (!slug || host?.isConnected || !settings.enabled)) return;
    lastUrl = nextUrl;
    const nextSlug = core.getProblemSlug(nextUrl);
    if (nextSlug !== slug) {
      slug = nextSlug;
      requestId++;
      companies = [];
      companiesExpanded = false;
      windowAvailable = false;
      practiceCompany = null;
      practiceRequestId++;
      clearTimeout(topicTimer);
      error = '';
      loading = false;
      if (view) view.search.value = '';
      if (!slug) unmount();
      if (slug && settings.enabled) { mount(); render(); void loadCompanies(); }
    } else if (slug && settings.enabled) {
      if (host && !host.isConnected) { host = null; view = null; }
      mount();
      render();
      if (force) void loadCompanies();
    }
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'LCT_CONTEXT') return false;
    sendResponse({ slug: core.getProblemSlug(location.href) });
    return false;
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lctSettings) {
      const previousEnabled = settings.enabled;
      const previousWindow = selectedWindow();
      settings = { ...defaults, ...changes.lctSettings.newValue };
      if (!settings.enabled) { requestId++; unmount(); }
      else checkNavigation(previousEnabled !== settings.enabled);
      if (previousWindow !== selectedWindow()) resetWindow();
      render();
    }
    if (changes.lctStatus) {
      const previous = status;
      status = changes.lctStatus.newValue || {};
      if (status.phase !== 'error') error = '';
      render();
      if (status.hasData && status.phase !== 'syncing' && (previous.phase === 'syncing' || status.lastSyncedAt !== previous.lastSyncedAt)) {
        void loadCompanies();
        if (practiceCompany) void loadPractice();
      }
    }
  });

  async function start() {
    try {
      const stored = await api.storage.local.get(['lctSettings', 'lctStatus']);
      settings = { ...defaults, ...stored.lctSettings };
      status = stored.lctStatus || {};
    } catch (_) { /* Start with defaults if storage is temporarily unavailable. */ }
    checkNavigation(true);
    const interval = setInterval(checkNavigation, 800);
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateTheme);
    addEventListener('popstate', () => checkNavigation());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNavigation(true); });
    addEventListener('pagehide', event => {
      if (!event.persisted) { disposed = true; clearInterval(interval); observer.disconnect(); }
    }, { once: true });
  }

  void start();
})();
