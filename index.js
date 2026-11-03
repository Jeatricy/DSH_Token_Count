import { createHost, createFetchHandler } from './src/host.js';

export const name = 'token-cost';
export const inject = ['connection', 'sessions', 'sessionPersistence'];
export { createHost, createFetchHandler, createRpcHandler, resolveDataDir } from './src/host.js';

export async function apply(ctx, config = {}) {
  const host = await createHost(ctx, config);
  ctx.effect(() => () => host.dispose(), 'token-cost: usage ledger');
  for (const endpoint of ['summary', 'refresh']) {
    ctx.connection.fetch.register({
      path: `/api/dsh-token-cost/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createFetchHandler(host, endpoint),
    });
  }
}
