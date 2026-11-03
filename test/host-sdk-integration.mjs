// Run with installed Electron in Node mode; this never creates a web server.
// ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals test/host-sdk-integration.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createHost } from '../src/host.js';
import { PricingService } from '../src/pricing-service.js';

assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1', 'Use the installed Electron with ELECTRON_RUN_AS_NODE=1');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = process.argv[2] ?? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
const sdkImport = (name, path = 'lib/index.js') => import(pathToFileURL(join(sdkRoot, name, path)).href);
const [{ Context }, { SessionStore }, persistencePlugin, llm] = await Promise.all([
  sdkImport('cordis'), sdkImport('dsh-session'), sdkImport('dsh-session-persistence-jsonl'), sdkImport('dsh-llm'),
]);
const sessionPackage = JSON.parse(await readFile(join(sdkRoot, 'dsh-session', 'package.json'), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'dsh-token-cost-real-sdk-'));
assert.ok(resolve(scratch).startsWith(join(resolve(tmpdir()), 'dsh-token-cost-real-sdk-')));
const dataDir = join(scratch, 'cost');
const persistenceRoot = join(scratch, 'session-storage');
const ctx = new Context();
const fibers = [];
let host;
let forkFiber;
let parentDetach;
let parentWriter;
let forkWriter;
const report = { ok: false, sdkVersion: sessionPackage.version, runtime: { node: process.versions.node, electron: process.versions.electron },
  isolated: true, profileModified: false, serverStarted: false, checks: [] };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const tokens = (input, output, read = 0, write = 0, reasoning = 0) => ({ inputTokens: input, outputTokens: output,
  cacheReadTokens: read, cacheWriteTokens: write, reasoningTokens: reasoning, totalTokens: input + output + read + write });
function compactStream(usage) {
  const accumulator = new llm.AssistantStreamAccumulator();
  const time = Date.now();
  accumulator.push({ time, chunk: { type: 'text-delta', index: 0, text: 'SDK_SYNTHETIC_CONTENT' } });
  accumulator.push({ time: time + 1, chunk: { type: 'usage', usage } });
  accumulator.push({ time: time + 2, chunk: { type: 'finish', reason: { kind: 'stop' } } });
  return accumulator.snapshot();
}
function settle(session, { turn, step, model, usage, explicitUsage = true }) {
  session.append('assistant/message', { turn, step,
    message: llm.createAssistantMessage({ source: { provider: 'sdk-test', model }, content: [{ type: 'text', text: 'SDK_SYNTHETIC_CONTENT' }] }),
    ...(explicitUsage ? { usage } : {}), stream: compactStream(usage),
  }, { surfaceOp: 'append' });
}
async function snapshotFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push([path.slice(root.length), createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  await visit(root);
  return result.sort(([left], [right]) => left.localeCompare(right));
}
try {
  const storeFiber = ctx.plugin(SessionStore); fibers.push(storeFiber); await storeFiber;
  const persistenceFiber = ctx.plugin(persistencePlugin, { root: persistenceRoot, compression: 'none' });
  fibers.push(persistenceFiber); await persistenceFiber;
  assert.ok(ctx.sessions); assert.ok(ctx.sessionPersistence);
  const config = { dataDir, overrides: [
    { provider: 'sdk-test', model: 'sdk-model-a', currency: 'CNY', rates: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } },
    { provider: 'sdk-test', model: 'sdk-model-b', currency: 'USD', rates: { input: 6, output: 24, cacheRead: 0.6, cacheWrite: 7.5 } },
  ] };
  const pricingService = new PricingService({ dataDir, config, fetch: async () => { throw new Error('Isolated SDK test is offline'); } });
  const hostFiber = ctx.plugin({ name: 'token-cost-sdk-test-host', inject: ['sessions', 'sessionPersistence'], async apply(scope) {
    host = await createHost(scope, config, { pricingService });
    scope.effect(() => () => host.dispose(), 'integration cost host');
  } }); fibers.push(hostFiber); await hostFiber;
  assert.ok(host);
  const parent = ctx.sessions.prepare('sdk-parent', { meta: { cwd: scratch } });
  parentWriter = await ctx.sessionPersistence.create(parent.header);
  parentDetach = ctx.sessions.enter(parent); ctx.sessions.announce(parent);
  let observedEvents = 0;
  const observer = ctx.on('session/event', session => { if (session.id === parent.id) observedEvents += 1; });
  parent.append('turn/start', { turn: 1 });
  const start = parent.append('step/start', { turn: 1, step: 1 });
  parent.append('request/header', { reason: 'initial', header: { config: { provider: 'sdk-test', model: 'sdk-model-a' } } });
  settle(parent, { turn: 1, step: 1, model: 'sdk-model-a', usage: tokens(100, 40, 500, 50, 30), explicitUsage: false });
  parent.append('step/end', { turn: 1, step: 1 });
  parent.append('step/start', { turn: 1, step: 2 });
  parent.append('request/header', { reason: 'change', header: { config: { provider: 'sdk-test', model: 'sdk-model-b' } } });
  settle(parent, { turn: 1, step: 2, model: 'sdk-model-b', usage: tokens(20, 5) });
  parent.append('step/end', { turn: 1, step: 2 });
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await host.flush(); await ctx.sessionPersistence.flush();
  assert.equal(observedEvents, parent.snapshotEvents(0).length); observer();
  const live = await host.summary(parent.id);
  assert.equal(live.totals.requests, 2); assert.equal(live.totals.priced, 2);
  assert.equal(live.totals.inputTokens, 120); assert.equal(live.totals.outputTokens, 45);
  assert.equal(live.totals.cacheReadTokens, 500); assert.equal(live.totals.cacheWriteTokens, 50);
  assert.equal(live.records[0].time, start.time);
  near(live.records[0].quote.native, (200 + 320 + 100 + 125) / 1_000_000);
  near(live.records[1].quote.native, (120 + 120) / 1_000_000);
  assert.deepEqual(live.turns[0].models, ['sdk-model-a', 'sdk-model-b']);
  report.checks.push('real SessionStore.append -> Cordis session/event -> createHost listener', 'real AssistantStreamAccumulator compact usage fallback', 'cache buckets and reasoning output', 'model switch and request timestamp');

  let child;
  forkFiber = ctx.plugin({ name: 'token-cost-sdk-test-fork', inject: ['sessions'], apply(scope) { child = scope.sessions.fork(parent, undefined, 'sdk-child'); } });
  await forkFiber;
  assert.equal(child.inheritedEventCount, parent.snapshotEvents(0).length);
  forkWriter = await ctx.sessionPersistence.create(child.header, { inheritedEventCount: child.inheritedEventCount });
  // Constructor seed events do not publish. Persist that prefix once before
  // live routing appends the child's own events, as the agent-loop does.
  await forkWriter.append(child.snapshotEvents(0));
  child.append('turn/start', { turn: 2 }); child.append('step/start', { turn: 2, step: 1 });
  settle(child, { turn: 2, step: 1, model: 'sdk-model-b', usage: tokens(3, 1) });
  child.append('step/end', { turn: 2, step: 1 }); child.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await host.flush(); await ctx.sessionPersistence.flush();
  const childLive = await host.summary(child.id);
  assert.equal(childLive.totals.requests, 1); assert.equal(childLive.totals.inputTokens, 3);
  assert.equal(childLive.records[0].turn, 2); assert.equal(childLive.records[0].model, 'sdk-model-b');
  report.checks.push('real SessionStore.fork inheritedEventCount excludes copied parent consumption');

  await forkWriter.close(); parentDetach(); parentDetach = null;
  await parentWriter.close(); await forkFiber.dispose(); forkFiber = null;
  assert.equal(ctx.sessions.get(parent.id), undefined); assert.equal(ctx.sessions.get(child.id), undefined);
  await host.flush();
  const beforeArchive = await snapshotFiles(persistenceRoot);
  const archive = await host.summary(parent.id);
  const repeated = await host.summary(parent.id);
  const childArchive = await host.summary(child.id);
  assert.deepEqual(archive.records, live.records); assert.deepEqual(repeated.records, live.records);
  assert.deepEqual(childArchive.records, childLive.records);
  const afterArchive = await snapshotFiles(persistenceRoot);
  assert.deepEqual(afterArchive, beforeArchive);
  assert.ok(!archive.warnings.some(value => value.includes('无法只读回填')));
  report.checks.push('real JSONL persistence open(read)/read/close archived summary', 'repeated archive replay and fork deduplication', 'archive file hashes unchanged by cost reads');

  // A second fresh cost directory proves cold history estimation works without
  // reusing the already-observed receipts.
  const coldDataDir = join(scratch, 'cold-cost');
  const coldPricing = new PricingService({ dataDir: coldDataDir, config, fetch: async () => { throw new Error('Isolated SDK test is offline'); } });
  const coldHost = await createHost(ctx, { ...config, dataDir: coldDataDir }, { pricingService: coldPricing });
  try {
    const cold = await coldHost.summary(parent.id);
    const coldChild = await coldHost.summary(child.id);
    assert.equal(cold.totals.requests, 2); assert.match(cold.records[0].quote.warnings.join(' '), /历史回填/);
    assert.equal(coldChild.totals.requests, 1); assert.equal(coldChild.totals.inputTokens, 3);
    assert.deepEqual(await snapshotFiles(persistenceRoot), beforeArchive);
    report.checks.push('fresh ledger reads real archived sessions with historical-estimate warnings');
  } finally { await coldHost.dispose(); }
  const receipt = await readFile(host.ledger.pathFor(parent.id), 'utf8');
  assert.ok(!receipt.includes('SDK_SYNTHETIC_CONTENT'));
  assert.ok(!receipt.includes('"content"'));
  report.checks.push('cost receipts exclude synthetic conversation content');
  report.totals = { live: live.totals, archive: archive.totals, childOwn: childLive.totals };
  report.eventCounts = { parent: parent.seq, child: child.seq, inherited: child.inheritedEventCount, observed: observedEvents };
  report.ok = true;
} catch (error) {
  report.error = { name: error.name, message: error.message };
  throw error;
} finally {
  if (parentDetach) parentDetach();
  await Promise.allSettled([parentWriter?.close(), forkWriter?.close()]);
  if (forkFiber) await forkFiber.dispose();
  if (host) await host.dispose();
  for (const fiber of fibers.reverse()) await fiber.dispose();
  const intended = resolve(scratch);
  assert.ok(intended.startsWith(join(resolve(tmpdir()), 'dsh-token-cost-real-sdk-')));
  await rm(intended, { recursive: true, force: true });
  report.temporaryDataRemoved = true;
  const artifacts = join(projectRoot, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'sdk-integration.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
