import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const apiBase = 'https://api.polyv.net';
let decorateWrites = Promise.resolve();

export function signParams(params, appSecret) {
  const joined = Object.entries(params)
    .filter(([key, value]) => key !== 'sign' && value !== null && value !== undefined && value !== '')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}${value}`)
    .join('');
  return createHash('md5').update(`${appSecret}${joined}${appSecret}`, 'utf8').digest('hex').toUpperCase();
}

export async function localSetting(key) {
  if (process.env[key]) return process.env[key].trim();
  let local = '';
  try { local = await readFile(new URL('../.env.local', import.meta.url), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const line = local.split(/\r?\n/).find(item => new RegExp(`^\\s*${key}\\s*=`).test(item));
  return line ? line.replace(/^\s*[^=]+\s*=\s*/, '').replace(/^['"]|['"]$/g, '').trim() : '';
}

export async function configuredChannelIds() {
  const [primary, additional] = await Promise.all(['POLYV_CHANNEL_ID', 'POLYV_CHANNEL_IDS'].map(localSetting));
  return [...new Set([primary, ...additional.split(',').map(value => value.trim())].filter(Boolean).filter(value => /^\d+$/.test(value)))];
}

async function configFromEnvironment(requestedChannelId) {
  const [appId, appSecret, channelIds] = await Promise.all([localSetting('POLYV_APP_ID'), localSetting('POLYV_APP_SECRET'), configuredChannelIds()]);
  const channelId = requestedChannelId || channelIds[0];
  const config = { appId, appSecret, channelId };
  if (Object.values(config).some(item => !item)) throw new Error('真实频道上传缺少 POLYV_APP_ID、POLYV_APP_SECRET 或 POLYV_CHANNEL_ID。请写入本地 .env.local。');
  if (!channelIds.includes(channelId)) throw new Error(`频道 ${channelId} 未配置为允许保存的频道。`);
  return config;
}

function signedParams(config, extra = {}, now = Date.now()) {
  const params = { appId: config.appId, timestamp: String(now), ...extra };
  return { ...params, sign: signParams(params, config.appSecret) };
}

function endpoint(path, params) {
  const url = new URL(path, apiBase);
  url.search = new URLSearchParams(params).toString();
  return url;
}

async function responseJson(response, step) {
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`保利威${step}响应不是 JSON（HTTP ${response.status}）。`); }
  if (!response.ok || result.code !== 200 || result.status !== 'success' || result.success === false) {
    const detail = result.error?.desc || result.message || '未知错误';
    const requestId = result.requestId ? `，requestId: ${result.requestId}` : '';
    throw new Error(`保利威${step}失败：${detail}（HTTP ${response.status}，业务码 ${result.error?.code ?? result.code ?? 'unknown'}${requestId}）。`);
  }
  return result;
}

function normalizedImageUrl(raw) {
  if (typeof raw !== 'string') throw new Error('保利威上传接口未返回图片地址。');
  const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  if (!['http:', 'https:'].includes(url.protocol) || !(url.hostname === 'videocc.net' || url.hostname.endsWith('.videocc.net'))) {
    throw new Error('保利威上传接口返回了非预期的图片域名。');
  }
  url.protocol = 'https:';
  return url.href;
}

export function uploadDecorateImage(options) {
  const operation = decorateWrites.catch(() => {}).then(() => uploadDecorateImageUnlocked(options));
  decorateWrites = operation.catch(() => {});
  return operation;
}

async function uploadDecorateImageUnlocked({ targetId, buffer, format, fetchImpl = fetch, config, channelId, now = Date.now }) {
  const credentials = config || await configFromEnvironment(channelId);
  const destination = {
    'player-cover': { section: 'player', field: 'warmUpImageUrl', uploadType: 'warmImage' },
    'live-cover': { section: 'splash', field: 'splashImageUrl', uploadType: 'splashImage' }
  }[targetId];
  if (!destination) throw new Error('当前素材位没有已确认的频道装修保存字段。');
  if (!['png', 'jpg', 'jpeg'].includes(format)) throw new Error('真实频道装修图片仅支持 PNG/JPEG。');
  if (buffer.length > 2 * 1024 * 1024) throw new Error('图片超过保利威装修图片 2 MB 限制。');
  const channel = { channelId: credentials.channelId };
  const getCurrent = async () => {
    const response = await fetchImpl(endpoint('/live/v4/channel/decorate/get', signedParams(credentials, channel, now())));
    const result = await responseJson(response, '查询装修');
    if (!result.data || typeof result.data !== 'object') throw new Error('保利威装修查询未返回频道配置。');
    return result.data;
  };
  const current = await getCurrent();
  if (!current[destination.section] || typeof current[destination.section] !== 'object' || Array.isArray(current[destination.section])) {
    throw new Error(`保利威装修查询未返回${destination.section === 'splash' ? '引导页' : '播放器'}设置，无法安全保存。`);
  }

  const fields = signedParams(credentials, { type: destination.uploadType }, now());
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  form.set('file', new Blob([buffer], { type: mime }), `${targetId}.${format === 'png' ? 'png' : 'jpg'}`);
  const upload = await responseJson(await fetchImpl(new URL('/live/v3/common/upload-image', apiBase), { method: 'POST', body: form }), '上传图片');
  const imageUrl = normalizedImageUrl(upload.data?.[0]);

  const updateBody = { ...current, [destination.section]: { ...current[destination.section], [destination.field]: imageUrl } };
  await responseJson(await fetchImpl(endpoint('/live/v4/channel/decorate/update', signedParams(credentials, channel, now())), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updateBody)
  }), '保存装修');
  const confirmed = await getCurrent();
  if (normalizedImageUrl(confirmed[destination.section]?.[destination.field]) !== imageUrl) throw new Error('保利威保存接口已返回成功，但回读的装修图片地址不一致，请到频道后台核对。');
  return { channelId: credentials.channelId, imageUrl };
}

export function uploadPlayerCover(options) {
  return uploadDecorateImage({ ...options, targetId: 'player-cover' });
}
