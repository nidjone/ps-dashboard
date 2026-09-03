// ============================================================
// Unit Tests — StandardWorkState multi-tab consistency
// reloadFromServer, initVisibilityReload (visibilitychange)
// Validates: Requirements 14.1, 14.2
// ============================================================
//
// standard-work.js is a browser script relying on global bindings
// (`StandardWorkData`/`StandardWorkHistory`/`document`/`localStorage`/`fetch`)
// provided by <script> tags in standard-work.html. To exercise it under
// Node's test runner, minimal browser-shaped globals are installed before
// requiring the module. Only the *environment* (DOM, storage, network) is
// stubbed — never the business logic under test. Here `fetch` is made
// controllable so we can simulate the server returning a specific state and
// simulate the server being unavailable.

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

// Controllable document stub: captures the visibilitychange handler and lets
// tests set the current visibilityState.
const documentStub = {
    visibilityState: "visible",
    _listeners: {},
    getElementById: () => null,
    querySelector: () => null,
    addEventListener(type, handler) {
        documentStub._listeners[type] = documentStub._listeners[type] || [];
        documentStub._listeners[type].push(handler);
    },
    // Test helper: dispatch a synthetic event to all registered handlers.
    _dispatch(type) {
        (documentStub._listeners[type] || []).forEach((h) => h());
    },
};
global.document = documentStub;

global.AbortSignal = global.AbortSignal || { timeout: () => undefined };

// Controllable fetch. Tests set `fetchController` to shape responses.
// mode: "available" (GET returns serverState, POST ok) or "offline" (rejects).
const fetchController = {
    mode: "available",
    serverState: null,
};
global.fetch = (url, opts = {}) => {
    if (fetchController.mode === "offline") {
        return Promise.reject(new Error("network down"));
    }
    const method = (opts.method || "GET").toUpperCase();
    if (method === "POST") {
        return Promise.resolve({ ok: true, status: 200 });
    }
    // GET
    const body = fetchController.serverState;
    return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    });
};

global.StandardWorkData = require("./standard-work-data.js");
global.StandardWorkHistory = { saveShiftSnapshot: () => {} };

const StandardWorkState = require("./standard-work.js");

/**
 * Builds a minimal valid StandardWorkState for use as a "server copy".
 * `lastResetDate` defaults to today so reloadFromServer does not trigger a
 * daily reset that would mutate the copy.
 */
function makeServerState(overrides = {}) {
    const today = new Date().toISOString().slice(0, 10);
    return Object.assign(
        {
            version: 1,
            lastResetDate: today,
            weeklyObjectives: "server objectives",
            shiftConfig: { periodsPerShift: 4, shiftStart: "06:00", shiftEnd: "16:30" },
            tasks: [
                {
                    id: "server-task-1",
                    title: "Server task",
                    category: "safety",
                    frequency: "daily",
                    notes: "",
                    editable: false,
                    editableField: null,
                    carryover: false,
                    sortOrder: 1,
                    createdAt: today + "T00:00:00.000Z",
                    updatedAt: today + "T00:00:00.000Z",
                },
            ],
            dailyStatus: { "server-task-1": { status: "done", periodCompleted: 2, notes: "" } },
            weeklyStatus: {},
            monthlyStatus: {},
        },
        overrides
    );
}

/**
 * Resets shims and initializes StandardWorkState fresh. Starts in "available"
 * mode so init() loads the provided serverState (last-write-wins baseline),
 * unless a caller overrides afterwards.
 */
async function freshState(serverState) {
    for (const key of Object.keys(fakeLocalStorageStore)) {
        delete fakeLocalStorageStore[key];
    }
    fetchController.mode = "available";
    fetchController.serverState = serverState || null;
    return StandardWorkState.init();
}

// ---------------------------------------------------------------
// reloadFromServer — last-write-wins
// ---------------------------------------------------------------

test("reloadFromServer: replaces currentState with the server's copy (last-write-wins, Req 14.2)", async () => {
    // Start with the built-in default template (no server state).
    fetchController.serverState = null;
    await freshState(null);

    const before = StandardWorkState.getState();
    assert.ok(before.tasks.length > 1, "should start from default template");

    // Now the server has a different, authoritative copy.
    const serverCopy = makeServerState();
    fetchController.serverState = serverCopy;

    const reloaded = await StandardWorkState.reloadFromServer();

    assert.ok(reloaded, "reloadFromServer should return the reloaded state");
    const after = StandardWorkState.getState();
    assert.equal(after.tasks.length, 1, "currentState should be replaced by the server copy");
    assert.equal(after.tasks[0].id, "server-task-1");
    assert.equal(after.weeklyObjectives, "server objectives");
    assert.equal(after.dailyStatus["server-task-1"].status, "done");
});

test("reloadFromServer: is a no-op and returns null when the server is unavailable (Req 14.1)", async () => {
    const serverCopy = makeServerState({ weeklyObjectives: "original" });
    await freshState(serverCopy);

    const before = StandardWorkState.getState();
    assert.equal(before.weeklyObjectives, "original");

    // Server goes offline; a would-be newer copy must NOT be applied.
    fetchController.mode = "offline";
    fetchController.serverState = makeServerState({ weeklyObjectives: "should-not-apply" });

    const result = await StandardWorkState.reloadFromServer();

    assert.equal(result, null, "reloadFromServer should return null when offline");
    const after = StandardWorkState.getState();
    assert.equal(after.weeklyObjectives, "original", "state must remain unchanged when server unavailable");
});

// ---------------------------------------------------------------
// initVisibilityReload — visibilitychange wiring
// ---------------------------------------------------------------

test("visibilitychange: reloads from server when the tab becomes visible (Req 14.1)", async () => {
    fetchController.serverState = null;
    await freshState(null);

    // init() already registered the listener. Point the server at a new copy.
    const serverCopy = makeServerState({ weeklyObjectives: "focused via refocus" });
    fetchController.serverState = serverCopy;
    documentStub.visibilityState = "visible";

    documentStub._dispatch("visibilitychange");

    // The handler kicks off an async reload; let microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const after = StandardWorkState.getState();
    assert.equal(after.weeklyObjectives, "focused via refocus");
    assert.equal(after.tasks[0].id, "server-task-1");
});

test("initVisibilityReload: is idempotent (no duplicate listener registration)", async () => {
    await freshState(null);
    const countAfterInit = (documentStub._listeners["visibilitychange"] || []).length;

    StandardWorkState.initVisibilityReload();
    StandardWorkState.initVisibilityReload();

    const countAfterExtra = (documentStub._listeners["visibilitychange"] || []).length;
    assert.equal(countAfterExtra, countAfterInit, "no additional listeners should be registered");
});
