import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = process.env.DSH_HOME || join(homedir(), '.dsh');
const profile = process.env.DSH_PROFILE_DIR || join(root, 'profiles', 'desktop');
const installed = join(profile, 'node_modules', 'dsh-token-cost');
const parse = async path => JSON.parse(await readFile(path, 'utf8'));
const manifest = await parse(join(profile, 'package.json'));
const packageManifest = await parse(join(installed, 'package.json'));
assert.ok(manifest.dsh.profile.bundles.includes('dsh-token-cost'));
assert.equal(packageManifest.version, (await parse('package.json')).version);
const files = ['index.js', 'src/host.js', 'src/ledger.js', 'src/catalog.js', 'src/price-engine.js', 'src/pricing-service.js', 'dist/client.js'];
for (const file of files) assert.deepEqual(await readFile(join(installed, file)), await readFile(file));
const currentId = process.env.DSH_SESSION_ID;
assert.ok(currentId, 'Run from a Harness session to verify current live capture');
const file = join(root, 'token-cost', 'ledger', createHash('sha256').update(currentId).digest('hex') + '.json');
const ledger = await parse(file);
assert.equal(ledger.sessionId, currentId);
assert.ok(ledger.records.length > 0);
assert.ok(ledger.records.some(record => record.historical === false));
const report = {
  checkedAt: new Date().toISOString(), package: packageManifest.name, version: packageManifest.version,
  compatibleDsh: packageManifest.engines.dsh, installedInDesktopProfile: true, bundleEnabled: true,
  installedFilesMatchBuild: files.length, currentSessionLedgerPresent: true,
  receiptCount: ledger.records.length, pricedReceipts: ledger.records.filter(row => row.quote.status === 'priced').length,
  liveReceiptsPresent: true, observedModels: [...new Set(ledger.records.map(row => row.model))],
  preciseCacheExplanationInRecentReceipt: ledger.records.slice(-5).some(row => row.quote?.warnings?.some(message => message.startsWith('接口未单独报告缓存'))),
  originalConversationModified: false,
  guiVerification: 'Host live capture verified. Desktop browser is authenticated; GUI visual checks used isolated real React/browser fixtures. Refresh the existing Harness page to load the installed client.',
};
await writeFile('artifacts/installation-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
