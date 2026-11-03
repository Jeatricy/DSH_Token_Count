import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenRouter, parseDeepSeek, matchModel, normalizeModel } from '../src/catalog.js';
import { selectScheduledRates, selectOpenRouterRates, quoteRequest, normalizeUsage, cacheUsageWarnings, withCurrentCacheWarnings } from '../src/price-engine.js';
import { PricingService, parseFx, parseHolidayCalendar, FX_URL, FX_FALLBACK_URL } from '../src/pricing-service.js';
const json = async name => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const openrouter = await json('openrouter');
const deepseek = await json('deepseek');
const holidays = await json('holidays-cn');
const fx = { rate: 7, date: '2026-11-03', source: 'test' };
const time = Date.parse('2026-11-03T10:00:00+08:00');
const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0, reasoningTokens: 50_000, totalTokens: 3_100_000 };
const ctx = { openrouter, deepseek, holidays, fx, now: time };
const request = (model, extra = {}) => ({ provider: 'example-provider', model, time, usage, ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('cache explanation identifies only the missing bucket and acknowledges total reconciliation', () => {
  const cached = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 8000, totalTokens: 9100 };
  const notes = cacheUsageWarnings(cached);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /未单独报告缓存写入/);
  assert.match(notes[0], /总 Token 对齐/);
  assert.match(notes[0], /缓存读取仍正常计费/);
  assert.doesNotMatch(notes[0], /按 0 估算|未单独报告缓存读取/);
  assert.deepEqual(cacheUsageWarnings({ ...cached, cacheWriteTokens: 0 }), []);
  assert.match(cacheUsageWarnings({ inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 200, totalTokens: 1300 })[0], /未单独报告缓存读取/);
  assert.match(cacheUsageWarnings({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100 })[0], /缓存读取、缓存写入/);
  assert.match(cacheUsageWarnings({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 8000 })[0], /缓存写入.*暂按 0 估算/);
  const q = quoteRequest(request('gpt-6-astra', { usage: cached }), ctx);
  near(q.native, .023);
});

test('old cache explanations can be refreshed without changing immutable receipt amounts', () => {
  const quote = { status: 'priced', native: 1.25, usd: 1.25, cny: 8.75, currency: 'USD', price: { rates: { input: 2 } }, fx: { rate: 7 }, warnings: ['未报告的缓存分项按 0 估算', '保留的其他提示'] };
  const before = structuredClone(quote);
  const updated = withCurrentCacheWarnings(quote, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, totalTokens: 115 });
  assert.deepEqual(quote, before);
  assert.deepEqual({ ...updated, warnings: [] }, { ...quote, warnings: [] });
  assert.ok(updated.warnings.includes('保留的其他提示'));
  assert.ok(!updated.warnings.includes('未报告的缓存分项按 0 估算'));
  assert.match(updated.warnings.at(-1), /缓存写入/);
});

test('all 685 captured listings retained, zero and dynamic prices distinguished', () => {
  assert.equal(openrouter.models.length, 685);
  const zero = quoteRequest(request('openrouter/free'), ctx);
  assert.equal(zero.status, 'priced'); assert.equal(zero.native, 0);
  assert.equal(quoteRequest(request('openrouter/auto'), ctx).status, 'unpriced');
});
test('normalizes display names without losing numerical versions', () => {
  assert.equal(normalizeModel('OpenAI: GPT-6 Astra'), 'gpt-6-astra');
  assert.equal(matchModel('gpt-6-astra', openrouter.models).model.id, 'openai/gpt-6-astra');
  assert.equal(matchModel('gpt-6.1-terra', openrouter.models).model.id, 'openai/gpt-6.1-terra');
});
test('fuzzy typo guarded from versions, model size, free and batch variants', () => {
  const models = [{ id: 'openai/gpt-6-astra' }, { id: 'openai/gpt-6-astra-pro' }];
  assert.equal(matchModel('gpt-6-asttra', models).match, 'fuzzy');
  for (const name of ['gpt-7-astra', 'gpt-6-astra-mini', 'gpt-6-astra:free', 'gpt-6-astra:batch']) assert.equal(matchModel(name, models), null);
});
test('ambiguous aliases fail closed and explicit mapping selects a price', () => {
  const models = [{ id: 'a/model-1' }, { id: 'b/model-1' }];
  assert.equal(matchModel('model-1', models), null);
  assert.equal(matchModel('private-name', models, { 'private-name': 'a/model-1' }).model.id, 'a/model-1');
});
test('OpenRouter exact snapshots stay distinct', () => {
  const legacy = matchModel('deepseek-v4.1-flash', openrouter.models);
  const current = matchModel('deepseek-v4.1-flash-1017', openrouter.models);
  assert.notEqual(legacy.model.id, current.model.id);
  assert.notEqual(legacy.model.pricing.prompt, current.model.pricing.prompt);
});
test('USD costs include cache once, output already includes reasoning', () => {
  // 3M prompt is over the long-context threshold: $20/M uncached, $2/M cache, $75/M output.
  const q = quoteRequest(request('gpt-6-astra'), ctx);
  assert.equal(q.currency, 'USD'); near(q.native, 31.5); near(q.usd, 31.5); near(q.cny, 220.5);
});
test('native DeepSeek RMB price has priority and converts to USD', () => {
  const q = quoteRequest(request('deepseek-flash', { provider: 'deepseek' }), ctx);
  assert.equal(q.currency, 'CNY'); near(q.native, 2.88); near(q.cny, 2.88); near(q.usd, 2.88 / 7);
  assert.equal(q.price.period, '高峰');
});
test('official old routing aliases follow the current documented tariff', () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'DeepSeek-V4.1-Flash-1017']) {
    const q = quoteRequest(request(model), ctx);
    assert.equal(q.matchedModel, 'deepseek-flash'); near(q.native, 2.88);
  }
});
test('explicit OpenRouter route uses USD catalog rather than Chinese official price', () => {
  const q = quoteRequest(request('deepseek/deepseek-v4.1-flash-1017', { provider: 'openrouter' }), ctx);
  assert.equal(q.currency, 'USD'); near(q.native, .432);
});
test('peak/offpeak boundaries are half-open in Beijing, unrelated to machine TZ', () => {
  const entry = deepseek.models.find(m => m.id === 'deepseek-flash');
  for (const [clock, period] of [['08:59:59', '闲时'], ['09:00:00', '高峰'], ['11:59:59', '高峰'], ['12:00:00', '闲时'], ['14:00:00', '高峰'], ['17:59:59', '高峰'], ['18:00:00', '闲时']]) {
    assert.equal(selectScheduledRates(entry, Date.parse(`2026-11-03T${clock}+08:00`), holidays).period, period);
  }
});
test('Chinese holidays and weekend make official pricing offpeak, including makeup weekends', () => {
  const entry = deepseek.models[0];
  for (const date of ['2026-10-01', '2026-11-07', '2026-10-10']) assert.equal(selectScheduledRates(entry, Date.parse(`${date}T10:00:00+08:00`), holidays).period, '闲时');
  assert.ok(selectScheduledRates(entry, Date.parse('2028-11-03T10:00:00+08:00'), holidays).warnings.length);
});
test('OpenRouter threshold strictly greater, overrides inherit and later keys win', () => {
  const entry = { pricing: { prompt: '.000001', completion: '.000005', overrides: [{ min_prompt_tokens: 100, prompt: '.000002' }, { min_prompt_tokens: 200, prompt: '.000003' }] } };
  assert.equal(selectOpenRouterRates(entry, time, 100).rates.input, 1);
  assert.equal(selectOpenRouterRates(entry, time, 101).rates.input, 2);
  assert.equal(selectOpenRouterRates(entry, time, 201).rates.input, 3);
  assert.equal(selectOpenRouterRates(entry, time, 201).rates.output, 5);
});
test('OpenRouter UTC time conditions combine with token conditions and wrap midnight', () => {
  const entry = { pricing: { prompt: '.000001', completion: '.000005', overrides: [{ min_prompt_tokens: 10, utc_days: ['tuesday'], utc_start: 2330, utc_end: 130, prompt: '.000002' }] } };
  assert.equal(selectOpenRouterRates(entry, Date.parse('2026-11-03T23:45:00Z'), 11).rates.input, 2);
  assert.equal(selectOpenRouterRates(entry, Date.parse('2026-11-03T01:30:00Z'), 11).rates.input, 1);
  assert.equal(selectOpenRouterRates(entry, Date.parse('2026-11-03T23:45:00Z'), 10).rates.input, 1);
});
test('invalid usage is unpriced, never silently free', () => {
  for (const bad of [undefined, {}, { ...usage, inputTokens: -1 }, { ...usage, totalTokens: 42 }, { ...usage, reasoningTokens: 200_000 }]) {
    assert.equal(quoteRequest(request('gpt-6-astra', { usage: bad }), ctx).status, 'unpriced');
  }
});
test('optional cache absence explicit; contradictory missing buckets are unpriced', () => {
  assert.ok(normalizeUsage({ inputTokens: 100, outputTokens: 10 }).warnings.length);
  assert.throws(() => normalizeUsage({ inputTokens: 100, outputTokens: 10, totalTokens: 160 }));
});
test('provider-scoped custom CNY prices and schedules override catalog', () => {
  const config = { overrides: [{ provider: 'example-provider', model: 'gpt-6-astra', currency: 'CNY', rates: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1 } }] };
  const q = quoteRequest(request('gpt-6-astra'), { ...ctx, config });
  assert.equal(q.match, 'override'); near(q.native, 1.4);
  assert.equal(quoteRequest(request('gpt-6-astra', { provider: 'other' }), { ...ctx, config }).currency, 'USD');
});
test('missing/stale FX preserves original currency and clearly flags conversion', () => {
  const q = quoteRequest(request('deepseek-flash'), { ...ctx, fx: null });
  assert.equal(q.usd, null); near(q.cny, 2.88); assert.ok(q.warnings.some(w => w.includes('汇率不可用')));
  const old = quoteRequest(request('deepseek-flash'), { ...ctx, fx: { ...fx, date: '2026-11-02' } });
  assert.equal(old.fx.stale, true);
});
test('parser rejects missing/negative core prices and changed official table instead of inventing zeros', () => {
  const parsed = parseOpenRouter({ data: [{ id: 'bad', pricing: { prompt: '-1', completion: '0' } }] });
  assert.equal(quoteRequest(request('bad'), { ...ctx, openrouter: parsed }).status, 'unpriced');
  assert.throws(() => parseDeepSeek('| unexpected |'));
  assert.throws(() => parseOpenRouter({ data: [] }));
});
test('daily FX parsers honor data dates and reject invalid currencies', () => {
  assert.equal(parseFx([{ date: '2026-11-03', base: 'USD', quote: 'CNY', rate: 6.6492 }]).rate, 6.6492);
  assert.throws(() => parseFx([{ date: '2026-11-03', base: 'EUR', quote: 'CNY', rate: 7 }]));
});
test('service refresh persists snapshots, coalesces requests and retains offline estimates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-pricing-'));
  let now = Date.parse('2026-11-04T10:00:00+08:00');
  let calls = 0;
  const service = new PricingService({ dataDir: dir, now: () => now, fetch: async url => {
    calls++;
    if (url === FX_URL) return new Response(JSON.stringify([{ date: '2026-11-04', base: 'USD', quote: 'CNY', rate: 6.7 }]));
    throw new Error('offline fixture');
  } });
  await service.initialize();
  assert.equal(service.getStatus().fx.rate, 6.7);
  assert.equal(service.getStatus().pricing.modelCount, 685);
  assert.ok(service.getStatus().warnings.some(w => w.includes('快照')));
  const before = calls;
  await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
  assert.equal(calls, before);
  const first = service.quote(request('gpt-6-astra', { time: now }));
  now += 24 * 3600_000;
  assert.equal(first.fx.date, '2026-11-04', 'a quoted snapshot does not mutate across dates');
  assert.equal(service.quote(request('gpt-6-astra', { time: Date.parse('2026-11-04T10:00:00+08:00') })).fx.rate, 6.7);
  await service.dispose();
});

test('separately priced reasoning is a subset of output, not an extra bucket', () => {
  const q = quoteRequest(request('perplexity/sonar-deep-research', { usage: { inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100_000 } }), ctx);
  assert.equal(q.status, 'priced'); near(q.native, 2.55);
  assert.equal(q.price.rates.reasoning, 3);
});
test('image-only output is unpriced when image charge counters are unavailable', () => {
  const model = openrouter.models.find(m => m.outputModalities?.length === 1 && m.outputModalities[0] === 'image');
  assert.ok(model); assert.equal(quoteRequest(request(model.id), ctx).status, 'unpriced');
});
test('holiday feed requires real announced dates and preserves adjacent-year holidays', () => {
  assert.throws(() => parseHolidayCalendar({ year: 2027, papers: [], days: [] }, 2027));
  assert.throws(() => parseHolidayCalendar({ year: 2027, papers: ['https://www.gov.cn/test'], days: [{ isOffDay: true, date: '2027-02-30' }] }, 2027));
  const calendar = parseHolidayCalendar({ year: 2027, papers: ['https://www.gov.cn/test'], days: [{ isOffDay: true, date: '2027-01-01' }, { isOffDay: true, date: '2026-12-31' }, { isOffDay: false, date: '2027-01-02' }] }, 2027);
  assert.deepEqual(calendar.dates, ['2026-12-31', '2027-01-01']);
});
test('model sync follows same-origin pagination and refuses incomplete catalogs', async () => {
  let calls = 0;
  const service = new PricingService({ dataDir: '.', fetch: async url => { calls++; return new Response(JSON.stringify(url.includes('cursor=2') ? { data: [{ id: 'two' }], links: { next: null } } : { data: [{ id: 'one' }], total_count: 2, links: { next: '?cursor=2&output_modalities=all' } })); } });
  assert.equal((await service.retrieveModels()).data.length, 2); assert.equal(calls, 2);
  service.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'one' }], total_count: 2 }));
  await assert.rejects(service.retrieveModels(), /不完整/);
});
test('stale primary FX tries the secondary and picks the fresher publication', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-cost-fx-'));
  const now = () => Date.parse('2026-11-04T10:00:00+08:00');
  const service = new PricingService({ dataDir, now, fetch: async url => {
    if (url === FX_URL) return new Response(JSON.stringify([{ date: '2026-11-03', base: 'USD', quote: 'CNY', rate: 6.6 }]));
    if (url === FX_FALLBACK_URL) return new Response(JSON.stringify({ result: 'success', base_code: 'USD', rates: { CNY: 6.7 }, time_last_update_unix: Date.parse('2026-11-04T00:01:00Z') / 1000 }));
    throw new Error('offline fixture');
  } });
  await service.initialize(); assert.equal(service.getStatus().fx.date, '2026-11-04'); near(service.getStatus().fx.rate, 6.7); await service.dispose();
});
