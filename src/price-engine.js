import { matchModel, normalizeModel, rate } from './catalog.js';

export function dateInZone(time, timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, year: values.year,
    minute: Number(values.hour) * 60 + Number(values.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday) };
}
const clock = value => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };
const inWindow = (minute, start, end) => start <= end ? minute >= start && minute < end : minute >= start || minute < end;

export function selectScheduledRates(entry, time, holidays = { years: {} }) {
  const schedule = entry.schedule;
  const warnings = [];
  if (!schedule) return { rates: entry.rates, period: null, warnings };
  const local = dateInZone(time, schedule.timeZone ?? 'Asia/Shanghai');
  const calendar = holidays.years?.[local.year];
  if (schedule.excludeChinaHolidays && !calendar) warnings.push(`${local.year} 年中国节假日日历未核实，分时价格按星期和时间估算`);
  const holiday = schedule.excludeChinaHolidays && Object.values(holidays.years ?? {}).some(calendar => calendar.dates?.includes(local.date));
  if (schedule.excludeChinaHolidays && calendar?.thirdParty) warnings.push('节假日来自附政府公告的第三方日历，价格仍为估算');
  const active = (!schedule.effectiveFrom || time >= Date.parse(schedule.effectiveFrom))
    && (!schedule.effectiveTo || time < Date.parse(schedule.effectiveTo))
    && !holiday && (schedule.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(local.weekday)
    && (schedule.windows ?? []).some(([start, end]) => inWindow(local.minute, clock(start), clock(end)));
  return { rates: { ...entry.rates, ...(active ? schedule.peak : {}) }, period: active ? '高峰' : '闲时', warnings };
}
const OR_KEYS = { prompt: 'input', completion: 'output', input_cache_read: 'cacheRead', input_cache_write: 'cacheWrite', internal_reasoning: 'reasoning', request: 'request' };
const OR_PRICES = new Set([...Object.keys(OR_KEYS), 'input_cache_write_1h', 'image', 'audio', 'input_audio_cache', 'web_search', 'internal_reasoning', 'image_token', 'image_output', 'audio_output', 'discount']);
const OR_CONDITIONS = new Set(['min_prompt_tokens', 'utc_days', 'utc_start', 'utc_end']);

/** OpenRouter thresholds are STRICTLY greater-than, and later matches win per key. */
export function selectOpenRouterRates(entry, time, promptTokens) {
  const pricing = { ...entry.pricing };
  const warnings = [];
  const applied = [];
  for (const override of entry.pricing.overrides ?? []) {
    if (Object.keys(override).some(key => !OR_PRICES.has(key) && !OR_CONDITIONS.has(key))) throw new Error('OpenRouter 出现未识别的条件价格规则');
    if (override.min_prompt_tokens !== undefined && !(promptTokens > override.min_prompt_tokens)) continue;
    const instant = new Date(time);
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][instant.getUTCDay()];
    if (override.utc_days && !override.utc_days.includes(weekday)) continue;
    const minute = instant.getUTCHours() * 60 + instant.getUTCMinutes();
    if (override.utc_start !== undefined || override.utc_end !== undefined) {
      if (override.utc_start === undefined || override.utc_end === undefined) throw new Error('OpenRouter 时间条件不完整');
      const parse = value => {
        if (!Number.isInteger(value) || value < 0 || value > 2359 || value % 100 >= 60) throw new Error('OpenRouter 时间条件无效');
        return Math.floor(value / 100) * 60 + value % 100;
      };
      if (!inWindow(minute, parse(override.utc_start), parse(override.utc_end))) continue;
    }
    for (const key of Object.keys(OR_KEYS)) if (Object.hasOwn(override, key)) pricing[key] = override[key];
    applied.push(override);
  }
  const rates = {};
  for (const [key, field] of Object.entries(OR_KEYS)) {
    const value = rate(pricing[key]);
    if (value !== null) rates[field] = value * (field === 'request' ? 1 : 1_000_000);
  }
  if (rate(pricing.input_cache_write_1h) !== null) warnings.push('未报告缓存 TTL 时按默认缓存写入价估算（不含 1 小时缓存差价）');
  return { rates, period: applied.length ? '条件价格' : null, applied, warnings };
}

/** Explain absent provider fields without implying that reported cache hits were ignored. */
export function cacheUsageWarnings(usage) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)) return [];
  const labels = [];
  for (const [key, label] of [['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入']]) {
    if (usage[key] === undefined) labels.push(label);
    else if (!count(usage[key])) return [];
  }
  if (!labels.length) return [];
  const knownTotal = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (!count(knownTotal)) return [];
  const names = labels.join('、');
  if (count(usage.totalTokens) && usage.totalTokens === knownTotal) {
    const cacheReadNote = usage.cacheReadTokens > 0 ? '已报告的缓存读取仍正常计费。' : '';
    return [`接口未单独报告${names}；已报告用量与总 Token 对齐。${cacheReadNote}`];
  }
  if (usage.totalTokens !== undefined) return [];
  return [`接口未单独报告${names}；缺失项暂按 0 估算，已报告的缓存用量仍正常计费。`];
}

/** Refresh explanatory text in old receipts without revaluing any money or price. */
export function withCurrentCacheWarnings(quote, usage) {
  if (!quote || quote.status !== 'priced') return quote;
  const warnings = (quote.warnings ?? []).filter(message => message !== '未报告的缓存分项按 0 估算'
    && !message.startsWith('接口未单独报告缓存'));
  return { ...quote, warnings: [...new Set([...warnings, ...cacheUsageWarnings(usage)])] };
}

/** DSH inputTokens excludes cache buckets; outputTokens already includes reasoning. */
export function normalizeUsage(usage) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)) throw new Error('供应商未报告完整 Token 用量');
  const result = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  const warnings = [];
  for (const key of ['cacheReadTokens', 'cacheWriteTokens']) {
    if (usage[key] !== undefined && !count(usage[key])) throw new Error('缓存 Token 数无效');
    result[key] = usage[key] ?? 0;
  }
  if (usage.reasoningTokens !== undefined && (!count(usage.reasoningTokens) || usage.reasoningTokens > usage.outputTokens)) throw new Error('推理 Token 数与输出不一致');
  result.reasoningTokens = usage.reasoningTokens ?? 0;
  const total = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens + result.outputTokens;
  if (!Number.isSafeInteger(total)) throw new Error('Token 总量超出安全范围');
  if (usage.totalTokens !== undefined && (!count(usage.totalTokens) || usage.totalTokens !== total)) throw new Error('供应商报告的总 Token 数与计费桶不一致');
  warnings.push(...cacheUsageWarnings(usage));
  result.totalTokens = total;
  return { usage: result, warnings };
}

export function calculateNative(usage, rates) {
  if (rate(rates.input) === null || rate(rates.output) === null) throw new Error('模型缺少可用输入或输出单价');
  const warnings = [];
  const fallback = key => {
    if (rate(rates[key]) !== null) return rates[key];
    if (usage[key === 'cacheRead' ? 'cacheReadTokens' : 'cacheWriteTokens']) warnings.push(`${key === 'cacheRead' ? '缓存读取' : '缓存写入'}单价未公布，暂按普通输入价估算`);
    return rates.input;
  };
  const read = fallback('cacheRead');
  const write = fallback('cacheWrite');
  const reasoning = usage.reasoningTokens ?? 0;
  const reasoningRate = rate(rates.reasoning) ?? rates.output;
  const native = (usage.inputTokens * rates.input + usage.cacheReadTokens * read + usage.cacheWriteTokens * write
    + (usage.outputTokens - reasoning) * rates.output + reasoning * reasoningRate) / 1_000_000 + (rates.request ?? 0);
  if (!Number.isFinite(native) || native < 0) throw new Error('计算结果超出可用范围');
  return { native, warnings, rates: { ...rates, cacheRead: read, cacheWrite: write } };
}

const unpriced = warning => ({ status: 'unpriced', currency: null, native: null, usd: null, cny: null, estimated: true,
  matchedModel: null, match: 'none', price: null, fx: null, warnings: [warning] });

/** Each returned object is a self-contained immutable-price receipt for persistence. */
export function quoteRequest(request, { openrouter, deepseek, holidays, fx, config = {}, now = Date.now() }) {
  try {
    const { usage, warnings } = normalizeUsage(request.usage);
    if (!Number.isFinite(request.time)) throw new Error('调用时间缺失，无法选择分时价格');
    const exactOverride = (config.overrides ?? []).find(item => normalizeModel(item.model) === normalizeModel(request.model)
      && (item.provider === undefined || item.provider === request.provider));
    const providerSource = config.providerSources?.[request.provider];
    const isOpenRouter = providerSource === 'openrouter' || /openrouter/i.test(request.provider ?? '');
    let matched;
    if (exactOverride) {
      if (!['USD', 'CNY'].includes(exactOverride.currency)) throw new Error('自定义价格币种必须是 USD 或 CNY');
      matched = { model: { ...exactOverride, id: exactOverride.model, rates: exactOverride.rates, source: '自定义价格', sourceUrl: exactOverride.sourceUrl ?? null, fetchedAt: exactOverride.updatedAt ?? null }, match: 'override' };
    } else {
      // Native RMB pricing takes priority for known DeepSeek identities, except
      // routes explicitly billed by OpenRouter. A provider override can opt in/out.
      if (!isOpenRouter && providerSource !== 'catalog' && config.preferDeepSeekOfficial !== false) {
        matched = matchModel(request.model, deepseek?.models ?? [], config.aliases, false);
      }
      matched ??= matchModel(request.model, openrouter?.models ?? [], config.aliases, config.allowFuzzy !== false);
    }
    if (!matched) return unpriced(`未找到 ${request.provider ?? ''}/${request.model ?? ''} 的可靠价格；可在配置中添加别名或单价`);
    const entry = matched.model;
    if (entry.outputModalities?.length && !entry.outputModalities.includes('text')) return unpriced(`${entry.id} 为 ${entry.outputModalities.join('/')} 模型，当前会话事件未报告对应计费数量`);
    if (entry.outputModalities?.some(modality => modality !== 'text')) warnings.push('多模态输出仅计算已报告的 Token，额外图像/音频费用未计入');
    const selected = entry.pricing
      ? selectOpenRouterRates(entry, request.time, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
      : selectScheduledRates(entry, request.time, holidays);
    const calculated = calculateNative(usage, selected.rates);
    if (selected.rates.reasoning !== undefined && selected.rates.reasoning !== selected.rates.output && request.usage.reasoningTokens === undefined) warnings.push('模型推理与普通输出价格不同，但未报告推理分项；暂按普通输出价估算');
    warnings.push(...selected.warnings, ...calculated.warnings);
    if (matched.match === 'fuzzy') warnings.push(`模型名称近似匹配至 ${entry.id}`);
    if (matched.match === 'alias') warnings.push(`模型名称通过别名匹配至 ${entry.id}`);
    if (entry.fetchedAt && now - Date.parse(entry.fetchedAt) > 36 * 3600_000) warnings.push('价格同步已超过 36 小时，使用缓存价格');
    if (entry.fetchedAt && request.time < Date.parse(entry.fetchedAt) - 24 * 3600_000) warnings.push('历史调用按现有价目估算，未验证当时价格');
    const fxValue = fx && Number.isFinite(fx.rate) && fx.rate > 0 ? { ...fx, stale: fx.date !== dateInZone(request.time).date } : null;
    if (!fxValue) warnings.push('汇率不可用，保留原币金额，换算金额待补');
    else if (fxValue.stale) warnings.push(`使用 ${fxValue.date} 参考汇率，非调用当天汇率`);
    const native = calculated.native;
    return { status: 'priced', currency: entry.currency, native,
      usd: entry.currency === 'USD' ? native : fxValue ? native / fxValue.rate : null,
      cny: entry.currency === 'CNY' ? native : fxValue ? native * fxValue.rate : null,
      estimated: true, matchedModel: entry.id, match: matched.match,
      price: { source: entry.source, sourceUrl: entry.sourceUrl, fetchedAt: entry.fetchedAt, currency: entry.currency,
        unit: 'per-million-tokens', rates: calculated.rates, period: selected.period, applied: selected.applied ?? [],
        tariff: entry.pricing ? { pricing: structuredClone(entry.pricing) } : null },
      fx: fxValue, warnings: [...new Set(warnings)] };
  } catch (error) { return unpriced(error.message); }
}
