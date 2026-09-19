/**
 * LoRA Manager Bridge - Options Page Script
 *
 * Manages extension configuration: ComfyUI host, cache settings, test connectivity.
 */

const DEFAULT_CONFIG = {
  comfyUIHost: 'http://127.0.0.1:8188',
  cacheTTLMs: 30000,
};

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('settings-form');
  const hostInput = document.getElementById('comfyUIHost');
  const cacheInput = document.getElementById('cacheTTLMs');
  const btnTest = document.getElementById('btn-test');
  const testResult = document.getElementById('test-result');
  const btnClearCache = document.getElementById('btn-clear-cache');

  // ── Version footer (kept in sync with manifest.json) ───────────────────

  document.getElementById('app-version').textContent =
    chrome.runtime.getManifest().version;

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
