import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { catalog } from './catalog.js';
import { chat, getSession, readDraft, readSavedAsset, readState } from './workflow.js';
import { configuredChannelIds, localSetting } from './polyv.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 8765);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_000_000) throw new Error('请求内容过大。');
  }
  return JSON.parse(raw);
}

function image(res, buffer, format) {
  res.writeHead(200, { 'Content-Type': format === 'jpg' ? 'image/jpeg' : `image/${format}`, 'Cache-Control': 'no-store' });
  res.end(buffer);
}

export const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const loopback = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(req.headers.host || '')) return json(res, 403, { error: '仅允许从本机访问。' });
  if (origin && loopback.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(origin && !loopback.test(origin) ? 403 : 204); res.end(); return; }
  const url = new URL(req.url, `http://${host}:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const channelIds = await configuredChannelIds();
      return json(res, 200, { ok: true, demoMode: process.env.DEMO_MODE === '1', saveMode: process.env.DEMO_MODE !== '1' && await localSetting('SAVE_MODE') === 'polyv' ? 'polyv' : 'local', aiProvider: process.env.DEMO_MODE === '1' ? 'demo' : await localSetting('AI_PROVIDER') || 'openai', channelId: channelIds[0] || null, channelIds });
    }
    if (req.method === 'GET' && url.pathname === '/api/specs') return json(res, 200, { specs: catalog });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { saved: await readState() });
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (origin && !loopback.test(origin)) return json(res, 403, { error: '不允许从其他网站调用本机助手。' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: '请求必须使用 JSON。' });
      return json(res, 200, await chat(await bodyOf(req)));
    }
    const sessionMatch = url.pathname.match(/^\/api\/session\/([a-f0-9-]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const session = await getSession(sessionMatch[1]);
      return json(res, session ? 200 : 404, session || { error: '会话不存在。' });
    }
    const draftMatch = url.pathname.match(/^\/api\/draft\/([a-f0-9-]+)\/(\d+)$/);
    if (req.method === 'GET' && draftMatch) {
      const draft = await readDraft(draftMatch[1], draftMatch[2]);
      if (!draft) return json(res, 404, { error: '草稿不存在。' });
      return image(res, draft.buffer, draft.format);
    }
    const assetMatch = url.pathname.match(/^\/api\/asset\/([a-z-]+)$/);
    if (req.method === 'GET' && assetMatch) {
      const asset = await readSavedAsset(assetMatch[1]);
      if (!asset) return json(res, 404, { error: '尚未保存该素材。' });
      return image(res, asset.buffer, asset.item.filename.split('.').at(-1));
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/demo')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(new URL('../demo/index.html', import.meta.url)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/widget') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-ancestors 'self' https://*.polyv.net https://*.polyv.cn https://*.polyv.com http://localhost:* http://127.0.0.1:*" });
      res.end(await readFile(new URL('../extension/widget.html', import.meta.url)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/widget.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(await readFile(new URL('../extension/embed.js', import.meta.url)));
      return;
    }
    const uiAsset = url.pathname.match(/^\/ui-assets\/((?:avatar|body|idle|happy|error)\.png|tracking\/\d{5}\.png)$/);
    if (req.method === 'GET' && uiAsset) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(await readFile(new URL(`../extension/assets/${uiAsset[1]}`, import.meta.url)));
      return;
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, error.status || 400, { error: error.message });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  server.listen(port, host, () => console.log(`POLYV demo listening on http://${host}:${port}/demo`));
}
