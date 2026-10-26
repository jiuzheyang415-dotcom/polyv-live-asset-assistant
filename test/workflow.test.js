import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const temporary = await mkdtemp(join(tmpdir(), 'polyv-demo-test-'));
process.env.POLYV_DATA_DIR = temporary;
process.env.DEMO_MODE = '1';
process.env.SAVE_MODE = 'polyv'; // 离线演示必须覆盖真实频道配置，始终模拟保存。
const { server } = await import('../server/index.js');
const { isFinalApproval } = await import('../server/workflow.js');

test('screenshot + conversation + revision + final save updates the simulated backend', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async body => {
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const choices = await post({ message: '生成一张图片' });
    assert.equal(choices.status, 'need_target');
    assert.equal(choices.choices.length, 2);
    assert.deepEqual(choices.choices.map(item => item.id), ['player-cover', 'live-cover']);

    const first = await post({ message: '生成一张蓝紫色科技感的播放器封面', screenshot: 'data:image/png;base64,iVBORw0KGgo=' });
    assert.equal(first.status, 'draft');
    assert.equal(first.target.id, 'player-cover');
    assert.equal(first.draft.version, 1);
    assert.equal(first.screenshotAccepted, true);
    const firstImage = Buffer.from(await (await fetch(base + first.draft.url)).arrayBuffer());
    const metadata = await sharp(firstImage).metadata();
    assert.equal(metadata.width, 750);
    assert.equal(metadata.height, 422);
    assert.ok(firstImage.length < 2 * 1024 * 1024);

    const second = await post({ sessionId: first.sessionId, message: '颜色再亮一点' });
    assert.equal(second.status, 'draft');
    assert.equal(second.draft.version, 2);
    const secondImage = Buffer.from(await (await fetch(base + second.draft.url)).arrayBuffer());
    assert.notDeepEqual(firstImage, secondImage);
    assert.deepEqual(Buffer.from(await (await fetch(base + first.draft.url)).arrayBuffer()), firstImage);

    const omittedVersion = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: first.sessionId, message: '定稿并上传' }) });
    assert.equal(omittedVersion.status, 400);
    assert.match((await omittedVersion.json()).error, /当前最新版草稿/);
    const staleVersion = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: first.sessionId, message: '定稿并上传', draftVersion: 1 }) });
    assert.equal(staleVersion.status, 400);
    const saved = await post({ sessionId: first.sessionId, message: 'OK，我认为这张图片行了', draftVersion: second.draft.version });
    assert.equal(saved.status, 'saved');
    assert.equal(saved.saved.targetId, 'player-cover');
    const savedImage = Buffer.from(await (await fetch(base + saved.saved.url)).arrayBuffer());
    assert.deepEqual(savedImage, secondImage);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.saved['player-cover'].width, 750);
    assert.equal((await (await fetch(`${base}/health`)).json()).demoMode, true);

    const live = await post({ message: '做一张蓝紫科技感的直播封面' });
    assert.equal(live.target.id, 'live-cover');
    const liveImage = Buffer.from(await (await fetch(base + live.draft.url)).arrayBuffer());
    const liveInfo = await sharp(liveImage).metadata();
    assert.equal(liveInfo.width, 1280);
    assert.equal(liveInfo.height, 720);

    const switched = await post({ sessionId: first.sessionId, targetId: 'player-cover', message: '创建一张直播封面，16:9 横版，主题为会计师执业考证冲刺课' });
    assert.equal(switched.target.id, 'live-cover');
    assert.equal(switched.draft.width, 1280);
    assert.equal(switched.draft.height, 720);
    assert.equal(switched.draft.version, 3);
    assert.deepEqual(Buffer.from(await (await fetch(base + first.draft.url)).arrayBuffer()), firstImage);
    const stale = await post({ sessionId: first.sessionId, targetId: 'removed-target', message: '再制作一张直播封面' });
    assert.equal(stale.target.id, 'live-cover');
    const unsupported = await post({ message: '做一张聊天背景图' });
    assert.equal(unsupported.status, 'need_target');
    assert.equal((await fetch(`${base}/api/asset/old-asset`)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('finalization intent requires an explicit positive decision', () => {
  assert.equal(isFinalApproval('定稿并上传'), true);
  assert.equal(isFinalApproval('OK，我认为这张图片行了'), true);
  assert.equal(isFinalApproval('OK，再亮一点'), false);
  assert.equal(isFinalApproval('不要定稿，继续修改'), false);
  assert.equal(isFinalApproval('这张可以定稿吗？'), false);
  assert.equal(isFinalApproval('先不要上传并保存'), false);
});

test('a conversation from one configured channel cannot continue in another', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-channel-session-test-'));
  const environment = { ...process.env, POLYV_DATA_DIR: directory, DEMO_MODE: '0', SAVE_MODE: 'polyv', POLYV_CHANNEL_ID: '1000001', POLYV_CHANNEL_IDS: '1000002' };
  try {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {chat} from './server/workflow.js'; const first=await chat({message:'生成一张图片',channelId:'1000001'}); const second=await chat({message:'生成一张图片',channelId:'1000002'}); let blocked=''; try { await chat({sessionId:first.sessionId,message:'生成一张图片',channelId:'1000002'}); } catch(error) { blocked=error.message; } console.log(JSON.stringify({first:first.sessionId,second:second.sessionId,blocked}));"
    ], { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8' }));
    assert.notEqual(result.first, result.second);
    assert.match(result.blocked, /另一个频道/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('negative approval text revises the image instead of saving it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-negative-approval-test-'));
  const environment = { ...process.env, POLYV_DATA_DIR: directory, DEMO_MODE: '1', SAVE_MODE: 'local' };
  try {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {chat,readState} from './server/workflow.js'; const first=await chat({message:'生成播放器封面'}); const next=await chat({sessionId:first.sessionId,message:'不要定稿，继续修改'}); console.log(JSON.stringify({status:next.status,version:next.draft.version,state:await readState()}))"
    ], { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8' }));
    assert.equal(result.status, 'draft');
    assert.equal(result.version, 2);
    assert.deepEqual(result.state, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parallel revisions receive distinct versions and preserve every image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-concurrent-revision-test-'));
  const environment = { ...process.env, POLYV_DATA_DIR: directory, DEMO_MODE: '1', SAVE_MODE: 'local' };
  try {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {chat,readDraft} from './server/workflow.js'; import sharp from 'sharp'; const first=await chat({message:'生成播放器封面'}); const before=await readDraft(first.sessionId,1); const revisions=await Promise.all(Array.from({length:5},(_,i)=>chat({sessionId:first.sessionId,message:'第'+i+'次修改'}))); const switched=await chat({sessionId:first.sessionId,message:'改做直播封面'}); const original=await readDraft(first.sessionId,1); const info=await sharp(original.buffer).metadata(); console.log(JSON.stringify({versions:revisions.map(item=>item.draft.version),switchedVersion:switched.draft.version,originalIntact:before.buffer.equals(original.buffer),originalWidth:info.width}))"
    ], { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8' }));
    assert.deepEqual(result.versions, [2, 3, 4, 5, 6]);
    assert.equal(result.switchedVersion, 7);
    assert.equal(result.originalIntact, true);
    assert.equal(result.originalWidth, 750);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parallel saves retain both asset records and a readable state file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-concurrent-save-test-'));
  const environment = { ...process.env, POLYV_DATA_DIR: directory, DEMO_MODE: '1', SAVE_MODE: 'local' };
  try {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {chat} from './server/workflow.js'; import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; const a=await chat({message:'生成播放器封面'}); const b=await chat({message:'生成直播封面'}); const stateFile=join(process.env.POLYV_DATA_DIR,'state.json'); let bad=0; for(let i=0;i<40;i++){await writeFile(stateFile,'{}'); const saved=await Promise.allSettled([chat({sessionId:a.sessionId,message:'定稿并上传',draftVersion:a.draft.version}),chat({sessionId:b.sessionId,message:'定稿并上传',draftVersion:b.draft.version})]); try{const state=JSON.parse(await readFile(stateFile,'utf8')); if(saved.some(item=>item.status!=='fulfilled')||Object.keys(state).length!==2)bad++}catch{bad++}} console.log(JSON.stringify({bad}))"
    ], { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8' }));
    assert.equal(result.bad, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed image request keeps the prior target and draft active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-failed-generation-test-'));
  const run = (code, environment) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, POLYV_DATA_DIR: directory, SAVE_MODE: 'local', ...environment }, encoding: 'utf8'
  }));
  try {
    const first = run("import {chat} from './server/workflow.js'; console.log(JSON.stringify(await chat({message:'生成播放器封面'})))", { DEMO_MODE: '1' });
    const after = run(`import {chat,getSession} from './server/workflow.js'; let error; try { await chat({sessionId:'${first.sessionId}',message:'改做直播封面'}) } catch (failure) { error=failure.message } const session=await getSession('${first.sessionId}'); console.log(JSON.stringify({error,target:session.target?.id,version:session.draft?.version,historyLength:session.history.length}))`, { DEMO_MODE: '0', AI_PROVIDER: 'invalid-for-test' });
    assert.match(after.error, /未知 AI_PROVIDER/);
    assert.equal(after.target, 'player-cover');
    assert.equal(after.version, 1);
    assert.equal(after.historyLength, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a draft can be confirmed after a server process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-restart-test-'));
  const environment = { ...process.env, POLYV_DATA_DIR: directory, DEMO_MODE: '1', SAVE_MODE: 'local' };
  const run = code => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8' }));
  try {
    const first = run("import {chat} from './server/workflow.js'; console.log(JSON.stringify(await chat({message:'生成播放器封面'})))");
    const saved = run(`import {chat} from './server/workflow.js'; console.log(JSON.stringify(await chat({sessionId:'${first.sessionId}',message:'定稿并上传',draftVersion:${first.draft.version}})))`);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.saved.targetId, 'player-cover');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation text and revision context survive a server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'polyv-history-test-'));
  const environment = { ...process.env, POLYV_DATA_DIR: directory, DEMO_MODE: '1', SAVE_MODE: 'local' };
  const run = code => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8' }));
  try {
    const first = run("import {chat} from './server/workflow.js'; console.log(JSON.stringify(await chat({message:'生成蓝紫色播放器封面'})))");
    const restored = run(`import {getSession} from './server/workflow.js'; console.log(JSON.stringify(await getSession('${first.sessionId}')))`);
    assert.equal(restored.history[0].text, '生成蓝紫色播放器封面');
    assert.equal(restored.draft.version, 1);
    const revised = run(`import {chat} from './server/workflow.js'; console.log(JSON.stringify(await chat({sessionId:'${first.sessionId}',message:'颜色再亮一些'})))`);
    assert.equal(revised.draft.version, 2);
    assert.equal(revised.history[0].text, '生成蓝紫色播放器封面');
    assert.equal(revised.history[2].text, '颜色再亮一些');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
