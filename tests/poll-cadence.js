/**
 * How much does an idle CivitAI tab talk to the worker?
 *
 * Nothing is downloading, so there is nothing to show — yet the poll used to
 * run at the same 2s beat as an active transfer, waking the service worker (and
 * the worker then makes its own server requests) for every open tab.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const pup = require('C:/Users/ASUS/AppData/Local/npm-cache/_npx/23232c69e5d221f3/node_modules/puppeteer-core');

const CS = fs.readFileSync(process.env.LB_CS || 'D:/Workbench/Lora_manager/lora-manager-edge-extension/content-script.js', 'utf8');
const CSS = fs.readFileSync('D:/Workbench/Lora_manager/lora-manager-edge-extension/content-style.css', 'utf8');
const PORT = 8793;

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="mantine-Stack-root"><h1 class="mantine-Title-root">Model</h1></div>
</body></html>`;

const boot = `
(() => {
  window.__msgs = [];
  const dual = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    const p = new Promise((r) => fn(...a, r));
    if (cb) { p.then(cb); return undefined; }
    return p;
  };
  window.chrome = {
    runtime: { lastError: null,
      sendMessage: dual((msg, done) => {
        if (msg.type === 'ACTIVE_DOWNLOADS' || msg.type === 'CLAIM_NOTICES') window.__msgs.push({ t: Date.now(), type: msg.type });
        setTimeout(() => {
          if (msg.type === 'ACTIVE_DOWNLOADS') return done({ success: true, downloads: [] });
          if (msg.type === 'CLAIM_NOTICES') return done({ success: true, notices: [] });
          if (msg.type === 'CHECK_MODEL') return done({ found: false, hasAnyVersion: false, foundTypes: [], versions: [], matchedVersion: null });
          done({ success: true });
        }, 0);
      }),
      onMessage: { addListener: () => {} } },
    storage: { sync: { get: dual((k, done) => done({ config: {} })) }, onChanged: { addListener: () => {} } },
  };
})();`;

(async () => {
  const srv = http.createServer((q, r) => {
    if (q.url === '/cs.js') { r.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); r.end(CS); return; }
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(PAGE);
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const b = await pup.launch({
    executablePath: 'C:/Users/ASUS/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
    headless: true, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP civitai.com 127.0.0.1'],
  });
  const page = await b.newPage();
  await page.evaluateOnNewDocument(boot);
  await page.goto(`http://civitai.com:${PORT}/models/999?modelVersionId=999000`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/cs.js' });
  await sleep(1500);

  // ── Idle, visible ──────────────────────────────────────────────────────
  await page.evaluate(() => { window.__msgs = []; });
  await sleep(24000);
  const idle = await page.evaluate(() => window.__msgs);
  const idlePerMsg = idle.length / 2;   // two messages per poll
  console.log(`\n  空闲可见 24 秒：${idle.length} 条消息 ≈ ${idlePerMsg.toFixed(1)} 次轮询（旧版固定 2 秒 → 约 12 次）`);

  // ── Idle, hidden ───────────────────────────────────────────────────────
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    window.__msgs = [];
  });
  await sleep(24000);
  const hidden = await page.evaluate(() => window.__msgs);
  console.log(`  空闲隐藏 24 秒：${hidden.length} 条消息 ≈ ${(hidden.length / 2).toFixed(1)} 次轮询`);

  console.log('\n[1] 空闲时不该用和下载中一样的频率去问');
  check('可见空闲时轮询明显少于 12 次', idlePerMsg <= 6,
    `24 秒内 ${idlePerMsg.toFixed(1)} 次 —— 旧版是 12 次`);
  check('隐藏时轮询进一步减少', hidden.length / 2 <= 2.5,
    `24 秒内 ${(hidden.length / 2).toFixed(1)} 次`);

  await page.close();
  await b.close();
  srv.close();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
