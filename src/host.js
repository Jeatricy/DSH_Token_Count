import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CostLedger, projectEvent } from './ledger.js';
import { PricingService } from './pricing-service.js';

const unique = values => [...new Set(values)];
const optional = (ctx, name) => {
  try { return ctx.get?.(name) ?? ctx[name]; } catch { return undefined; }
};
const expandHome = path => path === '~' ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;

export function resolveDataDir(config = {}, env = process.env) {
  if (typeof config.dataDir === 'string' && config.dataDir.trim()) return resolve(expandHome(config.dataDir));
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? expandHome(env.DSH_HOME) : join(homedir(), '.dsh');
  return resolve(root, 'token-cost');
}

export async function loadConfiguration(config = {}, env = process.env) {
  const explicit = typeof config.configFile === 'string' && config.configFile.trim();
  const file = explicit ? resolve(expandHome(config.configFile)) : join(resolveDataDir(config, env), 'config.json');
  try {
    const parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Configuration must be an object');
    const merged = { ...parsed, ...config };
    for (const key of ['aliases', 'providerSources']) {
      if (parsed[key] && config[key]) merged[key] = { ...parsed[key], ...config[key] };
    }
    return { config: merged, warnings: [] };
  } catch (error) {
    if (!explicit && error.code === 'ENOENT') return { config, warnings: [] };
    return { config, warnings: ['外置费用配置无法读取或解析；暂用插件配置及默认价目，未影响会话。'] };
  }
}

/** Reads archived events without resume, repair, append, or taking a write lease. */
export async function readArchivedSession(ctx, sessionId, signal) {
  const persistence = optional(ctx, 'sessionPersistence');
  if (typeof persistence?.open === 'function') {
    const handle = await persistence.open(sessionId, 'read', signal ? { signal } : undefined);
    try {
      const result = await handle.read(0, Number.MAX_SAFE_INTEGER, signal ? { signal } : undefined);
      if (!Number.isSafeInteger(handle.inheritedEventCount) || handle.inheritedEventCount < 0) {
        throw new Error('Archive does not expose its inherited event count');
      }
      return { events: result.events, inheritedEventCount: handle.inheritedEventCount };
    } finally { await handle.close(); }
  }
  const query = optional(ctx, 'sessionQuery');
  if (typeof query?.observeSession === 'function') {
    const observation = await query.observeSession(sessionId, { projectionMode: 'none', ...(signal ? { signal } : {}) });
    try {
      if (!Number.isSafeInteger(observation.inheritedEventCount) || observation.inheritedEventCount < 0) {
        throw new Error('Archive does not expose its inherited event count');
      }
      return { events: [...observation.events], inheritedEventCount: observation.inheritedEventCount };
    } finally {
      if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]();
      else if (typeof observation[Symbol.asyncDispose] === 'function') await observation[Symbol.asyncDispose]();
    }
  }
  throw new Error('Read-only session persistence is unavailable');
}

/** Installs observers synchronously; no observer returns a Promise to the agent loop. */
export async function createHost(ctx, config = {}, dependencies = {}) {
  const loaded = await loadConfiguration(config);
  config = loaded.config;
  const dataDir = resolveDataDir(config);
  const pricingService = dependencies.pricingService ?? new PricingService({ dataDir, config });
  const ledger = dependencies.ledger ?? new CostLedger({ dataDir, pricingService });
  const warnings = new Set(loaded.warnings);
  const disposers = [];
  const queuedThrough = new WeakMap();
  const refreshes = new Set();
  let disposed = false;
  let pending = Promise.resolve();
  const warn = message => {
    warnings.add(message);
    try { ctx.logger?.warn?.(`token-cost: ${message}`); } catch { /* observers must be contained */ }
  };
  const ready = Promise.all([
    Promise.resolve().then(() => ledger.initialize()).catch(() => warn('费用账本暂不可用；会话仍可继续，稍后可回填用量。')),
    Promise.resolve().then(() => pricingService.initialize()).catch(() => warn('价格初始化失败；保留用量，暂以缓存价或未计价显示。')),
  ]);
  const queue = operation => {
    const result = pending.then(async () => { await ready; return operation(); });
    pending = result.catch(() => {});
    return result;
  };
  const refreshInBackground = () => {
    if (disposed) return;
    const promise = ready.then(() => pricingService.refresh(false)).catch(() => warn('价格或汇率同步失败；已保存的费用快照保持不变。'));
    refreshes.add(promise);
    promise.finally(() => refreshes.delete(promise));
  };
  const capture = (session, { historical = true, event } = {}) => {
    if (disposed) return;
    try {
      const inheritedEventCount = session.inheritedEventCount;
      if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) {
        warn('会话未提供 fork 继承边界，暂不计入以免重复消费。');
        return;
      }
      const from = (queuedThrough.get(session) ?? -1) + 1;
      const events = session.snapshotEvents(from).map(projectEvent).filter(Boolean);
      if (!events.length) return;
      queuedThrough.set(session, events.at(-1).seq);
      const currentIndex = event ? events.findIndex(item => item.seq === event.seq) : -1;
      // An unadopted live Session can contain a restored prefix. Only the new
      // event is live; the prefix is explicitly labelled a historical estimate.
      const batches = currentIndex < 0 ? [{ events, historical }]
        : [{ events: events.slice(0, currentIndex), historical: true }, { events: events.slice(currentIndex), historical: false }];
      void queue(async () => {
        for (const batch of batches) if (batch.events.length) {
          await ledger.ingestProjected(session.id, batch.events, { inheritedEventCount, historical: batch.historical });
        }
      }).catch(() => {
        queuedThrough.delete(session);
        warn('部分用量尚未写入费用账本；下次读取将从原会话回填。');
      });
    } catch {
      warn('读取会话用量失败；会话仍可继续，稍后可回填。');
    }
  };
  const listen = (name, handler) => {
    const dispose = ctx.on(name, handler);
    if (typeof dispose === 'function') disposers.push(dispose);
  };
  listen('session/created', session => { capture(session); });
  listen('session/event', (session, event) => {
    capture(session, { historical: false, event });
    if (event.type === 'step/start' || event.type === 'llm/retry-started') refreshInBackground();
  });
  listen('session/disposed', session => { capture(session); });
  listen('session/flush', session => { capture(session); });
  for (const session of ctx.sessions.list()) capture(session);
  const interval = setInterval(refreshInBackground, 60 * 60 * 1000);
  interval.unref?.();

  const host = {
    dataDir, ledger, pricingService,
    async summary(sessionId, signal) {
      signal?.throwIfAborted();
      await ready;
      await pending;
      const readWarnings = [];
      const live = ctx.sessions.get(sessionId);
      try {
        if (live) {
          // Full replay is intentional: it heals a failed asynchronous write and
          // persisted seq cursors make repeat reads/HMR idempotent.
          await queue(() => ledger.ingest(sessionId, live.snapshotEvents(0), {
            inheritedEventCount: live.inheritedEventCount, historical: true,
          }));
        } else {
          const archive = await readArchivedSession(ctx, sessionId, signal);
          await queue(() => ledger.ingest(sessionId, archive.events, { inheritedEventCount: archive.inheritedEventCount, historical: true }));
        }
      } catch (error) {
        signal?.throwIfAborted();
        readWarnings.push('原会话暂无法只读回填；当前仅显示已保存的费用账本，合计可能不完整。');
      }
      signal?.throwIfAborted();
      const summary = await ledger.summary(sessionId);
      summary.warnings = unique([...summary.warnings, ...warnings, ...readWarnings]);
      return summary;
    },
    async refresh(sessionId, signal) {
      signal?.throwIfAborted();
      await ready;
      try { await pricingService.refresh(true); }
      catch { warn('价格或汇率同步失败；已保存的费用快照保持不变。'); }
      signal?.throwIfAborted();
      if (sessionId !== undefined) await host.summary(sessionId, signal);
      await queue(() => ledger.repriceUnknown(sessionId));
      if (sessionId !== undefined) return host.summary(sessionId, signal);
      const status = pricingService.getStatus();
      return { ...status, warnings: unique([...(status.warnings ?? []), ...warnings]) };
    },
    async flush() { await ready; await pending; await ledger.flush(); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
      for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* best effort */ } }
      await ready;
      await pending;
      await Promise.allSettled([...refreshes]);
      await Promise.allSettled([ledger.dispose(), pricingService.dispose?.()]);
    },
  };
  await ready;
  return host;
}

const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;

export function createRpcHandler(host) {
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner') return failure('token-cost/forbidden', 'Only the DSH owner may read cost records.');
    if (endpoint !== 'summary' && endpoint !== 'refresh') return failure('token-cost/not-found', 'Unknown token cost operation.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => key !== 'sessionId')
      || (endpoint === 'summary' ? !validId(payload.sessionId) : payload.sessionId !== undefined && !validId(payload.sessionId))) {
      return failure('token-cost/bad-request', 'A valid sessionId is required for summary; refresh accepts an optional sessionId.');
    }
    try {
      signal?.throwIfAborted();
      const value = await host[endpoint](payload.sessionId, signal);
      return { ok: true, value };
    } catch (error) {
      return failure(signal?.aborted ? 'token-cost/aborted' : 'token-cost/unavailable',
        signal?.aborted ? 'The request was cancelled.' : 'Cost records are temporarily unavailable; the conversation is unaffected.');
    }
  };
}

export function createFetchHandler(host, endpoint) {
  const rpc = createRpcHandler(host);
  return async request => {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return new Response('Expected application/json', { status: 415 });
    }
    let envelope;
    try { envelope = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string'
      || envelope.method !== `dsh-token-cost/${endpoint}`) return new Response('Invalid token cost request envelope', { status: 400 });
    // DSH rc.5 Connection authenticates and owner-gates exact Fetch routes before
    // dispatch. This handler is registered only on that connection, never raw HTTP.
    const result = await rpc(endpoint, envelope.payload, request.signal, { principal: { kind: 'owner' } });
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
  };
}
