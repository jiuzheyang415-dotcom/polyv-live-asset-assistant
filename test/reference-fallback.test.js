import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

test('reference image reaches image generation when separate vision access returns 403', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-reference-test-'));
  process.env.POLYV_DATA_DIR = directory;
  process.env.DEMO_MODE = '0';
  process.env.AI_PROVIDER = 'bailian';
  process.env.DASHSCOPE_API_KEY = 'test-key';
  process.env.DASHSCOPE_API_BASE = 'https://dashscope.aliyuncs.com/api/v1';
  const { chat } = await import('../server/workflow.js');
  const reference = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#2352c7' } }).png().toBuffer();
  const previousFetch = globalThis.fetch;
  let imageRequest;
  globalThis.fetch = async (url, options) => {
    const address = String(url);
    if (address.endsWith('/chat/completions')) return Response.json({ code: 'Forbidden', message: 'Model access denied' }, { status: 403 });
    if (address.endsWith('/multimodal-generation/generation')) {
      imageRequest = JSON.parse(options.body);
      return Response.json({ output: { choices: [{ message: { content: [{ image: 'https://dashscope-test.oss-cn-beijing.aliyuncs.com/result.png' }] } }] } });
    }
    if (address.endsWith('/result.png')) return new Response(reference, { status: 200 });
    throw new Error(`Unexpected request: ${address}`);
  };
  try {
    const result = await chat({ message: '模仿这张图做播放器封面', screenshot: `data:image/png;base64,${reference.toString('base64')}` });
    assert.equal(result.status, 'draft');
    assert.match(result.assistantMessage, /单独识别暂不可用/);
    assert.match(imageRequest.input.messages[0].content[0].image, /^data:image\/png;base64,/);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
