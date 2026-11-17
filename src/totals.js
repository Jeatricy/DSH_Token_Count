export const COUNT_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
export const count = value => Number.isSafeInteger(value) && value >= 0;
export const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function emptyTotals() {
  return { usd: null, cny: null, nativeUsd: null, nativeCny: null, requests: 0, priced: 0,
    unknown: 0, estimated: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, fxMissing: 0 };
}

export function tokenValue(record, field) {
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
