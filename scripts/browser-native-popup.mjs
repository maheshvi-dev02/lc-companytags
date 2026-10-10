import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { verifyBadges } from './browser-logos.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Native action popups are extension targets, not ordinary Playwright tabs.
// CDP only observes/reads the popup; every open starts with a real page click or
// keyboard activation of the shipped content-script button.
async function attachTarget(browserSession, targetId) {
  const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId, flatten: false });
  let nextId = 0;
  const pending = new Map();
  const onMessage = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  browserSession.on('Target.receivedMessageFromTarget', onMessage);
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native popup CDP timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
      .catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
  return {
    command,
    async read(expression) {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    },
    async detach() {
      browserSession.off('Target.receivedMessageFromTarget', onMessage);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Native popup detached')); }
      pending.clear();
      try { await browserSession.send('Target.detachFromTarget', { sessionId }); } catch { /* Popup may have closed itself. */ }
    },
  };
}

async function waitTarget(browserSession, popupUrl, previous) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = await browserSession.send('Target.getTargets');
    const target = targetInfos.find(item => item.url === popupUrl && !previous.has(item.targetId));
    if (target) return target;
    await pause(50);
  }
  throw new Error('The real inline activation did not create a native extension popup target.');
}

async function waitRead(client, expression, expected) {
  let observed;
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = await client.read(expression);
    if (JSON.stringify(observed) === JSON.stringify(expected)) return observed;
    await pause(50);
  }
  assert.deepEqual(observed, expected);
}

export async function exerciseNativePopup(context, page, { core, data, extensionUrl, output, browserName = 'chromium' }) {
  const host = page.locator('#company-lens-root');
  const button = host.getByRole('button', { name: 'Open extension', exact: true });
  const expected = core.companiesForSlug(data, 'two-sum', 'all').map(company => company.name);
  await button.waitFor({ state: 'visible' });
  assert.equal(await button.getAttribute('type'), 'button');
  assert.equal(await button.getAttribute('title'), 'Open extension');
  assert.equal(await button.locator('img').count(), 0, 'Open-window action must not masquerade as a company logo.');
  const svg = button.locator('svg');
  assert.equal(await svg.getAttribute('aria-hidden'), 'true');
  assert.equal(await svg.getAttribute('fill'), 'none');
  assert.equal(await svg.getAttribute('stroke'), 'currentColor');

  const layouts = [];
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['dark', 375]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => {
      document.documentElement.classList.remove('dark', 'light');
      document.documentElement.classList.add(theme);
    }, theme);
    await page.waitForFunction(theme => document.querySelector('#company-lens-root')?.hasAttribute('data-dark') === (theme === 'dark'), theme);
    const layout = await button.evaluate(node => {
      const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const root = node.getRootNode();
      return { button: box(node), svg: box(node.querySelector('svg')), caption: box(root.querySelector('.caption')),
        bar: box(root.querySelector('.company-bar')), host: box(root.host), viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth, color: getComputedStyle(node).color,
        companyCount: root.querySelectorAll('.company-chip').length };
    });
    assert.equal(layout.svg.width, 24); assert.equal(layout.svg.height, 24);
    assert.equal(layout.button.width, 28); assert.equal(layout.button.height, 28);
    assert.ok(layout.button.right <= layout.caption.right + 1 && layout.button.bottom <= layout.caption.bottom + 1);
    assert.ok(layout.documentWidth <= width && layout.host.right <= width);
    assert.equal(layout.companyCount, expected.length);
    layouts.push({ theme, width, ...layout });
    await host.screenshot({ path: path.join(output, `${browserName}-open-extension-${theme}-${width}.png`), animations: 'disabled' });
  }
  assert.notEqual(layouts[0].color, layouts[1].color, 'Outline icon must follow the page theme.');
  await page.setViewportSize({ width: 1440, height: 1000 });

  const browserSession = await context.browser().newBrowserCDPSession();
  const activations = [];
  try {
    await browserSession.send('Target.setDiscoverTargets', { discover: true });
    for (const activation of ['pointer', 'Enter', 'Space']) {
      await page.bringToFront();
      const before = new Set((await browserSession.send('Target.getTargets')).targetInfos.map(item => item.targetId));
      if (activation === 'pointer') await button.click();
      else {
        await page.locator('#problem-tags button').last().focus();
        await page.keyboard.press('Tab');
        assert.equal(await button.evaluate(node => node.getRootNode().activeElement === node), true, 'Tab must reach the caption action.');
        assert.equal(await button.evaluate(node => node.matches(':focus-visible')), true);
        assert.equal(await button.evaluate(node => getComputedStyle(node).outlineWidth), '2px');
        await button.press(activation);
      }
      let target;
      try { target = await waitTarget(browserSession, `${extensionUrl}/popup.html`, before); }
      catch (error) {
        const feedback = await host.locator('.open-feedback').textContent();
        throw new Error(`${error.message} Inline feedback: ${feedback}`);
      }
      const client = await attachTarget(browserSession, target.targetId);
      try {
        await waitRead(client, 'document.querySelector("#problem-title")?.textContent', 'Two Sum');
        await waitRead(client, 'Array.from(document.querySelectorAll("#companies .company-name"), node => node.textContent)', expected.slice(0, 5));
        const native = await client.read('({ nativePopup: chrome.extension.getViews({ type: "popup" }).includes(window), href: location.href, title: document.querySelector("#problem-title").textContent })');
        assert.equal(native.nativePopup, true, 'The action must open an actual toolbar popup, not a popup.html tab.');
        const logos = await verifyBadges({ read: expression => client.read(expression) }, {
          selector: '#companies .company-identity > .company-logo', names: expected.slice(0, 5), known: true,
          label: '{name}, view source',
        });
        if (activation === 'pointer') {
          const screenshot = await client.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          await writeFile(path.join(output, `${browserName}-native-toolbar-popup.png`), Buffer.from(screenshot.data, 'base64'));
        }
        activations.push({ activation, targetType: target.type, ...native, companyNames: expected.slice(0, 5), logos });
        await browserSession.send('Target.closeTarget', { targetId: target.targetId });
      } finally { await client.detach(); }
      await pause(100);
      assert.deepEqual(await host.locator('.company-name').allTextContents(), expected, 'Opening the toolbar must preserve the inline list.');
      assert.equal(await host.locator('.open-feedback').textContent(), '');
    }
  } finally { await browserSession.detach(); }
  return { layouts, activations, checks: [
    'A 24px outline open-window icon remains accessible in the caption at light/dark desktop and 375px widths without altering company chips.',
    'Real pointer, Enter and Space activations each open a native Chrome toolbar popup showing the current problem and local company logos; the inline list remains intact.',
  ] };
}
