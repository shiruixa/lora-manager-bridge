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
  let scanLock = false, detailReqId = 0;
  let lastUrl = '', lastDetailHref = '';  // track full href for detail version switches

  const I = (...a) => console.info(TAG, ...a);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  const nav = (o, ks) => { let c = o; for (const k of ks) { if (c == null) return; c = c[k]; } return c; };
  const ensureRel = (el) => { if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; };
  const removeOldUI = () => {
    const b = document.getElementById(BADGE_ID); if (b) b.remove();
    const l = document.getElementById(LIST_ID); if (l) l.remove();
  };

  function send(type, payload) {
    return new Promise((r) => {
      chrome.runtime.sendMessage({ type, payload }, (v) => {
        r(v && !chrome.runtime.lastError ? v : { found: false });
      });
    });
  }

  function ctx() {
    const p = location.pathname, q = location.search;
    const m = p.match(/^\/models\/(\d+)/);
    if (m) {
      const raw = (new URLSearchParams(q)).get('modelVersionId');
      return { type: 'detail', modelId: +m[1], versionId: raw ? +raw : null, href: location.href };
    }
    const v = p.match(/^\/model-versions\/(\d+)/);
    if (v) return { type: 'version', modelId: null, versionId: +v[1], href: location.href };
    if (p === '/models' || p === '/search/models' || p === '/' || p === '/search' || p.startsWith('/models?'))
      return { type: 'list', modelId: null, versionId: null, href: location.href };
    return { type: 'other', modelId: null, versionId: null, href: location.href };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DETAIL / VERSION PAGE
  // ═══════════════════════════════════════════════════════════════════

  function titleAnchor() {
    return new Promise((r) => {
      const sel = () => document.querySelector('.mantine-Title-root') || document.querySelector('h1');
      const e = sel();
      if (e) return r(e.closest('[class*="Stack"], [class*="Group"]') || e.parentElement);
      let t = 0;
      const iv = setInterval(() => {
        const e = sel();
        if (e) { clearInterval(iv); r(e.closest('[class*="Stack"], [class*="Group"]') || e.parentElement); }
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
    const loadingEl = document.createElement('span');
    loadingEl.id = BADGE_ID;
    loadingEl.className = 'lb-inline-badge lb-inline-loading';
    loadingEl.textContent = '⏳ 检查库中...';
    anchor.appendChild(loadingEl);

    // Query
    I('check: mid=' + modelId + ' vid=' + versionId + ' req#' + myReqId);
    const r = await send('CHECK_MODEL', { modelId, versionId });

    // Stale check — clean up loading badge even if discarding
    if (myReqId !== detailReqId) {
      I('discard req#' + myReqId + ' (latest=#' + detailReqId + ')');
      removeOldUI();
      return;
    }

    removeOldUI();

    if (!r || r.error) {
      const errEl = document.createElement('span');
      errEl.id = BADGE_ID;
      errEl.className = 'lb-inline-badge lb-inline-error';
      errEl.textContent = '⚠️ ComfyUI 未连接';
      anchor.appendChild(errEl);
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
      badgeEl.title = versions.map((v) => '[' + v.modelType + '] ' + v.fileName).join('\n');
    } else if (hasAny) {
      badgeEl.className = 'lb-inline-badge lb-inline-partial';
      badgeEl.textContent = '⚠️ 此版本未下载 (库中有 ' + versions.length + ' 个其他版本)';
      badgeEl.title = versions.map((v) => '[' + v.modelType + '] ' + v.fileName).join('\n');
    } else {
      badgeEl.className = 'lb-inline-badge lb-inline-none';
      badgeEl.textContent = '📥 此模型不在库中';
    }

    // Re-acquire anchor — it may have been replaced by SPA re-render
    const anchor2 = await titleAnchor();
    if (anchor2) anchor2.appendChild(badgeEl);
    else anchor.appendChild(badgeEl); // fallback

    // Version list
    if (versions.length > 0 && anchor2) {
      const listEl = document.createElement('div');
      listEl.id = LIST_ID;
      listEl.className = 'lb-versions';
      listEl.innerHTML = '<details class="lb-details"><summary>📂 已下载的版本 (' + versions.length + ' · ' + types.join(' + ') + ')</summary><ul class="lb-vlist">' + versions.map((v) => { const isM = matched && v.versionId === matched.versionId; return '<li class="' + (isM ? 'lb-vmatch' : '') + '"><span class="lb-vtype lb-vtype--' + (v.modelType || 'lora') + '">' + ((v.modelType || 'L').toUpperCase().slice(0,4)) + '</span><span class="lb-vname">' + esc(v.fileName || v.name) + '</span>' + (v.baseModel ? '<span class="lb-vbase">' + esc(v.baseModel) + '</span>' : '') + (isM ? '<span class="lb-vcur">★ 当前</span>' : '') + '</li>'; }).join('') + '</ul></details>';
      (anchor2.parentElement || anchor2).insertBefore(listEl, anchor2.nextSibling);
    } else if (anchor2) {
      const listEl = document.createElement('div');
      listEl.id = LIST_ID;
      listEl.className = 'lb-versions';
      // Don't insert an empty list — nothing to show
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // LIST PAGE
  // ═══════════════════════════════════════════════════════════════════

  function findCardLinks() {
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
    for (let p = link.parentElement; p && p !== document.body; p = p.parentElement) {
      const c = (p.className || '') + ' ' + (p.getAttribute('class') || '');
      if (c.includes('rounded') && c.includes('shadow') && c.includes('flex-col')) return p;
    }
    const fb = link.closest('[class*="rounded"][class*="shadow"]');
    if (fb && fb !== document.body) return fb;
    return link.parentElement?.parentElement || link;
  }

  function cardModelId(frame) {
    const a = frame.tagName === 'A' ? frame : frame.querySelector('a[class*="linkOrClick"]');
    if (!a) return null;
    const m = (a.getAttribute('href') || '').match(/\/models\/(\d+)/);
    return m ? +m[1] : null;
  }

  async function scanNewCards() {
    if (scanLock) return;
    scanLock = true;
    try {
      const links = findCardLinks();
      const todo = [];
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
        d.style.cssText = 'position:absolute;top:6px;right:6px;z-index:10;padding:0 6px;border-radius:3px;font-size:10px;background:rgba(0,0,0,.5);color:#aaa;pointer-events:none;';
        frame.appendChild(d);
      }
      const ids = [...new Set(todo.map((t) => t.modelId))];
      const { results } = await send('CHECK_MODELS_BATCH', { modelIds: ids });
      let n = 0;
      for (const { frame, modelId } of todo) {
        const ovl = frame.querySelector('.' + OVL_CLS); if (ovl) ovl.remove();
        frame.removeAttribute(CARD_PENDING); frame.setAttribute(CARD_DONE, '1');
        if (results?.[modelId]?.found) {
          frame.classList.add(CARD_MARKER);
          const abbr = (results[modelId].foundTypes || []).map((t) => t === 'checkpoint' ? 'CKPT' : 'LoRA').join('/');
          const d = document.createElement('div'); d.className = BADGE_CLS;
          d.textContent = '✅' + abbr + '×' + (results[modelId].versionCount || 1);
          d.title = '库中有 ' + (results[modelId].versionCount || 1) + ' 个版本 (' + abbr + ')';
          d.style.cssText = 'position:absolute;top:6px;right:6px;z-index:10;padding:0 6px;border-radius:3px;font-size:10px;font-weight:700;background:#27ae60;color:#fff;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.25);white-space:nowrap;';
          ensureRel(frame); frame.appendChild(d); n++;
        }
      }
      if (n) I('scan:', n, 'badges');
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

  // Polling fallback — catches shallow SPA routing that doesn't fire history events
  // Runs every 800ms on detail pages
  function poll() {
    const c = ctx();
    if ((c.type === 'detail' || c.type === 'version') && c.href !== lastDetailHref) {
      lastDetailHref = c.href;
      updateDetailBadge();
    }
    // Also update lastUrl if needed (poll catches URL changes too)
    if (c.href !== lastUrl) {
      lastUrl = c.href;
    }
    setTimeout(poll, 800);
  }

  // ═══════════════════════════════════════════════════════════════════
  // START
  // ═══════════════════════════════════════════════════════════════════

  I('loaded');
  lastUrl = location.href;
  lastDetailHref = location.href;
  handlePage();
  poll();
  setTimeout(() => { if (ctx().type === 'list') scanNewCards(); }, 2000);
})();
