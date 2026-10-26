import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredChannelIds, signParams, uploadDecorateImage, uploadPlayerCover } from '../server/polyv.js';

test('POLYV MD5 signature matches its published example', () => {
  const params = { channelIds: '2477096,2272655', startDay: '2022-05-20', endDay: '2022-06-18', appId: 'g4rqgmmjuo', timestamp: '1660270926732', page: null, size: null };
  assert.equal(signParams(params, 'fsq2k5weced1h8vui657xtdva66whf0g'), '0D2BDA2FD04D93A2B8832B91FD973C4D');
});

test('configured second channel is used for decoration reads and writes', async () => {
  const keys = ['POLYV_APP_ID', 'POLYV_APP_SECRET', 'POLYV_CHANNEL_ID', 'POLYV_CHANNEL_IDS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { POLYV_APP_ID: 'app', POLYV_APP_SECRET: 'secret', POLYV_CHANNEL_ID: '1000001', POLYV_CHANNEL_IDS: '1000002' });
  const urls = [];
  const imageUrl = 'https://liveimages.videocc.net/new.png';
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const path = new URL(url).pathname;
    if (path.endsWith('/get')) return Response.json({ code: 200, status: 'success', data: { player: { warmUpImageUrl: urls.length === 4 ? imageUrl : '' } } });
    if (path.endsWith('/upload-image')) return Response.json({ code: 200, status: 'success', data: [imageUrl] });
    if (path.endsWith('/update')) return Response.json({ code: 200, status: 'success' });
    throw new Error('Unexpected request');
  };
  try {
    assert.deepEqual(await configuredChannelIds(), ['1000001', '1000002']);
    const saved = await uploadPlayerCover({ channelId: '1000002', buffer: Buffer.from('x'), format: 'png', fetchImpl, now: () => 1660270926732 });
    assert.equal(saved.channelId, '1000002');
    for (const url of [urls[0], urls[2], urls[3]]) assert.equal(new URL(url).searchParams.get('channelId'), '1000002');
    await assert.rejects(uploadPlayerCover({ channelId: '9999999', buffer: Buffer.from('x'), format: 'png', fetchImpl }), /未配置为允许保存/);
    assert.equal(urls.length, 4);
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});

test('player cover is uploaded, saved to the one documented field, and read back', async () => {
  const config = { appId: 'app', appSecret: 'secret', channelId: '123' };
  const imageUrl = 'https://liveimages.videocc.net/uploaded/test.png';
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path.endsWith('/get')) return Response.json({ code: 200, status: 'success', success: true, data: { skin: 'blue', chat: { baseLikes: 8 }, player: { backgroundUrl: 'https://liveimages.videocc.net/old-background.png', warmUpEnabled: 'Y', warmUpImageUrl: calls.length === 4 ? imageUrl.replace('https:', 'http:') : '' } } });
    if (path.endsWith('/upload-image')) return Response.json({ code: 200, status: 'success', data: ['//liveimages.videocc.net/uploaded/test.png'] });
    if (path.endsWith('/update')) return Response.json({ code: 200, status: 'success', success: true, data: null });
    throw new Error('Unexpected request');
  };
  const saved = await uploadPlayerCover({ buffer: Buffer.from('fake PNG'), format: 'png', fetchImpl, config, now: () => 1660270926732 });
  assert.deepEqual(saved, { channelId: '123', imageUrl });
  assert.deepEqual(calls.map(x => x.path), ['/live/v4/channel/decorate/get', '/live/v3/common/upload-image', '/live/v4/channel/decorate/update', '/live/v4/channel/decorate/get']);
  const form = calls[1].options.body;
  assert.equal(form.get('type'), 'warmImage');
  assert.equal(form.get('sign'), signParams({ appId: 'app', timestamp: '1660270926732', type: 'warmImage' }, 'secret'));
  assert.deepEqual(JSON.parse(calls[2].options.body), { skin: 'blue', chat: { baseLikes: 8 }, player: { backgroundUrl: 'https://liveimages.videocc.net/old-background.png', warmUpEnabled: 'Y', warmUpImageUrl: imageUrl } });
  assert.ok(!calls[2].options.body.includes('secret'));
});

test('live cover uses splashImage and changes only splash.splashImageUrl', async () => {
  const imageUrl = 'https://liveimages.videocc.net/uploaded/live-cover.png';
  const calls = [];
  const current = { skin: 'blue', splashEnabled: 'Y', player: { warmUpImageUrl: 'https://liveimages.videocc.net/warm.png' }, splash: { splashImageUrl: '', splashImgBackgroundId: 9, splashLayout: 'normal', splashLargeImg: 'https://liveimages.videocc.net/portrait.png' } };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path.endsWith('/get')) return Response.json({ code: 200, status: 'success', data: calls.length === 4 ? { ...current, splash: { ...current.splash, splashImageUrl: imageUrl } } : current });
    if (path.endsWith('/upload-image')) return Response.json({ code: 200, status: 'success', data: [imageUrl] });
    if (path.endsWith('/update')) return Response.json({ code: 200, status: 'success' });
    throw new Error('Unexpected request');
  };
  const saved = await uploadDecorateImage({ targetId: 'live-cover', buffer: Buffer.from('image'), format: 'png', fetchImpl, config: { appId: 'app', appSecret: 'secret', channelId: '123' }, now: () => 1660270926732 });
  assert.equal(saved.imageUrl, imageUrl);
  assert.equal(calls[1].options.body.get('type'), 'splashImage');
  assert.deepEqual(JSON.parse(calls[2].options.body), { ...current, splash: { ...current.splash, splashImageUrl: imageUrl } });
});

test('failed remote update is surfaced as failure', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count++;
    if (count === 1) return Response.json({ code: 200, status: 'success', data: { player: {} } });
    if (count === 2) return Response.json({ code: 200, status: 'success', data: ['//liveimages.videocc.net/x.png'] });
    return Response.json({ code: 400, status: 'error', error: { desc: '找不到频道' } });
  };
  await assert.rejects(uploadPlayerCover({ buffer: Buffer.from('x'), format: 'png', fetchImpl, config: { appId: 'a', appSecret: 's', channelId: '0' } }), /保存装修失败/);
});

test('concurrent cover saves preserve both fields in the remote decoration snapshot', async () => {
  const config = { appId: 'app', appSecret: 'secret', channelId: '123' };
  let remote = { player: { warmUpImageUrl: '' }, splash: { splashImageUrl: '' } };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/get')) return Response.json({ code: 200, status: 'success', data: structuredClone(remote) });
    if (path.endsWith('/upload-image')) {
      const type = options.body.get('type');
      return Response.json({ code: 200, status: 'success', data: [`https://liveimages.videocc.net/${type}.png`] });
    }
    if (path.endsWith('/update')) {
      await new Promise(resolve => setTimeout(resolve, 5));
      remote = JSON.parse(options.body);
      return Response.json({ code: 200, status: 'success' });
    }
    throw new Error('Unexpected request');
  };
  await Promise.all([
    uploadDecorateImage({ targetId: 'player-cover', buffer: Buffer.from('a'), format: 'png', fetchImpl, config }),
    uploadDecorateImage({ targetId: 'live-cover', buffer: Buffer.from('b'), format: 'png', fetchImpl, config })
  ]);
  assert.equal(remote.player.warmUpImageUrl, 'https://liveimages.videocc.net/warmImage.png');
  assert.equal(remote.splash.splashImageUrl, 'https://liveimages.videocc.net/splashImage.png');
});
