export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models?output_modalities=all';
export const DEEPSEEK_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md';
const numeric = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
export const rate = value => numeric(value) ? Number(value) : null;

/** Preserve every listing, including free/unknown prices and provider conditionals. */
export function parseOpenRouter(payload, fetchedAt = new Date().toISOString()) {
  if (!Array.isArray(payload?.data) || !payload.data.length) throw new Error('OpenRouter 模型列表为空或格式已改变');
  const models = payload.data.filter(m => typeof m?.id === 'string' && m.pricing && typeof m.pricing === 'object').map(m => ({
    id: m.id, name: m.name ?? m.id, canonicalSlug: m.canonical_slug ?? null, currency: 'USD',
    source: 'OpenRouter', sourceUrl: OPENROUTER_URL, fetchedAt, pricing: m.pricing,
    contextLength: m.context_length ?? null, inputModalities: m.architecture?.input_modalities ?? [],
    outputModalities: m.architecture?.output_modalities ?? [],
  }));
  if (!models.length) throw new Error('OpenRouter 未提供可识别的价格');
  return { version: 1, fetchedAt, source: OPENROUTER_URL, models };
}

/** Parse the published table; fail closed if its known tariff semantics change. */
export function parseDeepSeek(markdown, fetchedAt = new Date().toISOString()) {
  const rows = markdown.split('\n').filter(line => /^\s*\|/.test(line)).map(line => line.split('|').slice(1, -1).map(s => s.trim()));
  const heading = rows.find(row => row[0] === '模型');
  const version = rows.find(row => row[0] === '模型版本');
  const start = heading?.findIndex(cell => /^deepseek-[a-z0-9.-]+(?:\(\d+\))?$/i.test(cell));
  if (!(start >= 0) || !version) throw new Error('DeepSeek 官方价目表结构已改变，保留上次快照');
  // These boundaries are explicit in the current official page. Never silently
  // keep applying them after the upstream wording changes.
  if (!/北京时间周一至周五/.test(markdown) || !/不含中国法定节假日/.test(markdown)
      || !/9:00\s*-\s*12:00、14:00\s*-\s*18:00/.test(markdown)
      || !/周末及中国法定节假日全天均为空闲/.test(markdown)) {
    throw new Error('DeepSeek 分时规则已变化，需要更新解析器；保留上次快照');
  }
  const models = [];
  for (let column = start; column < heading.length; column++) {
    const id = heading[column].replace(/\(\d+\)$/, '');
    if (!/^deepseek-[a-z0-9.-]+$/i.test(id)) throw new Error('官方模型名无法解析');
    const prices = { offpeak: {}, peak: {} };
    for (const row of rows) {
      if (!/^价格/.test(row[0])) continue;
      const field = row[1]?.includes('缓存未命中') ? 'input' : row[1]?.includes('缓存命中') ? 'cacheRead' : row[1]?.includes('输出') ? 'output' : null;
      const period = row[2] === '空闲时段' ? 'offpeak' : row[2] === '高峰时段' ? 'peak' : null;
      if (!field || !period) throw new Error('官方计价维度无法解析');
      const value = row[column]?.match(/^(\d+(?:\.\d+)?)元$/);
      if (!value) throw new Error('官方人民币单价无法解析');
      prices[period][field] = Number(value[1]);
    }
    for (const rates of Object.values(prices)) {
      if (!['input', 'cacheRead', 'output'].every(key => numeric(rates[key]))) throw new Error('官方价格不完整');
      rates.cacheWrite = rates.input;
    }
    const aliases = [version[column]?.toLowerCase()].filter(Boolean);
    // Only accept routing aliases that the current page itself explicitly states.
    const aliasSentence = markdown.split('\n').find(line => line.includes('旧模型名') && line.includes(`\`${id}\``));
    if (aliasSentence?.includes('按 Flash 价格计费')) {
      for (const match of aliasSentence.matchAll(/`(deepseek-[a-z0-9.-]+)`/g)) if (match[1] !== id) aliases.push(match[1]);
    }
    models.push({ id, name: version[column], aliases, currency: 'CNY', source: 'DeepSeek 官方', sourceUrl: DEEPSEEK_URL,
      fetchedAt, rates: prices.offpeak, schedule: { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5],
        windows: [['09:00', '12:00'], ['14:00', '18:00']], excludeChinaHolidays: true, peak: prices.peak } });
  }
  return { version: 1, fetchedAt, source: DEEPSEEK_URL, models };
}

export function normalizeModel(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^.*\//, '').replace(/^[^:]+:\s+/, '')
    .replace(/([a-z])(?=\d)/g, '$1-').replace(/[^a-z0-9.:]+/g, '-').replace(/^-|-$/g, '');
}
const stripDate = value => value.replace(/-(?:20\d{6}|\d{4})(?=$|:)/, '').replace(/-latest(?=$|:)/, '');
const versions = value => (value.match(/\d+(?:\.\d+)*/g) ?? []).join('|');
const qualifiers = value => (value.match(/(?:^|[-:])(pro|mini|nano|flash|lite|free|batch|preview|thinking|reasoner|instruct|turbo|exp)(?=$|[-:])/g) ?? []).sort().join('|');
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** High confidence only: identity/date aliases first; never cross versions or tiers. */
export function matchModel(model, models, aliases = {}, allowFuzzy = true) {
  const raw = String(model ?? '').toLowerCase().trim();
  const key = normalizeModel(raw);
  const configured = aliases[model] ?? aliases[raw] ?? aliases[key];
  if (configured) {
    const found = models.find(m => m.id === configured || normalizeModel(m.id) === normalizeModel(configured));
    return found ? { model: found, match: 'alias' } : null;
  }
  let candidates = models.filter(m => m.id.toLowerCase() === raw);
  if (candidates.length === 1) return { model: candidates[0], match: 'exact' };
  candidates = models.filter(m => normalizeModel(m.id) === key || normalizeModel(m.name) === key || m.aliases?.some(a => normalizeModel(a) === key));
  if (candidates.length === 1) return { model: candidates[0], match: normalizeModel(candidates[0].id) === key ? 'exact' : 'alias' };
  if (candidates.length > 1) return null;
  const base = stripDate(key);
  candidates = models.filter(m => [m.id, m.canonicalSlug, ...(m.aliases ?? [])].filter(Boolean).some(a => stripDate(normalizeModel(a)) === base));
  if (candidates.length === 1) return { model: candidates[0], match: 'alias' };
  if (candidates.length > 1 || !allowFuzzy || key.length < 8) return null;
  const ranked = models.map(m => {
    const other = normalizeModel(m.id);
    if (versions(key) !== versions(other) || qualifiers(key) !== qualifiers(other)) return null;
    // Vendor/model family must agree. Small spelling mistakes elsewhere may match.
    if (key.split('-')[0] !== other.split('-')[0]) return null;
    return { model: m, distance: distance(key, other), score: 1 - distance(key, other) / Math.max(key.length, other.length) };
  }).filter(Boolean).filter(m => m.distance <= 2 && m.score >= .88).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < .04)) return null;
  return { model: ranked[0].model, match: 'fuzzy', score: ranked[0].score };
}
