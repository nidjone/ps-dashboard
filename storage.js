// ============================================================
// Storage Adapter - ORF3 IB Problem Solve Dashboard
// Automatically uses server API when available, falls back to localStorage
// ============================================================

const Storage = (() => {
    "use strict";

    const LOCAL_DATA_KEY = "orf3_ps_dashboard_data";
    const LOCAL_HISTORY_KEY = "orf3_ps_history";
    let serverAvailable = false;
    let checkedServer = false;

    // --- Server Detection ---
    async function checkServer() {
        if (checkedServer) return serverAvailable;
        try {
            const resp = await fetch("/api/status", { method: "GET", signal: AbortSignal.timeout(2000) });
            if (resp.ok) {
                serverAvailable = true;
                console.log("[Storage] Server mode — data shared with team");
            }
        } catch (e) {
            serverAvailable = false;
            console.log("[Storage] Local mode — data stored in this browser only");
        }
        checkedServer = true;
        return serverAvailable;
    }

    function isServerMode() {
        return serverAvailable;
    }

    // --- Dashboard Data (roster, performance, pileData, floors) ---

    async function loadData() {
        if (serverAvailable) {
            try {
                const resp = await fetch("/api/data");
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && Object.keys(data).length > 0) return data;
                }
            } catch (e) {
                console.warn("[Storage] Server read failed, falling back to localStorage");
            }
        }
        // Fallback to localStorage
        try {
            const raw = localStorage.getItem(LOCAL_DATA_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                // If server is available but empty, push local data up to it (migration)
                if (serverAvailable && data && Object.keys(data).length > 0) {
                    console.log("[Storage] Migrating local data to server...");
                    fetch("/api/data", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: raw,
                    }).catch(() => {});
                }
                return data;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async function saveData(data) {
        // Always save to localStorage as backup
        try {
            localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(data));
        } catch (e) { /* ignore */ }

        // Save to server if available
        if (serverAvailable) {
            try {
                await fetch("/api/data", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(data),
                });
            } catch (e) {
                console.warn("[Storage] Server save failed:", e.message);
            }
        }
    }

    // Update individual roster entries by login (never replaces the whole
    // roster). This is the safest way to persist manual roster edits.
    async function updateRoster(changes) {
        // changes: { roster, damagelandRoster, removeLogins,
        //            removeDamagelandLogins, targetHC, damagelandTargetHC }
        if (serverAvailable) {
            try {
                await fetch("/api/roster/update", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(changes),
                });
            } catch (e) {
                console.warn("[Storage] Roster update failed:", e.message);
            }
        }
        // Keep localStorage backup in sync with full current arrays
        try {
            const raw = localStorage.getItem(LOCAL_DATA_KEY);
            const existing = raw ? JSON.parse(raw) : {};
            if (changes.fullRoster) existing.roster = changes.fullRoster;
            if (changes.fullDamagelandRoster) existing.damagelandRoster = changes.fullDamagelandRoster;
            if (changes.targetHC) existing.targetHC = changes.targetHC;
            if (changes.damagelandTargetHC) existing.damagelandTargetHC = changes.damagelandTargetHC;
            localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(existing));
        } catch (e) { /* ignore */ }
    }

    // Merge only specific sections into the server data, preventing
    // one user's save from overwriting another user's changes.
    async function mergeData(partialData) {
        // Update localStorage backup with the merged view
        try {
            const raw = localStorage.getItem(LOCAL_DATA_KEY);
            const existing = raw ? JSON.parse(raw) : {};
            Object.keys(partialData).forEach(k => { existing[k] = partialData[k]; });
            localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(existing));
        } catch (e) { /* ignore */ }

        if (serverAvailable) {
            try {
                await fetch("/api/data/merge", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(partialData),
                });
            } catch (e) {
                console.warn("[Storage] Server merge failed:", e.message);
            }
        }
    }

    // --- History Data (snapshots array) ---

    async function loadHistory() {
        if (serverAvailable) {
            try {
                const resp = await fetch("/api/history");
                if (resp.ok) {
                    const data = await resp.json();
                    if (Array.isArray(data) && data.length > 0) return data;
                }
            } catch (e) {
                console.warn("[Storage] Server history read failed, falling back to localStorage");
            }
        }
        // Fallback
        try {
            const raw = localStorage.getItem(LOCAL_HISTORY_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                // Migrate local history to server if available but empty
                if (serverAvailable && Array.isArray(data) && data.length > 0) {
                    console.log("[Storage] Migrating local history to server...");
                    fetch("/api/history", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: raw,
                    }).catch(() => {});
                }
                return data;
            }
            return [];
        } catch (e) {
            return [];
        }
    }

    async function saveHistory(snapshots) {
        // Always save to localStorage as backup
        try {
            localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(snapshots));
        } catch (e) { /* ignore */ }

        // Save to server if available
        if (serverAvailable) {
            try {
                await fetch("/api/history", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(snapshots),
                });
            } catch (e) {
                console.warn("[Storage] Server history save failed:", e.message);
            }
        }
    }

    async function mergeHistory(snapshots) {
        if (serverAvailable) {
            try {
                const resp = await fetch("/api/history/merge", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(snapshots),
                });
                if (resp.ok) return await resp.json();
            } catch (e) {
                console.warn("[Storage] Server merge failed:", e.message);
            }
        }
        // Fallback: merge locally
        const existing = await loadHistory();
        const dateSet = new Set(existing.map(s => s.date));
        let added = 0;
        snapshots.forEach(snap => {
            if (snap.date && !dateSet.has(snap.date)) {
                existing.push(snap);
                dateSet.add(snap.date);
                added++;
            }
        });
        existing.sort((a, b) => a.date.localeCompare(b.date));
        await saveHistory(existing);
        return { added, total: existing.length };
    }

    // --- Clear ---

    async function clearAll() {
        localStorage.removeItem(LOCAL_DATA_KEY);
        localStorage.removeItem(LOCAL_HISTORY_KEY);
        if (serverAvailable) {
            try {
                await fetch("/api/data", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                await fetch("/api/history", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify([]),
                });
            } catch (e) { /* ignore */ }
        }
    }

    return {
        checkServer,
        isServerMode,
        loadData,
        saveData,
        mergeData,
        updateRoster,
        loadHistory,
        saveHistory,
        mergeHistory,
        clearAll,
    };
})();
