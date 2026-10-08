import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeFixture } from './firefox-fixture.mjs';
import { exercisePanelLogos, exercisePopupLogos } from './browser-logos.mjs';
import { firefoxExplorerDriver, exerciseExplorer } from './browser-explorer.mjs';
import { bundledExpectations, exerciseBundledPanel, archiveFixture, browserArchiveCheck, assertArchiveResult, exerciseCollapsedBubble } from './browser-first-install.mjs';

// Installs and exercises the real Firefox MV3 addon. The default is deterministic:
// a dead proxy blocks extension requests. The packaged snapshot is verified on a
// fresh install before edge-case fixtures are seeded through the real background
// console and the unmodified distribution is reloaded.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/playwright');
await mkdir(output, { recursive: true });
const { firefox } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE,
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const core = require(path.join(root, 'dist/firefox/core.js'));
const { seed, html, commit } = makeFixture(core);
const id = 'company-lens@leetcode-tags.local';
const uuid = randomUUID();
const port = 23000 + Math.floor(Math.random() * 20000);
const report = { startedAt: new Date().toISOString(), mode: 'actual Firefox temporary addon, deterministic fixtures', checks: [] };

async function executable() {
  if (process.env.FIREFOX_EXECUTABLE) return process.env.FIREFOX_EXECUTABLE;
  const runtime = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  const installed = (await readdir(runtime)).filter((name) => /^firefox-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  return installed.length ? path.join(runtime, installed[0], 'firefox/firefox.exe') : undefined;
}

function rdpConnect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    const messages = [], waiters = [];
    const waitFor = (predicate, timeout = 30000) => {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((res, rej) => {
        const waiter = { predicate, resolve: res };
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error('Firefox RDP response timeout'));
        }, timeout);
        waiters.push(waiter);
      });
    };
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.indexOf(58) >= 0) {
        const colon = buffer.indexOf(58), length = Number(buffer.subarray(0, colon).toString());
        if (!Number.isFinite(length)) { reject(new Error('Bad Firefox RDP frame')); break; }
        if (buffer.length < colon + 1 + length) break;
        const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
        if (packet.type === 'target-available-form' && packet.target?.url?.includes('_generated_background_page.html'))
          backgroundConsole = packet.target.consoleActor;
        buffer = buffer.subarray(colon + 1 + length);
        const index = waiters.findIndex(({ predicate }) => predicate(packet));
        if (index >= 0) {
          const waiter = waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer); waiter.resolve(packet);
        } else messages.push(packet);
      }
    });
    socket.once('error', reject);
    socket.once('connect', () => resolve({ socket, waitFor,
      discard: (predicate) => { for (let i = messages.length - 1; i >= 0; i--) if (predicate(messages[i])) messages.splice(i, 1); },
      pending: () => messages,
      send: async (packet) => {
        const reply = waitFor((response) => response.from === packet.to && !response.type);
        const body = JSON.stringify(packet); socket.write(`${Buffer.byteLength(body)}:${body}`);
        const response = await reply.catch((error) => { throw new Error(`${error.message}: ${packet.type} to ${packet.to}`, { cause: error }); });
        assert.ok(!response.error, JSON.stringify(response));
        return response;
      },
    }));
  });
}

let context, rdp, page, backgroundConsole;
async function evaluateConsoleRaw(text, consoleActor = backgroundConsole) {
  const request = await rdp.send({ to: consoleActor, type: 'evaluateJSAsync', text });
  const response = await rdp.waitFor((packet) => packet.type === 'evaluationResult' && packet.resultID === request.resultID);
  assert.ok(!response.hasException && !response.topLevelAwaitRejected, response.exceptionMessage || JSON.stringify(response));
  if (response.result?.type === 'longString') {
    const value = await rdp.send({ to: response.result.actor, type: 'substring', start: 0, end: response.result.length });
    return value.substring;
  }
  return response.result;
}

async function evaluateBackground(body) {
  // Raw RDP does not perform the DevTools frontend's top-level-await rewrite.
  // Keep promise results in this isolated test background global and read them
  // through synchronous console expressions; production code is untouched.
  await evaluateConsoleRaw(`globalThis.__lctAuditResult = { done: false };
    (async () => { try {
      const value = await (async () => { ${body} })();
      globalThis.__lctAuditResult = { done: true, value };
    } catch (error) { globalThis.__lctAuditResult = { done: true, error: String(error.stack || error) }; } })(); 'started'`);
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = JSON.parse(await evaluateConsoleRaw('JSON.stringify(globalThis.__lctAuditResult)'));
    if (result.done) {
      assert.ok(!result.error, result.error);
      return result.value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Asynchronous Firefox background evaluation did not settle');
}

async function expectTexts(locator, expected) {
  let observed;
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = await locator.allTextContents();
    if (JSON.stringify(observed) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(observed, expected);
}

try {
  const expectedBundle = await bundledExpectations(path.join(root, 'dist/firefox'), core);
  const startupStartedAt = Date.now();
  context = await firefox.launchPersistentContext(path.join(output, `firefox-profile-${Date.now()}`), {
    headless: true, viewport: null, executablePath: await executable(),
    args: ['-start-debugger-server', String(port)],
    firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true,
      'devtools.debugger.prompt-connection': false,
      'devtools.chrome.enabled': true,
      'extensions.webextensions.uuids': JSON.stringify({ [id]: uuid }),
      'network.proxy.type': 1,
      'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 9,
      'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 9,
      'network.proxy.no_proxies_on': 'localhost,127.0.0.1',
      'network.proxy.allow_hijacking_localhost': false,
    },
  });
  await context.route(/https:\/\/(?:www\.)?leetcode\.(?:com|cn)\//,
    (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  rdp = await rdpConnect();
  await rdp.waitFor(() => true);
  const actors = await rdp.send({ to: 'root', type: 'getRoot' });
  const addonInstallationStartedAt = Date.now();
  const installed = await rdp.send({ to: actors.addonsActor, type: 'installTemporaryAddon', addonPath: path.join(root, 'dist/firefox') });
  assert.ok(installed.addon);
  const addons = await rdp.send({ to: 'root', type: 'listAddons' });
  report.addon = addons.addons.find((entry) => entry.id === id);
  assert.deepEqual(report.addon.warnings, []);
  const watcher = await rdp.send({ to: report.addon.actor, type: 'getWatcher' });
  report.watcher = watcher;
  await rdp.send({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
  const background = await rdp.waitFor((packet) => packet.type === 'target-available-form' &&
    packet.target?.url?.includes('_generated_background_page.html'));
  backgroundConsole = background.target.consoleActor;
  report.background = { url: background.target.url, actor: background.target.actor, consoleActor: backgroundConsole };
  const firstPage = await context.newPage();
  const navigationStartedAt = Date.now();
  await firstPage.goto('https://leetcode.com/problems/two-sum/description/');
  report.firstInstall = await exerciseBundledPanel(firstPage, expectedBundle, { startupStartedAt, navigationStartedAt, output, browserName: 'firefox' });
  report.firstInstall.addonInstallationToFirstPanelResultsMs = report.firstInstall.startupToFirstPanelResultsMs - (addonInstallationStartedAt - startupStartedAt);
  report.firstInstall.logos = await exercisePanelLogos(firstPage, expectedBundle.windows.all);
  report.checks.push(report.firstInstall.logos.check);
  await firstPage.screenshot({ path: path.join(output, 'firefox-first-install.png'), fullPage: true, animations: 'disabled' });
  report.checks.push(report.firstInstall.check);
  const offlineStatus = JSON.parse(await evaluateBackground('return JSON.stringify((await browser.storage.local.get("lctStatus")).lctStatus);'));
  assert.equal(offlineStatus.hasData, true);
  assert.equal(offlineStatus.dataSource, 'bundled');
  assert.equal(offlineStatus.commit, expectedBundle.data.commit);
  report.stage = 'Checking fresh bundled popup';
  const freshPopupUrl = report.addon.manifestURL.replace('manifest.json', 'popup.html');
  const freshPopupTab = await evaluateBackground(`return (await browser.tabs.create({ url: ${JSON.stringify(freshPopupUrl)}, active: false })).id;`);
  const freshPopupTarget = await rdp.waitFor((packet) => packet.type === 'target-available-form' && packet.target?.url === freshPopupUrl);
  let freshPopupObserved;
  for (let attempt = 0; attempt < 100; attempt++) {
    freshPopupObserved = JSON.parse(await evaluateConsoleRaw(`JSON.stringify({
      names: Array.from(document.querySelectorAll('.company-name'), node => node.textContent),
      window: document.querySelector('#window-select')?.value,
      note: document.querySelector('#window-note')?.textContent,
    })`, freshPopupTarget.target.consoleActor));
    if (freshPopupObserved.names.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(freshPopupObserved.names, expectedBundle.windows.all.slice(0, 5).map(({ name }) => name));
  assert.equal(freshPopupObserved.window, 'all');
  assert.match(freshPopupObserved.note, /Bundled snapshot/i);
  report.firstInstall.popupLogos = await exercisePopupLogos(firefoxExplorerDriver(source => evaluateConsoleRaw(source, freshPopupTarget.target.consoleActor)), expectedBundle.windows.all.slice(0, 5).map(company => company.name));
  report.checks.push(report.firstInstall.popupLogos.check);
  report.stage = 'Opening explorer from a popup on an unrelated site';
  const unrelatedPage = await context.newPage();
  await unrelatedPage.goto('https://example.com/');
  await unrelatedPage.bringToFront();
  assert.equal(await unrelatedPage.locator('#company-lens-root').count(), 0);
  const launcherTab = await evaluateBackground(`return (await browser.tabs.create({ url: ${JSON.stringify(freshPopupUrl)}, active: false })).id;`);
  const launcherTarget = await rdp.waitFor((packet) => packet.type === 'target-available-form' && packet.target?.url === freshPopupUrl);
  let launcherReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    report.launcherBeforeClick = JSON.parse(await evaluateConsoleRaw(`JSON.stringify({
      state: document.readyState, button: Boolean(document.querySelector('#explore-dataset')?.getClientRects().length),
      summary: document.querySelector('#dataset-summary')?.textContent || '',
      note: document.querySelector('#window-note')?.textContent || '', status: document.querySelector('#status')?.textContent || '',
    })`, launcherTarget.target.consoleActor));
    if (report.launcherBeforeClick.state === 'complete' && report.launcherBeforeClick.button &&
        report.launcherBeforeClick.summary.includes('470') && /Bundled snapshot/.test(report.launcherBeforeClick.note)) { launcherReady = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(launcherReady, true, 'The actual launcher popup must finish running its packaged scripts before clicking.');
  await evaluateConsoleRaw("document.querySelector('#explore-dataset').click(); 'opened'", launcherTarget.target.consoleActor);
  report.stage = 'Waiting for explorer document';
  let explorerTarget;
  try {
    explorerTarget = await rdp.waitFor((packet) => packet.type === 'target-available-form' &&
      packet.target?.url?.startsWith(report.addon.manifestURL.replace('manifest.json', 'explore.html')));
  } catch (error) {
    report.launcherAfterClick = JSON.parse(await evaluateConsoleRaw(`JSON.stringify({
      disabled: document.querySelector('#explore-dataset')?.disabled, status: document.querySelector('#status')?.textContent || '',
    })`, launcherTarget.target.consoleActor));
    report.openTabs = JSON.parse(await evaluateBackground('return JSON.stringify((await browser.tabs.query({})).map(({id,url,title,status}) => ({id,url,title,status})));'));
    throw error;
  }
  const explorerConsole = explorerTarget.target.consoleActor;
  report.stage = 'Exercising global explorer';
  report.explorer = await exerciseExplorer(firefoxExplorerDriver((source) => evaluateConsoleRaw(source, explorerConsole)),
    { data: expectedBundle.data, core, output, browserName: 'firefox' });
  report.explorer.openedFrom = 'Actual packaged popup while example.com was active; explorer document inspected and operated via Mozilla RDP with GitHub hosts blocked.';
  report.checks.push(...report.explorer.checks);
  const explorerTabs = JSON.parse(await evaluateBackground(`return JSON.stringify((await browser.tabs.query({})).filter((tab) =>
    tab.url?.startsWith(${JSON.stringify(report.addon.manifestURL.replace('manifest.json', 'explore.html'))})).map((tab) => tab.id));`));
  await evaluateBackground(`await browser.tabs.remove(${JSON.stringify(explorerTabs)}); return 'closed';`);
  await unrelatedPage.close();
  await evaluateBackground(`await browser.tabs.remove(${launcherTab}); return 'closed';`);
  report.firstInstall.popup = 'Actual packaged Firefox popup displays bundled all-time tags and source date, verified via Mozilla RDP.';
  report.checks.push(report.firstInstall.popup);
  report.stage = 'Checking network blocking and native archive decoding';
  const blocked = JSON.parse(await evaluateBackground(`return JSON.stringify(await Promise.all(
    ['https://api.github.com/', 'https://raw.githubusercontent.com/', 'https://codeload.github.com/'].map(async (url) => {
      try { await fetch(url); return { url, blocked: false }; }
      catch { return { url, blocked: true }; }
    })));`));
  assert.ok(blocked.every(({ blocked }) => blocked), 'Extension GitHub requests must be blocked before fixture seeding');
  report.checks.push('Real Firefox MV3 addon installs without manifest warnings; GitHub API, raw-file and codeload networking is blocked in its background process.');
  const localArchive = await archiveFixture(root, core);
  report.archive = JSON.parse(await evaluateBackground(`return JSON.stringify(await (${browserArchiveCheck.toString()})(${JSON.stringify(localArchive.payload)}));`));
  assertArchiveResult(report.archive, localArchive);
  report.checks.push('Native Firefox deflate-raw decoder extracts every real source archive CSV with CRC and Git blob validation.');
  let settled = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = JSON.parse(await evaluateBackground('return JSON.stringify((await browser.storage.local.get("lctStatus")).lctStatus);'));
    if (status && status.phase !== 'syncing') {
      assert.equal(status.hasData, true); assert.equal(status.dataSource, 'bundled'); settled = true; break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(settled, 'Initial blocked sync must settle before fixture seeding');
  report.stage = 'Seeding deterministic UI fixture';
  assert.equal(await evaluateBackground(`await browser.alarms.clearAll(); await browser.storage.local.set(${JSON.stringify(seed)}); return 'seeded';`), 'seeded');
  await evaluateBackground(`await browser.tabs.remove(${freshPopupTab}); return 'closed';`);
  rdp.discard((packet) => packet.type === 'target-available-form');
  await rdp.send({ to: report.addon.actor, type: 'reload' });
  const reloadedBackground = await rdp.waitFor((packet) => packet.type === 'target-available-form' &&
    packet.target?.url?.includes('_generated_background_page.html'));
  backgroundConsole = reloadedBackground.target.consoleActor;
  report.checks.push('Deterministic source data is seeded into actual addon storage and survives an addon reload.');

  page = await context.newPage();
  await page.goto('https://leetcode.com/problems/two-sum/description/');
  const host = page.locator('#company-lens-root');
  await host.waitFor({ state: 'visible', timeout: 30000 });
  await host.getByRole('link', { name: 'Amazon, view source', exact: true }).waitFor();
  await expectTexts(host.locator('.company-name'), ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg']);
  await expectTexts(host.locator('.frequency-score'), ['100', '91', '91', '65', '50']);
  assert.equal(await host.getByRole('link', { name: 'Amazon, view source', exact: true }).locator('.company-rank').textContent(), 'Company rank #2');
  assert.equal(await host.getByRole('link', { name: 'Amazon, view source', exact: true }).getAttribute('href'),
    `https://github.com/liquidslr/leetcode-company-wise-problems/blob/${commit}/Amazon/5.%20All.csv`);
  report.checks.push('Actual content script shows five companies in descending frequency order, with alphabetical ties, scores, ranks and pinned source links.');

  await host.getByRole('button', { name: 'Show all 7 companies' }).click();
  await expectTexts(host.locator('.company-name'), ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg', 'Meta', 'Microsoft']);
  assert.equal(await host.locator('.show-companies').getAttribute('aria-expanded'), 'true');
  assert.equal(await host.getByRole('link', { name: 'Meta, view source', exact: true }).locator('.frequency-score').textContent(), '0');
  assert.equal(await host.getByRole('link', { name: 'Microsoft, view source', exact: true }).locator('.frequency-score').textContent(), '—');
  assert.equal(await host.getByRole('link', { name: 'Microsoft, view source', exact: true }).locator('.company-rank').textContent(), 'Rank unavailable');
  await host.getByRole('button', { name: 'Show fewer' }).click();
  assert.equal(await host.locator('.companies a').count(), 5);
  report.checks.push('Show all / Show fewer expands the company list and preserves zero scores and unknown-score ranks.');

  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('micro');
  await expectTexts(host.locator('.company-name'), ['Microsoft']);
  assert.equal(await host.locator('.show-companies').isVisible(), false);
  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('unlisted-test-company');
  await host.locator('.empty').filter({ hasText: 'No company names match' }).waitFor();
  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('');
  await expectTexts(host.locator('.company-name'), ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg']);
  report.checks.push('Company search includes the hidden sixth/seventh companies and handles no-match searches.');

  const orders = [
    ['30d', ['Google', 'Meta', 'Amazon', 'Apple', 'Bloomberg']],
    ['3m', ['Spotify', 'Amazon', 'Apple', 'Google', 'Bloomberg']],
    ['6m', ['Meta', 'Amazon', 'Apple', 'Google', 'Spotify']],
    ['older', ['Bloomberg', 'Amazon', 'Apple', 'Google', 'Spotify']],
    ['all', ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg']],
  ];
  for (const [window, names] of orders) {
    await host.locator('.window-select').selectOption(window);
    await expectTexts(host.locator('.company-name'), names);
    if (window === '30d') {
      assert.equal(await host.getByRole('link', { name: 'Amazon, view source', exact: true }).locator('.company-rank').textContent(), 'Company rank #7');
      assert.ok((await host.getByRole('link', { name: 'Amazon, view source', exact: true }).getAttribute('href')).endsWith('/Amazon/1.%20Thirty%20Days.csv'));
    }
  }
  report.checks.push('All five time windows rerank companies and update per-company ranks and the matching source file.');

  const amazonPractice = ['Add Two Numbers', 'Merge Two Sorted Lists', 'Binary Tree Level Order Traversal',
    'Valid Parentheses', 'Longest Substring Without Repeating Characters', 'Maximum Depth of Binary Tree'];
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(host.locator('.practice-questions .question-title'), amazonPractice);
  assert.match(await host.locator('.practice-questions .question-meta').first().textContent(), /Medium.*score 180.*company rank #1/);
  assert.equal(await host.locator('.practice-questions a').first().getAttribute('href'), 'https://leetcode.com/problems/add-two-numbers/');
  await host.locator('.difficulty-select').selectOption('Medium');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Add Two Numbers', 'Binary Tree Level Order Traversal', 'Longest Substring Without Repeating Characters']);
  await host.locator('.topic-input').fill('Tree');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Binary Tree Level Order Traversal']);
  await host.locator('.topic-input').fill('not-a-fixture-topic');
  await host.locator('.practice-summary').filter({ hasText: 'No questions match these filters' }).waitFor();
  await expectTexts(host.locator('.practice-questions .question-title'), []);
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  report.checks.push('Practice lists sort by frequency, show scores/ranks, exclude the current problem, and support difficulty/topic/no-match filters.');

  report.collapsedGeometry = await exerciseCollapsedBubble(page, { output, browserName: 'firefox',
    getCollapsed: () => evaluateBackground('return Boolean((await browser.storage.local.get("lctSettings")).lctSettings?.collapsed);'),
    setCollapsed: (collapsed) => evaluateBackground(`const { lctSettings } = await browser.storage.local.get('lctSettings');
      await browser.storage.local.set({ lctSettings: { ...lctSettings, collapsed: ${collapsed} } }); return 'changed';`),
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForFunction(() => document.getElementById('company-lens-root')?.hasAttribute('data-dark'));
  await page.screenshot({ path: path.join(output, 'firefox-problem.png'), fullPage: true, animations: 'disabled' });
  report.checks.push(report.collapsedGeometry.check + ' The expanded panel follows the page dark theme.');

  await host.getByRole('button', { name: 'Show all 7 companies' }).click();
  await page.evaluate(() => history.pushState({}, '', '/problems/add-two-numbers/'));
  await host.locator('.company-view h2').filter({ hasText: 'Add Two Numbers' }).waitFor();
  await expectTexts(host.locator('.company-name'), ['Google', 'Amazon', 'Meta', 'Apple', 'Microsoft']);
  assert.equal(await host.locator('.show-companies').getAttribute('aria-expanded'), 'false');
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(host.locator('.practice-questions .question-title'), ['Two Sum', ...amazonPractice.slice(1)]);
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  report.checks.push('SPA problem changes rerank tags, reset expansion, and update the practice-list current-problem exclusion.');

  // Playwright cannot expose Firefox extension-process tabs as Page objects.
  // Mozilla RDP does expose the actual popup document, so dispatch the same
  // DOM input/change/click events through its console rather than mocking it.
  const popupUrl = report.addon.manifestURL.replace('manifest.json', 'popup.html');
  await evaluateBackground(`await browser.tabs.create({ url: ${JSON.stringify(popupUrl)}, active: false }); return 'opened';`);
  const popupTarget = await rdp.waitFor((packet) => packet.type === 'target-available-form' && packet.target?.url === popupUrl);
  const popupConsole = popupTarget.target.consoleActor;
  const popupRead = async (expression) => JSON.parse(await evaluateConsoleRaw(`JSON.stringify(${expression})`, popupConsole));
  const popupClick = async (selector) => evaluateConsoleRaw(`document.querySelector(${JSON.stringify(selector)}).click(); 'clicked'`, popupConsole);
  const popupSet = async (selector, value, event = 'change') => evaluateConsoleRaw(
    `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};
      document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); 'changed'`, popupConsole);
  const popupTexts = async (selector, expected) => {
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = await popupRead(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}), node => node.textContent)`);
      if (JSON.stringify(observed) === JSON.stringify(expected)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(observed, expected);
  };
  await popupTexts('.company-name', ['Google', 'Amazon', 'Meta', 'Apple', 'Microsoft']);
  await popupClick('#show-companies');
  assert.equal(await popupRead('document.querySelectorAll("#companies a").length'), 7);
  assert.equal(await popupRead('document.querySelector("#show-companies").getAttribute("aria-expanded")'), 'true');
  await popupClick('#show-companies');
  await popupSet('#search', 'Spotify', 'input');
  await popupTexts('.company-name', ['Spotify']);
  await popupSet('#search', '', 'input');
  await popupSet('#window-select', '30d');
  await page.waitForFunction(() => document.getElementById('company-lens-root')?.shadowRoot.querySelector('.window-select').value === '30d');
  await popupSet('#window-select', 'all');
  await popupTexts('.company-name', ['Google', 'Amazon', 'Meta', 'Apple', 'Microsoft']);
  await popupClick('[data-company="Amazon"]');
  await popupTexts('#practice-questions .question-title', ['Two Sum', ...amazonPractice.slice(1)]);
  await popupSet('#difficulty-select', 'Easy');
  await popupSet('#topic-input', 'Tree', 'input');
  await popupTexts('#practice-questions .question-title', ['Maximum Depth of Binary Tree']);
  await popupClick('#back-companies');
  report.popupVerification = 'Actual packaged popup DOM, inspected and operated via Mozilla RDP console; Playwright does not expose this extension-process tab.';
  report.checks.push('Actual packaged popup displays ranked tags, expansion, full-list search, shared windows and difficulty/topic-filtered practice questions.');

  await page.bringToFront();
  await page.waitForTimeout(200);
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await popupClick('[data-company="Amazon"]');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Two Sum', ...amazonPractice.slice(1)]);
  await popupTexts('#practice-questions .question-title', ['Two Sum', ...amazonPractice.slice(1)]);
  const retainedCompany = await host.locator('.companies a').first().elementHandle();
  const retainedQuestion = await host.locator('.practice-questions a').first().elementHandle();
  await host.locator('.practice-questions a').first().focus();
  await evaluateConsoleRaw(`globalThis.__lctProgressNodes = {
    company: document.querySelector('#companies a'), question: document.querySelector('#practice-questions a')
  }; 'retained'`, popupConsole);
  const statusBeforeProgress = JSON.parse(await evaluateBackground('return JSON.stringify((await browser.storage.local.get("lctStatus")).lctStatus);'));
  await evaluateBackground(`await browser.storage.local.set({
    lctStatus: { ...${JSON.stringify(statusBeforeProgress)}, phase: 'syncing', completed: 3, total: 35 },
    lctStage: { auditCheckpoint: true }, lctAuditChunk: { progress: 3 }
  }); return 'progress';`);
  await host.locator('.status-message').filter({ hasText: '3 of 35' }).waitFor();
  await page.waitForTimeout(1100);
  assert.equal(await retainedCompany.evaluate((node) => node.isConnected), true);
  assert.equal(await retainedQuestion.evaluate((node) => node.isConnected), true);
  assert.equal(await retainedQuestion.evaluate((node) => node.getRootNode().activeElement === node), true);
  assert.equal(await popupRead('globalThis.__lctProgressNodes.company.isConnected && globalThis.__lctProgressNodes.question.isConnected'), true);
  await evaluateBackground(`await browser.storage.local.set({ lctStatus: ${JSON.stringify(statusBeforeProgress)}, lctStage: null });
    await browser.storage.local.remove('lctAuditChunk'); return 'restored';`);
  await evaluateConsoleRaw("delete globalThis.__lctProgressNodes; 'cleared'", popupConsole);
  await retainedCompany.dispose(); await retainedQuestion.dispose();
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  await popupClick('#back-companies');
  report.checks.push('Background progress and unrelated storage checkpoints retain company/practice result nodes and the focused practice link.');

  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await host.locator('.difficulty-select').selectOption('Medium');
  await host.locator('.topic-input').fill('Tree');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Binary Tree Level Order Traversal']);
  const setEnabled = async (enabled) => evaluateConsoleRaw(
    `document.querySelector('#enabled').checked = ${enabled}; document.querySelector('#enabled').dispatchEvent(new Event('change', { bubbles: true })); 'changed'`, popupConsole);
  await setEnabled(false);
  await host.waitFor({ state: 'detached' });
  await setEnabled(true);
  await host.locator('.company-view').waitFor({ state: 'visible' });
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(host.locator('.practice-questions .question-title'), ['Two Sum', ...amazonPractice.slice(1)]);
  assert.equal(await host.locator('.difficulty-select').inputValue(), '');
  assert.equal(await host.locator('.topic-input').inputValue(), '');
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  report.checks.push('Popup enable/disable updates the open problem; re-enabling resets filtered practice state consistently.');

  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await host.locator('.topic-input').fill('Tree');
  await page.evaluate(() => document.getElementById('company-lens-root').remove());
  await host.locator('.company-view').waitFor({ state: 'visible' });
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(host.locator('.practice-questions .question-title'), ['Two Sum', ...amazonPractice.slice(1)]);
  assert.equal(await host.locator('.topic-input').inputValue(), '');
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  report.checks.push('Externally removed panels remount with consistent practice state and no pending filter result leakage.');

  await page.evaluate(() => history.pushState({}, '', '/problems/not-a-listed-problem/'));
  await host.locator('.empty').filter({ hasText: 'No company matches in this dataset.' }).waitFor();
  await page.evaluate(() => history.pushState({}, '', '/problemset/'));
  await host.waitFor({ state: 'detached' });
  await page.evaluate(() => history.pushState({}, '', '/problems/%2F/'));
  await page.waitForTimeout(1000);
  assert.equal(await host.count(), 0);
  await page.goto('https://leetcode.cn/contest/weekly-contest-100/problems/two-sum/');
  await host.getByRole('link', { name: 'Amazon, view source', exact: true }).waitFor();
  report.checks.push('Unknown problems, non-problem and malformed paths clear old tags; contest and leetcode.cn paths work.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  console.error(error.stack);
  if (rdp) report.debugTargets = rdp.pending().filter((packet) => /target/.test(packet.type || '')).slice(-10);
  if (page) {
    report.finalPanel = await page.locator('#company-lens-root .body').innerText().catch(() => null);
    await page.screenshot({ path: path.join(output, 'firefox-final.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  }
} finally {
  rdp?.socket.destroy();
  await context?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'firefox-results.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
