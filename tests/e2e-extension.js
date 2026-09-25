/**
 * End-to-end harness: the REAL extension, loaded into Chromium, talking to a
 * fake LoRA Manager. Two real tabs, real service worker, real messaging.
 *
 * Constructed fixtures kept missing the bugs the user actually hit, because the
 * fixture is always more forgiving than the real thing. This runs the shipping
 * code against real browser input instead.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const pup = require('C:/Users/ASUS/AppData/Local/npm-cache/_npx/23232c69e5d221f3/node_modules/puppeteer-core');

const EXT_SRC = process.env.LB_EXT || 'D:/Workbench/Lora_manager/lora-manager-edge-extension';
const CHROME = 'C:/Users/ASUS/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const SITE_PORT = 8791;
// Deliberately NOT 8188: the user's real ComfyUI:LoRA Manager is listening
// there, and this harness must never talk to it, let alone start downloads on it.
const LM_PORT = 18788;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log('  ' + a.join(' ')); }

/** Copy the extension and let it match plain http, so the page can be local. */
function stageExtension() {
  const dir = path.join(os.tmpdir(), 'lb-e2e-ext-' + Date.now());
  fs.cpSync(EXT_SRC, dir, { recursive: true, filter: (s) => !s.includes('.git') });
  const mf = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions.push('http://civitai.com/*', 'http://*.civitai.com/*');
  m.content_scripts[0].matches.push('http://civitai.com/*', 'http://*.civitai.com/*');
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  return dir;
}

/** Fake LoRA Manager: empty libraries, and downloads that never finish. */
function startLoRA() {
  const state = { downloads: [], progress: new Map(), held: new Map() };
  // Let the test finish a transfer on demand, the way a real one ends.
  state.finish = (id) => {
    const h = state.held.get(id);
    if (!h) return false;
    state.held.delete(id);
    h.writeHead(200, { 'Content-Type': 'application/json' });
    h.end(JSON.stringify({ success: true, file_name: 'finished.safetensors' }));
    return true;
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (p === '/api/lm/download-model-get') {
      const id = u.searchParams.get('download_id');
      state.downloads.push({ id, modelId: u.searchParams.get('model_id'), versionId: u.searchParams.get('model_version_id') });
      // The transfer stays open for the whole download — until the test ends it.
      state.held.set(id, res);
      return;
    }
    if (p.startsWith('/api/lm/download-progress/')) {
      const id = p.split('/').pop();
      const known = state.downloads.some((d) => d.id === id);
      if (!known) return json({ error: 'not found' }, 404);
      return json({ success: true, progress: 20, status: 'downloading', bytes_downloaded: 1000, total_bytes: 5000, bytes_per_second: 1000 });
    }
    if (p === '/api/lm/settings') return json({});
    if (p.endsWith('/list')) {
      // Model 700 is in the library — used by the no-version-in-URL case, where
      // the badge must not claim "this version is not downloaded".
      if (u.searchParams.get('civitai_model_id') === '700' && p.includes('/loras/')) {
        return json({
          items: [{ civitai: { id: 7777, modelId: 700 }, file_name: 'blank03-000010', sub_type: 'lora', base_model: 'Anima' }],
          total: 1,
        });
      }
      return json({ items: [], total: 0 });
    }
    return json({ success: true });
  });
  return new Promise((r) => srv.listen(LM_PORT, '127.0.0.1', () => r({ srv, state })));
}

/** Fake CivitAI: a model detail page with the title the extension anchors to. */
function startSite() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://civitai.com');
    const id = (u.pathname.match(/\/models\/(\d+)/) || [])[1] || '0';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Model ${id} | Civitai</title></head>
<body>
  <div class="mantine-Stack-root">
    <div class="mantine-Group-root">
      <h1 class="mantine-Title-root">Model ${id}</h1>
    </div>
    <div class="ModelVersionList"><button>version one</button><button>version two</button></div>
  </div>
</body></html>`);
  });
  return new Promise((r) => srv.listen(SITE_PORT, '127.0.0.1', () => r(srv)));
}

const clickDownload = (page) => page.evaluate(() => {
  const btn = document.querySelector('.lb-dl-btn');
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
});

(async () => {
  let failures = 0;
  const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };

  const extDir = stageExtension();
  const lm = await startLoRA();
  const site = await startSite();

  const browser = await pup.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox', '--no-proxy-server',
      '--host-resolver-rules=MAP civitai.com 127.0.0.1',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });
  console.log('ext dir: ' + extDir);

  // Point the extension at the fake server. Its own default is 127.0.0.1:8188,
  // which on this machine is the user's live ComfyUI.
  let worker = null;
  for (let i = 0; i < 40 && !worker; i++) {
    const t = (await browser.targets()).find((x) => x.type() === 'service_worker');
    if (t) worker = await t.worker();
    if (!worker) await sleep(250);
  }
  if (!worker) { console.log('  !! 扩展的 service worker 没有启动 — 扩展可能没被加载'); }
  else {
    await worker.evaluate((port) => new Promise((r) =>
      chrome.storage.sync.set({ config: { comfyUIHost: 'http://127.0.0.1:' + port, cacheTTLMs: 30000 } }, r)), LM_PORT);
    log('已把扩展指向假服务器 127.0.0.1:' + LM_PORT);
  }

  const tabA = await browser.newPage();
  const tabB = await browser.newPage();
  for (const [name, page, id] of [['A', tabA, 100], ['B', tabB, 200]]) {
    await page.goto(`http://civitai.com:${SITE_PORT}/models/${id}?modelVersionId=${id}000`, { waitUntil: 'domcontentloaded' });
  }
  await sleep(2500);

  const aHtml = await tabA.evaluate(() => !!document.querySelector('.lb-dl-btn'));
  const bHtml = await tabB.evaluate(() => !!document.querySelector('.lb-dl-btn'));
  console.log(`\n  下载按钮：A=${aHtml} B=${bHtml}`);
  log('A 徽章:', await tabA.evaluate(() => (document.querySelector('.lb-inline-badge') || {}).textContent || '(无)'));

  console.log('\n[1] 两个标签页都应出现下载控件');
  check('A 有下载按钮', aHtml, '没有');
  check('B 有下载按钮', bHtml, '没有');

  console.log('\n[2] 一个下载进行中时，另一个标签页仍能下载');
  const r1 = await clickDownload(tabA);
  await sleep(2000);
  const n1 = lm.state.downloads.length;
  console.log(`  A 点击结果=${r1}，服务器收到 ${n1} 个下载请求`);

  if (n1 === 0) {
    // Nothing reached the server: find out why before judging anything else.
    console.log('  !! A 的下载没有到达服务器 — 打印页面状态');
    console.log('  气泡:', await tabA.evaluate(() => (document.getElementById('lb-downloads') || {}).textContent || '(无)'));
    console.log('  toast:', await tabA.evaluate(() => (document.getElementById('lb-toast') || {}).textContent || '(无)'));
  }

  const r2 = await clickDownload(tabB);
  await sleep(2500);
  const n2 = lm.state.downloads.length;
  console.log(`  B 点击结果=${r2}，服务器累计收到 ${n2} 个下载请求`);
  lm.state.downloads.forEach((d) => log(` -> modelId=${d.modelId} versionId=${d.versionId}`));

  check('A 的下载已发出', n1 >= 1, `${n1} 个`);
  // This used to assert that BOTH requests went out at once. They no longer do,
  // and that is the point: on a link that dies for minutes at a time, every
  // extra transfer in flight is another casualty when it does. What must hold
  // is that B's click is not LOST — it is accepted and queued.
  check('B 没有并发发出（一次只压一条）', n2 === 1, `累计 ${n2} 个`);
  const bAreaNow = await tabB.evaluate(() => (document.querySelector('.lb-dl-area') || {}).textContent || '');
  check('B 的点击被接受并显示排队中，不是被丢弃', /排队中/.test(bAreaNow), bAreaNow);

  console.log('\n[3] 点了就该有反馈');
  const bArea = await tabB.evaluate(() => {
    const w = document.querySelector('.lb-dl-area');
    return w ? w.textContent.trim() : '(无下载区)';
  });
  const bBubble = await tabB.evaluate(() => {
    const el = document.getElementById('lb-downloads');
    return el && !el.hidden ? el.textContent.trim().slice(0, 80) : '(气泡隐藏)';
  });
  log('B 的下载区:', bArea);
  log('B 的气泡:', bBubble);
  check('B 的下载区给出了状态（不再是按钮）', !/下载到库/.test(bArea), bArea);
  check('B 的气泡可见并说明了状态', bBubble !== '(气泡隐藏)', bBubble);

  console.log('\n[4] 点击不该被每 2 秒的重渲染吞掉');
  // Click on the live button repeatedly across rebuild cycles; every click must
  // either start a download or be visibly rejected — never silently vanish.
  const before = lm.state.downloads.length;
  let clicked = 0;
  for (let i = 0; i < 6; i++) {
    const r = await clickDownload(tabA);
    if (r === 'clicked') clicked++;
    await sleep(1100);            // straddle the poll window on purpose
  }
  const after = lm.state.downloads.length;
  log(`6 次点击（每次间隔 1.1 秒，跨过轮询）：点了 ${clicked} 次，服务器请求 ${before} → ${after}`);
  check('重复点击同一版本不会产生新的下载请求（去重生效）', after === before, `${before} → ${after}`);

  console.log('\n[5] 控件必须稳定：轮询期间不得替换用户正在点的按钮');
  // Verified separately with real input events: when the node under the cursor
  // is removed between mousedown and mouseup, the browser dispatches NO click
  // at all — not to the wrapper, not to the document. So no listener placement
  // can rescue that click; the only fix is to stop replacing the node. This
  // asserts the replacement stops, while two downloads are running, i.e. at the
  // fastest polling cadence.
  const tabC = await browser.newPage();
  await tabC.goto(`http://civitai.com:${SITE_PORT}/models/300?modelVersionId=300000`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const stability = await tabC.evaluate(async () => {
    const first = document.querySelector('.lb-dl-btn');
    if (!first) return { error: '找不到下载按钮' };
    const samples = [];
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const now = document.querySelector('.lb-dl-btn');
      samples.push(now === first);
    }
    return { first: !!first, replaced: samples.filter((s) => !s).length, total: samples.length };
  });
  console.log(`  C：8 秒内采样 ${stability.total} 次（下载进行中，轮询 2 秒一次），按钮被替换 ${stability.replaced} 次`);
  check('下载按钮在整个采样期内是同一个节点',
    !stability.error && stability.replaced === 0, JSON.stringify(stability));

  // And the plain click path still works: with one transfer already running
  // (or queued) the click lands in the queue rather than on the wire, so what
  // is asserted is that it is *taken*, not that a request goes out.
  await tabC.evaluate(() => document.querySelector('.lb-dl-btn').click());
  await sleep(1500);
  const cArea = await tabC.evaluate(() => (document.querySelector('.lb-dl-area') || {}).textContent || '');
  check('点击仍然有效（开始或排队，不会被丢掉）',
    /排队中|%|准备中/.test(cArea), cArea);

  console.log('\n[6] 点了立刻要有反馈，不等轮询');
  const tabD = await browser.newPage();
  await tabD.goto(`http://civitai.com:${SITE_PORT}/models/400?modelVersionId=400000`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const feedback = await tabD.evaluate(async () => {
    const btn = document.querySelector('.lb-dl-btn');
    if (!btn) return '(没有按钮)';
    btn.click();
    // Read immediately: the next poll has not run yet, so anything visible here
    // came from the click itself.
    await new Promise((r) => setTimeout(r, 60));
    return (document.querySelector('.lb-dl-area') || {}).textContent || '';
  });
  log('D 点击后 60ms 的控件文字:', feedback.trim());
  check('点击后立刻显示等待态（不是继续显示按钮）',
    !/下载到库/.test(feedback), feedback);

  // Sections [2]-[6] left transfers running and queued behind them. Start [7]
  // from an idle queue, or "the first click goes immediately" is untestable.
  const drain = async (max = 40) => {
    for (let i = 0; i < max; i++) {
      const ids = [...lm.state.held.keys()];
      ids.forEach((id) => lm.state.finish(id));
      const before = lm.state.downloads.length;
      await sleep(800);
      if (lm.state.held.size === 0 && lm.state.downloads.length === before) return true;
    }
    return false;
  };
  const idle = await drain();
  console.log(`\n  （清空此前遗留的下载：${idle ? '队列已空' : '仍有残留'}，累计 ${lm.state.downloads.length} 个请求）`);

  console.log('\n[7] 点击先记录：一次只发一个请求，后面的排队');
  const tabE = await browser.newPage();
  const tabF = await browser.newPage();
  await tabE.goto(`http://civitai.com:${SITE_PORT}/models/500?modelVersionId=500000`, { waitUntil: 'domcontentloaded' });
  await tabF.goto(`http://civitai.com:${SITE_PORT}/models/600?modelVersionId=600000`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const eStart = lm.state.downloads.length;
  await tabE.evaluate(() => document.querySelector('.lb-dl-btn').click());
  await sleep(1500);
  const afterE = lm.state.downloads.length;

  await tabF.evaluate(() => document.querySelector('.lb-dl-btn').click());
  await sleep(2500);
  const afterF = lm.state.downloads.length;

  const fArea = await tabF.evaluate(() => (document.querySelector('.lb-dl-area') || {}).textContent || '');
  const eBubble = await tabE.evaluate(() => {
    const el = document.getElementById('lb-downloads');
    return el && !el.hidden ? el.textContent.replace(/\s+/g, ' ').slice(0, 90) : '(隐藏)';
  });
  console.log(`  第一个下载后服务器收到 ${afterE - eStart} 个请求；第二个点击后共 ${afterF - eStart} 个`);
  log('F 的控件:', fArea.trim());
  log('E 的气泡:', eBubble);

  check('第一个点击立即发出请求', afterE - eStart === 1, `${afterE - eStart}`);
  check('第二个点击没有并发发出（排队中）', afterF - eStart === 1, `共 ${afterF - eStart} 个 —— 说明两个请求同时发出去了`);
  check('第二个页面显示「排队中」而不是「下载到库」', /排队中/.test(fArea), fArea);
  check('气泡里能同时看到进行中和排队', /正在下载/.test(eBubble) && /排队/.test(eBubble), eBubble);

  console.log('\n[8] 前一个结束后，排队的自动开始');
  lm.state.finish(lm.state.downloads[afterE - 1].id);
  await sleep(4000);
  const last = lm.state.downloads[lm.state.downloads.length - 1];
  console.log(`  服务器累计收到 ${lm.state.downloads.length - eStart} 个请求，最后一个是 model_id=${last.modelId}`);
  check('排队的下载被自动发出', lm.state.downloads.length - eStart === 2,
    `共 ${lm.state.downloads.length - eStart} 个`);
  check('发出的是排队的那个（600）', last.modelId === '600', `实际 model_id=${last.modelId}`);

  const fAfter = await tabF.evaluate(() => (document.querySelector('.lb-dl-area') || {}).textContent || '');
  log('F 的控件（应已变成进度）:', fAfter.trim());
  check('排队中的控件变成了正在下载', !/排队中/.test(fAfter), fAfter);

  console.log('\n[9] 没有 ?modelVersionId= 的模型页，不能把 "null" 当成版本号');
  await drain();
  const tabG = await browser.newPage();
  // /models/{id} with no version in the query — ctx() gives versionId = null,
  // and String(null) used to become the literal text "null" on the wire.
  await tabG.goto(`http://civitai.com:${SITE_PORT}/models/700`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const gBadge = await tabG.evaluate(() => {
    const b = document.querySelector('.lb-inline-badge');
    return b ? b.textContent : '(无徽章)';
  });
  console.log(`  徽章: "${gBadge}"`);
  check('徽章不能谎称「此版本未下载」',
    !/此版本未下载/.test(gBadge), gBadge);
  check('徽章如实说库里有什么',
    /库中有这个模型/.test(gBadge), gBadge);

  const gHasBtn = await tabG.evaluate(() => !!document.querySelector('.lb-dl-btn'));
  await tabG.evaluate(() => document.querySelector('.lb-dl-btn') && document.querySelector('.lb-dl-btn').click());
  await sleep(2000);
  const gLast = lm.state.downloads[lm.state.downloads.length - 1];
  console.log(`  有下载按钮: ${gHasBtn}；服务器收到 model_id=${gLast && gLast.modelId} model_version_id=${gLast && gLast.versionId}`);
  check('这一页确实有下载按钮（否则测不到）', gHasBtn, '没有按钮');
  check('model_id 照常发出', gLast && gLast.modelId === '700', `实际 ${gLast && gLast.modelId}`);
  check('没有把 "null" 当成 model_version_id 发出去',
    gLast && gLast.versionId !== 'null' && gLast.versionId !== 'undefined',
    `实际发的是 ${JSON.stringify(gLast && gLast.versionId)}`);

  await browser.close();
  lm.srv.close();
  site.close();
  fs.rmSync(extDir, { recursive: true, force: true });

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
