import { localSetting } from './polyv.js';
import { dimensions, imageSize } from './image.js';

async function settings() {
  const [key, base] = await Promise.all([localSetting('DASHSCOPE_API_KEY'), localSetting('DASHSCOPE_API_BASE')]);
  if (!key) throw new Error('缺少 DASHSCOPE_API_KEY，请写入本地 .env.local。');
  const apiBase = new URL(base || 'https://dashscope.aliyuncs.com/api/v1');
  if (apiBase.protocol !== 'https:') throw new Error('DASHSCOPE_API_BASE 必须使用 HTTPS。');
  return { key, apiBase: apiBase.href.replace(/\/$/, '') };
}

async function jsonResponse(response, step) {
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`百炼${step}接口未返回 JSON。`); }
  if (!response.ok || data.code) {
    const error = new Error(`百炼${step}失败：${data.message || data.code || `HTTP ${response.status}`}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function bailianVision({ screenshot, prompt, fetchImpl = fetch }) {
  const { key, apiBase } = await settings();
  const model = await localSetting('BAILIAN_VISION_MODEL') || 'deepseek-v4.1-flash-1017';
  let response;
  try {
    response = await fetchImpl(`${apiBase.replace(/\/api\/v1$/, '/compatible-mode/v1')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: screenshot } }, { type: 'text', text: prompt }] }], stream: false }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch {
    const error = new Error('无法连接百炼截图理解接口。'); error.status = 502; throw error;
  }
  const data = await jsonResponse(response, '截图理解');
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('百炼截图理解接口未返回文本。');
  return content;
}

function safeImageDownloadUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !(url.hostname === 'aliyuncs.com' || url.hostname.endsWith('.aliyuncs.com'))) {
    throw new Error('百炼出图接口返回了非预期的图片地址。');
  }
  return url;
}

export async function bailianImage({ prompt, spec, previousBuffer, fetchImpl = fetch }) {
  const { key, apiBase } = await settings();
  const model = await localSetting('BAILIAN_IMAGE_MODEL') || 'qwen-image-3.0-pro';
  const { width, height } = dimensions(spec);
  const content = [];
  if (previousBuffer) content.push({ image: `data:image/png;base64,${previousBuffer.toString('base64')}` });
  content.push({ text: `为保利威直播间制作${spec.name}。${prompt}。${spec.designHint || ''}构图比例约 ${width}:${height}，重要文字和主体远离边缘。${previousBuffer ? '请保持参考图的主要构图，仅按修改意见调整。' : ''}画面中不要出现网页界面、按钮或上传框。` });
  const size = imageSize(width, height).replace('x', '*');
  let response;
  try {
    response = await fetchImpl(`${apiBase}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: { messages: [{ role: 'user', content }] }, parameters: { size, n: 1, prompt_extend: false, watermark: false } }),
      signal: AbortSignal.timeout(180_000)
    });
  } catch {
    const error = new Error('无法连接百炼图片生成接口。'); error.status = 502; throw error;
  }
  const data = await jsonResponse(response, '图片生成');
  const item = data.output?.choices?.[0]?.message?.content?.find(part => part.image);
  if (!item?.image) throw new Error('百炼图片生成接口未返回图片地址。');
  const url = safeImageDownloadUrl(item.image);
  let download;
  try { download = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) }); }
  catch { throw new Error('百炼图片已生成，但下载到本地失败。'); }
  if (!download.ok) throw new Error(`百炼图片下载失败（HTTP ${download.status}）。`);
  const contentLength = Number(download.headers.get('content-length'));
  if (contentLength > 20 * 1024 * 1024) throw new Error('百炼图片超过 20 MB，无法处理。');
  const buffer = Buffer.from(await download.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) throw new Error('百炼图片超过 20 MB，无法处理。');
  return buffer;
}
