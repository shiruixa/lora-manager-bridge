/**
 * A batch: ten downloads clicked at once, through the real background.js.
 *
 * Asserts the two things that matter before someone clicks twenty models:
 * exactly one transfer is ever on the wire, and the queue drains completely —
 * in the order the clicks were made, with no item silently dropped.
 */
const fs = require('fs');

const BG = fs.readFileSync(process.env.LB_BG || 'D:/Workbench/Lora_manager/lora-manager-edge-extension/background.js', 'utf8');

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N = 10;
const PEAK = [];

function makeStorage() {
  const store = {};
  const wrap = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    const p = new Promise((r) => fn(...a, r));
    if (cb) { p.then(cb); return undefined; }
    return p;
  };
  return {
    get: wrap((k, done) => done({ ...store })),
    set: wrap((i, done) => { Object.assign(store, i); done(); }),
    remove: wrap((k, done) => done()),
  };
}

(async () => {
  const requests = [];
  const held = new Map();
  let live = 0, peak = 0;

  const res = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });

  const fetchImpl = async (url) => {
    requests.push(String(url));
    const p = new URL(String(url)).pathname;
    if (p === '/api/lm/download-model-get') {
      const id = new URL(String(url)).searchParams.get('download_id');
      live++;
      peak = Math.max(peak, live);
      return new Promise((resolve) => held.set(id, () => {
        live--;
        resolve(res({ success: true, file_name: id.slice(0, 8) + '.safetensors' }));
      }));
    }
    if (p.startsWith('/api/lm/download-progress/')) return res({ success: true, progress: 50 });
    if (p.endsWith('/list')) return res({ items: [], total: 0 });
    return res({ success: true });
  };

  const listeners = [];
  const chrome = {
    runtime: { lastError: null, onMessage: { addListener: (f) => listeners.push(f) }, getURL: (p) => p },
    storage: { sync: makeStorage(), session: makeStorage(), local: makeStorage(), onChanged: { addListener: () => {} } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => {} },
  };
  const fn = new Function('chrome', 'fetch', 'crypto', 'console', 'setTimeout', 'clearTimeout', 'URL', 'URLSearchParams', 'AbortController', 'Promise', BG);
  fn(chrome, fetchImpl, require('crypto').webcrypto, { debug: () => {}, info: () => {}, error: () => {} },
     setTimeout, clearTimeout, URL, URLSearchParams, AbortController, Promise);

  const send = (type, payload) => new Promise((r) => {
    const handled = listeners[0]({ type, payload }, {}, r);
    if (!handled) r(undefined);
  });

  await sleep(150);

  console.log(`\n[1] 一次性点 ${N} 个`);
  const replies = [];
  for (let i = 0; i < N; i++) {
    replies.push(await send('DOWNLOAD_MODEL', { modelId: 1000 + i, versionId: 9000 + i, modelName: 'Model ' + i }));
    await sleep(25);
  }
  const immediate = replies.filter((r) => r && r.success && !r.queued).length;
  const queued = replies.filter((r) => r && r.queued).length;
  console.log(`  立刻开始 ${immediate} 个，排队 ${queued} 个`);
  console.log(`  排队位置: ${replies.filter((r) => r.queued).map((r) => r.position).join(', ')}`);

  check('每个点击都被接受（没有一个被拒绝或丢失）',
    replies.every((r) => r && r.success === true), JSON.stringify(replies.filter((r) => !r || !r.success)));
  check('只有 1 个立刻开始', immediate === 1, `${immediate} 个`);
  check('其余全部排队', queued === N - 1, `${queued} 个`);
  check('排队位置是 1..' + (N - 1),
    replies.filter((r) => r.queued).every((r, i) => r.position === i + 1),
    replies.filter((r) => r.queued).map((r) => r.position).join(','));

  const q0 = await send('ACTIVE_DOWNLOADS', {});
  console.log(`  服务器已收到 ${requests.filter((u) => u.includes('download-model-get')).length} 个请求，队列 ${q0.queue.length} 个`);

  console.log('\n[2] 依次放行，队列应当逐个推进');
  // Finish each transfer IN TURN. Taking entries[0] every time re-finished the
  // first one and never touched the ones that arrived later — which stalled the
  // loop, not the queue.
  const finished = new Set();
  let steps = 0;
  while (steps < N * 4) {
    const next = [...held.entries()].find(([id]) => !finished.has(id));
    if (!next) break;                    // nothing left to finish
    finished.add(next[0]);
    next[1]();                           // complete this one
    await sleep(250);                    // let the pump start the next
    steps++;
  }
  await sleep(400);

  const sent = requests.filter((u) => u.includes('download-model-get'))
    .map((u) => Number(new URL(u).searchParams.get('model_id')));
  const finalQ = await send('ACTIVE_DOWNLOADS', {});

  console.log(`\n  实际发出的顺序: ${sent.join(', ')}`);
  console.log(`  同时最多在传: ${peak} 个`);
  console.log(`  最终队列长度: ${finalQ.queue.length}`);

  console.log('\n[3] 批量下载的正确性');
  check('全部 ' + N + ' 个都发出去了',
    sent.length === N, `${sent.length} 个`);
  check('顺序与点击顺序一致',
    sent.join(',') === Array.from({ length: N }, (_, i) => 1000 + i).join(','), sent.join(','));
  check('任何时候都只有 1 个在传', peak === 1, `峰值 ${peak} 个`);
  check('队列最终清空', finalQ.queue.length === 0, `还剩 ${finalQ.queue.length} 个`);
  check('没有重复下载同一个模型',
    new Set(sent).size === sent.length, `${sent.length} 个请求中有重复`);

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
