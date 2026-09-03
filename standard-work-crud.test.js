// ============================================================
// Unit Tests — StandardWorkState CRUD operations
// addTask, editTask, removeTask, reorderTask
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 15.1, 15.2
// ============================================================
//
// standard-work.js is written as a browser script (relies on the global
// `StandardWorkData`/`StandardWorkHistory`/`document`/`localStorage`/`fetch`
// bindings provided by <script> tags in standard-work.html). To exercise it
// under Node's test runner, minimal browser-shaped globals are installed
// before requiring the module — this only stubs the *environment* (DOM,
// storage, network), never the business logic under test.

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
global.document = {
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
};
global.fetch = () => Promise.reject(new Error("no network in test environment"));
global.AbortSignal = global.AbortSignal || { timeout: () => undefined };

global.StandardWorkData = require("./standard-work-data.js");
global.StandardWorkHistory = { saveShiftSnapshot: () => {} };

const StandardWorkState = require("./standard-work.js");

/**
 * Initializes StandardWorkState fresh (defaults to the built-in task
 * template since localStorage/server are both empty) before each test.
 */
async function freshState() {
    for (const key of Object.keys(fakeLocalStorageStore)) {
        delete fakeLocalStorageStore[key];
    }
    return StandardWorkState.init();
}

// ---------------------------------------------------------------
// addTask
// ---------------------------------------------------------------

test("addTask: generates a UUID, appends the task, and initializes a not_started status entry (Req 3.1, 3.2)", async () => {
    await freshState();
    const result = StandardWorkState.addTask("daily", "safety", { title: "New safety check" });

    assert.equal(result.success, true);
    assert.equal(typeof result.newTaskId, "string");
    assert.ok(result.newTaskId.length > 0);

    const state = StandardWorkState.getState();
    const task = state.tasks.find((t) => t.id === result.newTaskId);
    assert.ok(task, "task should be appended to state.tasks");
    assert.equal(task.title, "New safety check");
    assert.equal(task.category, "safety");
    assert.equal(task.frequency, "daily");

    const statusEntry = state.dailyStatus[result.newTaskId];
    assert.ok(statusEntry, "status entry should be initialized");
    assert.equal(statusEntry.status, "not_started");
    assert.equal(statusEntry.periodCompleted, null);
});

test("addTask: places the new task at the end of its frequency+category section (Req 3.3)", async () => {
    await freshState();
    const existingSafetyTasks = StandardWorkState.getState().tasks.filter(
        (t) => t.frequency === "daily" && t.category === "safety"
    );
    const maxExistingOrder = Math.max(...existingSafetyTasks.map((t) => t.sortOrder || 0));

    const result = StandardWorkState.addTask("daily", "safety", { title: "Trailing safety item" });
    const newTask = result.task;

    assert.equal(newTask.sortOrder, maxExistingOrder + 1);
});

test("addTask: rejects an empty title without throwing (Req 3.6, 15.1)", async () => {
    await freshState();
    const before = StandardWorkState.getState().tasks.length;

    const result = StandardWorkState.addTask("daily", "safety", { title: "" });

    assert.equal(result.success, false);
    assert.equal(typeof result.error, "string");
    assert.equal(StandardWorkState.getState().tasks.length, before, "no task should be added");
});

test("addTask: rejects a whitespace-only title (Req 3.6, 15.1)", async () => {
    await freshState();
    const result = StandardWorkState.addTask("daily", "safety", { title: "    \t  " });
    assert.equal(result.success, false);
});

test("addTask: rejects an invalid category (Req 15.2)", async () => {
    await freshState();
    const result = StandardWorkState.addTask("daily", "not-a-real-category", { title: "Valid title" });
    assert.equal(result.success, false);
    assert.match(result.error, /category/i);
});

// ---------------------------------------------------------------
// editTask
// ---------------------------------------------------------------

test("editTask: updates fields and refreshes updatedAt (Req 3.4)", async () => {
    await freshState();
    const { newTaskId } = StandardWorkState.addTask("daily", "safety", { title: "Original title" });
    const originalTask = StandardWorkState.getState().tasks.find((t) => t.id === newTaskId);
    const originalUpdatedAt = originalTask.updatedAt;

    // Ensure the timestamp has a chance to change
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = StandardWorkState.editTask(newTaskId, { title: "Updated title", notes: "Some notes" });

    assert.equal(result.success, true);
    assert.equal(result.task.title, "Updated title");
    assert.equal(result.task.notes, "Some notes");
    assert.notEqual(result.task.updatedAt, originalUpdatedAt);
});

test("editTask: rejects updating to an empty title (Req 15.1)", async () => {
    await freshState();
    const { newTaskId } = StandardWorkState.addTask("daily", "safety", { title: "Keep me" });
    const result = StandardWorkState.editTask(newTaskId, { title: "   " });

    assert.equal(result.success, false);
    const task = StandardWorkState.getState().tasks.find((t) => t.id === newTaskId);
    assert.equal(task.title, "Keep me", "title should remain unchanged on validation failure");
});

test("editTask: throws for a non-existent task ID", async () => {
    await freshState();
    assert.throws(() => StandardWorkState.editTask("does-not-exist", { title: "x" }));
});

// ---------------------------------------------------------------
// removeTask
// ---------------------------------------------------------------

test("removeTask: deletes the task and its status entry (Req 3.5)", async () => {
    await freshState();
    const { newTaskId } = StandardWorkState.addTask("daily", "safety", { title: "Temporary task" });

    const result = StandardWorkState.removeTask(newTaskId);
    assert.equal(result.success, true);

    const state = StandardWorkState.getState();
    assert.equal(state.tasks.find((t) => t.id === newTaskId), undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(state.dailyStatus, newTaskId), false);
});

test("removeTask: throws for a non-existent task ID", async () => {
    await freshState();
    assert.throws(() => StandardWorkState.removeTask("does-not-exist"));
});

// ---------------------------------------------------------------
// reorderTask
// ---------------------------------------------------------------

test("reorderTask: moves a task to a new position and renumbers siblings sequentially (Req 3.7)", async () => {
    await freshState();
    const a = StandardWorkState.addTask("daily", "operations", { title: "A" }).task;
    const b = StandardWorkState.addTask("daily", "operations", { title: "B" }).task;
    const c = StandardWorkState.addTask("daily", "operations", { title: "C" }).task;

    // Move C to the first position within the operations section (note: the
    // default template already seeds several daily/operations tasks, so the
    // full sibling set includes those too — reorderTask renumbers all of them).
    const result = StandardWorkState.reorderTask(c.id, 1);
    assert.equal(result.success, true);

    const allSiblings = StandardWorkState.getState().tasks
        .filter((t) => t.frequency === "daily" && t.category === "operations")
        .sort((x, y) => x.sortOrder - y.sortOrder);

    // C should now be first among all operations siblings
    assert.equal(allSiblings[0].id, c.id);

    // A should still precede B (relative order preserved for untouched tasks)
    const indexA = allSiblings.findIndex((t) => t.id === a.id);
    const indexB = allSiblings.findIndex((t) => t.id === b.id);
    assert.ok(indexA < indexB);

    // sortOrder values across the whole section should be sequential (1..N)
    for (let i = 1; i < allSiblings.length; i++) {
        assert.equal(allSiblings[i].sortOrder, allSiblings[i - 1].sortOrder + 1);
    }
});

test("reorderTask: clamps out-of-range positions instead of erroring", async () => {
    await freshState();
    const a = StandardWorkState.addTask("daily", "operations", { title: "A" }).task;
    const b = StandardWorkState.addTask("daily", "operations", { title: "B" }).task;

    const result = StandardWorkState.reorderTask(a.id, 9999);
    assert.equal(result.success, true);

    const state = StandardWorkState.getState();
    const taskA = state.tasks.find((t) => t.id === a.id);
    const taskB = state.tasks.find((t) => t.id === b.id);
    assert.ok(taskA.sortOrder > taskB.sortOrder, "A should now sort after B");
});

test("reorderTask: throws for a non-existent task ID", async () => {
    await freshState();
    assert.throws(() => StandardWorkState.reorderTask("does-not-exist", 1));
});

// ---------------------------------------------------------------
// toggleCarryover
// ---------------------------------------------------------------

test("toggleCarryover: flips the carryover flag on a daily task's status entry (Req 7.1)", async () => {
    await freshState();
    const { newTaskId } = StandardWorkState.addTask("daily", "safety", { title: "Carryover candidate" });

    const firstToggle = StandardWorkState.toggleCarryover(newTaskId);
    assert.equal(firstToggle.success, true);
    assert.equal(firstToggle.carryover, true);
    assert.equal(StandardWorkState.getState().dailyStatus[newTaskId].carryover, true);

    const secondToggle = StandardWorkState.toggleCarryover(newTaskId);
    assert.equal(secondToggle.success, true);
    assert.equal(secondToggle.carryover, false);
    assert.equal(StandardWorkState.getState().dailyStatus[newTaskId].carryover, false);
});

test("toggleCarryover: rejects weekly/monthly tasks (carryover is daily-only)", async () => {
    await freshState();
    const { newTaskId } = StandardWorkState.addTask("weekly", "quality", { title: "Weekly-only task" });

    const result = StandardWorkState.toggleCarryover(newTaskId);
    assert.equal(result.success, false);
    assert.match(result.error, /daily/i);
    assert.equal(
        Object.prototype.hasOwnProperty.call(StandardWorkState.getState().weeklyStatus[newTaskId], "carryover"),
        false
    );
});

test("toggleCarryover: throws for a non-existent task ID", async () => {
    await freshState();
    assert.throws(() => StandardWorkState.toggleCarryover("does-not-exist"));
});
