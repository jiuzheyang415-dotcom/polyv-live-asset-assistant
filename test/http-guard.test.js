import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const directory = await mkdtemp(join(tmpdir(), 'polyv-http-guard-'));
process.env.POLYV_DATA_DIR = directory;
process.env.DEMO_MODE = '1';
const { server } = await import('../server/index.js');

test('local API rejects browser cross-site writes and non-JSON requests', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const foreign = await fetch(`${base}/api/chat`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'text/plain' }, body: JSON.stringify({ message: '生成一张图片' }) });
    assert.equal(foreign.status, 403);
    const nonJson = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ message: '生成一张图片' }) });
    assert.equal(nonJson.status, 415);
    const valid = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '生成一张图片' }) });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).status, 'need_target');
    const foreignHost = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/health', headers: { Host: 'untrusted.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(foreignHost, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
