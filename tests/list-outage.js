/**
 * ComfyUI down: the list page must be completely still, then recover on its own.
 *
 * Phase 1 (server down, 25s): no spinner may appear on any card, and scans must
 * not happen more often than one probe per 20s.
 * Phase 2 (server comes up): badges appear without a page refresh, and the
 * successful pass stops the loop instead of starting one.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const pup = require('C:/Users/ASUS/AppData/Local/npm-cache/_npx/23232c69e5d221f3/node_modules/puppeteer-core');

const EXT = 'D:/Workbench/Lora_manager/lora-manager-edge-extension';
const CS = fs.readFileSync(process.env.LB_CS || path.join(EXT, 'content-script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(EXT, 'content-style.css'), 'utf8');
const PORT = 8788;

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const card = (id) => `
  <div style="aspect-ratio:7/9">
    <div class="rounded-lg shadow-md flex-col" style="width:200px;height:260px">
      <div class="AspectRatioCard-x__content">
        <a class="AspectRatioImageCard-x__linkOrClick" href="/models/${id}?modelVersionId=${id}00"
           style="display:block;width:200px;height:250px"></a>
      </div>
    </div>
  </div>`;
const LIST = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div id="grid">${[111, 222, 333].map(card).join('')}</div></body></html>`;

const boot = `
(() => {
  window.__serverUp = false;
  window.__overlayAdds = 0;
  window.__batches = 0;
  window.__batchTimes = [];
  const dual = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    const p = new Promise((r) => fn(...a, r));
    if (cb) { p.then(cb); return undefined; }
    return p;
  };
  const hit = (id) => ({ found: true, foundTypes: ['lora'], versionCount: 1, names: [id + '.safetensors'] });
  window.chrome = {
    runtime: { lastError: null,
      sendMessage: dual((msg, done) => setTimeout(() => {
        if (msg.type === 'CHECK_MODELS_BATCH') {
          window.__batches++;
          window.__batchTimes.push(Date.now());
          if (!window.__serverUp) return done({ results: {}, ok: false });
          const results = {};
          for (const id of msg.payload.modelIds) results[id] = hit(id);
          return done({ results, ok: true });
        }
        if (msg.type === 'ACTIVE_DOWNLOADS') return done({ success: true, downloads: [] });
        if (msg.type === 'CLAIM_NOTICES') return done({ success: true, notices: [] });
        if (msg.type === 'CHECK_MODEL') return done({ found: false, hasAnyVersion: false, foundTypes: [], versions: [], matchedVersion: null, unreachable: true });
        done({ success: true });
      }, 0)),
      onMessage: { addListener: () => {} } },
    storage: { sync: { get: dual((k, done) => done({ config: {} })) }, onChanged: { addListener: () => {} } },
  };
  const origAppend = Element.prototype.appendChild;
  Element.prototype.appendChild = function (child) {
    if (child && child.classList && child.classList.contains('lb-card-ovl')) window.__overlayAdds++;
    return origAppend.call(this, child);
  };
})();`;

(async () => {
  const srv = http.createServer((q, r) => {
    if (q.url === '/cs.js') { r.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); r.end(CS); return; }
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(LIST);
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const b = await pup.launch({
    executablePath: 'C:/Users/ASUS/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
    headless: true, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP civitai.com 127.0.0.1'],
  });

  const page = await b.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.evaluateOnNewDocument(boot);
  page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); failures++; });
  await page.goto(`http://civitai.com:${PORT}/models`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/cs.js' });

  // ── Phase 1: server down ──────────────────────────────────────────────
  await sleep(3000);
  const a = await page.evaluate(() => ({ ovl: window.__overlayAdds, batches: window.__batches }));

  let peakOvl = 0;
  for (let i = 0; i < 9; i++) {           // sample every 2.5s for ~22s
    await sleep(2500);
    const n = await page.evaluate(() => document.querySelectorAll('.lb-card-ovl').length);
    if (n > peakOvl) peakOvl = n;
  }
  const c = await page.evaluate(() => ({ ovl: window.__overlayAdds, batches: window.__batches }));

  console.log(`\n  服务器不可用 25 秒：遮罩插入 ${a.ovl} → ${c.ovl}，批量请求 ${a.batches} → ${c.batches}`);

  console.log('\n[1] ComfyUI 没启动时页面必须完全静止');
  check('探测期间没有任何遮罩出现', peakOvl === 0, `观察到的最大遮罩数 ${peakOvl}（每次探测都给所有卡片盖 ⏳ 就是「一直闪」）`);
  check('遮罩插入不再随重试增长', c.ovl <= a.ovl, `${a.ovl} → ${c.ovl}`);
  check('批量请求不超过「每 20 秒一次探测」',
    c.batches <= a.batches + 2, `${a.batches} → ${c.batches}（25 秒最多 1 次探测，留 1 次余量）`);
  check('页面上没有残留遮罩', await page.evaluate(() => document.querySelectorAll('.lb-card-ovl').length) === 0, '有残留');

  // ── Phase 2: server starts ────────────────────────────────────────────
  console.log('\n[2] 启动 ComfyUI 后应自行恢复（不刷新页面）');
  await page.evaluate(() => { window.__serverUp = true; });
  await sleep(24000);

  const badges = await page.evaluate(() => document.querySelectorAll('.lb-card-badge').length);
  const stuck = await page.evaluate(() => document.querySelectorAll('.lb-card-ovl').length);
  const done = await page.evaluate(() => document.querySelectorAll('[data-lb-done]').length);
  const after = await page.evaluate(() => window.__batches);

  check('三张卡片都出现徽章', badges === 3, `只有 ${badges} 个徽章`);
  check('没有卡住的遮罩', stuck === 0, `${stuck} 个遮罩残留`);
  check('卡片被标记为已完成', done === 3, `${done} 张被标记`);
  check('成功后不再继续扫描（没有自我维持的循环）',
    after <= c.batches + 3, `恢复后批量请求 ${c.batches} → ${after}`);

  await page.close();
  await b.close();
  srv.close();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
