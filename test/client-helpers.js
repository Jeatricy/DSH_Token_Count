export function totals(overrides = {}) {
  return { usd: 0.01, cny: 0.072, nativeUsd: 0.01, nativeCny: 0,
    requests: 1, priced: 1, unknown: 0, estimated: 1, fxMissing: 0,
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0,
    ...overrides };
}
export function summary(sessionId = 'session-a', overrides = {}) {
  const amounts = totals();
  return { sessionId, totals: amounts,
    turns: [{ turn: 1, totals: amounts, models: ['example-model'], warnings: [] }],
    records: [{ id: 'request-1', turn: 1, provider: 'example', model: 'example-model', time: 1793678400000,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 },
      quote: { status: 'priced', currency: 'USD', native: 0.01, usd: 0.01, cny: 0.072,
        estimated: true, match: 'exact', matchedModel: 'example-model',
        price: { source: '公开价目', sourceUrl: 'https://example.com/prices', fetchedAt: 1793678400000,
          currency: 'USD', unit: 'per-million-tokens', rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 }, period: '高峰', applied: [] },
        fx: { rate: 7.2, date: '2026-11-03', source: 'ExchangeRate-API', attributionUrl: 'https://www.exchangerate-api.com', stale: false }, warnings: [] } }],
    pricing: { source: '公开价目', fetchedAt: 1793678400000, modelCount: 10, stale: false },
    fx: { rate: 7.2, date: '2026-11-03', source: 'ExchangeRate-API', attributionUrl: 'https://www.exchangerate-api.com', stale: false },
    warnings: [], ...overrides };
}
export function observable(initial) {
  let current = initial;
  const listeners = new Set();
  return { getSnapshot: () => current, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    set(value) { current = value; for (const listener of [...listeners]) listener(); }, size: () => listeners.size };
}
export async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
export function clock() {
  let current = 0;
  let nextId = 0;
  const tasks = new Map();
  const add = (callback, delay, interval = null) => { const id = ++nextId; tasks.set(id, { callback, at: current + delay, interval }); return id; };
  const timers = {
    setTimeout: (callback, delay) => add(callback, delay), clearTimeout: id => tasks.delete(id),
    setInterval: (callback, delay) => add(callback, delay, delay), clearInterval: id => tasks.delete(id),
  };
  return { timers, now: () => current, pending: () => tasks.size,
    async tick(milliseconds = 0) {
      const target = current + milliseconds;
      for (;;) {
        const next = [...tasks.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, item] = next;
        current = item.at;
        if (item.interval === null) tasks.delete(id);
        else item.at += item.interval;
        item.callback();
        await settle();
      }
      current = target;
      await settle();
    },
  };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function connection(handler = (_channel, _method, payload) => ({ ok: true, value: summary(payload.sessionId) })) {
  const generation = observable({ id: 1, host: 'first-host' });
  const calls = [];
  return { generation, calls, rpc: { call(...args) { calls.push(args); return handler(...args); } } };
}
