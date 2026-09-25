/**
 * Auto-retry for a transfer that stops progressing.
 *
 * Two shapes of failure, both seen on the real machine:
 *   - the connection dies mid-transfer, or goes quiet before any bytes flow
 *   - it keeps trickling (~8 KB/s on a 175 MB file — six hours to go)
 * The server recovers from neither, so the whole queue waits behind it.
 *
 * The window is shortened through the worker's tuning seam so this runs in
 * seconds rather than minutes.
 */
const fs = require('fs');

globalThis.__lbTuning = { stuckWindowMs: 1500, minProgressBytes: 1024, maxRetries: 2 };
const BG = fs.readFileSync(process.env.LB_BG || 'D:/Workbench/Lora_manager/lora-manager-edge-extension/background.js', 'utf8');

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  → ' + d)); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const res = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

(async () => {
  const requests = [];
  const cancels = [];
  const skips = [];
  const held = new Map();
  // Bytes reported by the fake server, per download id. Set to -1 for "no
  // progress record at all", which is the other way a transfer looks dead.
  const progressFor = new Map();

  const fetchImpl = async (url) => {
    requests.push(String(url));
    const u = new URL(String(url));
    const p = u.pathname;
    if (p === '/api/lm/download-model-get') {
      const id = u.searchParams.get('download_id');
      return new Promise((resolve) => held.set(id, resolve));
    }
    // The server has TWO ways to stop a transfer and they differ on the one
    // thing that matters: cancel deletes the .part, skip keeps it so the next
    // request resumes. The retry must use skip, or it throws away the bytes it
    // was about to resume from. Recording which one arrived is the point.
    if (p === '/api/lm/cancel-download-get' || p === '/api/lm/skip-download') {
      const id = u.searchParams.get('download_id');
      (p === '/api/lm/skip-download' ? skips : cancels).push(id);
      held.get(id) && held.get(id)(res({ success: true }));
      held.delete(id);
      return res({ success: true });
    }
    if (p.startsWith('/api/lm/download-progress/')) {
      const id = p.split('/').pop();
      const b = progressFor.get(id);
      if (b === -1) return res({ error: 'not found' }, 404);
      return res({ success: true, progress: 10, bytes_downloaded: b ?? 0, total_bytes: 100000000, bytes_per_second: 1 });
    }
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
  const downloadsSent = () => requests.filter((u) => u.includes('download-model-get')).length;

  const tick = async (n = 3) => { for (let i = 0; i < n; i++) { await send('ACTIVE_DOWNLOADS', {}); await sleep(600); } };

  await sleep(150);

  console.log('\n[1] 传输完全停住（字节数不再增长）要自动重试');
  await send('DOWNLOAD_MODEL', { modelId: 900, versionId: 9000, modelName: 'Stuck' });
  await sleep(200);
  const id1 = [...held.keys()][0];
  progressFor.set(id1, 5000000);                 // healthy first reading
  await tick(1);
  const beforeRetry = downloadsSent();
  console.log(`  首次请求已发出（共 ${beforeRetry} 个），现在让字节数卡住不动`);
  await tick(4);                                  // exceeds the 1.5s window

  console.log(`  停止请求：skip ${skips.length} 次 / cancel ${cancels.length} 次；下载请求 ${beforeRetry} → ${downloadsSent()} 个`);
  check('停住后发出了停止请求', skips.length + cancels.length >= 1, `${skips.length + cancels.length} 次`);
  check('**用的是 skip 而不是 cancel**（cancel 会删掉 .part，重试就白下了）',
    skips.length >= 1 && cancels.length === 0, `skip ${skips.length} / cancel ${cancels.length}`);
  check('并且重新发起了下载（自动重试）', downloadsSent() > beforeRetry, `${beforeRetry} → ${downloadsSent()}`);

  console.log('\n[2] 一直在慢慢爬（有字节但没「实质」进展）也要重试');
  const stops = () => skips.length + cancels.length;
  const cancelsBefore = stops();
  const id2 = [...held.keys()][0];
  // +100 bytes per tick: moving, but nowhere near minProgressBytes (1024).
  let b = 6000000;
  for (let i = 0; i < 5; i++) { b += 100; progressFor.set(id2, b); await send('ACTIVE_DOWNLOADS', {}); await sleep(600); }
  console.log(`  字节数从 6000100 爬到 ${b}（每次 +100），停止次数 ${cancelsBefore} → ${stops()}`);
  check('缓慢爬行也被判定为停滞', stops() > cancelsBefore, `${cancelsBefore} → ${stops()}`);

  console.log('\n[3] 重试次数用尽后要放弃并说明原因，不能永远重试');
  const limit = stops() + 6;
  let guard = 0;
  while (stops() < limit && guard++ < 60) {
    const cur = [...held.keys()][0];
    if (cur) progressFor.set(cur, -1);            // no progress record at all
    await send('ACTIVE_DOWNLOADS', {});
    await sleep(500);
  }
  const hist = await send('DOWNLOAD_HISTORY', {});
  const givenUp = (hist.history || []).filter((h) => /自动重试/.test(h.error || ''));
  console.log(`  共停止 ${stops()} 次（skip ${skips.length} / cancel ${cancels.length}），放弃记录 ${givenUp.length} 条`);
  if (givenUp.length) log_('  放弃原因: ' + givenUp[0].error);
  check('最终放弃了（没有无限重试）', givenUp.length >= 1, `${givenUp.length} 条`);
  check('放弃时给出了可读的原因', givenUp.length > 0 && /自动重试/.test(givenUp[0].error || ''), JSON.stringify(givenUp[0] || {}));

  function log_(s) { console.log(s); }

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
