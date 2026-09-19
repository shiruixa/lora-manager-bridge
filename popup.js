/**
 * LoRA Manager Bridge - Popup Script
 *
 * Quick status: connectivity, library size (LoRA + Checkpoint), page context.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('server-status');
  const countEl = document.getElementById('lora-count');
  const typeCountEl = document.getElementById('type-count');
  const pageEl = document.getElementById('current-page');

  // ── Check ComfyUI connectivity ─────────────────────────────────────────

  let connected = false;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'CHECK_CONNECTIVITY',
    });
    if (result && result.connected) {
      statusEl.textContent = '✅ 已连接';
      statusEl.className = 'status-value status--connected';
      connected = true;
    } else {
      statusEl.textContent = '❌ 未连接';
      statusEl.className = 'status-value status--disconnected';
    }
  } catch (e) {
    statusEl.textContent = '❌ 无法通信';
    statusEl.className = 'status-value status--disconnected';
  }

  // ── Get library summary ────────────────────────────────────────────────

  try {
    const summary = await chrome.runtime.sendMessage({
      type: 'GET_LIBRARY_SUMMARY',
    });

    if (summary && summary.connected) {
      const total = summary.total != null ? summary.total : 0;
      countEl.textContent = `${total} 个`;
      // Per-type counts from summary
      if (summary.loraCount != null && summary.checkpointCount != null) {
        typeCountEl.textContent = `${summary.loraCount} / ${summary.checkpointCount}`;
      } else {
        typeCountEl.textContent = total > 0 ? `${total} 个模型` : '--';
      }
    } else {
      countEl.textContent = '不可用';
      typeCountEl.textContent = '--';
    }
  } catch (e) {
    countEl.textContent = '加载失败';
    typeCountEl.textContent = '--';
  }

  // ── Get current tab info ───────────────────────────────────────────────

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = new URL(tab.url);
      if (url.hostname.includes('civitai')) {
        const pathMatch = url.pathname.match(/\/models\/(\d+)/);
        if (pathMatch) {
          pageEl.textContent = `模型 #${pathMatch[1]}`;
        } else if (url.pathname.includes('/model-versions/')) {
          const vMatch = url.pathname.match(/\/model-versions\/(\d+)/);
          pageEl.textContent = vMatch ? `版本 #${vMatch[1]}` : '模型版本页';
        } else if (url.pathname === '/models' || url.pathname === '/search/models' || url.pathname === '/') {
          pageEl.textContent = '模型列表/搜索';
        } else {
          pageEl.textContent = 'CivitAI';
        }
      } else {
        pageEl.textContent = '非 CivitAI 页面';
      }
    }
  } catch (e) {
    pageEl.textContent = '--';
  }

  // ── Button handlers ────────────────────────────────────────────────────

  /**
   * Send a message to the tab's content script.
   * Resolves null when nothing is listening there.
   */
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

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      // Ask the content script to re-check in place. Falls back to a reload
      // when it isn't there (non-CivitAI page, or injected before an update).
      const res = await sendToTab(tab.id, { type: 'RESCAN' });
      if (!res || !res.ok) {
        await chrome.tabs.reload(tab.id);
      }
    } catch (e) {
      console.error('[LoraBridge] Failed to refresh tab:', e);
    } finally {
      window.close();
    }
  });

  document.getElementById('btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
