// ============================================================
// Property-Based Tests — AM Standard Work Dashboard
// Property 2: Task ID uniqueness
// Validates: Requirements 3.1
// ============================================================
//
// NOTE: StandardWorkState.addTask() has not been implemented yet (see
// spec task 4.1). Until it exists, this test exercises the same ID
// generation/append logic described in design.md's `addTask` algorithm
// (Component 1: State Manager) via `simulateAddTask` below, which is a
// direct port of that pseudocode built on the real
// `StandardWorkData.generateUUID()` function. Once task 4.1 lands,
// `simulateAddTask` can be swapped for a call to
// `StandardWorkState.addTask()` against a real state object without
// changing the property assertions.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fc = require("fast-check");
const StandardWorkData = require("./standard-work-data.js");

/**
 * Mirrors the `addTask` algorithm from design.md: generates a UUID via
 * StandardWorkData.generateUUID(), computes sortOrder within the
 * frequency+category section, and appends the new task to `tasks`.
 *
 * @param {Array<Object>} tasks - Mutable task list to append to
 * @param {string} frequency - 'daily' | 'weekly' | 'monthly'
 * @param {string} category - Task category
 * @param {{title: string, notes?: string, editable?: boolean, editableField?: string}} taskData
 * @returns {Object} The newly created task
 */
function simulateAddTask(tasks, frequency, category, taskData) {
    const id = StandardWorkData.generateUUID();
    const now = new Date().toISOString();

    const sameSectionTasks = tasks.filter(
        (t) => t.frequency === frequency && t.category === category
    );
    const maxOrder = sameSectionTasks.length > 0
        ? Math.max(...sameSectionTasks.map((t) => t.sortOrder || 0))
        : 0;

    const newTask = {
        id,
        title: taskData.title,
        category,
        frequency,
        notes: taskData.notes || "",
        editable: taskData.editable || false,
        editableField: taskData.editableField || null,
        carryover: false,
        sortOrder: maxOrder + 1,
        createdAt: now,
        updatedAt: now,
    };

    tasks.push(newTask);
    return newTask;
}

test("Property 2: Task ID uniqueness — any sequence of addTask operations yields unique IDs (Validates: Requirements 3.1)", () => {
    fc.assert(
        fc.property(
            fc.array(
                fc.record({
                    frequency: fc.constantFrom(...StandardWorkData.VALID_FREQUENCIES),
                    category: fc.constantFrom(...StandardWorkData.VALID_CATEGORIES),
                    title: fc.string({ minLength: 1, maxLength: 40 }),
                }),
                { minLength: 0, maxLength: 200 }
            ),
            (operations) => {
                const tasks = [];
                for (const op of operations) {
                    simulateAddTask(tasks, op.frequency, op.category, { title: op.title });
                }
                const ids = tasks.map((t) => t.id);
                assert.equal(ids.length, new Set(ids).size);
            }
        ),
        { numRuns: 200 }
    );
});

test("Property 2: Task ID uniqueness holds when adding onto an already-populated task list (Validates: Requirements 3.1)", () => {
    fc.assert(
        fc.property(
            fc.array(fc.constantFrom(...StandardWorkData.VALID_CATEGORIES), { minLength: 1, maxLength: 50 }),
            (categories) => {
                // Start from the default task template, which already has generated IDs.
                const initialState = StandardWorkData.createInitialState();
                const tasks = initialState.tasks.slice();

                for (const category of categories) {
                    simulateAddTask(tasks, "daily", category, { title: "New task" });
                }

                const ids = tasks.map((t) => t.id);
                assert.equal(ids.length, new Set(ids).size);
            }
        ),
        { numRuns: 100 }
    );
});

// ============================================================
// Property-Based Tests — AM Standard Work Dashboard
// Property 4: Completion rate bounds
// Validates: Requirements 6.3
// ============================================================
//
// standard-work.js is written as a browser script (relies on globals like
// `document`/`localStorage`/`fetch`/`StandardWorkData`/`StandardWorkHistory`
// provided by <script> tags in standard-work.html). To exercise
// `computeCompletionStats` under Node's test runner, minimal browser-shaped
// globals are installed before requiring the module — this only stubs the
// *environment* (DOM, storage, network), never the business logic under test.
// See standard-work-crud.test.js for the same shimming pattern.

{
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
    global.StandardWorkData = global.StandardWorkData || StandardWorkData;
    global.StandardWorkHistory = global.StandardWorkHistory || { saveShiftSnapshot: () => {} };
}

const StandardWorkState = require("./standard-work.js");

/**
 * Builds an arbitrary StandardWorkState-shaped object with a random number
 * of daily/weekly/monthly tasks, each assigned a random Task_Status (including
 * 'na'). Some tasks are randomly given no status entry at all, to also
 * exercise the "missing entry defaults to not_started" path in
 * `computeCompletionStats`.
 */
const completionStateArb = fc
    .array(
        fc.record({
            frequency: fc.constantFrom(...StandardWorkData.VALID_FREQUENCIES),
            status: fc.constantFrom(...StandardWorkData.VALID_STATUSES),
            hasStatusEntry: fc.boolean(),
        }),
        { minLength: 0, maxLength: 150 }
    )
    .map((entries) => {
        const tasks = [];
        const dailyStatus = {};
        const weeklyStatus = {};
        const monthlyStatus = {};

        entries.forEach((entry, i) => {
            const id = `task-${i}`;
            tasks.push({
                id,
                title: `Task ${i}`,
                category: StandardWorkData.VALID_CATEGORIES[i % StandardWorkData.VALID_CATEGORIES.length],
                frequency: entry.frequency,
                sortOrder: i,
            });

            if (!entry.hasStatusEntry) return; // leave this task with no status entry

            const statusEntry = { status: entry.status, periodCompleted: null, notes: "" };
            if (entry.frequency === "daily") {
                dailyStatus[id] = statusEntry;
            } else if (entry.frequency === "weekly") {
                weeklyStatus[id] = statusEntry;
            } else {
                monthlyStatus[id] = statusEntry;
            }
        });

        return { tasks, dailyStatus, weeklyStatus, monthlyStatus };
    });

test("Property 4: Completion rate bounds — computeCompletionStats always returns rates in [0, 100] (Validates: Requirements 6.3)", () => {
    fc.assert(
        fc.property(completionStateArb, (state) => {
            const stats = StandardWorkState.computeCompletionStats(state);

            assert.ok(stats.daily.rate >= 0 && stats.daily.rate <= 100, `daily rate out of bounds: ${stats.daily.rate}`);
            assert.ok(stats.weekly.rate >= 0 && stats.weekly.rate <= 100, `weekly rate out of bounds: ${stats.weekly.rate}`);
            assert.ok(stats.monthly.rate >= 0 && stats.monthly.rate <= 100, `monthly rate out of bounds: ${stats.monthly.rate}`);
        }),
        { numRuns: 200 }
    );
});

test("Property 4: Completion rate bounds — rate is 0 when every applicable task is 'na' (Validates: Requirements 6.3)", () => {
    fc.assert(
        fc.property(
            fc.array(fc.constantFrom(...StandardWorkData.VALID_FREQUENCIES), { minLength: 1, maxLength: 30 }),
            (frequencies) => {
                const tasks = [];
                const dailyStatus = {};
                const weeklyStatus = {};
                const monthlyStatus = {};

                frequencies.forEach((frequency, i) => {
                    const id = `na-task-${i}`;
                    tasks.push({ id, title: `NA Task ${i}`, category: "safety", frequency, sortOrder: i });
                    const statusEntry = { status: "na", periodCompleted: null, notes: "" };
                    if (frequency === "daily") dailyStatus[id] = statusEntry;
                    else if (frequency === "weekly") weeklyStatus[id] = statusEntry;
                    else monthlyStatus[id] = statusEntry;
                });

                const stats = StandardWorkState.computeCompletionStats({ tasks, dailyStatus, weeklyStatus, monthlyStatus });
                assert.equal(stats.daily.rate, 0);
                assert.equal(stats.weekly.rate, 0);
                assert.equal(stats.monthly.rate, 0);
            }
        ),
        { numRuns: 100 }
    );
});
