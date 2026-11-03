import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CostLedger, projectEvent, totalRecords } from '../src/ledger.js';
import { quoteRequest } from '../src/price-engine.js';
import { FakePricing, fixture, usage } from './ledger-fixtures.js';

async function setup(t, pricing = new FakePricing()) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-token-cost-ledger-test-'));
  const ledger = new CostLedger({ dataDir, pricingService: pricing });
  await ledger.initialize();
  t.after(async () => {
    await ledger.dispose();
    assert.ok(resolve(dataDir).startsWith(join(resolve(tmpdir()), 'dsh-token-cost-ledger-test-')));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ledger, pricing, dataDir };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} !== ${expected}`);

function complete(tokens = usage(), options = {}) {
  const f = fixture(); f.start(); f.header(); f.message({ tokens, ...options }); f.end(); return f;
}

test('legacy cached receipts expose precise cache notes without rewriting or repricing history', async t => {
  const pricing = new FakePricing();
  const originalQuote = pricing.quote.bind(pricing);
  pricing.quote = request => ({ ...originalQuote(request), warnings: ['未报告的缓存分项按 0 估算', '历史快照提示'] });
  const { ledger } = await setup(t, pricing);
  const tokens = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 800, totalTokens: 920 };
  await ledger.ingest('legacy-cache', complete(tokens).events);
  const path = ledger.pathFor('legacy-cache');
  const originalFile = await readFile(path, 'utf8');
  const storedQuote = JSON.parse(originalFile).records[0].quote;
  pricing.multiplier = 100;
  const beforeCalls = pricing.calls.length;
  const summary = await ledger.summary('legacy-cache');
  assert.equal(pricing.calls.length, beforeCalls);
  assert.equal(await readFile(path, 'utf8'), originalFile);
  assert.deepEqual({ ...summary.records[0].quote, warnings: [] }, { ...storedQuote, warnings: [] });
  assert.equal(summary.totals.cacheReadTokens, 800);
  assert.equal(summary.totals.cacheWriteTokens, 0);
  assert.ok(summary.warnings.some(message => message.includes('未单独报告缓存写入')));
  assert.ok(summary.warnings.every(message => message !== '未报告的缓存分项按 0 估算'));
});

test('rc.5 cache buckets are additive to uncached input, reasoning is already output', async t => {
  const { ledger, pricing } = await setup(t);
  const tokens = usage(100, 40, 500, 50, 30);
  await ledger.ingest('cache', complete(tokens).events);
  const s = await ledger.summary('cache');
  assert.equal(s.totals.requests, 1); assert.equal(s.totals.priced, 1); assert.equal(s.totals.estimated, 1);
  assert.equal(s.totals.inputTokens, 100); assert.equal(s.totals.outputTokens, 40);
  assert.equal(s.totals.cacheReadTokens, 500); assert.equal(s.totals.cacheWriteTokens, 50);
  near(s.totals.usd, (200 + 320 + 100 + 125) / 1_000_000);
  near(s.totals.cny, s.totals.usd * 7);
  assert.deepEqual(pricing.calls[0].usage, tokens);
});

test('compact stream fallback uses the last usage record, message usage has precedence', async t => {
  const { ledger } = await setup(t);
  const f = fixture(); f.start(); f.header();
  const event = f.message({ tokens: usage(10, 4), streamOnly: true });
  event.data.stream.unshift({ type: 'chunk', time: event.time, chunk: { type: 'usage', usage: usage(1, 1) } });
  f.end(); await ledger.ingest('stream', f.events);
  assert.equal((await ledger.summary('stream')).totals.inputTokens, 10);
  const g = complete(usage(70, 8));
  g.events.find(e => e.type === 'assistant/message').data.stream.push({ type: 'chunk', time: 0, chunk: { type: 'usage', usage: usage(999, 9) } });
  await ledger.ingest('explicit', g.events);
  assert.equal((await ledger.summary('explicit')).totals.inputTokens, 70);
});

test('same turn+step replaces, retry-started starts a new counted request', async t => {
  const { ledger } = await setup(t);
  const f = fixture(); f.start(); f.header('provider-a', 'model-a');
  f.attempt({ tokens: usage(10, 3) });
  f.attempt({ tokens: usage(12, 4) });
  f.add('llm/retry', { turn: 1, step: 1, delayMs: 1000 });
  const retryStart = f.add('llm/retry-started', { turn: 1, step: 1 });
  f.message({ provider: 'provider-a', model: 'model-a', tokens: usage(20, 6) }); f.end();
  await ledger.ingest('retry', f.events);
  const s = await ledger.summary('retry');
  assert.equal(s.records.length, 2); assert.equal(s.totals.requests, 2);
  assert.equal(s.totals.inputTokens, 32); assert.equal(s.totals.outputTokens, 10);
  assert.equal(s.records[0].provider, 'provider-a'); assert.equal(s.records[1].time, retryStart.time);
  assert.equal(s.totals.unknown, 0);
});

test('actual message route wins, unchanged request headers carry into failures and future steps', async t => {
  const { ledger } = await setup(t);
  const f = fixture(); f.start(); f.header('provider-a', 'model-a');
  f.message({ provider: 'provider-b', model: 'model-b' });
  f.add('step/end', { turn: 1, step: 1 }); f.start(1, 2);
  f.attempt({ turn: 1, step: 2 }); f.end(1, 2);
  await ledger.ingest('routes', f.events);
  const s = await ledger.summary('routes');
  assert.deepEqual(s.turns[0].models, ['model-b', 'model-a']);
  assert.equal(s.records[0].provider, 'provider-b'); assert.equal(s.records[1].provider, 'provider-a');
  near(s.records[0].quote.usd, s.records[1].quote.usd * 3);
});

test('model switch and price/FX refresh never revalue previous receipts', async t => {
  const { ledger, pricing } = await setup(t);
  const f = fixture(); f.start(); f.header(); f.message(); f.end();
  await ledger.ingest('switch', f.events);
  const first = (await ledger.summary('switch')).records[0];
  pricing.multiplier = 100; pricing.fx = 9;
  f.start(2, 1); f.header('provider-b', 'model-b'); f.message({ turn: 2, provider: 'provider-b', model: 'model-b' }); f.end(2, 1);
  await ledger.ingest('switch', f.events);
  await ledger.repriceUnknown('switch');
  const s = await ledger.summary('switch');
  assert.deepEqual(s.records[0], first);
  assert.equal(s.turns.length, 2); assert.equal(s.records[1].quote.fx.rate, 9);
  assert.equal(s.records[0].quote.fx.rate, 7);
  assert.equal(s.totals.requests, 2);
});

test('same-request usage corrections retain original unit prices and FX', async t => {
  const { ledger, pricing } = await setup(t);
  const f = fixture(); f.start(); f.header(); f.message({ tokens: usage(10, 10) });
  await ledger.ingest('replacement', f.events);
  const original = (await ledger.summary('replacement')).records[0].quote;
  pricing.multiplier = 100; pricing.fx = 10;
  f.message({ tokens: usage(20, 20) }); f.end();
  await ledger.ingest('replacement', f.events);
  const s = await ledger.summary('replacement');
  assert.equal(s.records.length, 1); near(s.records[0].quote.usd, original.usd * 2);
  assert.deepEqual(s.records[0].quote.price, original.price); assert.deepEqual(s.records[0].quote.fx, original.fx);
});

test('same-request corrections crossing an OR prompt threshold use the original tariff', async t => {
  let promptPrice = '0.000001';
  const pricing = new FakePricing();
  pricing.quote = request => quoteRequest(request, {
    openrouter: { models: [{ id: 'model-a', currency: 'USD', source: 'fixture',
      pricing: { prompt: promptPrice, completion: '0.000002', input_cache_read: '0.0000001', input_cache_write: '0.000001',
        overrides: [{ min_prompt_tokens: 100, prompt: '0.000003', completion: '0.000004' }] } }] },
    fx: { rate: 7, date: '2026-11-03', source: 'fixture' }, config: {}, now: Date.parse('2026-11-03T01:00:00Z'),
  });
  const { ledger } = await setup(t, pricing);
  const f = fixture(); f.start(); f.header(); f.message({ tokens: usage(100, 10) });
  await ledger.ingest('tier', f.events);
  promptPrice = '0.1';
  f.message({ tokens: usage(101, 10) }); f.end(); await ledger.ingest('tier', f.events);
  const s = await ledger.summary('tier');
  assert.equal(s.totals.requests, 1); assert.equal(s.records[0].quote.price.rates.input, 3);
  near(s.totals.usd, 101 * 0.000003 + 10 * 0.000004);
  assert.equal(s.records[0].quote.fx.rate, 7);
});

test('locked replacements apply a distinct reasoning tariff without counting output twice', async t => {
  const pricing = new FakePricing();
  pricing.quote = request => quoteRequest(request, { openrouter: { models: [{ id: 'model-a', currency: 'USD', source: 'fixture',
    pricing: { prompt: '0.000001', completion: '0.000008', internal_reasoning: '0.000002' } }] },
    fx: { rate: 7, date: '2026-11-03', source: 'fixture' }, config: {}, now: Date.parse('2026-11-03T01:00:00Z') });
  const { ledger } = await setup(t, pricing);
  const f = fixture(); f.start(); f.header(); f.message({ tokens: usage(10, 10, 0, 0, 6) });
  await ledger.ingest('reasoning', f.events);
  f.message({ tokens: usage(20, 20, 0, 0, 12) }); f.end();
  await ledger.ingest('reasoning', f.events);
  const s = await ledger.summary('reasoning');
  near(s.totals.usd, (20 + 8 * 8 + 12 * 2) / 1_000_000);
  assert.equal(s.totals.outputTokens, 20); assert.equal(s.totals.requests, 1);
});

test('invalid corrected usage is unknown but its original tariff survives a later valid correction', async t => {
  const { ledger, pricing } = await setup(t);
  const f = fixture(); f.start(); f.header(); f.message({ tokens: usage(10, 10) });
  await ledger.ingest('correction', f.events);
  const original = (await ledger.summary('correction')).records[0].quote;
  f.message({ tokens: { ...usage(20, 20), inputTokens: -1 } });
  await ledger.ingest('correction', f.events);
  assert.equal((await ledger.summary('correction')).totals.unknown, 1);
  pricing.multiplier = 100; pricing.fx = 99;
  f.message({ tokens: usage(20, 20) }); f.end(); await ledger.ingest('correction', f.events);
  const record = (await ledger.summary('correction')).records[0];
  assert.deepEqual(record.quote.price, original.price); assert.deepEqual(record.quote.fx, original.fx);
  near(record.quote.native, original.native * 2);
});

test('request start/retry timestamps survive peak boundaries, midnight, and restart', async t => {
  const { ledger, pricing, dataDir } = await setup(t);
  const f = fixture(); const begin = f.start(1, 1, Date.parse('2026-11-03T23:59:59+08:00')); f.header();
  f.attempt({ time: Date.parse('2026-11-04T00:01:00+08:00') });
  f.add('llm/retry', { turn: 1, step: 1 });
  const retry = f.add('llm/retry-started', { turn: 1, step: 1 }, Date.parse('2026-11-04T08:59:59+08:00'));
  await ledger.ingest('midnight', f.events);
  const reopened = new CostLedger({ dataDir, pricingService: pricing });
  f.message({ time: Date.parse('2026-11-04T09:01:00+08:00') }); f.end();
  await reopened.ingest('midnight', f.events);
  const s = await reopened.summary('midnight');
  assert.deepEqual(s.records.map(r => r.time), [begin.time, retry.time]);
  assert.deepEqual(pricing.calls.map(r => r.time), [begin.time, retry.time]);
  await reopened.dispose();
});

test('repeated and concurrent replay survives reopening without double accounting', async t => {
  const { ledger, dataDir, pricing } = await setup(t);
  const f = complete();
  const other = new CostLedger({ dataDir, pricingService: pricing });
  await Promise.all([ledger.ingest('replay', f.events), other.ingest('replay', f.events), ledger.ingest('replay', f.events)]);
  assert.equal((await other.summary('replay')).totals.requests, 1);
  const original = (await other.summary('replay')).records[0];
  await other.dispose();
  const reopened = new CostLedger({ dataDir, pricingService: pricing });
  await reopened.ingest('replay', f.events, { historical: true });
  assert.deepEqual((await reopened.summary('replay')).records[0], original);
  assert.deepEqual((await readdir(join(dataDir, 'ledger'))).filter(p => p.endsWith('.tmp')), []);
  await reopened.dispose();
});

test('fork inherited prefix supplies route context but creates no new receipts', async t => {
  const { ledger } = await setup(t);
  const f = complete(); const inheritedEventCount = f.events.length;
  f.add('session/end-seed', { inherited: true });
  f.start(2, 1); f.attempt({ turn: 2, tokens: usage(5, 2) }); f.end(2, 1);
  await ledger.ingest('fork', f.events, { inheritedEventCount, historical: true });
  const s = await ledger.summary('fork');
  assert.equal(s.totals.requests, 1); assert.equal(s.records[0].turn, 2); assert.equal(s.records[0].model, 'model-a');
  assert.equal(s.totals.inputTokens, 5); assert.match(s.warnings.join(' '), /fork/);
  assert.match(s.records[0].quote.warnings.join(' '), /历史回填/);
});

test('missing usage, missing lifecycle, and contradictory totals remain unknown rather than zero priced', async t => {
  const { ledger } = await setup(t);
  const f = fixture(); f.start(); f.header(); f.attempt({ tokens: null }); f.end();
  await ledger.ingest('missing', f.events);
  const s = await ledger.summary('missing');
  assert.equal(s.totals.requests, 1); assert.equal(s.totals.unknown, 1); assert.equal(s.totals.usd, null); assert.equal(s.records[0].usage, null);
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) assert.equal(s.totals[key], null);
  assert.match(s.warnings.join(' '), /仅合计已报告部分/);
  const g = fixture(); g.header(); g.message();
  await ledger.ingest('missing-life', g.events);
  assert.equal((await ledger.summary('missing-life')).totals.unknown, 1);
  const h = complete({ ...usage(), totalTokens: 999 }); await ledger.ingest('invalid-total', h.events);
  assert.equal((await ledger.summary('invalid-total')).totals.unknown, 1);
  const i = fixture(); i.start(); i.header(); i.end(); await ledger.ingest('no-settlement', i.events);
  assert.equal((await ledger.summary('no-settlement')).totals.unknown, 1);
});

test('explicit zero usage is priced zero, absent usage never is; cache zeros may follow an exact total', async t => {
  const { ledger } = await setup(t);
  await ledger.ingest('zero', complete(usage(0, 0)).events);
  assert.equal((await ledger.summary('zero')).totals.usd, 0);
  await ledger.ingest('optional-cache', complete({ inputTokens: 4, outputTokens: 2, totalTokens: 6 }).events);
  assert.equal((await ledger.summary('optional-cache')).totals.priced, 1);
  await ledger.ingest('incomplete', complete({ inputTokens: 4, outputTokens: 2 }).events);
  assert.equal((await ledger.summary('incomplete')).totals.unknown, 1);
});

test('unknown prices and missing FX can be filled, but existing price and FX snapshots never change', async t => {
  const { ledger, pricing } = await setup(t);
  pricing.unknown.add('model-a');
  await ledger.ingest('later', complete().events, { historical: true });
  assert.equal((await ledger.summary('later')).totals.unknown, 1);
  pricing.unknown.clear(); await ledger.repriceUnknown('later');
  assert.equal((await ledger.summary('later')).totals.priced, 1);
  pricing.fx = null;
  await ledger.ingest('fx', complete().events);
  const before = (await ledger.summary('fx')).records[0];
  assert.equal(before.quote.cny, null);
  pricing.fx = 8; await ledger.repriceUnknown();
  const after = await ledger.summary('fx');
  assert.deepEqual(after.records[0].quote.price, before.quote.price);
  assert.equal(after.records[0].quote.native, before.quote.native);
  assert.equal(after.records[0].quote.usd, before.quote.usd);
  assert.equal(after.records[0].quote.cny, before.quote.native * 8);
  assert.equal(after.totals.fxMissing, 0);
  pricing.fx = 10; pricing.multiplier = 100; await ledger.repriceUnknown();
  assert.deepEqual((await ledger.summary('fx')).records[0], after.records[0]);
});

test('totals preserve native currency buckets and sum available converted portions', () => {
  const priced = (currency, native, usd, cny) => ({ usage: usage(1, 2), quote: { status: 'priced', currency, native, usd, cny, estimated: true } });
  const totals = totalRecords([priced('USD', 1, 1, 7), priced('CNY', 14, 2, 14), priced('USD', 3, 3, null),
    { usage: null, quote: { status: 'unpriced' } }]);
  assert.deepEqual(totals, { usd: 6, cny: 21, nativeUsd: 4, nativeCny: 14, requests: 4, priced: 3, unknown: 1,
    estimated: 3, inputTokens: 3, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, fxMissing: 1 });
});

test('disk receipt allowlist excludes conversations, request credentials and provider errors', async t => {
  const { ledger } = await setup(t);
  const f = fixture(); f.start(); f.header('deepseek', 'model-a', { apiKey: 'SECRET_KEY', baseUrl: 'https://private.example/?token=SECRET' });
  f.add('user/message', { content: 'PRIVATE PROMPT', authorization: 'SECRET_BEARER' });
  f.message(); f.end(); await ledger.ingest('privacy', f.events);
  const raw = await readFile(ledger.pathFor('privacy'), 'utf8');
  for (const value of ['PRIVATE CONTENT', 'PRIVATE PROMPT', 'SECRET_KEY', 'SECRET_BEARER', 'private.example', 'content', 'apiKey']) assert.ok(!raw.includes(value), value);
  assert.deepEqual(projectEvent({ seq: 99, time: 1, type: 'user/message', data: { content: 'PRIVATE' } }), { seq: 99, time: 1, type: 'user/message' });
});

test('gapped event batches do not advance the durable cursor and complete replay repairs them', async t => {
  const { ledger } = await setup(t);
  const f = complete();
  await ledger.ingest('gap', [f.events[0], f.events[2], f.events[3]]);
  assert.equal((await ledger.summary('gap')).totals.requests, 0);
  await ledger.ingest('gap', f.events);
  assert.equal((await ledger.summary('gap')).totals.requests, 1);
});

test('corrupt or unsupported receipts are preserved instead of silently reset', async t => {
  const { ledger } = await setup(t);
  const path = ledger.pathFor('broken');
  await writeFile(path, '{broken', 'utf8');
  await assert.rejects(ledger.ingest('broken', complete().events));
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
