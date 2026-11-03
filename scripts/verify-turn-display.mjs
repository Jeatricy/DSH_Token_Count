import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CostLedger } from '../src/ledger.js';
import { normalizeTurn } from '../src/client.js';
const root = process.env.DSH_HOME || join(homedir(), '.dsh');
const dataDir = join(root, 'token-cost');
const sessionId = process.env.DSH_SESSION_ID;
assert.ok(sessionId, 'This read-only check requires the current Harness session');
const file = join(dataDir, 'ledger', createHash('sha256').update(sessionId).digest('hex') + '.json');
const before = JSON.parse(await readFile(file, 'utf8'));
const pricingService = { getStatus: () => ({ pricing: null, fx: null, warnings: [] }), quote() { throw new Error('Historical receipts must not be repriced'); } };
const ledger = new CostLedger({ dataDir, pricingService });
const summary = await ledger.summary(sessionId);
await ledger.dispose();
const turns = summary.turns.map(row => {
  const sdkOwner = { turn: row.turn, status: 'closed', start: { type: 'turn/start', data: { turn: row.turn } }, end: { type: 'turn/end', data: { turn: row.turn } }, steps: [], data: new Map() };
  const normalized = normalizeTurn(sdkOwner);
  const matched = summary.turns.find(candidate => candidate.turn === normalized);
  assert.equal(matched, row);
  return { turn: normalized, requests: matched.totals.requests, priced: matched.totals.priced,
    hasUsd: typeof matched.totals.usd === 'number', hasCny: typeof matched.totals.cny === 'number' };
});
for (const old of before.records) {
  const current = summary.records.find(row => row.id === old.id);
  assert.ok(current);
  assert.equal(current.quote.native, old.quote.native);
  assert.deepEqual(current.quote.price, old.quote.price);
  assert.deepEqual(current.quote.fx, old.quote.fx);
}
assert.ok(summary.warnings.every(message => message !== '未报告的缓存分项按 0 估算'));
assert.ok(summary.records.every(row => !(row.quote.warnings ?? []).includes('未报告的缓存分项按 0 估算')));
assert.equal(turns.reduce((total, row) => total + row.requests, 0), summary.totals.requests);
assert.ok(turns.some(turn => turn.priced > 0 && turn.hasUsd && turn.hasCny));
const report = { checkedAt: new Date().toISOString(), readOnly: true, turns,
  turnRequestCountsMatchSession: true, oldPriceAndFxSnapshotsPreserved: before.records.length,
  legacyCacheWarningReplacedOnRead: true, guiDomInspected: false };
await writeFile('artifacts/turn-display-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
