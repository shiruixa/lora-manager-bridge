/**
 * LoRA Manager Bridge - Content Script
 *
 * Detail pages: inline badge near model title. Version switch → re-checks via URL poll.
 * List pages:    incremental card scan on scroll / MutationObserver.
 */
(function () {
  'use strict';

  const TAG = '[LoraBridge]';
  const CARD_DONE = 'data-lb-done', CARD_PENDING = 'data-lb-pending';
  const CARD_MARKER = 'lb-card-owned', BADGE_CLS = 'lb-card-badge', OVL_CLS = 'lb-card-ovl';
  const BADGE_ID = 'lb-inline-badge', LIST_ID = 'lb-version-list';

  // Concurrency: scanLock for list, detailReqId sequence for detail (no global processing lock)
  let scanLock = false, detailReqId = 0, retryTimer = null;
  let downloadsEnabled = true;   // overwritten from config below
  let lastUrl = '', lastDetailHref = '';  // track full href for detail version switches

  const I = (...a) => console.info(TAG, ...a);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  // esc() does not escape quotes, which is fine for text nodes but not for
  // values interpolated into an HTML attribute.
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  const nav = (o, ks) => { let c = o; for (const k of ks) { if (c == null) return; c = c[k]; } return c; };
  const ensureRel = (el) => { if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; };
  const removeOldUI = () => {
    const b = document.getElementById(BADGE_ID); if (b) b.remove();
    const l = document.getElementById(LIST_ID); if (l) l.remove();
    // Both the container and the inline progress box — missing the container
    // left a stale download control behind on every re-render, so switching
    // versions stacked them up.
    document.querySelectorAll('.lb-dl-area, .lb-dl').forEach((e) => e.remove());
  };

  // Native tooltips don't render newlines — join version rows with a separator.
  const tooltip = (vs) => vs.map((v) => '[' + v.modelType + '] ' + v.fileName).join(' · ');

  // Badge labels. LoRA Manager reports a precise sub-type, so variants get
  // named as themselves rather than lumped in with their parent library:
  // lora/locon/dora, checkpoint/diffusion_model, embedding, vae/upscaler/
  // text_encoder. Library names are the fallback when no sub-type came back.
  const TYPE_ABBR = {
    // sub-types
    lora: 'LoRA',
    locon: 'LoCon',
    dora: 'DoRA',
    checkpoint: 'CKPT',
    diffusion_model: 'UNET',
    embedding: 'EMB',
    vae: 'VAE',
    upscaler: 'UPSC',
    text_encoder: 'TXT',
    // library names (fallback)
    loras: 'LoRA',
    checkpoints: 'CKPT',
    embeddings: 'EMB',
    other: '其它',
  };
  const abbrOf = (types) => (types || []).map((t) => TYPE_ABBR[t] || String(t).toUpperCase()).join('/');

  // ── Clipboard + toast ────────────────────────────────────────────────


  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Clipboard API needs a user gesture and a focused document; fall back.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }

  let toastTimer = null;
  function toast(message) {
    let el = document.getElementById('lb-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lb-toast';
      el.className = 'lb-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('lb-toast--on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('lb-toast--on'), 2200);
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  // The server's wording is accurate but assumes you know where to look.
  // Map the ones a user can actually act on to something concrete.
  const ERROR_HINTS = [
    [/default \w+ root path not set/i, '请先在 LoRA Manager 设置里指定默认模型目录'],
    [/early access/i, '该模型需付费早期访问，暂时无法下载'],
    [/already exists/i, '该模型已在库中'],
  ];

  function friendlyError(message) {
    const msg = String(message || '');
    for (const [pattern, hint] of ERROR_HINTS) {
      if (pattern.test(msg)) return hint;
    }
    return msg || '下载失败';
  }

  function makeBadge(cls, text) {
    const el = document.createElement('span');
    el.id = BADGE_ID;
    el.className = 'lb-inline-badge ' + cls;
    el.textContent = text;
    return el;
  }

  /**
   * Put an element immediately after the model title, so it sits beside it.
   *
   * Placement is relative to the title ELEMENT, not to some container found by
   * walking up the tree. That distinction matters: `[class*="Group"]` matches
   * Mantine's ubiquitous `mantine-Group-root`, so when the expected title
   * wrapper was absent the old search climbed to a container that also holds
   * the version switcher — and the control turned up among the version buttons.
   * Sitting next to the title is correct no matter how it is wrapped, and it
   * survives an SPA re-render because the element is re-acquired each time.
   *
   * Returns the element it landed in, or null when the title never appeared.
   */
  async function placeBesideTitle(el, fallback) {
    const title = await titleEl();
    const parent = (title && title.parentElement) || fallback;
    if (!parent) return null;
    if (title && title.parentElement === parent && parent.contains(title)) {
      parent.insertBefore(el, title.nextSibling);
    } else {
      parent.appendChild(el);
    }
    return parent;
  }

  // Resolves with the worker's response, or null when the message never
  // reached it (worker asleep/errored, or extension context invalidated).
  // Callers must treat null as "unknown", NOT as "not found".
  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (v) => {
          resolve(chrome.runtime.lastError ? null : (v ?? null));
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // CivArchive is a CivitAI mirror using the SAME model/version ID system.
  // Only the DOM differs (Tailwind classes instead of Mantine/CSS Modules).
  const IS_ARCHIVE = () => location.hostname.includes('civitaiarchive');

  function ctx() {
    const p = location.pathname, q = location.search;
    const m = p.match(/^\/models\/(\d+)/);
    if (m) {
      const raw = (new URLSearchParams(q)).get('modelVersionId');
      return { type: 'detail', modelId: +m[1], versionId: raw ? +raw : null, href: location.href };
    }
    const v = p.match(/^\/model-versions\/(\d+)/);
    if (v) return { type: 'version', modelId: null, versionId: +v[1], href: location.href };
    // CivArchive: /users/{name} is a model grid (user's page). CivitAI: /search/models etc.
    if (IS_ARCHIVE()) {
      if (/^\/users\//.test(p) || p === '/' || p === '/models') {
        return { type: 'list', modelId: null, versionId: null, href: location.href };
      }
    }
    if (p === '/models' || p === '/search/models' || p === '/' || p === '/search' || p.startsWith('/models?'))
      return { type: 'list', modelId: null, versionId: null, href: location.href };
    return { type: 'other', modelId: null, versionId: null, href: location.href };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DETAIL / VERSION PAGE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * The model title element, once the page has one.
   *
   * Resolves with the ELEMENT (not a container) — see placeBesideTitle for why.
   */
  function titleEl() {
    return new Promise((resolve) => {
      const sel = () => IS_ARCHIVE()
        // CivArchive: <div class="tracking-tight text-3xl font-bold">
        ? (document.querySelector('.tracking-tight.text-3xl.font-bold')
           || document.querySelector('h1'))
        : (document.querySelector('.mantine-Title-root') || document.querySelector('h1'));

      const found = sel();
      if (found) return resolve(found);

      let tries = 0;
      const iv = setInterval(() => {
        const e = sel();
        if (e) {
          clearInterval(iv);
          resolve(e);
        } else if (++tries > 50) {
          clearInterval(iv);
          resolve(null);
        }
      }, 200);
    });
  }

  async function updateDetailBadge() {
    const myReqId = ++detailReqId;

    const c = ctx();
    if (!c.modelId && c.type !== 'version') return;

    let modelId = c.modelId, versionId = c.versionId;

    // Version page: resolve modelId from page DOM
    if (!modelId && c.type === 'version') {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { const d = JSON.parse(s.textContent); const v = nav(d, ['mainEntity','model']) || nav(d, ['model']); if (typeof v === 'string') { const m2 = v.match(/\/(\d+)/); if (m2) { modelId = +m2[1]; break; } } } catch(e) {}
      }
      if (!modelId) {
        for (const a of document.querySelectorAll('a[href*="/models/"]')) {
          const m2 = (a.getAttribute('href')||'').match(/\/models\/(\d+)/);
          if (m2) { modelId = +m2[1]; break; }
        }
      }
    }
    if (!modelId && !versionId) return;

    // Show loading, clean old UI. Placed beside the title rather than in some
    // ancestor container, so it cannot land among the version buttons.
    removeOldUI();
    const anchor = await placeBesideTitle(makeBadge('lb-inline-loading', '⏳ 检查库中...'));
    if (!anchor) return;

    // Query
    I('check: mid=' + modelId + ' vid=' + versionId + ' req#' + myReqId);
    const r = await send('CHECK_MODEL', { modelId, versionId });

    // Stale check. Do NOT touch the DOM here — removeOldUI() deletes by ID, so
    // it would wipe the loading badge the newer request just inserted. That
    // request owns the UI now.
    if (myReqId !== detailReqId) {
      I('discard req#' + myReqId + ' (latest=#' + detailReqId + ')');
      return;
    }

    removeOldUI();

    // No response, an explicit error, or every endpoint down → the server is
    // unreachable. This is not the same as "not in the library".
    if (!r || r.error || r.unreachable) {
      await placeBesideTitle(makeBadge('lb-inline-error', '⚠️ ComfyUI 未连接'), anchor);
      return;
    }

    // Couldn't resolve modelId (the API can only filter by model id), so there
    // is nothing to query. Say so instead of guessing.
    if (r.needsModelId) {
      await placeBesideTitle(makeBadge('lb-inline-none', '❓ 无法确定模型 ID'), anchor);
      return;
    }

    const versions = r.versions || [];
    const matched = r.matchedVersion;
    const hasAny = r.hasAnyVersion || versions.length > 0;
    const types = r.foundTypes || [];

    I('done: matched=' + !!matched + ' others=' + versions.length + ' types=' + JSON.stringify(types));

    // Badge
    const badgeEl = document.createElement('span');
    badgeEl.id = BADGE_ID;

    if (matched) {
      badgeEl.className = 'lb-inline-badge lb-inline-owned';
      badgeEl.innerHTML = '✅ 此版本已下载 <span class="lb-badge-extra">' + esc(matched.fileName) + ' · ' + (matched.modelType || '') + '</span>';
      badgeEl.title = tooltip(versions);
    } else if (hasAny) {
      badgeEl.className = 'lb-inline-badge lb-inline-partial';
      badgeEl.textContent = '⚠️ 此版本未下载 (库中有 ' + versions.length + ' 个其他版本)';
      badgeEl.title = tooltip(versions);
    } else {
      badgeEl.className = 'lb-inline-badge lb-inline-none';
      badgeEl.textContent = '📥 此模型不在库中';
    }

    const anchor2 = await placeBesideTitle(badgeEl, anchor);
    if (!anchor2) return;

    // Everything else is inserted immediately after the last thing placed,
    // starting from the badge — which already sits beside the title. Chaining
    // this way keeps the whole group next to the title and in order, instead
    // of appending to whatever container happened to be found.
    let after = badgeEl;
    const appendNext = (el) => {
      const host = after.parentElement || anchor2;
      host.insertBefore(el, after.nextSibling);
      after = el;
    };

    // Download control — only when this exact version is not in the library yet.
    if (!matched && downloadsEnabled) {
      appendNext(makeDownloadArea(modelId, versionId));
    }

    // Version list — nothing to show when the library has no version of this model.
    if (versions.length > 0) {
      const listEl = document.createElement('div');
      listEl.id = LIST_ID;
      listEl.className = 'lb-versions';
      listEl.innerHTML = '<details class="lb-details"><summary>📂 已下载的版本 (' + versions.length + ' · ' + types.join(' + ') + ')</summary><ul class="lb-vlist">' + versions.map((v) => {
        const isM = matched && v.versionId === matched.versionId;
        const copy = v.filePath || v.fileName || '';
        // Show the precise sub-type (LoCon / DoRA / UNET / VAE…), falling back
        // to the library it lives in.
        const token = v.subType || v.modelType || 'lora';
        return '<li class="' + (isM ? 'lb-vmatch' : '') + '" data-lb-copy="' + escAttr(copy) + '" title="点击复制本地路径">' +
          '<span class="lb-vtype lb-vtype--' + (v.modelType || 'lora') + '">' + esc(abbrOf([token])) + '</span>' +
          '<span class="lb-vname">' + esc(v.fileName || v.name) + '</span>' +
          (v.baseModel ? '<span class="lb-vbase">' + esc(v.baseModel) + '</span>' : '') +
          (isM ? '<span class="lb-vcur">★ 当前</span>' : '') + '</li>';
      }).join('') + '</ul></details>';
      appendNext(listEl);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOWNLOAD (detail page)
  //
  // The button reflects what is actually happening. When a transfer for this
  // version is already running it is NOT a button — offering "download" again
  // is precisely how the same model gets fetched repeatedly, since a running
  // download is not yet in the library. Live progress lives in the bubble, so
  // it stays visible on every page, not just this one.
  // ═══════════════════════════════════════════════════════════════════

  const activeFor = (modelId, versionId) => activeDownloads.find(
    (d) => String(d.modelId) === String(modelId) && String(d.versionId) === String(versionId)
  ) || null;

  function makeDownloadArea(modelId, versionId) {
    const wrap = document.createElement('span');
    wrap.className = 'lb-dl-area';
    // Read back on every poll to decide between "download" and "downloading".
    wrap.dataset.lbModel = String(modelId);
    wrap.dataset.lbVersion = String(versionId);
    renderDownloadArea(wrap);
    return wrap;
  }

  function renderDownloadArea(wrap) {
    const modelId = wrap.dataset.lbModel;
    const versionId = wrap.dataset.lbVersion;
    const running = activeFor(modelId, versionId);

    if (running) {
      const hasNumbers = running.progress != null;
      const p = hasNumbers ? Math.max(0, Math.min(100, Math.round(running.progress))) : 0;
      wrap.innerHTML = '<span class="lb-dl lb-dl-inline">' +
        '<span class="lb-dl-bar"><i style="width:' + p + '%"></i></span>' +
        '<span class="lb-dl-pct">' + (hasNumbers ? p + '%' : '准备中') + '</span>' +
        '<button type="button" class="lb-dl-cancel">取消</button></span>';

      wrap.querySelector('.lb-dl-cancel').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.target.disabled = true;
        const res = await send('CANCEL_DOWNLOAD', { downloadId: running.downloadId });
        toast(res && res.success ? '已取消下载（已下载的部分保留）' : '❌ 取消失败');
      });
      return;
    }

    wrap.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'lb-dl-btn';
    btn.type = 'button';
    btn.textContent = '⬇️ 下载到库';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Disable synchronously — the area only re-renders after the round trip.
      btn.disabled = true;
      try {
        const started = await send('DOWNLOAD_MODEL', {
          modelId,
          versionId,
          // So the bubble can name this download on every other page too.
          modelName: pageModelName(),
        });
        if (!started || !started.success) {
          toast('❌ ' + friendlyError(started && started.error));
          btn.disabled = false;
          return;
        }
        toast(started.reused
          ? '⏳ 该版本已在下载中，进度见右下角'
          : '⬇️ 已开始下载，进度见右下角');
        // Next poll turns this area into the running state.
        pollDownloads();
      } catch (err) {
        btn.disabled = false;
      }
    });
    wrap.appendChild(btn);
  }

  /** The model's name as shown on this page, for labelling the download. */
  function pageModelName() {
    const h1 = document.querySelector('.mantine-Title-root, h1');
    const t = (h1 && h1.textContent || '').trim();
    if (t) return t;
    return (document.title || '').split(/[|·]/)[0].trim() || null;
  }

  /** Re-render every download area on the page from the latest poll. */
  function refreshDownloadAreas() {
    document.querySelectorAll('.lb-dl-area').forEach(renderDownloadArea);
  }

  /**
   * Re-check whatever this page shows for a model whose download just ended.
   *
   * A list page marks a card as scanned the moment it answers, and never looks
   * again — so a card that read "not in library" before the download would keep
   * saying so forever, even though the model is now there. Clearing just that
   * model's cards and re-scanning is cheap; the cached answers are dropped too,
   * or the re-check would be answered from the pre-download cache.
   */
  async function refreshModelOnPage(modelId) {
    if (modelId == null) return;
    await send('INVALIDATE_MODEL', { modelId });

    const c = ctx();
    if (c.type === 'list') {
      let cleared = 0;
      for (const link of findCardLinks()) {
        const f = cardFrame(link);
        if (!f || cardModelId(f) !== Number(modelId)) continue;
        // Reset the card completely. Clearing only CARD_DONE would leave the
        // old badge in place and the re-check would stack a second one on top.
        f.removeAttribute(CARD_DONE);
        f.classList.remove(CARD_MARKER);
        f.querySelectorAll('.' + BADGE_CLS + ', .' + OVL_CLS).forEach((e) => e.remove());
        cleared++;
      }
      if (cleared) {
        I('re-checking', cleared, 'card(s) after download, model', modelId);
        scanNewCards();
      }
      return;
    }

    // Detail / version page: the badge for this page may have changed.
    if (Number(modelId) === Number(c.modelId) || c.type === 'version') {
      updateDetailBadge();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // LIST PAGE
  // ═══════════════════════════════════════════════════════════════════

  function findCardLinks() {
    // CivArchive: <a class="block group relative rounded-lg ... shadow-lg border ...">
    // The <a> element IS the card — no need to walk up to a container.
    if (IS_ARCHIVE()) {
      return Array.from(document.querySelectorAll('a[href*="/models/"][class*="shadow-lg"]'))
        .filter((a) => /\/models\/\d+/.test(a.getAttribute('href') || '') && a.offsetWidth >= 60);
    }
    const all = document.querySelectorAll('a[href*="/models/"][class*="linkOrClick"]');
    const out = [];
    for (const a of all) {
      if (!/\/models\/\d+/.test(a.getAttribute('href') || '')) continue;
      if (a.offsetWidth < 60) continue;
      out.push(a);
    }
    return out;
  }

  function cardFrame(link) {
    // CivArchive: <a> itself is the card
    if (IS_ARCHIVE()) return link;
    for (let p = link.parentElement; p && p !== document.body; p = p.parentElement) {
      const c = (p.className || '') + ' ' + (p.getAttribute('class') || '');
      if (c.includes('rounded') && c.includes('shadow') && c.includes('flex-col')) return p;
    }
    const fb = link.closest('[class*="rounded"][class*="shadow"]');
    if (fb && fb !== document.body) return fb;
    return link.parentElement?.parentElement || link;
  }

  function cardModelId(frame) {
    // CivArchive: frame is the <a>, CivitAI: <a class="linkOrClick"> inside frame
    const a = frame.tagName === 'A' ? frame : frame.querySelector('a[class*="linkOrClick"]');
    if (!a) return null;
    const m = (a.getAttribute('href') || '').match(/\/models\/(\d+)/);
    return m ? +m[1] : null;
  }

  // Undo a scan attempt: drop the overlay and the pending marker so these
  // cards stay eligible for the next scan.
  function abandon(todo) {
    for (const { frame } of todo) {
      const ovl = frame.querySelector('.' + OVL_CLS);
      if (ovl) ovl.remove();
      frame.removeAttribute(CARD_PENDING);
    }
  }

  // One pending retry at a time. Without this a dropped server would either
  // hammer it on every scroll, or (before) leave cards dead forever. While the
  // server is down the interval is much longer — retrying every 10s against
  // something that is not running achieves nothing but churn.
  function scheduleRetry() {
    if (retryTimer) return;
    const delay = serverDown ? PROBE_WHILE_DOWN_MS : 10000;
    I('ComfyUI 不可达，已暂停检查，' + Math.round(delay / 1000) + ' 秒后探测一次');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (ctx().type === 'list') scanNewCards();
    }, delay);
  }

  // While the server is known to be unreachable, a scan can only fail — so it
  // is skipped entirely rather than showing a spinner for a request that is
  // certain to fail, then taking it away again. Recovery is a single probe
  // every PROBE_WHILE_DOWN_MS, so starting ComfyUI is still noticed on its own.
  let serverDown = false;
  let probeAfter = 0;
  const PROBE_WHILE_DOWN_MS = 20000;

  async function scanNewCards() {
    if (scanLock) return;
    if (serverDown && Date.now() < probeAfter) return;
    // A probe during a known outage is a reachability check, nothing more. The
    // spinner is skipped: stamping ⏳ on every card only to take it away again
    // is itself a visible flash, and the request it stands for is the one most
    // likely to fail. Recovery is unaffected — badges appear on the pass that
    // succeeds.
    const probing = serverDown;
    scanLock = true;
    const todo = [];
    try {
      const links = findCardLinks();
      for (const link of links) {
        const f = cardFrame(link);
        if (!f || f === document.body) continue;
        if (f.hasAttribute(CARD_DONE) || f.hasAttribute(CARD_PENDING)) continue;
        const mid = cardModelId(f);
        if (!mid) continue;
        todo.push({ frame: f, modelId: mid });
        f.setAttribute(CARD_PENDING, '1');
      }
      if (!todo.length) return;
      I('scan:', todo.length, probing ? 'cards (探测中，不显示遮罩)' : 'new cards');
      if (!probing) for (const { frame } of todo) {
        ensureRel(frame);
        const d = document.createElement('div'); d.className = OVL_CLS; d.textContent = '⏳';
        frame.appendChild(d);
      }
      const ids = [...new Set(todo.map((t) => t.modelId))];
      const res = await send('CHECK_MODELS_BATCH', { modelIds: ids });

      // No response, or every endpoint failed → ComfyUI unreachable. Leaving
      // CARD_DONE off is what lets these cards recover once it comes back.
      if (!res || !res.results || res.ok === false) {
        serverDown = true;
        probeAfter = Date.now() + PROBE_WHILE_DOWN_MS;
        abandon(todo);
        scheduleRetry();
        return;
      }
      serverDown = false;

      const results = res.results;
      let n = 0, retryNeeded = false;
      for (const { frame, modelId } of todo) {
        const ovl = frame.querySelector('.' + OVL_CLS); if (ovl) ovl.remove();
        frame.removeAttribute(CARD_PENDING);

        const hit = results[modelId];

        // No endpoint answered for this card — leave it unscanned so a later
        // pass picks it up, rather than marking it done with no badge.
        if (!hit || hit.unknown) { retryNeeded = true; continue; }

        frame.setAttribute(CARD_DONE, '1');
        if (hit.found) {
          frame.classList.add(CARD_MARKER);
          const abbr = abbrOf(hit.foundTypes);
          const count = hit.versionCount || 1;
          const names = hit.names || [];

          const d = document.createElement('div');
          d.className = BADGE_CLS;
          d.textContent = '✅' + abbr + '×' + count;
          // Carries the payload for the delegated click handler and popover.
          d.dataset.lbCopy = names[0] || '';

          const pop = document.createElement('div');
          pop.className = 'lb-card-pop';
          pop.innerHTML =
            '<div class="lb-pop-head">库中已有 ' + count + ' 个版本 · ' + esc(abbr) + '</div>' +
            names.map((nm) => '<div class="lb-pop-file">' + esc(nm) + '</div>').join('') +
            (count > names.length ? '<div class="lb-pop-more">…还有 ' + (count - names.length) + ' 个</div>' : '') +
            '<div class="lb-pop-hint">点击复制文件名</div>';
          d.appendChild(pop);

          ensureRel(frame); frame.appendChild(d); n++;
        }
      }
      if (retryNeeded) scheduleRetry();
      if (n) I('scan:', n, 'badges');
    } catch (e) {
      // Never leave cards stuck in PENDING — scanNewCards skips those forever.
      abandon(todo);
      I('scan error:', (e && e.message) || e);
    } finally { scanLock = false; }
  }

  function resetList() {
    document.querySelectorAll('.' + CARD_MARKER).forEach((e) => e.classList.remove(CARD_MARKER));
    document.querySelectorAll('.' + BADGE_CLS).forEach((e) => e.remove());
    document.querySelectorAll('.' + OVL_CLS).forEach((e) => e.remove());
    document.querySelectorAll('[' + CARD_DONE + ']').forEach((e) => e.removeAttribute(CARD_DONE));
    document.querySelectorAll('[' + CARD_PENDING + ']').forEach((e) => e.removeAttribute(CARD_PENDING));
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAIN — no global lock, just dispatch
  // ═══════════════════════════════════════════════════════════════════

  function handlePage() {
    const c = ctx();

    // Full URL changed (different page or SPA nav to new page)
    const urlChanged = location.href !== lastUrl;
    if (urlChanged) {
      I('nav:', c.type, c.versionId ? 'vid=' + c.versionId : '');
      if (c.type === 'list') resetList();
      if (c.type !== 'detail' && c.type !== 'version') removeOldUI();
      lastUrl = location.href;
    }

    // Detail page: re-check on URL change AND on versionId change
    if (c.type === 'detail' || c.type === 'version') {
      const hrefKey = c.href;
      if (hrefKey !== lastDetailHref) {
        lastDetailHref = hrefKey;
        updateDetailBadge();
      }
    }

    // List page
    if (c.type === 'list') {
      scanNewCards();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // DETECTION
  // ═══════════════════════════════════════════════════════════════════

  // One delegated listener instead of one per badge: badges come and go with
  // every scan, and the cards' own links would otherwise also navigate.
  document.addEventListener('click', (e) => {
    const target = e.target && e.target.closest
      ? (e.target.closest('.' + BADGE_CLS) || e.target.closest('[data-lb-copy]'))
      : null;
    if (!target) return;

    const text = target.dataset.lbCopy;
    if (!text) return;

    // The badge sits on top of the card link — don't open the model page.
    e.preventDefault();
    e.stopPropagation();

    copyText(text).then((ok) => {
      toast(ok ? '📋 已复制：' + text : '❌ 复制失败');
    });
  }, true);

  // Scroll → list
  let st;
  window.addEventListener('scroll', () => {
    if (ctx().type !== 'list') return;
    clearTimeout(st); st = setTimeout(scanNewCards, 350);
  }, { passive: true });

  /** Elements this extension puts on the page — and their descendants.
   *
   *  Descendants matter: the download bubble rebuilds itself with innerHTML on
   *  every poll, and the badge's popover is nested inside the badge. Matching
   *  only the added node's own class would call those page mutations, and a
   *  scan would then be scheduled every 1.5 seconds for as long as a download
   *  runs. A text node counts as ours when its parent is.
   *
   *  Built lazily: BUBBLE_ID is declared further down, and this runs only from
   *  the observer callback, long after the module has finished initialising. */
  const isOurNode = (n) => {
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    return !!(el && el.closest && el.closest(
      '.' + OVL_CLS + ', .' + BADGE_CLS + ', .lb-card-pop, .lb-dl-area, .lb-dl, ' +
      '#lb-inline-badge, #lb-version-list, #' + BUBBLE_ID + ', #lb-toast'));
  };

  // MutationObserver → list only (new lazy-loaded DOM)
  //
  // It must ignore insertions this extension makes itself. Otherwise adding a
  // badge or a spinner is itself a mutation, which schedules another scan,
  // which adds more spinners — a loop that never ends while the cards stay
  // unmarked, i.e. exactly when the server is unreachable. Measured: 201
  // spinner insertions and 67 batch requests in 25 seconds, which is what the
  // user saw as constant flickering.
  let mt;
  new MutationObserver((records) => {
    if (ctx().type !== 'list') return;
    const fromPage = records.some((r) =>
      Array.from(r.addedNodes).some((n) => n.nodeType === 1 && !isOurNode(n)));
    if (!fromPage) return;
    clearTimeout(mt); mt = setTimeout(scanNewCards, 400);
  }).observe(document.body, { childList: true, subtree: true });

  // URL change via history API
  const _push = history.pushState;
  history.pushState = function (...a) { _push.apply(this, a); onUrlChange(); };
  const _replace = history.replaceState;
  history.replaceState = function (...a) { _replace.apply(this, a); onUrlChange(); };
  window.addEventListener('popstate', onUrlChange);

  function onUrlChange() {
    // Immediate: compare location.href, trigger if different
    if (location.href !== lastUrl) {
      handlePage();
    }
  }

  // Polling fallback — catches shallow SPA routing that doesn't fire history
  // events. Delegates to handlePage() rather than advancing lastUrl itself:
  // updating it here would swallow the change and skip resetList() on list pages.
  function poll() {
    if (location.href !== lastUrl) handlePage();
    setTimeout(poll, 800);
  }

  // ═══════════════════════════════════════════════════════════════════
  // EXTERNAL TRIGGERS
  // ═══════════════════════════════════════════════════════════════════

  // Full re-check: drop cached API results, clear markers, scan again.
  async function rescan() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    await send('CLEAR_CACHE');
    lastUrl = '';
    lastDetailHref = '';
    handlePage();
  }

  // Requested by the popup's refresh button — re-checks in place instead of
  // reloading the tab, so scroll position survives.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'RESCAN') {
      rescan().then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false })
      );
      return true;
    }

    // What the popup shows about this page. Synchronous, so no async reply.
    // The ids are included because the popup cannot read the tab's URL without
    // an extra permission — this script is the authority on where we are.
    if (message?.type === 'PAGE_STATUS') {
      const c = ctx();
      sendResponse({
        ok: true,
        pageType: c.type,
        modelId: c.modelId,
        versionId: c.versionId,
        badged: document.querySelectorAll('.' + BADGE_CLS).length,
        pending: document.querySelectorAll('[' + CARD_PENDING + ']').length,
        inline: (document.getElementById(BADGE_ID) || {}).textContent || null,
        retryPending: !!retryTimer,
      });
      return false;
    }

    return false;
  });

  // Settings changed (e.g. a different ComfyUI host) — cached results are stale.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.config) return;
    readConfig();
    rescan();
  });

  function readConfig() {
    try {
      chrome.storage.sync.get('config', (stored) => {
        if (chrome.runtime.lastError) return;
        // Default to enabled so the button works before settings are opened.
        downloadsEnabled = stored?.config?.enableDownloads !== false;
      });
    } catch (e) { /* storage unavailable */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOWNLOAD BUBBLE
  //
  // A download takes minutes and is invisible from the page that started it,
  // which is how the same model ends up downloaded several times. This panel
  // is the answer: present on every CivitAI page, showing what is running and
  // how far along, so the state is never a guess.
  // ═══════════════════════════════════════════════════════════════════

  const BUBBLE_ID = 'lb-downloads';
  let activeDownloads = [];
  let recentFinishes = [];   // { label, ok, until }
  let bubbleTimer = null;

  function bubbleEl() {
    let el = document.getElementById(BUBBLE_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = BUBBLE_ID;
      el.className = 'lb-bubble';
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  function renderBubble() {
    const el = bubbleEl();
    const now = Date.now();
    recentFinishes = recentFinishes.filter((f) => f.until > now);

    if (activeDownloads.length === 0 && recentFinishes.length === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;

    const rows = activeDownloads.map((d) => {
      // progress is null until the server starts reporting bytes — the request
      // is being validated, or metadata is being fetched. Showing "准备中…"
      // is the whole point: the user must be able to see it started.
      const hasNumbers = d.progress != null;
      const p = hasNumbers ? Math.max(0, Math.min(100, Math.round(d.progress))) : 0;
      const speed = d.bytesPerSecond ? fmtBytes(d.bytesPerSecond) + '/s' : '';
      const size = d.totalBytes ? fmtBytes(d.bytesDownloaded || 0) + ' / ' + fmtBytes(d.totalBytes) : '';
      // A download that has not moved for a while is not dead — CivitAI stalls
      // and LoRA Manager retries with resume. Say so instead of looking frozen.
      const stalled = d.stalled
        ? '<div class="lb-bubble-stall">⚠️ 网络卡顿，正在重试…</div>' : '';
      return '<div class="lb-bubble-item">' +
        '<div class="lb-bubble-row"><span class="lb-bubble-name">' +
          esc(d.label || ('模型 ' + (d.modelId ?? '?'))) + '</span>' +
        '<span class="lb-bubble-pct' + (hasNumbers ? '' : ' is-pending') + '">' +
          (hasNumbers ? p + '%' : '准备中…') + '</span></div>' +
        '<div class="lb-bubble-bar"><i style="width:' + p + '%"></i></div>' +
        (hasNumbers
          ? '<div class="lb-bubble-meta">' + esc([size, speed].filter(Boolean).join(' · ')) + '</div>'
          : '<div class="lb-bubble-meta">等待服务器开始传输…</div>') +
        stalled +
        '</div>';
    }).join('');

    // Three outcomes, not two. `ok` is tri-state: a transfer that ended without
    // anyone seeing its result is genuinely unknown, and showing that as a red
    // failure invents a result — which is exactly what this rewrite is meant to
    // stop doing.
    const DONE_LOOK = {
      true:  { cls: '',           icon: '✅' },
      false: { cls: 'is-err',     icon: '❌' },
      null:  { cls: 'is-unknown', icon: '⏳' },
    };
    const done = recentFinishes.map((f) => {
      const look = DONE_LOOK[String(f.ok)] || DONE_LOOK.null;
      return '<div class="lb-bubble-item lb-bubble-done ' + look.cls + '">' +
        look.icon + ' ' + esc(f.label) + '</div>';
    }).join('');

    // Once nothing is running the bubble is just a result notice, so it gets a
    // dismiss affordance: the text stays long enough to read, and one click
    // clears it. A running transfer gets no ✕ — it is not dismissable.
    const hasRunning = activeDownloads.length > 0;
    el.innerHTML =
      '<div class="lb-bubble-head">' +
        (hasRunning ? '⬇️ 正在下载 (' + activeDownloads.length + ')' : '下载结果') +
        (hasRunning ? '' : '<button type="button" class="lb-bubble-close" title="关闭">✕</button>') +
      '</div>' + rows + done;

    if (!hasRunning) {
      const close = el.querySelector('.lb-bubble-close');
      if (close) {
        close.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          recentFinishes = [];
          renderBubble();
        });
      }
    }
  }

  /**
   * Keep the bubble in step with the worker.
   *
   * Exception-safe on purpose: a throw anywhere in here used to stop the loop
   * for good, freezing the bubble on whatever it last showed — so a finished
   * download's result stayed on screen forever with nothing left to update or
   * age it out.
   */
  async function pollDownloads() {
    clearTimeout(bubbleTimer);
    try {
      await pollOnce();
    } catch (e) {
      I('poll error:', (e && e.message) || e);
    } finally {
      // Always re-render and always reschedule. The render is what expires
      // finished rows, so it must happen even when a poll fails.
      renderBubble();
      bubbleTimer = setTimeout(pollDownloads, 2000);
    }
  }

  // A poll that fails says nothing about what is running, so the last known
  // list is kept — but not forever: after this many consecutive failures the
  // state is unknown, and showing a stale "downloading" row forever is worse
  // than showing nothing.
  let failedPolls = 0;

  async function pollOnce() {
    const res = await send('ACTIVE_DOWNLOADS');

    if (!res || !res.success || !Array.isArray(res.downloads)) {
      if (++failedPolls >= 3) activeDownloads = [];
      return;
    }
    failedPolls = 0;

    // Everything below assumes the poll actually answered.
    {
      const seen = new Set(res.downloads.map((d) => d.downloadId));
      // Anything we were showing that is no longer running has just finished.
      for (const prev of activeDownloads) {
        if (!seen.has(prev.downloadId)) {
          prevBytes.delete(prev.downloadId);   // don't let the stall tracker grow
          recentFinishes.push({
            label: prev.label || ('模型 ' + (prev.modelId ?? '?')),
            ok: true,
            until: Date.now() + 10000,
          });
          // The library changed — this page's marks for that model are stale.
          refreshModelOnPage(prev.modelId);
        }
      }
      activeDownloads = res.downloads.map((d) => ({ ...d, ...labelFor(d) }));

      // Stall detection: same byte count across two polls more than ~90s apart.
      const now = Date.now();
      for (const d of activeDownloads) {
        const prev = prevBytes.get(d.downloadId);
        if (!prev || prev.bytes !== d.bytesDownloaded) {
          prevBytes.set(d.downloadId, { bytes: d.bytesDownloaded, at: now });
          d.stalled = false;
        } else {
          d.stalled = now - prev.at > 90000;
        }
      }
      refreshDownloadAreas();

      // Pick up outcomes that finished while no page was watching, so the
      // bubble is the surface that reports them.
      const claimed = await send('CLAIM_NOTICES');
      if (claimed && claimed.notices && claimed.notices.length) {
        for (const n of claimed.notices) {
          recentFinishes.push({
            // Keep the tri-state intact — `n.ok === true` would turn "unknown"
            // into "failed" and show a red cross for a download that may well
            // have succeeded. The server's own wording is accurate but assumes
            // you know where to look, so failures get the friendlier phrasing.
            label: n.ok === false ? friendlyError(n.error)
                 : n.ok === true ? (n.note || n.fileName || '下载完成')
                 : '下载已完成，正在等待 LoRA Manager 索引…',
            ok: n.ok,
            until: Date.now() + 12000,
          });
          // Ids travel with the notice so the page can refresh its marks for
          // that model — including on a list page, where a card may have been
          // written off as "not in library" before the download started.
          refreshModelOnPage(n.modelId);
        }
        renderBubble();
      }
    }
  }

  const prevBytes = new Map();

  /** Best available name for a running download, from what the page knows. */
  function labelFor(d) {
    return { label: d.modelName || null };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOWNLOAD NOTICES FROM OTHER TABS
  // ═══════════════════════════════════════════════════════════════════

  // Outcomes are reported through the bubble rather than a toast — see the
  // claim inside pollDownloads(). A toast that vanishes is exactly the kind of
  // feedback that made a running download look like a failed one.

  // ═══════════════════════════════════════════════════════════════════
  // DEBUG
  // ═══════════════════════════════════════════════════════════════════

  // Snapshot of what the extension currently sees. Content scripts live in an
  // isolated world, so the DevTools console must be switched to this
  // extension's context before calling this — it is not visible from the
  // page's own console.
  window.__loraBridgeDiag = () => ({
    url: location.href,
    pageType: ctx().type,
    scanLock,
    retryPending: !!retryTimer,
    detailReqId,
    cards: {
      links: findCardLinks().length,
      done: document.querySelectorAll('[' + CARD_DONE + ']').length,
      pending: document.querySelectorAll('[' + CARD_PENDING + ']').length,
      badged: document.querySelectorAll('.' + BADGE_CLS).length,
    },
    inlineBadge: (document.getElementById(BADGE_ID) || {}).textContent || null,
    versionList: !!document.getElementById(LIST_ID),
  });

  // ═══════════════════════════════════════════════════════════════════
  // START
  // ═══════════════════════════════════════════════════════════════════

  // One poller drives both the bubble and any download area on the page. It
  // also keeps the worker alive while a transfer is running, which is what
  // makes the numbers live.
  pollDownloads();

  // Coming back to this tab is the moment the user is looking — refresh now
  // rather than waiting out a background-tab throttle interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollDownloads();
  });

  I('loaded');
  readConfig();
  lastUrl = '';
  lastDetailHref = '';
  handlePage();
  poll();
  setTimeout(() => { if (ctx().type === 'list') scanNewCards(); }, 2000);
})();
