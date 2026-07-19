// ==UserScript==
// @name         Korone Discovery+
// @namespace    https://www.pekora.zip/
// @version      3.6.2
// @description  Optimized progressive discovery for every indexed game, with an active-player-only Game of the Day, live player counts, resumable scanning, and new-ID alerts.
// @match        https://pekora.zip/games*
// @match        https://www.pekora.zip/games*
// @match        https://www.pekora.zip/home*
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const CONFIG = Object.freeze({
        targetHeading: "Classics",
        replacementHeading: "Discover Games",
        newBadgeText: "NEW",
        minVisits: 1_000,
        maxVisits: 5_000,
        maxRows: 500,
        cacheTtlMs: 6 * 60 * 60 * 1000,
        preserveCatalogMs: 45 * 24 * 60 * 60 * 1000,
        recentUpdateWindowMs: 30 * 24 * 60 * 60 * 1000,
        cacheKey: "pekora-discovery-catalog-v3",
        trackerKey: "pekora-game-update-tracker-v3",
        fullScanProgressKey: "pekora-full-id-scan-progress-v1",
        fullScanDbName: "pekora-full-game-index-v1",
        fullScanStoreName: "games",
        fullScanBatchSize: 100,
        fullScanDelayMs: 950,
        fullScanHiddenDelayMs: 1_600,
        fullScanHeadroomIds: 75_000,
        fullScanRescanHeadroomIds: 5_000,
        fullScanExtendThresholdIds: 10_000,
        fullScanMaxRetries: 5,
        scanAlertsEnabledKey: "pekora-scan-alerts-enabled-v1",
        scanAlertStateKey: "pekora-scan-alert-state-v1",
        scanAlertCooldownMs: 12 * 60 * 60 * 1000,
        gameOfDayKey: "pekora-game-of-the-day-v1",
        gameOfDayCandidateLimit: 24,
        gameOfDayMinimumPlayers: 1,
        visiblePlayerRefreshMs: 10 * 60 * 1000,
        visiblePlayerRefreshDelayMs: 1_200,
        indexedInitialLoadLimit: 2_500,
        indexedPageLoadLimit: 2_500,
        mountWatchdogMs: 3_000,
        searchDebounceMs: 250,
        fullScanUiUpdateEveryBatches: 8,
        fullScanProgressSaveEveryBatches: 4,
        maxConcurrentRequests: 2,
        refreshConcurrentRequests: 1,
        requestTimeoutMs: 18_000,
        startupRefreshDelayMs: 12_000,
        observerDebounceMs: 350,
        mountRetryIntervalMs: 500,
        mountRetryMaxMs: 60_000,
        expandedInitialLimit: 100,
        expandedBatchSize: 100,
        defaultMode: "all",
        keywordScanTerms: "abcdefghijklmnopqrstuvwxyz0123456789".split(""),
    });

    const state = {
        catalog: [],
        catalogById: new Map(),
        visibleGames: [],
        mode: CONFIG.defaultMode,
        search: "",
        currentPage: 0,
        expanded: false,
        expandedLimit: CONFIG.expandedInitialLimit,
        loading: false,
        loaded: false,
        started: false,
        deepScanning: false,
        fullScanning: false,
        fullScanStopRequested: false,
        fullScanProgress: null,
        databasePromise: null,
        error: null,
        scanMessage: "",
        patchQueued: false,
        patching: false,
        resizeTimer: null,
        observerTimer: null,
        mountRetryTimer: null,
        startupRefreshTimer: null,
        forcePatch: false,
        tracker: null,
        cardTemplate: null,
        thumbnailPending: new Set(),
        searchTextCache: new WeakMap(),
        viewCache: new Map(),
        catalogRevision: 0,
        newScanAvailable: false,
        newScanHighestPlaceId: 0,
        indexedCatalogLoaded: false,
        gameOfDay: null,
        gameOfDayDate: "",
        playerCountPending: new Set(),
        playerRefreshTimer: null,
        playerRefreshQueue: new Map(),
        indexedTotalCount: 0,
        indexedLoadedCount: 0,
        indexedLastKey: null,
        indexedLoadComplete: false,
        indexedLoading: false,
        mountWatchdogTimer: null,
    };

    function apiUrl(path, params) {
        const url = new URL(path, location.origin);

        for (const [key, value] of Object.entries(params || {})) {
            url.searchParams.set(key, String(value));
        }

        return url.href;
    }

    function sleep(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    async function fetchJson(url, options = {}) {
        const retries = Math.max(0, Number(options.retries ?? 2));
        const timeoutMs = Math.max(
            3_000,
            Number(options.timeoutMs ?? CONFIG.requestTimeoutMs)
        );
        let lastError = null;

        for (let attempt = 0; attempt <= retries; attempt += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(url, {
                    method: "GET",
                    credentials: "include",
                    headers: { Accept: "application/json" },
                    signal: controller.signal,
                });

                if (response.status === 429) {
                    const retryAfter = Number(response.headers.get("retry-after"));
                    const delay = Number.isFinite(retryAfter)
                        ? Math.max(1, retryAfter) * 1000
                        : Math.min(20_000, 2_500 * 2 ** attempt);

                    if (attempt < retries) {
                        await sleep(delay);
                        continue;
                    }
                }

                if (
                    [500, 502, 503, 504].includes(response.status) &&
                    attempt < retries
                ) {
                    await sleep(Math.min(20_000, 1_500 * 2 ** attempt));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} for ${url}`);
                }

                const contentType = response.headers.get("content-type") || "";

                if (!contentType.includes("application/json")) {
                    throw new Error(
                        `Expected JSON but received ${contentType || "unknown content"}`
                    );
                }

                return await response.json();
            } catch (error) {
                lastError = error;

                if (attempt >= retries) {
                    break;
                }

                await sleep(Math.min(15_000, 1_000 * 2 ** attempt));
            } finally {
                clearTimeout(timeout);
            }
        }

        throw lastError || new Error(`Request failed for ${url}`);
    }

    function waitForIdle(timeout = 1_500) {
        return new Promise((resolve) => {
            if (typeof window.requestIdleCallback === "function") {
                window.requestIdleCallback(() => resolve(), { timeout });
                return;
            }

            setTimeout(resolve, Math.min(timeout, 250));
        });
    }

    function readJsonStorage(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            console.warn(`[Pekora Discovery] Invalid storage entry ${key}:`, error);
            return fallback;
        }
    }

    function writeJsonStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`[Pekora Discovery] Could not save ${key}:`, error);
        }
    }

    function scanAlertsEnabled() {
        return readJsonStorage(CONFIG.scanAlertsEnabledKey, true) !== false;
    }

    function setScanAlertsEnabled(enabled) {
        writeJsonStorage(CONFIG.scanAlertsEnabledKey, Boolean(enabled));
        return Boolean(enabled);
    }

    function sendNewScanNotification(highestPlaceId) {
        const title = "Korone Discovery+";
        const message =
            `New game IDs were detected after Place ID ` +
            `${Number(highestPlaceId).toLocaleString()}. Open the Games page and click Scan New Games.`;

        try {
            if (typeof GM_notification === "function") {
                GM_notification({
                    title,
                    text: message,
                    timeout: 12_000,
                    onclick: () => {
                        window.focus();
                        if (!location.pathname.startsWith("/games")) {
                            location.href = "/games";
                        }
                    },
                });
                return;
            }

            if (
                typeof Notification === "function" &&
                Notification.permission === "granted"
            ) {
                const notification = new Notification(title, {
                    body: message,
                    tag: "korone-discovery-new-scan",
                });

                notification.onclick = () => {
                    window.focus();
                    if (!location.pathname.startsWith("/games")) {
                        location.href = "/games";
                    }
                    notification.close();
                };
            }
        } catch (error) {
            console.warn("[Pekora Discovery] Could not show scan notification:", error);
        }
    }

    function detectNewScanRange(games = state.catalog, notify = true) {
        const progress = readFullScanProgress();
        const highestPlaceId = highestKnownPlaceId(games);
        const lastValidPlaceId = Number(progress?.lastValidPlaceId) || 0;
        const available = Boolean(
            progress?.complete &&
            highestPlaceId > lastValidPlaceId
        );

        state.newScanAvailable = available;
        state.newScanHighestPlaceId = highestPlaceId;

        if (!available || !notify || !scanAlertsEnabled()) {
            return available;
        }

        const alertState = readJsonStorage(CONFIG.scanAlertStateKey, {
            highestNotifiedPlaceId: 0,
            notifiedAt: 0,
        });
        const highestNotifiedPlaceId =
            Number(alertState?.highestNotifiedPlaceId) || 0;
        const notifiedAt = Number(alertState?.notifiedAt) || 0;
        const shouldNotify =
            highestPlaceId > highestNotifiedPlaceId ||
            Date.now() - notifiedAt >= CONFIG.scanAlertCooldownMs;

        if (shouldNotify) {
            sendNewScanNotification(highestPlaceId);
            writeJsonStorage(CONFIG.scanAlertStateKey, {
                highestNotifiedPlaceId: highestPlaceId,
                notifiedAt: Date.now(),
            });
        }

        return available;
    }

    function readFullScanProgress() {
        const stored = readJsonStorage(CONFIG.fullScanProgressKey, null);

        if (!stored || stored.version !== 1) {
            return null;
        }

        return {
            version: 1,
            nextPlaceId: Math.max(1, Number(stored.nextPlaceId) || 1),
            targetPlaceId: Math.max(1, Number(stored.targetPlaceId) || 1),
            scannedIds: Math.max(0, Number(stored.scannedIds) || 0),
            foundGames: Math.max(0, Number(stored.foundGames) || 0),
            lastValidPlaceId: Math.max(0, Number(stored.lastValidPlaceId) || 0),
            startedAt: Math.max(0, Number(stored.startedAt) || 0),
            lastRunAt: Math.max(0, Number(stored.lastRunAt) || 0),
            paused: Boolean(stored.paused),
            complete: Boolean(stored.complete),
        };
    }

    function writeFullScanProgress(progress) {
        const normalized = {
            ...progress,
            version: 1,
            lastRunAt: Date.now(),
        };

        writeJsonStorage(CONFIG.fullScanProgressKey, normalized);
        state.fullScanProgress = normalized;
        return normalized;
    }

    function openFullScanDatabase() {
        if (state.databasePromise) {
            return state.databasePromise;
        }

        state.databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.fullScanDbName, 1);

            request.addEventListener("upgradeneeded", () => {
                const database = request.result;

                if (!database.objectStoreNames.contains(CONFIG.fullScanStoreName)) {
                    database.createObjectStore(CONFIG.fullScanStoreName, {
                        keyPath: "universeId",
                    });
                }
            });

            request.addEventListener("success", () => resolve(request.result));
            request.addEventListener("error", () => reject(request.error));
            request.addEventListener("blocked", () =>
                reject(new Error("The Pekora game index database is blocked by another tab."))
            );
        });

        return state.databasePromise;
    }

    async function databaseGetAllGames() {
        const database = await openFullScanDatabase();

        return new Promise((resolve, reject) => {
            const transaction = database.transaction(
                CONFIG.fullScanStoreName,
                "readonly"
            );
            const request = transaction
                .objectStore(CONFIG.fullScanStoreName)
                .getAll();

            request.addEventListener("success", () =>
                resolve(Array.isArray(request.result) ? request.result : [])
            );
            request.addEventListener("error", () => reject(request.error));
        });
    }

    async function databaseCountGames() {
        const database = await openFullScanDatabase();

        return new Promise((resolve, reject) => {
            const transaction = database.transaction(
                CONFIG.fullScanStoreName,
                "readonly"
            );
            const request = transaction
                .objectStore(CONFIG.fullScanStoreName)
                .count();

            request.addEventListener("success", () =>
                resolve(Math.max(0, Number(request.result) || 0))
            );
            request.addEventListener("error", () => reject(request.error));
        });
    }

    async function databaseGetGame(universeId) {
        const key = Number(universeId);

        if (!Number.isInteger(key)) {
            return null;
        }

        const database = await openFullScanDatabase();

        return new Promise((resolve, reject) => {
            const transaction = database.transaction(
                CONFIG.fullScanStoreName,
                "readonly"
            );
            const request = transaction
                .objectStore(CONFIG.fullScanStoreName)
                .get(key);

            request.addEventListener("success", () =>
                resolve(request.result || null)
            );
            request.addEventListener("error", () => reject(request.error));
        });
    }

    async function databaseGetGameAtOffset(offset) {
        const database = await openFullScanDatabase();
        const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));

        return new Promise((resolve, reject) => {
            const transaction = database.transaction(
                CONFIG.fullScanStoreName,
                "readonly"
            );
            const request = transaction
                .objectStore(CONFIG.fullScanStoreName)
                .openCursor();
            let advanced = false;

            request.addEventListener("success", () => {
                const cursor = request.result;

                if (!cursor) {
                    resolve(null);
                    return;
                }

                if (!advanced && safeOffset > 0) {
                    advanced = true;
                    cursor.advance(safeOffset);
                    return;
                }

                resolve(cursor.value || null);
            });
            request.addEventListener("error", () => reject(request.error));
        });
    }

    async function databaseGetGamesPage(afterKey, limit) {
        const database = await openFullScanDatabase();
        const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
        const startKey = Number(afterKey);

        return new Promise((resolve, reject) => {
            const transaction = database.transaction(
                CONFIG.fullScanStoreName,
                "readonly"
            );
            const store = transaction.objectStore(CONFIG.fullScanStoreName);
            const range = Number.isFinite(startKey)
                ? IDBKeyRange.lowerBound(startKey, true)
                : null;
            const request = store.openCursor(range);
            const games = [];
            let lastKey = Number.isFinite(startKey) ? startKey : null;
            let settled = false;

            const finish = (complete) => {
                if (settled) {
                    return;
                }

                settled = true;
                resolve({
                    games,
                    lastKey,
                    complete: Boolean(complete),
                });
            };

            request.addEventListener("success", () => {
                const cursor = request.result;

                if (!cursor) {
                    finish(true);
                    return;
                }

                games.push(cursor.value);
                lastKey = Number(cursor.key);

                if (games.length >= safeLimit) {
                    finish(false);
                    return;
                }

                cursor.continue();
            });
            request.addEventListener("error", () => reject(request.error));
        });
    }

    function resetIndexedLoader() {
        state.indexedLoadedCount = 0;
        state.indexedLastKey = null;
        state.indexedLoadComplete = false;
    }

    async function loadMoreIndexedGames(
        limit = CONFIG.indexedPageLoadLimit,
        { render = true } = {}
    ) {
        if (state.indexedLoading || state.indexedLoadComplete) {
            return 0;
        }

        state.indexedLoading = true;

        try {
            if (state.indexedTotalCount <= 0) {
                state.indexedTotalCount = await databaseCountGames();
            }

            const page = await databaseGetGamesPage(
                state.indexedLastKey,
                limit
            );
            let added = 0;
            let changed = false;

            for (const indexedGame of page.games) {
                const key = Number(indexedGame?.universeId);

                if (!Number.isInteger(key)) {
                    continue;
                }

                const existing = state.catalogById.get(key);

                if (existing) {
                    const merged = mergeGameRecords(existing, indexedGame);
                    Object.assign(existing, merged);
                    changed = true;
                    continue;
                }

                const annotated = annotateTracking(
                    [indexedGame],
                    state.tracker
                )[0];
                state.catalog.push(annotated);
                state.catalogById.set(key, annotated);
                added += 1;
                changed = true;
            }

            state.indexedLoadedCount += page.games.length;
            state.indexedLastKey = page.lastKey;
            state.indexedLoadComplete = Boolean(
                page.complete ||
                page.games.length === 0 ||
                state.indexedLoadedCount >= state.indexedTotalCount
            );
            state.indexedCatalogLoaded = true;

            if (changed) {
                state.catalogRevision += 1;
                state.viewCache.clear();
                state.searchTextCache = new WeakMap();
            }

            if (render) {
                queuePatch(true);
            }

            return added;
        } catch (error) {
            console.warn("[Pekora Discovery] Could not load the next indexed-game page:", error);
            return 0;
        } finally {
            state.indexedLoading = false;
        }
    }

    async function databasePutGames(games) {
        if (!Array.isArray(games) || games.length === 0) {
            return;
        }

        const database = await openFullScanDatabase();

        await new Promise((resolve, reject) => {
            const transaction = database.transaction(
                CONFIG.fullScanStoreName,
                "readwrite"
            );
            const store = transaction.objectStore(CONFIG.fullScanStoreName);

            for (const game of games) {
                store.put(game);
            }

            transaction.addEventListener("complete", resolve);
            transaction.addEventListener("error", () => reject(transaction.error));
            transaction.addEventListener("abort", () => reject(transaction.error));
        });
    }

    function readCatalogCache() {
        const cached = readJsonStorage(CONFIG.cacheKey, null);

        if (!cached || !Array.isArray(cached.games)) {
            return null;
        }

        return {
            savedAt: Number(cached.savedAt) || 0,
            games: cached.games,
            isFresh:
                Number.isFinite(cached.savedAt) &&
                Date.now() - cached.savedAt <= CONFIG.cacheTtlMs,
        };
    }

    function writeCatalogCache(games) {
        writeJsonStorage(CONFIG.cacheKey, {
            savedAt: Date.now(),
            games,
        });
    }

    function loadTracker() {
        try {
            const raw = localStorage.getItem(CONFIG.trackerKey);

            // Older scanner versions could accidentally snapshot the entire
            // full ID index into localStorage. A very large JSON blob blocks
            // the main thread while parsing, so reset only that lightweight
            // tracker. IndexedDB games and scan progress are untouched.
            if (raw && raw.length > 1_000_000) {
                localStorage.removeItem(CONFIG.trackerKey);
                return {
                    version: 3,
                    initializedAt: 0,
                    lastScanAt: 0,
                    games: {},
                };
            }

            const stored = raw ? JSON.parse(raw) : null;

            if (
                stored &&
                stored.version === 3 &&
                stored.games &&
                typeof stored.games === "object"
            ) {
                return stored;
            }
        } catch (error) {
            console.warn("[Pekora Discovery] Could not load update tracker:", error);
        }

        return {
            version: 3,
            initializedAt: 0,
            lastScanAt: 0,
            games: {},
        };
    }

    function normalizeComparable(value) {
        if (value == null) {
            return "";
        }

        return String(value)
            .replace(/\r\n/g, "\n")
            .replace(/[\t ]+/g, " ")
            .trim();
    }

    function thumbnailFingerprint(url) {
        if (!url) {
            return "";
        }

        try {
            const parsed = new URL(url, location.origin);
            return parsed.pathname;
        } catch {
            return normalizeComparable(url);
        }
    }

    function compactFingerprint(value) {
        const text = normalizeComparable(value);
        let hash = 2166136261;

        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }

        return `${text.length}:${(hash >>> 0).toString(16)}`;
    }

    function meaningfulSnapshot(game) {
        return {
            name: normalizeComparable(game.name),
            descriptionHash: compactFingerprint(
                game.gameDescription ?? game.description
            ),
            imageToken: normalizeComparable(game.imageToken),
            thumbnail: thumbnailFingerprint(game.thumbnailUrl),
            year: normalizeComparable(game.year),
            placeId: normalizeComparable(game.placeId),
            rootPlaceId: normalizeComparable(game.rootPlaceId),
            genre: normalizeComparable(game.genre),
            price: normalizeComparable(game.price),
            serverUpdatedAt: normalizeComparable(game.updatedAt ?? game.updated),
        };
    }

    function changedSnapshotFields(previous, current) {
        return Object.keys(current).filter(
            (key) => normalizeComparable(previous?.[key]) !== current[key]
        );
    }

    function updateTracker(scannedGames) {
        const now = Date.now();
        const tracker = loadTracker();
        const establishingBaseline = !Number.isFinite(tracker.initializedAt) || tracker.initializedAt <= 0;

        if (establishingBaseline) {
            tracker.initializedAt = now;
        }

        for (const game of scannedGames) {
            const key = String(game.universeId);
            const snapshot = meaningfulSnapshot(game);
            const previous = tracker.games[key];

            if (!previous) {
                tracker.games[key] = {
                    snapshot,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    lastChangedAt: 0,
                    changedFields: [],
                };
                continue;
            }

            const changedFields = changedSnapshotFields(previous.snapshot, snapshot);

            tracker.games[key] = {
                snapshot,
                firstSeenAt: Number(previous.firstSeenAt) || now,
                lastSeenAt: now,
                lastChangedAt:
                    changedFields.length > 0 && !establishingBaseline
                        ? now
                        : Number(previous.lastChangedAt) || 0,
                changedFields:
                    changedFields.length > 0 && !establishingBaseline
                        ? changedFields
                        : Array.isArray(previous.changedFields)
                          ? previous.changedFields
                          : [],
            };
        }

        const activeKeys = new Set(
            scannedGames.map((game) => String(game.universeId))
        );
        const pruneBefore = now - CONFIG.preserveCatalogMs * 2;

        // Only list-discovered games need local snapshot tracking. Exact
        // server update timestamps for the full ID index live in IndexedDB.
        // Removing old full-index snapshots prevents localStorage from growing
        // into a multi-megabyte object that can stall the page.
        for (const [key, record] of Object.entries(tracker.games)) {
            if (
                !activeKeys.has(key) ||
                (Number(record.lastSeenAt) || 0) < pruneBefore
            ) {
                delete tracker.games[key];
            }
        }

        tracker.lastScanAt = now;
        writeJsonStorage(CONFIG.trackerKey, tracker);
        state.tracker = tracker;
        return tracker;
    }

    function annotateTracking(games, tracker = state.tracker || loadTracker()) {
        state.tracker = tracker;

        return games.map((game) => {
            const record = tracker.games[String(game.universeId)] || null;
            const firstSeenAt = Number(record?.firstSeenAt) || 0;

            return {
                ...game,
                tracking: {
                    firstSeenAt,
                    lastSeenAt: Number(record?.lastSeenAt) || 0,
                    lastChangedAt: Number(record?.lastChangedAt) || 0,
                    changedFields: Array.isArray(record?.changedFields)
                        ? record.changedFields
                        : [],
                    isNewDiscovery:
                        firstSeenAt > 0 &&
                        tracker.initializedAt > 0 &&
                        firstSeenAt - tracker.initializedAt > 60_000,
                },
            };
        });
    }

    function parseGenreId(filter) {
        if (!filter || filter.name === "All") {
            return null;
        }

        const match = String(filter.token || "").match(/_(\d+)_/);
        return match ? Number(match[1]) : null;
    }

    async function mapWithConcurrency(items, limit, worker) {
        const results = new Array(items.length);
        let nextIndex = 0;

        async function runWorker() {
            while (nextIndex < items.length) {
                const index = nextIndex;
                nextIndex += 1;

                try {
                    results[index] = await worker(items[index], index);
                } catch (error) {
                    results[index] = { error };
                }
            }
        }

        const workerCount = Math.max(1, Math.min(limit, items.length));
        await Promise.all(Array.from({ length: workerCount }, runWorker));
        return results;
    }

    function buildCatalogRequests(sortsPayload, deepScan) {
        const sorts = Array.isArray(sortsPayload.sorts)
            ? sortsPayload.sorts
            : [];
        const requests = [];
        const requestKeys = new Set();

        function addRequest(sortToken, genre = 0, keyword = "") {
            const key = `${sortToken}:${genre}:${keyword.toLowerCase()}`;

            if (!sortToken || requestKeys.has(key)) {
                return;
            }

            requestKeys.add(key);
            requests.push({ sortToken, genre, keyword });
        }

        // Normal/background refreshes only load the site's main server sorts.
        // Genre and keyword expansion is reserved for the manual Deep Scan so
        // opening /games does not create a burst of dozens of API requests.
        for (const sort of sorts) {
            addRequest(sort.token, 0, "");
        }

        if (deepScan) {
            const genreIds = (Array.isArray(sortsPayload.genreFilters)
                ? sortsPayload.genreFilters
                : []
            )
                .map(parseGenreId)
                .filter(Number.isInteger);

            const popularToken =
                sorts.find((sort) => sort.token === "popular")?.token ||
                sorts[0]?.token;

            for (const sort of sorts) {
                for (const genreId of genreIds) {
                    addRequest(sort.token, genreId, "");
                }
            }

            for (const term of CONFIG.keywordScanTerms) {
                addRequest(popularToken, 0, term);
            }
        }

        return requests;
    }

    function mergeGameRecords(existing, incoming) {
        if (!existing) {
            return { ...incoming };
        }

        const merged = {
            ...existing,
            ...incoming,
            _fromList: Boolean(existing._fromList || incoming._fromList),
            _fromFullScan: Boolean(
                existing._fromFullScan || incoming._fromFullScan
            ),
        };

        const preserveNumericFields = [
            "visitCount",
            "totalUpVotes",
            "totalDownVotes",
        ];

        for (const field of preserveNumericFields) {
            if (
                !Number.isFinite(Number(incoming[field])) &&
                Number.isFinite(Number(existing[field]))
            ) {
                merged[field] = Number(existing[field]);
            }
        }

        if (!incoming.thumbnailUrl && existing.thumbnailUrl) {
            merged.thumbnailUrl = existing.thumbnailUrl;
        }

        if (!incoming.gameDescription && existing.gameDescription) {
            merged.gameDescription = existing.gameDescription;
        }

        return merged;
    }

    function normalizePlaceDetail(detail) {
        const queriedPlaceId = Number(detail?.placeId);
        const rootPlaceId = Number(
            detail?.universeRootPlaceId ?? detail?.placeId
        );
        const universeId = Number(detail?.universeId);

        // The ID range includes subplaces. Only retain each universe's root
        // place so the full index contains one card per public game.
        if (
            !Number.isInteger(queriedPlaceId) ||
            !Number.isInteger(rootPlaceId) ||
            !Number.isInteger(universeId) ||
            queriedPlaceId !== rootPlaceId
        ) {
            return null;
        }

        return {
            placeId: rootPlaceId,
            rootPlaceId,
            universeId,
            name: String(detail?.name || "Untitled Game"),
            gameDescription: String(detail?.description || ""),
            description: String(detail?.description || ""),
            year: detail?.year ?? null,
            robloxPlaceId: detail?.robloxPlaceId ?? null,
            creatorId: Number(detail?.builderId) || 0,
            creatorType: String(detail?.builderType || "User"),
            creatorName: String(detail?.builder || "Unknown"),
            price: detail?.price ?? null,
            playerCount: Number(detail?.playerCount) || 0,
            isPlayable: Boolean(detail?.isPlayable),
            imageToken: String(detail?.imageToken || ""),
            reasonProhibited: String(detail?.reasonProhibited || ""),
            maxPlayerCount: Number(detail?.maxPlayerCount) || 0,
            genre: String(detail?.genre || "All"),
            moderationStatus: String(detail?.moderationStatus || ""),
            createdAt: String(detail?.created || ""),
            updatedAt: String(detail?.updated || ""),
            _fromFullScan: true,
            _lastCatalogSeenAt: Date.now(),
            _playerCountCheckedAt: Date.now(),
        };
    }

    async function fetchPlaceDetailsWithRetry(placeIds) {
        const url = apiUrl(
            "/apisite/games/v1/games/multiget-place-details",
            { placeIds: placeIds.join(",") }
        );
        let lastError = null;

        for (let attempt = 0; attempt < CONFIG.fullScanMaxRetries; attempt += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(
                () => controller.abort(),
                CONFIG.requestTimeoutMs
            );

            try {
                const response = await fetch(url, {
                    method: "GET",
                    credentials: "include",
                    headers: { Accept: "application/json" },
                    signal: controller.signal,
                });

                if (response.status === 429) {
                    const retryAfter = Number(response.headers.get("retry-after"));
                    await sleep(
                        Number.isFinite(retryAfter)
                            ? Math.max(1, retryAfter) * 1000
                            : Math.min(30_000, 5_000 * 2 ** attempt)
                    );
                    continue;
                }

                if ([500, 502, 503, 504].includes(response.status)) {
                    lastError = new Error(`HTTP ${response.status} for ${url}`);
                    await sleep(Math.min(45_000, 4_000 * 2 ** attempt));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} for ${url}`);
                }

                const payload = await response.json();
                return Array.isArray(payload) ? payload : [];
            } catch (error) {
                lastError = error;
                await sleep(Math.min(30_000, 1_500 * 2 ** attempt));
            } finally {
                clearTimeout(timeout);
            }
        }

        throw lastError || new Error("The place-details request failed.");
    }

    function highestKnownPlaceId(games = state.catalog) {
        return Math.max(
            0,
            ...games.map((game) => Number(game?.placeId) || 0)
        );
    }

    function createInitialFullScanProgress() {
        const highestKnown = highestKnownPlaceId();
        const targetPlaceId = Math.max(
            CONFIG.fullScanHeadroomIds,
            highestKnown + CONFIG.fullScanHeadroomIds
        );

        return {
            version: 1,
            nextPlaceId: 1,
            targetPlaceId,
            scannedIds: 0,
            foundGames: 0,
            lastValidPlaceId: highestKnown,
            startedAt: Date.now(),
            lastRunAt: Date.now(),
            paused: false,
            complete: false,
        };
    }

    function fullScanStatusText(progress = state.fullScanProgress) {
        if (!progress) {
            return "Full ID scan has not started.";
        }

        const completedThrough = Math.max(0, progress.nextPlaceId - 1);
        const percentage = Math.min(
            100,
            (completedThrough / Math.max(1, progress.targetPlaceId)) * 100
        );

        return (
            `Scanning Place IDs ${completedThrough.toLocaleString()} / ` +
            `${progress.targetPlaceId.toLocaleString()} ` +
            `(${percentage.toFixed(1)}%) · ` +
            `${progress.foundGames.toLocaleString()} public games indexed`
        );
    }

    async function mergeIndexedGamesIntoCatalog() {
        state.indexedTotalCount = await databaseCountGames();
        resetIndexedLoader();
        await loadMoreIndexedGames(CONFIG.indexedInitialLoadLimit, {
            render: false,
        });
        state.indexedCatalogLoaded = true;
        await initializeGameOfDay();
        queuePatch(true);
        return state.catalog;
    }

    async function runFullCatalogScan() {
        if (state.fullScanning || (state.loading && !state.fullScanning)) {
            return;
        }

        let progress = readFullScanProgress();

        if (!progress) {
            progress = createInitialFullScanProgress();
        } else if (progress.complete) {
            const latestKnownPlaceId = Math.max(
                Number(progress.lastValidPlaceId) || 0,
                highestKnownPlaceId()
            );
            const nextPlaceId = Math.max(
                1,
                (Number(progress.lastValidPlaceId) || 0) + 1
            );

            progress = {
                ...progress,
                nextPlaceId,
                targetPlaceId: Math.max(
                    nextPlaceId + CONFIG.fullScanBatchSize - 1,
                    latestKnownPlaceId + CONFIG.fullScanRescanHeadroomIds
                ),
                complete: false,
                paused: false,
            };
            state.newScanAvailable = false;
        } else {
            progress.paused = false;
        }

        state.fullScanning = true;
        state.fullScanStopRequested = false;
        state.loading = true;
        state.error = null;
        progress = writeFullScanProgress(progress);
        state.scanMessage = fullScanStatusText(progress);
        queuePatch(true);

        let batchesSinceSave = 0;
        let batchesSinceUi = 0;

        try {
            while (progress.nextPlaceId <= progress.targetPlaceId) {
                if (state.fullScanStopRequested) {
                    progress.paused = true;
                    progress = writeFullScanProgress(progress);
                    state.scanMessage =
                        "Full ID scan paused. Click Resume Full Scan to continue.";
                    break;
                }

                const batchStart = progress.nextPlaceId;
                const batchEnd = Math.min(
                    progress.targetPlaceId,
                    batchStart + CONFIG.fullScanBatchSize - 1
                );
                const placeIds = Array.from(
                    { length: batchEnd - batchStart + 1 },
                    (_, index) => batchStart + index
                );
                const details = await fetchPlaceDetailsWithRetry(placeIds);
                const rootGames = details
                    .map(normalizePlaceDetail)
                    .filter(Boolean);

                if (rootGames.length > 0) {
                    await databasePutGames(rootGames);
                    progress.foundGames += rootGames.length;

                    const highestReturned = Math.max(
                        ...rootGames.map((game) => game.placeId)
                    );
                    progress.lastValidPlaceId = Math.max(
                        progress.lastValidPlaceId,
                        highestReturned
                    );

                    if (
                        highestReturned >=
                        progress.targetPlaceId -
                            CONFIG.fullScanExtendThresholdIds
                    ) {
                        progress.targetPlaceId += CONFIG.fullScanHeadroomIds;
                    }
                }

                progress.nextPlaceId = batchEnd + 1;
                progress.scannedIds += placeIds.length;
                progress.paused = false;
                batchesSinceSave += 1;
                batchesSinceUi += 1;

                if (
                    batchesSinceSave >=
                    CONFIG.fullScanProgressSaveEveryBatches
                ) {
                    progress = writeFullScanProgress(progress);
                    batchesSinceSave = 0;
                } else {
                    state.fullScanProgress = { ...progress };
                }

                if (
                    batchesSinceUi >= CONFIG.fullScanUiUpdateEveryBatches
                ) {
                    state.scanMessage = fullScanStatusText(progress);
                    updateLiveScanUi();
                    batchesSinceUi = 0;
                }

                await sleep(
                    document.visibilityState === "hidden"
                        ? CONFIG.fullScanHiddenDelayMs
                        : CONFIG.fullScanDelayMs
                );
            }

            progress = writeFullScanProgress(progress);

            if (!progress.paused && progress.nextPlaceId > progress.targetPlaceId) {
                progress.complete = true;
                progress.paused = false;
                progress = writeFullScanProgress(progress);
                state.scanMessage =
                    `Full ID scan complete. ` +
                    `${progress.foundGames.toLocaleString()} public root games were indexed.`;
                state.newScanAvailable = false;
                state.newScanHighestPlaceId = Number(progress.lastValidPlaceId) || 0;
                writeJsonStorage(CONFIG.scanAlertStateKey, {
                    highestNotifiedPlaceId:
                        Number(progress.lastValidPlaceId) || 0,
                    notifiedAt: Date.now(),
                });
            }

            // Do not request thousands of thumbnails at scan completion.
            // Icons are fetched lazily only for cards the user actually views.
            await mergeIndexedGamesIntoCatalog({ loadThumbnails: false });
        } catch (error) {
            console.error("[Pekora Discovery] Full ID scan failed:", error);
            progress.paused = true;
            writeFullScanProgress(progress);
            state.error = error instanceof Error ? error : new Error(String(error));
            state.scanMessage =
                "The scanner paused after a server/network error. Resume it later.";
        } finally {
            state.fullScanning = false;
            state.fullScanStopRequested = false;
            state.loading = false;
            state.loaded = true;
            state.currentPage = 0;
            queuePatch(true);
        }
    }

    async function refreshIndexedGameDetails(indexedGames) {
        if (!Array.isArray(indexedGames) || indexedGames.length === 0) {
            return [];
        }

        const batches = [];
        const rootPlaceIds = [
            ...new Set(
                indexedGames
                    .map((game) => Number(game.placeId))
                    .filter(Number.isInteger)
            ),
        ];

        for (
            let offset = 0;
            offset < rootPlaceIds.length;
            offset += CONFIG.fullScanBatchSize
        ) {
            batches.push(
                rootPlaceIds.slice(offset, offset + CONFIG.fullScanBatchSize)
            );
        }

        let completed = 0;
        const results = await mapWithConcurrency(
            batches,
            CONFIG.refreshConcurrentRequests,
            async (placeIds) => {
                const details = await fetchPlaceDetailsWithRetry(placeIds);
                completed += 1;

                if (
                    completed === batches.length ||
                    completed % CONFIG.fullScanUiUpdateEveryBatches === 0
                ) {
                    state.scanMessage =
                        `Refreshing player counts and exact update times: ` +
                        `${completed.toLocaleString()} / ` +
                        `${batches.length.toLocaleString()} batches…`;
                    updateLiveScanUi();
                }

                await sleep(CONFIG.fullScanDelayMs);
                return details.map(normalizePlaceDetail).filter(Boolean);
            }
        );

        const refreshed = results.flatMap((result) =>
            Array.isArray(result) ? result : []
        );
        const existingById = new Map(
            indexedGames.map((game) => [Number(game.universeId), game])
        );
        const mergedRefreshed = refreshed.map((game) =>
            mergeGameRecords(existingById.get(Number(game.universeId)), game)
        );

        await databasePutGames(mergedRefreshed);
        return mergedRefreshed;
    }

    async function fetchCatalogBatch(requests) {
        const responses = await mapWithConcurrency(
            requests,
            CONFIG.maxConcurrentRequests,
            async ({ sortToken, genre, keyword }) => {
                const makeUrl = (maxRows) =>
                    apiUrl("/apisite/games/v1/games/list", {
                        sortToken,
                        maxRows,
                        genre,
                        keyword,
                    });

                let payload;

                try {
                    payload = await fetchJson(makeUrl(CONFIG.maxRows));
                } catch (error) {
                    // The live server was observed using 100 rows. If it rejects
                    // a larger value, retry with that known-compatible size.
                    if (CONFIG.maxRows <= 100) {
                        throw error;
                    }

                    payload = await fetchJson(makeUrl(100));
                }

                return Array.isArray(payload.games) ? payload.games : [];
            }
        );

        const gamesById = new Map();

        for (const result of responses) {
            if (!Array.isArray(result)) {
                if (result?.error) {
                    console.warn(
                        "[Pekora Discovery] A catalog request failed:",
                        result.error
                    );
                }
                continue;
            }

            for (const game of result) {
                const universeId = Number(game?.universeId);
                const placeId = Number(game?.placeId ?? game?.rootPlaceId);
                const visitCount = Number(game?.visitCount);

                if (
                    !Number.isInteger(universeId) ||
                    !Number.isInteger(placeId) ||
                    !Number.isFinite(visitCount)
                ) {
                    continue;
                }

                const normalized = {
                    ...game,
                    universeId,
                    placeId,
                    rootPlaceId: Number(game?.rootPlaceId ?? placeId),
                    visitCount,
                    playerCount: Number(game?.playerCount) || 0,
                    totalUpVotes: Number(game?.totalUpVotes) || 0,
                    totalDownVotes: Number(game?.totalDownVotes) || 0,
                    gameDescription: String(
                        game?.gameDescription ?? game?.description ?? ""
                    ),
                    createdAt: String(game?.createdAt ?? game?.created ?? ""),
                    updatedAt: String(game?.updatedAt ?? game?.updated ?? ""),
                    _fromList: true,
                    _lastCatalogSeenAt: Date.now(),
                    _playerCountCheckedAt: Date.now(),
                };

                const existing = gamesById.get(universeId);

                if (!existing || normalized.gameDescription?.length > existing.gameDescription?.length) {
                    gamesById.set(universeId, normalized);
                }
            }
        }

        return [...gamesById.values()];
    }

    async function attachThumbnails(games) {
        const ids = [...new Set(games.map((game) => game.universeId))];
        const thumbnailById = new Map();

        for (let offset = 0; offset < ids.length; offset += 100) {
            const chunk = ids.slice(offset, offset + 100);

            try {
                const payload = await fetchJson(
                    apiUrl("/apisite/thumbnails/v1/games/icons", {
                        size: "150x150",
                        format: "png",
                        universeIds: chunk.join(","),
                    })
                );

                for (const thumbnail of payload.data || []) {
                    const targetId = Number(thumbnail?.targetId);

                    if (
                        Number.isInteger(targetId) &&
                        typeof thumbnail?.imageUrl === "string"
                    ) {
                        thumbnailById.set(targetId, thumbnail.imageUrl);
                    }
                }
            } catch (error) {
                console.warn(
                    "[Pekora Discovery] Thumbnail request failed:",
                    error
                );
            }
        }

        for (const game of games) {
            game.thumbnailUrl =
                thumbnailById.get(game.universeId) ||
                game.thumbnailUrl ||
                null;
            game._thumbnailCheckedAt = Date.now();
        }
    }

    function scheduleVisibleThumbnailLoad(games) {
        const retryAfter = Date.now() - 24 * 60 * 60 * 1000;
        const targets = [];

        for (const game of games || []) {
            const universeId = Number(game?.universeId);

            if (
                !Number.isInteger(universeId) ||
                game.thumbnailUrl ||
                state.thumbnailPending.has(universeId) ||
                Number(game._thumbnailCheckedAt || 0) > retryAfter
            ) {
                continue;
            }

            state.thumbnailPending.add(universeId);
            targets.push(game);

            if (targets.length >= 100) {
                break;
            }
        }

        if (targets.length === 0) {
            return;
        }

        Promise.resolve()
            .then(async () => {
                await attachThumbnails(targets);

                const indexedTargets = targets.filter(
                    (game) => game._fromFullScan
                );

                if (indexedTargets.length > 0) {
                    await databasePutGames(indexedTargets);
                }
            })
            .catch((error) => {
                console.warn(
                    "[Pekora Discovery] Lazy thumbnail load failed:",
                    error
                );
            })
            .finally(() => {
                for (const game of targets) {
                    state.thumbnailPending.delete(Number(game.universeId));
                }

                renderCurrentSection();
            });
    }

    function mergeCatalog(previousGames, freshlyScannedGames) {
        const now = Date.now();
        const keepAfter = now - CONFIG.preserveCatalogMs;
        const merged = new Map();

        for (const oldGame of previousGames || []) {
            const lastSeen = Number(oldGame?._lastCatalogSeenAt) || 0;

            if (
                Number.isInteger(Number(oldGame?.universeId)) &&
                (oldGame?._fromFullScan || lastSeen >= keepAfter)
            ) {
                merged.set(Number(oldGame.universeId), oldGame);
            }
        }

        for (const game of freshlyScannedGames) {
            const key = Number(game.universeId);
            merged.set(key, mergeGameRecords(merged.get(key), game));
        }

        return [...merged.values()];
    }

    async function scanCatalog({
        deepScan = false,
        refreshIndexed = false,
    } = {}) {
        const oldCache = readCatalogCache();
        const previousGames = state.catalog.length > 0
            ? state.catalog
            : oldCache?.games || [];

        const sortsPayload = await fetchJson(
            apiUrl("/apisite/games/v1/games/sorts", {
                gameSortsContext: "GamesDefaultSorts",
            })
        );

        const requests = buildCatalogRequests(sortsPayload, deepScan);
        state.scanMessage = deepScan
            ? `Deep scanning ${requests.length} game lists…`
            : `Scanning ${requests.length} game lists…`;
        queuePatch(true);

        const freshlyScannedGames = await fetchCatalogBatch(requests);

        if (freshlyScannedGames.length === 0) {
            throw new Error("Pekora returned no games from the available lists.");
        }

        state.scanMessage = `Loading icons for ${freshlyScannedGames.length.toLocaleString()} listed games…`;
        queuePatch(true);
        await attachThumbnails(freshlyScannedGames);

        // Never read the complete IndexedDB index during a normal rescan.
        // The loaded window is merged in memory, while the rest remains paged
        // from IndexedDB only when the user navigates farther into the row.
        const mergedById = new Map(
            mergeCatalog(previousGames, freshlyScannedGames).map((game) => [
                Number(game.universeId),
                game,
            ])
        );
        const merged = [...mergedById.values()];
        const tracker = updateTracker(merged.filter((game) => game._fromList));
        const annotated = annotateTracking(merged, tracker);

        // Indexed games remain in IndexedDB. Keep the lightweight homepage/list
        // cache in localStorage so large full indexes do not exceed its quota.
        writeCatalogCache(annotated.filter((game) => game._fromList));
        detectNewScanRange(annotated, true);
        return annotated;
    }

    function slugify(value) {
        const slug = String(value || "game")
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-zA-Z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");

        return slug || "game";
    }

    function formatVisits(value) {
        const visits = Number(value);
        return Number.isFinite(visits)
            ? `${visits.toLocaleString()} visits`
            : "Visits unavailable";
    }

    function formatRelativeTime(timestamp) {
        const difference = Date.now() - Number(timestamp);

        if (!Number.isFinite(difference) || difference < 0) {
            return "recently";
        }

        const minute = 60_000;
        const hour = 60 * minute;
        const day = 24 * hour;

        if (difference < minute) {
            return "just now";
        }

        if (difference < hour) {
            const minutes = Math.floor(difference / minute);
            return `${minutes}m ago`;
        }

        if (difference < day) {
            const hours = Math.floor(difference / hour);
            return `${hours}h ago`;
        }

        const days = Math.floor(difference / day);
        return `${days}d ago`;
    }

    function getServerUpdatedTimestamp(game) {
        const value = game?.updatedAt ?? game?.updated;
        const timestamp = value ? Date.parse(value) : NaN;

        if (Number.isFinite(timestamp)) {
            return timestamp;
        }

        return Number(game?.tracking?.lastChangedAt) || 0;
    }


    function localDateKey(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function stableDailyHash(value) {
        const text = String(value || "");
        let hash = 2166136261;

        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }

        return hash >>> 0;
    }

    function displayableIndexedGame(game) {
        const universeId = Number(game?.universeId);
        const placeId = Number(game?.placeId ?? game?.rootPlaceId);

        return Boolean(
            Number.isInteger(universeId) &&
            universeId > 0 &&
            Number.isInteger(placeId) &&
            placeId > 0
        );
    }

    function gameOfDayEligible(game) {
        return Boolean(
            displayableIndexedGame(game) &&
            normalizeComparable(game?.name || "Untitled Game") &&
            Number(game?.playerCount || 0) >=
                CONFIG.gameOfDayMinimumPlayers
        );
    }

    function gameOfDayCandidateScore(game, today) {
        return stableDailyHash(
            `korone:${today}:${Number(game?.universeId) || 0}`
        );
    }

    function uniqueGameOfDayCandidates(games, today) {
        const byUniverseId = new Map();

        for (const game of games || []) {
            const universeId = Number(game?.universeId);

            if (
                !displayableIndexedGame(game) ||
                !Number.isInteger(universeId) ||
                byUniverseId.has(universeId)
            ) {
                continue;
            }

            byUniverseId.set(universeId, game);
        }

        return [...byUniverseId.values()].sort(
            (left, right) =>
                gameOfDayCandidateScore(left, today) -
                gameOfDayCandidateScore(right, today)
        );
    }

    async function refreshGameOfDayCandidates(candidates) {
        const limited = candidates.slice(
            0,
            CONFIG.gameOfDayCandidateLimit
        );

        if (limited.length === 0) {
            return [];
        }

        try {
            const details = await fetchPlaceDetailsWithRetry(
                [...new Set(
                    limited.map((game) => Number(game.placeId))
                )]
            );
            const refreshed = details
                .map(normalizePlaceDetail)
                .filter(Boolean);
            const refreshedById = new Map(
                refreshed.map((game) => [Number(game.universeId), game])
            );
            const checkedAt = Date.now();
            const databaseUpdates = [];
            const results = [];

            for (const candidate of limited) {
                const live = refreshedById.get(
                    Number(candidate.universeId)
                );

                if (!live) {
                    continue;
                }

                const merged = mergeGameRecords(candidate, live);
                merged._playerCountCheckedAt = checkedAt;

                const loaded = state.catalogById.get(
                    Number(merged.universeId)
                );

                if (loaded) {
                    Object.assign(loaded, merged);
                    results.push(loaded);
                    databaseUpdates.push(loaded);
                } else {
                    results.push(merged);
                    databaseUpdates.push(merged);
                }
            }

            if (databaseUpdates.length > 0) {
                await databasePutGames(databaseUpdates);
            }

            return results;
        } catch (error) {
            console.warn(
                "[Pekora Discovery] Could not validate Game of the Day candidates:",
                error
            );

            // Keep the feature available during a temporary network error, but
            // only use candidates whose most recently saved count is positive.
            return limited.filter(gameOfDayEligible);
        }
    }

    function selectGameOfDay() {
        const today = localDateKey();

        if (
            state.gameOfDay &&
            state.gameOfDayDate === today &&
            gameOfDayEligible(state.gameOfDay)
        ) {
            return state.gameOfDay;
        }

        return null;
    }

    async function initializeGameOfDay({ force = false } = {}) {
        const today = localDateKey();

        if (
            !force &&
            state.gameOfDay &&
            state.gameOfDayDate === today &&
            gameOfDayEligible(state.gameOfDay)
        ) {
            return state.gameOfDay;
        }

        const saved = readJsonStorage(CONFIG.gameOfDayKey, null);
        let savedCandidate = null;

        if (saved?.date === today) {
            savedCandidate = await databaseGetGame(saved.universeId);
        }

        const positiveCandidates = state.catalog.filter(
            gameOfDayEligible
        );
        const orderedCandidates = uniqueGameOfDayCandidates(
            [
                ...(savedCandidate ? [savedCandidate] : []),
                ...positiveCandidates,
            ],
            today
        );

        // Preserve today's choice when it is still active, then use the
        // deterministic daily ordering for the remaining active candidates.
        if (savedCandidate) {
            const savedIndex = orderedCandidates.findIndex(
                (game) =>
                    Number(game.universeId) ===
                    Number(savedCandidate.universeId)
            );

            if (savedIndex > 0) {
                orderedCandidates.unshift(
                    ...orderedCandidates.splice(savedIndex, 1)
                );
            }
        }

        const liveCandidates = await refreshGameOfDayCandidates(
            orderedCandidates
        );
        const selected =
            liveCandidates.find(gameOfDayEligible) || null;

        state.gameOfDay = selected;
        state.gameOfDayDate = selected ? today : "";

        if (selected) {
            writeJsonStorage(CONFIG.gameOfDayKey, {
                date: today,
                universeId: Number(selected.universeId),
            });
        } else {
            localStorage.removeItem(CONFIG.gameOfDayKey);
        }

        return selected;
    }

    function isGameOfDay(game) {
        const featured = selectGameOfDay();
        return Boolean(
            featured &&
            Number(featured.universeId) === Number(game?.universeId)
        );
    }

    function displayGameInfo() {
        const featured = state.search.trim() ? null : selectGameOfDay();
        const games = featured
            ? state.visibleGames.filter(
                  (game) =>
                      Number(game.universeId) !==
                      Number(featured.universeId)
              )
            : state.visibleGames;

        return {
            featured,
            games,
            totalCount: games.length + (featured ? 1 : 0),
        };
    }

    function displayPageCount(pageSize, info = displayGameInfo()) {
        const safePageSize = Math.max(1, Number(pageSize) || 1);
        const { featured, games } = info;

        if (!featured) {
            return Math.max(1, Math.ceil(games.length / safePageSize));
        }

        const remainingAfterFeaturedPage = Math.max(
            0,
            games.length - Math.max(0, safePageSize - 1)
        );

        return (
            1 +
            Math.ceil(remainingAfterFeaturedPage / safePageSize)
        );
    }

    async function refreshVisiblePlayerCounts(games) {
        if (
            state.loading ||
            state.fullScanning ||
            !Array.isArray(games) ||
            games.length === 0
        ) {
            return;
        }

        const refreshBefore = Date.now() - CONFIG.visiblePlayerRefreshMs;
        const targets = [];

        for (const game of games) {
            const universeId = Number(game?.universeId);
            const placeId = Number(game?.placeId);

            if (
                !Number.isInteger(universeId) ||
                !Number.isInteger(placeId) ||
                state.playerCountPending.has(universeId) ||
                Number(game?._playerCountCheckedAt || 0) > refreshBefore
            ) {
                continue;
            }

            state.playerCountPending.add(universeId);
            targets.push(game);
        }

        if (targets.length === 0) {
            return;
        }

        let changed = false;

        try {
            const details = await fetchPlaceDetailsWithRetry(
                [...new Set(targets.map((game) => Number(game.placeId)))]
            );
            const refreshed = details
                .map(normalizePlaceDetail)
                .filter(Boolean);
            const refreshedById = new Map(
                refreshed.map((game) => [Number(game.universeId), game])
            );
            const checkedAt = Date.now();
            const indexedUpdates = [];

            for (const target of targets) {
                const update = refreshedById.get(Number(target.universeId));
                const previousCount = Number(target.playerCount || 0);

                if (update) {
                    const merged = mergeGameRecords(target, update);
                    Object.assign(target, merged, {
                        _playerCountCheckedAt: checkedAt,
                    });
                    changed =
                        changed ||
                        previousCount !== Number(target.playerCount || 0);

                    if (target._fromFullScan) {
                        indexedUpdates.push(target);
                    }
                } else {
                    target._playerCountCheckedAt = checkedAt;
                }
            }

            if (indexedUpdates.length > 0) {
                await databasePutGames(indexedUpdates);
            }

            if (state.gameOfDay) {
                const featuredUpdate = refreshedById.get(
                    Number(state.gameOfDay.universeId)
                );

                if (featuredUpdate) {
                    Object.assign(
                        state.gameOfDay,
                        mergeGameRecords(state.gameOfDay, featuredUpdate),
                        { _playerCountCheckedAt: checkedAt }
                    );
                }

                if (!gameOfDayEligible(state.gameOfDay)) {
                    state.gameOfDay = null;
                    state.gameOfDayDate = "";
                    localStorage.removeItem(CONFIG.gameOfDayKey);
                    await initializeGameOfDay({ force: true });
                    changed = true;
                }
            }
        } catch (error) {
            console.warn(
                "[Pekora Discovery] Could not refresh visible player counts:",
                error
            );
        } finally {
            for (const game of targets) {
                state.playerCountPending.delete(Number(game.universeId));
            }

            if (changed) {
                renderCurrentSection();
            }
        }
    }

    function scheduleVisiblePlayerCountRefresh(games) {
        for (const game of games || []) {
            const universeId = Number(game?.universeId);

            if (Number.isInteger(universeId)) {
                state.playerRefreshQueue.set(universeId, game);
            }
        }

        if (state.gameOfDay) {
            state.playerRefreshQueue.set(
                Number(state.gameOfDay.universeId),
                state.gameOfDay
            );
        }

        if (state.playerRefreshTimer) {
            return;
        }

        state.playerRefreshTimer = setTimeout(() => {
            state.playerRefreshTimer = null;
            const targets = [...state.playerRefreshQueue.values()];
            state.playerRefreshQueue.clear();
            refreshVisiblePlayerCounts(targets);
        }, CONFIG.visiblePlayerRefreshDelayMs);
    }

    function discoveryHeadingMatches(heading) {
        if (!heading) {
            return false;
        }

        const title = heading.querySelector(
            ".pekora-discovery-heading-text"
        );

        return title
            ? title.textContent.trim() === CONFIG.replacementHeading
            : heading.textContent.trim() === CONFIG.replacementHeading;
    }

    function renderDiscoveryHeading(heading) {
        if (!heading) {
            return;
        }

        heading.classList.add("pekora-discovery-heading");
        heading.replaceChildren();

        const title = document.createElement("span");
        title.className = "pekora-discovery-heading-text";
        title.textContent = CONFIG.replacementHeading;

        const badge = document.createElement("span");
        badge.className = "pekora-discovery-heading-new-badge";
        badge.textContent = CONFIG.newBadgeText;
        badge.setAttribute("aria-label", "New feature");
        badge.title = "New game-discovery feature";

        heading.append(title, badge);
    }

    function findSection() {
        const marked = document.querySelector(
            '[data-pekora-discovery-section="true"]'
        );

        if (marked?.isConnected) {
            return marked;
        }

        const heading = [...document.querySelectorAll("h3")].find(
            (element) => element.textContent.trim() === CONFIG.targetHeading
        );

        if (!heading) {
            return null;
        }

        return (
            heading.closest('[class*="sort-"]') ||
            heading.parentElement?.parentElement ||
            null
        );
    }

    function findByClassPart(root, part) {
        return root?.querySelector(`[class*="${part}"]`) || null;
    }

    function setCatalog(games) {
        state.catalog = Array.isArray(games) ? games : [];
        state.catalogById = new Map(
            state.catalog
                .map((game) => [Number(game?.universeId), game])
                .filter(([key]) => Number.isInteger(key))
        );
        state.catalogRevision += 1;
        state.viewCache.clear();
        state.searchTextCache = new WeakMap();

        if (state.gameOfDay) {
            const loadedFeatured = state.catalog.find(
                (game) =>
                    Number(game?.universeId) ===
                    Number(state.gameOfDay?.universeId)
            );

            if (loadedFeatured) {
                state.gameOfDay = loadedFeatured;
            }
        }

        return state.catalog;
    }

    function getFilteredGames() {
        const search = state.search.trim().toLowerCase();
        const cacheKey = `${state.catalogRevision}:${state.mode}`;
        let games = state.viewCache.get(cacheKey);

        if (!games) {
            const now = Date.now();

            if (state.mode === "updated") {
                games = state.catalog
                    .filter((game) => {
                        const updatedAt = getServerUpdatedTimestamp(game);
                        return (
                            updatedAt > 0 &&
                            now - updatedAt <= CONFIG.recentUpdateWindowMs
                        );
                    })
                    .sort(
                        (left, right) =>
                            getServerUpdatedTimestamp(right) -
                            getServerUpdatedTimestamp(left)
                    );
            } else if (state.mode === "all") {
                // Include every valid indexed game. Do not filter by the old
                // isPlayable flag because older database entries may have it
                // set to false simply because the API omitted that property.
                // IndexedDB already yields a stable universe-ID order, so no
                // expensive six-figure sort is needed here.
                games = state.catalog.filter(displayableIndexedGame);
            } else {
                games = state.catalog
                    .filter(
                        (game) =>
                            Number.isFinite(Number(game.visitCount)) &&
                            Number(game.visitCount) >= CONFIG.minVisits &&
                            Number(game.visitCount) <= CONFIG.maxVisits
                    )
                    .sort((left, right) => {
                        const visitDifference =
                            Number(left.visitCount) - Number(right.visitCount);

                        if (visitDifference !== 0) {
                            return visitDifference;
                        }

                        return String(left.name || "").localeCompare(
                            String(right.name || "")
                        );
                    });
            }

            state.viewCache.set(cacheKey, games);
        }

        if (!search) {
            return games;
        }

        return games.filter((game) => {
            let searchable = state.searchTextCache.get(game);

            if (!searchable) {
                searchable = [
                    game.name,
                    game.creatorName,
                    game.gameDescription,
                    game.genre,
                ]
                    .map((value) => String(value || "").toLowerCase())
                    .join("\n");
                state.searchTextCache.set(game, searchable);
            }

            return searchable.includes(search);
        });
    }

    function modeLabel() {
        if (state.mode === "updated") {
            return "Recently Updated";
        }

        if (state.mode === "all") {
            return "Every Game";
        }

        return "Hidden Gems";
    }

    function createBadge(className, text, title) {
        const badge = document.createElement("div");
        badge.className = className;
        badge.textContent = text;

        if (title) {
            badge.title = title;
        }

        return badge;
    }

    function createGameCard(template, game, featured = false) {
        const card = template.cloneNode(true);
        card.dataset.pekoraDiscoveryCard = String(game.universeId);
        card.classList.toggle(
            "pekora-discovery-game-of-day-card",
            Boolean(featured)
        );

        if (featured) {
            card.dataset.pekoraGameOfDay = "true";
        } else {
            delete card.dataset.pekoraGameOfDay;
        }

        card
            .querySelectorAll(
                ".pekora-discovery-visit-badge, " +
                    ".pekora-discovery-update-badge, " +
                    ".pekora-discovery-game-of-day-badge, " +
                    ".pekora-discovery-player-badge"
            )
            .forEach((element) => element.remove());

        const cardLink =
            findByClassPart(card, "gameCardLink-") ||
            card.querySelector('a[href*="/games/"]');

        if (cardLink) {
            cardLink.href = `/games/${encodeURIComponent(game.placeId)}/${slugify(
                game.name
            )}`;
        }

        const thumbContainer =
            findByClassPart(card, "gameCardThumbContainer-") ||
            card.querySelector("img")?.parentElement;
        const image = thumbContainer?.querySelector("img");

        if (image) {
            image.alt = String(game.name || "");
            image.loading = "lazy";

            if (game.thumbnailUrl) {
                image.src = game.thumbnailUrl;
                image.style.removeProperty("opacity");
            } else {
                image.removeAttribute("src");
                image.style.opacity = "0.15";
            }
        }

        if (thumbContainer) {
            if (featured) {
                thumbContainer.appendChild(
                    createBadge(
                        "pekora-discovery-game-of-day-badge",
                        "Game of the Day",
                        "Today’s featured game from the complete indexed catalog"
                    )
                );
                thumbContainer.appendChild(
                    createBadge(
                        "pekora-discovery-player-badge",
                        `${Number(game.playerCount || 0).toLocaleString()} playing`,
                        `${game.name}: ${Number(game.playerCount || 0).toLocaleString()} players online`
                    )
                );
            }

            if (Number.isFinite(Number(game.visitCount))) {
                thumbContainer.appendChild(
                    createBadge(
                        "pekora-discovery-visit-badge",
                        formatVisits(game.visitCount),
                        `${game.name}: ${Number(game.visitCount).toLocaleString()} total visits`
                    )
                );
            }

            const serverUpdatedAt = getServerUpdatedTimestamp(game);

            if (
                serverUpdatedAt > 0 &&
                Date.now() - serverUpdatedAt <= CONFIG.recentUpdateWindowMs
            ) {
                thumbContainer.appendChild(
                    createBadge(
                        "pekora-discovery-update-badge",
                        `Updated ${formatRelativeTime(serverUpdatedAt)}`,
                        game.updatedAt
                            ? `Pekora update timestamp: ${game.updatedAt}`
                            : "A visible game detail changed"
                    )
                );
            } else if (game.tracking?.isNewDiscovery) {
                thumbContainer.appendChild(
                    createBadge(
                        "pekora-discovery-update-badge pekora-discovery-new-badge",
                        "Newly found",
                        "This game appeared in a later catalog scan"
                    )
                );
            }
        }

        const title = findByClassPart(card, "gameCardTitle-");

        if (title) {
            title.textContent = String(game.name || "Untitled Game");
            title.title = `${game.name} — ${formatVisits(game.visitCount)}`;
        }

        const playerCount = findByClassPart(card, "playerCount-");

        if (playerCount) {
            playerCount.textContent = `${Number(
                game.playerCount || 0
            ).toLocaleString()} Playing`;
        }

        const year = findByClassPart(card, "yearText3-");

        if (year) {
            year.textContent = game.year == null ? "" : String(game.year);
        }

        const upVotes = Number(game.totalUpVotes || 0);
        const downVotes = Number(game.totalDownVotes || 0);
        const totalVotes = upVotes + downVotes;
        const votePercentage =
            totalVotes > 0 ? Math.round((upVotes / totalVotes) * 100) : 0;
        const voteBar = findByClassPart(card, "votePercentage-");

        if (voteBar) {
            voteBar.style.width = `${votePercentage}%`;
        }

        const upVoteCount = findByClassPart(card, "upvoteCount-");
        const downVoteCount = findByClassPart(card, "downvoteCount-");

        if (upVoteCount) {
            upVoteCount.textContent = upVotes.toLocaleString();
        }

        if (downVoteCount) {
            downVoteCount.textContent = downVotes.toLocaleString();
        }

        const creator = findByClassPart(card, "creatorText-");
        const creatorLink = creator?.querySelector("a");

        if (creator) {
            if (creatorLink) {
                creatorLink.textContent = String(game.creatorName || "Unknown");
                creatorLink.href = `/User.aspx?ID=${encodeURIComponent(
                    game.creatorId || 0
                )}`;
            } else {
                creator.textContent = `By ${game.creatorName || "Unknown"}`;
            }
        }

        return card;
    }

    function getPageSize(row) {
        const width = row.getBoundingClientRect().width || window.innerWidth;
        return Math.max(1, Math.floor(width / 170));
    }

    function setPagerEnabled(element, enabled) {
        if (!element) {
            return;
        }

        element.classList.toggle("opacity-25", !enabled);
        element.style.opacity = enabled ? "1" : "0.25";
        element.style.pointerEvents = enabled ? "auto" : "none";
        element.setAttribute("aria-disabled", String(!enabled));
    }

    function replaceWithCleanClone(element) {
        if (!element) {
            return null;
        }

        const clone = element.cloneNode(true);
        element.replaceWith(clone);
        return clone;
    }

    function emptyMessage() {
        if (state.loading) {
            return state.scanMessage || "Scanning Pekora’s game catalog…";
        }

        if (state.error) {
            return `Could not load games: ${state.error.message}`;
        }

        if (state.mode === "updated") {
            return "No indexed games have a Pekora update timestamp from the last 30 days. Run Full Scan to index the complete public ID range, then use Rescan to refresh timestamps.";
        }

        if (state.search) {
            return `No games matched “${state.search}”.`;
        }

        return state.mode === "hidden"
            ? "No games between 1,000 and 5,000 visits were found in the discovered catalog."
            : "No games were found.";
    }

    function updateHeaderSpacing(section, header) {
        requestAnimationFrame(() => {
            const carousel = findByClassPart(section, "uselessFuckingClass-");

            if (!carousel || !header) {
                return;
            }

            const requiredMargin = Math.max(43, Math.ceil(header.offsetHeight + 23));
            carousel.style.marginTop = `${requiredMargin}px`;
        });
    }

    function renderCurrentSection() {
        const section = findSection();

        if (!section) {
            queuePatch(true);
            return;
        }

        const row = findByClassPart(section, "gameRow-");
        const heading = section.querySelector("h3");
        const header = heading?.parentElement;
        const toolbar = header?.querySelector(".pekora-discovery-toolbar");
        const template = state.cardTemplate?.cloneNode(true);

        if (!row || !header || !toolbar || !template) {
            queuePatch(true);
            return;
        }

        renderSection(section, template, {
            row,
            backButton: findByClassPart(section, "goBack-"),
            forwardButton: findByClassPart(section, "goForward-"),
            seeAllButton:
                findByClassPart(header, "seeAllButton-") ||
                header.querySelector("button"),
            toolbar,
            header,
        });
    }

    function createToolbar(section, header) {
        header.querySelector(".pekora-discovery-toolbar")?.remove();

        const toolbar = document.createElement("div");
        toolbar.className = "pekora-discovery-toolbar";
        toolbar.innerHTML = `
            <select class="pekora-discovery-mode" aria-label="Discovery view">
                <option value="all">Every Game</option>
                <option value="updated">Recently Updated</option>
                <option value="hidden">1K–5K Visits</option>
            </select>
            <input class="pekora-discovery-search" type="search" placeholder="Search games" aria-label="Search discovered games">
            <button class="pekora-discovery-rescan" type="button" title="Refresh the site lists without loading the complete local index">Rescan</button>
            <button class="pekora-discovery-deep-scan" type="button" title="Search additional lists and keywords.">Deep Scan</button>
            <button class="pekora-discovery-full-scan" type="button" title="Scan numeric Place IDs, save progress, and build a near-complete public-game index.">Full Scan</button>
            <button class="pekora-discovery-alerts" type="button" title="Notify you when new game IDs are ready to scan">Alerts: On</button>
            <button class="pekora-discovery-load-more" type="button" title="Render another batch of games" hidden>Load More</button>
            <span class="pekora-discovery-count"></span>
        `;

        const trailingContainer = header.lastElementChild;
        header.insertBefore(toolbar, trailingContainer || null);
        header.style.flexWrap = "wrap";
        header.style.gap = "7px";

        const modeSelect = toolbar.querySelector(".pekora-discovery-mode");
        const searchInput = toolbar.querySelector(".pekora-discovery-search");
        const rescanButton = toolbar.querySelector(".pekora-discovery-rescan");
        const deepScanButton = toolbar.querySelector(".pekora-discovery-deep-scan");
        const fullScanButton = toolbar.querySelector(".pekora-discovery-full-scan");
        const alertsButton = toolbar.querySelector(".pekora-discovery-alerts");
        const loadMoreButton = toolbar.querySelector(".pekora-discovery-load-more");

        modeSelect.value = state.mode;
        searchInput.value = state.search;

        modeSelect.addEventListener("change", () => {
            state.mode = modeSelect.value;
            state.currentPage = 0;
            state.expanded = false;
            state.expandedLimit = CONFIG.expandedInitialLimit;
            queuePatch(true);
        });

        let searchTimer = null;
        searchInput.addEventListener("input", () => {
            // Save the text immediately, but do not rebuild the toolbar.
            // Replacing the input element was what caused focus to disappear
            // after every typed character.
            state.search = searchInput.value;
            state.currentPage = 0;

            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                renderCurrentSection();
            }, CONFIG.searchDebounceMs);
        });

        rescanButton.addEventListener("click", () => refreshCatalog(false, false));
        deepScanButton.addEventListener("click", () => refreshCatalog(true));
        fullScanButton.addEventListener("click", () => {
            if (state.fullScanning) {
                state.fullScanStopRequested = true;
                state.scanMessage = "Pausing after the current ID batch…";
                queuePatch(true);
                return;
            }

            runFullCatalogScan();
        });

        alertsButton.addEventListener("click", () => {
            const enabled = setScanAlertsEnabled(!scanAlertsEnabled());
            alertsButton.textContent = enabled ? "Alerts: On" : "Alerts: Off";
            alertsButton.title = enabled
                ? "Notifications are enabled for newly detected game IDs"
                : "Notifications are disabled";

            if (enabled) {
                detectNewScanRange(state.catalog, true);
            }
        });

        loadMoreButton.addEventListener("click", async () => {
            if (
                state.mode === "all" &&
                !state.search.trim() &&
                state.expandedLimit >= state.visibleGames.length - 25 &&
                !state.indexedLoadComplete
            ) {
                loadMoreButton.disabled = true;
                loadMoreButton.textContent = "Loading…";
                await loadMoreIndexedGames();
            }

            state.expandedLimit += CONFIG.expandedBatchSize;
            renderCurrentSection();
        });

        alertsButton.textContent = scanAlertsEnabled()
            ? "Alerts: On"
            : "Alerts: Off";
        rescanButton.disabled = state.loading;
        deepScanButton.disabled = state.loading;
        fullScanButton.disabled = state.loading && !state.fullScanning;
        updateHeaderSpacing(section, header);
        return toolbar;
    }

    function renderSection(section, template, controls) {
        const {
            row,
            backButton,
            forwardButton,
            seeAllButton,
            toolbar,
            header,
        } = controls;

        if (!row || !template) {
            return;
        }

        state.visibleGames = getFilteredGames();
        const pageSize = getPageSize(row);
        const displayInfo = displayGameInfo();
        const pageCount = displayPageCount(pageSize, displayInfo);
        state.currentPage = Math.min(state.currentPage, pageCount - 1);

        let visiblePage;

        if (state.expanded) {
            visiblePage = displayInfo.featured
                ? [
                      displayInfo.featured,
                      ...displayInfo.games.slice(
                          0,
                          Math.max(0, state.expandedLimit - 1)
                      ),
                  ]
                : displayInfo.games.slice(0, state.expandedLimit);
        } else if (displayInfo.featured) {
            if (state.currentPage === 0) {
                visiblePage = [
                    displayInfo.featured,
                    ...displayInfo.games.slice(0, Math.max(0, pageSize - 1)),
                ];
            } else {
                const start =
                    Math.max(0, pageSize - 1) +
                    (state.currentPage - 1) * pageSize;
                visiblePage = displayInfo.games.slice(
                    start,
                    start + pageSize
                );
            }
        } else {
            visiblePage = displayInfo.games.slice(
                state.currentPage * pageSize,
                (state.currentPage + 1) * pageSize
            );
        }

        if (visiblePage.length > 0) {
            const fragment = document.createDocumentFragment();

            for (const game of visiblePage) {
                fragment.appendChild(
                    createGameCard(template, game, isGameOfDay(game))
                );
            }

            row.replaceChildren(fragment);
            scheduleVisibleThumbnailLoad(visiblePage);
            scheduleVisiblePlayerCountRefresh(visiblePage);
        } else {
            const message = document.createElement("div");
            message.className = "pekora-discovery-message";
            message.textContent = emptyMessage();
            row.replaceChildren(message);
        }

        if (state.expanded) {
            row.style.setProperty("width", "100%", "important");
            row.style.flexWrap = "wrap";
            row.style.overflow = "visible";

            if (backButton) {
                backButton.style.display = "none";
            }

            if (forwardButton) {
                forwardButton.style.display = "none";
            }
        } else {
            row.style.removeProperty("width");
            row.style.removeProperty("flex-wrap");
            row.style.removeProperty("overflow");

            if (backButton) {
                backButton.style.removeProperty("display");
            }

            if (forwardButton) {
                forwardButton.style.removeProperty("display");
            }

            setPagerEnabled(backButton, state.currentPage > 0);
            setPagerEnabled(
                forwardButton,
                state.currentPage < pageCount - 1
            );
        }

        const fullModeTotal =
            state.mode === "all" && !state.search.trim()
                ? Math.max(displayInfo.totalCount, state.indexedTotalCount)
                : displayInfo.totalCount;

        if (seeAllButton) {
            seeAllButton.textContent = state.expanded ? "Collapse" : "See All";
            seeAllButton.title = `${fullModeTotal.toLocaleString()} games in ${modeLabel()}`;
            seeAllButton.disabled = fullModeTotal === 0;
        }

        const count = toolbar?.querySelector(".pekora-discovery-count");
        const rescanButton = toolbar?.querySelector(".pekora-discovery-rescan");
        const deepScanButton = toolbar?.querySelector(".pekora-discovery-deep-scan");
        const fullScanButton = toolbar?.querySelector(".pekora-discovery-full-scan");
        const alertsButton = toolbar?.querySelector(".pekora-discovery-alerts");
        const loadMoreButton = toolbar?.querySelector(".pekora-discovery-load-more");

        if (count) {
            if (state.loading) {
                count.textContent = state.scanMessage || "Scanning…";
            } else if (state.expanded && visiblePage.length < displayInfo.totalCount) {
                count.textContent =
                    `${visiblePage.length.toLocaleString()} rendered · ` +
                    `${displayInfo.totalCount.toLocaleString()} matching · ` +
                    `${state.catalog.length.toLocaleString()} indexed`;
            } else if (state.mode === "all" && !state.search.trim()) {
                count.textContent =
                    `${displayInfo.totalCount.toLocaleString()} loaded · ` +
                    `${Math.max(state.indexedTotalCount, displayInfo.totalCount).toLocaleString()} indexed`;
            } else {
                count.textContent =
                    `${displayInfo.totalCount.toLocaleString()} shown · ` +
                    `${Math.max(state.indexedTotalCount, state.catalog.length).toLocaleString()} indexed`;
            }
        }

        if (rescanButton) {
            rescanButton.disabled = state.loading;
        }

        if (deepScanButton) {
            deepScanButton.disabled = state.loading;
            deepScanButton.textContent = state.deepScanning ? "Scanning…" : "Deep Scan";
        }

        if (fullScanButton) {
            const progress = state.fullScanProgress || readFullScanProgress();
            fullScanButton.disabled = state.loading && !state.fullScanning;

            if (state.fullScanning) {
                fullScanButton.textContent = state.fullScanStopRequested
                    ? "Pausing…"
                    : "Pause Scan";
            } else if (progress?.paused && !progress.complete) {
                fullScanButton.textContent = "Resume Full Scan";
            } else if (progress?.complete) {
                fullScanButton.textContent = state.newScanAvailable
                    ? "Scan New Games"
                    : "Scan New IDs";
                fullScanButton.title = state.newScanAvailable
                    ? `New game IDs were detected up to Place ID ${state.newScanHighestPlaceId.toLocaleString()}`
                    : "Check the ID range after the most recently indexed game";
            } else {
                fullScanButton.textContent = "Full Scan";
            }
        }

        if (alertsButton) {
            alertsButton.textContent = scanAlertsEnabled()
                ? "Alerts: On"
                : "Alerts: Off";
            alertsButton.classList.toggle(
                "pekora-discovery-alerts-active",
                state.newScanAvailable
            );
            alertsButton.title = state.newScanAvailable
                ? "New game IDs are ready to scan"
                : scanAlertsEnabled()
                  ? "Notifications are enabled"
                  : "Notifications are disabled";
        }

        if (loadMoreButton) {
            const loadedRemaining = Math.max(
                0,
                displayInfo.totalCount - visiblePage.length
            );
            const moreIndexedGames = Boolean(
                state.mode === "all" &&
                !state.search.trim() &&
                !state.indexedLoadComplete
            );
            const remaining = moreIndexedGames
                ? Math.max(
                      loadedRemaining,
                      state.indexedTotalCount - visiblePage.length
                  )
                : loadedRemaining;

            loadMoreButton.hidden = !state.expanded || remaining === 0;
            loadMoreButton.disabled = state.indexedLoading || remaining === 0;
            loadMoreButton.textContent = state.indexedLoading
                ? "Loading…"
                : remaining > 0
                  ? `Load ${Math.min(CONFIG.expandedBatchSize, remaining)} More`
                  : "All Loaded";
        }

        requestAnimationFrame(() => {
            const cardHeight =
                row.firstElementChild?.getBoundingClientRect().height || 249;
            const height = `${Math.max(180, Math.round(cardHeight))}px`;

            if (backButton && !state.expanded) {
                backButton.style.height = height;
            }

            if (forwardButton && !state.expanded) {
                forwardButton.style.height = height;
            }
        });

        section.dataset.pekoraDiscoveryRendered = "true";
    }

    function patchSection() {
        if (
            state.patching ||
            !state.loaded ||
            !location.pathname.startsWith("/games")
        ) {
            return;
        }

        const section = findSection();

        if (!section) {
            return;
        }

        const row = findByClassPart(section, "gameRow-");
        const heading = section.querySelector("h3");
        const header = heading?.parentElement;
        const isIntact = Boolean(
            section.dataset.pekoraDiscoveryRendered === "true" &&
                discoveryHeadingMatches(heading) &&
                header?.querySelector(".pekora-discovery-toolbar") &&
                (row?.querySelector("[data-pekora-discovery-card]") ||
                    row?.querySelector(".pekora-discovery-message"))
        );

        if (isIntact && !state.forcePatch) {
            return;
        }

        state.forcePatch = false;

        if (!row || !heading || !header) {
            return;
        }

        const liveTemplate = row.querySelector("li")?.cloneNode(true) || null;

        if (
            liveTemplate &&
            !liveTemplate.hasAttribute("data-pekora-discovery-card")
        ) {
            state.cardTemplate = liveTemplate.cloneNode(true);
        } else if (!state.cardTemplate && liveTemplate) {
            state.cardTemplate = liveTemplate.cloneNode(true);
        }

        const originalTemplate = state.cardTemplate?.cloneNode(true) || null;

        if (!originalTemplate) {
            return;
        }

        state.patching = true;

        try {
            section.dataset.pekoraDiscoverySection = "true";
            renderDiscoveryHeading(heading);
            heading.title = state.loading
                ? state.scanMessage
                : `${state.catalog.length.toLocaleString()} unique games indexed`;

            const backButton = replaceWithCleanClone(
                findByClassPart(section, "goBack-")
            );
            const forwardButton = replaceWithCleanClone(
                findByClassPart(section, "goForward-")
            );
            const oldSeeAllButton =
                findByClassPart(header, "seeAllButton-") ||
                header.querySelector("button");
            const oldSeeAllLink = oldSeeAllButton?.closest("a");
            const seeAllLink = replaceWithCleanClone(oldSeeAllLink);
            const seeAllButton = seeAllLink?.querySelector("button") || null;
            const toolbar = createToolbar(section, header);

            if (seeAllLink) {
                seeAllLink.removeAttribute("href");
                seeAllLink.style.cursor = "pointer";
                seeAllLink.addEventListener(
                    "click",
                    (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        state.expanded = !state.expanded;
                        state.expandedLimit = CONFIG.expandedInitialLimit;
                        renderSection(section, originalTemplate, {
                            row,
                            backButton,
                            forwardButton,
                            seeAllButton,
                            toolbar,
                            header,
                        });
                    },
                    true
                );
            }

            backButton?.addEventListener(
                "click",
                (event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (state.currentPage > 0) {
                        state.currentPage -= 1;
                        renderSection(section, originalTemplate, {
                            row,
                            backButton,
                            forwardButton,
                            seeAllButton,
                            toolbar,
                            header,
                        });
                    }
                },
                true
            );

            forwardButton?.addEventListener(
                "click",
                async (event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    const pageSize = getPageSize(row);
                    let lastPage = Math.max(
                        0,
                        Math.ceil(state.visibleGames.length / pageSize) - 1
                    );

                    if (
                        state.currentPage >= lastPage &&
                        state.mode === "all" &&
                        !state.search.trim() &&
                        !state.indexedLoadComplete
                    ) {
                        await loadMoreIndexedGames();
                        state.visibleGames = getFilteredGames();
                        lastPage = Math.max(
                            0,
                            Math.ceil(state.visibleGames.length / pageSize) - 1
                        );
                    }

                    if (state.currentPage < lastPage) {
                        state.currentPage += 1;
                        renderSection(section, originalTemplate, {
                            row,
                            backButton,
                            forwardButton,
                            seeAllButton,
                            toolbar,
                            header,
                        });
                    }
                },
                true
            );

            renderSection(section, originalTemplate, {
                row,
                backButton,
                forwardButton,
                seeAllButton,
                toolbar,
                header,
            });
        } finally {
            state.patching = false;
        }
    }

    function injectStyles() {
        if (document.getElementById("pekora-discovery-style")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "pekora-discovery-style";
        style.textContent = `
            .pekora-discovery-heading {
                display: inline-flex !important;
                align-items: center !important;
                gap: 10px !important;
                min-width: max-content;
                white-space: nowrap;
            }

            .pekora-discovery-heading-text {
                display: inline-block;
            }

            .pekora-discovery-heading-new-badge {
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                height: 34px;
                min-width: 58px;
                padding: 0 13px;
                box-sizing: border-box;
                color: #fff !important;
                background:
                    linear-gradient(
                        135deg,
                        #ff5ecb 0%,
                        #c54de5 48%,
                        #7658ff 100%
                    ) !important;
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 5px;
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.24),
                    0 2px 8px rgba(126, 76, 255, 0.38);
                font-family: "Source Sans Pro", Arial, sans-serif;
                font-size: 18px;
                font-weight: 700;
                line-height: 1;
                letter-spacing: 0.2px;
                text-shadow: 0 1px 1px rgba(0, 0, 0, 0.28);
                user-select: none;
                pointer-events: none;
                flex: 0 0 auto;
            }

            .pekora-discovery-toolbar {
                display: flex;
                align-items: center;
                gap: 5px;
                min-width: 0;
                font-family: "Source Sans Pro", Arial, sans-serif;
                font-weight: 400;
            }

            .pekora-discovery-toolbar select,
            .pekora-discovery-toolbar input,
            .pekora-discovery-toolbar button {
                height: 29px;
                border: 1px solid var(--text-color-quinary);
                border-radius: 3px;
                color: var(--text-color-primary);
                background: var(--white-color);
                font: inherit;
                font-size: 13px;
            }

            .pekora-discovery-toolbar select {
                width: 132px;
                padding: 2px 5px;
            }

            .pekora-discovery-toolbar input {
                width: 135px;
                padding: 3px 7px;
            }

            .pekora-discovery-toolbar button {
                padding: 3px 8px;
                cursor: pointer;
            }

            .pekora-discovery-toolbar button:hover:not(:disabled) {
                border-color: var(--primary-color);
                background: var(--white-color-hover);
            }

            .pekora-discovery-toolbar button:disabled {
                cursor: wait;
                opacity: 0.55;
            }

            .pekora-discovery-alerts-active {
                color: #fff !important;
                border-color: #02b757 !important;
                background: #087438 !important;
                box-shadow: 0 0 0 2px rgba(2, 183, 87, 0.16) !important;
            }

            .pekora-discovery-count {
                max-width: 250px;
                overflow: hidden;
                color: var(--text-color-tertiary);
                font-size: 12px;
                font-weight: 400;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .pekora-discovery-visit-badge,
            .pekora-discovery-update-badge,
            .pekora-discovery-game-of-day-badge,
            .pekora-discovery-player-badge {
                position: absolute !important;
                z-index: 3 !important;
                display: block !important;
                padding: 3px 6px !important;
                color: #fff !important;
                background: rgba(0, 0, 0, 0.8) !important;
                border-radius: 3px !important;
                font-family: "Source Sans Pro", Arial, sans-serif !important;
                font-size: 11px !important;
                font-weight: 600 !important;
                line-height: 1.2 !important;
                pointer-events: none !important;
            }

            .pekora-discovery-visit-badge {
                left: 6px !important;
                bottom: 6px !important;
            }

            .pekora-discovery-update-badge {
                top: 6px !important;
                right: 6px !important;
                max-width: calc(100% - 12px);
                overflow: hidden;
                background: rgba(245, 77, 77, 0.92) !important;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .pekora-discovery-new-badge {
                background: rgba(2, 183, 87, 0.92) !important;
            }

            .pekora-discovery-game-of-day-card {
                position: relative !important;
                z-index: 4 !important;
            }

            html body .pekora-discovery-game-of-day-card > [class*="gameCardContainer-"],
            html body .pekora-discovery-game-of-day-card[class*="gameCardContainer-"] {
                border: 2px solid #e1b536 !important;
                background:
                    linear-gradient(
                        180deg,
                        rgba(94, 68, 10, 0.34) 0%,
                        rgba(24, 20, 10, 0.96) 100%
                    ) !important;
                box-shadow:
                    0 0 0 1px rgba(255, 227, 130, 0.35),
                    0 0 18px rgba(225, 181, 54, 0.48),
                    0 8px 20px rgba(0, 0, 0, 0.42) !important;
            }

            html body .pekora-discovery-game-of-day-card:hover > [class*="gameCardContainer-"],
            html body .pekora-discovery-game-of-day-card[class*="gameCardContainer-"]:hover {
                border-color: #ffe28a !important;
                box-shadow:
                    0 0 0 1px rgba(255, 240, 180, 0.52),
                    0 0 25px rgba(237, 193, 63, 0.68),
                    0 10px 25px rgba(0, 0, 0, 0.5) !important;
            }

            .pekora-discovery-game-of-day-badge {
                top: 6px !important;
                left: 6px !important;
                max-width: calc(100% - 12px);
                color: #211600 !important;
                background:
                    linear-gradient(135deg, #fff0a8 0%, #e3b633 55%, #b87b08 100%) !important;
                border: 1px solid rgba(255, 245, 190, 0.9) !important;
                box-shadow:
                    inset 0 1px 0 rgba(255, 255, 255, 0.65),
                    0 2px 8px rgba(0, 0, 0, 0.45) !important;
                text-transform: uppercase;
                letter-spacing: 0.35px;
                text-shadow: 0 1px 0 rgba(255, 255, 255, 0.35);
            }

            .pekora-discovery-player-badge {
                right: 6px !important;
                bottom: 6px !important;
                color: #fff6cc !important;
                background: rgba(45, 31, 3, 0.9) !important;
                border: 1px solid rgba(226, 183, 54, 0.72) !important;
            }

            .pekora-discovery-game-of-day-card .pekora-discovery-update-badge {
                top: 31px !important;
            }

            .pekora-discovery-game-of-day-card [class*="gameCardTitle-"] {
                color: #ffe7a0 !important;
                font-weight: 700 !important;
            }

            .pekora-discovery-message {
                width: 100%;
                min-height: 180px;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 24px;
                color: var(--text-color-tertiary);
                text-align: center;
            }

            @media (max-width: 1100px) {
                .pekora-discovery-count {
                    display: none;
                }
            }

            @media (max-width: 767px) {
                .pekora-discovery-heading {
                    gap: 7px !important;
                }

                .pekora-discovery-heading-new-badge {
                    height: 29px;
                    min-width: 49px;
                    padding: 0 10px;
                    font-size: 15px;
                }

                .pekora-discovery-toolbar {
                    width: 100%;
                    flex-wrap: wrap;
                    order: 3;
                }

                .pekora-discovery-toolbar select,
                .pekora-discovery-toolbar input {
                    flex: 1 1 125px;
                    width: auto;
                }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function updateLiveScanUi() {
        requestAnimationFrame(() => {
            const section = document.querySelector(
                '[data-pekora-discovery-section="true"]'
            );

            if (!section) {
                return;
            }

            const toolbar = section.querySelector(".pekora-discovery-toolbar");
            const count = toolbar?.querySelector(".pekora-discovery-count");
            const fullScanButton = toolbar?.querySelector(
                ".pekora-discovery-full-scan"
            );
            const heading = section.querySelector("h3");

            if (count) {
                count.textContent = state.scanMessage || "Scanning…";
            }

            if (fullScanButton && state.fullScanning) {
                fullScanButton.disabled = false;
                fullScanButton.textContent = state.fullScanStopRequested
                    ? "Pausing…"
                    : "Pause Scan";
            }

            if (heading) {
                heading.title = state.scanMessage || "Scanning…";
            }
        });
    }

    function queuePatch(force = false) {
        if (force) {
            state.forcePatch = true;
        }

        if (state.patchQueued) {
            return;
        }

        state.patchQueued = true;

        requestAnimationFrame(() => {
            state.patchQueued = false;
            patchSection();
        });
    }

    function isDiscoveryMounted() {
        const section = document.querySelector(
            '[data-pekora-discovery-section="true"]'
        );
        const heading = section?.querySelector("h3");
        const toolbar = section?.querySelector(".pekora-discovery-toolbar");
        const row = section ? findByClassPart(section, "gameRow-") : null;

        return Boolean(
            section?.isConnected &&
            discoveryHeadingMatches(heading) &&
            toolbar &&
            (row?.querySelector("[data-pekora-discovery-card]") ||
                row?.querySelector(".pekora-discovery-message"))
        );
    }

    function scheduleMountRecovery(reset = false) {
        if (reset && state.mountRetryTimer) {
            clearTimeout(state.mountRetryTimer);
            state.mountRetryTimer = null;
        }

        if (
            state.mountRetryTimer ||
            !state.loaded ||
            !location.pathname.startsWith("/games")
        ) {
            return;
        }

        const startedAt = Date.now();

        const attempt = () => {
            state.mountRetryTimer = null;

            if (!location.pathname.startsWith("/games")) {
                return;
            }

            if (!isDiscoveryMounted()) {
                queuePatch(true);
            }

            if (
                !isDiscoveryMounted() &&
                Date.now() - startedAt < CONFIG.mountRetryMaxMs
            ) {
                state.mountRetryTimer = setTimeout(
                    attempt,
                    CONFIG.mountRetryIntervalMs
                );
            }
        };

        attempt();
    }

    function scheduleBackgroundRefresh(cache) {
        if (state.startupRefreshTimer) {
            clearTimeout(state.startupRefreshTimer);
        }

        const delay = cache ? CONFIG.startupRefreshDelayMs : 1_500;

        state.startupRefreshTimer = setTimeout(async () => {
            state.startupRefreshTimer = null;

            if (
                !location.pathname.startsWith("/games") ||
                state.loading ||
                state.fullScanning
            ) {
                return;
            }

            // A stale cache is still immediately usable. Refresh only the
            // lightweight main sorts in the background after the page settles.
            await waitForIdle(2_000);
            await refreshCatalog(false, false);
        }, delay);
    }

    async function refreshCatalog(deepScan, refreshIndexed = false) {
        if (state.loading || state.fullScanning) {
            return;
        }

        state.loading = true;
        state.deepScanning = Boolean(deepScan);
        state.error = null;
        state.scanMessage = deepScan
            ? "Starting deep scan…"
            : "Checking for updates…";
        queuePatch(true);

        try {
            setCatalog(
                await scanCatalog({ deepScan, refreshIndexed })
            );
            await initializeGameOfDay({ force: true });
            state.scanMessage = deepScan
                ? `Deep scan complete: ${state.catalog.length.toLocaleString()} games discovered.`
                : `Scan complete: ${state.catalog.length.toLocaleString()} games discovered.`;
        } catch (error) {
            console.error("[Pekora Discovery]", error);
            state.error = error instanceof Error ? error : new Error(String(error));
        } finally {
            state.loading = false;
            state.deepScanning = false;
            state.loaded = true;
            state.currentPage = 0;
            queuePatch(true);
            scheduleMountRecovery(true);
        }
    }

    async function start() {
        if (state.started) {
            scheduleMountRecovery(true);
            return;
        }

        state.started = true;
        injectStyles();
        state.tracker = loadTracker();
        state.fullScanProgress = readFullScanProgress();

        const cache = readCatalogCache();
        const cachedGames = Array.isArray(cache?.games) ? cache.games : [];

        // Render cached/list data immediately. Do not wait for a potentially
        // large IndexedDB getAll() before mounting the replacement row.
        setCatalog(
            cachedGames.length
                ? annotateTracking(cachedGames, state.tracker)
                : []
        );
        state.loaded = true;
        state.loading = state.catalog.length === 0;
        state.scanMessage = state.loading
            ? "Loading saved game index…"
            : "";
        detectNewScanRange(state.catalog, false);
        queuePatch(true);
        scheduleMountRecovery(true);

        await waitForIdle(700);

        try {
            state.indexedTotalCount = await databaseCountGames();
            resetIndexedLoader();
            await loadMoreIndexedGames(CONFIG.indexedInitialLoadLimit, {
                render: false,
            });
            await initializeGameOfDay();
            detectNewScanRange(state.catalog, false);
        } catch (error) {
            console.warn("[Pekora Discovery] Could not load the saved game index:", error);
            state.indexedCatalogLoaded = true;
        } finally {
            state.loading = false;
            queuePatch(true);
            scheduleMountRecovery(true);
            startMountWatchdog();
        }

        if (!cache || !cache.isFresh) {
            scheduleBackgroundRefresh(cache);
        }
    }

    function startMountWatchdog() {
        if (state.mountWatchdogTimer) {
            return;
        }

        state.mountWatchdogTimer = setInterval(() => {
            if (
                document.visibilityState !== "visible" ||
                !location.pathname.startsWith("/games") ||
                !state.loaded
            ) {
                return;
            }

            if (!isDiscoveryMounted()) {
                queuePatch(true);
                scheduleMountRecovery(true);
            }
        }, CONFIG.mountWatchdogMs);
    }

    function patchHistoryNavigation() {
        for (const methodName of ["pushState", "replaceState"]) {
            const original = history[methodName];

            if (typeof original !== "function" || original.__pekoraDiscoveryPatched) {
                continue;
            }

            const wrapped = function (...args) {
                const result = original.apply(this, args);
                setTimeout(() => {
                    queuePatch(true);
                    scheduleMountRecovery(true);
                    startMountWatchdog();
                }, 0);
                return result;
            };

            Object.defineProperty(wrapped, "__pekoraDiscoveryPatched", {
                value: true,
            });
            history[methodName] = wrapped;
        }
    }

    patchHistoryNavigation();
    startMountWatchdog();

    const observer = new MutationObserver(() => {
        if (
            state.patching ||
            !state.loaded ||
            !location.pathname.startsWith("/games") ||
            state.observerTimer ||
            isDiscoveryMounted()
        ) {
            return;
        }

        state.observerTimer = setTimeout(() => {
            state.observerTimer = null;

            if (!isDiscoveryMounted()) {
                queuePatch(true);
                scheduleMountRecovery();
            }
        }, CONFIG.observerDebounceMs);
    });

    const observerRoot = document.documentElement;
    observer.observe(observerRoot, {
        childList: true,
        subtree: true,
    });

    window.addEventListener("resize", () => {
        clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
            if (!state.expanded) {
                state.currentPage = 0;
            }

            queuePatch(true);
        }, 250);
    });

    window.addEventListener("pageshow", () => {
        queuePatch(true);
        scheduleMountRecovery(true);
        startMountWatchdog();
    });

    window.addEventListener("popstate", () => {
        queuePatch(true);
        scheduleMountRecovery(true);
        startMountWatchdog();
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            queuePatch(true);
            scheduleMountRecovery(true);
            startMountWatchdog();
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();