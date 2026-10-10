(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.LCTCore;
  const logos = globalThis.LCTCompanyLogos;
  const $ = id => document.getElementById(id);
  const defaults = { enabled: true, collapsed: false, window: 'all' };
  const windowLabels = { all: 'All time', '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months', older: 'Older than 6 months' };
  let settings = { ...defaults };
  let status = {};
  let companies = [];
  let slug = null;
  let activeTabId = null;
  let problem = null;
  let problemLoaded = false;
  let error = '';
  let loading = false;
  let requestId = 0;
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

  const companySortOptions = [
    ['frequency-desc', 'Highest frequency'], ['frequency-asc', 'Lowest frequency'],
    ['name-asc', 'Company name A–Z'], ['name-desc', 'Company name Z–A']
  ];
  let companySort = 'frequency-desc';
  let companySortSave = Promise.resolve();
  let sortMenuOpen = false;
  let sortActiveIndex = 0;
  let sortTypeahead = '';
  let sortTypedAt = 0;
  const validCompanySort = value => companySortOptions.some(([key]) => key === value) ? value : 'frequency-desc';

  function closeCompanySort(returnFocus = false) {
    sortMenuOpen = false;
    $('company-sort-menu').hidden = true;
    $('company-sort-trigger').setAttribute('aria-expanded', 'false');
    $('company-sort-trigger').removeAttribute('aria-activedescendant');
    sortTypeahead = '';
    if (returnFocus) $('company-sort-trigger').focus();
  }
  function syncCompanySort() {
    $('company-sort-value').textContent = companySortOptions.find(([key]) => key === companySort)[1];
    Array.from($('company-sort-menu').children).forEach(option => {
      option.setAttribute('aria-selected', String(option.dataset.value === companySort));
    });
  }
  function setSortActive(index) {
    const options = Array.from($('company-sort-menu').children);
    sortActiveIndex = Math.max(0, Math.min(options.length - 1, index));
    options.forEach((option, i) => option.toggleAttribute('data-active', i === sortActiveIndex));
    const active = options[sortActiveIndex];
    $('company-sort-trigger').setAttribute('aria-activedescendant', active.id);
    const menu = $('company-sort-menu');
    if (active.offsetTop < menu.scrollTop) menu.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = active.offsetTop + active.offsetHeight - menu.clientHeight;
    }
  }
  function openCompanySort(edge) {
    const trigger = $('company-sort-trigger');
    if (trigger.hidden) return;
    const menu = $('company-sort-menu');
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 190), document.documentElement.clientWidth - 16);
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const upward = below < 160 && above > below;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(0, Math.min(220, upward ? above : below))}px`;
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8))}px`;
    menu.style.top = `${upward ? Math.max(8, rect.top - 6 - menu.getBoundingClientRect().height) : rect.bottom + 6}px`;
    sortMenuOpen = true;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.focus();
    setSortActive(edge === 'first' ? 0 : edge === 'last' ? companySortOptions.length - 1 : companySortOptions.findIndex(([key]) => key === companySort));
  }
  function changeCompanySort(value, save = false) {
    const next = validCompanySort(value);
    if (next === companySort) return;
    companySort = next;
    renderCompanies();
    $('companies').scrollTop = 0;
    if (save) {
      companySortSave = companySortSave.then(() => api.storage.local.set({ lctPopupCompanySort: next })).catch(() => {
        error = 'Could not save your sort preference. The current view still works.';
        renderStatus();
      });
    }
  }
  function pickCompanySort(option) {
    if (!option) return;
    closeCompanySort(true);
    changeCompanySort(option.dataset.value, true);
  }
  function setupCompanySort() {
    const menu = document.createElement('div');
    menu.id = 'company-sort-menu';
    menu.className = 'company-sort-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Sort companies');
    menu.hidden = true;
    menu.append(...companySortOptions.map(([value, label], index) => {
      const option = document.createElement('div');
      option.id = `company-sort-option-${index}`;
      option.className = 'company-sort-option';
      option.setAttribute('role', 'option');
      option.dataset.value = value;
      option.textContent = label;
      return option;
    }));
    document.body.append(menu);
    syncCompanySort();
    const trigger = $('company-sort-trigger');
    trigger.addEventListener('click', () => sortMenuOpen ? closeCompanySort() : openCompanySort());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Tab') { closeCompanySort(); return; }
      if (event.key === 'Escape') { if (sortMenuOpen) { event.preventDefault(); closeCompanySort(true); } return; }
      if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); closeCompanySort(true); return; }
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'Enter' || event.key === ' ') {
          if (sortMenuOpen) pickCompanySort(menu.children[sortActiveIndex]);
          else openCompanySort();
        } else if (!sortMenuOpen) openCompanySort(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined);
        else setSortActive(event.key === 'Home' ? 0 : event.key === 'End' ? companySortOptions.length - 1 : sortActiveIndex + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!sortMenuOpen) openCompanySort();
        const now = Date.now();
        sortTypeahead = (now - sortTypedAt < 700 ? sortTypeahead : '') + event.key.toLocaleLowerCase();
        sortTypedAt = now;
        const repeated = Array.from(sortTypeahead).every(letter => letter === sortTypeahead[0]);
        const prefix = repeated ? sortTypeahead[0] : sortTypeahead;
        const start = repeated ? sortActiveIndex + 1 : sortActiveIndex;
        for (let step = 0; step < companySortOptions.length; step++) {
          const index = (start + step) % companySortOptions.length;
          if (companySortOptions[index][1].toLocaleLowerCase().startsWith(prefix)) { setSortActive(index); break; }
        }
      }
    });
    menu.addEventListener('click', event => {
      const option = event.target.closest('[role="option"]');
      if (option?.parentNode === menu) pickCompanySort(option);
    });
    menu.addEventListener('pointermove', event => {
      const option = event.target.closest('[role="option"]');
      if (option?.parentNode === menu) setSortActive(Array.from(menu.children).indexOf(option));
    });
    document.addEventListener('pointerdown', event => {
      if (sortMenuOpen && !trigger.contains(event.target) && !menu.contains(event.target)) closeCompanySort();
    });
    document.addEventListener('focusin', event => {
      if (sortMenuOpen && event.target !== trigger && !menu.contains(event.target)) closeCompanySort();
    });
    window.addEventListener('resize', () => closeCompanySort());
    window.addEventListener('scroll', event => {
      if (sortMenuOpen && !menu.contains(event.target)) closeCompanySort();
    }, true);
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

  function dateLabel(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function safeSource(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith('/liquidslr/leetcode-company-wise-problems/')) return parsed.href;
    } catch (_) { /* Use the known repository link. */ }
    return core.SOURCE_URL;
  }

  function renderCompanies() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const ordered = core.sortCompanies(companies, companySort);
    const filtered = ordered.filter(company => company.name.toLocaleLowerCase().includes(query));
    const shown = query || companiesExpanded ? filtered : filtered.slice(0, previewCount);
    $('companies').toggleAttribute('data-scrollable', shown.length > previewCount);
    const hasFrequency = companies.some(company => Number.isFinite(company.frequency) && company.frequency >= 0);
    $('frequency-heading').hidden = companies.length === 0;
    $('company-tools').hidden = companies.length === 0;
    $('company-sort-trigger').hidden = companies.length < 2;
    if (companies.length < 2) closeCompanySort();
    syncCompanySort();
    $('companies').setAttribute('aria-label', `Companies listed for this problem, sorted by ${companySortOptions.find(([key]) => key === companySort)[1].toLocaleLowerCase()}`);
    $('frequency-heading').textContent = hasFrequency ? 'Frequency score' : 'Frequency unavailable';
    $('frequency-heading').title = hasFrequency ? frequencyHelp : `Refresh to check for frequency scores. ${frequencyHelp}`;
    $('frequency-heading').setAttribute('aria-label', `${$('frequency-heading').textContent}. ${$('frequency-heading').title}`);
    $('show-companies').hidden = Boolean(query) || companies.length <= previewCount;
    $('show-companies').setAttribute('aria-expanded', String(companiesExpanded));
    $('show-companies-label').textContent = companiesExpanded ? 'Show fewer' : `Show all ${companies.length} companies`;
    $('companies').replaceChildren(...shown.map((company, index) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      const companyName = document.createElement('span');
      companyName.className = 'company-name';
      companyName.textContent = company.name;
      const knownFrequency = Number.isFinite(company.frequency) && company.frequency >= 0;
      const frequency = document.createElement('span');
      frequency.className = 'frequency-score';
      frequency.textContent = knownFrequency ? String(company.frequency) : '—';
      frequency.id = `company-frequency-${index}`;
      frequency.title = knownFrequency ? `Frequency score: ${company.frequency}` : 'Frequency score unavailable';
      frequency.setAttribute('aria-label', frequency.title);
      const companyInfo = document.createElement('span');
      companyInfo.className = 'company-info';
      const rank = document.createElement('span');
      rank.className = 'company-rank';
      rank.textContent = Number.isInteger(company.rank) && company.rank > 0 ? `Company rank #${company.rank}` : 'Rank unavailable';
      rank.title = `This problem’s frequency rank within ${company.name} for ${windowLabels[selectedWindow()].toLowerCase()}. Equal scores share a rank.`;
      companyInfo.append(companyName, rank);
      const identity = document.createElement('span');
      identity.className = 'company-identity';
      identity.append(logos.createBadge(company.name), companyInfo);
      link.append(identity, frequency);
      link.href = safeSource(company.sourceUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${company.name}, view source`);
      link.setAttribute('aria-describedby', frequency.id);
      const practiceButton = document.createElement('button');
      practiceButton.type = 'button';
      practiceButton.className = 'practice-company';
      practiceButton.textContent = 'Practice';
      practiceButton.setAttribute('aria-label', `Practice ${company.name}`);
      practiceButton.dataset.company = company.name;
      practiceButton.addEventListener('click', () => openPractice(company.name));
      item.append(link, practiceButton);
      return item;
    }));
    $('search-wrap').hidden = companies.length < 6 && !query;
    renderCompanyMessage(filtered.length > 0);
  }

  function renderCompanyMessage(hasMatches = $('companies').childElementCount > 0) {
    const query = $('search').value.trim();
    $('empty').hidden = !slug || hasMatches;
    if (query && companies.length) $('empty').textContent = 'No company names match your search.';
    else if (loading && !status.hasData) $('empty').textContent = 'Loading company tags…';
    else if (!status.hasData && status.phase === 'syncing') $('empty').textContent = 'Preparing company tags…';
    else if (!windowAvailable) $('empty').textContent = status.phase === 'syncing' ? 'This time window is syncing. It will appear when the updated dataset is ready.' : 'This time window is not downloaded yet. Refresh to load it.';
    else $('empty').textContent = 'No company matches in this dataset. Coverage may be incomplete.';
  }

  function renderStatus() {
    const revision = /^[a-f0-9]{40}$/i.test(status.commit || '') ? status.commit : '';
    $('source').href = revision ? `${core.SOURCE_URL.replace(/\/$/, '')}/tree/${revision}` : core.SOURCE_URL;
    $('source').title = revision ? `Dataset revision ${revision.slice(0, 7)}` : 'Public company dataset';
    const syncedDate = new Date(status.lastSyncedAt);
    $('status').title = status.lastSyncedAt && Number.isFinite(syncedDate.getTime()) ? `Last synced: ${syncedDate.toLocaleString()}` : '';
    const snapshot = status.dataSource === 'bundled' ? 'Bundled snapshot · ' : '';
    $('window-note').textContent = status.sourceUpdatedAt ? `${snapshot}Windows relative to source updated ${dateLabel(status.sourceUpdatedAt)}` : 'Time windows follow the dates in the source dataset.';
    const failure = error || (status.phase === 'error' ? status.message || 'Refresh failed. Check your connection and try again.' : '');
    const stale = status.lastCheckedAt && Date.now() - new Date(status.lastCheckedAt).getTime() > 48 * 60 * 60 * 1000;
    $('dataset-state').textContent = status.phase === 'syncing' ? 'Syncing' : failure ? 'Needs attention' : stale ? 'Saved data' : status.hasData ? 'Ready' : 'Not synced';
    $('dataset-state').dataset.state = status.phase === 'syncing' ? 'syncing' : failure || stale ? 'warning' : status.hasData ? 'ready' : 'idle';
    $('dataset-state').toggleAttribute('data-warning', Boolean(failure || stale));
    $('dataset-summary').textContent = status.hasData ? `${Number(status.companyCount || 0).toLocaleString()} companies · ${Number(status.problemCount || 0).toLocaleString()} problems indexed` : 'Live data from liquidslr’s public GitHub repository.';
    $('status').toggleAttribute('data-warning', Boolean(failure || stale));
    if (failure) $('status').textContent = `${status.hasData ? 'Showing saved data. ' : ''}${failure}`;
    else if (status.phase === 'syncing') $('status').textContent = status.total > 0 ? `${snapshot}Syncing dataset · ${status.completed || 0} of ${status.total}` : `${snapshot}Checking the latest dataset…`;
    else if (stale) $('status').textContent = `${snapshot}Last checked ${dateLabel(status.lastCheckedAt)}. Refresh for updates.`;
    else if (status.sourceUpdatedAt) $('status').textContent = `${snapshot}Source updated ${dateLabel(status.sourceUpdatedAt)} · checked ${dateLabel(status.lastCheckedAt || status.lastSyncedAt)}`;
    else if (status.lastCheckedAt || status.lastSyncedAt) $('status').textContent = `${snapshot}Last checked ${dateLabel(status.lastCheckedAt || status.lastSyncedAt)}`;
    else $('status').textContent = 'Refresh to save the latest company index for offline use.';
    $('refresh').disabled = status.phase === 'syncing';
    $('refresh').textContent = status.phase === 'syncing' ? 'Syncing…' : 'Refresh dataset';
    $('progress').hidden = status.phase !== 'syncing';
    if (status.total > 0) {
      $('progress').max = status.total;
      $('progress').value = Math.min(status.completed || 0, status.total);
    } else $('progress').removeAttribute('value');
    renderCompanyMessage();
    renderPracticeSummary();
  }

  function render() {
    $('enabled').checked = settings.enabled;
    const title = typeof problem?.title === 'string' && problem.title.trim() ? problem.title : core.formatProblemTitle(slug);
    $('problem-title').textContent = slug ? title : 'Open a LeetCode problem';
    renderProblemAcceptance();
    $('problem-summary').textContent = slug ? `${companies.length} ${companies.length === 1 ? 'company' : 'companies'} · ${windowLabels[selectedWindow()].toLowerCase()}` : 'Company tags appear as you browse problem pages.';
    $('window-select').value = selectedWindow();
    $('company-view').hidden = Boolean(practiceCompany);
    $('practice-view').hidden = !practiceCompany;
    $('open-problems').hidden = Boolean(slug);
    renderCompanies();
    renderPractice();
    renderStatus();
  }

  function renderProblemAcceptance() {
    const line = $('problem-acceptance');
    line.hidden = !slug || !problemLoaded;
    line.replaceChildren();
    if (line.hidden) return;
    const acceptance = acceptanceInfo(problem?.acceptanceRate);
    line.append(acceptance.button, acceptance.help);
  }

  function resetWindow() {
    closeCompanySort();
    requestId++;
    companies = [];
    problem = null;
    problemLoaded = false;
    windowAvailable = false;
    companiesExpanded = false;
    error = '';
    render();
    void load();
    if (practiceCompany) void loadPractice();
  }

  function openPractice(company) {
    closeCompanySort();
    practiceCompany = company;
    $('difficulty-select').value = '';
    $('topic-input').value = '';
    render();
    $('back-companies').focus();
    void loadPractice();
  }

  function renderPracticeSummary() {
    if (!practiceCompany) return;
    if (practiceError) $('practice-summary').textContent = practiceError;
    else if (practiceLoading) $('practice-summary').textContent = 'Loading practice questions…';
    else if (!practiceAvailable) $('practice-summary').textContent = status.phase === 'syncing' ? 'Practice questions are syncing for this window.' : 'Practice questions are not downloaded for this window. Refresh the dataset.';
    else if (!practiceTotal) $('practice-summary').textContent = 'No questions match these filters in this time window.';
    else {
      const order = practiceQuestions.some(question => Number.isFinite(question.frequency) && question.frequency >= 0) ? 'highest frequency first' : 'frequency unavailable';
      $('practice-summary').textContent = `${practiceQuestions.length} of ${practiceTotal} questions · ${order}`;
    }
  }

  function renderPractice() {
    if (!practiceCompany) return;
    $('practice-title').textContent = practiceCompany;
    $('practice-heading').replaceChildren(logos.createBadge(practiceCompany), $('practice-title'));
    renderPracticeSummary();
    $('practice-questions').replaceChildren(...practiceQuestions.map(question => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `https://leetcode.com/problems/${encodeURIComponent(question.slug)}/`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const title = document.createElement('span');
      title.className = 'question-title';
      title.textContent = question.title;
      const score = Number.isFinite(question.frequency) && question.frequency >= 0 ? String(question.frequency) : 'unavailable';
      const rank = Number.isInteger(question.rank) && question.rank > 0 ? `company rank #${question.rank}` : 'rank unavailable';
      const meta = document.createElement('span');
      meta.className = 'question-meta';
      const acceptance = acceptanceInfo(question.acceptanceRate);
      meta.append(document.createTextNode(`${question.difficulty || 'Difficulty unavailable'} · `), acceptance.button, document.createTextNode(` · score ${score} · ${rank}`));
      link.append(title);
      item.append(link, meta, acceptance.help);
      if (Array.isArray(question.topics) && question.topics.length) {
        const topics = document.createElement('span');
        topics.className = 'question-topics';
        topics.textContent = question.topics.slice(0, 3).join(' · ');
        topics.title = question.topics.join(', ');
        item.append(topics);
      }
      return item;
    }));
  }

  async function loadPractice() {
    if (!practiceCompany) return;
    const id = ++practiceRequestId;
    practiceQuestions = [];
    practiceLoading = true;
    practiceError = '';
    renderPractice();
    try {
      const message = { type: 'LCT_PRACTICE', company: practiceCompany, window: selectedWindow(), limit: 20 };
      if (slug) message.excludeSlug = slug;
      if ($('difficulty-select').value) message.difficulty = $('difficulty-select').value;
      if ($('topic-input').value.trim()) message.topic = $('topic-input').value.trim();
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

  async function load() {
    const id = ++requestId;
    loading = true;
    problem = null;
    problemLoaded = false;
    renderProblemAcceptance();
    renderStatus();
    try {
      const result = await api.runtime.sendMessage(slug ? { type: 'LCT_GET', slug, window: selectedWindow() } : { type: 'LCT_STATUS' });
      if (id !== requestId) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load the dataset. Try Refresh.');
      status = result.status || status;
      if (Array.isArray(result.companies)) companies = result.companies;
      problem = result.problem && typeof result.problem === 'object' ? result.problem : null;
      problemLoaded = Boolean(slug);
      windowAvailable = result.available ?? Boolean(result.status?.hasData && selectedWindow() === 'all');
      error = '';
    } catch (cause) {
      if (id !== requestId) return;
      error = cause.message || 'Could not connect. Check your connection and try again.';
    } finally {
      if (id === requestId) { loading = false; render(); }
    }
  }

  $('explore-dataset').addEventListener('click', async () => {
    const button = $('explore-dataset');
    button.disabled = true;
    try {
      const query = $('search').value.trim();
      const result = await api.runtime.sendMessage({ type: 'LCT_OPEN_EXPLORER', mode: query ? 'companies' : 'problems', query });
      if (!result?.ok) throw new Error(result?.error || 'Could not open the dataset explorer.');
    } catch (cause) {
      error = cause.message || 'Could not open the dataset explorer.';
      renderStatus();
    } finally { button.disabled = false; }
  });
  $('search').addEventListener('input', renderCompanies);
  $('window-select').addEventListener('change', () => {
    settings.window = $('window-select').value;
    resetWindow();
    api.storage.local.set({ lctSettings: settings }).catch(() => { error = 'Could not save your time window preference.'; render(); });
  });
  $('back-companies').addEventListener('click', () => {
    const previousCompany = practiceCompany;
    practiceCompany = null;
    practiceRequestId++;
    clearTimeout(topicTimer);
    render();
    const returnButton = Array.from($('companies').querySelectorAll('.practice-company')).find(button => button.dataset.company === previousCompany);
    (returnButton || $('window-select')).focus();
  });
  $('difficulty-select').addEventListener('change', loadPractice);
  $('topic-input').addEventListener('input', () => {
    clearTimeout(topicTimer);
    practiceRequestId++;
    practiceQuestions = [];
    practiceLoading = true;
    renderPractice();
    topicTimer = setTimeout(loadPractice, 250);
  });
  $('show-companies').addEventListener('click', () => {
    companiesExpanded = !companiesExpanded;
    renderCompanies();
    if (!companiesExpanded) $('companies').scrollTop = 0;
  });
  $('enabled').addEventListener('change', async () => {
    const previousEnabled = settings.enabled;
    settings.enabled = $('enabled').checked;
    try { await api.storage.local.set({ lctSettings: settings }); }
    catch (_) { settings.enabled = previousEnabled; error = 'Could not save your display preference. Try again.'; render(); }
  });
  $('refresh').addEventListener('click', async () => {
    error = '';
    status = { ...status, phase: 'syncing', total: 0, completed: 0 };
    renderStatus();
    try {
      const result = await api.runtime.sendMessage({ type: 'LCT_REFRESH' });
      if (!result?.ok) throw new Error(result?.error || 'Refresh failed. Check your connection and try again.');
      status = result.status || status;
      await load();
      if (practiceCompany) await loadPractice();
    } catch (cause) {
      status = { ...status, phase: 'error' };
      error = cause.message || 'Refresh failed. Check your connection and try again.';
      renderStatus();
    }
  });
  api.storage.onChanged.addListener((changes, area) => {
    // The open popup owns its selected order. Read the saved preference on the
    // next open; delayed echoes from our queued writes must not undo a newer choice.
    if (area !== 'local' || (!changes.lctSettings && !changes.lctStatus && !changes.lctData)) return;
    if (changes.lctSettings) {
      const previousWindow = selectedWindow();
      settings = { ...defaults, ...changes.lctSettings.newValue };
      $('enabled').checked = settings.enabled;
      if (previousWindow !== selectedWindow()) resetWindow();
    }
    let dataChanged = Boolean(changes.lctData?.newValue);
    if (changes.lctStatus) {
      const previous = status;
      status = changes.lctStatus.newValue || {};
      if (status.phase !== 'error') error = '';
      dataChanged ||= Boolean(status.hasData && (!previous.hasData || status.commit !== previous.commit || status.lastSyncedAt !== previous.lastSyncedAt));
      // Status-only changes leave company and practice DOM nodes intact.
      renderStatus();
    }
    if (dataChanged) {
      void load();
      if (practiceCompany) void loadPractice();
    }
  });

  api.tabs.onUpdated?.addListener((tabId, change) => {
    if (tabId !== activeTabId || typeof change.url !== 'string') return;
    const nextSlug = core.getProblemSlug(change.url);
    if (nextSlug === slug) return;
    slug = nextSlug;
    $('search').value = '';
    resetWindow();
  });

  async function start() {
    try {
      const stored = await api.storage.local.get(['lctSettings', 'lctStatus', 'lctPopupCompanySort']);
      settings = { ...settings, ...stored.lctSettings };
      status = stored.lctStatus || {};
      companySort = validCompanySort(stored.lctPopupCompanySort);
    } catch (_) { /* The background request will report a usable error if needed. */ }
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id !== undefined) {
        activeTabId = tabs[0].id;
        const contextRequest = requestId;
        const context = await api.tabs.sendMessage(tabs[0].id, { type: 'LCT_CONTEXT' });
        if (contextRequest === requestId) slug = typeof context?.slug === 'string' ? context.slug : null;
      }
    } catch (_) { /* Other sites and tabs opened before installation have no content script. */ }
    render();
    await load();
  }
  setupCompanySort();
  void start();
})();
