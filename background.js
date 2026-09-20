/**
 * LoRA Manager Bridge - Background Service Worker
 *
 * Proxies API requests from content scripts to the local ComfyUI/LoRA Manager server
 * and caches results to minimize API calls.
 *
 * Checks BOTH LoRA and Checkpoint endpoints.
 */

// Default configuration
const DEFAULT_CONFIG = {
  comfyUIHost: 'http://127.0.0.1:8188',
  pollIntervalMs: 5000,
  cacheTTLMs: 30000,
};

// In-memory cache: key → { data, timestamp }
const cache = new Map();
const MAX_CACHE_SIZE = 300;

// URL → in-flight promise, so identical concurrent queries share one fetch.
const inflight = new Map();

// Entries older than this are dropped regardless of the configured TTL, so a
// cache never grows unboundedly stale. The configured TTL may exceed it.
const MIN_CACHE_AGE_MS = 120000;

// How long a loaded config is reused before hitting chrome.storage again.
// Without this, every request (including cache hits) reads storage.
const CONFIG_TTL_MS = 5000;

const REQUEST_TIMEOUT_MS = 5000;

// /api/lm/* caps page_size at 100 (see py/routes/handlers/model_handlers.py).
const PAGE_SIZE = 100;

// Max simultaneous requests to the local server.
const MAX_CONCURRENT_REQUESTS = 6;

// The libraries LoRA Manager files models into. Each is scanned separately, so
// a model can only be found by querying the library it lives in:
//   loras       — lora, locon, dora            (the LoRA variants)
//   checkpoints — checkpoint, diffusion_model  (covers the unet/diffusion_models roots)
//   embeddings  — embedding
//   other       — vae, upscaler, text_encoder  (added in LoRA Manager ~1.2)
const MODEL_ENDPOINTS = [
  { type: 'lora',       endpoint: '/api/lm/loras/list',       label: 'LoRA' },
  { type: 'checkpoint', endpoint: '/api/lm/checkpoints/list', label: 'Checkpoint' },
  { type: 'embedding',  endpoint: '/api/lm/embeddings/list',  label: 'Embedding' },
  { type: 'other',      endpoint: '/api/lm/other/list',       label: 'Other' },
];

// Endpoints the server has answered 404 for. Older LoRA Manager builds predate
// the `other` library, and probing it once per card per scan would be a pile of
// wasted requests. Cleared on CLEAR_CACHE so an upgrade gets picked up.
const unsupportedEndpoints = new Set();

const activeEndpoints = () =>
  MODEL_ENDPOINTS.filter((e) => !unsupportedEndpoints.has(e.endpoint));

// ============================================================================
// Configuration
// ============================================================================

let configMemo = null;  // { promise, timestamp }

async function loadConfig() {
  try {
    const stored = await chrome.storage.sync.get('config');
    if (stored && stored.config) {
      return { ...DEFAULT_CONFIG, ...stored.config };
    }
  } catch (e) {
    console.warn('[LoraBridge] Failed to load config:', e);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Load configuration from storage or return defaults.
 *
 * Memoized for CONFIG_TTL_MS so a burst of concurrent queries shares one
 * storage read. Concurrent callers during the first load share the same
 * promise too. Cache TTL comes from here, so this must stay cheap.
 */
function getConfig() {
  const now = Date.now();
  if (configMemo && now - configMemo.timestamp < CONFIG_TTL_MS) {
    return configMemo.promise;
  }
  configMemo = { promise: loadConfig(), timestamp: now };
  return configMemo.promise;
}

// Drop the memo as soon as the options page saves new settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.config) {
    configMemo = null;
    cache.clear();
  }
});

async function getBaseUrl() {
  const config = await getConfig();
  return config.comfyUIHost.replace(/\/+$/, '');
}

// ============================================================================
// Caching / fetching
// ============================================================================

/**
 * Evict expired and excess cache entries.
 *
 * @param {number} ttlMs configured cache TTL — never evict sooner than that,
 *                       otherwise a long TTL silently degrades to MIN_CACHE_AGE_MS.
 */
function evictCache(ttlMs) {
  const maxAge = Math.max(MIN_CACHE_AGE_MS, ttlMs || 0);
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > maxAge) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_CACHE_SIZE) {
    cache.delete(cache.keys().next().value);
  }
}

/**
 * Query the LoRA Manager API and return results.
 *
 * Requests for the same URL are coalesced: scroll and MutationObserver can
 * trigger overlapping scans, and without this they'd both hit the server
 * because the cache is only filled once the response lands.
 */
async function queryEndpoint(endpoint, params = {}, options = {}) {
  const config = await getConfig();
  const baseUrl = config.comfyUIHost.replace(/\/+$/, '');
  const url = new URL(`${baseUrl}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const cacheKey = url.toString();

  // Forced re-reads (download progress, post-download verification) must never
  // be served from cache. The fresh answer is written back rather than dropped,
  // so the caller's own follow-up reads — e.g. re-rendering the badge — see the
  // new state instead of the stale entry this call just bypassed.
  if (options.noCache) {
    const data = await fetchJson(cacheKey, REQUEST_TIMEOUT_MS);
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  }

  const ttlMs = options.ttlMs ?? config.cacheTTLMs;
  evictCache(ttlMs);

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ttlMs) {
    return cached.data;
  }

  const inflightRequest = inflight.get(cacheKey);
  if (inflightRequest) return inflightRequest;

  const request = fetchJson(cacheKey, REQUEST_TIMEOUT_MS)
    .then((data) => {
      cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    })
    .catch((error) => {
      // A 404 on a model library means this build of LoRA Manager does not have
      // it — remember that instead of re-probing it for every card.
      if (error.message === 'HTTP 404' && MODEL_ENDPOINTS.some((e) => e.endpoint === endpoint)) {
        if (!unsupportedEndpoints.has(endpoint)) {
          console.debug('[LoraBridge] library unavailable, skipping:', endpoint);
        }
        unsupportedEndpoints.add(endpoint);
      } else {
        console.debug('[LoraBridge] API request failed:', endpoint, error.message);
      }
      throw error;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });

  inflight.set(cacheKey, request);
  return request;
}

/**
 * GET a URL and parse JSON, aborting after `timeoutMs`.
 */
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Download
// ============================================================================

// downloadId → { result, error } for downloads started this session.
const downloads = new Map();

// Identity of a transfer, for spotting "this exact version is already being
// downloaded". The duplicate guard itself lives in the persisted `inFlight`
// set (see below) rather than an in-memory map, because an in-memory guard dies
// with the worker — and a user retrying an apparently-stalled download would
// then start a second transfer of the same file. The server does not overwrite
// on a name clash; it saves the second copy under a new name, so the cost is a
// duplicate on disk.
const versionKey = (modelId, versionId) => `${modelId ?? ''}:${versionId ?? ''}`;

// ---------------------------------------------------------------------------
// Surviving the worker
//
// A download runs on the server, so closing the tab that started it does not
// stop it — but it also leaves nothing generating events, and a Manifest V3
// worker is terminated after ~30s of inactivity. A multi-minute download with
// no page open therefore outlives the worker that started it, taking the
// in-flight request and its `.finally()` with it: no badge, no notice.
//
// So the bookkeeping is mirrored into `chrome.storage.session`, which outlives
// the worker within a browser session, and the outcome is re-derived from the
// server afterwards rather than remembered from a promise that no longer
// exists. (No extra permission: session storage is part of `storage`.)
// ---------------------------------------------------------------------------

const INFLIGHT_KEY = 'inflightDownloads';   // downloadId → { modelId, versionId, at }
const PENDING_KEY = 'pendingNotices';       // downloadId → { ok, fileName, error, at }

const inFlight = new Map();
const unnotified = new Map();   // ok: true = succeeded, false = failed, null = unknown

let hydrated = false;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await chrome.storage.session.get([INFLIGHT_KEY, PENDING_KEY]);
    for (const [id, v] of Object.entries(stored[INFLIGHT_KEY] || {})) inFlight.set(id, v);
    for (const [id, v] of Object.entries(stored[PENDING_KEY] || {})) unnotified.set(id, v);
  } catch (e) {
    console.debug('[LoraBridge] could not restore download state:', e.message);
  }
  updateBadge();
}

function persistState() {
  try {
    chrome.storage.session.set({
      [INFLIGHT_KEY]: Object.fromEntries(inFlight),
      [PENDING_KEY]: Object.fromEntries(unnotified),
    });
  } catch (e) { /* storage unavailable */ }
}

function updateBadge() {
  const notices = [...unnotified.values()];
  const count = notices.length;
  // Red only for a confirmed failure; amber when the outcome could not be
  // established, so a slow index doesn't read as an error.
  const colour = notices.some((n) => n.ok === false) ? '#e74c3c'
    : notices.some((n) => n.ok === null) ? '#e67e22'
    : '#27ae60';
  try {
    chrome.action.setBadgeText({ text: count ? String(count) : '' });
    if (count) chrome.action.setBadgeBackgroundColor({ color: colour });
  } catch (e) { /* action API unavailable */ }
}

/**
 * Settle downloads whose worker died mid-transfer.
 *
 * The server keeps the only durable record of a transfer, so the outcome is
 * re-derived from it: progress still listed → still running; gone → the
 * transfer is over, and whether the file landed is answered by the library.
 */
async function reconcileDownloads() {
  await hydrate();
  if (inFlight.size === 0) return;

  for (const [downloadId, info] of [...inFlight]) {
    let stillRunning = true;
    try {
      await queryEndpoint(`/api/lm/download-progress/${downloadId}`, {}, { noCache: true });
    } catch (e) {
      stillRunning = false;   // 404 → no longer tracked, i.e. over
    }
    if (stillRunning) continue;

    inFlight.delete(downloadId);
    const ok = await libraryHasVersion(info.modelId, info.versionId);
    unnotified.set(downloadId, {
      ok,
      error: ok === false ? '下载已结束，但库中没有该版本' : null,
      fileName: null,
      at: Date.now(),
    });
    console.debug('[LoraBridge] reconciled orphaned download:', downloadId, 'ok=' + ok);
  }

  persistState();
  updateBadge();
}

/** Tri-state: true / false, or null when it genuinely cannot be determined. */
async function libraryHasVersion(modelId, versionId) {
  try {
    const { allVersions, ok } = await queryAllEndpoints({ modelId, noCache: true });
    if (!ok) return null;                       // server unreachable — do not guess
    if (!versionId) return allVersions.length > 0;
    return allVersions.some((v) => v.versionId === versionId);
  } catch (e) {
    return null;
  }
}

/**
 * Start a download and return immediately with its id.
 *
 * Uses the **GET** variant deliberately. Browsers attach an `Origin` header to
 * POSTs but not to GETs, and ComfyUI rejects any loopback request whose Origin
 * differs from the Host (its anti-CSRF guard, server.py). A POST from the
 * extension therefore 403s against a stock ComfyUI unless the user passes
 * --enable-cors-header — which is far too much to ask of anyone installing this
 * extension. GET carries no Origin, so it works unmodified.
 *
 * The trade-off: the GET variant takes no `model_root`, so the destination is
 * LoRA Manager's own decision (`use_default_paths=true`) — the model-type root,
 * plus whatever subfolder its path template specifies. The extension
 * deliberately does not override the host application's own configuration.
 *
 * The request stays open for the whole transfer (the server downloads inside
 * it), so it is intentionally not awaited; `download_id` is generated up front
 * so progress polling can start immediately.
 */
async function handleDownloadModel({ modelId, versionId, modelName }) {
  if (!modelId && !versionId) {
    return { success: false, error: '缺少 modelId / versionId' };
  }

  // Already downloading this exact version? Hand back the running one and let
  // the caller attach to it, rather than starting a second copy.
  //
  // The check reads the PERSISTED in-flight set, not an in-memory one: the
  // worker is routinely terminated mid-download, and an in-memory guard dies
  // with it — so a user retrying an apparently-stalled download would start a
  // second transfer of the same file, which the server then saves under a new
  // name (`…-87a8.safetensors`) instead of overwriting.
  const key = versionKey(modelId, versionId);
  await hydrate();
  const existing = [...inFlight.entries()]
    .find(([, v]) => versionKey(v.modelId, v.versionId) === key);
  if (existing) {
    // Only reuse if it is genuinely still running. A stale entry left behind by
    // a dead worker would otherwise make a fresh request look satisfied.
    let stillRunning = true;
    try {
      await queryEndpoint(`/api/lm/download-progress/${existing[0]}`, {}, { noCache: true });
    } catch (e) {
      stillRunning = false;
    }
    if (stillRunning) {
      return { success: true, downloadId: existing[0], reused: true };
    }
    await reconcileDownloads();   // settle the stale one before starting anew
  }

  let baseUrl;
  try {
    baseUrl = await getBaseUrl();
  } catch (error) {
    return { success: false, error: String((error && error.message) || error) };
  }

  const downloadId = crypto.randomUUID();
  const params = new URLSearchParams({
    download_id: downloadId,
    use_default_paths: 'true',
  });
  if (modelId) params.set('model_id', String(modelId));
  if (versionId) params.set('model_version_id', String(versionId));

  const url = `${baseUrl}/api/lm/download-model-get?${params}`;

  // Drop settled entries so a long session doesn't accumulate them.
  for (const [id, e] of downloads) {
    if (e.result || e.error) downloads.delete(id);
  }

  let markSettled;
  const entry = {
    result: null,
    error: null,
    // Resolves once the outcome is known, so a poller that has lost the
    // server-side progress entry can wait for the authoritative answer.
    settled: new Promise((resolve) => { markSettled = resolve; }),
  };
  downloads.set(downloadId, entry);

  // Record the transfer BEFORE awaiting it. If this worker is terminated while
  // the download is still running — the normal case when the tab is closed —
  // this is the only thing left pointing at it, and reconcileDownloads() will
  // pick it up when a worker next runs.
  await hydrate();
  // The name is only known to the page that started this — carrying it here
  // lets every other tab's bubble show something better than an id.
  inFlight.set(downloadId, {
    modelId: modelId ?? null,
    versionId: versionId ?? null,
    modelName: typeof modelName === 'string' && modelName.trim() ? modelName.trim().slice(0, 120) : null,
    at: Date.now(),
  });
  persistState();

  fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(async (response) => {
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        data = { raw: text };
      }
      if (!response.ok || data?.success === false) {
        entry.error = data?.error || `HTTP ${response.status}`;
      } else {
        entry.result = data;
      }
    })
    .catch((error) => {
      entry.error = String((error && error.message) || error);
    })
    .finally(() => {
      // Reached only if this worker survived the whole transfer. If it did not,
      // reconcileDownloads() re-derives the outcome from the server instead.
      inFlight.delete(downloadId);
      // Record the outcome before resolving, so a page that is about to be
      // closed still has it waiting for whoever looks next.
      unnotified.set(downloadId, {
        ok: !entry.error,
        error: entry.error || null,
        fileName: entry.result?.file_name || null,
        at: Date.now(),
      });
      persistState();
      updateBadge();
      markSettled();
    });

  console.debug('[LoraBridge] download started:', downloadId);
  return { success: true, downloadId };
}

/**
 * Poll one download's progress.
 *
 * The server drops progress entries once a transfer ends, so a 404 means the
 * transfer is over — but "over" is not the same as "succeeded": a download
 * rejected by CivitAI also ends this way. So on 404 we wait briefly for our own
 * request to settle, which carries the real outcome.
 */
async function handleDownloadStatus({ downloadId }) {
  if (!downloadId) return { success: false, error: '缺少 downloadId' };

  const entry = downloads.get(downloadId);
  let progressData = null;
  let stillRunning = true;

  try {
    progressData = await queryEndpoint(
      `/api/lm/download-progress/${downloadId}`,
      {},
      { noCache: true }
    );
  } catch (e) {
    // 404 → no longer tracked server-side, i.e. the transfer is over.
    stillRunning = false;
  }

  // The progress entry is removed just before the response is written, so a
  // request that is still pending here is about to tell us what happened.
  if (!stillRunning && entry && !entry.result && !entry.error) {
    await Promise.race([entry.settled, new Promise((r) => setTimeout(r, 2500))]);
  }

  const finished = !stillRunning || !!(entry && entry.result);
  const failed = !!(progressData && progressData.success === false);

  return {
    success: true,
    downloadId,
    finished: finished || failed || entry?.error != null,
    progress: progressData?.progress ?? (finished ? 100 : 0),
    bytesDownloaded: progressData?.bytes_downloaded ?? null,
    totalBytes: progressData?.total_bytes ?? null,
    bytesPerSecond: progressData?.bytes_per_second ?? null,
    error: entry?.error || progressData?.error || null,
  };
}

/**
 * Cancel an in-flight download. The server keeps partial files.
 */
async function handleCancelDownload({ downloadId }) {
  if (!downloadId) return { success: false, error: '缺少 downloadId' };
  try {
    const result = await queryEndpoint('/api/lm/cancel-download-get', { download_id: downloadId });
    if (result?.success === false) {
      return { success: false, error: result.error || '取消失败' };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: String((error && error.message) || error) };
  }
}

/**
 * Check connectivity.
 */
async function checkConnectivity() {
  try {
    const baseUrl = await getBaseUrl();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${baseUrl}/api/lm/loras/list?page_size=1`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeoutId);
    return { connected: response.ok, serverType: 'comfyui-lora-manager' };
  } catch (error) {
    return { connected: false, serverType: null };
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Resolve a handler promise into a sendResponse call.
 *
 * Without the rejection branch a handler that throws leaves sendResponse
 * uncalled, and the content script silently sees "not found".
 */
function respond(promise, sendResponse) {
  promise.then(sendResponse, (error) => {
    console.error('[LoraBridge] handler failed:', error);
    sendResponse({
      found: false,
      versions: [],
      foundTypes: [],
      error: String((error && error.message) || error),
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_MODEL') {
    respond(handleCheckModel(message.payload), sendResponse);
    return true;
  }

  if (message.type === 'CHECK_MODELS_BATCH') {
    respond(handleCheckModelsBatch(message.payload), sendResponse);
    return true;
  }

  if (message.type === 'CHECK_CONNECTIVITY') {
    respond(checkConnectivity(), sendResponse);
    return true;
  }

  if (message.type === 'GET_LIBRARY_SUMMARY') {
    respond(handleGetLibrarySummary(), sendResponse);
    return true;
  }

  if (message.type === 'DOWNLOAD_MODEL') {
    respond(handleDownloadModel(message.payload), sendResponse);
    return true;
  }

  if (message.type === 'DOWNLOAD_STATUS') {
    respond(handleDownloadStatus(message.payload), sendResponse);
    return true;
  }

  if (message.type === 'CANCEL_DOWNLOAD') {
    respond(handleCancelDownload(message.payload), sendResponse);
    return true;
  }

  if (message.type === 'ACTIVE_DOWNLOADS') {
    // Everything a page needs to show live download state: what is running,
    // how far along, and whether it has stopped making progress.
    respond((async () => {
      await hydrate();
      const downloads = await Promise.all([...inFlight.entries()].map(async ([downloadId, info]) => {
        let progress = null;
        try {
          progress = await queryEndpoint(`/api/lm/download-progress/${downloadId}`, {}, { noCache: true });
        } catch (e) {
          // Progress gone → the transfer is over; reconcile will finish the
          // bookkeeping, and the page should stop showing it as running.
          return null;
        }
        return {
          downloadId,
          modelId: info.modelId,
          versionId: info.versionId,
          modelName: info.modelName || null,
          startedAt: info.at,
          progress: progress?.progress ?? 0,
          bytesDownloaded: progress?.bytes_downloaded ?? null,
          totalBytes: progress?.total_bytes ?? null,
          bytesPerSecond: progress?.bytes_per_second ?? null,
        };
      }));
      return { success: true, downloads: downloads.filter(Boolean) };
    })(), sendResponse);
    return true;
  }

  if (message.type === 'CLAIM_NOTICES') {
    // Reconcile first: this is often the first message to reach the worker
    // since the tab that started the download was closed, so any transfer that
    // outlived it is only discovered right here.
    respond((async () => {
      await reconcileDownloads();
      // Handed to whichever page (or popup) asks first, so exactly one surface
      // reports each outcome.
      const notices = [...unnotified.entries()].map(([downloadId, n]) => ({ downloadId, ...n }));
      unnotified.clear();
      persistState();
      updateBadge();
      return { success: true, notices };
    })(), sendResponse);
    return true;
  }

  if (message.type === 'ACK_DOWNLOAD') {
    // The page that was watching this transfer reported it itself.
    respond((async () => {
      await hydrate();
      if (unnotified.delete(message.payload?.downloadId)) {
        persistState();
        updateBadge();
      }
      return { success: true };
    })(), sendResponse);
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    // Clears cached API results only — deliberately not the download map, so an
    // in-flight transfer keeps its completion/error tracking.
    cache.clear();
    // Re-probe libraries that 404'd, so upgrading LoRA Manager is picked up
    // without restarting the browser.
    unsupportedEndpoints.clear();
    // Responded synchronously, so do NOT return true — that would tell the
    // sender to keep the channel open for a reply that never comes, and the
    // worker being torn down then surfaces as
    // "message channel closed before a response was received".
    sendResponse({ success: true });
    return false;
  }

  return false;
});

/**
 * Query all model endpoints (LoRA + Checkpoint) for a single model.
 *
 * Returns `ok: false` when every endpoint failed — meaning the server is
 * unreachable, which is NOT the same as "this model is not in the library".
 */
async function queryAllEndpoints({ modelId, noCache = false }) {
  // The API only filters by civitai_model_id (there is no version filter), so
  // without a modelId an unfiltered query would return arbitrary library
  // entries and the caller would misread them as "other versions of this model".
  if (!modelId) {
    return { allVersions: [], foundTypes: [], ok: true, needsModelId: true };
  }

  const settled = await Promise.all(
    activeEndpoints().map(async ({ type, endpoint, label }) => {
      try {
        const data = await queryEndpoint(endpoint, {
          civitai_model_id: modelId,
          page_size: PAGE_SIZE,
        }, { noCache });
        return { type, label, items: data?.items || [], ok: true };
      } catch (e) {
        return { type, label, items: [], ok: false };
      }
    })
  );

  const allVersions = [];
  const foundTypes = [];
  let ok = false;

  for (const result of settled) {
    if (result.ok) ok = true;
    if (result.items.length === 0) continue;

    if (!foundTypes.includes(result.type)) foundTypes.push(result.type);
    for (const item of result.items) {
      // LoRA Manager reports the precise sub-type — locon, dora,
      // diffusion_model, vae, upscaler… — which is what the badge shows.
      const subType = String(item.sub_type || '').toLowerCase() || null;
      if (subType && !foundTypes.includes(subType)) foundTypes.push(subType);
      allVersions.push({
        versionId: item.civitai?.id || null,
        modelId: item.civitai?.modelId || modelId || null,
        name: item.model_name || item.file_name,
        fileName: item.file_name,
        // Full local path: only ever sent for the single-model lookup. Batch
        // responses carry file *names* only, so the user's directory layout
        // never lands in the DOM of a public page.
        filePath: item.file_path || '',
        baseModel: item.base_model || '',
        modelType: result.type,
        subType,
        sha256: item.sha256 || '',
      });
    }
  }

  return { allVersions, foundTypes, ok, needsModelId: false };
}

/**
 * Check if a single model is in the library (LoRA + Checkpoint).
 */
async function handleCheckModel({ modelId, versionId, noCache }) {
  if (!modelId && !versionId) {
    return { found: false, versions: [], foundTypes: [] };
  }

  try {
    const { allVersions, foundTypes, ok, needsModelId } = await queryAllEndpoints({ modelId, noCache });

    if (needsModelId) {
      return { found: false, versions: [], foundTypes: [], needsModelId: true };
    }

    if (!ok) {
      return { found: false, versions: [], foundTypes: [], unreachable: true };
    }

    if (versionId) {
      const exactVersion = allVersions.find((v) => v.versionId === versionId);
      return {
        found: exactVersion !== undefined,
        hasAnyVersion: allVersions.length > 0,
        versions: allVersions,
        matchedVersion: exactVersion || null,
        foundTypes,
      };
    }

    return {
      found: allVersions.length > 0,
      hasAnyVersion: allVersions.length > 0,
      versions: allVersions,
      matchedVersion: null,
      foundTypes,
    };
  } catch (error) {
    return { found: false, versions: [], foundTypes: [], error: error.message };
  }
}

/**
 * Batch check model IDs against all endpoints (LoRA + Checkpoint).
 *
 * Strategy: For each modelId, query BOTH endpoints with civitai_model_id filter.
 * Each (endpoint, modelId) pair has a UNIQUE cache key, so scrolling and loading
 * more cards produces fresh API calls rather than hitting a stale "fetch all"
 * cache entry.
 *
 * Returns `ok: false` when no request succeeded, so the caller can retry
 * instead of permanently marking those cards as scanned.
 */
async function handleCheckModelsBatch({ modelIds }) {
  if (!modelIds || !Array.isArray(modelIds) || modelIds.length === 0) {
    return { results: {}, ok: true };
  }

  // Normalize and deduplicate
  const unique = [];
  const seen = new Set();
  for (const id of modelIds) {
    const n = typeof id === 'number' ? id : parseInt(id, 10);
    if (isNaN(n) || seen.has(n)) continue;
    seen.add(n);
    unique.push(n);
  }

  // Initialize results. `unknown` marks a modelId no endpoint managed to
  // answer for — caller must retry those rather than treat them as absent.
  const results = {};
  for (const mid of unique) {
    results[mid] = { found: false, versionCount: 0, foundTypes: [], names: [], unknown: true };
  }

  if (unique.length === 0) return { results, ok: true };

  let anySucceeded = false;

  // One thunk per (modelId, endpoint). Thunks — not started promises — so
  // runWithConcurrency actually controls how many are in flight at once.
  const tasks = [];
  for (const modelId of unique) {
    for (const { type, endpoint } of activeEndpoints()) {
      tasks.push(async () => {
        try {
          const data = await queryEndpoint(endpoint, {
            civitai_model_id: modelId,
            page_size: PAGE_SIZE,
          });
          anySucceeded = true;
          results[modelId].unknown = false;

          const items = data?.items || [];
          if (items.length > 0) {
            results[modelId].found = true;
            results[modelId].versionCount += items.length;

            // Badge tokens: the precise sub-type when the server reports one
            // (locon, dora, diffusion_model, vae, upscaler…), else the library.
            const tokens = [type];
            for (const item of items) {
              const sub = String(item.sub_type || '').toLowerCase();
              if (sub && !tokens.includes(sub)) tokens.push(sub);
            }
            for (const t of tokens) {
              if (results[modelId].foundTypes.length < 3 &&
                  !results[modelId].foundTypes.includes(t)) {
                results[modelId].foundTypes.push(t);
              }
            }

            // A few file names for the hover popover — names only, never paths.
            for (const item of items) {
              if (results[modelId].names.length >= 3) break;
              const name = item.file_name || item.model_name;
              if (name && !results[modelId].names.includes(name)) {
                results[modelId].names.push(name);
              }
            }
          }
        } catch (e) {
          // Endpoint unreachable for this modelId — it stays `unknown`, which
          // tells the caller to retry instead of marking the card as scanned.
        }
      });
    }
  }

  await runWithConcurrency(tasks, MAX_CONCURRENT_REQUESTS);

  const foundCount = unique.filter((mid) => results[mid].found).length;
  if (foundCount > 0) {
    console.debug('[LoraBridge] batch: checked', unique.length, 'modelIds × 2 endpoints,', foundCount, 'found');
  }

  return { results, ok: anySucceeded };
}

/**
 * Run an array of async *thunks* with a concurrency limit.
 *
 * The tasks must be functions; passing already-started promises would let every
 * request fire at once and the limit would only throttle the awaiting.
 */
async function runWithConcurrency(tasks, limit) {
  const queue = tasks.slice();
  const workerCount = Math.min(limit, queue.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        await queue.shift()();
      }
    })
  );
}

/**
 * Get summary of the library with per-type counts.
 */
async function handleGetLibrarySummary() {
  try {
    // Built from the active libraries so adding a model type can't leave the
    // per-type counts silently out of step with `total` again.
    const settled = await Promise.all(
      activeEndpoints().map(async ({ type, endpoint }) => {
        try {
          const data = await queryEndpoint(endpoint, { page_size: 1 });
          return [type, data?.total ?? 0];
        } catch (e) {
          return [type, 0];
        }
      })
    );
    const counts = Object.fromEntries(settled);

    // Whether LoRA Manager has a CivitAI API key. Without one, every download
    // fails with 401 — worth surfacing before the user hits that wall.
    let apiKeySet = null;
    try {
      const settingsData = await queryEndpoint('/api/lm/settings');
      if (settingsData && settingsData.settings) {
        apiKeySet = !!settingsData.settings.civitai_api_key_set;
      }
    } catch (e) { /* older builds may not report it */ }

    const connectivity = await checkConnectivity();
    return {
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      // Convenience keys kept for the popup's fixed fields.
      loraCount: counts.lora ?? 0,
      checkpointCount: counts.checkpoint ?? 0,
      embeddingCount: counts.embedding ?? 0,
      apiKeySet,
      connected: connectivity.connected,
    };
  } catch (error) {
    return { counts: {}, total: 0, connected: false, error: error.message };
  }
}

// ============================================================================
// STARTUP
// ============================================================================

// A worker that was terminated mid-download wakes with empty in-memory maps.
// Restore them, then settle anything that finished while nothing was running —
// otherwise a download started from a tab that has since been closed would
// never be reported.
hydrate().then(reconcileDownloads);

// Recovery also needs the worker to actually wake up. With the tab closed there
// may be nothing left to generate an event, so the badge would only appear once
// the user happened to open a page or the popup. A heartbeat settles transfers
// on its own, so the badge shows up whether or not anyone is interacting.
// (`alarms` carries no user-facing permission warning.)
try {
  chrome.alarms.create('reconcile-downloads', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'reconcile-downloads') reconcileDownloads();
  });
} catch (e) {
  console.debug('[LoraBridge] alarms unavailable:', e.message);
}
