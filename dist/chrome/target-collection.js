/* Local Target collections and CSV export. Saved rows contain no account snapshot. */
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.LCTTargetCollection = value;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'lctTargetCollection', MAX_TARGETS = 100;
  const text = (value, max = 200) => typeof value === 'string' && value.length <= max ? value : '';
  const strings = (value, limit = 256) => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.trim() && item.length <= 200))].slice(0, limit) : [];
  function cleanTarget(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 50) throw new Error('Invalid saved Target.');
    const input = value.context || {}, seen = new Set();
    if (!['random', 'plan'].includes(input.targetMode) || !['all', '30d', '3m', '6m', 'older'].includes(input.window) || (typeof (input.difficulty || '') !== 'string' || (input.difficulty || '').length > 30 || (input.difficulty || '').split(',').filter(Boolean).some(v => !['Easy', 'Medium', 'Hard'].includes(v.trim()))) || !['all', 'solved', 'not-solved'].includes(input.completionFilter || 'all')) throw new Error('Invalid Target filters.');
    const companies = strings(input.companies === undefined ? (input.company ? [input.company] : []) : input.companies, 500);
    const company = companies.length === 1 ? companies[0] : '';
    if (input.targetMode === 'plan' && !companies.length) throw new Error('Choose a target company.');
    const questions = value.questions.map(row => {
      if (!row || typeof row.slug !== 'string' || row.slug.length > 200 || row.slug !== row.slug.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) || seen.has(row.slug) || !text(row.title, 500)) throw new Error('Invalid Target problem.');
      seen.add(row.slug);
      return { slug: row.slug, title: row.title, difficulty: ['Easy', 'Medium', 'Hard'].includes(row.difficulty) ? row.difficulty : '',
        companyMatches: (Array.isArray(row.companyMatches) ? row.companyMatches : []).filter(m => companies.includes(m?.name)).slice(0, 500).map(m => ({ name: m.name, frequency: Number.isFinite(m.frequency) && m.frequency >= 0 ? m.frequency : null, rank: Number.isInteger(m.rank) && m.rank > 0 ? m.rank : null })),
        topics: strings(row.topics), newTopics: strings(row.newTopics),
        acceptanceRate: Number.isFinite(row.acceptanceRate) && row.acceptanceRate >= 0 && row.acceptanceRate <= 100 ? row.acceptanceRate : null,
        frequency: Number.isFinite(row.frequency) && row.frequency >= 0 ? row.frequency : null,
        rank: Number.isInteger(row.rank) && row.rank > 0 ? row.rank : null };
    });
    return { context: { targetMode: input.targetMode, company, companies, topicMatch: input.topicMatch === 'all' ? 'all' : 'any', window: input.window, difficulty: input.difficulty || '', topics: strings(input.topics), completionFilter: input.completionFilter || 'all', count: Number.isInteger(input.count) && input.count >= 1 && input.count <= 50 ? input.count : questions.length },
      questions, coveredTopics: strings(value.coveredTopics), availableTopicCount: Number.isInteger(value.availableTopicCount) && value.availableTopicCount >= 0 ? value.availableTopicCount : 0,
      sourceRevision: text(value.sourceRevision), total: Number.isInteger(value.total) && value.total >= questions.length ? value.total : questions.length };
  }
  function nameFor(target) { return (((target.context.companies || [target.context.company]).filter(Boolean).join(' + ') || 'Random problem') + (target.context.targetMode === 'plan' ? ' prep' : '')).slice(0, 100); }
  function cleanName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f]/.test(value)) throw new Error('Enter a collection name (1–100 characters).');
    return value.trim();
  }
  function validID(value) { return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value); }
  function create(storage) {
    let queue = Promise.resolve();
    const serial = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
    async function read() {
      const stored = (await storage.get(KEY))[KEY], entries = [];
      for (const entry of Array.isArray(stored) ? stored : []) {
        try { if (validID(entry?.id) && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))) entries.push({ ...cleanTarget(entry), id: entry.id, name: cleanName(entry.name || nameFor(entry)), createdAt: entry.createdAt, updatedAt: entry.updatedAt || entry.createdAt, revision: Number.isInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1 }); } catch (_) { /* Skip malformed saved entries. */ }
      }
      return entries;
    }
    function existing(entries, id, revision) {
      if (!validID(id)) throw new Error('Invalid saved Target.');
      const entry = entries.find(target => target.id === id);
      if (!entry) throw new Error('This collection was removed. Open another saved target.');
      if (revision !== entry.revision) throw new Error('This collection changed in another view. Open it again before editing.');
      return entry;
    }
    const newID = () => globalThis.crypto?.randomUUID?.() || 'target-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return {
      list: () => serial(read),
      save: value => serial(async () => {
        const target = cleanTarget(value), entries = await read();
        if (entries.length >= MAX_TARGETS) throw new Error('Your collection has 100 targets. Remove a saved target before adding another.');
        const createdAt = new Date().toISOString();
        const entry = { ...target, id: newID(), name: cleanName(value.name === undefined ? nameFor(target) : value.name), createdAt, updatedAt: createdAt, revision: 1 };
        await storage.set({ [KEY]: [entry, ...entries] }); return entry;
      }),
      update: (id, name, revision, value) => serial(async () => {
        const entries = await read(), original = existing(entries, id, revision);
        const target = value === undefined ? cleanTarget(original) : cleanTarget(value);
        const entry = { ...target, id, name: cleanName(name), createdAt: original.createdAt, updatedAt: new Date().toISOString(), revision: original.revision + 1 };
        await storage.set({ [KEY]: entries.map(item => item.id === id ? entry : item) }); return entry;
      }),
      clone: (id, name, revision, value) => serial(async () => {
        const entries = await read(), original = existing(entries, id, revision);
        if (entries.length >= MAX_TARGETS) throw new Error('Your collection has 100 targets. Remove a saved target before adding another.');
        const createdAt = new Date().toISOString(), target = value === undefined ? cleanTarget(original) : cleanTarget(value);
        const entry = { ...target, id: newID(), name: cleanName(name), createdAt, updatedAt: createdAt, revision: 1 };
        await storage.set({ [KEY]: [entry, ...entries] }); return entry;
      }),
      remove: id => serial(async () => {
        if (!validID(id)) throw new Error('Invalid saved Target.');
        const entries = await read(); await storage.set({ [KEY]: entries.filter(entry => entry.id !== id) });
      })
    };
  }
  function csv(value) {
    const target = cleanTarget(value);
    const cell = value => {
      let content = value === null || value === undefined ? '' : String(value);
      if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(content)) content = "'" + content;
      return '"' + content.replace(/"/g, '""') + '"';
    };
    const header = ['Position', 'Company', 'Time window', 'Title', 'Difficulty', 'Topics', 'Acceptance rate (%)', 'Frequency score', 'Company rank', 'LeetCode URL'];
    const rows = target.questions.map((row, index) => [index + 1, row.companyMatches.length ? row.companyMatches.map(m => m.name).join('; ') : target.context.companies.join('; '), target.context.window === 'older' ? 'Older than 6 months' : target.context.window, row.title, row.difficulty, row.topics.join('; '), row.acceptanceRate, row.companyMatches.length ? row.companyMatches.map(m => m.name + ': ' + (m.frequency ?? '')).join('; ') : row.frequency, row.companyMatches.length ? row.companyMatches.map(m => m.name + ': ' + (m.rank ?? '')).join('; ') : row.rank, 'https://leetcode.com/problems/' + row.slug + '/']);
    return '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  return { create, csv, cleanTarget, KEY };
});
