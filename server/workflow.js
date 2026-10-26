import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { catalog, findTarget } from './catalog.js';
import { createImage } from './image.js';
import { analyzeScreenshot } from './vision.js';
import { configuredChannelIds, localSetting, uploadDecorateImage } from './polyv.js';

const dataDir = process.env.POLYV_DATA_DIR ? pathToFileURL(resolve(process.env.POLYV_DATA_DIR) + '/') : new URL('../data/', import.meta.url);
const sessions = new Map();
const sessionWrites = new Map();
let stateWrites = Promise.resolve();
const demoMode = process.env.DEMO_MODE === '1';
const validSessionId = id => /^[a-f0-9-]{36}$/i.test(String(id || ''));

function serializeSession(id, operation) {
  if (!validSessionId(id)) return operation();
  const previous = sessionWrites.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.catch(() => {});
  sessionWrites.set(id, settled);
  settled.finally(() => { if (sessionWrites.get(id) === settled) sessionWrites.delete(id); });
  return current;
}

async function writeJsonAtomically(destination, value) {
  const temporary = new URL(`${destination.pathname.split('/').at(-1)}.${randomUUID()}.tmp`, destination);
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, destination);
}

async function persistSession(session) {
  await mkdir(new URL('sessions/', dataDir), { recursive: true });
  const record = {
    id: session.id, channelId: session.channelId || null, targetId: session.target?.id || null, brief: session.brief,
    visualContext: session.visualContext, version: session.version,
    aiProvider: session.aiProvider, history: session.history,
    draft: session.draft ? { format: session.draft.format, bytes: session.draft.bytes } : null
  };
  await writeJsonAtomically(new URL(`sessions/${session.id}.json`, dataDir), record);
}

async function restoreSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  if (!validSessionId(id)) return null;
  try {
    const record = JSON.parse(await readFile(new URL(`sessions/${id}.json`, dataDir), 'utf8'));
    const target = catalog.find(item => item.id === record.targetId) || null;
    if (record.id === id && (!record.targetId || target) && Number.isSafeInteger(record.version) && record.version >= 0) {
      const format = record.draft?.format;
      const draft = target && record.version > 0 && ['png', 'jpg', 'webp'].includes(format)
        ? { path: new URL(`drafts/${id}-${record.version}.${format}`, dataDir), format, bytes: record.draft.bytes }
        : null;
      if (draft) await readFile(draft.path);
      const session = { id, channelId: record.channelId || (await configuredChannelIds())[0] || null, target, brief: String(record.brief || ''), visualContext: record.visualContext || null,
        version: record.version, aiProvider: record.aiProvider, history: Array.isArray(record.history) ? record.history : [], draft };
      sessions.set(id, session);
      return session;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let filenames;
  try { filenames = await readdir(new URL('drafts/', dataDir)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const prefix = `${id}-`;
  const latest = filenames
    .filter(name => name.startsWith(prefix) && /^\d+\.(png|jpg|webp)$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length).split('.')[0]) - Number(a.slice(prefix.length).split('.')[0]))[0];
  if (!latest) return null;
  const path = new URL(`drafts/${latest}`, dataDir);
  const buffer = await readFile(path);
  const metadata = await sharp(buffer).metadata();
  const target = catalog.find(item => item.width === metadata.width && item.height === metadata.height);
  if (!target) return null;
  const session = { id, channelId: (await configuredChannelIds())[0] || null, target, brief: '', visualContext: null, draft: { path, format: latest.split('.').at(-1), bytes: buffer.length }, version: Number(latest.slice(prefix.length).split('.')[0]), history: [] };
  sessions.set(id, session);
  return session;
}

export function isFinalApproval(text) {
  const value = String(text || '').trim().replace(/[，,。！!\s]/g, '');
  if (!value || /[?？]/.test(value)) return false;
  return /^(?:(?:好的|OK|可以|现在)?(?:请|帮我|麻烦你)?(?:定稿(?:并上传)?|确认(?:定稿|上传)|上传并保存|保存到后台)(?:吧|了)?|这张(?:可以|行了)|就用这张|我认为这张图片行了|OK我认为这张图片行了|OK|好的|可以了|就这样)$/i.test(value);
}

function publicSpec(spec) {
  return spec && { id: spec.id, name: spec.name, width: spec.width, height: spec.height, maxBytes: spec.maxBytes, formats: spec.formats, note: spec.note };
}

function publicDraft(session) {
  if (!session.draft) return null;
  return {
    version: session.version,
    url: `/api/draft/${session.id}/${session.version}`,
    width: session.target.width,
    height: session.target.height,
    bytes: session.draft.bytes,
    format: session.draft.format,
    mode: demoMode ? 'demo' : session.aiProvider || 'openai'
  };
}

async function saveState(target, draft, remote = null, mode = remote ? 'polyv' : 'local') {
  const operation = stateWrites.catch(() => {}).then(async () => {
    await mkdir(new URL('saved/', dataDir), { recursive: true });
    const extension = draft.format === 'jpg' ? 'jpg' : draft.format;
    const destination = new URL(`saved/${target.id}.${extension}`, dataDir);
    await copyFile(draft.path, destination);
    const state = await readState();
    state[target.id] = { targetId: target.id, version: Date.now(), filename: `${target.id}.${extension}`, width: target.width, height: target.height, bytes: draft.bytes, savedAt: new Date().toISOString(), mode, ...(remote || {}) };
    await writeJsonAtomically(new URL('state.json', dataDir), state);
    return state[target.id];
  });
  stateWrites = operation.catch(() => {});
  return operation;
}

export async function readState() {
  try {
    const saved = JSON.parse(await readFile(new URL('state.json', dataDir), 'utf8'));
    return Object.fromEntries(catalog.filter(item => saved[item.id]).map(item => [item.id, saved[item.id]]));
  }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function getSession(id) {
  const session = await restoreSession(id);
  if (!session) return null;
  return { sessionId: session.id, status: session.draft ? 'draft' : 'new', target: publicSpec(session.target), draft: publicDraft(session), visualContext: session.visualContext, history: session.history };
}

export async function readDraft(id, version) {
  const session = await restoreSession(id);
  const requested = Number(version);
  if (!session || !Number.isSafeInteger(requested) || requested < 1 || requested > session.version) return null;
  const files = await readdir(new URL('drafts/', dataDir));
  const filename = files.find(name => new RegExp(`^${id}-${requested}\\.(png|jpg|webp)$`).test(name));
  if (!filename) return null;
  return { buffer: await readFile(new URL(`drafts/${filename}`, dataDir)), format: filename.split('.').at(-1) };
}

export async function readSavedAsset(targetId) {
  if (!catalog.some(item => item.id === targetId)) return null;
  const state = await readState();
  const item = state[targetId];
  if (!item) return null;
  return { buffer: await readFile(new URL(`saved/${item.filename}`, dataDir)), item };
}

export function chat(options) {
  return serializeSession(options?.sessionId, () => chatUnlocked(options));
}

async function chatUnlocked({ sessionId, message, screenshot, targetId, draftVersion, channelId }) {
  const text = String(message || '').trim();
  if (!text || text.length > 2000) throw new Error('请输入 1～2000 字的需求或修改意见。');
  const polyvSaveMode = !demoMode && await localSetting('SAVE_MODE') === 'polyv';
  const channelIds = polyvSaveMode ? await configuredChannelIds() : [];
  const activeChannelId = polyvSaveMode ? String(channelId || channelIds[0] || '') : null;
  if (polyvSaveMode && !channelIds.includes(activeChannelId)) throw new Error(`频道 ${activeChannelId} 未配置为允许使用的频道。`);
  if (screenshot && (typeof screenshot !== 'string' || screenshot.length > 8_000_000 || !/^data:image\/(png|jpeg|webp);base64,/.test(screenshot))) {
    throw new Error('截图需为 6 MB 以内的 PNG、JPEG 或 WebP 图片。');
  }
  let session = sessionId && await restoreSession(sessionId);
  if (session && polyvSaveMode && session.channelId !== activeChannelId) throw new Error('当前会话属于另一个频道，请新建对话。');
  if (session?.target && !catalog.some(item => item.id === session.target.id)) session = null;
  if (!session) {
    session = { id: randomUUID(), channelId: activeChannelId, target: null, brief: '', visualContext: null, draft: null, version: 0, history: [] };
    sessions.set(session.id, session);
  }
  if (isFinalApproval(text)) {
    if (!session.draft) return { sessionId: session.id, status: 'need_draft', assistantMessage: '请先生成并确认一张图片，再定稿上传。', target: publicSpec(session.target), draft: null };
    const namedTarget = findTarget(text);
    if (namedTarget && namedTarget.id !== session.target.id) throw new Error(`当前草稿是${session.target.name}，请先生成${namedTarget.name}再定稿。`);
    const validVersion = (typeof draftVersion === 'number' && Number.isSafeInteger(draftVersion))
      || (typeof draftVersion === 'string' && /^[1-9]\d*$/.test(draftVersion));
    if (!validVersion || Number(draftVersion) !== session.version) {
      throw new Error('请先查看并确认当前最新版草稿后再定稿。');
    }
    const metadata = await sharp(await readFile(session.draft.path)).metadata();
    if (metadata.width !== session.target.width || metadata.height !== session.target.height || session.draft.bytes > session.target.maxBytes) {
      throw new Error('当前草稿未通过素材规格校验，无法保存。');
    }
    const remote = polyvSaveMode ? await uploadDecorateImage({ targetId: session.target.id, buffer: await readFile(session.draft.path), format: session.draft.format, channelId: activeChannelId }) : null;
    const saved = await saveState(session.target, session.draft, remote, remote ? 'polyv' : 'local');
    const destination = remote ? `保利威频道 ${remote.channelId}` : '模拟后台';
    session.history.push({ role: 'user', text }, { role: 'assistant', text: `已将第 ${session.version} 版保存到${destination}。` });
    await persistSession(session);
    return { sessionId: session.id, status: 'saved', assistantMessage: remote
      ? `已将${session.target.name}保存到${destination}，正在刷新频道后台预览。`
      : `已将${session.target.name}保存到${destination}，页面预览已更新。`, target: publicSpec(session.target), draft: publicDraft(session), saved: { ...saved, url: `/api/asset/${session.target.id}?v=${saved.version}` }, history: session.history };
  }
  let vision = null;
  let visionWarning = '';
  if (screenshot) {
    try { vision = await analyzeScreenshot({ screenshot, message: text, demoMode }); }
    catch (error) { visionWarning = `参考图的单独识别暂不可用（${error.message}）；将直接把图片交给出图模型参考。`; }
  }
  const visualContext = vision && vision.mode !== 'not_analyzed' ? vision : session.visualContext;
  const identified = findTarget(text, targetId) || (!session.target && vision?.targetId ? findTarget('', vision.targetId) : null);
  if (targetId && !identified) throw new Error('未知的素材位置。');
  const target = identified || session.target;
  const changingTarget = Boolean(identified && session.target?.id !== identified.id);
  if (!target) {
    const context = vision && vision.mode !== 'not_analyzed' && vision.summary ? `我看到：${vision.summary}。` : vision?.mode === 'not_analyzed' ? '当前离线演示未解析截图内容。' : '';
    session.visualContext = visualContext;
    session.history.push({ role: 'user', text, screenshot: !!screenshot }, { role: 'assistant', text: `${visionWarning}${context}你想制作哪个位置的素材？请选择播放器封面或直播封面。` });
    await persistSession(session);
    return { sessionId: session.id, status: 'need_target', assistantMessage: `${visionWarning}${context}你想制作哪个位置的素材？请选择播放器封面或直播封面。`, choices: catalog.map(publicSpec), screenshotAccepted: !!screenshot, vision, draft: null };
  }
  const priorDraft = changingTarget ? null : session.draft;
  const brief = changingTarget ? '' : session.brief;
  const previousBuffer = priorDraft ? await readFile(priorDraft.path) : screenshot && !demoMode
    ? await sharp(Buffer.from(screenshot.split(',')[1], 'base64')).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    : null;
  const version = session.version + 1;
  const prompt = `${brief ? `${brief}。本轮修改：${text}` : text}${screenshot && !priorDraft ? '。请参考随附图片的视觉风格和主体，按当前素材规格重新创作，不要照搬网页界面。' : ''}${visualContext ? `。截图参考：${visualContext.visualDirection}。标注：${visualContext.annotations}` : ''}`;
  const image = await createImage({ prompt, spec: target, previousBuffer, version, demoMode });
  const aiProvider = demoMode ? 'demo' : await localSetting('AI_PROVIDER') || 'openai';
  await mkdir(new URL('drafts/', dataDir), { recursive: true });
  const path = new URL(`drafts/${session.id}-${version}.${image.format}`, dataDir);
  await writeFile(path, image.output);
  session.target = target;
  session.draft = { path, format: image.format, bytes: image.output.length };
  session.version = version;
  session.visualContext = visualContext;
  session.aiProvider = aiProvider;
  session.brief = brief || text;
  const finishAction = '定稿并上传';
  session.history.push({ role: 'user', text, screenshot: !!screenshot }, { role: 'assistant', text: `已生成${target.name}第 ${version} 版。你可以继续描述修改意见，满意后说“${finishAction}”。` });
  await persistSession(session);
  const context = vision && vision.mode !== 'not_analyzed' && vision.summary ? `已参考截图：${vision.summary}。` : vision?.mode === 'not_analyzed' ? '当前离线演示未解析截图，画面依据文字生成。' : '';
  return { sessionId: session.id, status: 'draft', assistantMessage: `${visionWarning}${context}已生成${session.target.name}第 ${version} 版，符合 ${session.target.width}×${session.target.height} px、${Math.round(session.target.maxBytes / 1024 / 1024)} MB 以下的规格。可以继续修改，或说“${finishAction}”。`, target: publicSpec(session.target), draft: publicDraft(session), screenshotAccepted: !!screenshot, vision, history: session.history };
}
