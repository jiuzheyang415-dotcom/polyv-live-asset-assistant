import test from 'node:test';
import assert from 'node:assert/strict';
import { bailianImage, bailianVision } from '../server/bailian.js';

test('Bailian DeepSeek receives pasted screenshot through compatible chat API', async () => {
  const previousKey = process.env.DASHSCOPE_API_KEY;
  const previousBase = process.env.DASHSCOPE_API_BASE;
  process.env.DASHSCOPE_API_KEY = 'test-key';
  process.env.DASHSCOPE_API_BASE = 'https://dashscope.aliyuncs.com/api/v1';
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return Response.json({ choices: [{ message: { content: '{"targetId":"player-cover"}' } }] });
  };
  try {
    const result = await bailianVision({ screenshot: 'data:image/png;base64,abc', prompt: '识别截图', fetchImpl });
    assert.equal(result, '{"targetId":"player-cover"}');
    assert.equal(request.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'deepseek-v4.1-flash-1017');
    assert.equal(body.messages[0].content[0].image_url.url, 'data:image/png;base64,abc');
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.DASHSCOPE_API_BASE; else process.env.DASHSCOPE_API_BASE = previousBase;
  }
});

test('Bailian Qwen Image edits the previous draft and downloads generated image', async () => {
  const previousKey = process.env.DASHSCOPE_API_KEY;
  const previousBase = process.env.DASHSCOPE_API_BASE;
  process.env.DASHSCOPE_API_KEY = 'test-key';
  process.env.DASHSCOPE_API_BASE = 'https://dashscope.aliyuncs.com/api/v1';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return Response.json({ output: { choices: [{ message: { content: [{ image: 'https://dashscope-test.oss-cn-beijing.aliyuncs.com/result.png' }] } }] } });
    return new Response(Buffer.from('image-bytes'), { status: 200 });
  };
  try {
    const buffer = await bailianImage({ prompt: '更亮一些', spec: { name: '播放器封面', width: 750, height: 422 }, previousBuffer: Buffer.from('old-image'), fetchImpl });
    assert.equal(buffer.toString(), 'image-bytes');
    assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'qwen-image-3.0-pro');
    assert.match(body.input.messages[0].content[0].image, /^data:image\/png;base64,/);
    assert.equal(body.parameters.size, '1536*864');
    assert.equal(calls[1].options.headers, undefined);
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.DASHSCOPE_API_BASE; else process.env.DASHSCOPE_API_BASE = previousBase;
  }
});
