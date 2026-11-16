import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Public tests need no proprietary SDK. Set this to a local extraction to enable
// the separately reported integration checks; no SDK source is copied to output.
export async function readSdkSource(packageName, entry = 'lib/client.js') {
  const root = process.env.DSH_SDK_REFERENCE_DIR || fileURLToPath(new URL('../.reference', import.meta.url));
  try { return await readFile(resolve(root, packageName, entry), 'utf8'); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}

/** Hand-authored public owner contract, independent of the extracted SDK. */
export function createTurnOwnerFixture(turn = 1, seq = turn * 10) {
  return { turn: { turn, status: 'closed', steps: [], data: {},
    start: { type: 'turn/start', seq: seq - 5, data: { turn } },
    end: { type: 'turn/end', seq, data: { turn } } }, seq };
}

// 0.2.2-rc.1 ships tab-indented bundles; 0.2.2-rc.3 ships the same modules
// minified on a few lines with backtick strings and no spaces around `=`.
// The helpers below therefore read brackets and literals instead of layout.
function skipLiteral(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') { cursor += 2; continue; }
    if (quote === '`' && character === '$' && source[cursor + 1] === '{') {
      const close = findCloser(source, cursor + 1);
      if (close < 0) break;
      cursor = close + 1;
      continue;
    }
    if (character === quote) return cursor + 1;
    cursor += 1;
  }
  throw new Error('The installed SDK contains an unterminated literal; inspect its bundling.');
}

function findCloser(source, index) {
  const open = source[index];
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : null;
  if (close === null) throw new Error(`The installed SDK has an unsupported opener ${JSON.stringify(open)}.`);
  let depth = 0;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '"' || character === "'" || character === '`') { cursor = skipLiteral(source, cursor) - 1; continue; }
    if (character === '/' && source[cursor + 1] === '/') {
      const end = source.indexOf('\n', cursor + 2);
      cursor = end < 0 ? source.length : end;
      continue;
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function evaluateLiteral(text) {
  return vm.runInNewContext(`(${text})`);
}

/** One `function name(...) {...}` declaration, whatever the indentation. */
function extractFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`SDK ${name} changed`);
  const params = source.indexOf('(', match.index);
  const paramsEnd = findCloser(source, params);
  if (paramsEnd < 0) throw new Error(`SDK ${name} changed`);
  const body = source.indexOf('{', paramsEnd);
  const bodyEnd = body < 0 ? -1 : findCloser(source, body);
  if (bodyEnd < 0) throw new Error(`SDK ${name} changed`);
  return source.slice(match.index, bodyEnd + 1);
}

/** The initializer assigned to `name`, parsed as the value the SDK defines. */
function initializerOf(source, name) {
  const match = new RegExp(`(?:const|var|let)\\s+${name}\\s*=\\s*`).exec(source);
  if (!match) throw new Error(`SDK ${name} changed`);
  const start = match.index + match[0].length;
  const character = source[start];
  const end = character === '{' ? findCloser(source, start) + 1
    : character === '"' || character === "'" || character === '`' ? skipLiteral(source, start) : -1;
  if (end < 0) throw new Error(`SDK ${name} changed`);
  return evaluateLiteral(source.slice(start, end));
}

/** The CSS string declared immediately before one module's exported class map. */
function moduleCssOf(source, className) {
  const marker = new RegExp(`(?:const|var|let)\\s+${className}\\s*=\\s*`).exec(source);
  if (!marker) throw new Error(`SDK ${className} changed`);
  const declarations = /(?:const|var|let)\s+css\$?\d*\s*=\s*/g;
  let last = null;
  for (const match of source.matchAll(declarations)) {
    if (match.index > marker.index) break;
    last = match;
  }
  if (!last) throw new Error(`SDK CSS for ${className} changed`);
  const start = last.index + last[0].length;
  const character = source[start];
  if (character !== '"' && character !== "'" && character !== '`') throw new Error(`SDK CSS for ${className} changed`);
  return evaluateLiteral(source.slice(start, skipLiteral(source, start)));
}

/** Optional: execute the installed SDK resolver and TurnTailNodeView. */
export async function captureSdkTurnOwner(turn = 1, kind = 'turn', seq = turn * 10) {
  const [chat, conversation] = await Promise.all([
    readSdkSource('dsh-client-ui-chat'), readSdkSource('dsh-client-ui-conversation'),
  ]);
  if (!chat || !conversation) return null;
  // The definition, not the `this.resolve(seq)` call sites; rc.3 minifies away the space.
  const method = /(?<![.\w$])resolve\(seq\)\s*\{/.exec(conversation);
  const methodBody = method ? method.index + method[0].length - 1 : -1;
  const methodEnd = methodBody < 0 ? -1 : findCloser(conversation, methodBody);
  if (methodEnd < 0) throw new Error('The installed SDK location resolver changed; inspect its owner contract.');
  const resolveLocation = vm.runInNewContext(`({ resolve(seq) ${conversation.slice(methodBody, methodEnd + 1)} }).resolve`, {
    SESSION_LOCATION: { kind: 'session' }, UNRESOLVED_LOCATION: { kind: 'unresolved' },
  });
  const step = { turn, step: 1, status: 'closed', data: {} };
  const sdkTurn = { ...createTurnOwnerFixture(turn, seq).turn, steps: [step] };
  const location = resolveLocation.call({
    coordinates: new Map([[seq, { turn, ...(kind === 'step' ? { step: 1 } : {}) }]]),
    timeline: { turns: new Map([[turn, sdkTurn]]) },
    stepsByTurn: new Map([[turn, new Map([[1, step]])]]),
  }, seq);
  const component = vm.runInNewContext(`(() => { ${extractFunction(chat, 'TurnTailNodeView')}\nreturn TurnTailNodeView; })()`, {
    react: { memo: component => component },
    react_jsx_runtime: { jsx: (type, props) => ({ type, props }) },
    TurnTailNodeView_module_css_default: { root: 'sdk-turn-tail' },
  });
  let owner;
  component({
    node: { kind: 'turn-tail', data: { turn, seq, closing: null }, location },
    openFile() {}, useAccess: () => false, useChat: () => false, usePerformanceUsage: () => 'basic',
    renderSlot(name, props) {
      if (name !== 'conversation.chat.turnTail') throw new Error(`Unexpected SDK slot ${name}`);
      owner = props;
      return 'slot-placeholder';
    },
  });
  if (owner?.turn !== sdkTurn || location.kind !== kind) throw new Error('SDK turn identity was not preserved.');
  return owner;
}

/** Optional in-memory snippets; callers execute the real toolbar event handlers. */
export async function readSdkToolbar() {
  const source = await readSdkSource('dsh-client-ui-chat');
  if (!source) return null;
  return {
    kind: 'actual SDK MessageIconActions + TurnUsagePanel',
    messageSource: extractFunction(source, 'MessageIconActions'),
    usageSource: ['formatCompactCount', 'formatExactCount', 'TurnUsagePanel']
      .map(name => extractFunction(source, name)).join('\n'),
    messageClasses: initializerOf(source, 'MessageIconActions_module_css_default'),
    usageClasses: initializerOf(source, 'TurnUsagePanel_module_css_default'),
    dialogClasses: initializerOf(source, 'stat_dialog_module_css_default'),
    css: moduleCssOf(source, 'MessageIconActions_module_css_default')
      + moduleCssOf(source, 'TurnUsagePanel_module_css_default')
      + moduleCssOf(source, 'stat_dialog_module_css_default'),
  };
}

export const toolbarFixtureCss = '.fixture-actions{display:flex;align-items:center;gap:8px;height:28px}.fixture-action{width:28px;height:28px;border:0;background:transparent;color:inherit}.fixture-end{display:inline-flex;min-width:0;align-items:center;gap:8px;margin-left:8px}.fixture-clock{font-size:12px;white-space:nowrap}.fixture-usage{display:inline-flex;min-width:0}.fixture-usage-button{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:6px 8px}.fixture-native-dialog{position:fixed;z-index:1000;left:24px;top:200px;padding:16px;background:#eee;color:#222;border:1px solid #777}';

/** Self-contained renderer also used by the offline browser. Its default branch
 * is an authored contract fixture; the optional branch executes local SDK code. */
export function createToolbarComponents(React, ReactDOM, ports = {}, sdk = null) {
  const h = React.createElement;
  const Icon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true }, h('path', { d: 'M4 4h8v8H4z', fill: 'none', stroke: 'currentColor' }));
  const messageClasses = sdk?.messageClasses ?? { actions: 'fixture-actions', action: 'fixture-action', endInfo: 'fixture-end', timeEnd: 'fixture-clock', timeStart: 'fixture-clock' };
  const usageClasses = sdk?.usageClasses ?? { root: 'fixture-usage', trigger: 'fixture-usage-button', label: 'fixture-usage-label' };
  const t = (key, values = {}) => ({ copy: '复制', copied: '已复制', 'message.branch': '分支', 'message.turnUsage.title': '原生 Token 用量',
    'message.turnUsage.count': `${values.count ?? ''} tok`, 'message.turnUsage.consumed': `用量 ${values.total ?? ''}` }[key] ?? key);
  const clipboard = text => { ports.copy?.(text); return Promise.resolve(true); };
  function useClipboardCopy(text) {
    const [copied, setCopied] = React.useState(false);
    return { copied, onCopy: () => clipboard(text).then(setCopied) };
  }
  function useStatDialog() {
    const [open, update] = React.useState(false);
    return { open, setOpen(value) { ports.usage?.(value); update(value); }, rootRef: React.useRef(null), panelRef: React.useRef(null), pos: { position: 'fixed', left: 24, top: 200, zIndex: 1000 } };
  }
  if (sdk) {
    const context = {
      react: React, react_dom: ReactDOM,
      react_jsx_runtime: { jsx: (type, props, key) => h(type, { ...props, ...(key === undefined ? {} : { key }) }), jsxs: (type, props, key) => { const { children, ...rest } = props; return h(type, { ...rest, ...(key === undefined ? {} : { key }) }, ...children); }, Fragment: React.Fragment },
      MessageIconActions_module_css_default: messageClasses, TurnUsagePanel_module_css_default: usageClasses,
      stat_dialog_module_css_default: sdk.dialogClasses,
      _deepseek_ai_dsh_client_ui_primitives: { Tooltip: ({ children }) => children, writeClipboard: clipboard, useClipboardCopy, IconCheckOutlineRegular: Icon, IconCopyOutlineRegular: Icon, IconBranchOutlineRegular: Icon, IconDatabaseOutlineRegular: Icon },
      useCalendarDay: () => 0, formatMessageClock: () => '13:48', useStatDialog,
      formatTokens: value => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : String(value),
      formatExactTokens: value => String(value), formatCacheHitPercent: () => 0, MEASURE_STYLE: {},
    };
    const compile = (source, name) => Function(...Object.keys(context), `${source}\nreturn ${name};`)(...Object.values(context));
    return { MessageIconActions: compile(sdk.messageSource, 'MessageIconActions'), TurnUsagePanel: compile(sdk.usageSource, 'TurnUsagePanel'), messageClasses, usageClasses, t };
  }
  function TurnUsagePanel({ usage }) {
    const state = useStatDialog();
    return h('span', { className: usageClasses.root },
      h('button', { type: 'button', className: usageClasses.trigger, 'aria-haspopup': 'dialog', 'aria-expanded': state.open, onClick: () => state.setOpen(!state.open) }, h(Icon), h('span', null, `用量 ${(usage.totalTokens / 1e6).toFixed(1)}M tok`)),
      state.open && ReactDOM.createPortal(h('div', { role: 'dialog', 'aria-label': '原生 Token 用量', className: 'fixture-native-dialog' }, '原生用量明细'), document.body));
  }
  function MessageIconActions({ text, time, clock, onBranch, extraActions, usageAction }) {
    const { copied, onCopy } = useClipboardCopy(text);
    return h('div', { 'data-clock': clock, className: messageClasses.actions },
      h('button', { type: 'button', className: messageClasses.action, 'aria-label': copied ? '已复制' : '复制', onClick: onCopy }, h(Icon)),
      extraActions,
      onBranch && h('button', { type: 'button', className: messageClasses.action, 'aria-label': '分支', onClick: onBranch }, h(Icon)),
      h('span', { className: messageClasses.endInfo }, usageAction, time === undefined ? null : h('span', { className: messageClasses.timeEnd }, '13:48')));
  }
  return { MessageIconActions, TurnUsagePanel, messageClasses, usageClasses, t };
}
