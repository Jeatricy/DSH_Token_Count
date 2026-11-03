import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createClientPlugin } from '../src/client.js';
import { captureSdkTurnOwner, createTurnOwnerFixture, readSdkToolbar, createToolbarComponents } from './client-sdk.js';
import { connection, observable, summary, totals } from './client-helpers.js';

const css = await readFile(new URL('../src/client.css', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mount(t, { turns = [1], owners, value = summary(), handler, running = false, toolbar = false, sdk = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  // jsdom has no top layer. Only the open/close events are shimmed here; the
  // separate Chrome test verifies real positioning, light dismiss and clipping.
  const opened = new WeakSet();
  const matches = dom.window.HTMLElement.prototype.matches;
  dom.window.HTMLElement.prototype.matches = function(selector) {
    return selector === ':popover-open' ? opened.has(this) : matches.call(this, selector);
  };
  const togglePopover = (element, open) => {
    if (open) opened.add(element); else opened.delete(element);
    const event = new dom.window.Event('toggle');
    Object.defineProperty(event, 'newState', { value: open ? 'open' : 'closed' });
    element.dispatchEvent(event);
  };
  dom.window.HTMLElement.prototype.showPopover = function() { togglePopover(this, true); };
  dom.window.HTMLElement.prototype.hidePopover = function() { togglePopover(this, false); };
  const saved = new Map();
  for (const [name, next] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
  }
  const registrations = new Map();
  const disposers = [];
  const rpc = connection(handler ?? ((_channel, _method, payload) => ({ ok: true, value: { ...value, sessionId: payload.sessionId } })));
  const session = observable({ running });
  const useSession = selector => selector(React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot));
  createClientPlugin(React, css, ReactDOM).apply({
    connection: rpc,
    effect: callback => { disposers.push(callback()); },
    slots: { inject(_name, callback) { callback(); }, register(descriptor, component) { registrations.set(descriptor.name, component); } },
  });
  const root = createRoot(dom.window.document.getElementById('root'));
  const actions = { copies: [], usage: [], branches: 0 };
  const native = createToolbarComponents(React, ReactDOM, { copy: text => actions.copies.push(text), usage: open => actions.usage.push(open) }, sdk);
  let toolbarState = { visible: true, detailed: true, version: 0, enabled: true };
  const render = async (sessionId = 'session-a', patch) => {
    if (patch) toolbarState = { ...toolbarState, ...patch };
    const Tail = registrations.get('conversation.chat.turnTail');
    const Dock = registrations.get('conversation.composer.dock');
    const Styles = registrations.get('shell.overlay');
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(Styles),
        ...(owners ?? turns.map(turn => ({ turn, seq: turn * 10 }))).map((owner, index) => toolbar
          ? React.createElement('div', { key: index, 'data-turn-tail': typeof owner.turn === 'object' ? owner.turn?.turn : owner.turn },
            React.createElement('div', { 'data-slot': 'conversation.chat.turnTail' }, toolbarState.enabled && React.createElement(Tail, { sessionId, useSession, ...owner })),
            toolbarState.visible && React.createElement(native.MessageIconActions, { key: toolbarState.version, text: 'native copy text', time: toolbarState.clock === false ? undefined : 123, clock: 'end', t: native.t,
              onBranch: () => { actions.branches++; }, usageAction: toolbarState.detailed ? React.createElement(native.TurnUsagePanel, { usage: { totalTokens: 14600000, outputTokens: 100, uncachedInputTokens: 200 }, t: native.t }) : null }))
          : React.createElement(Tail, { key: index, sessionId, useSession, ...owner })),
        React.createElement(Dock, { sessionId, useSession })));
    });
    await React.act(async () => { await wait(210); });
  };
  t.after(async () => {
    await React.act(async () => { root.unmount(); });
    for (const dispose of disposers) dispose?.();
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await render();
  return { dom, document: dom.window.document, rpc, session, render, native, actions };
}
async function expand(dom, selector = '.dsh-tc-dock') {
  const root = dom.window.document.querySelector(selector);
  await React.act(async () => {
    root.querySelector('.dsh-tc-trigger').click();
    await wait(5);
  });
  return root.querySelector('.dsh-tc-popover');
}

test('real React renders formal slots, one stylesheet, shared requests and expandable Chinese details', async t => {
  const { dom, document, rpc } = await mount(t, { turns: Array.from({ length: 30 }, (_, i) => i + 1) });
  assert.equal(document.querySelectorAll('.dsh-tc-turn').length, 30);
  assert.equal(document.querySelectorAll('style[data-dsh-token-cost-styles]').length, 1);
  assert.equal(rpc.calls.length, 1);
  assert.match(document.querySelector('.dsh-tc-turn').textContent, /本轮估算 ¥0\.072 · \$0\.01/);
  assert.match(document.querySelector('.dsh-tc-dock').textContent, /会话累计 ¥0\.072 · \$0\.01/);
  const details = await expand(dom);
  assert.equal(details.tabIndex, -1);
  assert.equal(details.getAttribute('role'), 'dialog');
  assert.equal(document.activeElement, details);
  assert.match(details.textContent, /美元原币小计\$0\.01/);
  assert.match(details.textContent, /人民币原币小计¥0\.00/);
  assert.match(details.textContent, /输入 Token1,000/);
  assert.match(details.textContent, /请勿相加/);
  assert.match(details.textContent, /不等于账户实扣/);
  const attribution = [...details.querySelectorAll('a')].find(link => link.textContent === 'ExchangeRate-API');
  assert.equal(attribution.href, 'https://www.exchangerate-api.com/');
  const source = details.querySelector('a[href="https://example.com/prices"]');
  assert.equal(source.rel, 'noopener noreferrer');
  const request = details.querySelector('.dsh-tc-request');
  await React.act(async () => { request.open = true; });
  assert.match(request.textContent, /单价 \/ 百万 Token/);
  assert.match(request.textContent, /高峰/);
  await React.act(async () => {
    details.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(details.matches(':popover-open'), false);
  assert.equal(document.activeElement, document.querySelector('.dsh-tc-dock .dsh-tc-trigger'));
});

test('actual rc.5 turn-tail owners select the correct numeric turn and only its request records', async t => {
  const owner = await captureSdkTurnOwner(7, 'step', 70);
  if (!owner) { t.skip('Optional local SDK extraction is unavailable'); return; }
  assert.equal(typeof owner.turn, 'object');
  assert.equal(owner.turn.turn, 7);
  const value = summary('session-a', {
    totals: totals({ usd: 1, cny: 7.2 }),
    turns: [{ turn: 7, totals: totals({ usd: 0.02, cny: 0.144 }), models: ['turn-seven'], warnings: ['turn-seven-warning'] }],
    warnings: ['another-turn-warning'],
  });
  value.records = [{ ...value.records[0], turn: 7, model: 'turn-seven' }, { ...value.records[0], id: 'other', turn: 8, model: 'turn-eight' }];
  const { dom, document, rpc } = await mount(t, { owners: [owner], value });
  assert.match(document.querySelector('.dsh-tc-turn .dsh-tc-trigger').textContent, /本轮估算 ¥0\.144 · \$0\.02/);
  assert.doesNotMatch(document.querySelector('.dsh-tc-turn .dsh-tc-trigger').textContent, /暂无用量/);
  assert.match(document.querySelector('.dsh-tc-dock .dsh-tc-trigger').textContent, /会话累计 ¥7\.20 · \$1\.00/);
  const panel = await expand(dom, '.dsh-tc-turn');
  assert.match(panel.textContent, /第 7 轮费用/);
  assert.equal(panel.querySelectorAll('.dsh-tc-request').length, 1);
  assert.match(panel.textContent, /turn-seven/);
  assert.match(panel.textContent, /turn-seven-warning/);
  assert.doesNotMatch(panel.textContent, /turn-eight|another-turn-warning|\[object Object\]/);
  assert.equal(rpc.calls.length, 1);
});

async function exerciseToolbar(t, sdk = null) {
  const { dom, document, render, actions, native } = await mount(t, { toolbar: true, sdk, owners: [createTurnOwnerFixture(1)] });
  const find = () => {
    const toolbar = document.querySelector('[data-clock="end"]');
    const outlet = toolbar?.querySelector('[data-dsh-token-cost-portal]');
    const usage = toolbar?.querySelector(`.${native.usageClasses.trigger}`)?.parentElement;
    const clock = toolbar?.querySelector(`.${native.messageClasses.timeEnd}`);
    return { toolbar, outlet, usage, clock };
  };
  let { toolbar, outlet, usage, clock } = find();
  assert.ok(outlet);
  assert.equal(usage.nextElementSibling, outlet);
  assert.equal(outlet.nextElementSibling, clock);
  assert.match(outlet.textContent, /本轮估算 ¥0\.072/);
  assert.equal(document.querySelector('[data-slot="conversation.chat.turnTail"] .dsh-tc-turn'), null);
  const copy = toolbar.querySelector('button[aria-label="复制"]');
  await React.act(async () => { copy.click(); await wait(5); });
  assert.deepEqual(actions.copies, ['native copy text']);
  await React.act(async () => { toolbar.querySelector('button[aria-label="分支"]').click(); });
  assert.equal(actions.branches, 1);
  const usageButton = usage.querySelector('button');
  await React.act(async () => { usageButton.click(); });
  assert.ok(document.querySelector('[role="dialog"][aria-label="原生 Token 用量"]'));
  await React.act(async () => { usageButton.click(); });
  assert.deepEqual(actions.usage, [true, false]);
  const panel = await expand(dom, '[data-dsh-token-cost-portal] .dsh-tc-turn');
  await React.act(async () => { panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(document.activeElement, outlet.querySelector('.dsh-tc-trigger'));
  await render('session-a', { detailed: false });
  assert.equal(find().outlet, outlet);
  assert.equal(outlet.nextElementSibling, find().clock);
  assert.equal(find().usage, undefined);
  await render('session-a', { detailed: true });
  assert.equal(find().usage.nextElementSibling, outlet);
  await render('session-a', { version: 1 });
  assert.equal(outlet.isConnected, false);
  ({ toolbar, outlet, usage, clock } = find());
  assert.equal(usage.nextElementSibling, outlet);
  assert.equal(outlet.nextElementSibling, clock);
  assert.equal(document.querySelectorAll('[data-dsh-token-cost-portal]').length, 1);
  await render('session-a', { visible: false });
  assert.equal(document.querySelectorAll('[data-dsh-token-cost-portal]').length, 0);
  assert.ok(document.querySelector('[data-slot="conversation.chat.turnTail"] .dsh-tc-turn'));
  await render('session-a', { visible: true });
  assert.ok(find().outlet);
  const nativeCopy = find().toolbar.querySelector('button[aria-label="复制"]');
  const nativeClock = find().clock;
  await render('session-a', { enabled: false });
  assert.equal(document.querySelectorAll('[data-dsh-token-cost-portal]').length, 0);
  assert.equal(document.querySelectorAll('[data-dsh-token-cost-anchor]').length, 0);
  assert.equal(find().toolbar.querySelector('button[aria-label="复制"]'), nativeCopy);
  assert.equal(find().clock, nativeClock);
  await render('session-a', { enabled: true });
  assert.equal(document.querySelectorAll('[data-dsh-token-cost-portal]').length, 1);
  await render('session-a', { detailed: false, clock: false });
  assert.equal(document.querySelectorAll('[data-dsh-token-cost-portal]').length, 0);
  assert.ok(document.querySelector('[data-slot="conversation.chat.turnTail"] .dsh-tc-turn'));
}

test('public toolbar contract preserves native controls and handles dynamic placement and cleanup', t => exerciseToolbar(t));
test('optional real SDK MessageIconActions and TurnUsagePanel preserve order and native event handlers', async t => {
  const sdk = await readSdkToolbar();
  if (!sdk) { t.skip('Optional local SDK extraction is unavailable'); return; }
  await exerciseToolbar(t, sdk);
});

test('invalid turn owners never display the session total as a turn estimate', async t => {
  const { document, rpc } = await mount(t, { owners: [{ turn: {} }, { turn: { turn: '1' } }, { turn: null }, { turn: undefined }] });
  assert.equal(document.querySelectorAll('.dsh-tc-turn').length, 0);
  assert.equal(document.querySelectorAll('.dsh-tc-dock').length, 1);
  assert.equal(rpc.calls.length, 1);
});

test('reasoning output price appears only when it differs from the ordinary output price', async t => {
  const value = summary();
  const base = value.records[0];
  value.records = [4, 2, undefined].map((reasoning, index) => ({
    ...base, id: `request-${index}`,
    quote: { ...base.quote, price: { ...base.quote.price, rates: { ...base.quote.price.rates, reasoning } } },
  }));
  const { dom } = await mount(t, { value });
  const details = await expand(dom);
  assert.match(details.textContent, /原币小计按价目币种累计/);
  const requests = [...details.querySelectorAll('.dsh-tc-request')];
  assert.match(requests[0].textContent, /推理输出 \$4\.00 \/ 百万 Token/);
  assert.doesNotMatch(requests[1].textContent, /推理输出/);
  assert.doesNotMatch(requests[2].textContent, /推理输出/);
});

test('all unknown amounts and token counts stay unknown with a visible unpriced count', async t => {
  const unknown = totals({ usd: 0, cny: 0, nativeUsd: 0, nativeCny: 0, requests: 2, priced: 0, unknown: 2,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
  const value = summary('session-a', { totals: unknown, turns: [{ turn: 1, totals: unknown, models: ['mystery'], warnings: ['未识别的模型'] }], records: [] });
  const { dom, document } = await mount(t, { value });
  assert.match(document.querySelector('.dsh-tc-dock').textContent, /会话累计 ¥— · \$—/);
  assert.match(document.querySelector('.dsh-tc-dock').textContent, /2 次未计价/);
  const details = await expand(dom);
  assert.match(details.textContent, /美元原币小计\$—/);
  assert.match(details.textContent, /输入 Token—/);
  assert.doesNotMatch(details.textContent, /¥0\.00|\$0\.00/);
});

test('error state offers a working retry and manual price refresh uses the same authenticated connection', async t => {
  let fail = true;
  const { dom, document, rpc } = await mount(t, { handler: (_channel, _method, payload) => {
    if (fail) throw new Error('HTTP 503');
    return { ok: true, value: summary(payload.sessionId) };
  } });
  const error = document.querySelector('.dsh-tc-dock .dsh-tc-error-row');
  assert.match(error.textContent, /费用读取失败：HTTP 503/);
  assert.equal(error.getAttribute('role'), 'status');
  fail = false;
  await React.act(async () => { error.querySelector('button').click(); await wait(25); });
  assert.equal(document.querySelector('.dsh-tc-dock .dsh-tc-error-row'), null);
  const details = await expand(dom);
  const refresh = [...details.querySelectorAll('button')].find(button => button.textContent === '更新价格与汇率');
  await React.act(async () => { refresh.click(); await wait(25); });
  assert.equal(rpc.calls.at(-1)[1], 'dsh-token-cost/refresh');
});

test('live running completion refreshes totals and session switch resets expanded content', async t => {
  const { dom, document, rpc, session, render } = await mount(t);
  await expand(dom);
  await React.act(async () => { session.set({ running: true }); });
  await React.act(async () => { await wait(210); });
  await React.act(async () => { session.set({ running: false }); });
  await React.act(async () => { await wait(210); });
  assert.equal(rpc.calls.length, 3);
  await render('session-b');
  assert.equal(rpc.calls.at(-1)[2].sessionId, 'session-b');
  assert.equal(document.querySelector('.dsh-tc-dock .dsh-tc-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.dsh-tc-panel'), null);
});

test('CSS provides theme tokens, mobile sizing, visible keyboard focus and reduced-motion support', () => {
  assert.match(css, /--dsw-alias-bg-layer-1/);
  assert.match(css, /prefers-color-scheme:dark/);
  assert.match(css, /max-width:480px/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /max-height:min\(420px,60vh\)/);
  assert.match(css, /transition:transform 120ms/);
  assert.doesNotMatch(css, /[⌄›]/);
});
