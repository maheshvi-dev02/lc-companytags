import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { firefoxExplorerDriver } from './browser-explorer.mjs';
import { problemFixture } from './browser-first-install.mjs';

// Focused regression for real Firefox action-popup sizing, not popup.html in a tab.
// The isolated-profile preference allows opening the native popup through RDP;
// production permissions and gesture requirements are unchanged.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/playwright');
await mkdir(output, { recursive: true });
const { firefox } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE,
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
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

let context, rdp, backgroundConsole, screenshotActor;
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


try {
  context = await firefox.launchPersistentContext(path.join(output, `firefox-dropdown-profile-${Date.now()}`), {
    headless: true, viewport: null, executablePath: await executable(),
    args: ['-start-debugger-server', String(port)],
    firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false,
      'devtools.chrome.enabled': true, 'extensions.openPopupWithoutUserGesture.enabled': true,
      'extensions.webextensions.uuids': JSON.stringify({ [id]: uuid }),
      'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 9,
      'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 9,
      'network.proxy.no_proxies_on': 'localhost,127.0.0.1',
    },
  });
  rdp = await rdpConnect(); await rdp.waitFor(() => true);
  const actors = await rdp.send({ to: 'root', type: 'getRoot' }); screenshotActor = actors.screenshotActor;
  await rdp.send({to:actors.addonsActor,type:'installTemporaryAddon',addonPath:path.join(root,'dist/firefox')});
  const addons = await rdp.send({to:'root',type:'listAddons'});
  report.addon = addons.addons.find(entry => entry.id === id);
  const watcher = await rdp.send({to:report.addon.actor,type:'getWatcher'});
  await rdp.send({to:watcher.actor,type:'watchTargets',targetType:'frame'});
  backgroundConsole = (await rdp.waitFor(p => p.type === 'target-available-form' && p.target?.url?.includes('_generated_background_page.html'))).target.consoleActor;
  report.browser = await evaluateBackground('return await browser.runtime.getBrowserInfo();');
  await context.route('https://leetcode.com/**', route=>route.fulfill({contentType:'text/html',body:problemFixture()}));
  const problemPage = await context.newPage();
  await problemPage.goto('https://leetcode.com/problems/two-sum/description/');
  await problemPage.locator('#company-lens-root .company-name').first().waitFor();
  await evaluateBackground(`await browser.action.openPopup(); return 'opened';`);
  const popupUrl=report.addon.manifestURL.replace('manifest.json','popup.html');
  const target=(await rdp.waitFor(p => p.type === 'target-available-form' && p.target?.url === popupUrl)).target;
  const ui = firefoxExplorerDriver(source=>evaluateConsoleRaw(source,target.consoleActor));

  async function until(expression) {
    for (let i=0;i<100;i++) { if(await ui.read(expression)) return; await new Promise(r=>setTimeout(r,50)); }
    throw new Error(`Popup did not become ready: ${expression}`);
  }
  const pause=()=>new Promise(r=>setTimeout(r,250));
  async function visibleMenu(id) {
    await pause();
    const state=await ui.read(`(()=>{const m=document.getElementById('${id}-menu'),r=m.getBoundingClientRect();return {hidden:m.hidden,expanded:document.getElementById('${id}-trigger').getAttribute('aria-expanded'),height:r.height,top:r.top,bottom:r.bottom,viewport:innerHeight};})()`);
    assert.equal(state.hidden,false,`${id} must survive Firefox's popup resize events`);
    assert.equal(state.expanded,'true'); assert.ok(state.height>20);
    assert.ok(state.top>=0 && state.bottom<=state.viewport+1,JSON.stringify(state));
  }
  async function choose(id,value) {
    await ui.click(`#${id}-trigger`); await visibleMenu(id);
    await ui.click(`#${id}-menu [data-value="${value}"]`);
    assert.equal(await ui.read(`document.getElementById('${id}').value`),value);
    assert.equal(await ui.read(`document.getElementById('${id}-menu').hidden`),true);
  }
  await until(`!document.querySelector('#window-select-trigger')?.disabled && document.querySelectorAll('#companies .company-name').length>0`);
  report.views=await evaluateBackground(`return browser.extension.getViews({type:'popup'}).map(v=>v.location.href);`);
  assert.deepEqual(report.views,[popupUrl],'Must exercise the native toolbar popup');
  await ui.mutate(`globalThis.__resizes=0;window.addEventListener('resize',()=>__resizes++)`);
  await choose('window-select','3m'); await choose('window-select','all');
  report.checks.push('Time-window dropdown stays visible in the actual Firefox toolbar popup and applies selection.');
  await ui.click('#company-sort-trigger'); await visibleMenu('company-sort');
  await ui.click('#company-sort-menu [data-value="name-asc"]');
  assert.equal(await ui.read(`document.querySelector('#company-sort-value').textContent`),'Company name A\u2013Z');
  report.checks.push('Company sort menu stays open and applies name sorting.');
  await ui.click('#companies button[data-company]');
  await until(`!document.querySelector('#difficulty-select-trigger').disabled`);
  await choose('difficulty-select','Medium');
  await choose('practice-status-select','all');
  await choose('practice-sort-select','name-asc');
  report.checks.push('Company practice difficulty, completion-status and sort menus open and select.');
  await ui.click('#mode-target');
  await until(`document.querySelector('#target-company').options.length>2 && !document.querySelector('#target-company-trigger').disabled`);
  await choose('target-company','Microsoft'); await choose('target-difficulty','Medium');
  await choose('target-topic','Array'); await choose('target-status','all');
  await ui.click('#target-plan'); await choose('target-count','12');
  await ui.click('#target-count-trigger'); await visibleMenu('target-count');
  await ui.press('#target-count-trigger','Escape');
  assert.equal(await ui.read(`document.querySelector('#target-count-menu').hidden`),true);
  await ui.click('#target-company-trigger'); await visibleMenu('target-company');
  await ui.mutate(`document.querySelector('#target-company-menu').scrollTop=1000`);
  await visibleMenu('target-company');
  await ui.mutate(`document.querySelector('#target-title').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  assert.equal(await ui.read(`document.querySelector('#target-company-menu').hidden`),true);
  report.checks.push('All five Target dropdowns work, long menus scroll, Escape and outside clicks still dismiss.');
  await ui.click('#target-count-trigger'); await visibleMenu('target-count');
  report.resizeEvents=await ui.read('__resizes'); assert.ok(report.resizeEvents>0);
  report.screenshot=await screenshotExtension(target,'firefox-dropdown-fixed.png');
  report.status='passed';
} catch(error) {report.status='failed';report.error=error.stack;process.exitCode=1;}
finally {rdp?.socket.destroy();await context?.close();await writeFile(path.join(output,'firefox-dropdown-report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:report.status,browser:report.browser,checks:report.checks,resizeEvents:report.resizeEvents,error:report.error},null,2));
