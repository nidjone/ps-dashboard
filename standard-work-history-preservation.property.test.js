// ============================================================
// Property-Based Test — AM Standard Work Dashboard
// Property 5: History preservation
// Validates: Requirements 8.1
// ============================================================
//
// After a daily reset, the previous day's state must be captured in
// history: StandardWorkHistory.getSnapshot(previousDate) should return a
// non-null snapshot whose `tasks` array length matches the number of daily
// tasks that existed in the pre-reset state.
//
// standard-work.js and standard-work-history.js are written as browser
// scripts (relying on globals like `document`/`localStorage`/`fetch`/
// `StandardWorkData`/`StandardWorkHistory` provided by <script> tags in
// standard-work.html). To exercise them under Node's test runner, minimal
// browser-shaped globals are installed before requiring the modules — this
// only stubs the *environment* (DOM, storage, network), never the business
// logic under test. See standard-work-crud.test.js for the same shimming
// pattern.
//
// Unlike standard-work-crud.test.js (which stubs StandardWorkHistory with a
// no-op `{ saveShiftSnapshot: () => {} }`), this test requires the REAL
// StandardWorkHistory module so that snapshot storage/retrieval can
// actually be verified.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fc = require("fast-check");

// --- Minimal browser environment shims (installed before requiring the
// modules under test, since they read these globals at call time) ---
const fakeLocalStorageStore = {};
global.localStorage = global.localStorage || {
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
global.document = global.document || {
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
};
global.fetch = global.fetch || (() => Promise.reject(new Error("no network in test environment")));
global.AbortSignal = global.AbortSignal || { timeout: () => undefined };

// Load order matters: StandardWorkData, then the REAL StandardWorkHistory,
// then StandardWorkState — standard-work.js expects both StandardWorkData
// and StandardWorkHistory to already be defined as globals.
global.StandardWorkData = global.StandardWorkData || require("./standard-work-data.js");
global.StandardWorkHistory = global.StandardWorkHistory || require("./standard-work-history.js");

const StandardWorkData = global.StandardWorkData;
const StandardWorkHistory = global.StandardWorkHistory;
const StandardWorkState = require("./standard-work.js");

/**
 * Builds a minimal, schema-valid StandardWorkState with `numDailyTasks`
 * daily tasks (each assigned one of the given random statuses) and no
 * weekly/monthly tasks, with `lastResetDate` set to the given past date.
 *
 * @param {string} previousDate - ISO date string (e.g. "2024-03-05"), guaranteed < today
 * @param {string[]} statuses - One Task_Status value per daily task to create
 * @returns {Object} A valid StandardWorkState-shaped object
 */
function buildStateWithDailyTasks(previousDate, statuses) {
    const tasks = [];
    const dailyStatus = {};

    statuses.forEach((status, i) => {
        const id = `daily-task-${i}`;
        tasks.push({
            id,
            title: `Task ${i}`,
            category: StandardWorkData.VALID_CATEGORIES[i % StandardWorkData.VALID_CATEGORIES.length],
            frequency: "daily",
            notes: "",
            editable: false,
            editableField: null,
            carryover: false,
            sortOrder: i,
            createdAt: `${previousDate}T00:00:00.000Z`,
            updatedAt: `${previousDate}T00:00:00.000Z`,
        });
        dailyStatus[id] = { status, periodCompleted: null, notes: "" };
    });

    return {
        version: 1,
        lastResetDate: previousDate,
        weeklyObjectives: "",
        shiftConfig: { periodsPerShift: 4, shiftStart: "06:00", shiftEnd: "16:30" },
        tasks,
        dailyStatus,
        weeklyStatus: {},
        monthlyStatus: {},
    };
}

// Days-ago offset (>= 1 full UTC day) so the derived `previousDate` is
// always strictly before "today" as computed by dailyReset()
// (`new Date().toISOString().slice(0, 10)`, which is always UTC-based).
const daysAgoArb = fc.integer({ min: 1, max: 3650 });

const dailyResetHistoryArb = fc.record({
    daysAgo: daysAgoArb,
    statuses: fc.array(fc.constantFrom(...StandardWorkData.VALID_STATUSES), { minLength: 0, maxLength: 20 }),
});

test("Property 5: History preservation — dailyReset saves a snapshot for the previous date with the correct daily task count (Validates: Requirements 8.1)", () => {
    fc.assert(
        fc.property(dailyResetHistoryArb, ({ daysAgo, statuses }) => {
            // StandardWorkHistory keeps its snapshots in module-level state, so
            // without resetting between property iterations, a `daysAgo` value
            // spanning up to 10 years combined with hundreds of fast-check runs
            // would legitimately trigger the 90-snapshot rolling window (Req
            // 8.2) and evict the very entry this iteration is about to assert
            // on. Clearing history before each iteration isolates this
            // property to what it's actually testing: a single dailyReset()
            // call preserves the previous day's state.
            StandardWorkHistory.importJSON("[]");

            const previousDate = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
            const state = buildStateWithDailyTasks(previousDate, statuses);
            const dailyTaskCountBeforeReset = Object.keys(state.dailyStatus).length;

            StandardWorkState.dailyReset(state);

            const snapshot = StandardWorkHistory.getSnapshot(previousDate);
            assert.notEqual(snapshot, null, `expected a snapshot to exist for ${previousDate}`);
            assert.equal(snapshot.tasks.length, dailyTaskCountBeforeReset);
            assert.equal(snapshot.tasks.length, statuses.length);
        }),
        { numRuns: 200 }
    );
});
