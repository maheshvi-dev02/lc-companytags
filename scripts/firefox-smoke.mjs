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
import { bundledExpectations, exerciseBundledPanel, exerciseBundledPopup, problemFixture, exerciseInlineLayout, exerciseInlineNavigation, exercisePopupFeatures, exercisePopupContext, archiveFixture, browserArchiveCheck, assertArchiveResult } from './browser-first-install.mjs';

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
const { seed, commit } = makeFixture(core);
const html = problemFixture();
seed.lctSettings.collapsed = true; // Existing collapsed-card preferences must not hide the new inline bar.
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

let context, rdp, page, backgroundConsole, screenshotActor, lastPopupTarget;
async function screenshotExtension(target, filename) {
  const prepared = await rdp.send({ to: target.screenshotContentActor, type: 'prepareCapture', args: { selector: 'body' } });
  const captured = await rdp.send({ to: screenshotActor, type: 'capture', args: {
    browsingContextID: target.browsingContextID, rect: prepared.value.rect,
    snapshotScale: 1, disableFlash: true,
  } });
  assert.ok(captured.value.data?.startsWith('data:image/png;base64,'), 'Firefox must produce an actual extension document screenshot.');
  await writeFile(path.join(output, filename), Buffer.from(captured.value.data.split(',')[1], 'base64'));
  return filename;
}
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

async function evaluateBackground(body, consoleActor = backgroundConsole) {
  // Raw RDP does not perform the DevTools frontend's top-level-await rewrite.
  // Keep promise results in this isolated test extension global and read them
  // through synchronous console expressions; production code is untouched.
  await evaluateConsoleRaw(`globalThis.__lctAuditResult = { done: false };
    (async () => { try {
      const value = await (async () => { ${body} })();
      globalThis.__lctAuditResult = { done: true, value };
    } catch (error) { globalThis.__lctAuditResult = { done: true, error: String(error) + '\\n' + (error.stack || '') }; } })(); 'started'`, consoleActor);
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = JSON.parse(await evaluateConsoleRaw('JSON.stringify(globalThis.__lctAuditResult)', consoleActor));
    if (result.done) {
      assert.ok(!result.error, result.error);
      return result.value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Asynchronous Firefox extension evaluation did not settle');
}

async function exerciseProblemMetadata(consoleActor, data, expectedRates) {
  const slugs = expectedRates ? Object.keys(expectedRates) : ['two-sum'];
  const queries = [...slugs, 'not-a-listed-problem'].flatMap(slug =>
    Object.keys(core.WINDOW_FILES).map(window => ({ slug, window })));
  const observed = JSON.parse(await evaluateBackground(`
    const results = [];
    for (const query of ${JSON.stringify(queries)}) {
      const result = await browser.runtime.sendMessage({ type: 'LCT_GET', ...query });
      results.push({ ...query, ok: result?.ok, error: result?.error, problem: result?.problem,
        companyScopedAcceptance: result?.companies?.some(company => Object.hasOwn(company, 'acceptanceRate')) });
    }
    return JSON.stringify(results);`, consoleActor));
  for (const result of observed) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.problem, core.problemForSlug(data, result.slug), 'Actual popup/background messaging must preserve current problem metadata.');
    assert.equal(result.companyScopedAcceptance, false, 'Acceptance belongs to the problem, not company interview reports.');
    if (expectedRates && Object.hasOwn(expectedRates, result.slug)) assert.equal(result.problem.acceptanceRate, expectedRates[result.slug]);
  }
  return { observed, check: expectedRates ?
    'Actual Firefox popup/background LCT_GET roundtrips preserve problem-global acceptance, including zero, 100%, decimal precision, missing and invalid values, across all five company windows.' :
    'Fresh Firefox popup/background messages expose bundled current-problem acceptance consistently across company windows and return null for an unknown problem.' };
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

async function exerciseInlineExplorerButton(problemPage, data, slug = 'two-sum') {
  const host = problemPage.locator('#company-lens-root');
  const button = host.getByRole('button', { name: 'Open Company Lens full page', exact: true });
  const explorerBase = report.addon.manifestURL.replace('manifest.json', 'explore.html');
  const stored = await evaluateBackground(`return await browser.storage.local.get(['lctSettings', 'lctExplorerSorts']);`);
  const window = Object.hasOwn(core.WINDOW_FILES, stored.lctSettings?.window) ? stored.lctSettings.window : 'all';
  const companySort = stored.lctExplorerSorts?.problemCompanies || 'frequency-desc';
  const expected = core.sortCompanies(core.companiesForSlug(data, slug, window), companySort);
  const expectedTitle = core.problemForSlug(data, slug)?.title || core.formatProblemTitle(slug);
  const geometry = await button.boundingBox();
  assert.ok(geometry.width <= 32 && geometry.height <= 32, 'The inline opener stays a compact icon button.');
  assert.equal(await button.getAttribute('title'), 'Open Company Lens full page');
  assert.equal(await button.locator('svg').count(), 1);
  const chip = await host.locator('.companies a').first().elementHandle();
  const names = await host.locator('.company-name').allTextContents();
  const originalWindowLabel = await host.locator('.window-label').innerText();
  const outcomes = [];
  for (const activation of ['mouse', 'keyboard']) {
    await problemPage.bringToFront();
    const originalTabs = await evaluateBackground(`return (await browser.tabs.query({})).map(tab => ({id:tab.id,url:tab.url,windowId:tab.windowId,active:tab.active}));`);
    const sourceTab = originalTabs.find(tab => tab.active && core.getProblemSlug(tab.url) === slug);
    assert.ok(sourceTab, 'The original LeetCode problem tab must be active before opening controls.');
    const popupViews = await evaluateBackground(`return browser.extension.getViews({type:'popup'}).map(view=>view.location.href);`);
    rdp.discard(packet => packet.type === 'target-available-form' && packet.target?.url?.startsWith(explorerBase));
    if (activation === 'keyboard') { await button.focus(); await button.press('Enter'); }
    else await button.click();
    let added = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const tabs = await evaluateBackground(`return (await browser.tabs.query({})).map(tab=>({id:tab.id,url:tab.url,windowId:tab.windowId,active:tab.active}));`);
      added = tabs.filter(tab => !originalTabs.some(previous => previous.id === tab.id));
      if (added.length && added[0].url?.startsWith(explorerBase)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(added.length, 1, 'Each inline activation must create exactly one full-page Explorer tab.');
    const explorerTab = added[0], url = new URL(explorerTab.url);
    assert.equal(url.protocol + '//' + url.host + url.pathname, explorerBase);
    assert.equal(url.searchParams.get('mode'), 'problems');
    assert.equal(url.searchParams.get('query'), '');
    assert.equal(url.searchParams.get('slug'), slug);
    assert.equal(explorerTab.active, true, 'The full-page Explorer must become the active tab.');
    assert.equal(explorerTab.windowId, sourceTab.windowId, 'The Explorer opens in the original problem tab browser window.');
    const target = (await rdp.waitFor(packet => packet.type === 'target-available-form' && packet.target?.url === explorerTab.url, 10000)).target;
    const ui = firefoxExplorerDriver(source => evaluateConsoleRaw(source, target.consoleActor));
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = await ui.read(`({title:document.querySelector('#detail-title')?.textContent,window:document.querySelector('#window-select')?.value,
        detail:!!document.querySelector('#detail-view')?.getClientRects().length,busy:document.querySelector('#detail-results')?.getAttribute('aria-busy'),
        companies:Array.from(document.querySelectorAll('#detail-results .company-row'),row=>({name:row.dataset.company,rank:row.querySelector('.company-rank')?.textContent,score:row.querySelector('.frequency-score')?.textContent}))})`);
      if (observed.detail && observed.busy === 'false' && observed.title === expectedTitle && JSON.stringify(observed.companies.map(company => company.name)) === JSON.stringify(expected.map(company => company.name))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(observed.detail, true); assert.equal(observed.busy, 'false'); assert.equal(observed.title, expectedTitle); assert.equal(observed.window, window);
    assert.deepEqual(observed.companies.map(company => company.name), expected.map(company => company.name));
    for (let index = 0; index < expected.length; index++) {
      const company = expected[index], row = observed.companies[index];
      assert.equal(row.rank, company.rank == null ? 'Rank unavailable' : `Company rank #${company.rank}`);
      assert.equal(row.score, Number.isFinite(company.frequency) && company.frequency >= 0 ? String(company.frequency) : '—');
    }
    assert.deepEqual(await evaluateBackground(`return browser.extension.getViews({type:'popup'}).map(view=>view.location.href);`), popupViews, 'The inline opener must not invoke the toolbar-popup route.');
    outcomes.push(`${activation}: active Explorer tab shows ${expectedTitle}, ${window}, and all ${expected.length} correct company names/ranks/scores`);
    const prepared = await rdp.send({ to: target.screenshotContentActor, type: 'prepareCapture', args: { selector: 'body' } });
    const rect = prepared.value.rect; rect.height = Math.min(rect.height, 1000);
    const captured = await rdp.send({ to: screenshotActor, type: 'capture', args: { browsingContextID: target.browsingContextID, rect, snapshotScale: 1, disableFlash: true } });
    assert.ok(captured.value.data?.startsWith('data:image/png;base64,'), 'Firefox produces a real full-page Explorer screenshot.');
    await writeFile(path.join(output, `firefox-inline-explorer-${slug}-${activation}.png`), Buffer.from(captured.value.data.split(',')[1], 'base64'));
    await ui.click('#detail-back');
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = await ui.read(`({search:!!document.querySelector('#search-view').getClientRects().length,detail:!!document.querySelector('#detail-view').getClientRects().length,mode:document.querySelector('#mode-problems').getAttribute('aria-selected')})`);
      if (observed.search && !observed.detail && observed.mode === 'true') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(observed, { search: true, detail: false, mode: 'true' }, 'Back returns to the global Problems search.');
    await ui.fill('#global-search', slug);
    const matching = core.searchProblems(data, { window, query: slug, sort: stored.lctExplorerSorts?.problems || 'relevance', limit: 50 }).problems.map(problem => problem.slug);
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = await ui.read(`({busy:document.querySelector('#results').getAttribute('aria-busy'),slugs:Array.from(document.querySelectorAll('#results [data-action="problem"]'),node=>node.dataset.slug)})`);
      if (observed.busy === 'false' && JSON.stringify(observed.slugs) === JSON.stringify(matching)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(observed.busy, 'false');
    assert.deepEqual(observed.slugs, matching, 'Global search remains usable after opening and leaving a direct problem detail.');
    await evaluateBackground(`await browser.tabs.remove(${explorerTab.id}); return 'closed';`);
    await problemPage.bringToFront();
    await problemPage.waitForFunction(() => {
      const button = document.querySelector('#company-lens-root')?.shadowRoot.querySelector('.open-extension');
      return button && !button.disabled && button.getAttribute('aria-busy') !== 'true';
    });
    assert.equal(await chip.evaluate(node => node.isConnected), true, 'Opening the full-page Explorer must retain the original company chip nodes.');
    assert.deepEqual(await host.locator('.company-name').allTextContents(), names);
    assert.equal(await host.locator('.window-label').innerText(), originalWindowLabel);
    assert.equal(await host.locator('.open-feedback[role=status]').textContent(), '');
    assert.deepEqual(await evaluateBackground(`return (await browser.tabs.query({})).map(tab=>tab.id).sort((a,b)=>a-b);`), originalTabs.map(tab => tab.id).sort((a,b)=>a-b), 'Closing the newly created Explorer leaves every original tab intact.');
  }
  await problemPage.screenshot({ path: path.join(output, `firefox-inline-opener-${slug}.png`), fullPage: true, animations: 'disabled' });
  return { slug, window, browserVersion: report.browser.version, geometry, outcomes,
    check: 'Trusted mouse and native Enter activation open an active full-page Explorer tab for the current problem and saved window, preserve the inline bar, and keep Back/global search working without invoking the toolbar popup.' };
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
    (route) => route.fulfill({ contentType: 'text/html', body: problemFixture({ anchor: !new URL(route.request().url()).searchParams.has('late') }) }));
  await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  rdp = await rdpConnect();
  await rdp.waitFor(() => true);
  const actors = await rdp.send({ to: 'root', type: 'getRoot' });
  screenshotActor = actors.screenshotActor;
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
  report.browser = JSON.parse(await evaluateBackground('return JSON.stringify(await browser.runtime.getBrowserInfo());'));
  const firstPage = await context.newPage();
  const navigationStartedAt = Date.now();
  await firstPage.goto('https://leetcode.com/problems/two-sum/description/');
  report.firstInstall = await exerciseBundledPanel(firstPage, expectedBundle, { startupStartedAt, navigationStartedAt, output, browserName: 'firefox' });
  report.firstInstall.addonInstallationToFirstPanelResultsMs = report.firstInstall.startupToFirstPanelResultsMs - (addonInstallationStartedAt - startupStartedAt);
  report.firstInstall.inline = await exerciseInlineLayout(firstPage, { core, data: expectedBundle.data, output, browserName: 'firefox-bundled' });
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
  report.firstInstall.problemMetadata = await exerciseProblemMetadata(freshPopupTarget.target.consoleActor, expectedBundle.data);
  report.checks.push(report.firstInstall.problemMetadata.check);
  report.firstInstall.bundledPopup = await exerciseBundledPopup(firefoxExplorerDriver(source => evaluateConsoleRaw(source, freshPopupTarget.target.consoleActor)), firstPage, expectedBundle, core);
  report.firstInstall.windowNote = report.firstInstall.bundledPopup.windowNote;
  report.checks.push(report.firstInstall.bundledPopup.check);
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
  report.acceptanceScreenshots = [await screenshotExtension(explorerTarget.target, 'firefox-acceptance-explorer.png')];
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
  report.inline = await exerciseInlineLayout(page, { core, data: seed.lctData, output, browserName: 'firefox' });
  report.checks.push(...report.inline.checks);
  report.inlineExplorer = await exerciseInlineExplorerButton(page, seed.lctData);
  report.checks.push(report.inlineExplorer.check);
  const popupUrl = report.addon.manifestURL.replace('manifest.json', 'popup.html');
  const openPopup = async () => {
    await page.bringToFront();
    await evaluateBackground(`await browser.tabs.create({ url: ${JSON.stringify(popupUrl)}, active: false }); return 'opened';`);
    const target = await rdp.waitFor(packet => packet.type === 'target-available-form' && packet.target?.url === popupUrl);
    lastPopupTarget = target.target;
    report.problemMetadata = await exerciseProblemMetadata(target.target.consoleActor, seed.lctData, {
      'two-sum': 50, 'add-two-numbers': 45.6, 'merge-two-sorted-lists': 0,
      'binary-tree-level-order-traversal': null, 'valid-parentheses': 100,
      'longest-substring-without-repeating-characters': null, 'maximum-depth-of-binary-tree': 74.123,
    });
    return firefoxExplorerDriver(source => evaluateConsoleRaw(source, target.target.consoleActor));
  };
  const popupUI = await openPopup();
  report.checks.push(report.problemMetadata.check);
  const toolbar = await exercisePopupFeatures(popupUI, page, { data: seed.lctData, core,
    getStatus: async () => JSON.parse(await evaluateBackground('return JSON.stringify((await browser.storage.local.get("lctStatus")).lctStatus);')),
    setStorage: data => evaluateBackground(`await browser.storage.local.set(${JSON.stringify(data)}); return 'changed';`),
    removeStorage: key => evaluateBackground(`await browser.storage.local.remove(${JSON.stringify(key)}); return 'removed';`),
  });
  report.checks.push(...toolbar.checks);
  report.acceptanceScreenshots.push(await screenshotExtension(lastPopupTarget, 'firefox-acceptance-current.png'));
  await popupUI.click('#companies button[data-company="Amazon"]');
  const practiceTitles = core.practiceQuestions(seed.lctData, { company: 'Amazon', window: 'all' }).questions.map(question => question.title);
  let screenshotTitles;
  for (let attempt = 0; attempt < 100; attempt++) {
    screenshotTitles = await popupUI.read("Array.from(document.querySelectorAll('#practice-questions .question-title'), node => node.textContent)");
    if (JSON.stringify(screenshotTitles) === JSON.stringify(practiceTitles)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(screenshotTitles, practiceTitles);
  report.acceptanceScreenshots.push(await screenshotExtension(lastPopupTarget, 'firefox-acceptance-practice.png'));
  await popupUI.click('#back-companies');
  const navigation = await exerciseInlineNavigation(page, { data: seed.lctData, core, context,
    onSPA: async () => {
      report.inlineExplorerAfterSPA = await exerciseInlineExplorerButton(page, seed.lctData, 'add-two-numbers');
      return exercisePopupContext(await openPopup(), { data: seed.lctData, core, slug: 'add-two-numbers' });
    },
  });
  report.checks.push(...navigation.checks);
  report.popupVerification = 'Actual packaged popup DOM, inspected and operated via Mozilla RDP console; Playwright does not expose this extension-process tab.';
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  console.error(error.stack);
  if (rdp) report.debugTargets = rdp.pending().filter((packet) => /target/.test(packet.type || '')).slice(-10);
  if (page) {
    report.finalPanel = await page.locator('#company-lens-root').innerText().catch(() => null);
    await page.screenshot({ path: path.join(output, 'firefox-final.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  }
} finally {
  rdp?.socket.destroy();
  await context?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'firefox-results.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
