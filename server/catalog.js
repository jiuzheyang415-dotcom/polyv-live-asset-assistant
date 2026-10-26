export const catalog = [
  {
    id: 'player-cover',
    name: '播放器封面',
    aliases: ['播放器封面', '播放器的封面', '播放封面', '暖场封面'],
    width: 750,
    height: 422,
    maxBytes: 2 * 1024 * 1024,
    formats: ['jpg', 'png', 'gif'],
    note: '模拟参数：750×422 px，2 MB 以下，JPG/PNG/GIF'
  },
  {
    id: 'live-cover',
    name: '直播封面',
    aliases: ['直播封面', '引导页封面', '引导页图片', '直播引导图', '直播间封面'],
    width: 1280,
    height: 720,
    maxBytes: 2 * 1024 * 1024,
    formats: ['png', 'jpg'],
    designHint: '制作直播引导页的 16:9 横版封面，在手机和 PC 上都清晰可读。构图围绕用户描述的主题，标题如有则保持准确，重要内容避开边缘。不要绘制浏览器或播放器控件。',
    note: '引导页图文布局与 PC 使用 16:9；通过 splashImage 上传，再写入 splash.splashImageUrl。'
  }
];

export function findTarget(text, id) {
  const input = String(text || '').toLowerCase();
  const matches = catalog.filter(item => item.aliases.some(alias => input.includes(alias.toLowerCase())));
  if (matches.length === 1) return matches[0];
  if (id) return catalog.find(item => item.id === id) || null;
  return null;
}
