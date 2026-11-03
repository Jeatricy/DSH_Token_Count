import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CostLedger } from '../src/ledger.js';
import { createHost, createRpcHandler, createFetchHandler, readArchivedSession, resolveDataDir, loadConfiguration } from '../src/host.js';
import { FakePricing, fixture, usage } from './ledger-fixtures.js';

function context(sessions = [], persistence) {
  const handlers = new Map(); const live = new Map(sessions.map(session => [session.id, session]));
  return {
    handlers, live, messages: [], sessionPersistence: persistence,
    sessions: { list: () => [...live.values()], get: id => live.get(id) },
    get(name) { return this[name]; },
    logger: { warn() {} },
    on(name, listener) {
      const set = handlers.get(name) ?? new Set(); set.add(listener); handlers.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, ...args) { return [...(handlers.get(name) ?? [])].map(listener => listener(...args)); },
  };
}
function liveSession(id, events = [], inheritedEventCount = 0) {
  return { id, events, inheritedEventCount, snapshotEvents: from => events.filter(event => event.seq >= from) };
}
async function directory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-token-cost-host-test-'));
  t.after(async () => {
    assert.ok(resolve(dataDir).startsWith(join(resolve(tmpdir()), 'dsh-token-cost-host-test-')));
    await rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}
async function start(t, ctx, dependencies = {}) {
  const dataDir = await directory(t);
  const pricingService = dependencies.pricingService ?? new FakePricing();
  const host = await createHost(ctx, { dataDir }, { pricingService, ...dependencies });
  t.after(() => host.dispose());
  return { host, pricing: pricingService, dataDir };
}
function finished() {
  const f = fixture(); f.start(); f.header(); f.message(); f.end(); return f;
}

test('startup sweeps existing sessions and historical replay stays idempotent', async t => {
  const f = finished(); const session = liveSession('existing', f.events);
  const { host } = await start(t, context([session]));
  const first = await host.summary('existing'); const second = await host.summary('existing');
  assert.equal(first.totals.requests, 1); assert.deepEqual(second.records, first.records);
  assert.match(first.records[0].quote.warnings.join(' '), /历史回填/);
});

test('session/event handlers remain synchronous while capturing live receipts and retry refresh hints', async t => {
  const session = liveSession('live'); const ctx = context([session]);
  const { host, pricing } = await start(t, ctx);
  const f = finished();
  for (const event of f.events) {
    session.events.push(event);
    assert.deepEqual(ctx.emit('session/event', session, event), [undefined]);
  }
  await host.flush();
  const s = await host.summary('live');
  assert.equal(s.totals.requests, 1); assert.ok(pricing.refreshCalls.includes(false));
  assert.ok(!s.records[0].quote.warnings.some(warning => warning.includes('历史回填')));
  await host.dispose();
  assert.equal(ctx.handlers.get('session/event').size, 0); assert.equal(pricing.disposed, true);
});

test('late adoption marks only the restored prefix historical', async t => {
  const ctx = context(); const { host } = await start(t, ctx);
  const f = finished(); f.start(2, 1); f.header('deepseek', 'model-b');
  const latest = f.message({ turn: 2, model: 'model-b' });
  const session = liveSession('adopt', [...f.events]); ctx.live.set(session.id, session);
  ctx.emit('session/event', session, latest);
  await host.flush();
  const s = await host.summary('adopt');
  assert.equal(s.records.length, 2);
  assert.match(s.records[0].quote.warnings.join(' '), /历史回填/);
  // Its start preceded observation, so the second request is also explicitly
  // historical even though its settlement is the first live notification.
  assert.match(s.records[1].quote.warnings.join(' '), /历史回填/);
});

test('archive path opens read only, passes inheritance and closes the handle', async t => {
  const f = finished(); const inheritedEventCount = f.events.length;
  f.add('session/end-seed', { inherited: true }); f.start(2, 1); f.attempt({ turn: 2, tokens: usage(3, 1) }); f.end(2, 1);
  const calls = [];
  const persistence = { async open(id, access) {
    calls.push(['open', id, access]);
    return { inheritedEventCount, async read(offset, length) { calls.push(['read', offset, length]); return { eventState: 'shared-frozen', events: f.events }; },
      async close() { calls.push(['close']); } };
  } };
  const { host } = await start(t, context([], persistence));
  const s = await host.summary('archive-fork');
  assert.equal(s.totals.requests, 1); assert.equal(s.records[0].turn, 2);
  assert.deepEqual(calls, [['open', 'archive-fork', 'read'], ['read', 0, Number.MAX_SAFE_INTEGER], ['close']]);
});

test('read-only archive handles close on failure and sessionQuery observations dispose', async () => {
  let closed = 0; const error = new Error('archive unavailable');
  await assert.rejects(readArchivedSession({ sessionPersistence: { async open(id, access) {
    assert.equal(access, 'read'); return { inheritedEventCount: 0, async read() { throw error; }, async close() { closed += 1; } };
  } } }, 'bad'), error);
  assert.equal(closed, 1);
  let disposed = 0;
  const events = finished().events;
  const result = await readArchivedSession({ sessionQuery: { async observeSession(id, options) {
    assert.equal(options.projectionMode, 'none');
    return { events, inheritedEventCount: 0, [Symbol.dispose]() { disposed += 1; } };
  } } }, 'query');
  assert.equal(result.events.length, events.length); assert.equal(disposed, 1);
});

test('missing archive boundary refuses fork accounting rather than guessing', async () => {
  let closed = false;
  await assert.rejects(readArchivedSession({ sessionPersistence: { async open() {
    return { async read() { return { events: finished().events }; }, async close() { closed = true; } };
  } } }, 'fork'), /inherited/);
  assert.equal(closed, true);
});

test('archive unavailability returns existing ledger with a clear incompleteness warning', async t => {
  const ctx = context(); const { host } = await start(t, ctx);
  await host.ledger.ingest('saved', finished().events);
  const s = await host.summary('saved');
  assert.equal(s.totals.requests, 1); assert.match(s.warnings.join(' '), /只读回填/);
});

test('a failed live ledger write does not escape observer and summary repairs from original session', async t => {
  const dataDir = await directory(t); const pricing = new FakePricing();
  const ledger = new CostLedger({ dataDir, pricingService: pricing });
  const ingest = ledger.ingestProjected.bind(ledger); let fail = true;
  ledger.ingestProjected = (...args) => { if (fail) { fail = false; return Promise.reject(new Error('disk temporarily unavailable')); } return ingest(...args); };
  const session = liveSession('healed'); const ctx = context([session]);
  const host = await createHost(ctx, { dataDir }, { ledger, pricingService: pricing });
  t.after(() => host.dispose());
  for (const event of finished().events) { session.events.push(event); assert.doesNotThrow(() => ctx.emit('session/event', session, event)); }
  await host.flush();
  const s = await host.summary('healed');
  assert.equal(s.totals.requests, 1); assert.ok(s.warnings.length > 0);
});

test('offline initialization and refresh failures preserve conversation and known receipts', async t => {
  const pricing = new FakePricing();
  pricing.initialize = async () => { throw new Error('offline secret'); };
  pricing.refresh = async () => { throw new Error('offline secret'); };
  const session = liveSession('offline', finished().events);
  const { host } = await start(t, context([session]), { pricingService: pricing });
  const before = await host.summary('offline'); const after = await host.refresh('offline');
  assert.equal(after.totals.requests, 1); assert.deepEqual(after.records, before.records);
  assert.match(after.warnings.join(' '), /初始化失败|同步失败/);
  assert.ok(!JSON.stringify(after).includes('offline secret'));
});

test('manual refresh prices unknown records and leaves previously priced records unchanged', async t => {
  const pricing = new FakePricing(); pricing.unknown.add('model-a');
  const f = finished(); f.start(2); f.header('deepseek', 'model-b'); f.message({ turn: 2, model: 'model-b' }); f.end(2);
  const session = liveSession('refresh', f.events);
  const { host } = await start(t, context([session]), { pricingService: pricing });
  const before = await host.summary('refresh'); assert.equal(before.totals.unknown, 1);
  pricing.unknown.clear(); pricing.multiplier = 100; pricing.fx = 9;
  const after = await host.refresh('refresh');
  assert.equal(after.totals.unknown, 0); assert.equal(after.totals.priced, 2);
  assert.deepEqual(after.records[1], before.records[1]); assert.ok(pricing.refreshCalls.includes(true));
});

test('data directory resolution is portable and explicit configuration wins', () => {
  assert.equal(resolveDataDir({}, {}), resolve(homedir(), '.dsh', 'token-cost'));
  assert.equal(resolveDataDir({}, { DSH_HOME: '/custom-root' }), resolve('/custom-root', 'token-cost'));
  assert.equal(resolveDataDir({ dataDir: '~/cost-data' }, { DSH_HOME: '/other' }), resolve(homedir(), 'cost-data'));
});

test('default/explicit config JSON merges safely and bad configuration becomes a warning', async t => {
  const dataDir = await directory(t);
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ aliases: { old: 'model-a' }, providerSources: { custom: 'openrouter' }, overrides: [{ model: 'model-a' }] }));
  const loaded = await loadConfiguration({ dataDir, aliases: { extra: 'model-b' } });
  assert.deepEqual(loaded.config.aliases, { old: 'model-a', extra: 'model-b' });
  assert.equal(loaded.config.providerSources.custom, 'openrouter'); assert.deepEqual(loaded.warnings, []);
  const file = join(dataDir, 'malformed.json'); await writeFile(file, '{invalid');
  const invalid = await loadConfiguration({ dataDir, configFile: file });
  assert.equal(invalid.warnings.length, 1); assert.equal(invalid.config.dataDir, dataDir);
  const ctx = context(); const host = await createHost(ctx, { dataDir, configFile: file }, { pricingService: new FakePricing() });
  t.after(() => host.dispose());
  assert.match((await host.summary('empty')).warnings.join(' '), /外置费用配置/);
});

const owner = { principal: { kind: 'owner' } };
test('RPC gates owner access, validates payload and contains failures without leaking error details', async () => {
  const calls = [];
  const rpc = createRpcHandler({ async summary(id) { calls.push(id); return { sessionId: id }; }, async refresh() { throw new Error('secret credential'); } });
  assert.equal((await rpc('summary', { sessionId: 's' }, undefined, { principal: { kind: 'guest' } })).error.code, 'token-cost/forbidden');
  assert.equal((await rpc('summary', { sessionId: 's', extra: true }, undefined, owner)).error.code, 'token-cost/bad-request');
  assert.equal((await rpc('summary', {}, undefined, owner)).error.code, 'token-cost/bad-request');
  assert.equal((await rpc('other', {}, undefined, owner)).error.code, 'token-cost/not-found');
  assert.deepEqual(await rpc('summary', { sessionId: 's' }, undefined, owner), { ok: true, value: { sessionId: 's' } });
  const failure = await rpc('refresh', {}, undefined, owner);
  assert.equal(failure.error.code, 'token-cost/unavailable'); assert.ok(!JSON.stringify(failure).includes('credential'));
  assert.deepEqual(calls, ['s']);
});

test('Fetch routes honor the DSH client-request/server-response envelope and JSON method contract', async () => {
  const handler = createFetchHandler({ async summary(sessionId) { return { sessionId, totals: { requests: 1 } }; } }, 'summary');
  const url = 'http://localhost/api/dsh-token-cost/summary';
  const envelope = { type: 'client-request', rpcId: 'rpc-1', method: 'dsh-token-cost/summary', payload: { sessionId: 's' } };
  const request = body => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const response = await handler(request(envelope));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { sessionId: 's', totals: { requests: 1 } } } });
  assert.equal((await handler(new Request(url))).status, 405);
  assert.equal((await handler(new Request(url, { method: 'POST', body: 'x' }))).status, 415);
  assert.equal((await handler(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await handler(request({ ...envelope, method: 'wrong' }))).status, 400);
});

test('aborted RPC does not start reading history or refreshing prices', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  const rpc = createRpcHandler({ async summary() { called = true; } });
  const result = await rpc('summary', { sessionId: 's' }, controller.signal, owner);
  assert.equal(result.error.code, 'token-cost/aborted'); assert.equal(called, false);
});
