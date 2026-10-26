import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const backgroundSource = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const embedSource = await readFile(new URL('../extension/embed.js', import.meta.url), 'utf8');

function makeDocument() {
  function element(tag) {
    const classes = new Set();
    const node = {
      tag, children: [], isConnected: false, parent: null, shadowRoot: null,
      classList: {
        contains: name => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
      },
      append(...children) { for (const child of children) { child.parent = node; child.isConnected = node.isConnected; node.children.push(child); } },
      attachShadow() { node.shadowRoot = element('shadow'); node.shadowRoot.isConnected = node.isConnected; return node.shadowRoot; },
      attributes: {}, setAttribute(name, value) { node.attributes[name] = value; }, getAttribute(name) { return node.attributes[name] ?? null; }, focus() {}, click() { node.onclick?.(); },
      remove() { node.isConnected = false; if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); },
      querySelector(selector) {
        const match = candidate => selector.startsWith('.') ? candidate.classList.contains(selector.slice(1)) : candidate.id === selector.slice(1);
        for (const child of node.children) {
          if (match(child)) return child;
          const nested = child.querySelector(selector);
          if (nested) return nested;
        }
        return null;
      }
    };
    Object.defineProperty(node, 'className', { set(value) { classes.clear(); for (const name of String(value).split(/\s+/)) if (name) classes.add(name); } });
    return node;
  }
  const body = element('body');
  body.isConnected = true;
  return {
    body, currentScript: null, createElement: element, addEventListener() {},
    getElementById(id) {
      const visit = node => node.id === id ? node : node.children.map(visit).find(Boolean);
      return visit(body) || null;
    }
  };
}

test('the extension reopens the panel directly after reload and honors an explicit close', async () => {
  let onAction;
  let onUpdated;
  let onMessage;
  const values = new Map();
  const extensionValues = new Map();
  const sessionStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const location = { href: 'https://console.polyv.net/live/index.html#/channel/1000001/page-renovation-new', hostname: 'console.polyv.net' };
  const context = vm.createContext({
    URL, location, sessionStorage, document: makeDocument(),
    window: { addEventListener() {}, dispatchEvent() {} }, setInterval: () => 1, clearInterval() {}, setTimeout() {}, requestAnimationFrame() {},
    fetch: async () => ({ ok: true, json: async () => ({ demoMode: false, saveMode: 'polyv', channelId: '1000001' }) }),
    chrome: { action: { onClicked: { addListener(fn) { onAction = fn; } } },
      tabs: { onUpdated: { addListener(fn) { onUpdated = fn; } }, onRemoved: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { onMessage = fn; } }, sendMessage(message) { onMessage(message, { tab: { id: 7 } }); } },
      storage: { session: {
        async set(items) { for (const [key, value] of Object.entries(items)) extensionValues.set(key, value); },
        async get(key) { return { [key]: extensionValues.get(key) }; },
        async remove(key) { extensionValues.delete(key); }
      } },
      scripting: { async executeScript({ func, args, files }) {
      if (files) { vm.runInContext(embedSource, context); return [{ result: undefined }]; }
      return [{ result: func(...(args || [])) }];
    } } }
  });
  vm.runInContext(backgroundSource, context);
  vm.runInContext(embedSource, context); // Declarative content script before first explicit opening.
  assert.equal(context.document.getElementById('polyv-assistant-root'), null);

  await onAction({ id: 7, url: location.href });
  let root = context.document.getElementById('polyv-assistant-root');
  assert.equal(sessionStorage.getItem('polyv-assistant-open-channel'), '1000001');
  assert.equal(root.shadowRoot.querySelector('.panel').classList.contains('open'), true);
  vm.runInContext(embedSource, context); // A second injection must not toggle an open panel closed.
  assert.equal(root.shadowRoot.querySelector('.panel').classList.contains('open'), true);

  context.document = makeDocument(); // Full page reload destroys the page DOM.
  values.clear(); // The site may clear its own session storage during a reload.
  await onUpdated(7, { status: 'complete' }, { url: location.href });
  vm.runInContext(embedSource, context); // Declarative content script may also run.
  root = context.document.getElementById('polyv-assistant-root');
  assert.equal(root.shadowRoot.querySelector('.panel').classList.contains('open'), true);
  root.shadowRoot.querySelector('.close').click();
  assert.equal(sessionStorage.getItem('polyv-assistant-open-channel'), null);
  assert.equal(extensionValues.has('polyv-assistant-open-tab-7'), false);

  context.document = makeDocument();
  vm.runInContext(embedSource, context);
  assert.equal(context.document.getElementById('polyv-assistant-root'), null);
});

test('a different channel URL does not automatically reopen the saved channel assistant', () => {
  const sessionStorage = { getItem: () => '1000001' };
  const document = makeDocument();
  const context = vm.createContext({
    URL, location: { href: 'https://console.polyv.net/live/index.html#/channel/1234567/page-renovation-new?from=1000001', hostname: 'console.polyv.net' },
    sessionStorage, document, window: { addEventListener() {} }
  });
  vm.runInContext(embedSource, context);
  assert.equal(document.getElementById('polyv-assistant-root'), null);
});

test('the toolbar opens on added channel 1000002 and remembers that channel', async () => {
  let onAction;
  const stored = new Map();
  const sessionValues = new Map();
  const location = { href: 'https://console.polyv.net/live/index.html#/channel/1000002/page-renovation-new' };
  const context = vm.createContext({
    location,
    sessionStorage: { setItem: (key, value) => sessionValues.set(key, value) },
    fetch: async () => ({ ok: true, json: async () => ({ demoMode: false, saveMode: 'polyv', channelId: '1000001', channelIds: ['1000001', '1000002'] }) }),
    chrome: {
      action: { onClicked: { addListener(fn) { onAction = fn; } } },
      tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
      runtime: { onMessage: { addListener() {} } },
      storage: { session: { async set(items) { for (const [key, value] of Object.entries(items)) stored.set(key, value); } } },
      scripting: { async executeScript({ func, args, files }) { return files ? [{ result: undefined }] : [{ result: func(...(args || [])) }]; } }
    }
  });
  vm.runInContext(backgroundSource, context);
  await onAction({ id: 9, url: location.href });
  assert.equal(stored.get('polyv-assistant-open-tab-9'), '1000002');
  assert.equal(sessionValues.get('polyv-assistant-open-channel'), '1000002');
});
