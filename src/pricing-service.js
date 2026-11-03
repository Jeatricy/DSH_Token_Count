import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseOpenRouter, parseDeepSeek, OPENROUTER_URL, DEEPSEEK_URL } from './catalog.js';
import { quoteRequest, dateInZone } from './price-engine.js';

export const FX_URL = 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY';
export const FX_FALLBACK_URL = 'https://open.er-api.com/v6/latest/USD';
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
export async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export function parseFx(payload, fetchedAt = new Date().toISOString()) {
  const pair = Array.isArray(payload) ? payload.find(p => p.base === 'USD' && p.quote === 'CNY') : null;
  if (pair && /^\d{4}-\d{2}-\d{2}$/.test(pair.date) && Number.isFinite(pair.rate) && pair.rate > 0) {
    return { rate: pair.rate, date: pair.date, fetchedAt, source: 'Frankfurter（每日参考价）', sourceUrl: FX_URL, stale: false };
  }
  if (payload?.result === 'success' && payload.base_code === 'USD' && Number(payload.rates?.CNY) > 0) {
    const publishedAt = new Date(payload.time_last_update_unix * 1000).toISOString();
    return { rate: Number(payload.rates.CNY), date: publishedAt.slice(0, 10), publishedAt, fetchedAt,
      source: 'ExchangeRate-API', sourceUrl: FX_FALLBACK_URL, attributionUrl: 'https://www.exchangerate-api.com', stale: false };
  }
  throw new Error('汇率响应格式无效');
}

export function parseHolidayCalendar(payload, year, fetchedAt = new Date().toISOString()) {
  if (payload?.year !== Number(year) || !Array.isArray(payload.papers) || !payload.papers.length || !Array.isArray(payload.days)) throw new Error('本年度放假安排尚未公布或数据无效');
  const papers = payload.papers.filter(url => {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && (parsed.hostname === 'gov.cn' || parsed.hostname.endsWith('.gov.cn')); } catch { return false; }
  });
  if (!papers.length) throw new Error('节假日日历缺少政府公告来源');
  const days = payload.days.filter(day => day.isOffDay === true).map(day => day.date);
  if (!days.length || days.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('节假日日历缺少有效放假日期');
  const dates = [...new Set(days)].sort();
  if (!dates.some(date => date.startsWith(`${year}-`))) throw new Error('节假日日历未包含目标年份的放假日期');
  return { sourceUrl: papers[0], papers, verifiedAt: fetchedAt, thirdParty: true, dates };
}

/** No prompts, model names, account keys or usage are sent to the public sources. */
export class PricingService {
  constructor({ dataDir, config = {}, fetch: fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.dataDir = dataDir; this.config = config; this.fetch = fetchImpl; this.now = now;
    this.catalogs = {}; this.fxHistory = {}; this.holidays = { years: {} }; this.warnings = [];
    this.lastAttempt = 0; this.inFlight = null; this.closed = false;
  }
  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    for (const name of ['openrouter', 'deepseek']) {
      let seed;
      try { seed = await readJson(new URL(`../data/${name}.json`, import.meta.url)); } catch { /* no seed */ }
      let cache;
      try { cache = await readJson(join(this.dataDir, `${name}.json`)); } catch { /* offline seed */ }
      this.catalogs[name] = cache?.version === 1 && Array.isArray(cache.models) && cache.models.length ? cache : seed;
    }
    try { this.holidays = await readJson(new URL('../data/holidays-cn.json', import.meta.url)); } catch { /* warning is tariff-specific */ }
    try { const cached = await readJson(join(this.dataDir, 'holidays-cn.json')); this.holidays.years = { ...cached.years, ...this.holidays.years }; } catch { /* bundled calendar */ }
    if (this.config.holidays?.years) this.holidays.years = { ...this.holidays.years, ...this.config.holidays.years };
    try { this.fxHistory = await readJson(join(this.dataDir, 'fx-history.json')); } catch {
      try { const seed = await readJson(new URL('../data/fx.json', import.meta.url)); this.fxHistory[seed.date] = seed; } catch { /* no invented fixed rate */ }
    }
    this.fx = Object.values(this.fxHistory).filter(value => value?.rate > 0).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
    // Caller can render the bundled snapshot immediately. Refresh has its own
    // catch boundary and never interferes with model requests.
    await this.refresh(false);
    return this;
  }
  async retrieve(url, kind = 'json') {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      headers: { Accept: kind === 'json' ? 'application/json' : 'text/markdown', 'User-Agent': 'dsh-token-cost/1.0 (public pricing sync)' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 12_000_000) throw new Error('价格响应过大');
    return kind === 'json' ? JSON.parse(text) : text;
  }
  async retrieveModels() {
    const all = [];
    let url = OPENROUTER_URL;
    const visited = new Set();
    let total;
    while (url) {
      const parsed = new URL(url, OPENROUTER_URL);
      if (parsed.origin !== 'https://openrouter.ai' || parsed.pathname !== '/api/v1/models' || visited.has(parsed.href) || visited.size >= 50) throw new Error('OpenRouter 分页地址无效');
      visited.add(parsed.href);
      const page = await this.retrieve(parsed.href);
      if (!Array.isArray(page.data)) throw new Error('OpenRouter 模型分页无效');
      all.push(...page.data);
      total ??= page.total_count;
      url = page.links?.next ?? null;
      if (url !== null && typeof url !== 'string') throw new Error('OpenRouter 分页格式已改变');
    }
    const data = [...new Map(all.map(model => [model.id, model])).values()];
    if (Number.isInteger(total) && data.length < total) throw new Error('OpenRouter 返回的模型目录不完整');
    return { data };
  }
  refresh(force = false) {
    if (this.closed) return Promise.resolve(this.getStatus());
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    const day = dateInZone(now).date;
    const needsPrice = ['openrouter', 'deepseek'].some(key => !this.catalogs[key]?.fetchedAt || dateInZone(Date.parse(this.catalogs[key].fetchedAt)).date !== day);
    const needsFx = this.fx?.date !== day;
    const needsCalendar = !this.holidays.years?.[dateInZone(now).year];
    if (!force && !needsPrice && !needsFx && !needsCalendar) return Promise.resolve(this.getStatus());
    if (now - this.lastAttempt < (force ? 30_000 : 3600_000)) return Promise.resolve(this.getStatus());
    this.lastAttempt = now;
    this.inFlight = this.performRefresh(needsPrice || force, needsFx || force).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async performRefresh(prices, fx) {
    const warnings = [];
    const tasks = [];
    const fetchedAt = new Date(this.now()).toISOString();
    if (prices) for (const [name, url, parser, kind] of [
      ['openrouter', OPENROUTER_URL, parseOpenRouter, 'json'],
      ['deepseek', DEEPSEEK_URL, parseDeepSeek, 'text'],
    ]) tasks.push((async () => {
      try {
        const catalog = parser(name === 'openrouter' ? await this.retrieveModels() : await this.retrieve(url, kind), fetchedAt);
        await atomicJson(join(this.dataDir, `${name}.json`), catalog);
        this.catalogs[name] = catalog;
      } catch (error) { warnings.push(`${name} 价格同步失败，使用上次快照：${error.message}`); }
    })());
    if (fx) tasks.push((async () => {
      let value;
      let lastError;
      const today = dateInZone(this.now()).date;
      for (const url of [FX_URL, FX_FALLBACK_URL]) {
        try {
          const candidate = parseFx(await this.retrieve(url), fetchedAt);
          if (!value || candidate.date > value.date) value = candidate;
          if (value.date >= today) break;
        } catch (error) { lastError = error; }
      }
      if (!value) warnings.push(`汇率同步失败，使用已缓存汇率：${lastError?.message ?? '未返回有效汇率'}`);
      if (value) {
        const history = { ...this.fxHistory, [value.date]: value };
        try { await atomicJson(join(this.dataDir, 'fx-history.json'), history); this.fxHistory = history; this.fx = value; }
        catch (error) { warnings.push(`汇率保存失败：${error.message}`); }
      }
    })());
    const year = Number(dateInZone(this.now()).year);
    const calendarYears = [year, ...(dateInZone(this.now()).date.slice(5, 7) >= '11' ? [year + 1] : [])];
    for (const calendarYear of calendarYears) if (!this.holidays.years?.[calendarYear]) tasks.push((async () => {
      try {
        const url = `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${calendarYear}.json`;
        const calendar = parseHolidayCalendar(await this.retrieve(url), calendarYear, fetchedAt);
        const next = { ...this.holidays, years: { ...this.holidays.years, [calendarYear]: { ...calendar, feedUrl: url } } };
        this.holidays = next;
      } catch (error) { if (calendarYear === year) warnings.push(`${year} 节假日日历暂不可用：${error.message}`); }
    })());
    await Promise.all(tasks);
    try { await atomicJson(join(this.dataDir, 'holidays-cn.json'), this.holidays); } catch (error) { warnings.push(`日历缓存保存失败：${error.message}`); }
    this.warnings = warnings;
    return this.getStatus();
  }
  getFx(time) {
    const day = Number.isFinite(time) ? dateInZone(time).date : '';
    const fx = this.fxHistory[day] ?? this.fx;
    return fx ? { ...fx, stale: fx.date !== day } : null;
  }
  quote(request) {
    const fx = this.getFx(request.time);
    return quoteRequest(request, { ...this.catalogs, holidays: this.holidays, fx, config: this.config, now: this.now() });
  }
  getStatus() {
    const now = this.now();
    return { pricing: { fetchedAt: this.catalogs.openrouter?.fetchedAt ?? null, modelCount: this.catalogs.openrouter?.models?.length ?? 0,
      source: OPENROUTER_URL, officialFetchedAt: this.catalogs.deepseek?.fetchedAt ?? null,
      stale: !this.catalogs.openrouter?.fetchedAt || now - Date.parse(this.catalogs.openrouter.fetchedAt) > 36 * 3600_000 },
    fx: this.fx ? { ...this.fx, stale: this.fx.date !== dateInZone(now).date } : { rate: null, date: null, source: null, stale: true },
    warnings: [...this.warnings, '公共价目估算；不含套餐、渠道加价、税费及未报告的搜索/图片/音频等额外费用。'] };
  }
  async dispose() { this.closed = true; await this.inFlight; }
}
