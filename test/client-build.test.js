import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createSummaryStore } from '../src/client.js';
import { summary, observable, clock } from './client-helpers.js';
import { readSdkSource } from './client-sdk.js';

// Build the actual distributable before inspecting its registration and imports.
await import('../scripts/build-client.mjs');
const bundle = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');

test('distributable uses the DSH module factory with shared React and ReactDOM imports', () => {
  let registered;
  let called = 0;
  const context = vm.createContext({ window: { __ModuleLoader__: { load(value) { called++; registered = value; } } } });
  vm.runInContext(bundle, context);
  assert.equal(called, 1);
  assert.equal(registered.id, 'dsh-token-cost');
  const requests = [];
  const plugin = registered.factory(name => { requests.push(name); return { createElement() {} }; });
  assert.deepEqual(requests, ['react', 'react-dom']);
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'connection']);
  assert.equal(typeof plugin.apply, 'function');
  assert.doesNotMatch(bundle, /__SECRET_INTERNALS|react\.production\.min|document\.(querySelector|createElement)|appendChild|innerHTML|globalThis\.fetch/);
});

test('registered components use the formal turnTail, composer dock and stylesheet slots', async () => {
  let registered;
  const time = clock();
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: value => { registered = value; } } },
    ...time.timers, AbortController, URL,
  });
  vm.runInContext(bundle, context);
  const plugin = registered.factory(() => ({ createElement() {} }));
  const registrations = [];
  const effects = [];
  plugin.apply({
    connection: { generation: observable({ id: 1 }), rpc: { call() { throw new Error('No UI mounted'); } } },
    effect: callback => { effects.push(callback()); },
    slots: { inject(name, callback) { callback(); }, register(descriptor, component) { registrations.push({ descriptor, component }); } },
  });
  assert.deepEqual(registrations.map(item => item.descriptor.name), ['conversation.chat.turnTail', 'conversation.composer.dock', 'shell.overlay']);
  assert.equal(registrations[0].descriptor.id, 'token-cost.turn');
  assert.equal(registrations[1].descriptor.id, 'token-cost.session');
  for (const dispose of effects) dispose();
  assert.equal(time.pending(), 0);
});

test('actual rc.5 Connection SDK sends authenticated transport envelope and validates correlation', async t => {
  const source = await readSdkSource('dsh-client-connection', 'lib/client.browser.js');
  if (!source) { t.skip('Read-only extracted SDK is not included in published package'); return; }
  let module;
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: value => { module = value; } } },
    crypto: webcrypto, URL, AbortController, Response, Headers, console,
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  const sdk = module.factory(() => { throw new Error('Unexpected external SDK dependency'); });
  const calls = [];
  let connection;
  let badCorrelation = false;
  sdk.installConnection({ provide(name, value) { assert.equal(name, 'connection'); connection = value; } }, {
    transport: { async fetch(path, init) {
      const envelope = JSON.parse(init.body);
      calls.push({ path, init, envelope });
      return new Response(JSON.stringify({ type: 'server-response', rpcId: badCorrelation ? 'wrong-id' : envelope.rpcId, result: { ok: true, value: summary(envelope.payload.sessionId) } }), { headers: { 'content-type': 'application/json' } });
    } },
  });
  const time = clock();
  const store = createSummaryStore({ ...connection, generation: observable({ id: 1 }) }, { timers: time.timers, document: null, debounceMs: 0 });
  store.subscribe('session-a', () => {});
  await time.tick();
  // The actual SDK builds a document-relative route, so subpath-mounted hosts work.
  assert.equal(calls[0].path, 'api/dsh-token-cost/summary');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].envelope.type, 'client-request');
  assert.equal(calls[0].envelope.method, 'dsh-token-cost/summary');
  assert.equal(typeof calls[0].envelope.rpcId, 'string');
  assert.deepEqual(calls[0].envelope.payload, { sessionId: 'session-a' });
  // Allow Response.json()'s stream continuation to settle.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot('session-a').summary.sessionId, 'session-a');
  badCorrelation = true;
  await assert.rejects(connection.rpc.call('/api', 'dsh-token-cost/summary', { sessionId: 'session-a' }), /rpcId mismatch/);
  store.dispose();
});
