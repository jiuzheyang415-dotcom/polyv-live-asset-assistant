import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { bailianImage } from './bailian.js';
import { localSetting } from './polyv.js';

const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare';

async function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const env = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
  const line = env.split(/\r?\n/).find(x => /^\s*OPENAI_API_KEY\s*=/.test(x));
  if (!line) throw new Error('缺少 OPENAI_API_KEY');
  return line.replace(/^\s*OPENAI_API_KEY\s*=\s*/, '').replace(/^['"]|['"]$/g, '').trim();
}

export function chooseFormat(spec) {
  const formats = (spec.formats || []).map(x => x.toLowerCase());
  if (!formats.length || formats.includes('png')) return 'png';
  if (formats.includes('jpg') || formats.includes('jpeg')) return 'jpg';
  if (formats.includes('webp')) return 'webp';
  if (formats.includes('gif')) return 'gif';
  throw new Error('当前区域未提供可生成的图片格式。');
}

export function dimensions(spec) {
  let width = Number(spec.width);
  let height = Number(spec.height);
  if (!Number.isInteger(width) || width < 32 || width > 3840) width = 1024;
  if (!Number.isInteger(height) || height < 32 || height > 3840) height = 1024;
  if ((!spec.width || !spec.height) && /^\d{1,2}:\d{1,2}$/.test(spec.ratio || '')) {
    const [a, b] = spec.ratio.split(':').map(Number);
    if (a > b) { width = 1024; height = Math.round(width * b / a); }
    else { height = 1024; width = Math.round(height * a / b); }
  }
  return { width, height };
}

export function imageSize(width, height) {
  const ratio = width / height;
  if (ratio >= 0.9 && ratio <= 1.1) return '1024x1024';
  let w = ratio >= 1 ? 1536 : 1024;
  let h = ratio >= 1 ? 1024 : 1536;
  if (ratio > 1.5) h = Math.round(w / ratio / 16) * 16;
  if (ratio < 0.67) w = Math.round(h * ratio / 16) * 16;
  w = Math.max(512, w); h = Math.max(512, h);
  return `${w}x${h}`;
}

export async function fitImage(buffer, spec) {
  const { width, height } = dimensions(spec);
  const format = chooseFormat(spec);
  const limit = Math.min(Number(spec.maxBytes) || 10 * 1024 * 1024, 10 * 1024 * 1024);
  if (limit < 10_000) throw new Error('文件大小上限过小。');
  const base = sharp(buffer).resize(width, height, { fit: 'cover', position: 'attention' });
  for (const quality of [90, 80, 70, 60, 50, 40]) {
    let pipeline = base.clone();
    if (format === 'jpg') pipeline = pipeline.jpeg({ quality, mozjpeg: true });
    if (format === 'png') pipeline = pipeline.png({ compressionLevel: 9, palette: quality < 80, quality });
    if (format === 'webp') pipeline = pipeline.webp({ quality });
    if (format === 'gif') pipeline = pipeline.gif({ effort: 7 });
    const output = await pipeline.toBuffer();
    if (output.length <= limit) return { output, format, width, height };
  }
  throw new Error(`无法将图片压缩到 ${Math.round(limit / 1024)} KB 以内。`);
}

function palette(text) {
  if (/红|橙|暖|热烈/.test(text)) return ['#f74455', '#ff9e65', '#5b1b75'];
  if (/绿|自然|清新/.test(text)) return ['#0f9d87', '#a4d891', '#124b66'];
  if (/金|奢华|节日/.test(text)) return ['#8b55d9', '#ffcd70', '#392386'];
  if (/亮|明亮/.test(text)) return ['#5e8cff', '#b6dcff', '#6757dd'];
  return ['#303cc9', '#477bfa', '#221c70'];
}

async function demoImage(prompt, spec, version) {
  const { width, height } = dimensions(spec);
  const [a, b, c] = palette(prompt);
  const shift = version * 19;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${a}"/><stop offset=".55" stop-color="${c}"/><stop offset="1" stop-color="${b}"/></linearGradient>
  <radialGradient id="glow"><stop stop-color="white" stop-opacity=".46"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient></defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <circle cx="${width * .2 + shift}" cy="${height * .25}" r="${height * .46}" fill="url(#glow)"/>
  <circle cx="${width * .8 - shift}" cy="${height * .72}" r="${height * .38}" fill="url(#glow)"/>
  <path d="M 0 ${height * .86} Q ${width * .42} ${height * .4} ${width} ${height * .83} L ${width} ${height} L 0 ${height} Z" fill="white" opacity=".11"/>
  <circle cx="${width * .72}" cy="${height * .28}" r="${height * .13}" fill="white" opacity=".12"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function openaiImage(prompt, spec, previousBuffer) {
  const key = await loadKey();
  const { width, height } = dimensions(spec);
  const instruction = `Create a polished image asset for a POLYV livestream. Asset: ${spec.name}. User direction: ${prompt}. ${spec.designHint || ''} Composition ratio ${width}:${height}. Keep important content away from edges. No browser interface or controls.`;
  let response;
  try {
    if (previousBuffer) {
      const form = new FormData();
      form.set('model', model);
      form.set('prompt', `${instruction} Preserve the recognizable composition of the input image while applying the requested change.`);
      form.set('image', new Blob([previousBuffer], { type: 'image/png' }), 'previous.png');
      form.set('size', imageSize(width, height));
      form.set('quality', 'medium');
      form.set('output_format', 'png');
      response = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180_000) });
    } else {
      response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: instruction, size: imageSize(width, height), quality: 'medium', output_format: 'png' }),
        signal: AbortSignal.timeout(180_000)
      });
    }
  } catch {
    const failure = new Error('无法连接 OpenAI 图片生成接口。可设置 DEMO_MODE=1 使用离线演示模式。');
    failure.status = 502;
    throw failure;
  }
  const result = await response.json();
  if (!response.ok) {
    const failure = new Error(result.error?.message || `OpenAI API 返回 ${response.status}`);
    failure.status = response.status;
    throw failure;
  }
  if (!result.data?.[0]?.b64_json) throw new Error('图片接口未返回图片数据。');
  return Buffer.from(result.data[0].b64_json, 'base64');
}

export async function createImage({ prompt, spec, previousBuffer, version, demoMode }) {
  const provider = demoMode ? 'demo' : await localSetting('AI_PROVIDER') || 'openai';
  let source;
  if (provider === 'demo') source = await demoImage(prompt, spec, version);
  else if (provider === 'bailian') source = await bailianImage({ prompt, spec, previousBuffer });
  else if (provider === 'openai') source = await openaiImage(prompt, spec, previousBuffer);
  else throw new Error(`未知 AI_PROVIDER：${provider}`);
  return fitImage(source, spec);
}
