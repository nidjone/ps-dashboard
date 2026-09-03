// ============================================================
// Unit Tests — Full Backup export/import (state + history bundle)
// Covers StandardWorkState.exportFullBackup() / importFullBackup():
//   - exportFullBackup() returns a JSON string parsing to a bundle with
//     type "sw-full-backup", version 1, a `state` object, and a `history` array.
//   - Round-trip: importFullBackup() applies the bundle state (currentState +
//     localStorage "sw_state") and hands history to StandardWorkHistory.
//   - Rejections: invalid JSON, wrong/absent type, invalid state.
//   - History-only malformed (history not an array): state still imports,
//     success returned (with warning).
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-link-corrections.test.js:
// a minimal fake DOM/localStorage/fetch environment is installed before the
// real, unmodified modules are required.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Install browser-shaped globals before requiring the modules under test ---
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
global.document = {
    addEventListener() {},
    getElementById() {
        return null;
    },
    querySelector() {
        return null;
    },
    querySelectorAll() {
        return [];
    },
};
global.fetch = () => Promise.reject(new Error("no network in test environment"));
global.AbortSignal = global.AbortSignal || { timeout: () => undefined };
global.confirm = () => true;

const StandardWorkData = require("./standard-work-data.js");
global.StandardWorkData = StandardWorkData;

const StandardWorkHistory = require("./standard-work-history.js");
global.StandardWorkHistory = StandardWorkHistory;

const StandardWorkState = require("./standard-work.js");
global.StandardWorkState = StandardWorkState;

function resetStorage() {
    for (const key of Object.keys(fakeLocalStorageStore)) {
        delete fakeLocalStorageStore[key];
    }
}

function makeSnapshot(date) {
    return { date, shift: "day", completionRate: 50, tasks: [], carryoverItems: [] };
}

// ---------------------------------------------------------------
// exportFullBackup shape
// ---------------------------------------------------------------

test("exportFullBackup returns a JSON bundle with type, version, state, history", () => {
    resetStorage();
    // Seed a state and history into localStorage directly.
    const state = StandardWorkData.createInitialState();
    global.localStorage.setItem("sw_state", JSON.stringify(state));
    global.localStorage.setItem("sw_history", JSON.stringify([makeSnapshot("2026-01-01")]));

    const json = StandardWorkState.exportFullBackup();
    assert.equal(typeof json, "string");

    const bundle = JSON.parse(json);
    assert.equal(bundle.type, "sw-full-backup");
    assert.equal(bundle.version, 1);
    assert.equal(typeof bundle.exportedAt, "string");

    assert.ok(bundle.state && typeof bundle.state === "object");
    assert.ok(Array.isArray(bundle.state.tasks));
    assert.ok(bundle.state.migrations && typeof bundle.state.migrations === "object");

    assert.ok(Array.isArray(bundle.history));
    assert.equal(bundle.history.length, 1);
    assert.equal(bundle.history[0].date, "2026-01-01");
});

test("exportFullBackup defaults history to [] when localStorage has none", () => {
    resetStorage();
    global.localStorage.setItem("sw_state", JSON.stringify(StandardWorkData.createInitialState()));
    const bundle = JSON.parse(StandardWorkState.exportFullBackup());
    assert.deepEqual(bundle.history, []);
});

// ---------------------------------------------------------------
// Round-trip import
// ---------------------------------------------------------------

test("importFullBackup applies state (currentState + localStorage) and history", () => {
    resetStorage();

    const bundle = {
        type: "sw-full-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        state: StandardWorkData.createInitialState(),
        history: [makeSnapshot("2026-01-01"), makeSnapshot("2026-01-02")],
    };

    const result = StandardWorkState.importFullBackup(JSON.stringify(bundle));
    assert.equal(result.success, true);
    assert.equal(result.warning, undefined);

    // currentState reflects the imported state.
    const current = StandardWorkState.getState();
    assert.ok(current && Array.isArray(current.tasks));
    assert.ok(current.tasks.length > 0);

    // localStorage "sw_state" now parses to a state with tasks.
    const persisted = JSON.parse(global.localStorage.getItem("sw_state"));
    assert.ok(Array.isArray(persisted.tasks));
    assert.ok(persisted.tasks.length > 0);

    // History was imported into StandardWorkHistory.
    const summary = StandardWorkHistory.getSummary();
    assert.equal(summary.totalDays, 2);
    assert.equal(summary.firstDate, "2026-01-01");
    assert.equal(summary.lastDate, "2026-01-02");

    // And re-exporting reflects the imported snapshots.
    const exported = JSON.parse(StandardWorkHistory.exportJSON());
    assert.equal(exported.length, 2);
});

// ---------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------

test("importFullBackup rejects invalid JSON", () => {
    const result = StandardWorkState.importFullBackup("{not valid json");
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid JSON/i);
});

test("importFullBackup rejects a bundle with the wrong type", () => {
    const result = StandardWorkState.importFullBackup(
        JSON.stringify({ type: "something-else", state: StandardWorkData.createInitialState() })
    );
    assert.equal(result.success, false);
    assert.match(result.error, /backup file/i);
});

test("importFullBackup rejects an object with no type", () => {
    const result = StandardWorkState.importFullBackup(
        JSON.stringify({ state: StandardWorkData.createInitialState() })
    );
    assert.equal(result.success, false);
    assert.match(result.error, /backup file/i);
});

test("importFullBackup rejects a bundle whose state fails validation", () => {
    const result = StandardWorkState.importFullBackup(
        JSON.stringify({ type: "sw-full-backup", version: 1, state: {} })
    );
    assert.equal(result.success, false);
    assert.match(result.error, /state/i);
});

// ---------------------------------------------------------------
// History-only malformed
// ---------------------------------------------------------------

test("importFullBackup still succeeds (with warning) when history is not an array", () => {
    resetStorage();

    const bundle = {
        type: "sw-full-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        state: StandardWorkData.createInitialState(),
        history: 5, // malformed — not an array
    };

    const result = StandardWorkState.importFullBackup(JSON.stringify(bundle));
    assert.equal(result.success, true);
    assert.ok(result.warning, "expected a warning about history");

    // State still imported despite the bad history.
    const current = StandardWorkState.getState();
    assert.ok(current && Array.isArray(current.tasks));
    assert.ok(current.tasks.length > 0);
});
