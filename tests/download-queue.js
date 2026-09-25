/**
 * The download queue: clicks are recorded, one transfer runs at a time, and the
 * next one starts when the wire frees up.
 *
 * Loads the REAL background.js against a fake chrome + fake LoRA Manager whose
 * transfers never finish until the test says so.
 */
const fs = require('fs');
const path = require('path');

const BG = fs.readFileSync(process.env.LB_BG || 'D:/Workbench/Lora_manager/lora-manager-edge-extension/background.js', 'utf8');

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStorage(shared) {
  const store = shared || {};
  const wrap = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    const p = new Promise((r) => fn(...a, r));
    if (cb) { p.then(cb); return undefined; }
    return p;
  };
  return {
    __store: store,
    get: wrap((keys, done) => done({ ...store })),
    set: wrap((items, done) => { Object.assign(store, items); done(); }),
    remove: wrap((k, done) => done()),
  };
}

function makeChrome(stores) {
  const listeners = [];
  return {
    __listeners: listeners,
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    storage: {
      sync: makeStorage(),
      session: stores.session,
      local: stores.local,
      onChanged: { addListener: () => {} },
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => {} },
  };
}

function loadWorker(stores, requests, pending) {
  const chrome = makeChrome(stores);
  const res = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  });
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const p = new URL(String(url)).pathname;
    if (p === '/api/lm/download-model-get') {
      const id = new URL(String(url)).searchParams.get('download_id');
      return new Promise((resolve) => pending.push({ id, resolve }));
    }
    if (p.startsWith('/api/lm/download-progress/')) return res({ success: true, progress: 10 });
    if (p.endsWith('/list')) return res({ items: [], total: 0 });
    return res({ success: true });
  };
  const fn = new Function('chrome', 'fetch', 'crypto', 'console', 'setTimeout', 'clearTimeout', 'URL', 'URLSearchParams', 'AbortController', 'Promise', BG);
  fn(chrome, fetchImpl, require('crypto').webcrypto, { debug: () => {}, info: () => {}, error: () => {} },
     setTimeout, clearTimeout, URL, URLSearchParams, AbortController, Promise);
  return chrome;
}

const send = (chrome, type, payload) => new Promise((resolve) => {
  const handled = chrome.__listeners[0]({ type, payload }, {}, resolve);
  if (!handled) resolve(undefined);
});

const sentFor = (requests) => requests.filter((u) => u.includes('download-model-get'))
  .map((u) => new URL(u).searchParams.get('model_id') + '/' + new URL(u).searchParams.get('model_version_id'));

(async () => {
  const stores = { session: makeStorage(), local: makeStorage() };
  const requests = [];
  const pending = [];
  const chrome = loadWorker(stores, requests, pending);
  await sleep(150);

  console.log('\n[1] 一次只发一个：后面的点击被记下来，不阻塞返回');
  const a = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 100, versionId: 1000, modelName: 'A' });
  await sleep(60);
  const b = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 200, versionId: 2000, modelName: 'B' });
  const c = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 300, versionId: 3000, modelName: 'C' });
  await sleep(120);
  console.log(`  A→${JSON.stringify(a)}\n  B→${JSON.stringify(b)}\n  C→${JSON.stringify(c)}`);
  console.log(`  服务器收到的下载请求: ${JSON.stringify(sentFor(requests))}`);

  check('A 立即开始', a && a.success === true && !a.queued, JSON.stringify(a));
  check('B 被排队而不是被拒绝', b && b.success === true && b.queued === true, JSON.stringify(b));
  check('B 的位置是第 1 位', b && b.position === 1, JSON.stringify(b));
  check('C 是第 2 位', c && c.position === 2, JSON.stringify(c));
  check('只有 A 到达了服务器', sentFor(requests).length === 1, JSON.stringify(sentFor(requests)));

  console.log('\n[2] 重复排队要被去重');
  const b2 = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 200, versionId: 2000, modelName: 'B again' });
  check('第二次点 B 返回原来的位置，而不是新增一条',
    b2 && b2.queued === true && b2.position === 1, JSON.stringify(b2));

  console.log('\n[3] 前一个结束后，下一个自动开始');
  const active = await send(chrome, 'ACTIVE_DOWNLOADS', {});
  console.log(`  队列对外可见: ${JSON.stringify((active.queue || []).map((q) => q.modelId + '@' + q.position))}`);
  check('队列出现在轮询结果里（页面才能显示「排队中」）',
    (active.queue || []).length === 2 && active.queue[0].position === 1, JSON.stringify(active.queue));

  pending[0].resolve({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, file_name: 'A.safetensors' }) });
  await sleep(300);
  console.log(`  A 完成后服务器收到的请求: ${JSON.stringify(sentFor(requests))}`);
  check('B 在前一个结束后自动发出', sentFor(requests).length === 2, JSON.stringify(sentFor(requests)));
  check('发出的是 B（先进先出）', sentFor(requests)[1] === '200/2000', JSON.stringify(sentFor(requests)));

  console.log('\n[4] 取消排队中的下载');
  const cancelC = await send(chrome, 'CANCEL_QUEUED', { modelId: 300, versionId: 3000 });
  await sleep(80);
  const after = await send(chrome, 'ACTIVE_DOWNLOADS', {});
  console.log(`  取消后队列: ${JSON.stringify((after.queue || []).map((q) => q.modelId))}`);
  check('取消返回成功', cancelC && cancelC.success === true, JSON.stringify(cancelC));
  check('C 已从队列移除', (after.queue || []).length === 0, JSON.stringify(after.queue));

  pending[1].resolve({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, file_name: 'B.safetensors' }) });
  await sleep(300);
  check('被取消的 C 永远不会被发出', sentFor(requests).length === 2, JSON.stringify(sentFor(requests)));

  console.log('\n[5] 队列与在途下载要在【重载扩展】后仍然存在');
  // A real reload does NOT keep the worker's session storage — that was the
  // discovery: reloading mid-batch silently dropped the whole queue. Only the
  // `local` area carries over, which is why the work in progress lives there.
  // Put something of each kind in place first, or there is nothing to carry.
  const d1 = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 400, versionId: 4000, modelName: 'D' });
  const d2 = await send(chrome, 'DOWNLOAD_MODEL', { modelId: 500, versionId: 5000, modelName: 'E' });
  await sleep(120);
  console.log(`  重载前: D→${JSON.stringify(d1)}  E→${JSON.stringify(d2)}`);
  check('重载前是一个在传、一个排队',
    d1 && d1.success === true && !d1.queued && d2 && d2.queued === true, JSON.stringify([d1, d2]));

  const reloaded = { session: makeStorage(), local: stores.local };
  const requests2 = [];
  const pending2 = [];
  const chrome2 = loadWorker(reloaded, requests2, pending2);
  await sleep(150);

  const carried = await send(chrome2, 'ACTIVE_DOWNLOADS', {});
  const carriedQ = (carried.queue || []).map((q) => q.modelId);
  const carriedD = (carried.downloads || []).map((d) => d.modelId);
  console.log(`  重载后：在途 ${JSON.stringify(carriedD)}，排队 ${JSON.stringify(carriedQ)}`);
  check('重载后在途的下载仍被跟踪（还在服务端跑着）', carriedD.includes(400), JSON.stringify(carried[0]));
  check('重载后排队的下载还在队列里', carriedQ.includes(500), JSON.stringify(carriedQ));
  check('重载没有重复发出已经在传的那个',
    sentFor(requests2).length === 0, `重载后又发了 ${sentFor(requests2).length} 个请求`);

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
