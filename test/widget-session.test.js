import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const html = readFileSync(new URL('../extension/widget.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'widget inline script exists');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    entries() { return [...values.entries()]; }
  };
}

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.dataset = {};
    this._textContent = '';
    this._innerHTML = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      toggle: (name, force) => {
        const enabled = force ?? !this.classList.contains(name);
        if (enabled) this.classList.add(name);
        else this.classList.remove(name);
        return enabled;
      }
    };
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent; }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  replaceChildren(...nodes) { this.children = []; this._textContent = ''; this._innerHTML = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelectorAll(selector) {
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (selector === '[data-target]' ? Boolean(child.dataset.target)
          : selector === '.draft-card' ? child.classList.contains('draft-card')
            : selector === '.draft-actions .primary' ? child.classList.contains('primary') : false) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  click() { if (!this.disabled) this.onclick?.(); }
  focus() {}
}

function widget({ local = storage(), session = storage(), health, chat, channelSearch = '' } = {}) {
  const elements = new Map(['content', 'history-list', 'new-chat', 'show-history', 'send', 'message', 'file', 'upload-preview', 'upload-thumb', 'upload-name', 'remove-upload', 'footnote']
    .map(id => [id, new Element()]));
  elements.get('content').innerHTML = '<div class="starter">welcome</div>';
  elements.get('send').disabled = true;
  const document = {
    querySelector: selector => elements.get(selector.slice(1)),
    querySelectorAll: selector => elements.get('content').querySelectorAll(selector),
    createElement: tag => new Element(tag)
  };
  const events = new Map();
  const requests = [];
  const window = { addEventListener: (name, fn) => events.set(name, fn), parent: { postMessage() {} } };
  const fetch = async (url, options) => {
    if (url === '/health') return { ok: true, json: async () => health ? await health() : { demoMode: true, channelId: 'demo' } };
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => await chat(requests.at(-1)) };
  };
  const context = vm.createContext({ document, window, fetch, location: { search: channelSearch }, URLSearchParams, localStorage: local, sessionStorage: session, crypto: { randomUUID } });
  vm.runInContext(script, context);
  return { elements, requests, context, local, session, events };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const draft = (id, version = 1) => ({ version, url: `/api/draft/${id}/${version}`, width: 750, height: 422, bytes: 1000 });
const target = { id: 'player-cover', name: '播放器封面' };
const reply = (id, version = 1) => ({ sessionId: id, status: 'draft', assistantMessage: '已生成', draft: draft(id, version), target });

test('chat waits for channel identity before sending', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const id = randomUUID();
  const app = widget({ health: () => gate, chat: () => reply(id) });
  app.elements.get('message').value = '做播放器封面';
  app.elements.get('send').click();
  assert.equal(app.requests.length, 0);
  release({ demoMode: true, channelId: 'demo' });
  await settle();
  assert.equal(app.elements.get('send').disabled, false);
  app.elements.get('send').click();
  await settle();
  assert.equal(app.requests.length, 1);
});

test('widget scopes history and chat to the channel in its iframe URL', async () => {
  const id = randomUUID();
  const app = widget({
    channelSearch: '?channelId=1000002',
    health: () => ({ demoMode: false, saveMode: 'polyv', channelId: '1000001', channelIds: ['1000001', '1000002'] }),
    chat: () => reply(id)
  });
  await settle();
  assert.match(app.elements.get('footnote').textContent, /1000002/);
  app.elements.get('message').value = '生成播放器封面';
  app.elements.get('send').click();
  await settle();
  assert.equal(app.requests[0].channelId, '1000002');
  assert.ok(app.local.getItem(`polyv-assistant-conversation-v2:1000002:${id}`));
});

test('busy request keeps its original conversation when history is clicked', async () => {
  const first = randomUUID();
  const second = randomUUID();
  const legacy = { activeId: first, conversations: [
    { id: first, title: '第一条', createdAt: 1, updatedAt: 2, items: [] },
    { id: second, title: '第二条', createdAt: 1, updatedAt: 1, items: [] }
  ] };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = widget({ local: storage({ 'polyv-assistant-conversations-v1:demo': JSON.stringify(legacy) }), chat: () => gate });
  await settle();
  app.elements.get('message').value = '生成播放器封面';
  app.elements.get('send').click();
  await settle();
  app.elements.get('show-history').click();
  const secondButton = app.elements.get('history-list').children.find(button => button.textContent === '第二条');
  secondButton.click();
  assert.equal(app.session.getItem('polyv-assistant-active-v2:demo'), first);
  release(reply(first));
  await settle();
  const firstSaved = JSON.parse(app.local.getItem(`polyv-assistant-conversation-v2:demo:${first}`));
  const secondSaved = JSON.parse(app.local.getItem(`polyv-assistant-conversation-v2:demo:${second}`));
  assert.equal(firstSaved.items.filter(item => item.type === 'message').length, 2);
  assert.equal(secondSaved.items.length, 0);
});

test('typed approval sends the draft version currently shown', async () => {
  const id = randomUUID();
  const legacy = { activeId: id, conversations: [{ id, title: '封面', createdAt: 1, updatedAt: 2,
    items: [{ type: 'draft', draft: draft(id, 2), target, saved: false }] }] };
  const app = widget({ local: storage({ 'polyv-assistant-conversations-v1:demo': JSON.stringify(legacy) }), chat: () => ({ sessionId: id, status: 'saved', assistantMessage: '已保存', target, saved: { mode: 'local' } }) });
  await settle();
  app.elements.get('message').value = '定稿并上传';
  app.elements.get('send').click();
  await settle();
  assert.equal(app.requests[0].draftVersion, 2);
});

test('new chat clears unsent text and attachment; separate tabs keep separate histories', async () => {
  const shared = storage();
  const first = randomUUID();
  const second = randomUUID();
  const a = widget({ local: shared, chat: () => reply(first) });
  const b = widget({ local: shared, chat: () => reply(second) });
  await settle();
  a.elements.get('message').value = '生成第一张';
  a.elements.get('send').click();
  await settle();
  b.elements.get('message').value = '生成第二张';
  b.elements.get('send').click();
  await settle();
  assert.ok(shared.getItem(`polyv-assistant-conversation-v2:demo:${first}`));
  assert.ok(shared.getItem(`polyv-assistant-conversation-v2:demo:${second}`));
  vm.runInContext("pendingImage='data:image/jpeg;base64,AAAA'; pendingThumbnail='data:image/jpeg;base64,AAAA';", a.context);
  a.elements.get('message').value = '还没发送的文字';
  a.elements.get('new-chat').click();
  assert.equal(a.elements.get('message').value, '');
  assert.equal(vm.runInContext('pendingImage', a.context), null);
  assert.equal(a.session.getItem('polyv-assistant-active-v2:demo'), '');
});

test('reference thumbnail remains in history and switching conversations clears the next attachment', async () => {
  const id = randomUUID();
  const shared = storage();
  const firstTab = widget({ local: shared, chat: () => reply(id) });
  await settle();
  vm.runInContext("pendingImage='data:image/jpeg;base64,AAAA'; pendingThumbnail='data:image/jpeg;base64,AAAA'; pendingImageName='参考图.jpg';", firstTab.context);
  firstTab.elements.get('message').value = '按参考图生成';
  firstTab.elements.get('send').click();
  await settle();
  const stored = JSON.parse(shared.getItem(`polyv-assistant-conversation-v2:demo:${id}`));
  assert.equal(stored.items.find(item => item.type === 'message' && item.role === 'user').attachment.name, '参考图.jpg');

  const secondTab = widget({ local: shared, chat: () => reply(id, 2) });
  await settle();
  const userBubble = secondTab.elements.get('content').children.find(element => element.classList.contains('user'));
  assert.equal(userBubble.children[0].src, 'data:image/jpeg;base64,AAAA');
  vm.runInContext("pendingImage='data:image/jpeg;base64,BBBB'; pendingThumbnail='data:image/jpeg;base64,BBBB';", secondTab.context);
  secondTab.elements.get('message').value = '另一条没发送的文字';
  secondTab.elements.get('show-history').click();
  secondTab.elements.get('history-list').children[0].click();
  assert.equal(secondTab.elements.get('message').value, '');
  assert.equal(vm.runInContext('pendingImage', secondTab.context), null);
});
