/**
 * The bubble rebuilds itself with innerHTML every 2s while a download runs.
 * Those are DOM insertions — the observer must not mistake them for page
 * mutations and schedule a scan of the whole list on every poll.
 *
 * Scans are counted by spying on the link query findCardLinks() uses.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const pup = require('C:/Users/ASUS/AppData/Local/npm-cache/_npx/23232c69e5d221f3/node_modules/puppeteer-core');

const EXT = 'D:/Workbench/Lora_manager/lora-manager-edge-extension';
const CS = fs.readFileSync(process.env.LB_CS || path.join(EXT, 'content-script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(EXT, 'content-style.css'), 'utf8');
const PORT = 8789;

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
  window.__scans = 0;
  window.__polls = 0;
  const origQSA = Document.prototype.querySelectorAll;
  Document.prototype.querySelectorAll = function (sel) {
    if (String(sel).includes('linkOrClick')) window.__scans++;
    return origQSA.call(this, sel);
  };
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
          const results = {};
          for (const id of msg.payload.modelIds) results[id] = hit(id);
          return done({ results, ok: true });
        }
        if (msg.type === 'ACTIVE_DOWNLOADS') {
          window.__polls++;
          return done({ success: true, downloads: [{
            downloadId: 'dl-1', modelId: 2356447, label: 'Granblue',
            progress: 10 + window.__polls, bytesDownloaded: 1000 * window.__polls,
            totalBytes: 4000000, bytesPerSecond: 8000000, stalled: false,
          }] });
        }
        if (msg.type === 'CLAIM_NOTICES') return done({ success: true, notices: [] });
        done({ success: true });
      }, 0)),
      onMessage: { addListener: () => {} } },
    storage: { sync: { get: dual((k, done) => done({ config: {} })) }, onChanged: { addListener: () => {} } },
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
  await sleep(2000);

  const badges = await page.evaluate(() => document.querySelectorAll('.lb-card-badge').length);
  const s0 = await page.evaluate(() => ({ scans: window.__scans, polls: window.__polls }));
  console.log(`\n  初始：${badges} 个徽章，${s0.scans} 次扫描，${s0.polls} 次进度轮询`);

  // 12 秒 ≈ 6 次气泡重建
  await sleep(12000);
  const s1 = await page.evaluate(() => ({ scans: window.__scans, polls: window.__polls }));
  const rows = await page.evaluate(() => document.querySelectorAll('.lb-bubble-item').length);
  console.log(`  12 秒后：${s1.scans} 次扫描，${s1.polls} 次进度轮询，气泡 ${rows} 行`);

  console.log('\n[1] 气泡自身的 DOM 重建不得触发列表扫描');
  check('气泡确实在轮询并重建（前提成立）', s1.polls >= s0.polls + 4, `轮询 ${s0.polls} → ${s1.polls}`);
  check('轮询期间没有额外的列表扫描',
    s1.scans <= s0.scans + 1, `扫描 ${s0.scans} → ${s1.scans}（每次轮询触发一次扫描就是本测试要抓的缺陷）`);

  await page.close();
  await b.close();
  srv.close();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
