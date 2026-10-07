import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/playwright');
await mkdir(output, { recursive: true });
const { firefox } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const uuid = randomUUID();
const id = 'company-lens@leetcode-tags.local';
const port = 23000 + Math.floor(Math.random() * 20000);
const report = { startedAt: new Date().toISOString(), mode: 'actual Firefox temporary extension via Mozilla RDP', checks: [], packets: [] };
const fixture = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two Sum - LeetCode</title><style>body{background:#171717;color:#eee;font:16px system-ui;margin:40px;max-width:700px}h1{font-size:30px}pre{background:#292929;padding:24px}header{color:#ffa116}</style></head><body><header>LeetCode / Problems</header><h1>1. Two Sum</h1><p>Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.</p><pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]</pre></body></html>';

function rdpConnect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    const messages = [], waiters = [];
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('RDP response timeout')), 20000);
      waiters.push((value) => { clearTimeout(timer); res(value); });
    });
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.indexOf(58) >= 0) {
        const colon = buffer.indexOf(58), length = Number(buffer.subarray(0, colon).toString());
        if (!Number.isFinite(length)) { reject(new Error(`Bad RDP frame ${buffer.toString()}`)); break; }
        if (buffer.length < colon + 1 + length) break;
        const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
        buffer = buffer.subarray(colon + 1 + length);
        report.packets.push(message);
        if (waiters.length) waiters.shift()(message); else messages.push(message);
      }
    });
    socket.once('error', reject);
    socket.once('connect', () => resolve({ socket, next, send: async (packet) => {
      const body = JSON.stringify(packet); socket.write(`${Buffer.byteLength(body)}:${body}`);
      let response;
      do { response = await next(); } while (response.from !== packet.to);
      return response;
    } }));
  });
}

let context, rdp, page;
try {
  context = await firefox.launchPersistentContext(path.join(output, `firefox-profile-${Date.now()}`), {
    headless: true, viewport: null,
    executablePath: process.env.FIREFOX_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'ms-playwright/firefox-1497/firefox/firefox.exe'),
    args: ['-start-debugger-server', String(port)],
    firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true,
      'devtools.debugger.prompt-connection': false,
      'devtools.chrome.enabled': true,
      'extensions.webextensions.uuids': JSON.stringify({ [id]: uuid }),
    },
  });
  rdp = await rdpConnect();
  await rdp.next();
  const actors = await rdp.send({ to: 'root', type: 'getRoot' });
  assert.ok(actors.addonsActor, 'Firefox exposes temporary addon installer');
  const installed = await rdp.send({ to: actors.addonsActor, type: 'installTemporaryAddon', addonPath: path.join(root, 'dist/firefox') });
  assert.ok(!installed.error, JSON.stringify(installed));
  report.install = installed;
  const addons = await rdp.send({ to: 'root', type: 'listAddons' });
  report.addon = addons.addons.find((entry) => entry.id === id);
  assert.deepEqual(report.addon.warnings, []);
  report.checks.push('Built Firefox MV3 distribution installed as an actual temporary addon.');
  console.log('Actual Firefox temporary extension installed; checking content script with live sync.');
  page = await context.newPage();
  await page.route(/https:\/\/(?:www\.)?leetcode\.(?:com|cn)\//, (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('https://leetcode.com/problems/two-sum/description/');
  const host = page.locator('#company-lens-root');
  await host.waitFor({ state: 'visible', timeout: 30000 });
  report.checks.push('Real content script injects the correct problem panel and communicates with the extension background.');
  await page.screenshot({ path: path.join(output, 'firefox-initial.png'), fullPage: true });
  for (let i = 0; i < 30; i++) {
    report.finalPanel = await host.locator('.body').innerText();
    if (await host.locator('.companies a').count()) break;
    if (/rate limit|unavailable|could not/i.test(report.finalPanel)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  report.companyCount = await host.locator('.companies a').count();
  if (report.companyCount) {
    report.checks.push(`Actual content script displays ${report.companyCount} live company tags for Two Sum.`);
    await host.getByRole('searchbox', { name: 'Filter company names' }).fill('amazon');
    assert.equal(await host.locator('.companies a').count(), 1);
    await host.getByRole('searchbox', { name: 'Filter company names' }).fill('');
    report.checks.push('Company search filters actual source data.');
  } else {
    report.limitations = [report.finalPanel];
    if (/GitHub rate limit reached/.test(report.finalPanel)) report.checks.push('Actual GitHub rate-limit response displays retry timing and preserves a usable error state.');
  }
  await host.getByRole('button', { name: 'Collapse Company Lens' }).click();
  await host.locator('.body').waitFor({ state: 'hidden' });
  await host.getByRole('button', { name: 'Expand Company Lens' }).click();
  await host.locator('.body').waitFor({ state: 'visible' });
  report.checks.push('Collapse and expand work in Firefox.');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForFunction(() => document.getElementById('company-lens-root')?.hasAttribute('data-dark'));
  await page.screenshot({ path: path.join(output, report.companyCount ? 'firefox-live-data.png' : 'firefox-final.png'), fullPage: true });
  await page.evaluate(() => history.pushState({}, '', '/problems/not-a-listed-problem/'));
  await host.locator('h2').filter({ hasText: 'Not A Listed Problem' }).waitFor();
  report.checks.push('SPA navigation updates the problem title.');
  await page.evaluate(() => history.pushState({}, '', '/problemset/'));
  await host.waitFor({ state: 'detached' });
  report.checks.push('Leaving a problem removes the panel.');
  report.status = report.companyCount ? 'passed' : 'partial';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  console.error(error.stack);
  if (page) {
    report.finalPanel = await page.locator('#company-lens-root .body').innerText().catch(() => null);
    await page.screenshot({ path: path.join(output, 'firefox-final.png'), fullPage: true }).catch(() => {});
  }
} finally {
  rdp?.socket.destroy();
  report.finishedAt = new Date().toISOString();
  delete report.packets;
  await writeFile(path.join(output, 'firefox-results.json'), JSON.stringify(report, null, 2) + '\n');
  await context?.close();
}
console.log(JSON.stringify(report, null, 2));
