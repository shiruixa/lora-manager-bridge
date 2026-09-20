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
      // Every tracked library, in a stable order, so the parts always add up to
      // the total. Libraries the server doesn't have simply are not present.
      const c = summary.counts || {};
      const parts = ['lora', 'checkpoint', 'embedding', 'other']
        .filter((k) => c[k] != null)
        .map((k) => String(c[k]));
      typeCountEl.textContent = parts.length ? parts.join(' / ') : '--';
    } else {
      countEl.textContent = '不可用';
      typeCountEl.textContent = '--';
    }
  } catch (e) {
    countEl.textContent = '加载失败';
    typeCountEl.textContent = '--';
  }

  // ── Download log ───────────────────────────────────────────────────────
  //
  // The in-page bubble only exists in the tab that started a download, so
  // switching tabs loses it. The popup is the surface that works from ANY tab
  // and any site — which makes it the reliable place to look. It behaves like a
  // log: running transfers update in place, finished ones append and stay put
  // for the life of the popup.

  const logEntries = [];        // newest first; running rows are rebuilt each poll
  const LOG_MAX = 15;

  // Past outcomes come from the worker, not from what this popup happens to
  // have seen — otherwise closing and reopening the popup would show an empty
  // log, and the results would be gone for good.
  let pastEntries = [];

  function renderLog() {
    const el = document.getElementById('notices');
    const listEl = document.getElementById('notices-list');
    const countEl = document.getElementById('notices-count');

    // Running transfers first, then the durable history behind them.
    const rows = [
      ...logEntries,
      ...pastEntries.map((h) => ({
        kind: 'done',
        ok: h.ok,
        label: h.ok === false ? friendly(h.error)
             : h.ok === true ? (h.note || h.fileName || '下载完成')
             : '下载已结束，请到 LoRA Manager 确认',
        at: h.at,
      })),
    ].slice(0, LOG_MAX);

    if (!rows.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const running = rows.filter((e) => e.kind === 'active').length;
    countEl.textContent = running ? `进行中 ${running}` : '';

    listEl.innerHTML = rows.map((e) => {
      const time = e.at ? fmtTime(e.at) : '';
      if (e.kind === 'active') {
        const hasNumbers = e.progress != null;
        const p = hasNumbers ? Math.max(0, Math.min(100, Math.round(e.progress))) : 0;
        const meta = hasNumbers
          ? [e.speed ? fmtBytes(e.speed) + '/s' : '', e.total ? fmtBytes(e.done) + ' / ' + fmtBytes(e.total) : '']
              .filter(Boolean).join(' · ')
          : '等待服务器开始传输…';
        return '<li class="notice notice--active">' +
          '<span class="notice-icon">⬇️</span>' +
          '<span class="notice-text">' +
            '<span class="notice-name">' + escapeHtml(e.label) + '</span>' +
            '<span class="notice-bar"><i style="width:' + p + '%"></i></span>' +
            '<span class="notice-meta">' + (hasNumbers ? p + '%' : '准备中…') +
              (meta ? ' · ' + escapeHtml(meta) : '') + '</span>' +
          '</span>' +
          (time ? '<span class="notice-time">' + time + '</span>' : '') +
          '</li>';
      }
      const look = {
        true: { cls: 'notice--ok', icon: '✅' },
        false: { cls: 'notice--err', icon: '❌' },
        null: { cls: 'notice--unknown', icon: '⏳' },
      };
      const L = look[String(e.ok)] || look.null;
      return '<li class="notice ' + L.cls + '">' +
        '<span class="notice-icon">' + L.icon + '</span>' +
        '<span class="notice-text">' + escapeHtml(e.label) + '</span>' +
        (time ? '<span class="notice-time">' + time + '</span>' : '') +
        '</li>';
    }).join('');

    if (logEntries.length > LOG_MAX) logEntries.length = LOG_MAX;
  }

  // Running transfers update their existing row rather than piling up.
  async function pollDownloadLog() {
    try {
      const [active, , past] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'ACTIVE_DOWNLOADS' }),
        // Claimed only to clear the toolbar badge. The rows come from the
        // history below instead, so a result is not listed twice.
        chrome.runtime.sendMessage({ type: 'CLAIM_NOTICES' }),
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_HISTORY' }),
      ]);

      pastEntries = (past && past.history) || [];

      const running = (active && active.downloads) || [];
      const seen = new Set();
      for (const d of running) {
        seen.add(d.downloadId);
        const existing = logEntries.find((e) => e.kind === 'active' && e.id === d.downloadId);
        const row = {
          kind: 'active',
          id: d.downloadId,
          label: d.modelName || ('模型 ' + (d.modelId ?? '?')),
          progress: d.progress,
          speed: d.bytesPerSecond,
          done: d.bytesDownloaded,
          total: d.totalBytes,
          at: existing ? existing.at : Date.now(),
        };
        if (existing) Object.assign(existing, row);
        else logEntries.unshift(row);
      }
      // Anything no longer running leaves the active rows. Its outcome is not
      // lost: it is already in the history the worker keeps.
      for (let i = logEntries.length - 1; i >= 0; i--) {
        const e = logEntries[i];
        if (e.kind === 'active' && !seen.has(e.id)) logEntries.splice(i, 1);
      }

      renderLog();
    } catch (e) { /* the log is best-effort */ }
  }

  /** Server wording, phrased for someone who does not know where to look. */
  function friendly(msg) {
    const s = String(msg || '');
    if (/default \w+ root path not set/i.test(s)) return '请先在 LoRA Manager 设置里指定默认模型目录';
    if (/early access/i.test(s)) return '该模型需付费早期访问，暂时无法下载';
    if (/already exists/i.test(s)) return '该模型已在库中';
    return s || '下载失败';
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  pollDownloadLog();
  // Live while the popup is open — that is the whole point of putting it here.
  const logTimer = setInterval(pollDownloadLog, 1200);
  window.addEventListener('unload', () => clearInterval(logTimer));

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

  /** Download outcomes come from the server and may contain arbitrary text. */
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

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
