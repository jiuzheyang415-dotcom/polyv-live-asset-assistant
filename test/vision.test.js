import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScreenshot } from '../server/vision.js';

test('passes a pasted screenshot and user intent to the vision model', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousProvider = process.env.AI_PROVIDER;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AI_PROVIDER = 'openai';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ targetId: 'player-cover', summary: '红框标出播放器封面区域', visualDirection: '沿用蓝紫色渐变和留白', annotations: '红框指向播放器封面上传位' }) }] }] }) };
  };
  try {
    const screenshot = 'data:image/png;base64,iVBORw0KGgo=';
    const result = await analyzeScreenshot({ screenshot, message: '参考红框位置生成封面', demoMode: false });
    assert.equal(result.targetId, 'player-cover');
    assert.match(result.annotations, /红框/);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(request.options.body);
    assert.equal(body.input[0].content[1].image_url, screenshot);
    assert.match(body.input[0].content[0].text, /参考红框位置生成封面/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
  }
});

test('offline demo discloses that it did not analyze the screenshot', async () => {
  const result = await analyzeScreenshot({ screenshot: 'data:image/png;base64,iVBORw0KGgo=', message: '看看这张图', demoMode: true });
  assert.equal(result.mode, 'not_analyzed');
  assert.equal(result.targetId, null);
});
