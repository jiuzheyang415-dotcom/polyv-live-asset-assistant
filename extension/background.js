const assistantBase = 'http://127.0.0.1:8765';
const tabKey = tabId => `polyv-assistant-open-tab-${tabId}`;

async function openInTab(tabId, channelId) {
  await chrome.scripting.executeScript({ target: { tabId }, func: channel => {
    sessionStorage.setItem('polyv-assistant-open-channel', channel);
  }, args: [channelId] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['embed.js'] });
}

async function showMessage(tabId, message) {
  await chrome.scripting.executeScript({ target: { tabId }, func: text => window.alert(text), args: [message] });
}

async function matchingChannel(tabId, channelIds) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: allowed => {
      const channel = location.href.match(/(?:^|[/#])channel\/(\d+)(?=\/|[?#]|$)/)?.[1];
      return channel && allowed.includes(channel) ? channel : null;
    },
    args: [channelIds]
  });
  return result || null;
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !/^https:\/\/[^/]*\.polyv\.(?:net|cn|com)\//i.test(tab.url || '')) {
    if (tab.id) await showMessage(tab.id, '请先打开保利威正式频道后台页面。');
    return;
  }
  let health;
  try {
    const response = await fetch(`${assistantBase}/health`);
    if (!response.ok) throw new Error('本地服务未就绪');
    health = await response.json();
  } catch {
    await showMessage(tab.id, '无法连接本地助手。请先在项目目录运行 npm start。');
    return;
  }
  const channelIds = health.channelIds || (health.channelId ? [health.channelId] : []);
  if (health.demoMode || health.saveMode !== 'polyv' || !channelIds.length) {
    await showMessage(tab.id, '请将本地助手配置为正式频道保存模式，并设置目标频道号。');
    return;
  }
  const channelId = await matchingChannel(tab.id, channelIds);
  if (!channelId) {
    await showMessage(tab.id, `当前页面未检测到已配置的频道号 ${channelIds.join('、')}，挂件不会打开。`);
    return;
  }
  await chrome.storage.session.set({ [tabKey(tab.id)]: channelId });
  await openInTab(tab.id, channelId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const key = tabKey(tabId);
  const channelId = (await chrome.storage.session.get(key))[key];
  if (!channelId || !tab.url) return;
  const channel = tab.url.match(/(?:^|[/#])channel\/(\d+)(?=\/|[?#]|$)/)?.[1];
  if (channel && channel !== channelId) {
    await chrome.storage.session.remove(key);
    return;
  }
  if (channel === channelId && /^https:\/\/[^/]*\.polyv\.(?:net|cn|com)\//i.test(tab.url)) {
    try { await openInTab(tabId, channelId); } catch { /* The tab may have navigated away. */ }
  }
});

chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(tabKey(tabId)));

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'polyv-assistant:closed' && sender.tab?.id) {
    void chrome.storage.session.remove(tabKey(sender.tab.id));
  }
});
