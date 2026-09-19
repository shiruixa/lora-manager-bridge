/**
 * LoRA Manager Bridge - Popup Script
 *
 * Quick status: connectivity, library size, what the extension has done on the
 * current page, and shortcuts.
 */

const PAGE_TYPE_LABEL = {
  detail: '模型详情页',
  version: '模型版本页',
  list: '模型列表/搜索',
  other: '其它 CivitAI 页面',
};

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('server-status');
  const countEl = document.getElementById('lora-count');
  const typeCountEl = document.getElementById('type-count');
  const pageEl = document.getElementById('current-page');
  const pageStatusRow = document.getElementById('page-status-row');
  const pageStatusEl = document.getElementById('page-status');
  const hintEl = document.getElementById('hint');
  const refreshBtn = document.getElementById('btn-refresh');
  const openLmBtn = document.getElementById('btn-open-lm');

  const showHint = (text) => {
    hintEl.textContent = text;
    hintEl.hidden = !text;
  };

  // ── Current tab (needed by several rows below) ─────────────────────────

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { /* leave tab null */ }

  // `tab.url` is only readable with the `tabs` permission or a matching host
  // permission — neither of which this extension wants. So the content script
  // is the authority on what page this is; the URL is a best-effort extra.
  let pageStatus = null;
  if (tab) pageStatus = await sendToTab(tab.id, { type: 'PAGE_STATUS' });
  const scriptAlive = !!(pageStatus && pageStatus.ok);

  let url = null;
  try {
    if (tab && tab.url) url = new URL(tab.url);
  } catch (e) { /* URL may be unreadable; the content script covers us */ }

  const isCivitaiUrl = !!url && /civitai/.test(url.hostname);
  const isSupportedPage = scriptAlive || isCivitaiUrl;

  // ── ComfyUI connectivity ───────────────────────────────────────────────

  try {
    const result = await chrome.runtime.sendMessage({ type: 'CHECK_CONNECTIVITY' });
    if (result && result.connected) {
      statusEl.textContent = '✅ 已连接';
      statusEl.className = 'status-value status--connected';
    } else {
      statusEl.textContent = '❌ 未连接';
      statusEl.className = 'status-value status--disconnected';
      showHint('ComfyUI 未运行，或设置里的地址不对。页面上的标记无法显示。');
    }
  } catch (e) {
    statusEl.textContent = '❌ 无法通信';
    statusEl.className = 'status-value status--disconnected';
  }

  // ── Library size ───────────────────────────────────────────────────────

  try {
    const summary = await chrome.runtime.sendMessage({ type: 'GET_LIBRARY_SUMMARY' });

    if (summary && summary.connected) {
      countEl.textContent = `${summary.total != null ? summary.total : 0} 个`;
      // Every tracked type, so the parts always add up to the total.
      const c = summary.counts || {};
      const parts = [c.lora, c.checkpoint, c.embedding]
        .filter((n) => n != null)
        .map((n) => String(n));
      typeCountEl.textContent = parts.length ? parts.join(' / ') : '--';
    } else {
      countEl.textContent = '不可用';
      typeCountEl.textContent = '--';
    }
  } catch (e) {
    countEl.textContent = '加载失败';
    typeCountEl.textContent = '--';
  }

  // ── What this page looks like to the extension ─────────────────────────

  if (scriptAlive) {
    // The content script knows exactly what page this is.
    pageEl.textContent = describePage(pageStatus);
    pageStatusRow.hidden = false;
    if (pageStatus.inline) {
      pageStatusEl.textContent = pageStatus.inline;
    } else if (pageStatus.badged > 0) {
      pageStatusEl.textContent = `✅ ${pageStatus.badged} 个模型在库中`;
    } else if (pageStatus.pageType === 'list') {
      pageStatusEl.textContent = '未发现已入库的模型';
    } else {
      pageStatusEl.textContent = '暂无标记';
    }
  } else if (url) {
    // No script, but we can at least tell whether the page is even relevant.
    pageEl.textContent = isCivitaiUrl ? 'CivitAI（脚本未注入）' : '非 CivitAI 页面';
    if (!isCivitaiUrl) showHint('打开 CivitAI 模型页面后，这里会显示标记情况。');
  } else {
    pageEl.textContent = '--';
    showHint('读不到这个标签页的信息，无法判断它是不是 CivitAI 页面。');
  }

  // ── Buttons ────────────────────────────────────────────────────────────

  // Two genuinely different situations, so two different buttons:
  //   - the content script answers  → re-check in place, page untouched
  //   - it does not (tab predates the last extension update) → the only fix is
  //     a page load, offered as an explicit, labelled action rather than a
  //     reload that happens behind the user's back.
  if (!isSupportedPage) {
    // Don't claim "not CivitAI" when we simply cannot tell — say what we know.
    refreshBtn.disabled = true;
    refreshBtn.textContent = url
      ? '🔄 重新检查本页（仅限 CivitAI）'
      : '🔄 无法识别当前页面';
  } else if (!scriptAlive) {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '🔄 刷新本页以启用';
    refreshBtn.classList.add('btn-warn');
    showHint('这个标签页还是在扩展更新之前打开的，里面的脚本是旧版本。点上面的按钮刷新一次即可恢复正常。');
  } else {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '🔄 重新检查本页';
  }

  refreshBtn.addEventListener('click', async () => {
    if (!tab || refreshBtn.disabled) return;

    if (!scriptAlive) {
      // Explicit user-initiated reload; the button says exactly what it does.
      refreshBtn.disabled = true;
      refreshBtn.textContent = '⏳ 刷新中…';
      await chrome.tabs.reload(tab.id);
      window.close();
      return;
    }

    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳ 重新检查中…';
    const res = await sendToTab(tab.id, { type: 'RESCAN' });
    if (res && res.ok) {
      refreshBtn.textContent = '✅ 已重新检查';
      setTimeout(() => window.close(), 600);
    } else {
      // It answered a moment ago but not now — treat as a stale page.
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 刷新本页以启用';
      refreshBtn.classList.add('btn-warn');
      showHint('内容脚本没有响应。刷新一次该页面即可恢复。');
    }
  });

  openLmBtn.addEventListener('click', async () => {
    const host = await getComfyHost();
    chrome.tabs.create({ url: `${host}/loras` });
    window.close();
  });

  // Open the options page as a plain tab. openOptionsPage() with
  // open_in_tab:false lands the user on edge://extensions instead of the
  // settings, which reads as a bug.
  document.getElementById('btn-options').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    window.close();
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Human-readable page description, from the content script's own view. */
  function describePage(s) {
    if (s.pageType === 'detail') return s.modelId ? `模型 #${s.modelId}` : '模型详情页';
    if (s.pageType === 'version') return s.versionId ? `版本 #${s.versionId}` : '模型版本页';
    if (s.pageType === 'list') return '模型列表/搜索';
    return 'CivitAI';
  }

  /** Send a message to a tab's content script; null when nothing listens. */
  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          resolve(chrome.runtime.lastError ? null : (response ?? null));
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function getComfyHost() {
    try {
      const stored = await chrome.storage.sync.get('config');
      const host = stored && stored.config && stored.config.comfyUIHost;
      if (host) return host.replace(/\/+$/, '');
    } catch (e) { /* fall through */ }
    return 'http://127.0.0.1:8188';
  }
});
