// Offline demo: existing Chrome, shared React, no HTTP server or DSH profile changes.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { summary, totals } from './client-helpers.js';
import { captureSdkTurnOwner, createTurnOwnerFixture, readSdkToolbar, createToolbarComponents, toolbarFixtureCss } from './client-sdk.js';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const domRoot = dirname(require.resolve('react-dom/package.json'));
const domRequire = createRequire(resolve(domRoot, 'package.json'));
const modules = [
  ['react', resolve(dirname(require.resolve('react/package.json')), 'cjs/react.development.js')],
  ['scheduler', resolve(dirname(domRequire.resolve('scheduler/package.json')), 'cjs/scheduler.development.js')],
  ['react-dom', resolve(domRoot, 'cjs/react-dom.development.js')],
  ['react-dom/client', resolve(domRoot, 'cjs/react-dom-client.development.js')],
];
const sources = await Promise.all(modules.map(async ([id, path]) => [id, await readFile(path, 'utf8')]));
const bundle = await readFile(resolve(root, 'dist/client.js'), 'utf8');
const sdkOwner = await captureSdkTurnOwner(7, 'turn', 70);
const owner = sdkOwner ?? createTurnOwnerFixture(7, 70);
const sdkToolbar = await readSdkToolbar();
const candidates = [process.env.DSH_TEST_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
const executablePath = candidates.find(path => existsSync(path));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const evidence = [];
try {
  for (const [name, width, height, colorScheme] of [['light', 960, 900, 'light'], ['dark', 960, 900, 'dark'], ['mobile', 375, 812, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      :root{color-scheme:light dark;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#242934;background:#f9fafb;--dsw-alias-label-primary:#242934;--dsw-alias-label-secondary:#555f70;--dsw-alias-label-tertiary:#6d7788;--dsw-alias-bg-layer-1:#fff;--dsw-alias-border-l2:#e4e7ec;--dsw-alias-state-business-primary:#4264cf;--dsw-alias-interactive-bg-hover:#edf0f5}
      *{box-sizing:border-box}body{margin:0;padding:24px 20px}main{max-width:680px;margin:auto;height:calc(100vh - 48px);display:flex;flex-direction:column}h1{font-size:18px;font-weight:600;margin:0 0 7px}.fixture-note{color:#7c8698;font-size:11px;margin:0 0 24px}.transcript{flex:1;min-height:0}.reply{font-size:14px;line-height:1.8;margin-bottom:16px;max-width:600px}[data-turn-tail]{display:flex;flex-direction:column;gap:16px}.clip{overflow:hidden;flex:none}.composer{border:1px solid var(--dsw-alias-border-l2);border-radius:16px;min-height:90px;padding:18px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);font-size:13px}.dock{display:flex;justify-content:center;align-items:center;gap:12px;max-width:100%;padding:5px 0 3px}.other-pill{min-width:0;flex:0 1 auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      @media(prefers-color-scheme:dark){:root{background:#1b1d22;color:#e6e9ee;--dsw-alias-label-primary:#e6e9ee;--dsw-alias-label-secondary:#b9c0cd;--dsw-alias-label-tertiary:#939eb0;--dsw-alias-bg-layer-1:#24272e;--dsw-alias-border-l2:#393e49;--dsw-alias-state-business-primary:#98aaff;--dsw-alias-interactive-bg-hover:#2d323c}}@media(max-width:480px){body{padding:18px 12px}main{height:calc(100vh - 36px)}.dock{gap:8px}.other-pill{font-size:10px}.fixture-note{margin-bottom:18px}}
      </style><main><h1>逐轮费用工具栏</h1><p class="fixture-note">DEMO · 离线组件验证 · 示例数据</p><div class="transcript"><div class="reply">本轮费用已并入用量工具栏。复制、用量与时间保持原有行为；点击费用可查看浮窗明细。</div><div id="tail"></div></div><div class="clip"><div class="composer">输入消息…</div><div class="dock" data-composer-dock><span class="other-pill">3 轮 2 次请求</span><span class="other-pill">57.9M tok</span><div id="dock" style="min-width:0;max-width:100%;flex:0 1 auto"></div><span class="other-pill" style="flex:none">◯ 53%</span></div></div><div id="styles"></div></main></html>`);
    await page.addStyleTag({ content: sdkToolbar?.css ?? toolbarFixtureCss });
    await page.evaluate(items => {
      window.process = { env: { NODE_ENV: 'development' } };
      const definitions = new Map(items), cache = new Map();
      window.sharedRequire = id => {
        if (cache.has(id)) return cache.get(id).exports;
        const module = { exports: {} }; cache.set(id, module);
        new Function('module', 'exports', 'require', definitions.get(id))(module, module.exports, window.sharedRequire);
        return module.exports;
      };
      window.__ModuleLoader__ = { load: descriptor => { window.costPlugin = descriptor.factory(window.sharedRequire); } };
    }, sources);
    await page.addScriptTag({ content: bundle });
    const data = summary('preview', { totals: totals({ usd: 110.4841, cny: 735.6028, nativeUsd: 110.4841 }),
      turns: [{ turn: 7, totals: totals({ usd: 0.02, cny: 0.144 }), models: ['example-model'], warnings: [] }] });
    data.records[0].turn = 7;
    await page.evaluate(({ value, turnOwner, factory, sdk }) => {
      const React = window.sharedRequire('react'), ReactDOM = window.sharedRequire('react-dom');
      const { createRoot } = window.sharedRequire('react-dom/client');
      const makeToolbar = new Function(`return (${factory})`)();
      window.nativeActions = { copies: [], usage: [], branches: 0 };
      const native = makeToolbar(React, ReactDOM, { copy: text => window.nativeActions.copies.push(text), usage: value => window.nativeActions.usage.push(value) }, sdk);
      window.nativeClasses = native;
      const slots = new Map();
      window.previewCalls = 0;
      window.costPlugin.apply({
        connection: { generation: { getSnapshot: () => 1, subscribe: () => () => {} }, rpc: { async call() { window.previewCalls++; return { ok: true, value }; } } },
        effect: fn => fn(), slots: { inject(_name, fn) { fn(); }, register(descriptor, component) { slots.set(descriptor.name, component); } },
      });
      const props = { sessionId: 'preview', ...turnOwner, useSession: select => select({ running: false }) };
      for (const [id, slot] of [['dock', 'conversation.composer.dock'], ['styles', 'shell.overlay']]) createRoot(document.getElementById(id)).render(React.createElement(slots.get(slot), props));
      const tailRoot = createRoot(document.getElementById('tail'));
      let config = { detailed: true, visible: true, enabled: true, version: 0 };
      window.renderToolbar = patch => {
        config = { ...config, ...patch };
        tailRoot.render(React.createElement('div', { 'data-turn-tail': 7, 'data-actions-reveal': 'always' },
          React.createElement('div', { 'data-slot': 'conversation.chat.turnTail' }, config.enabled && React.createElement(slots.get('conversation.chat.turnTail'), props)),
          config.visible && React.createElement(native.MessageIconActions, { key: config.version, text: 'native clipboard text', time: 123, clock: 'end', t: native.t,
            onBranch: () => { window.nativeActions.branches++; }, usageAction: config.detailed ? React.createElement(native.TurnUsagePanel, { usage: { totalTokens: 14600000, outputTokens: 100, uncachedInputTokens: 200 }, t: native.t }) : null })));
      };
      window.renderToolbar({});
    }, { value: data, turnOwner: { turn: owner.turn, seq: owner.seq }, factory: createToolbarComponents.toString(), sdk: sdkToolbar });
    await page.waitForFunction(() => document.querySelector('[data-dsh-token-cost-portal] .dsh-tc-trigger')?.textContent.includes('¥0.144'));
    assert.equal(await page.evaluate(() => window.previewCalls), 1);
    const geometry = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-clock=end]'), native = window.nativeClasses;
      const usage = toolbar.querySelector(`.${native.usageClasses.trigger}`), outlet = toolbar.querySelector('[data-dsh-token-cost-portal]');
      const cost = outlet.querySelector('.dsh-tc-trigger'), clock = toolbar.querySelector(`.${native.messageClasses.timeEnd}`);
      return { usage: usage.getBoundingClientRect().toJSON(), cost: cost.getBoundingClientRect().toJSON(), clock: clock.getBoundingClientRect().toJSON(),
        domOrder: usage.parentElement.nextElementSibling === outlet && outlet.nextElementSibling === clock,
        scrollWidth: document.documentElement.scrollWidth, nativeUsageLabel: usage.textContent };
    });
    assert.equal(geometry.domOrder, true);
    if (width > 480) {
      assert.ok(geometry.cost.left >= geometry.usage.right - 0.5);
      assert.ok(Math.abs((geometry.cost.top + geometry.cost.height / 2) - (geometry.usage.top + geometry.usage.height / 2)) < 1);
      assert.ok(geometry.clock.left >= geometry.cost.right - 0.5);
    }
    assert.ok(geometry.scrollWidth <= width);
    assert.match(geometry.nativeUsageLabel, /14\.6M/);
    const copy = page.locator('[data-clock=end] button[aria-label="复制"]');
    await copy.click();
    await page.waitForFunction(() => window.nativeActions.copies.length === 1);
    await page.locator('[data-clock=end] button[aria-label="分支"]').click();
    const usageButton = page.locator('[data-clock=end] > span > span > button[aria-haspopup=dialog]').filter({ hasNot: page.locator('.dsh-tc-chevron') });
    await usageButton.click();
    await page.getByRole('dialog', { name: '原生 Token 用量', exact: true }).waitFor({ state: 'visible' });
    await usageButton.click();
    assert.deepEqual(await page.evaluate(() => window.nativeActions), { copies: ['native clipboard text'], usage: [true, false], branches: 1 });
    const turnTrigger = page.locator('[data-dsh-token-cost-portal] .dsh-tc-trigger');
    await turnTrigger.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.dsh-tc-turn .dsh-tc-popover').matches(':popover-open'));
    assert.match(await page.locator('.dsh-tc-turn .dsh-tc-heading').innerText(), /第 7 轮费用/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-dsh-token-cost-portal] .dsh-tc-trigger'));
    if (name === 'light') {
      await page.evaluate(() => { window.oldOutlet = document.querySelector('[data-dsh-token-cost-portal]'); window.renderToolbar({ detailed: false }); });
      await page.waitForFunction(() => { const outlet = document.querySelector('[data-dsh-token-cost-portal]'); return outlet && outlet.previousElementSibling === null; });
      await page.evaluate(() => window.renderToolbar({ detailed: true, version: 1 }));
      await page.waitForFunction(() => !window.oldOutlet.isConnected && document.querySelectorAll('[data-dsh-token-cost-portal]').length === 1 && document.querySelector('[data-dsh-token-cost-portal]').previousElementSibling?.querySelector('button[aria-haspopup=dialog]'));
      await page.evaluate(() => { window.nativeCopy = document.querySelector('[data-clock=end] button[aria-label="复制"]'); window.renderToolbar({ enabled: false }); });
      await page.waitForFunction(() => document.querySelectorAll('[data-dsh-token-cost-portal],[data-dsh-token-cost-anchor]').length === 0);
      assert.equal(await page.evaluate(() => window.nativeCopy === document.querySelector('[data-clock=end] button[aria-label="复制"]')), true);
      await page.evaluate(() => window.renderToolbar({ enabled: true, visible: false }));
      await page.waitForFunction(() => document.querySelector('[data-slot="conversation.chat.turnTail"] .dsh-tc-turn') && !document.querySelector('[data-dsh-token-cost-portal]'));
      await page.evaluate(() => window.renderToolbar({ visible: true }));
      await page.waitForFunction(() => document.querySelector('[data-dsh-token-cost-portal] .dsh-tc-trigger'));
    }
    await page.screenshot({ path: resolve(root, `artifacts/client-toolbar-${name}.png`), fullPage: true });
    const dockTrigger = page.locator('.dsh-tc-dock .dsh-tc-trigger'), dockPopup = page.locator('.dsh-tc-dock .dsh-tc-popover');
    const before = await page.locator('.composer').boundingBox();
    await dockTrigger.click();
    await page.waitForFunction(() => document.querySelector('.dsh-tc-dock .dsh-tc-popover').matches(':popover-open'));
    const popup = await dockPopup.boundingBox(), trigger = await dockTrigger.boundingBox();
    assert.ok(popup.y + popup.height <= trigger.y);
    assert.deepEqual(await page.locator('.composer').boundingBox(), before);
    await page.mouse.click(3, 3);
    await page.waitForFunction(() => !document.querySelector('.dsh-tc-dock .dsh-tc-popover').matches(':popover-open'));
    const dockSizes = [];
    // Opening/resizing the sidebar changes the composer, not the viewport.
    for (const composerWidth of width > 480 ? [680, 480, 360, 280, 680] : [351, 280, 351]) {
      await page.locator('main').evaluate((element, size) => { element.style.maxWidth = `${size}px`; }, composerWidth);
      const layout = await dockTrigger.evaluate(button => {
        const label = button.querySelector('.dsh-tc-label');
        const dock = button.closest('[data-composer-dock]');
        const range = document.createRange();
        range.selectNodeContents(label);
        return { viewportWidth: window.innerWidth, composerWidth: dock.clientWidth, dockHeight: dock.getBoundingClientRect().height,
          triggerHeight: button.getBoundingClientRect().height, labelLines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
          truncated: label.scrollWidth > label.clientWidth, overflow: dock.scrollWidth > dock.clientWidth,
          title: button.title, accessibleName: button.getAttribute('aria-label') };
      });
      assert.equal(layout.viewportWidth, width);
      assert.equal(layout.labelLines, 1, `Session cost wrapped at composer width ${composerWidth}`);
      assert.ok(layout.triggerHeight <= 29, `Session cost grew to ${layout.triggerHeight}px`);
      assert.ok(layout.dockHeight <= 37, `Composer dock grew to ${layout.dockHeight}px`);
      assert.equal(layout.overflow, false);
      if (composerWidth <= 360) assert.equal(layout.truncated, true);
      if (composerWidth === 680) assert.equal(layout.truncated, false);
      if (composerWidth === 280) {
        const narrowComposer = await page.locator('.composer').boundingBox();
        await dockTrigger.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.dsh-tc-dock .dsh-tc-popover').matches(':popover-open'));
        assert.match(await dockPopup.locator('.dsh-tc-heading').innerText(), /¥735\.6028 · \$110\.4841/);
        assert.deepEqual(await page.locator('.composer').boundingBox(), narrowComposer);
        const narrowPopup = await dockPopup.boundingBox(), narrowTrigger = await dockTrigger.boundingBox();
        assert.ok(narrowPopup.y + narrowPopup.height <= narrowTrigger.y);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement === document.querySelector('.dsh-tc-dock .dsh-tc-trigger'));
      }
      if (composerWidth === 360) await page.screenshot({ path: resolve(root, `artifacts/dock-sidebar-narrow-${name}.png`), fullPage: true });
      dockSizes.push(layout);
    }
    assert.match(dockSizes.at(-1).title, /会话累计 ¥735\.6028 · \$110\.4841/);
    assert.match(dockSizes.at(-1).accessibleName, /会话累计 ¥735\.6028 · \$110\.4841/);
    assert.deepEqual(errors, []);
    evidence.push({ mode: name, viewport: `${width}×${height}`, source: sdkToolbar?.kind ?? 'public toolbar contract fixture', sdkIntegrationSkipped: !sdkToolbar,
      nativeUsageRight: geometry.usage.right, costLeft: geometry.cost.left, costRight: geometry.cost.right, clockLeft: geometry.clock.left,
      usageCenterY: geometry.usage.top + geometry.usage.height / 2, costCenterY: geometry.cost.top + geometry.cost.height / 2,
      order: 'copy → branch → usage → turn cost → time', nativeActionsWorking: true, horizontalOverflow: false,
      lifecycle: name === 'light' ? 'basic/detailed, toolbar replacement, fallback, owned cleanup, native node identity preserved' : 'covered by wide browser and DOM regression',
      popoverPreserved: true, dockSizes, consoleErrors: errors.length });
    await page.close();
  }
  const report = { demo: true, browser: executablePath || 'Playwright Chromium', ownerSource: sdkOwner ? 'actual SDK TurnTailNodeView' : 'public owner contract fixture', evidence };
  await writeFile(resolve(root, 'artifacts/client-toolbar-evidence.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
