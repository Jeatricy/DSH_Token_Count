import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryStore, formatMoney, formatCount, amountText, safeSourceUrl, normalizeTurn, popoverPosition, validateSummary, SUMMARY_METHOD, REFRESH_METHOD } from '../src/client.js';
import { totals, summary, clock, connection, deferred, settle } from './client-helpers.js';

function setup(handler, extra = {}) {
  const time = clock();
  const rpc = connection(handler);
  const store = createSummaryStore(rpc, { timers: time.timers, now: time.now, debounceMs: 10, pollMs: 1000, timeoutMs: 500, document: null, ...extra });
  return { time, rpc, store };
}

test('turn identity accepts the official object and numeric callers without coercion', () => {
  assert.equal(normalizeTurn({ turn: 7, status: 'closed' }), 7);
  assert.equal(normalizeTurn(7), 7);
  assert.equal(normalizeTurn(0), 0);
  for (const invalid of [null, undefined, {}, { turn: '7' }, { turn: -1 }, { turn: Infinity }, { turn: 1.5 }, [7], '7', NaN]) {
    assert.equal(normalizeTurn(invalid), undefined);
  }
});

test('popover geometry stays above the composer and within both narrow and short viewports', () => {
  const viewport = { width: 375, height: 812 };
  const anchor = { left: 290, width: 60, top: 700, bottom: 728 };
  const position = popoverPosition(anchor, viewport, true);
  assert.equal(position.placement, 'up');
  assert.equal(position.width, 351);
  assert.equal(position.left, 12);
  assert.equal(position.top, 692);
  assert.equal(position.maxHeight, 420);
  const short = popoverPosition({ ...anchor, top: 160, bottom: 188 }, viewport, true);
  assert.equal(short.maxHeight, 140);
  const turnNearTop = popoverPosition({ ...anchor, top: 50, bottom: 78 }, viewport);
  assert.equal(turnNearTop.placement, 'down');
  assert.equal(turnNearTop.top, 86);
});

test('missing and tiny money cannot appear as zero; both conversions are kept separate', () => {
  assert.equal(formatMoney(null), '¥—');
  assert.equal(formatMoney(undefined, 'USD'), '$—');
  assert.equal(formatMoney(NaN), '¥—');
  assert.equal(formatMoney(0), '¥0.00');
  assert.equal(formatMoney(0.0000001), '¥<0.000001');
  assert.equal(formatMoney(0.000123, 'USD'), '$0.000123');
  assert.equal(amountText(totals()), '¥0.072 · $0.01');
  assert.equal(amountText(totals({ requests: 2, priced: 0, unknown: 2, cny: 0, usd: 0 })), '¥— · $—');
  assert.equal(formatCount(null), '—');
  assert.equal(safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeSourceUrl('https://example.com/prices'), 'https://example.com/prices');
});

test('summary rejects wrong sessions and corrupt money instead of rendering misleading values', () => {
  assert.equal(validateSummary(summary(), 'session-a').sessionId, 'session-a');
  assert.throws(() => validateSummary(summary('session-b'), 'session-a'), /格式不正确/);
  assert.throws(() => validateSummary(summary('session-a', { totals: totals({ cny: '0' }) }), 'session-a'), /格式不正确/);
  assert.throws(() => validateSummary(summary('session-a', { turns: [{ turn: 1 }] }), 'session-a'), /格式不正确/);
});

test('50 turn slots and the composer share one initial request and one poll clock', async () => {
  const { store, rpc, time } = setup();
  const releases = Array.from({ length: 51 }, () => store.subscribe('session-a', () => {}));
  for (let turn = 1; turn <= 50; turn++) store.observe('session-a', false, turn, turn * 10);
  await time.tick(10);
  assert.equal(rpc.calls.length, 1);
  assert.deepEqual(rpc.calls[0].slice(0, 3), ['/api', SUMMARY_METHOD, { sessionId: 'session-a' }]);
  assert.equal(store.getSnapshot('session-a').summary.totals.cny, 0.072);
  await time.tick(1000);
  assert.equal(rpc.calls.length, 2);
  for (const release of releases) release();
  assert.equal(time.pending(), 0);
  store.dispose();
  assert.equal(rpc.generation.size(), 0);
});

test('turn end and changed tail trigger one automatic refresh after an in-flight read', async () => {
  const first = deferred();
  let count = 0;
  const { store, rpc, time } = setup((_channel, _method, payload) => ++count === 1 ? first.promise : { ok: true, value: summary(payload.sessionId) });
  store.subscribe('session-a', () => {});
  store.observe('session-a', true, 1, 10);
  await time.tick(10);
  for (let i = 0; i < 50; i++) store.observe('session-a', false, 1, 20);
  await time.tick(100);
  assert.equal(rpc.calls.length, 1);
  first.resolve({ ok: true, value: summary() });
  await settle();
  await time.tick(10);
  assert.equal(rpc.calls.length, 2);
  store.dispose();
});

test('changing sessions isolates snapshots and remount refreshes a cached session', async () => {
  const pending = deferred();
  const { store, rpc, time } = setup((_channel, _method, payload) => payload.sessionId === 'session-a' ? pending.promise : { ok: true, value: summary(payload.sessionId) });
  const releaseA = store.subscribe('session-a', () => {});
  await time.tick(10);
  releaseA();
  store.subscribe('session-b', () => {});
  await time.tick(10);
  pending.resolve({ ok: true, value: summary('session-a') });
  await settle();
  assert.equal(store.getSnapshot('session-b').summary.sessionId, 'session-b');
  assert.equal(store.getSnapshot('session-a').summary, null);
  assert.equal(rpc.calls[0][3].aborted, true);
  const releaseAgain = store.subscribe('session-a', () => {});
  await time.tick(10);
  assert.equal(rpc.calls.length, 3);
  releaseAgain();
  store.dispose();
});

test('connection generations abort and discard old host responses before refetching', async () => {
  const old = deferred();
  let count = 0;
  const { store, rpc, time } = setup((_channel, _method, payload) => ++count === 1 ? old.promise : { ok: true, value: summary(payload.sessionId, { totals: totals({ cny: 2 }) }) });
  store.subscribe('session-a', () => {});
  await time.tick(10);
  rpc.generation.set(undefined);
  assert.equal(store.getSnapshot('session-a').connected, false);
  assert.equal(store.getSnapshot('session-a').summary, null);
  rpc.generation.set({ id: 2, host: 'second-host' });
  await time.tick(10);
  old.resolve({ ok: true, value: summary() });
  await settle();
  assert.equal(store.getSnapshot('session-a').summary.totals.cny, 2);
  assert.equal(rpc.calls[0][3].aborted, true);
  store.dispose();
});

test('a turn finishing during reconnect still refreshes after the replacement read', async () => {
  const reconnectRead = deferred();
  let count = 0;
  const { store, rpc, time } = setup((_channel, _method, payload) => ++count === 2 ? reconnectRead.promise : { ok: true, value: summary(payload.sessionId) });
  store.subscribe('session-a', () => {});
  store.observe('session-a', true, 1, 10);
  await time.tick(10);
  rpc.generation.set({ id: 2, host: 'same-host' });
  await time.tick(10);
  store.observe('session-a', false, 1, 20);
  reconnectRead.resolve({ ok: true, value: summary() });
  await settle();
  await time.tick(10);
  assert.equal(rpc.calls.length, 3);
  store.dispose();
});

test('network error is visible, retry succeeds, explicit price refresh uses its endpoint', async () => {
  let count = 0;
  const { store, rpc, time } = setup((_channel, _method, payload) => {
    if (++count === 1) throw new Error('HTTP 503');
    return { ok: true, value: summary(payload.sessionId) };
  });
  store.subscribe('session-a', () => {});
  await time.tick(10);
  assert.equal(store.getSnapshot('session-a').error, 'HTTP 503');
  store.retry('session-a');
  await time.tick();
  assert.equal(store.getSnapshot('session-a').error, null);
  store.refresh('session-a');
  await time.tick();
  assert.equal(rpc.calls.at(-1)[1], REFRESH_METHOD);
  store.dispose();
});

test('timeout unlocks requests even if a transport ignores abort', async () => {
  const never = deferred();
  let count = 0;
  const { store, rpc, time } = setup((_channel, _method, payload) => ++count === 1 ? never.promise : { ok: true, value: summary(payload.sessionId) });
  store.subscribe('session-a', () => {});
  await time.tick(510);
  assert.match(store.getSnapshot('session-a').error, /超时/);
  assert.equal(rpc.calls[0][3].aborted, true);
  store.retry('session-a');
  await time.tick();
  assert.equal(store.getSnapshot('session-a').summary.sessionId, 'session-a');
  store.dispose();
});

test('hidden pages stop polling and visible pages refresh immediately', async () => {
  const events = new Map();
  const document = { visibilityState: 'hidden', addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const { store, rpc, time } = setup(undefined, { document });
  store.subscribe('session-a', () => {});
  await time.tick(10);
  await time.tick(2000);
  assert.equal(rpc.calls.length, 1);
  document.visibilityState = 'visible';
  events.get('visibilitychange')();
  await time.tick(10);
  assert.equal(rpc.calls.length, 2);
  store.dispose();
  assert.equal(events.size, 0);
});

test('a failed update keeps the previous summary explicitly marked with error', async () => {
  let fail = false;
  const { store, time } = setup((_channel, _method, payload) => fail ? { ok: false, error: { message: '费用服务暂不可用' } } : { ok: true, value: summary(payload.sessionId) });
  store.subscribe('session-a', () => {});
  await time.tick(10);
  fail = true;
  store.retry('session-a');
  await time.tick();
  assert.equal(store.getSnapshot('session-a').summary.sessionId, 'session-a');
  assert.equal(store.getSnapshot('session-a').error, '费用服务暂不可用');
  store.dispose();
});
