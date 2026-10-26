import { readFile } from 'node:fs/promises';
import { catalog } from './catalog.js';
import { bailianVision } from './bailian.js';
import { localSetting } from './polyv.js';

const visionModel = process.env.OPENAI_VISION_MODEL || 'gpt-5.6-luna';

async function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const env = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
  const line = env.split(/\r?\n/).find(value => /^\s*OPENAI_API_KEY\s*=/.test(value));
  if (!line) throw new Error('缺少 OPENAI_API_KEY');
  return line.replace(/^\s*OPENAI_API_KEY\s*=\s*/, '').replace(/^['"]|['"]$/g, '').trim();
}

function outputText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
}

export async function analyzeScreenshot({ screenshot, message, demoMode }) {
  if (!screenshot) return null;
  if (demoMode) return { mode: 'not_analyzed', targetId: null, summary: '', visualDirection: '', annotations: '' };
  const prompt = `You are helping create image assets for a livestream admin page. Read the attached screenshot and the user's Chinese message. Identify the visual reference, marked or circled area, visible labels, colors, composition, and changes requested. The only available asset targets are: ${catalog.map(item => `${item.id}=${item.name}`).join(', ')}. Return a single JSON object with keys targetId (one listed id or null if uncertain), summary (brief Chinese description of what the image shows), visualDirection (Chinese visual guidance for image generation), annotations (Chinese description of arrows, red boxes, handwritten notes or other markings). Do not infer upload dimensions or formats from the screenshot; those come from the app catalog. User message: ${message}`;
  const provider = await localSetting('AI_PROVIDER') || 'openai';
  if (provider === 'bailian') return parseVision(await bailianVision({ screenshot, prompt }), 'bailian');
  if (provider !== 'openai') throw new Error(`未知 AI_PROVIDER：${provider}`);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await loadKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: visionModel, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: screenshot, detail: 'original' }] }], max_output_tokens: 500 }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch {
    const error = new Error('截图视觉分析接口连接失败。可用离线演示模式继续文字流程。');
    error.status = 502;
    throw error;
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || `截图视觉分析失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return parseVision(outputText(data), 'openai');
}

function parseVision(text, mode) {
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); }
  catch { parsed = { targetId: null, summary: text.slice(0, 500), visualDirection: text.slice(0, 500), annotations: '' }; }
  return {
    mode,
    targetId: catalog.some(item => item.id === parsed.targetId) ? parsed.targetId : null,
    summary: String(parsed.summary || '').slice(0, 500),
    visualDirection: String(parsed.visualDirection || '').slice(0, 700),
    annotations: String(parsed.annotations || '').slice(0, 500)
  };
}
