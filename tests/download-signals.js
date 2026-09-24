/**
 * The two signals that answer "is this thing alive?":
 *   - elapsed time, which only ever counts up, even while bytes stall
 *   - a note when the byte count goes BACKWARDS (the server reconnected and is
 *     re-fetching from an earlier offset), so the bar doesn't appear to run
 *     backwards for no reason
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const pup = require('C:/Users/ASUS/AppData/Local/npm-cache/_npx/23232c69e5d221f3/node_modules/puppeteer-core');

const EXT = 'D:/Workbench/Lora_manager/lora-manager-edge-extension';
const CS = fs.readFileSync(process.env.LB_CS || path.join(EXT, 'content-script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(EXT, 'content-style.css'), 'utf8');
const PORT = 8794;

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="mantine-Stack-root"><h1 class="mantine-Title-root">Model</h1></div></body></html>`;

// The fake worker walks a scripted series of byte counts for one download.
const boot = `
(() => {
  window.__bytes = [1000000, 1400000, 1800000, 900000, 950000, 990000];
  window.__i = 0;
  // Fixed once, not recomputed per poll — otherwise "elapsed" never grows and
  // the test would pass without proving anything ticks.
  window.__started = Date.now() - 154000;
  const dual = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    const p = new Promise((r) => fn(...a, r));
    if (cb) { p.then(cb); return undefined; }
    return p;
  };
  window.chrome = {
    runtime: { lastError: null,
      sendMessage: dual((msg, done) => setTimeout(() => {
        if (msg.type === 'ACTIVE_DOWNLOADS') {
          const b = window.__bytes[Math.min(window.__i, window.__bytes.length - 1)];
          window.__i++;
          return done({ success: true, downloads: [{
            downloadId: 'dl-1', modelId: 1, versionId: 2, label: 'Test Model',
            startedAt: window.__started,
            progress: null, bytesDownloaded: b, totalBytes: 5000000, bytesPerSecond: 2000000,
          }] });
        }
        if (msg.type === 'CLAIM_NOTICES') return done({ success: true, notices: [] });
        if (msg.type === 'CHECK_MODEL') return done({ found: false, hasAnyVersion: false, foundTypes: [], versions: [], matchedVersion: null });
        done({ success: true });
      }, 0)),
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
  page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); failures++; });
  await page.goto(`http://civitai.com:${PORT}/models/1?modelVersionId=2`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/cs.js' });

  const read = () => page.evaluate(() => {
    const el = document.getElementById('lb-downloads');
    const item = el && el.querySelector('[data-lb-dl]');
    return {
      bubble: el && !el.hidden,
      meta: item ? (item.querySelector('.lb-bubble-meta') || {}).textContent || '' : '',
      note: item ? (item.querySelector('.lb-bubble-stall') || {}).textContent || '' : '',
      pct: item ? (item.querySelector('.lb-bubble-pct') || {}).textContent || '' : '',
    };
  });

  await sleep(2500);
  const s1 = await read();
  console.log(`\n  第 1 次读: 进度=${s1.pct}  meta="${s1.meta}"`);
  console.log(`  第 2 次读前，等 2.5 秒`);

  await sleep(2500);
  const s2 = await read();
  console.log(`  第 2 次读: 进度=${s2.pct}  meta="${s2.meta}"`);
  console.log(`  提示="${s2.note}"`);
  console.log(`  （字节序列 1.0 → 1.4 → 1.8 → 0.9 MB，第 4 次轮询才倒退，继续等）`);

  // The backwards jump is the 4th poll, ~8s in.
  await sleep(6000);
  const s3 = await read();
  console.log(`  第 3 次读: 进度=${s3.pct}  meta="${s3.meta}"`);
  console.log(`  提示="${s3.note}"`);

  console.log('\n[1] 已用时必须显示，而且只增不减');
  check('meta 行里有「已用」', /已用/.test(s1.meta), `实际: "${s1.meta}"`);
  const t1 = (s1.meta.match(/已用 (\d+:\d+)/) || [])[1];
  const t2 = (s2.meta.match(/已用 (\d+:\d+)/) || [])[1];
  const toSec = (t) => { const [m, sec] = (t || '0:0').split(':').map(Number); return m * 60 + sec; };
  check('已用时在两次读取之间真的走了', toSec(t2) > toSec(t1), `${t1} → ${t2}`);

  console.log('\n[2] 字节数倒退时必须说明「已重新传输」');
  check('出现了重新传输的提示', /重新传输/.test(s3.note), `实际提示: "${s3.note}"`);
  check('提示不是卡顿警告（两者含义不同）', !/卡顿/.test(s3.note), `实际: "${s3.note}"`);

  await page.close();
  await b.close();
  srv.close();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
