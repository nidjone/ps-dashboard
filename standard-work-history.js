// ============================================================
// Standard Work History Store — AM Standard Work Dashboard
// Rolling shift snapshot log: creation, rolling window, date-range queries
// ============================================================

const StandardWorkHistory = (() => {
    "use strict";

    // --- Private State ---
    // Module-level array of snapshots, always kept sorted ascending by `date`.
    let snapshots = [];
    let serverAvailable = false;

    const STORAGE_KEY = "sw_history";
    const MAX_SNAPSHOTS = 90;

    // --- Sorting Helper ---
    /**
     * Sorts the in-memory snapshots array ascending by ISO date string.
     */
    function sortSnapshots() {
        snapshots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }

    // --- Rolling Window Enforcement ---
    /**
     * Trims the snapshots array down to the most recent MAX_SNAPSHOTS entries
     * (by date), evicting the oldest ones first (Requirement 8.2).
     */
    function enforceRollingWindow() {
        if (snapshots.length > MAX_SNAPSHOTS) {
            sortSnapshots();
            snapshots = snapshots.slice(snapshots.length - MAX_SNAPSHOTS);
        }
    }

    // --- Server Detection ---
    /**
     * Checks if the server's standard-work history API is reachable.
     * @returns {Promise<boolean>} Whether the server is available
     */
    async function checkServer() {
        try {
            const resp = await fetch("/api/standard-work/history", {
                method: "GET",
                signal: AbortSignal.timeout(2000),
            });
            serverAvailable = !!resp.ok;
        } catch (e) {
            serverAvailable = false;
        }
        return serverAvailable;
    }

    // --- Persistence: Save to localStorage ---
    /**
     * Persists the current snapshots array to localStorage.
     */
    function saveToLocalStorage() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
        } catch (e) {
            console.warn("[StandardWorkHistory] Failed to save to localStorage:", e.message);
        }
    }

    // --- Persistence: Sync to Server (fire-and-forget) ---
    /**
     * Pushes the current snapshots array to the server via
     * POST /api/standard-work/history. Fire-and-forget: failures are logged
     * but never thrown, matching the dual-write pattern used in
     * StandardWorkState.saveState()/syncToServer().
     * @returns {Promise<{success: boolean, reason?: string}>}
     */
    async function syncToServer() {
        if (!serverAvailable) {
            return { success: false, reason: "offline" };
        }
        try {
            const resp = await fetch("/api/standard-work/history", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(snapshots),
            });
            if (!resp.ok) {
                throw new Error(`Server responded with status ${resp.status}`);
            }
            return { success: true };
        } catch (e) {
            console.warn("[StandardWorkHistory] Server sync failed:", e.message);
            return { success: false, reason: e.message };
        }
    }

    // --- Persistence: Save (localStorage always, server best-effort) ---
    /**
     * Persists the snapshots array: always to localStorage, and
     * fire-and-forget to the server when available.
     */
    function persist() {
        saveToLocalStorage();
        if (serverAvailable) {
            syncToServer().catch((e) => {
                console.warn("[StandardWorkHistory] Unexpected error during server sync:", e.message);
            });
        }
    }

    // --- Save Shift Snapshot ---
    /**
     * Creates/stores a shift snapshot, keyed/deduplicated by date. If a
     * snapshot already exists for the given date, it is replaced (so
     * repeated calls for the same day do not create duplicates). Enforces
     * the 90-snapshot rolling window (evicting the oldest) after insertion.
     *
     * Requirements: 8.1, 8.2, 1.7
     *
     * @param {string} date - ISO date string (e.g. "2026-07-28")
     * @param {Object} shiftData - HistorySnapshot-shaped data (as produced by
     *   StandardWorkState.buildSnapshot()): { date, shift, weeklyObjectives,
     *   completionRate, tasks, carryoverItems }
     * @returns {Object} The stored snapshot
     */
    function saveShiftSnapshot(date, shiftData) {
        const snapshot = Object.assign({}, shiftData, { date });

        const existingIndex = snapshots.findIndex((s) => s.date === date);
        if (existingIndex !== -1) {
            snapshots[existingIndex] = snapshot;
        } else {
            snapshots.push(snapshot);
        }

        sortSnapshots();
        enforceRollingWindow();
        persist();

        return snapshot;
    }

    // --- Get Snapshot by Date ---
    /**
     * Returns the snapshot for the given date, or null if none exists.
     * @param {string} date - ISO date string
     * @returns {Object|null}
     */
    function getSnapshot(date) {
        const found = snapshots.find((s) => s.date === date);
        return found || null;
    }

    // --- Get Range ---
    /**
     * Returns all snapshots within the given date range (inclusive), sorted
     * ascending by date.
     *
     * @param {string} startDate - ISO date string (inclusive lower bound)
     * @param {string} endDate - ISO date string (inclusive upper bound)
     * @returns {Object[]}
     */
    function getRange(startDate, endDate) {
        return snapshots
            .filter((s) => s.date >= startDate && s.date <= endDate)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }

    // --- Get Summary ---
    /**
     * Returns a summary of the stored history: total snapshot count, and
     * the earliest/latest snapshot dates (or null if empty).
     * @returns {{totalDays: number, firstDate: string|null, lastDate: string|null}}
     */
    function getSummary() {
        if (snapshots.length === 0) {
            return { totalDays: 0, firstDate: null, lastDate: null };
        }
        sortSnapshots();
        return {
            totalDays: snapshots.length,
            firstDate: snapshots[0].date,
            lastDate: snapshots[snapshots.length - 1].date,
        };
    }

    // --- Export / Import ---
    /**
     * Produces a JSON string representing all stored snapshots.
     * @returns {string}
     */
    function exportJSON() {
        return JSON.stringify(snapshots);
    }

    /**
     * Produces a JSON string of all stored snapshots (via exportJSON) and,
     * when running in a browser-like environment, triggers a client-side
     * file download of that JSON via a temporary `<a download>` element
     * (Requirement 8.4). In non-DOM environments (e.g. Node test runner),
     * the download step is skipped and the JSON string is simply returned.
     *
     * @param {string} [filename] - Desired download filename. Defaults to
     *   `standard-work-history-<today's ISO date>.json`.
     * @returns {string} The exported JSON string.
     */
    function downloadExport(filename) {
        const json = exportJSON();

        if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
            // No DOM available (e.g. Node test environment) — nothing to
            // trigger a download with, just return the JSON string.
            return json;
        }

        const name = filename || `standard-work-history-${new Date().toISOString().slice(0, 10)}.json`;

        try {
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.warn("[StandardWorkHistory] downloadExport failed to trigger download:", e.message);
        }

        return json;
    }

    /**
     * Parses and stores snapshots from a JSON string, replacing the current
     * in-memory snapshots. Enforces the rolling window and persists on
     * success. Rejects invalid JSON as well as JSON that does not resolve
     * to an array of snapshot-shaped objects (each entry must at minimum
     * have a `date` field) — Requirement 8.5.
     *
     * @param {string} jsonString
     * @returns {{success: boolean, error?: string}}
     */
    function importJSON(jsonString) {
        let parsed;
        try {
            parsed = JSON.parse(jsonString);
        } catch (e) {
            return { success: false, error: "Invalid JSON" };
        }
        if (!Array.isArray(parsed)) {
            return { success: false, error: "Expected an array of snapshots" };
        }

        for (let i = 0; i < parsed.length; i++) {
            const entry = parsed[i];
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return { success: false, error: `Snapshot at index ${i} is not a valid object` };
            }
            if (typeof entry.date !== "string" || entry.date.trim() === "") {
                return { success: false, error: `Snapshot at index ${i} is missing a valid "date" field` };
            }
        }

        snapshots = parsed;
        sortSnapshots();
        enforceRollingWindow();
        persist();
        return { success: true };
    }

    // --- Init ---
    /**
     * Loads existing snapshots from the server (if available) or
     * localStorage otherwise, storing the result in the module-level
     * `snapshots` array (sorted by date).
     * @returns {Promise<Object[]>} The loaded snapshots array
     */
    async function init() {
        await checkServer();

        let loaded = null;

        if (serverAvailable) {
            try {
                const resp = await fetch("/api/standard-work/history");
                if (resp.ok) {
                    const data = await resp.json();
                    if (Array.isArray(data)) {
                        loaded = data;
                    }
                }
            } catch (e) {
                console.warn("[StandardWorkHistory] Server history load failed:", e.message);
            }
        }

        if (!loaded) {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        loaded = parsed;
                    }
                }
            } catch (e) {
                console.warn("[StandardWorkHistory] localStorage history parse failed:", e.message);
            }
        }

        snapshots = loaded || [];
        sortSnapshots();
        enforceRollingWindow();

        return snapshots;
    }

    // --- Public API ---
    return {
        init,
        saveShiftSnapshot,
        getSnapshot,
        getRange,
        getSummary,
        exportJSON,
        downloadExport,
        importJSON,
        STORAGE_KEY,
        MAX_SNAPSHOTS,
    };
})();

// Node.js module export (for test runners); no-op in the browser.
if (typeof module !== "undefined" && module.exports) {
    module.exports = StandardWorkHistory;
}
