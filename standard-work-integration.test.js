// ============================================================
// Integration Tests — AM Standard Work Dashboard
// End-to-end flows wiring the REAL modules together:
//   StandardWorkData -> StandardWorkHistory -> StandardWorkState
// Validates: Requirements 1.1, 2.1, 3.1, 7.2, 8.1, 9.1
// ============================================================
//
// Unlike the focused unit tests (standard-work-crud.test.js, which stubs
// StandardWorkHistory with a no-op) these tests exercise the modules as they
// actually collaborate at runtime: adding a task, completing it, resetting
// the day, archiving to history, and falling back to localStorage when the
// server is unreachable — all against the real implementations.
//
// standard-work.js / standard-work-history.js are browser scripts that read
// globals (`document`/`localStorage`/`fetch`/`AbortSignal`/`StandardWorkData`/
// `StandardWorkHistory`) at call time. As with the other test files, only the
// *environment* is shimmed here (DOM, storage, network) — never the business
// logic under test. Load order matters: StandardWorkData, then the REAL
// StandardWorkHistory, then StandardWorkState (which expects both to already
// exist as globals). See standard-work-history-preservation.property.test.js
// for the same shimming/ordering pattern.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Minimal browser environment shims (installed before requiring the
// modules under test) ---
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
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
};
// Offline by default: fetch rejects, so init() falls back to localStorage/
// defaults and isServerMode() stays false (Req 9.1, 9.3). Individual tests may
// override this if they need server-mode behavior.
global.fetch = () => Promise.reject(new Error("no network in test environment"));
global.AbortSignal = global.AbortSignal || { timeout: () => undefined };

// Load order: data -> REAL history -> state.
global.StandardWorkData = require("./standard-work-data.js");
global.StandardWorkHistory = require("./standard-work-history.js");

const StandardWorkData = global.StandardWorkData;
const StandardWorkHistory = global.StandardWorkHistory;
const StandardWorkState = require("./standard-work.js");

// --- Test isolation helpers -------------------------------------------------

/** Empties the fake localStorage store in place. */
function clearLocalStorage() {
    for (const key of Object.keys(fakeLocalStorageStore)) {
        delete fakeLocalStorageStore[key];
    }
}

/**
 * Resets shared module-level state so each test starts clean:
 *   - clears the fake localStorage store
 *   - clears the singleton StandardWorkHistory snapshots (importJSON("[]"))
 *   - restores the default offline fetch stub
 *   - re-inits StandardWorkState (which, with no stored/server data, seeds the
 *     built-in default task template and resets module-level currentState)
 *
 * @returns {Promise<Object>} the freshly initialized state
 */
async function freshEnvironment() {
    clearLocalStorage();
    StandardWorkHistory.importJSON("[]");
    global.fetch = () => Promise.reject(new Error("no network in test environment"));
    return StandardWorkState.init();
}

/** Sleeps for the given number of milliseconds. */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns a valid ISO date string `daysAgo` days before today (UTC-based). */
function isoDaysAgo(daysAgo) {
    return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Flow 1: page load -> add task -> complete task -> verify persistence
// Validates: Requirements 3.1, 2.1, 9.1
// ---------------------------------------------------------------------------

test("Flow 1: add a task, complete it with a period, and verify it persists to localStorage (Req 3.1, 2.1, 9.1)", async () => {
    await freshEnvironment();

    // Add a new daily task (Req 3.1)
    const addResult = StandardWorkState.addTask("daily", "safety", { title: "Integration safety check" });
    assert.equal(addResult.success, true);
    const taskId = addResult.newTaskId;

    // Complete it in period 2 (Req 2.1, 2.2)
    StandardWorkState.updateTaskStatus(taskId, "done", 2);

    // In-memory assertions
    const state = StandardWorkState.getState();
    const task = state.tasks.find((t) => t.id === taskId);
    assert.ok(task, "task should be present in currentState.tasks");
    assert.equal(state.dailyStatus[taskId].status, "done");
    assert.equal(state.dailyStatus[taskId].periodCompleted, 2);

    // Persistence: the debounced save fires after 300ms. Wait just past that,
    // then confirm the task + status reached localStorage (Req 9.1).
    await delay(350);

    const rawPersisted = global.localStorage.getItem(StandardWorkState.STORAGE_KEY);
    assert.ok(rawPersisted, "state should be written to localStorage under STORAGE_KEY");
    const persisted = JSON.parse(rawPersisted);

    const persistedTask = persisted.tasks.find((t) => t.id === taskId);
    assert.ok(persistedTask, "the added task should be present in persisted state");
    assert.equal(persistedTask.title, "Integration safety check");
    assert.equal(persisted.dailyStatus[taskId].status, "done");
    assert.equal(persisted.dailyStatus[taskId].periodCompleted, 2);
});

// ---------------------------------------------------------------------------
// Flow 2: daily reset -> snapshot created + daily statuses cleared
// Validates: Requirements 1.1, 8.1
// ---------------------------------------------------------------------------

test("Flow 2: daily reset archives a snapshot of completed tasks and clears daily statuses (Req 1.1, 8.1)", async () => {
    const state = await freshEnvironment();

    // Mark a couple of daily tasks done so the snapshot has completions to capture.
    const dailyTasks = state.tasks.filter((t) => t.frequency === "daily");
    assert.ok(dailyTasks.length >= 2, "default template should seed multiple daily tasks");
    const doneA = dailyTasks[0].id;
    const doneB = dailyTasks[1].id;
    StandardWorkState.updateTaskStatus(doneA, "done", 1);
    StandardWorkState.updateTaskStatus(doneB, "done", 3);

    // Simulate a day change so dailyReset performs a real reset (Req 1.1).
    const previousDate = isoDaysAgo(1);
    state.lastResetDate = previousDate;

    StandardWorkState.dailyReset(state);

    // A snapshot for the previous date should now exist in the REAL history
    // store, and it should have captured the completed tasks (Req 8.1).
    const snapshot = StandardWorkHistory.getSnapshot(previousDate);
    assert.notEqual(snapshot, null, `expected a snapshot for ${previousDate}`);
    assert.equal(snapshot.tasks.length, dailyTasks.length, "snapshot captures all daily tasks");

    const snapDoneA = snapshot.tasks.find((t) => t.id === doneA);
    const snapDoneB = snapshot.tasks.find((t) => t.id === doneB);
    assert.equal(snapDoneA.status, "done");
    assert.equal(snapDoneA.periodCompleted, 1);
    assert.equal(snapDoneB.status, "done");
    assert.equal(snapDoneB.periodCompleted, 3);

    // Post-reset: every daily status is cleared back to not_started (Req 1.2).
    const postReset = StandardWorkState.getState();
    for (const t of postReset.tasks.filter((x) => x.frequency === "daily")) {
        assert.equal(postReset.dailyStatus[t.id].status, "not_started", `daily task ${t.id} should be reset`);
        assert.equal(postReset.dailyStatus[t.id].periodCompleted, null);
    }
    assert.equal(postReset.lastResetDate, new Date().toISOString().slice(0, 10));
});

// ---------------------------------------------------------------------------
// Flow 3: offline mode -> localStorage fallback + reload
// Validates: Requirements 9.1
// ---------------------------------------------------------------------------

test("Flow 3: offline mode falls back to localStorage, persists, and reloads on re-init (Req 9.1)", async () => {
    // fetch rejects (offline). init() must not throw and must land in local mode.
    await freshEnvironment();
    assert.equal(StandardWorkState.isServerMode(), false, "server should be unavailable in offline mode");

    // A subsequent add + forced synchronous save writes to localStorage.
    const addResult = StandardWorkState.addTask("daily", "operations", { title: "Offline-added task" });
    assert.equal(addResult.success, true);
    const taskId = addResult.newTaskId;

    // Force a synchronous localStorage write rather than waiting on the 300ms
    // debounce, to prove the localStorage-primary path works while offline.
    await StandardWorkState.saveState();

    const rawAfterSave = global.localStorage.getItem(StandardWorkState.STORAGE_KEY);
    assert.ok(rawAfterSave, "offline save should write to localStorage");
    assert.ok(JSON.parse(rawAfterSave).tasks.some((t) => t.id === taskId), "added task should be in localStorage");

    // Simulate a page reload: init() again (still offline). It should load the
    // previously-persisted state from localStorage, including our added task.
    await StandardWorkState.init();
    assert.equal(StandardWorkState.isServerMode(), false);

    const reloaded = StandardWorkState.getState();
    const reloadedTask = reloaded.tasks.find((t) => t.id === taskId);
    assert.ok(reloadedTask, "the offline-added task should survive a reload from localStorage");
    assert.equal(reloadedTask.title, "Offline-added task");
});

// ---------------------------------------------------------------------------
// Flow 4: carryover flagging -> daily reset -> [CARRYOVER] prefix
// Validates: Requirements 7.2
// ---------------------------------------------------------------------------

test("Flow 4: a carryover-flagged incomplete task gets a [CARRYOVER] notes prefix after daily reset (Req 7.2)", async () => {
    const state = await freshEnvironment();

    // Pick a daily task, flag it for carryover, leave it NOT done.
    const dailyTask = state.tasks.find((t) => t.frequency === "daily");
    assert.ok(dailyTask, "default template should seed at least one daily task");
    const taskId = dailyTask.id;

    const toggle = StandardWorkState.toggleCarryover(taskId);
    assert.equal(toggle.success, true);
    assert.equal(toggle.carryover, true);
    // Sanity: not done, so it qualifies for carryover processing.
    assert.notEqual(StandardWorkState.getState().dailyStatus[taskId].status, "done");

    // Simulate a day change and reset.
    state.lastResetDate = isoDaysAgo(1);
    StandardWorkState.dailyReset(state);

    const postReset = StandardWorkState.getState();
    const entry = postReset.dailyStatus[taskId];
    assert.ok(entry.notes.startsWith("[CARRYOVER]"), `expected notes to start with [CARRYOVER], got: ${JSON.stringify(entry.notes)}`);
    // The carryover flag itself must be cleared after processing (Req 7.3).
    assert.equal(entry.carryover, false, "carryover flag should be cleared after reset");
});
