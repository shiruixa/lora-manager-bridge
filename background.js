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

// In-memory LRU cache: key → { data, timestamp }
const cache = new Map();
const MAX_CACHE_SIZE = 300;

// Model types to check for the "in library" status
const MODEL_ENDPOINTS = [
  { type: 'lora',       endpoint: '/api/lm/loras/list',       label: 'LoRA' },
  { type: 'checkpoint', endpoint: '/api/lm/checkpoints/list', label: 'Checkpoint' },
];

/**
 * Load configuration from storage or return defaults.
 */
async function getConfig() {
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
 * Get the base URL from config.
 */
async function getBaseUrl() {
  const config = await getConfig();
  return config.comfyUIHost.replace(/\/+$/, '');
}

/**
 * Evict expired and excess cache entries.
 */
function evictCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > 120000) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

/**
 * Query the LoRA Manager API and return results.
 */
async function queryEndpoint(endpoint, params = {}) {
  const baseUrl = await getBaseUrl();
  const url = new URL(`${baseUrl}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const cacheKey = url.toString();
  evictCache();

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < (await getConfig()).cacheTTLMs) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.debug('[LoraBridge] API request failed:', endpoint, error.message);
    throw error;
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_MODEL') {
    handleCheckModel(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'CHECK_MODELS_BATCH') {
    handleCheckModelsBatch(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'CHECK_CONNECTIVITY') {
    checkConnectivity().then(sendResponse);
    return true;
  }

  if (message.type === 'GET_LIBRARY_SUMMARY') {
    handleGetLibrarySummary().then(sendResponse);
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    cache.clear();
    sendResponse({ success: true });
    return true;
  }

  return false;
});

/**
 * Query all model endpoints (LoRA + Checkpoint) for a single model.
 */
async function queryAllEndpoints({ modelId, versionId }) {
  const allVersions = [];
  const foundTypes = [];

  for (const { type, endpoint, label } of MODEL_ENDPOINTS) {
    try {
      const params = {};
      if (modelId) {
        params.civitai_model_id = modelId;
      }

      const data = await queryEndpoint(endpoint, {
        ...params,
        page_size: 50,
      });

      const items = data?.items || [];
      if (items.length > 0) {
        foundTypes.push(label);
        for (const item of items) {
          allVersions.push({
            versionId: item.civitai?.id || null,
            modelId: item.civitai?.modelId || modelId || null,
            name: item.model_name || item.file_name,
            fileName: item.file_name,
            baseModel: item.base_model || '',
            modelType: type,
            sha256: item.sha256 || '',
          });
        }
      }
    } catch (e) {
      // Silently skip failed endpoints
    }
  }

  return { allVersions, foundTypes };
}

/**
 * Check if a single model is in the library (LoRA + Checkpoint).
 */
async function handleCheckModel({ modelId, versionId }) {
  if (!modelId && !versionId) {
    return { found: false, versions: [], foundTypes: [] };
  }

  try {
    const { allVersions, foundTypes } = await queryAllEndpoints({ modelId, versionId });

    // Debug: log version IDs for matching
    if (allVersions.length > 0) {
      console.debug('[LoraBridge] CHECK_MODEL: modelId=' + modelId + ' lookingForVersion=' + versionId +
        ' found=' + allVersions.length + ' versions, localIds=' +
        JSON.stringify(allVersions.map((v) => v.versionId)));
    }

    if (versionId && allVersions.length > 0) {
      const exactVersion = allVersions.find((v) => v.versionId === versionId);
      console.debug('[LoraBridge] CHECK_MODEL: versionMatch result=' + (!!exactVersion));
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
 * Strategy: For each modelId, query BOTH endpoints with civitai_model_id filter
 * in parallel. Each (endpoint, modelId) pair has a UNIQUE cache key, so scrolling
 * and loading more cards produces fresh API calls rather than hitting a stale
 * "fetch all" cache entry.
 *
 * Concurrency is capped at 6 parallel requests to avoid overwhelming the
 * local server (modelIds × 2 endpoints = 12 concurrent max).
 */
async function handleCheckModelsBatch({ modelIds }) {
  if (!modelIds || !Array.isArray(modelIds) || modelIds.length === 0) {
    return { results: {} };
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

  // Initialize results
  const results = {};
  for (const mid of unique) {
    results[mid] = { found: false, versionCount: 0, foundTypes: [] };
  }

  if (unique.length === 0) return { results };

  // For each modelId, query BOTH endpoints → one promise per (modelId, endpoint)
  const tasks = [];
  for (const modelId of unique) {
    for (const { type, endpoint, label } of MODEL_ENDPOINTS) {
      tasks.push((async () => {
        try {
          const data = await queryEndpoint(endpoint, {
            civitai_model_id: modelId,
            page_size: 50,
          });
          const items = data?.items || [];
          if (items.length > 0) {
            results[modelId].found = true;
            results[modelId].versionCount += items.length;
            if (!results[modelId].foundTypes.includes(label)) {
              results[modelId].foundTypes.push(label);
            }
          }
        } catch (e) {
          // Silently skip failed endpoints
        }
      })());
    }
  }

  // Run with concurrency limit
  await runWithConcurrency(tasks, 6);

  const foundCount = unique.filter((mid) => results[mid].found).length;
  if (foundCount > 0) {
    console.debug('[LoraBridge] batch: checked', unique.length, 'modelIds × 2 endpoints,', foundCount, 'found');
  }

  return { results };
}

/**
 * Run an array of async tasks with a concurrency limit.
 */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = task.then((r) => {
      executing.splice(executing.indexOf(p), 1);
      return r;
    });
    executing.push(p);
    results.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(results);
}

/**
 * Get summary of the library with per-type counts.
 */
async function handleGetLibrarySummary() {
  try {
    let total = 0;
    let loraCount = 0;
    let checkpointCount = 0;
    for (const { type, endpoint } of MODEL_ENDPOINTS) {
      try {
        const data = await queryEndpoint(endpoint, { page_size: 1 });
        const n = data?.total ?? 0;
        total += n;
        if (type === 'lora') loraCount = n;
        if (type === 'checkpoint') checkpointCount = n;
      } catch (e) {}
    }
    const connectivity = await checkConnectivity();
    return {
      total,
      loraCount,
      checkpointCount,
      connected: connectivity.connected,
    };
  } catch (error) {
    return { total: 0, loraCount: 0, checkpointCount: 0, connected: false, error: error.message };
  }
}
