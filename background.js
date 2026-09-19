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

// Model types to check for the "in library" status
const MODEL_ENDPOINTS = [
  { type: 'lora',       endpoint: '/api/lm/loras/list',       label: 'LoRA' },
  { type: 'checkpoint', endpoint: '/api/lm/checkpoints/list', label: 'Checkpoint' },
  { type: 'embedding',  endpoint: '/api/lm/embeddings/list',  label: 'Embedding' },
];

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

  // Polled endpoints (download progress) must never be served from cache.
  if (options.noCache) {
    return fetchJson(cacheKey, REQUEST_TIMEOUT_MS);
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
      console.debug('[LoraBridge] API request failed:', endpoint, error.message);
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
async function handleDownloadModel({ modelId, versionId }) {
  if (!modelId && !versionId) {
    return { success: false, error: '缺少 modelId / versionId' };
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
    .finally(markSettled);

  console.debug('[LoraBridge] download started:', downloadId);
  return { success: true, downloadId };
}

/**
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

  if (message.type === 'CLEAR_CACHE') {
    // Clears cached API results only — deliberately not the download map, so an
    // in-flight transfer keeps its completion/error tracking.
    cache.clear();
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
async function queryAllEndpoints({ modelId }) {
  // The API only filters by civitai_model_id (there is no version filter), so
  // without a modelId an unfiltered query would return arbitrary library
  // entries and the caller would misread them as "other versions of this model".
  if (!modelId) {
    return { allVersions: [], foundTypes: [], ok: true, needsModelId: true };
  }

  const settled = await Promise.all(
    MODEL_ENDPOINTS.map(async ({ type, endpoint, label }) => {
      try {
        const data = await queryEndpoint(endpoint, {
          civitai_model_id: modelId,
          page_size: PAGE_SIZE,
        });
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

    foundTypes.push(result.label);
    for (const item of result.items) {
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
        sha256: item.sha256 || '',
      });
    }
  }

  return { allVersions, foundTypes, ok, needsModelId: false };
}

/**
 * Check if a single model is in the library (LoRA + Checkpoint).
 */
async function handleCheckModel({ modelId, versionId }) {
  if (!modelId && !versionId) {
    return { found: false, versions: [], foundTypes: [] };
  }

  try {
    const { allVersions, foundTypes, ok, needsModelId } = await queryAllEndpoints({ modelId });

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
    for (const { endpoint, label } of MODEL_ENDPOINTS) {
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
            if (!results[modelId].foundTypes.includes(label)) {
              results[modelId].foundTypes.push(label);
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
    // Built from MODEL_ENDPOINTS so adding a model type can't leave the
    // per-type counts silently out of step with `total` again.
    const settled = await Promise.all(
      MODEL_ENDPOINTS.map(async ({ type, endpoint }) => {
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
