// ============================================================
// Historical Data Module - ORF3 IB Problem Solve Dashboard
// Stores daily snapshots of associate metrics for trend analysis
// ============================================================

const History = (() => {
    "use strict";

    const STORAGE_KEY = "orf3_ps_history";
    const MAX_DAYS = 180; // ~6 months of daily data

    // In-memory cache of snapshots (loaded at startup)
    let _cache = null;

    function getAll() {
        if (_cache !== null) return _cache;
        // Sync fallback from localStorage for first call before async load completes
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            _cache = raw ? JSON.parse(raw) : [];
        } catch (e) {
            _cache = [];
        }
        return _cache;
    }

    function saveAll(snapshots) {
        // Trim to max days
        const trimmed = snapshots.slice(-MAX_DAYS);
        _cache = trimmed;
        // Save via Storage adapter (async, fire-and-forget)
        Storage.saveHistory(trimmed);
    }

    // Load from server/localStorage at startup (async)
    async function initialize() {
        try {
            const data = await Storage.loadHistory();
            if (Array.isArray(data) && data.length > 0) {
                _cache = data;
            }
        } catch (e) {
            console.warn("[History] Failed to load from server:", e);
        }
    }

    // Save a snapshot for today (or a given date)
    // Overwrites if same date already exists
    function saveSnapshot(dateStr) {
        const date = dateStr || new Date().toISOString().slice(0, 10);
        const snapshots = getAll();

        // Build associate data from current roster + performance
        const associates = {};
        DATA.roster.forEach(r => {
            if (!r.clockedIn) return;
            const p = DATA.performance[r.login];
            if (!p) return;

            const totalHrs = p.totalHours || 0;
            const directHrs = p.directHours || 0;
            const inferredHrs = totalHrs - directHrs;
            const uit = totalHrs > 0 ? Math.round((inferredHrs / totalHrs) * 1000) / 10 : null;
            const tot = p.tot || null;

            associates[r.login] = {
                name: `${r.firstName} ${r.lastName}`,
                floor: r.floor,
                uph: p.uph || 0,
                tot: tot,
                uit: uit,
                units: p.unitsShift || 0,
                directHrs: Math.round(directHrs * 100) / 100,
                totalHrs: Math.round(totalHrs * 100) / 100,
            };
        });

        // Build floor-level aggregates
        const floorData = {};
        [1, 2, 3, 4].forEach(floorId => {
            const floorAssociates = Object.values(associates).filter(a => a.floor === floorId);
            if (floorAssociates.length === 0) {
                floorData[floorId] = { uit: null, tot: null, headcount: 0, avgUph: 0 };
                return;
            }
            const withHours = floorAssociates.filter(a => a.totalHrs > 0);
            const totalInferred = withHours.reduce((s, a) => s + (a.totalHrs - a.directHrs), 0);
            const totalHrs = withHours.reduce((s, a) => s + a.totalHrs, 0);
            const floorUIT = totalHrs > 0 ? Math.round((totalInferred / totalHrs) * 1000) / 10 : null;
            const withToT = floorAssociates.filter(a => a.tot !== null);
            const avgToT = withToT.length > 0 ? Math.round(withToT.reduce((s, a) => s + a.tot, 0) / withToT.length) : null;
            const avgUph = floorAssociates.length > 0 ? Math.round(floorAssociates.reduce((s, a) => s + a.uph, 0) / floorAssociates.length) : 0;

            floorData[floorId] = {
                uit: floorUIT,
                tot: avgToT,
                headcount: floorAssociates.length,
                avgUph: avgUph,
            };
        });

        const snapshot = { date, associates, floors: floorData, piles: getPileData() };

        // Replace existing snapshot for same date, or append
        const existingIdx = snapshots.findIndex(s => s.date === date);
        if (existingIdx >= 0) {
            // Merge: keep existing pile data if new snapshot doesn't have it, and vice versa
            const existing = snapshots[existingIdx];
            snapshot.associates = { ...existing.associates, ...snapshot.associates };
            snapshot.floors = { ...existing.floors, ...snapshot.floors };
            if (!snapshot.piles && existing.piles) snapshot.piles = existing.piles;
            snapshots[existingIdx] = snapshot;
        } else {
            snapshots.push(snapshot);
        }

        // Sort by date
        snapshots.sort((a, b) => a.date.localeCompare(b.date));
        saveAll(snapshots);

        return snapshot;
    }

    // Get current pile data for snapshot
    function getPileData() {
        const sos = DATA.pileData.sos;
        const current = DATA.pileData.current;
        const sosTotal = Object.values(sos).reduce((a, b) => a + b, 0);
        const currentTotal = Object.values(current).reduce((a, b) => a + b, 0);

        if (sosTotal === 0 && currentTotal === 0) return null;

        return {
            sos: { ...sos },
            current: { ...current },
            sosTotal,
            currentTotal,
            delta: currentTotal - sosTotal,
        };
    }

    // Save just pile data for today (called from pile import)
    function savePileSnapshot(dateStr) {
        const date = dateStr || new Date().toISOString().slice(0, 10);
        const snapshots = getAll();
        const piles = getPileData();
        if (!piles) return;

        const existingIdx = snapshots.findIndex(s => s.date === date);
        if (existingIdx >= 0) {
            snapshots[existingIdx].piles = piles;
        } else {
            snapshots.push({
                date,
                associates: {},
                floors: {},
                piles: piles,
            });
        }

        snapshots.sort((a, b) => a.date.localeCompare(b.date));
        saveAll(snapshots);
    }

    // Get pile trend data
    function getPileTrend(startDate, endDate) {
        const range = getRange(startDate, endDate);
        return range.filter(s => s.piles).map(s => ({
            date: s.date,
            ...s.piles,
        }));
    }

    // Get snapshots within a date range
    function getRange(startDate, endDate) {
        const all = getAll();
        return all.filter(s => s.date >= startDate && s.date <= endDate);
    }

    // Get all unique dates
    function getDates() {
        return getAll().map(s => s.date);
    }

    // Get trend data for a specific associate
    function getAssociateTrend(login, startDate, endDate) {
        const range = getRange(startDate, endDate);
        return range.map(s => ({
            date: s.date,
            ...(s.associates[login] || { uit: null, tot: null, uph: 0, units: 0 }),
        }));
    }

    // Get trend data for a specific floor
    function getFloorTrend(floorId, startDate, endDate) {
        const range = getRange(startDate, endDate);
        return range.map(s => ({
            date: s.date,
            ...(s.floors[floorId] || { uit: null, tot: null, headcount: 0, avgUph: 0 }),
        }));
    }

    // Export all history as JSON (for backup)
    function exportJSON() {
        const data = {
            exported: new Date().toISOString(),
            site: "ORF3",
            snapshots: getAll(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `orf3_ps_history_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // Import history from JSON file (merges with existing)
    function importJSON(text) {
        try {
            const data = JSON.parse(text);
            const imported = data.snapshots || data;
            if (!Array.isArray(imported)) throw new Error("Invalid format");

            const existing = getAll();
            const dateSet = new Set(existing.map(s => s.date));

            let added = 0;
            imported.forEach(snap => {
                if (snap.date && snap.associates) {
                    if (!dateSet.has(snap.date)) {
                        existing.push(snap);
                        added++;
                    }
                }
            });

            existing.sort((a, b) => a.date.localeCompare(b.date));
            saveAll(existing);
            return `Imported ${added} new snapshots (${existing.length} total days in history)`;
        } catch (e) {
            throw new Error("Invalid history file: " + e.message);
        }
    }

    // Clear all history
    function clearAll() {
        _cache = [];
        localStorage.removeItem(STORAGE_KEY);
        Storage.saveHistory([]);
    }

    // Get summary stats
    function getSummary() {
        const all = getAll();
        return {
            totalDays: all.length,
            firstDate: all.length > 0 ? all[0].date : null,
            lastDate: all.length > 0 ? all[all.length - 1].date : null,
        };
    }

    return {
        initialize,
        saveSnapshot,
        savePileSnapshot,
        getAll,
        getRange,
        getDates,
        getAssociateTrend,
        getFloorTrend,
        getPileTrend,
        exportJSON,
        importJSON,
        clearAll,
        getSummary,
    };
})();
