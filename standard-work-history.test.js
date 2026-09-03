// ============================================================
// Unit Tests — StandardWorkHistory
// saveShiftSnapshot, getSnapshot, getRange, rolling window, getSummary
// Validates: Requirements 8.1, 8.2, 8.3, 1.7
// ============================================================
//
// standard-work-history.js is written as a browser script (relies on the
// global `localStorage`/`fetch`/`AbortSignal` bindings provided in
// standard-work.html). To exercise it under Node's test runner, minimal
// browser-shaped globals are installed before requiring the module — this
// only stubs the *environment* (storage, network), never the business logic
// under test.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Minimal browser environment shims (installed before require) ---
const fakeLocalStorageStore = {};
global.localStorage = {
    getItem(key) {
        return Object.prototype.hasOwnProperty.call(fakeLocalStorageStore, key) ? fakeLocalStorageStore[key] : null;
    },
    setItem(key, value) {
        fakeLocalStorageStore[key] = String(value);
    },
    removeItem(key) {
        delete fakeLocalStorageStore[key];
    },
};
global.fetch = () => Promise.reject(new Error("no network in test environment"));
global.AbortSignal = global.AbortSignal || { timeout: () => undefined };

const StandardWorkHistory = require("./standard-work-history.js");

/**
 * Re-initializes StandardWorkHistory with an empty localStorage before each
 * test so snapshot state doesn't leak between tests.
 */
async function freshHistory() {
    for (const key of Object.keys(fakeLocalStorageStore)) {
        delete fakeLocalStorageStore[key];
    }
    return StandardWorkHistory.init();
}

/**
 * Builds a minimal HistorySnapshot-shaped object (matching the shape
 * produced by StandardWorkState.buildSnapshot()).
 */
function makeShiftData(overrides = {}) {
    return Object.assign(
        {
            shift: "day",
            weeklyObjectives: "",
            completionRate: 0,
            tasks: [],
            carryoverItems: [],
        },
        overrides
    );
}

// ---------------------------------------------------------------
// saveShiftSnapshot / getSnapshot
// ---------------------------------------------------------------

test("saveShiftSnapshot: stores a snapshot retrievable via getSnapshot (Req 8.1)", async () => {
    await freshHistory();

    const shiftData = makeShiftData({
        completionRate: 85,
        tasks: [{ id: "task-1", title: "Safety Gemba", category: "safety", status: "done", periodCompleted: 1, notes: "" }],
        carryoverItems: [{ id: "task-2", title: "Clear TNL", reason: "System down" }],
        weeklyObjectives: "Focus on bin audits",
    });

    StandardWorkHistory.saveShiftSnapshot("2026-07-28", shiftData);

    const snapshot = StandardWorkHistory.getSnapshot("2026-07-28");
    assert.ok(snapshot, "snapshot should be retrievable");
    assert.equal(snapshot.date, "2026-07-28");
    assert.equal(snapshot.completionRate, 85);
    assert.equal(snapshot.weeklyObjectives, "Focus on bin audits");
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.carryoverItems.length, 1);
});

test("getSnapshot: returns null for a date with no snapshot", async () => {
    await freshHistory();
    assert.equal(StandardWorkHistory.getSnapshot("2099-01-01"), null);
});

test("saveShiftSnapshot: saving twice for the same date replaces (dedupes) rather than duplicates", async () => {
    await freshHistory();

    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData({ completionRate: 50 }));
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData({ completionRate: 90 }));

    const snapshot = StandardWorkHistory.getSnapshot("2026-07-28");
    assert.equal(snapshot.completionRate, 90);

    const range = StandardWorkHistory.getRange("2026-01-01", "2026-12-31");
    assert.equal(range.length, 1, "should only have one entry for the deduplicated date");
});

test("saveShiftSnapshot: persists to localStorage", async () => {
    await freshHistory();
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData());

    const raw = fakeLocalStorageStore[StandardWorkHistory.STORAGE_KEY];
    assert.ok(raw, "localStorage should contain the history key");
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].date, "2026-07-28");
});

// ---------------------------------------------------------------
// getRange
// ---------------------------------------------------------------

test("getRange: returns only snapshots within the inclusive date range, sorted by date (Req 8.3)", async () => {
    await freshHistory();

    StandardWorkHistory.saveShiftSnapshot("2026-07-20", makeShiftData());
    StandardWorkHistory.saveShiftSnapshot("2026-07-25", makeShiftData());
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData());
    StandardWorkHistory.saveShiftSnapshot("2026-08-01", makeShiftData());

    const range = StandardWorkHistory.getRange("2026-07-21", "2026-07-28");

    assert.equal(range.length, 2);
    assert.deepEqual(range.map((s) => s.date), ["2026-07-25", "2026-07-28"]);
});

test("getRange: includes snapshots exactly on the start/end boundary dates", async () => {
    await freshHistory();

    StandardWorkHistory.saveShiftSnapshot("2026-07-21", makeShiftData());
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData());

    const range = StandardWorkHistory.getRange("2026-07-21", "2026-07-28");
    assert.equal(range.length, 2);
});

test("getRange: returns an empty array when no snapshots fall within range", async () => {
    await freshHistory();
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData());

    const range = StandardWorkHistory.getRange("2020-01-01", "2020-01-31");
    assert.deepEqual(range, []);
});

// ---------------------------------------------------------------
// Rolling window (max 90 snapshots)
// ---------------------------------------------------------------

test("rolling window: evicts the oldest snapshots once more than 90 are stored (Req 8.2)", async () => {
    await freshHistory();

    // Save 95 sequential daily snapshots starting 2026-01-01
    const startDate = new Date(Date.UTC(2026, 0, 1));
    for (let i = 0; i < 95; i++) {
        const d = new Date(startDate);
        d.setUTCDate(startDate.getUTCDate() + i);
        const iso = d.toISOString().slice(0, 10);
        StandardWorkHistory.saveShiftSnapshot(iso, makeShiftData());
    }

    const summary = StandardWorkHistory.getSummary();
    assert.equal(summary.totalDays, 90, "should be capped at MAX_SNAPSHOTS (90)");

    // The oldest 5 days (day 0..4) should have been evicted; day 5 (index 5)
    // should now be the earliest surviving snapshot.
    const expectedFirst = new Date(startDate);
    expectedFirst.setUTCDate(startDate.getUTCDate() + 5);
    assert.equal(summary.firstDate, expectedFirst.toISOString().slice(0, 10));

    const expectedLast = new Date(startDate);
    expectedLast.setUTCDate(startDate.getUTCDate() + 94);
    assert.equal(summary.lastDate, expectedLast.toISOString().slice(0, 10));

    // The evicted date should no longer be retrievable
    assert.equal(StandardWorkHistory.getSnapshot(startDate.toISOString().slice(0, 10)), null);
});

// ---------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------

test("getSummary: returns zeroed/null summary when no snapshots exist", async () => {
    await freshHistory();
    const summary = StandardWorkHistory.getSummary();
    assert.deepEqual(summary, { totalDays: 0, firstDate: null, lastDate: null });
});

test("getSummary: returns totalDays, firstDate, and lastDate across stored snapshots", async () => {
    await freshHistory();

    StandardWorkHistory.saveShiftSnapshot("2026-07-25", makeShiftData());
    StandardWorkHistory.saveShiftSnapshot("2026-07-20", makeShiftData());
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData());

    const summary = StandardWorkHistory.getSummary();
    assert.equal(summary.totalDays, 3);
    assert.equal(summary.firstDate, "2026-07-20");
    assert.equal(summary.lastDate, "2026-07-28");
});

// ---------------------------------------------------------------
// exportJSON / downloadExport / importJSON
// ---------------------------------------------------------------

test("exportJSON: produces a valid JSON string of all stored snapshots (Req 8.4)", async () => {
    await freshHistory();
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData({ completionRate: 75 }));

    const json = StandardWorkHistory.exportJSON();
    const parsed = JSON.parse(json);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].date, "2026-07-28");
    assert.equal(parsed[0].completionRate, 75);
});

test("downloadExport: in a Node environment (no document/URL) returns the JSON string without throwing (Req 8.4)", async () => {
    await freshHistory();
    StandardWorkHistory.saveShiftSnapshot("2026-07-28", makeShiftData());

    assert.equal(typeof document, "undefined", "test environment should not define document");

    let json;
    assert.doesNotThrow(() => {
        json = StandardWorkHistory.downloadExport();
    });

    const parsed = JSON.parse(json);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].date, "2026-07-28");
});

test("importJSON: rejects invalid JSON with an error (Req 8.5)", async () => {
    await freshHistory();
    const result = StandardWorkHistory.importJSON("{not valid json");
    assert.equal(result.success, false);
    assert.ok(result.error);
});

test("importJSON: rejects a non-array JSON value with an error (Req 8.5)", async () => {
    await freshHistory();
    const result = StandardWorkHistory.importJSON(JSON.stringify({ foo: "bar" }));
    assert.equal(result.success, false);
    assert.ok(result.error);
});

test("importJSON: rejects an array containing an entry missing a `date` field (Req 8.5)", async () => {
    await freshHistory();
    const badPayload = JSON.stringify([
        makeShiftData({ completionRate: 50 }), // no `date` field
    ]);

    const result = StandardWorkHistory.importJSON(badPayload);
    assert.equal(result.success, false);
    assert.ok(result.error);

    // Ensure the rejected import did not overwrite existing state
    const summary = StandardWorkHistory.getSummary();
    assert.equal(summary.totalDays, 0);
});

test("importJSON: accepts and stores a valid array of snapshots (Req 8.5)", async () => {
    await freshHistory();
    const goodPayload = JSON.stringify([
        Object.assign({ date: "2026-07-28" }, makeShiftData({ completionRate: 60 })),
    ]);

    const result = StandardWorkHistory.importJSON(goodPayload);
    assert.equal(result.success, true);

    const snapshot = StandardWorkHistory.getSnapshot("2026-07-28");
    assert.ok(snapshot);
    assert.equal(snapshot.completionRate, 60);
});
