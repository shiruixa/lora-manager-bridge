/**
 * LoRA Manager Bridge - Options Page Script
 *
 * Manages extension configuration: ComfyUI host, cache settings, test connectivity.
 */

const DEFAULT_CONFIG = {
  comfyUIHost: 'http://127.0.0.1:8188',
  cacheTTLMs: 30000,
  enableDownloads: true,   // must match the default in content-script.js
};

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('settings-form');
  const hostInput = document.getElementById('comfyUIHost');
  const cacheInput = document.getElementById('cacheTTLMs');
  const btnTest = document.getElementById('btn-test');
  const testResult = document.getElementById('test-result');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const downloadsInput = document.getElementById('enableDownloads');

  // ── Version footer (kept in sync with manifest.json) ───────────────────

  document.getElementById('app-version').textContent =
    chrome.runtime.getManifest().version;

  // ── CivitAI API key status ─────────────────────────────────────────────
  //
  // The key lives in LoRA Manager and only LoRA Manager can write it (its
  // settings endpoint is POST-only, which ComfyUI's origin check rejects for
  // extensions). So this reports and links rather than offering an input that
  // could never work.

  const keyStatusEl = document.getElementById('api-key-status');
  const btnOpenLmSettings = document.getElementById('btn-open-lm-settings');

  async function refreshKeyStatus() {
    try {
      const summary = await chrome.runtime.sendMessage({ type: 'GET_LIBRARY_SUMMARY' });

      if (!summary || !summary.connected) {
        keyStatusEl.textContent = 'ComfyUI 未连接，无法检测';
        keyStatusEl.className = 'key-status-value key-status--unknown';
        return;
      }
      if (summary.apiKeySet === null) {
        keyStatusEl.textContent = '该版本未上报此项，请手动到 LoRA Manager 里确认';
        keyStatusEl.className = 'key-status-value key-status--unknown';
        return;
      }
      if (summary.apiKeySet) {
        keyStatusEl.textContent = '✅ 已配置';
        keyStatusEl.className = 'key-status-value key-status--ok';
      } else {
        keyStatusEl.textContent = '⚠️ 未配置 —— 下载模型会失败';
        keyStatusEl.className = 'key-status-value key-status--missing';
      }
    } catch (e) {
      keyStatusEl.textContent = '检测失败';
      keyStatusEl.className = 'key-status-value key-status--unknown';
    }
  }

  btnOpenLmSettings.addEventListener('click', () => {
    const host = hostInput.value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8188';
    // tabs.create is more reliable than window.open from an options page.
    chrome.tabs.create({ url: `${host}/loras` });
  });

  refreshKeyStatus();

  // ── Load current config ────────────────────────────────────────────────

  let config = { ...DEFAULT_CONFIG };
  try {
    const stored = await chrome.storage.sync.get('config');
    if (stored && stored.config) {
      config = { ...DEFAULT_CONFIG, ...stored.config };
    }
  } catch (e) {
    console.warn('[LoraBridge Options] Failed to load config:', e);
  }

  hostInput.value = config.comfyUIHost;
  cacheInput.value = String(config.cacheTTLMs);
  downloadsInput.checked = config.enableDownloads !== false;

  // ── Test connectivity ──────────────────────────────────────────────────

  btnTest.addEventListener('click', async () => {
    const host = hostInput.value.trim() || 'http://127.0.0.1:8188';
    testResult.textContent = '⏳ 测试中...';
    testResult.className = 'test-result test-result--pending';

    try {
      // We use a direct fetch from the options page (it has host permissions)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${host.replace(/\/+$/, '')}/api/lm/loras/list?page_size=1`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        testResult.textContent = `✅ 连接成功！库中有 ${data?.total ?? '?'} 个 LoRA`;
        testResult.className = 'test-result test-result--success';
      } else {
        testResult.textContent = `❌ 服务器响应错误 (HTTP ${response.status})`;
        testResult.className = 'test-result test-result--error';
      }
    } catch (e) {
      testResult.textContent = '❌ 无法连接。请确认 ComfyUI 正在运行且地址正确。';
      testResult.className = 'test-result test-result--error';
    }
  });

  // ── Save config ────────────────────────────────────────────────────────

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const newConfig = {
      comfyUIHost: hostInput.value.trim() || 'http://127.0.0.1:8188',
      cacheTTLMs: Math.max(1000, Math.min(300000, parseInt(cacheInput.value, 10) || 30000)),
      enableDownloads: downloadsInput.checked,
    };

    try {
      await chrome.storage.sync.set({ config: newConfig });

      // Notify background worker to clear cache
      await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });

      showToast('✅ 设置已保存');
    } catch (e) {
      showToast('❌ 保存失败: ' + e.message);
    }
  });

  // ── Clear cache ────────────────────────────────────────────────────────

  btnClearCache.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      showToast('🗑️ 缓存已清除');
    } catch (e) {
      showToast('❌ 清除缓存失败');
    }
  });

  // ── Toast helper ───────────────────────────────────────────────────────

  function showToast(message) {
    // Remove existing toast
    const existing = document.querySelector('.lora-bridge-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'lora-bridge-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      padding: 10px 24px; border-radius: 8px; font-weight: 600; font-size: 14px;
      background: #2d3748; color: #e0e0e0; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      z-index: 9999; animation: toast-in 0.3s ease-out;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }
});
