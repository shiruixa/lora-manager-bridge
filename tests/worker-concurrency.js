/**
 * Two tabs, two different models, one download already running.
 *
 * Loads the REAL background.js against a fake chrome + a fake LoRA Manager
 * server, and records every request that reaches the server. This answers the
 * question the code alone cannot: does the worker refuse the second download,
 * or does it send it and something else swallows the result?
 */
const fs = require('fs');
const path = require('path');

const BG = fs.readFileSync(process.env.LB_BG || 'D:/Workbench/Lora_manager/lora-manager-edge-extension/background.js', 'utf8');

const requests = [];        // every fetch that reaches the fake server
const pendingDownloads = []; // resolvers for the long-lived download GETs

function makeFetch() {
  // A real Response offers both json() and text(); the worker uses whichever
  // suits the call site, so the fake must offer both or it fails in ways the
  // real server never would.
  const res = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  });

  return async (url, opts) => {
    requests.push(String(url));
    const u = new URL(String(url));
    const p = u.pathname;

    // The long-lived transfer: the server holds the connection open for the
    // whole download. Never resolves here — that is the point.
    if (p === '/api/lm/download-model-get') {
      return new Promise((resolve) => pendingDownloads.push({ url: String(url), resolve }));
    }
    if (p.startsWith('/api/lm/download-progress/')) {
      // A running transfer has a progress record; that is what makes the
      // duplicate guard conclude "still running" and reuse it.
      return res({ success: true, progress: 10, status: 'downloading' });
    }
    if (p.endsWith('/list')) {
      // Every query is "answered, nothing found, and there were no matches".
      return res({ items: [], total: 0 });
    }
    if (p === '/api/lm/settings') return res({});
    return res({ success: true });
  };
}

function makeChrome() {
  const store = {};
  const listeners = [];
  const asPromiseOrCb = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    const p = new Promise((r) => fn(...a, r));
    if (cb) { p.then(cb); return undefined; }
    return p;
  };
  const storageArea = () => ({
    get: asPromiseOrCb((keys, done) => done({})),
    set: asPromiseOrCb((items, done) => { Object.assign(store, items); done(); }),
    remove: asPromiseOrCb((k, done) => done()),
  });
  return {
    __listeners: listeners,
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    storage: {
      sync: storageArea(),
      session: storageArea(),
      local: storageArea(),
      onChanged: { addListener: () => {} },
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: asPromiseOrCb((q, done) => done([])), sendMessage: () => {} },
  };
}

function loadWorker() {
  const chrome = makeChrome();
  const fetchImpl = makeFetch();
  const fn = new Function('chrome', 'fetch', 'crypto', 'console', 'setTimeout', 'clearTimeout', 'URL', 'URLSearchParams', 'AbortController', 'Promise', BG);
  fn(chrome, fetchImpl, require('crypto').webcrypto, console,
     setTimeout, clearTimeout, URL, URLSearchParams, AbortController, Promise);
  return chrome;
}

/** Send a message the way a content script does, and await the reply. */
function send(chrome, type, payload) {
  return new Promise((resolve) => {
    const listener = chrome.__listeners[0];
    const handled = listener({ type, payload }, {}, (response) => resolve(response));
    if (!handled) resolve(undefined);
  });
}

const downloadHits = () => requests.filter((u) => u.includes('/api/lm/download-model-get'));

(async () => {
  let failures = 0;
  const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };

  const chrome = loadWorker();
  await new Promise((r) => setTimeout(r, 200));   // let startup hydrate/reconcile settle

  // Tab A starts a download for model 100 / version 1000.
  const a = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 100, versionId: 1000, modelName: 'Model A' });
  await new Promise((r) => setTimeout(r, 100));
  console.log(`\n  A 的回复: ${JSON.stringify(a)}`);

  // Tab B, a different model, while A is still transferring.
  const b = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 200, versionId: 2000, modelName: 'Model B' });
  await new Promise((r) => setTimeout(r, 100));
  console.log(`  B 的回复: ${JSON.stringify(b)}`);

  const hits = downloadHits();
  console.log(`\n  到达服务器的下载请求：${hits.length} 个`);
  hits.forEach((h) => console.log('    ' + h.replace(/^https?:\/\/[^/]+/, '').slice(0, 120)));

  // Did the duplicate guard even look? It must query the running download's
  // progress to decide whether the persisted entry is still real.
  const probes = requests.filter((u) => u.includes('/api/lm/download-progress/'));
  console.log(`\n  去重守卫的进度查询：${probes.length} 次`);
  probes.forEach((h) => console.log('    ' + h.replace(/^https?:\/\/[^/]+/, '')));
  console.log('\n  全部请求顺序：');
  requests.forEach((h, i) => console.log(`    ${i}. ` + h.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)));

  console.log('\n[1] 第二个模型必须真的发出下载请求');
  check('A 已开始下载', a && a.success === true, JSON.stringify(a));
  check('B 也开始了自己的下载（不被 A 挡住）',
    b && b.success === true && !b.reused, JSON.stringify(b));
  check('服务器收到两个不同的下载请求',
    hits.length === 2 && hits[0] !== hits[1], `收到 ${hits.length} 个`);

  // What does the worker think is in flight? ACTIVE_DOWNLOADS iterates the
  // very map the duplicate guard searches, so this shows what the guard sees.
  const active = await send(chrome, 'ACTIVE_DOWNLOADS', {});
  console.log(`\n  ACTIVE_DOWNLOADS 认为在途：${(active && active.downloads || []).length} 个`);
  (active && active.downloads || []).forEach((d) =>
    console.log(`    id=${d.downloadId} modelId=${JSON.stringify(d.modelId)} versionId=${JSON.stringify(d.versionId)}`));

  // Third case: the SAME version again — this one SHOULD be deduped.
  const a2 = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 200, versionId: 2000, modelName: 'Model B again' });
  const hits2 = downloadHits();
  console.log('\n[2] 同一个版本重复请求仍然要被去重（这是之前修过的）');
  check('同一版本被识别为已在下载中',
    a2 && a2.success === true && a2.reused === true, JSON.stringify(a2));
  check('没有产生第三个下载请求', hits2.length === 2, `收到 ${hits2.length} 个`);

  console.log('\n  全部请求顺序（最终）：');
  requests.forEach((h, i) => console.log(`    ${i}. ` + h.replace(/^https?:\/\/[^/]+/, '').slice(0, 95)));
  const probesFinal = requests.filter((u) => u.includes('/api/lm/download-progress/'));
  console.log(`\n  去重守卫的进度查询（最终）：${probesFinal.length} 次`);

  process.exit(failures === 0 ? 0 : 1);
})();
