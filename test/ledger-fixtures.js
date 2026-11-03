// rc.5 durable event fixtures: epoch milliseconds, monotonically increasing seq,
// request/header.data.header.config and compact Assistant stream records.
export function usage(inputTokens = 100, outputTokens = 20, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens };
}
export function fixture(start = Date.parse('2026-11-03T08:59:50+08:00')) {
  const events = [];
  return {
    events,
    add(type, data = {}, time = start + events.length * 1000) {
      const event = { type, data, time, seq: events.length };
      events.push(event); return event;
    },
    header(provider = 'deepseek', model = 'model-a', extra = {}) {
      return this.add('request/header', { reason: 'change', header: { config: { provider, model, ...extra } } });
    },
    start(turn = 1, step = 1, time) {
      if (!events.some(event => event.type === 'turn/start' && event.data.turn === turn)) this.add('turn/start', { turn }, time);
      return this.add('step/start', { turn, step }, time);
    },
    message({ turn = 1, step = 1, provider = 'deepseek', model = 'model-a', tokens = usage(), time, streamOnly = false, text = 'PRIVATE CONTENT' } = {}) {
      return this.add('assistant/message', { turn, step,
        message: { id: 'message-id', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider, model } },
        ...tokens && !streamOnly ? { usage: tokens } : {},
        stream: [
          { type: 'text-chunks', time0: start, index: 0, dt: [], texts: [text] },
          ...tokens ? [{ type: 'chunk', time: time ?? start, chunk: { type: 'usage', usage: tokens } }] : [],
          { type: 'chunk', time: time ?? start, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      }, time);
    },
    attempt({ turn = 1, step = 1, tokens = usage(), time } = {}) {
      return this.add('assistant/attempt', { turn, step, stream: tokens
        ? [{ type: 'chunk', time: time ?? start, chunk: { type: 'usage', usage: tokens } },
          { type: 'chunk', time: time ?? start, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'PRIVATE ERROR', code: 'SERVER' } } } }]
        : [],
      }, time);
    },
    end(turn = 1, step = 1) {
      this.add('step/end', { turn, step }); this.add('turn/end', { turn, reason: { kind: 'completed' } });
    },
  };
}

export class FakePricing {
  constructor() { this.calls = []; this.multiplier = 1; this.fx = 7; this.unknown = new Set(); this.initialized = 0; this.refreshCalls = []; }
  async initialize() { this.initialized += 1; }
  async refresh(force) { this.refreshCalls.push(force); return this.getStatus(); }
  async dispose() { this.disposed = true; }
  quote(request) {
    this.calls.push(structuredClone(request));
    if (this.unknown.has(request.model)) return { status: 'unpriced', currency: null, native: null, usd: null, cny: null,
      estimated: true, matchedModel: null, match: 'none', price: null, fx: null, warnings: ['缺少模型单价'] };
    const modelFactor = request.model === 'model-b' ? 3 : 1;
    const rates = { input: 2 * this.multiplier * modelFactor, output: 8 * this.multiplier * modelFactor,
      cacheRead: 0.2 * this.multiplier * modelFactor, cacheWrite: 2.5 * this.multiplier * modelFactor };
    const native = (request.usage.inputTokens * rates.input + request.usage.outputTokens * rates.output
      + (request.usage.cacheReadTokens ?? 0) * rates.cacheRead + (request.usage.cacheWriteTokens ?? 0) * rates.cacheWrite) / 1_000_000;
    const currency = request.provider === 'cny-provider' ? 'CNY' : 'USD';
    return { status: 'priced', currency, native, usd: currency === 'USD' ? native : this.fx ? native / this.fx : null,
      cny: currency === 'CNY' ? native : this.fx ? native * this.fx : null, estimated: true, matchedModel: request.model, match: 'exact',
      price: { unit: 'per-million-tokens', rates, source: 'fixture', sourceUrl: 'https://example.test/prices', fetchedAt: '2026-11-03T00:00:00Z', period: null, applied: [] },
      fx: this.fx ? { rate: this.fx, date: '2026-11-03', source: 'fixture', stale: false } : null, warnings: [] };
  }
  getFx() { return this.fx ? { rate: this.fx, date: '2026-11-03', source: 'fixture', stale: false } : null; }
  getStatus() { return { pricing: { fetchedAt: '2026-11-03T00:00:00Z', modelCount: 2, source: 'fixture', stale: false },
    fx: { rate: this.fx, date: '2026-11-03', source: 'fixture', stale: false }, warnings: [] }; }
}
