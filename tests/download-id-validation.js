/**
 * A detail page reached WITHOUT ?modelVersionId=.
 *
 * `ctx()` gives versionId = null there, and `String(null)` is the string
 * "null" — truthy, so it passed every guard and went to the server as
 * `model_version_id=null`. The server parses that as an integer and answers
 * "Invalid model_version_id: Must be an integer".
 *
 * The worker is loaded for real, so this checks what actually reaches the wire.
 */
const fs = require('fs');

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
  return { get: wrap((k, d) => d({ ...store })), set: wrap((i, d) => { Object.assign(store, i); d(); }), remove: wrap((k, d) => d()) };
}

(async () => {
  const urls = [];
  const res = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body), json: async () => body,
  });
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const p = new URL(String(url)).pathname;
    if (p === '/api/lm/download-model-get') return res({ success: true, file_name: 'x.safetensors' });
    if (p.startsWith('/api/lm/download-progress/')) return res({ success: true, progress: 5 });
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
  const dl = () => urls.filter((u) => u.includes('download-model-get'));
  const param = (u, k) => new URL(u).searchParams.get(k);

  console.log('\n[1] 缺 versionId 时，不能把 "null" 当参数发出去');
  const r1 = await send('DOWNLOAD_MODEL', { modelId: 2882216, versionId: null, modelName: 'No version in URL' });
  await sleep(120);
  const sent = dl();
  console.log(`  回复: ${JSON.stringify(r1)}`);
  sent.forEach((u) => console.log('  发到服务器: ' + u.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)));

  check('请求发出去了（只用 model_id 是合法的）', sent.length === 1, `${sent.length} 个`);
  check('model_id 正确', sent[0] && param(sent[0], 'model_id') === '2882216', param(sent[0] || '', 'model_id'));
  check('**没有** 把 "null" 当成 model_version_id 发出去',
    sent[0] && param(sent[0], 'model_version_id') === null,
    `实际发的是 model_version_id=${param(sent[0] || '', 'model_version_id')}`);

  console.log('\n[2] 老版扩展发来的字符串 "null" / "undefined" 也要挡住');
  for (const bad of ['null', 'undefined', '', 'abc']) {
    await send('DOWNLOAD_MODEL', { modelId: 555, versionId: bad, modelName: 'legacy ' + bad });
  }
  await sleep(200);
  const badSent = dl().slice(1).map((u) => param(u, 'model_version_id'));
  console.log(`  四个坏值发出后，服务器看到的 model_version_id: ${JSON.stringify(badSent)}`);
  check('没有任何一个请求带上了非整数的 version_id',
    badSent.every((v) => v === null || /^\d+$/.test(v)), JSON.stringify(badSent));

  console.log('\n[3] 两个 id 都无效时要明确拒绝，而不是发一个必然报错的请求');
  const before = dl().length;
  const r3 = await send('DOWNLOAD_MODEL', { modelId: null, versionId: null, modelName: 'nothing' });
  await sleep(120);
  console.log(`  回复: ${JSON.stringify(r3)}`);
  check('没有发出请求', dl().length === before, `多发了 ${dl().length - before} 个`);
  check('返回了可读的错误，而不是服务器那句英文校验失败',
    r3 && r3.success === false && /modelId|versionId/.test(r3.error || '') && !/Must be an integer/.test(r3.error || ''),
    JSON.stringify(r3));

  console.log('\n[4] 合法的 versionId 仍然照常传递');
  const ok = await send('DOWNLOAD_MODEL', { modelId: 111, versionId: 222, modelName: 'fine' });
  await sleep(120);
  const last = dl()[dl().length - 1];
  check('正常参数没有被过滤掉',
    ok && ok.success === true && param(last, 'model_id') === '111' && param(last, 'model_version_id') === '222',
    `${param(last || '', 'model_id')} / ${param(last || '', 'model_version_id')}`);

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
