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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Automatic retry for transfers that stop progressing
//
// Two ways a download stops being useful, and the server only recovers from
// one of them:
//
//   - the connection dies mid-transfer → its stall timer notices and resumes
//   - the connection goes quiet in a phase the stall timer does not cover
//     (asking CivitAI for the download URL), or keeps trickling at a few KB/s
//     → nothing on the server ever gives up, and the whole queue waits behind
//     it forever
//
// Measured: one transfer sat at 9% moving ~8 KB/s (a 175 MB file, six hours to
// go) with zero log lines, and another produced nothing at all for minutes.
//
// So the worker gives up on it and asks again. That is cheap because the server
// resumes: `py/services/downloader.py:428-439` keeps the `.part` file and sends
// a Range header for whatever is already in it, so a retry costs a reconnect —
// not the bytes already downloaded.
// ---------------------------------------------------------------------------

// Test seam: the harness overrides these so the retry path runs in seconds
// instead of minutes. Only a script inside the worker's own scope can set it —
// page scripts have no access to it.
const TUNING = {
  stuckWindowMs: 3 * 60 * 1000,   // no real progress for this long → retry
  minProgressBytes: 512 * 1024,   // "real progress" = at least this much (~3 KB/s)
  maxRetries: 3,                  // then give up and let the queue move
  ...(globalThis.__lbTuning || {}),
};

const lastProgress = new Map();  // downloadId → { bytes, at } of the last real advance
const autoRetries = new Map();   // versionKey → attempts made

/**
 * Record a progress reading and say whether this transfer now looks dead.
 *
 * A reading of `null` (no progress record on the server) counts as no progress
 * — it is exactly the wedge this exists to catch — but it must not refresh the
 * timer either, or the check could never fire.
 */
function noteProgress(downloadId, bytes) {
  const prev = lastProgress.get(downloadId);
  const now = Date.now();
  if (prev === undefined) {
    lastProgress.set(downloadId, { bytes: bytes ?? 0, at: now });
    return false;
  }
  // A byte count that went backwards is a restart, not progress, and must also
  // reset the clock rather than count as movement.
  if (bytes != null && (bytes - prev.bytes >= TUNING.minProgressBytes || bytes < prev.bytes)) {
    lastProgress.set(downloadId, { bytes, at: now });
    return false;
  }
  return now - prev.at > TUNING.stuckWindowMs;
}

async function retryStuckDownload(downloadId) {
  const info = inFlight.get(downloadId);
  if (!info) return;
  const key = versionKey(info.modelId, info.versionId);
  const tries = (autoRetries.get(key) || 0) + 1;

  // Cancelling makes the transfer's own request finish in failure, and its
  // outcome handler would then record a ❌ for a download that is about to be
  // retried. Mark it so the log shows the retry, not a failure that never
  // happened.
  const entry = downloads.get(downloadId);
  if (entry) entry.suppressOutcome = true;

  // Stop the server's side of it. The partial file stays on disk, so whichever
  // of these paths we take next picks up where this one left off.
  await handleCancelDownload({ downloadId }).catch(() => {});
  inFlight.delete(downloadId);
  lastProgress.delete(downloadId);

  if (tries > TUNING.maxRetries) {
    // Out of attempts. Say so and let the queue go — one bad file must not hold
    // up everything behind it.
    autoRetries.delete(key);
    recordOutcome(downloadId, {
      ok: false,
      error: '网络太慢或连接反复中断，已自动重试 ' + TUNING.maxRetries + ' 次仍未成功',
      modelId: info.modelId ?? null,
      versionId: info.versionId ?? null,
      at: Date.now(),
    });
    console.debug('[LoraBridge] giving up on stuck download:', downloadId);
    pumpQueue();
    return;
  }

  autoRetries.set(key, tries);
  console.debug('[LoraBridge] auto-retrying stuck download:', downloadId, 'attempt', tries);
  // To the FRONT: it was already waiting its turn in the queue, so retrying it
  // should not put it behind everything clicked since.
  queue.unshift({
    modelId: info.modelId ?? null,
    versionId: info.versionId ?? null,
    modelName: info.modelName || null,
    at: Date.now(),
  });
  persistState();
  pumpQueue();
}

// The server refuses a download whose version it already has. Worded a few
// ways depending on the library, so match loosely.
const ALREADY_IN_LIBRARY = /already exists|already in (the )?\w+ library/i;

// How long a transfer may go without ever reporting progress before a missing
// progress record is taken to mean it is over rather than not yet started.
const STARTUP_GRACE_MS = 90000;

// ---------------------------------------------------------------------------
// Surviving the worker
//
// A download runs on the server, so closing the tab that started it does not
// stop it — but it also leaves nothing generating events, and a Manifest V3
// worker is terminated after ~30s of inactivity. A multi-minute download with
// no page open therefore outlives the worker that started it, taking the
// in-flight request and its `.finally()` with it: no badge, no notice.
//
// So the bookkeeping is mirrored into extension storage, and the outcome is
// re-derived from the server afterwards rather than remembered from a promise
// that no longer exists.
//
// TWO areas, because they have different lifetimes:
//
//   chrome.storage.session  notifications, the result log, unconfirmed results
//   chrome.storage.local    in-flight transfers and the queue
//
// `session` is right for things the user reads once: it dies with the browser,
// so yesterday's ✅ cannot come back on its own. But it does NOT survive
// reloading the extension — and the queue and the in-flight set are *work in
// progress*, which must. Reloading during a batch (which is exactly what
// installing a fix requires) silently dropped every queued download and lost
// track of a transfer that was still running on the server. Work in progress
// goes in `local`, with an age cutoff so nothing from a previous day comes back
// to life. (No extra permission: both areas are part of `storage`.)
// ---------------------------------------------------------------------------

const INFLIGHT_KEY = 'inflightDownloads';   // downloadId → { modelId, versionId, at }
const PENDING_KEY = 'pendingNotices';       // downloadId → { ok, fileName, error, at }
const HISTORY_KEY = 'downloadHistory';      // newest-first list of past outcomes
const UNCONFIRMED_KEY = 'unconfirmedOutcomes';  // downloadId → { modelId, versionId, at }
const QUEUE_KEY = 'downloadQueue';          // ordered list of { modelId, versionId, modelName, at }

// Work in progress older than this is not resumed — a queue or a transfer from
// a previous day is stale, and reviving it would just produce noise (a result
// for a download nobody remembers starting).
const RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// How many transfers may run at once.
//
// One, deliberately. The link these downloads traverse dies for minutes at a
// time, and every transfer in flight when it dies dies with it and then races
// the others to reconnect — measured: seven clicks at once, four outright
// failures, while a single file ran at 4.6 MB/s. Concurrency does not add
// bandwidth here; it only multiplies the casualties. Clicks are not lost —
// they queue.
const QUEUE_MAX_CONCURRENT = 1;

// Outcomes are kept after they have been reported, so the popup can show a log
// that survives being closed and reopened. "Claimed once" is the right rule for
// the badge and the toast, but it made the log vanish the moment it was read.
const HISTORY_MAX = 20;

const inFlight = new Map();
const unnotified = new Map();   // ok: true = succeeded, false = failed, null = unknown
let history = [];               // newest first

// Downloads the user has asked for that have not been put on the wire yet, in
// the order they were clicked. Persisted with everything else, so a worker
// terminated between two transfers still knows what it owes.
let queue = [];
// Set synchronously while a transfer is being started, before it is registered
// in `inFlight` — otherwise a click and the queue pump can both see an idle
// wire in the same tick and start two transfers.
let pumping = false;
const busy = () => pumping || inFlight.size >= QUEUE_MAX_CONCURRENT;

// Outcomes that came back "unknown" and may yet be settled by a later index.
// Kept apart from `unnotified` because claiming clears that map — and an entry
// that has already been shown must still be upgradable, otherwise the log sits
// on "无法确认" forever for a download that plainly worked.
const unconfirmed = new Map();  // downloadId → { modelId, versionId, at }

// Give up on a late index after this long; anything older is not coming.
const UNCONFIRMED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let hydrated = false;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await chrome.storage.session.get(
      [PENDING_KEY, HISTORY_KEY, UNCONFIRMED_KEY]);
    for (const [id, v] of Object.entries(stored[PENDING_KEY] || {})) unnotified.set(id, v);
    for (const [id, v] of Object.entries(stored[UNCONFIRMED_KEY] || {})) unconfirmed.set(id, v);
    if (Array.isArray(stored[HISTORY_KEY])) history = stored[HISTORY_KEY];

    // Work in progress comes from `local`, so it survives reloading the
    // extension. Anything too old to still be real is dropped rather than
    // resumed.
    const durable = await chrome.storage.local.get([INFLIGHT_KEY, QUEUE_KEY]);
    const fresh = (at) => Date.now() - (at || 0) < RESUME_MAX_AGE_MS;
    let droppedInflight = 0, droppedQueued = 0;
    for (const [id, v] of Object.entries(durable[INFLIGHT_KEY] || {})) {
      if (fresh(v.at)) inFlight.set(id, v); else droppedInflight++;
    }
    if (Array.isArray(durable[QUEUE_KEY])) {
      queue = durable[QUEUE_KEY].filter((q) => fresh(q.at));
      droppedQueued = durable[QUEUE_KEY].length - queue.length;
    }
    if (droppedInflight || droppedQueued) {
      console.debug('[LoraBridge] dropped stale work in progress:', droppedInflight, 'transfers,', droppedQueued, 'queued');
      persistState();
    }
  } catch (e) {
    console.debug('[LoraBridge] could not restore download state:', e.message);
  }
  updateBadge();
}

function persistState() {
  try {
    // Read once, gone on reload — appropriate for notices and the result log.
    chrome.storage.session.set({
      [PENDING_KEY]: Object.fromEntries(unnotified),
      [HISTORY_KEY]: history,
      [UNCONFIRMED_KEY]: Object.fromEntries(unconfirmed),
    });
    // Work in progress: must outlive a reload of the extension.
    chrome.storage.local.set({
      [INFLIGHT_KEY]: Object.fromEntries(inFlight),
      [QUEUE_KEY]: queue,
    });
  } catch (e) { /* storage unavailable */ }
}

/**
 * Record an outcome both as "needs reporting" and in the durable log.
 *
 * The popup reads the log; the badge and toast read the pending set. Keeping
 * them separate is what lets a result survive being shown.
 */
function recordOutcome(downloadId, outcome) {
  unnotified.set(downloadId, outcome);

  // Track it for a later upgrade, or drop it once it is no longer unknown.
  if (outcome.ok === null && outcome.modelId) {
    unconfirmed.set(downloadId, {
      modelId: outcome.modelId,
      versionId: outcome.versionId ?? null,
      at: outcome.at || Date.now(),
    });
  } else {
    unconfirmed.delete(downloadId);
  }
  // Sorted by time rather than by insertion: an outcome can be re-recorded when
  // it is upgraded from "unconfirmed" to a success, and that must not jump it to
  // the top of the log.
  history = [{ downloadId, ...outcome }, ...history.filter((h) => h.downloadId !== downloadId)]
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, HISTORY_MAX);
  persistState();
  updateBadge();
}

function updateBadge() {
  const notices = [...unnotified.values()];

  try {
    // A running transfer takes precedence. The in-page bubble only exists on the
    // three CivitAI hosts, so on any other site this badge is the only sign that
    // something is downloading — and it is visible from every tab.
    if (inFlight.size > 0) {
      chrome.action.setBadgeText({ text: '⬇' + (inFlight.size > 1 ? inFlight.size : '') });
      chrome.action.setBadgeBackgroundColor({ color: '#3182ce' });
      return;
    }

    // Red only for a confirmed failure; amber when the outcome could not be
    // established, so a slow index doesn't read as an error.
    const colour = notices.some((n) => n.ok === false) ? '#e74c3c'
      : notices.some((n) => n.ok === null) ? '#e67e22'
      : '#27ae60';
    chrome.action.setBadgeText({ text: notices.length ? String(notices.length) : '' });
    if (notices.length) chrome.action.setBadgeBackgroundColor({ color: colour });
  } catch (e) { /* action API unavailable */ }
}

/**
 * Settle downloads whose worker died mid-transfer.
 *
 * The server keeps the only durable record of a transfer, so the outcome is
 * re-derived from it: progress still listed → still running; gone → the
 * transfer is over, and whether the file landed is answered by the library.
 *
 * A full sweep is not cheap: it queries the progress endpoint once per in-flight
 * transfer, and for a transfer that has ended it waits out up to 4.5 seconds of
 * retries while the library indexes the new file. Every page poll asks for it
 * (CLAIM_NOTICES), on a 2-second beat per open tab — so it ran constantly
 * without being any more prompt. What it actually adds is catching a transfer
 * whose worker died, which does not need sub-second freshness; callers that ask
 * for it repeatedly should use reconcileIfDue() instead.
 */
const RECONCILE_MIN_INTERVAL_MS = 8000;
let lastReconcileAt = 0;

async function reconcileIfDue() {
  if (Date.now() - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return;
  await reconcileDownloads();
}

async function reconcileDownloads() {
  lastReconcileAt = Date.now();
  await hydrate();

  // Outcomes reported as "could not confirm" are not final. The usual reason is
  // that the library had not indexed the file yet, and indexing can take
  // minutes — far longer than it is reasonable to block on. So re-check them on
  // this same heartbeat and upgrade to a definite success when the model turns
  // up. Without this, a download that plainly worked sat on "不确定" for good.
  await upgradeUnconfirmed();

  if (inFlight.size === 0) return;

  for (const [downloadId, info] of [...inFlight]) {
    let stillRunning = true;
    try {
      await queryEndpoint(`/api/lm/download-progress/${downloadId}`, {}, { noCache: true });
    } catch (e) {
      // ONLY a 404 means the server dropped the transfer — that is the signal
      // this whole reconciliation rests on. Any other failure (server briefly
      // unreachable) says nothing about the transfer, so leave it in flight
      // rather than settling it on a guess.
      if (e.message !== 'HTTP 404') continue;

      // A 404 has two meanings and they must not be conflated:
      //   - the record appeared and is now gone  → the transfer really ended
      //   - the record never appeared            → the transfer has not started
      //     yet (the server is validating, fetching metadata, choosing a file)
      // Settling a brand-new transfer on the second reading is how a download
      // that had barely begun got reported as "finished".
      if (!info.sawProgress && Date.now() - (info.at || 0) < STARTUP_GRACE_MS) {
        continue;
      }
      stillRunning = false;
    }
    if (stillRunning) continue;

    inFlight.delete(downloadId);

    // The transfer being over says nothing about whether the file landed:
    // LoRA Manager indexes a new file asynchronously, so a check taken the
    // instant it ends routinely misses it. Give the library a few seconds to
    // catch up before concluding anything.
    let ok = await libraryHasVersion(info.modelId, info.versionId);
    for (let i = 0; ok === false && i < 3; i++) {
      await sleep(1500);
      ok = await libraryHasVersion(info.modelId, info.versionId);
    }

    recordOutcome(downloadId, {
      // This worker never saw the transfer's outcome — it only knows the
      // progress record is gone. Finding the version proves success, but NOT
      // finding it proves nothing (the index lags, or the user deleted it), so
      // the negative is reported as "unknown" rather than as a failure.
      ok: ok === true ? true : null,
      error: null,
      fileName: null,
      modelId: info.modelId ?? null,
      versionId: info.versionId ?? null,
      at: Date.now(),
    });
    console.debug('[LoraBridge] reconciled orphaned download:', downloadId, 'ok=' + ok);
    // A transfer settled here counts as the wire freeing up just as much as one
    // that settled through its own finally — which never ran, this worker being
    // a different one.
    pumpQueue();
  }
}

/**
 * Turn "could not confirm" into a definite answer once the library catches up.
 *
 * Only ever upgrades to success — a negative stays unknown, because "not in the
 * library" is never proof of failure.
 */
async function upgradeUnconfirmed() {
  if (unconfirmed.size === 0) return;

  for (const [downloadId, info] of [...unconfirmed]) {
    if (Date.now() - (info.at || 0) > UNCONFIRMED_MAX_AGE_MS) {
      unconfirmed.delete(downloadId);
      continue;
    }
    const found = await libraryHasVersion(info.modelId, info.versionId);
    if (found !== true) continue;

    console.debug('[LoraBridge] late index confirmed', downloadId);
    // Keep the original timestamp so the log entry does not jump the queue.
    const original = history.find((h) => h.downloadId === downloadId);
    recordOutcome(downloadId, {
      ...(original || {}),
      ok: true,
      error: null,
      at: (original && original.at) || info.at || Date.now(),
    });
  }
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

  // Already waiting in the queue for this same version? Queueing it a second
  // time would download the same file twice once its turn came round.
  const waiting = queue.findIndex((q) => versionKey(q.modelId, q.versionId) === key);
  if (waiting !== -1) {
    return { success: true, queued: true, position: waiting + 1 };
  }

  // Only one transfer at a time (see the note on QUEUE_MAX_CONCURRENT). The
  // click is still honoured — it is recorded and started when the wire is free.
  if (busy()) {
    queue.push({ modelId: modelId ?? null, versionId: versionId ?? null, modelName: modelName || null, at: Date.now() });
    persistState();
    return { success: true, queued: true, position: queue.length };
  }

  return startDownloadNow({ modelId, versionId, modelName });
}

/**
 * Put one download on the wire, right now.
 *
 * Split out from handleDownloadModel so the queue can dispatch through exactly
 * the same path a direct click takes — one place builds the URL, records the
 * transfer and attaches the outcome handler.
 */
async function startDownloadNow({ modelId, versionId, modelName }) {
  // Set synchronously, before the first await: it is what stops the queue pump
  // and a click from both deciding the wire is free in the same tick.
  pumping = true;
  try {
    return await beginDownload({ modelId, versionId, modelName });
  } finally {
    pumping = false;
  }
}

/**
 * Start the next queued download, if the wire is free.
 *
 * Called from every point where a transfer ends (its own finally, reconciliation
 * settling an orphan, the heartbeat, and each page poll) so the queue keeps
 * moving whether or not the tab that created it is still open.
 */
async function pumpQueue() {
  try {
    await hydrate();
    // No await between this check and startDownloadNow taking the flag: two
    // pumps racing here would both see an idle wire and start two transfers,
    // which is the whole thing the queue exists to prevent.
    if (busy() || queue.length === 0) return;
    const next = queue.shift();
    persistState();
    console.debug('[LoraBridge] queue: starting', queue.length, 'still waiting');
    await startDownloadNow(next);
  } catch (e) {
    console.debug('[LoraBridge] queue pump failed:', e.message);
  }
}

async function beginDownload({ modelId, versionId, modelName }) {
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
  // Signal the transfer on the toolbar icon: the in-page bubble only exists on
  // the three CivitAI hosts, so on any other site this is the only indication —
  // and it is visible from every tab.
  updateBadge();

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
        const reason = data?.error || `HTTP ${response.status}`;
        // "Already exists" is a refusal, not a failure: it means the model IS
        // in the library — the very thing the button was asking for. Reporting
        // it as an error contradicts the badge on the same page and reads as a
        // bug. Record it as the success it is, and say what happened.
        if (ALREADY_IN_LIBRARY.test(reason)) {
          entry.result = { success: true, already_present: true };
          entry.note = '该模型已在库中';
        } else {
          entry.error = reason;
        }
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
      const info = inFlight.get(downloadId) || {};
      inFlight.delete(downloadId);
      // Cancelled by the stuck-download watchdog: it is being retried, and the
      // failure this request just produced is an artefact of that, not a result.
      if (entry.suppressOutcome) {
        lastProgress.delete(downloadId);
        markSettled();
        pumpQueue();
        return;
      }
      // Record the outcome before resolving, so a page that is about to be
      // closed still has it waiting for whoever looks next.
      recordOutcome(downloadId, {
        ok: !entry.error,
        error: entry.error || null,
        // Set when the transfer was refused for a reason that is not a failure.
        note: entry.note || null,
        fileName: entry.result?.file_name || null,
        // So the page that reports this can also refresh whatever it was
        // showing for that model.
        modelId: info.modelId ?? null,
        versionId: info.versionId ?? null,
        at: Date.now(),
      });
      markSettled();
      // The wire is free — hand it to whoever is next in line.
      pumpQueue();
    });

  console.debug('[LoraBridge] download started:', downloadId);
  return { success: true, downloadId };
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

  if (message.type === 'CANCEL_DOWNLOAD') {
    respond(handleCancelDownload(message.payload), sendResponse);
    return true;
  }

  if (message.type === 'CANCEL_QUEUED') {
    // Dropping a download that has not started yet. Separate from
    // CANCEL_DOWNLOAD because a queued item has no server-side download id —
    // nothing has been sent, which is the whole point of the queue.
    respond((async () => {
      await hydrate();
      const { modelId, versionId } = message.payload || {};
      const key = versionKey(modelId, versionId);
      const before = queue.length;
      queue = queue.filter((q) => versionKey(q.modelId, q.versionId) !== key);
      if (queue.length !== before) persistState();
      return { success: queue.length !== before };
    })(), sendResponse);
    return true;
  }

  if (message.type === 'ACTIVE_DOWNLOADS') {
    // Everything a page needs to show live download state: what is running,
    // how far along, and whether it has stopped making progress.
    respond((async () => {
      await hydrate();

      // The poll is the most reliable driver the queue has: it runs every
      // couple of seconds in every open tab, and it is the one thing still
      // going after a worker has been terminated and restarted mid-transfer.
      // Fire-and-forget so it never delays the response.
      pumpQueue();

      // Fetched concurrently. In sequence, N transfers cost N round trips
      // end-to-end inside one 2-second poll — the last one's progress was
      // always that much staler than the first's, and with the server busy the
      // whole poll could overrun its own interval.
      const stuck = [];
      const out = (await Promise.all([...inFlight].map(async ([downloadId, info]) => {
        // A settled request is not running any more; its outcome is recorded by
        // the download's own .finally().
        const entry = downloads.get(downloadId);
        if (entry && (entry.result || entry.error)) return null;

        let progress = null;
        try {
          progress = await queryEndpoint(`/api/lm/download-progress/${downloadId}`, {}, { noCache: true });
        } catch (e) {
          // No progress record *yet* is the normal state: the server validates
          // the request, fetches metadata and picks a file before any bytes
          // move. A request it refused never produces one at all. Neither is
          // evidence the download is over — so keep showing it rather than
          // dropping it. Dropping was why the bubble stayed empty for the whole
          // transfer: the one thing that shows progress is a signal that only
          // exists once progress exists.
          progress = null;
        }

        // Remember that this transfer has been seen making progress. A later
        // 404 then unambiguously means "over" rather than "not started yet".
        if (progress && info.sawProgress !== true) {
          info.sawProgress = true;
          persistState();
        }

        // This is also the only place with fresh byte counts, so it is where a
        // transfer that has stopped moving gets noticed.
        if (noteProgress(downloadId, progress?.bytes_downloaded ?? null)) {
          stuck.push(downloadId);
        }

        return {
          downloadId,
          modelId: info.modelId,
          versionId: info.versionId,
          modelName: info.modelName || null,
          startedAt: info.at,
          // null = running, but no numbers yet.
          progress: progress?.progress ?? null,
          bytesDownloaded: progress?.bytes_downloaded ?? null,
          totalBytes: progress?.total_bytes ?? null,
          bytesPerSecond: progress?.bytes_per_second ?? null,
        };
      }))).filter(Boolean);

      // After the response, so the page is not kept waiting on a cancel round
      // trip. Each one cancels and re-queues, which the pump then restarts.
      if (stuck.length) setTimeout(() => stuck.forEach(retryStuckDownload), 0);

      return {
        success: true,
        downloads: out,
        // Waiting downloads, so a page can say "排队中 · 第 2 位" instead of
        // leaving the click looking like it did nothing.
        queue: queue.map((q, i) => ({
          position: i + 1,
          modelId: q.modelId ?? null,
          versionId: q.versionId ?? null,
          modelName: q.modelName || null,
          at: q.at || null,
        })),
      };
    })(), sendResponse);
    return true;
  }

  if (message.type === 'DOWNLOAD_HISTORY') {
    // The durable log. Unlike CLAIM_NOTICES this does not consume anything, so
    // the popup can be reopened and still show what happened.
    respond((async () => {
      await hydrate();
      return { success: true, history: history.slice(0, HISTORY_MAX) };
    })(), sendResponse);
    return true;
  }

  if (message.type === 'CLEAR_HISTORY') {
    history = [];
    persistState();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'CLAIM_NOTICES') {
    // Reconcile first (rate-limited — see reconcileIfDue): this is often the
    // first message to reach the worker since the tab that started the download
    // was closed, so any transfer that outlived it is only discovered here.
    respond((async () => {
      await reconcileIfDue();
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

  if (message.type === 'INVALIDATE_MODEL') {
    // A download just changed what the library holds for this model, so any
    // cached answer about it is now wrong — including the "not found" cached
    // moments before the download started, which would otherwise pin the page
    // to the pre-download state for the rest of the cache TTL.
    const modelId = String(message.payload?.modelId ?? '');
    let dropped = 0;
    for (const key of [...cache.keys()]) {
      if (modelId && key.includes(`civitai_model_id=${modelId}`)) {
        cache.delete(key);
        dropped++;
      }
    }
    console.debug('[LoraBridge] invalidated', dropped, 'cached queries for model', modelId);
    sendResponse({ success: true, dropped });
    return false;
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
hydrate().then(reconcileDownloads).then(pumpQueue).catch(() => {});

// Recovery also needs the worker to actually wake up. With the tab closed there
// may be nothing left to generate an event, so the badge would only appear once
// the user happened to open a page or the popup. A heartbeat settles transfers
// on its own, so the badge shows up whether or not anyone is interacting.
// (`alarms` carries no user-facing permission warning.)
try {
  chrome.alarms.create('reconcile-downloads', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'reconcile-downloads') return;
    // Also the queue's backstop: with every tab closed nothing polls, and a
    // queue with nobody to advance it would sit there indefinitely.
    reconcileDownloads().then(pumpQueue).catch(() => {});
  });
} catch (e) {
  console.debug('[LoraBridge] alarms unavailable:', e.message);
}
