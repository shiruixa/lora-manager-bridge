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
  let lastUrl = '', lastDetailHref = '';  // track full href for detail version switches

  const I = (...a) => console.info(TAG, ...a);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  const nav = (o, ks) => { let c = o; for (const k of ks) { if (c == null) return; c = c[k]; } return c; };
  const ensureRel = (el) => { if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; };
  const removeOldUI = () => {
    const b = document.getElementById(BADGE_ID); if (b) b.remove();
    const l = document.getElementById(LIST_ID); if (l) l.remove();
  };

  // Native tooltips don't render newlines — join version rows with a separator.
  const tooltip = (vs) => vs.map((v) => '[' + v.modelType + '] ' + v.fileName).join(' · ');

  function makeBadge(cls, text) {
    const el = document.createElement('span');
    el.id = BADGE_ID;
    el.className = 'lb-inline-badge ' + cls;
    el.textContent = text;
    return el;
  }

  // Badges are appended after an await, by which point an SPA re-render may
  // have replaced the original anchor with a detached node — appending there
  // would silently show nothing. Re-acquire it, falling back to the original.
  async function placeBadge(el, fallback) {
    const anchor = (await titleAnchor()) || fallback;
    anchor.appendChild(el);
    return anchor;
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

  function titleAnchor() {
    return new Promise((r) => {
      // CivArchive detail page: title is <div class="tracking-tight text-3xl font-bold">
      const sel = () => {
        if (IS_ARCHIVE()) {
          const t = document.querySelector('.tracking-tight.text-3xl.font-bold')
                 || document.querySelector('h1');
          return t;
        }
        return document.querySelector('.mantine-Title-root') || document.querySelector('h1');
      };
      const e = sel();
      if (e) return r(e.closest('[class*="Stack"], [class*="Group"], [class*="flex items-center"]') || e.parentElement);
      let t = 0;
      const iv = setInterval(() => {
        const e = sel();
        if (e) { clearInterval(iv); r(e.closest('[class*="Stack"], [class*="Group"], [class*="flex items-center"]') || e.parentElement); }
        if (++t > 50) { clearInterval(iv); r(null); }
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

    const anchor = await titleAnchor();
    if (!anchor) return;

    // Show loading, clean old UI
    removeOldUI();
    anchor.appendChild(makeBadge('lb-inline-loading', '⏳ 检查库中...'));

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
      await placeBadge(makeBadge('lb-inline-error', '⚠️ ComfyUI 未连接'), anchor);
      return;
    }

    // Couldn't resolve modelId (the API can only filter by model id), so there
    // is nothing to query. Say so instead of guessing.
    if (r.needsModelId) {
      await placeBadge(makeBadge('lb-inline-none', '❓ 无法确定模型 ID'), anchor);
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

    const anchor2 = await placeBadge(badgeEl, anchor);

    // Version list — nothing to show when the library has no version of this model.
    if (versions.length > 0) {
      const listEl = document.createElement('div');
      listEl.id = LIST_ID;
      listEl.className = 'lb-versions';
      listEl.innerHTML = '<details class="lb-details"><summary>📂 已下载的版本 (' + versions.length + ' · ' + types.join(' + ') + ')</summary><ul class="lb-vlist">' + versions.map((v) => { const isM = matched && v.versionId === matched.versionId; return '<li class="' + (isM ? 'lb-vmatch' : '') + '"><span class="lb-vtype lb-vtype--' + (v.modelType || 'lora') + '">' + ((v.modelType || 'L').toUpperCase().slice(0,4)) + '</span><span class="lb-vname">' + esc(v.fileName || v.name) + '</span>' + (v.baseModel ? '<span class="lb-vbase">' + esc(v.baseModel) + '</span>' : '') + (isM ? '<span class="lb-vcur">★ 当前</span>' : '') + '</li>'; }).join('') + '</ul></details>';
      (anchor2.parentElement || anchor2).insertBefore(listEl, anchor2.nextSibling);
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
  // hammer it on every scroll, or (before) leave cards dead forever.
  function scheduleRetry() {
    if (retryTimer) return;
    I('ComfyUI 不可达，10 秒后重试');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (ctx().type === 'list') scanNewCards();
    }, 10000);
  }

  async function scanNewCards() {
    if (scanLock) return;
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
      I('scan:', todo.length, 'new cards');
      for (const { frame } of todo) {
        ensureRel(frame);
        const d = document.createElement('div'); d.className = OVL_CLS; d.textContent = '⏳';
        frame.appendChild(d);
      }
      const ids = [...new Set(todo.map((t) => t.modelId))];
      const res = await send('CHECK_MODELS_BATCH', { modelIds: ids });

      // No response, or every endpoint failed → ComfyUI unreachable. Leaving
      // CARD_DONE off is what lets these cards recover once it comes back.
      if (!res || !res.results || res.ok === false) {
        abandon(todo);
        scheduleRetry();
        return;
      }

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
          const abbr = (hit.foundTypes || []).map((t) => t === 'checkpoint' ? 'CKPT' : 'LoRA').join('/');
          const d = document.createElement('div'); d.className = BADGE_CLS;
          d.textContent = '✅' + abbr + '×' + (hit.versionCount || 1);
          d.title = '库中有 ' + (hit.versionCount || 1) + ' 个版本 (' + abbr + ')';
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

  // Scroll → list
  let st;
  window.addEventListener('scroll', () => {
    if (ctx().type !== 'list') return;
    clearTimeout(st); st = setTimeout(scanNewCards, 350);
  }, { passive: true });

  // MutationObserver → list only (new lazy-loaded DOM)
  let mt;
  new MutationObserver((records) => {
    if (ctx().type !== 'list') return;
    if (!records.some((r) => r.addedNodes.length > 0)) return;
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
    if (message?.type !== 'RESCAN') return false;
    rescan().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  });

  // Settings changed (e.g. a different ComfyUI host) — cached results are stale.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.config) rescan();
  });

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

  I('loaded');
  lastUrl = '';
  lastDetailHref = '';
  handlePage();
  poll();
  setTimeout(() => { if (ctx().type === 'list') scanNewCards(); }, 2000);
})();
