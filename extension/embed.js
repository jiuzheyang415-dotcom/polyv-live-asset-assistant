(() => {
  const official = /\.polyv\.(?:net|cn|com)$/i.test(location.hostname);
  const openKey = 'polyv-assistant-open-channel';
  const channel = location.href.match(/(?:^|[/#])channel\/(\d+)(?=\/|[?#]|$)/)?.[1];
  if (official) {
    try { if (!channel || sessionStorage.getItem(openKey) !== channel) return; }
    catch { return; }
  }
  const existing = document.getElementById('polyv-assistant-root');
  if (existing) {
    const launcher = existing.shadowRoot?.querySelector('.launcher');
    if (launcher?.getAttribute('aria-expanded') !== 'true') launcher?.click();
    return;
  }
  const script = document.currentScript;
  const base = new URL(script?.dataset.base || script?.src || 'http://127.0.0.1:8765/', location.href);
  const asset = path => (typeof chrome !== 'undefined' && chrome.runtime?.id
    ? chrome.runtime.getURL(`assets/${path}`)
    : new URL(`/ui-assets/${path}`, base).href);
  const root = document.createElement('div');
  root.id = 'polyv-assistant-root';
  const shadow = root.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    *{box-sizing:border-box}
    .launcher{position:fixed;right:8px;bottom:8px;width:122px;height:122px;border:0;padding:0;background:transparent;cursor:pointer;z-index:2147483646;display:grid;place-items:center;animation:xb-float 4.8s ease-in-out infinite;transition:transform .16s}
    .launcher:hover{transform:translateY(-3px) scale(1.03)}.launcher:focus-visible,.close:focus-visible{outline:3px solid #85a5ff;outline-offset:2px}.launcher img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;user-select:none}
    .badge{position:absolute;right:15px;bottom:18px;width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:#39c7a3;box-shadow:0 0 12px #39c7a388}
    .launcher.working .badge{animation:xb-pulse 1s ease-in-out infinite}
    .panel{position:fixed;right:132px;bottom:24px;width:min(410px,calc(100vw - 160px));height:min(630px,calc(100vh - 48px));border-radius:28px;overflow:hidden;background:linear-gradient(180deg,#f1f4ff,#eaefff);box-shadow:0 16px 46px #2849a830;border:1px solid #fff;z-index:2147483646;display:none}
    .panel.open{display:block;animation:xb-panel-in .18s ease-out}.panel iframe{width:100%;height:100%;border:0}.close{position:fixed;right:146px;bottom:calc(min(630px,100vh - 48px) - 20px);z-index:2147483647;width:28px;height:28px;border:0;border-radius:8px;background:#ffffffc9;color:#64708a;cursor:pointer;display:none;font-size:20px;line-height:1}.close.open{display:block}
    @keyframes xb-float{50%{translate:0 -5px}}@keyframes xb-pulse{50%{opacity:.35;scale:.8}}@keyframes xb-panel-in{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
    @media(max-width:720px){.launcher{right:4px;bottom:4px;width:104px;height:104px}.panel{right:8px;bottom:108px;width:calc(100vw - 16px);height:min(620px,calc(100vh - 124px))}.close{right:22px;bottom:calc(min(620px,100vh - 124px) + 65px)}}
    @media(max-height:520px){.panel{right:8px;bottom:8px;height:calc(100vh - 16px);width:min(410px,calc(100vw - 16px))}.launcher{display:none}.close{right:22px;bottom:calc(100vh - 52px)}}
    @media(prefers-reduced-motion:reduce){.launcher,.panel.open,.badge{animation:none!important;transition:none!important}}
  `;
  const launcher = document.createElement('button');
  launcher.className = 'launcher'; launcher.type = 'button'; launcher.setAttribute('aria-label', '打开小保 AI 直播助手');
  const robot = document.createElement('img'); robot.src = asset('tracking/00000.png'); robot.alt = ''; robot.draggable = false; launcher.append(robot);
  const badge = document.createElement('span'); badge.className = 'badge'; launcher.append(badge);
  const panel = document.createElement('div'); panel.className = 'panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '保利威直播 AI 助手');
  const frame = document.createElement('iframe'); frame.title = '保利威直播 AI 助手';
  const widgetURL = new URL('/widget', base);
  if (official && channel) widgetURL.searchParams.set('channelId', channel);
  frame.src = widgetURL.href; panel.append(frame);
  const close = document.createElement('button'); close.className = 'close'; close.type = 'button'; close.setAttribute('aria-label', '关闭助手'); close.textContent = '×';
  let refreshing = false;
  const anchors = [14, 22, 26, 33, 40, 46, 50, 7];
  const frames = Array.from({ length: 56 }, (_, index) => asset(`tracking/${String(index).padStart(5, '0')}.png`));
  let currentFrame = 0;
  let targetFrame = 0;
  let lastFrameAt = 0;
  let emotionUntil = 0;
  document.addEventListener('mousemove', event => {
    const rect = launcher.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    const angle = ((Math.atan2(-y, -x) * 180 / Math.PI) + 360) % 360;
    const segment = Math.floor(angle / 45);
    const lower = anchors[segment];
    const next = anchors[(segment + 1) % anchors.length];
    targetFrame = (lower + Math.round(((next - lower + 56) % 56) * ((angle % 45) / 45))) % 56;
  }, { passive: true });
  function animate(time) {
    if (time > emotionUntil && time - lastFrameAt >= 42 && currentFrame !== targetFrame) {
      const forward = (targetFrame - currentFrame + 56) % 56;
      const backward = (currentFrame - targetFrame + 56) % 56;
      const delta = forward <= backward ? forward : -backward;
      const distance = Math.abs(delta);
      const step = distance >= 20 ? 6 : distance >= 12 ? 4 : distance >= 6 ? 3 : distance >= 3 ? 2 : 1;
      currentFrame = (currentFrame + Math.sign(delta) * Math.min(distance, step) + 56) % 56;
      robot.src = frames[currentFrame];
      lastFrameAt = time;
    }
    if (time > emotionUntil && emotionUntil) { emotionUntil = 0; robot.src = frames[currentFrame]; }
    if (root.isConnected) requestAnimationFrame(animate);
  }
  function toggle(open) {
    panel.classList.toggle('open', open);
    close.classList.toggle('open', open);
    launcher.setAttribute('aria-expanded', String(open));
    if (official) {
      try { if (open) sessionStorage.setItem(openKey, channel); else sessionStorage.removeItem(openKey); } catch {}
      if (!open) {
        try { chrome.runtime.sendMessage({ type: 'polyv-assistant:closed' }); } catch {}
      }
    }
    if (open) frame.focus(); else launcher.focus();
  }
  launcher.onclick = () => toggle(!panel.classList.contains('open'));
  close.onclick = () => toggle(false);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && panel.classList.contains('open')) toggle(false); });
  window.addEventListener('message', event => {
    if (event.origin !== base.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'polyv-assistant:working') launcher.classList.toggle('working', Boolean(event.data.working));
    if (event.data?.type === 'polyv-assistant:saved') {
      robot.src = asset('happy.png'); emotionUntil = performance.now() + 2500;
      window.dispatchEvent(new CustomEvent('polyv-assistant:saved', { detail: event.data.detail }));
      if (!refreshing && event.data.detail?.saved?.mode === 'polyv' && /\.polyv\.(?:net|cn|com)$/i.test(location.hostname)) {
        refreshing = true;
        setTimeout(() => location.reload(), 1200);
      }
    }
    if (event.data?.type === 'polyv-assistant:close') toggle(false);
  });
  shadow.append(style, panel, launcher, close);
  document.body.append(root);
  requestAnimationFrame(animate);
  if (official) {
    toggle(true);
    if (channel) {
      const route = new RegExp(`(?:^|[/#])channel/${channel}(?=/|[?#]|$)`);
      const watch = setInterval(() => {
        if (!root.isConnected || !route.test(location.href)) {
          try { sessionStorage.removeItem(openKey); } catch {}
          root.remove();
          clearInterval(watch);
        }
      }, 1000);
    }
  }
})();
