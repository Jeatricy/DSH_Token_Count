import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { calculateNative, selectOpenRouterRates, withCurrentCacheWarnings } from './price-engine.js';

const VERSION = 1;
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const COUNT_FIELDS = TOKEN_FIELDS.slice(0, 4);
const HISTORY_WARNING = '历史回填按当前可用价格及参考汇率估算，未验证当时实际扣款。';
const PUBLIC_WARNING = '所有金额均为公共价目估算，不等于账户实际扣款。';
const MISSING_USAGE = '请求未报告可用 Token 用量；费用未计价，合计可能不完整。';
const LIFECYCLE_WARNING = '请求生命周期不完整；不能确认完整消费，费用未计价。';
const count = value => Number.isSafeInteger(value) && value >= 0;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const copy = value => structuredClone(value);
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
const samePosition = (slot, data) => slot?.turn === data.turn && slot?.step === data.step;
const safeRoute = source => typeof source?.provider === 'string' && source.provider.length > 0
  && typeof source.model === 'string' && source.model.length > 0
  ? { provider: source.provider, model: source.model } : null;

/** Retain only usage and route metadata before crossing an async boundary. */
export function projectEvent(event) {
  if (!event || !count(event.seq) || typeof event.type !== 'string') return null;
  const data = event.data ?? {};
  const result = { seq: event.seq, type: event.type, time: Number.isSafeInteger(event.time) ? event.time : null };
  if (count(data.turn)) result.turn = data.turn;
  if (count(data.step)) result.step = data.step;
  if (event.type === 'request/header') result.route = safeRoute(data.header?.config);
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    result.route = event.type === 'assistant/message' ? safeRoute(data.message?.source) : null;
    let sample = event.type === 'assistant/message' ? data.usage : undefined;
    if (sample === undefined && Array.isArray(data.stream)) {
      for (let index = data.stream.length - 1; index >= 0; index -= 1) {
        const record = data.stream[index];
        if (record?.type === 'chunk' && record.chunk?.type === 'usage') {
          sample = record.chunk.usage;
          break;
        }
      }
    }
    if (sample !== undefined) result.usage = sanitizeUsage(sample);
  }
  return result;
}

export function sanitizeUsage(sample) {
  if (!sample || !count(sample.inputTokens) || !count(sample.outputTokens)) return null;
  const result = {};
  for (const field of TOKEN_FIELDS) {
    if (sample[field] !== undefined) {
      if (!count(sample[field])) return null;
      result[field] = sample[field];
    }
  }
  return result;
}

function usageProblem(usage) {
  if (!usage) return MISSING_USAGE;
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens) return '推理 Token 超出输出 Token，用量无效。';
  const total = COUNT_FIELDS.reduce((sum, key) => sum + (usage[key] ?? 0), 0);
  if (!count(total)) return 'Token 总量超出安全整数范围。';
  if (usage.totalTokens !== undefined && usage.totalTokens !== total) return '总 Token 数与输入、输出和缓存分项不一致，无法完整计价。';
  if (usage.totalTokens === undefined && (usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined)) {
    return '总 Token 数和缓存分项均不完整，无法确认完整用量。';
  }
  return null;
}

function unpriced(warnings) {
  return { status: 'unpriced', currency: null, native: null, usd: null, cny: null, estimated: true,
    matchedModel: null, match: 'none', price: null, fx: null, warnings: unique(warnings) };
}

/** Replacements change quantities, never the unit prices/FX selected for a receipt. */
function quoteAtLockedPrice(previous, usage, time) {
  let rates = previous.price?.rates;
  if (!rates || previous.price.unit !== 'per-million-tokens') return null;
  try {
    const selected = previous.price.tariff?.pricing
      ? selectOpenRouterRates(previous.price.tariff, time,
        usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
      : { rates, period: previous.price.period, applied: previous.price.applied, warnings: [] };
    const calculated = calculateNative({ ...usage, cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0 }, selected.rates);
    const native = calculated.native;
    const fx = previous.fx?.rate > 0 && Number.isFinite(previous.fx.rate) ? previous.fx.rate : null;
    return { ...copy(previous), native,
      price: { ...copy(previous.price), rates: calculated.rates, period: selected.period, applied: selected.applied ?? [] },
      warnings: unique([...previous.warnings, ...selected.warnings, ...calculated.warnings]),
      usd: previous.currency === 'USD' ? native : fx ? native / fx : null,
      cny: previous.currency === 'CNY' ? native : fx ? native * fx : null };
  } catch { return null; }
}

function fillMissingFx(quote, time, pricingService) {
  if (quote?.status !== 'priced' || !money(quote.native) || (money(quote.usd) && money(quote.cny))
    || (Number.isFinite(quote.fx?.rate) && quote.fx.rate > 0)) return quote;
  let fx;
  try { fx = pricingService.getFx?.(time); } catch { return quote; }
  if (!Number.isFinite(fx?.rate) || fx.rate <= 0 || !['USD', 'CNY'].includes(quote.currency)) return quote;
  return { ...copy(quote),
    usd: money(quote.usd) ? quote.usd : quote.currency === 'USD' ? quote.native : quote.native / fx.rate,
    cny: money(quote.cny) ? quote.cny : quote.currency === 'CNY' ? quote.native : quote.native * fx.rate,
    fx: copy(fx), warnings: unique([...(quote.warnings ?? []).filter(warning => !warning.startsWith('汇率不可用')),
      '原币价格保持锁定；缺失换算按补录的参考汇率估算。',
      ...(fx.stale ? [`使用 ${fx.date} 参考汇率，非调用当天汇率`] : [])]) };
}

function emptyState(sessionId, inheritedEventCount) {
  return { version: VERSION, sessionId, cursor: -1, inheritedEventCount, route: null,
    currentTurn: null, active: null, last: null, records: [], turnWarnings: {}, warnings: [] };
}

export function emptyTotals() {
  return { usd: null, cny: null, nativeUsd: null, nativeCny: null, requests: 0, priced: 0,
    unknown: 0, estimated: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, fxMissing: 0 };
}

function tokenValue(record, field) {
  const usage = record.usage;
  if (count(usage?.[field])) return usage[field];
  if ((field === 'cacheReadTokens' || field === 'cacheWriteTokens') && count(usage?.totalTokens)
    && usage.totalTokens === COUNT_FIELDS.reduce((sum, key) => sum + (usage[key] ?? 0), 0)) return 0;
  return null;
}

export function totalRecords(records) {
  const totals = emptyTotals();
  const observed = Object.fromEntries(COUNT_FIELDS.map(field => [field, false]));
  const add = (key, value) => { if (money(value)) totals[key] = (totals[key] ?? 0) + value; };
  for (const record of records) {
    totals.requests += 1;
    for (const field of COUNT_FIELDS) {
      const value = tokenValue(record, field);
      if (value !== null) { totals[field] += value; observed[field] = true; }
    }
    const quote = record.quote;
    if (quote?.status !== 'priced' || !money(quote.native)) { totals.unknown += 1; continue; }
    totals.priced += 1;
    if (quote.estimated) totals.estimated += 1;
    add('usd', quote.usd); add('cny', quote.cny);
    if (quote.currency === 'USD') add('nativeUsd', quote.native);
    if (quote.currency === 'CNY') add('nativeCny', quote.native);
    if (!money(quote.usd) || !money(quote.cny)) totals.fxMissing += 1;
  }
  for (const field of COUNT_FIELDS) if (records.length && !observed[field]) totals[field] = null;
  return totals;
}

// In-process serializers cover all ledger instances importing this module. Each
// operation reloads its file under the serializer, preventing stale-cache writes.
// Separate DSH processes should use separate dataDir values.
const writerQueues = new Map();
function serialize(directory, operation) {
  const previous = writerQueues.get(directory) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  const settled = task.catch(() => {});
  writerQueues.set(directory, settled);
  settled.then(() => { if (writerQueues.get(directory) === settled) writerQueues.delete(directory); });
  return task;
}

/** Independent, atomic, content-free cost receipts; never writes a DSH session. */
export class CostLedger {
  constructor({ dataDir, pricingService }) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
    this.directory = join(resolve(dataDir), 'ledger');
    this.pricingService = pricingService;
    this.ready = null;
    this.tail = Promise.resolve();
    this.closed = false;
  }
  initialize() {
    this.ready ??= mkdir(this.directory, { recursive: true }).then(() => this).catch(error => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }
  pathFor(sessionId) {
    return join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  }
  _run(operation) {
    if (this.closed) return Promise.reject(new Error('Cost ledger is closed'));
    const task = serialize(this.directory, async () => { await this.initialize(); return operation(); });
    this.tail = task.catch(() => {});
    return task;
  }
  async _load(sessionId, inheritedEventCount = 0) {
    try {
      const state = JSON.parse(await readFile(this.pathFor(sessionId), 'utf8'));
      if (state.version !== VERSION || state.sessionId !== sessionId || !Number.isSafeInteger(state.cursor)
        || !Array.isArray(state.records) || !state.turnWarnings || !Array.isArray(state.warnings)) {
        throw new Error('Unsupported or invalid cost ledger; existing file was preserved');
      }
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return emptyState(sessionId, inheritedEventCount);
    }
  }
  async _save(state) {
    const path = this.pathFor(state.sessionId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      // Only the exact temporary path generated above is eligible for cleanup.
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  _turnWarning(state, turn, warning) {
    if (!count(turn)) { state.warnings = unique([...state.warnings, warning]); return; }
    state.turnWarnings[turn] = unique([...(state.turnWarnings[turn] ?? []), warning]);
  }
  _quote(record, previous) {
    const warnings = [...(record.historical ? [HISTORY_WARNING] : [])];
    const problem = usageProblem(record.usage);
    if (problem) warnings.push(problem);
    if (!record.lifecycleOk) warnings.push(LIFECYCLE_WARNING);
    if (!record.provider || !record.model) warnings.push('实际 provider/model 缺失，未用当前模型替代历史路由。');
    if (!Number.isSafeInteger(record.time)) warnings.push('请求发生时间缺失，无法选择分时价格。');
    if (problem || !record.lifecycleOk || !record.provider || !record.model || !Number.isSafeInteger(record.time)) return unpriced(warnings);
    let quote;
    const locked = previous?.quote?.status === 'priced' ? previous.quote : previous?.lockedQuote;
    if (locked?.status === 'priced' && previous.provider === record.provider && previous.model === record.model) {
      if (previous.quote.status === 'priced' && JSON.stringify(previous.usage) === JSON.stringify(record.usage)) return copy(previous.quote);
      quote = quoteAtLockedPrice(locked, record.usage, record.time);
      if (!quote) return unpriced([...warnings, '已锁定价目无法计算修正后的用量；保留原快照待检查。']);
    } else {
      try { quote = this.pricingService.quote({ provider: record.provider, model: record.model, time: record.time, usage: copy(record.usage) }); }
      catch { return unpriced([...warnings, '价格服务暂不可用；用量已保留，费用未计价。']); }
    }
    if (!quote || !['priced', 'unpriced'].includes(quote.status)) return unpriced([...warnings, '价格服务未返回有效报价。']);
    return { ...copy(quote), estimated: true, warnings: unique([...(quote.warnings ?? []), ...warnings]) };
  }
  _settle(state, slot, event) {
    const index = state.records.findIndex(record => record.id === slot.id);
    const previous = index >= 0 ? state.records[index] : null;
    // A settlement without a new usage sample must not erase an earlier sample
    // for the same projection slot (token-meter uses the same rule).
    const usage = event && Object.hasOwn(event, 'usage') ? event.usage : previous?.usage ?? null;
    const route = event?.route ?? (previous?.provider && previous?.model ? previous : slot.route);
    const record = { id: slot.id, turn: slot.turn, step: slot.step, provider: route?.provider ?? null,
      model: route?.model ?? null, time: slot.time, usage, historical: slot.historical,
      lifecycleOk: slot.valid, quote: null };
    record.quote = this._quote(record, previous);
    if (record.quote.status !== 'priced' && previous?.provider === record.provider && previous?.model === record.model) {
      const locked = previous.quote.status === 'priced' ? previous.quote : previous.lockedQuote;
      if (locked) record.lockedQuote = copy(locked);
    }
    if (index < 0) state.records.push(record); else state.records[index] = record;
    slot.settled = true;
    state.last = { id: slot.id, turn: slot.turn, step: slot.step };
    return record;
  }
  _begin(state, event, historical, valid) {
    state.active = { id: `${state.sessionId}:${event.seq}`, turn: event.turn, step: event.step,
      time: event.time, route: copy(state.route), historical, valid, settled: false, retry: false };
    state.last = null;
    if (!valid) this._turnWarning(state, event.turn, LIFECYCLE_WARNING);
  }
  _fold(state, event, historical) {
    const { type, turn, step } = event;
    if (type === 'request/header') {
      state.route = event.route;
      if (state.active && !state.active.settled) state.active.route = copy(event.route);
      return;
    }
    if (event.seq < state.inheritedEventCount) return;
    if (type === 'turn/start' && count(turn)) {
      if (state.active) {
        if (!state.active.settled) this._settle(state, state.active);
        this._turnWarning(state, state.active.turn, '缺少 step/end 或 turn/end，上一轮生命周期不完整。');
      }
      state.active = null; state.last = null; state.currentTurn = turn;
      state.turnWarnings[turn] ??= [];
    } else if (type === 'step/start' && count(turn) && count(step)) {
      const valid = state.currentTurn === turn && state.active === null;
      if (state.active && !state.active.settled) this._settle(state, state.active);
      this._begin(state, event, historical, valid);
    } else if (type === 'assistant/message' || type === 'assistant/attempt') {
      if (!count(turn) || !count(step)) { this._turnWarning(state, turn, LIFECYCLE_WARNING); return; }
      if (!samePosition(state.active, event)) {
        if (samePosition(state.last, event)) {
          const previous = state.records.find(record => record.id === state.last.id);
          if (previous) {
            const slot = { id: previous.id, turn, step, time: previous.time, historical: previous.historical,
              valid: previous.lifecycleOk, route: safeRoute(previous) };
            this._settle(state, slot, event);
            this._turnWarning(state, turn, '结算出现在生命周期边界之后；按同一请求替换用量。');
            return;
          }
        }
        if (state.active && !state.active.settled) this._settle(state, state.active);
        this._begin(state, event, historical, false);
      }
      this._settle(state, state.active, event);
    } else if (type === 'llm/retry' && count(turn) && count(step)) {
      if (!samePosition(state.active, event)) { this._turnWarning(state, turn, LIFECYCLE_WARNING); return; }
      if (!state.active.settled) this._settle(state, state.active);
      state.active.retry = true;
    } else if (type === 'llm/retry-started' && count(turn) && count(step)) {
      const valid = state.currentTurn === turn && samePosition(state.active, event) && state.active.retry === true;
      if (state.active && !state.active.settled) this._settle(state, state.active);
      this._begin(state, event, historical, valid);
    } else if (type === 'step/end') {
      if (samePosition(state.active, event)) {
        if (!state.active.settled) this._settle(state, state.active);
        state.active = null;
      } else if (state.currentTurn !== null) this._turnWarning(state, turn, LIFECYCLE_WARNING);
    } else if (type === 'turn/end') {
      if (state.active) {
        if (!state.active.settled) this._settle(state, state.active);
        this._turnWarning(state, turn, '缺少 step/end；本轮请求生命周期不完整。');
      }
      if (state.currentTurn !== null && state.currentTurn !== turn) this._turnWarning(state, turn, LIFECYCLE_WARNING);
      state.active = null; state.currentTurn = null;
    }
  }
  ingest(sessionId, events, options = {}) {
    const projected = Array.from(events, projectEvent).filter(Boolean);
    return this.ingestProjected(sessionId, projected, options);
  }
  ingestProjected(sessionId, projected, { inheritedEventCount = 0, historical = false } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.length) return Promise.reject(new TypeError('sessionId is required'));
    if (!count(inheritedEventCount)) return Promise.reject(new TypeError('Invalid inheritedEventCount'));
    projected = [...projected].sort((a, b) => a.seq - b.seq);
    return this._run(async () => {
      const state = await this._load(sessionId, inheritedEventCount);
      if (state.cursor >= 0 && state.inheritedEventCount !== inheritedEventCount) {
        throw new Error('Session inherited prefix changed; refusing to reinterpret existing receipts');
      }
      let changed = false;
      for (const event of projected) {
        if (event.seq <= state.cursor) continue;
        // Never advance over an unseen suffix: a later snapshot can fill it in.
        if (event.seq !== state.cursor + 1) {
          state.warnings = unique([...state.warnings, '会话事件存在缺口，等待完整回填；当前费用合计可能不完整。']);
          changed = true; break;
        }
        this._fold(state, event, historical);
        state.cursor = event.seq;
        changed = true;
      }
      if (changed) await this._save(state);
      return { cursor: state.cursor, records: state.records.length };
    });
  }
  _summary(state) {
    const status = this.pricingService.getStatus();
    const records = state.records.map(({ id, turn, provider, model, time, usage, quote }) => copy({
      id, turn, provider, model, time, usage, quote: withCurrentCacheWarnings(quote, usage),
    }));
    const turns = [...new Set([...Object.keys(state.turnWarnings).map(Number), ...records.map(record => record.turn)])]
      .sort((a, b) => a - b).map(turn => {
        const rows = records.filter(record => record.turn === turn);
        const partialTokens = rows.some(record => COUNT_FIELDS.some(field => tokenValue(record, field) === null))
          ? ['Token 统计仅合计已报告部分；未报告用量未按零推断。'] : [];
        return { turn, totals: totalRecords(rows), models: unique(rows.map(record => record.model)),
          warnings: unique([...(state.turnWarnings[turn] ?? []), ...partialTokens, ...rows.flatMap(record => record.quote?.warnings ?? [])]) };
      });
    const inherited = state.inheritedEventCount ? ['fork 继承前缀已排除；这里只合计该会话自身发起的请求。'] : [];
    return { sessionId: state.sessionId, totals: totalRecords(records), turns, records,
      pricing: copy(status.pricing), fx: copy(status.fx),
      warnings: unique([PUBLIC_WARNING, ...state.warnings, ...inherited, ...(status.warnings ?? []), ...turns.flatMap(turn => turn.warnings)]) };
  }
  summary(sessionId) { return this._run(async () => this._summary(await this._load(sessionId))); }
  repriceUnknown(sessionId) {
    return this._run(async () => {
      const paths = sessionId === undefined
        ? (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => join(this.directory, name))
        : [this.pathFor(sessionId)];
      let changed = 0;
      for (const path of paths) {
        let stored;
        try { stored = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (typeof stored?.sessionId !== 'string' || this.pathFor(stored.sessionId) !== path) throw new Error('Invalid ledger identity');
        const state = await this._load(stored.sessionId);
        let dirty = false;
        for (const record of state.records) {
          let quote = record.quote?.status === 'priced' ? record.quote : this._quote(record, record);
          quote = fillMissingFx(quote, record.time, this.pricingService);
          if (JSON.stringify(quote) !== JSON.stringify(record.quote)) {
            record.quote = quote;
            if (quote.status === 'priced') delete record.lockedQuote;
            dirty = true; changed += 1;
          }
        }
        if (dirty) await this._save(state);
      }
      return changed;
    });
  }
  async flush() { await this.tail; }
  async dispose() { this.closed = true; await this.tail; }
}

export { CostLedger as TokenCostLedger };
