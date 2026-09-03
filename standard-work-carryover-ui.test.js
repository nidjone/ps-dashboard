// ============================================================
// Unit Tests — Carryover toggle UI and visual indicator
// Validates: Requirements 7.1, 7.4
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-status-toggle.test.js /
// standard-work-add-task-modal.test.js: standard-work-renderer.js is a browser
// script that manipulates real DOM APIs, so rather than pull in jsdom this
// file installs a minimal fake DOM covering the subset of the API the renderer
// actually touches (createElement, classList, dataset, appendChild,
// replaceChild, addEventListener/click, getElementById/querySelector). The
// business logic under test — the carryover button wiring in renderTaskRow,
// handleCarryoverToggle's delegation to StandardWorkState.toggleCarryover, and
// the targeted row re-render — is the real, unmodified implementation.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Minimal fake DOM ---

class FakeElement {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.style = {};
        this._className = "";
        this._attrs = {};
        this._listeners = {};
        this._text = "";
        this.value = "";
        this.checked = false;

        const self = this;
        this.classList = {
            add(cls) {
                const set = new Set(self._className.split(/\s+/).filter(Boolean));
                set.add(cls);
                self._className = [...set].join(" ");
            },
            remove(cls) {
                const set = new Set(self._className.split(/\s+/).filter(Boolean));
                set.delete(cls);
                self._className = [...set].join(" ");
            },
            contains(cls) {
                return self._className.split(/\s+/).filter(Boolean).includes(cls);
            },
        };
    }

    get className() {
        return this._className;
    }
    set className(v) {
        this._className = v;
    }

    get textContent() {
        return this._text;
    }
    set textContent(v) {
        this._text = String(v);
        this.children = [];
    }

    setAttribute(name, value) {
        this._attrs[name] = value;
    }
    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    }

    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    removeEventListener() {}

    // Simulates a real single-tap/click: browsers fire exactly one 'click'
    // event per tap on a <button> — no separate confirmation step.
    click() {
        (this._listeners.click || []).forEach((fn) => fn({ target: this, stopPropagation() {} }));
    }

    appendChild(child) {
        if (child.tagName === "#FRAGMENT") {
            for (const c of child.children) {
                this.children.push(c);
                c.parentNode = this;
            }
            child.children = [];
            return child;
        }
        this.children.push(child);
        child.parentNode = this;
        return child;
    }

    replaceChild(newChild, oldChild) {
        const idx = this.children.indexOf(oldChild);
        if (idx === -1) throw new Error("replaceChild: oldChild is not a child of this node");
        this.children[idx] = newChild;
        newChild.parentNode = this;
        oldChild.parentNode = null;
        return oldChild;
    }
}

function searchTree(node, predicate) {
    if (!node) return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) {
        const found = searchTree(child, predicate);
        if (found) return found;
    }
    return null;
}

function createFakeDocument() {
    const idMap = new Map();
    const roots = [];

    return {
        createElement(tag) {
            return new FakeElement(tag);
        },
        createDocumentFragment() {
            return new FakeElement("#fragment");
        },
        getElementById(id) {
            return idMap.get(id) || null;
        },
        querySelector(selector) {
            // `.sw-task-row[data-task-id="<id>"]`
            const m = /^\.([\w-]+)\[data-task-id="([^"]+)"\]$/.exec(selector);
            if (m) {
                const [, cls, taskId] = m;
                for (const root of roots) {
                    const found = searchTree(
                        root,
                        (el) => el.classList && el.classList.contains(cls) && el.dataset.taskId === taskId
                    );
                    if (found) return found;
                }
                return null;
            }
            const m2 = /^\.([\w-]+)$/.exec(selector);
            if (m2) {
                for (const root of roots) {
                    const found = searchTree(root, (el) => el.classList && el.classList.contains(m2[1]));
                    if (found) return found;
                }
            }
            return null;
        },
        _registerRoot(id, el) {
            idMap.set(id, el);
            roots.push(el);
        },
        addEventListener() {},
    };
}

// --- Install browser-shaped globals before requiring the modules under test ---
const fakeDocument = createFakeDocument();
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
global.document = fakeDocument;
global.fetch = () => Promise.reject(new Error("no network in test environment"));
global.AbortSignal = global.AbortSignal || { timeout: () => undefined };

global.StandardWorkData = require("./standard-work-data.js");
global.StandardWorkHistory = { saveShiftSnapshot: () => {} };

const StandardWorkState = require("./standard-work.js");
global.StandardWorkState = StandardWorkState;

const StandardWorkRenderer = require("./standard-work-renderer.js");

/**
 * Sets up a fresh StandardWorkState (default template) plus the KPI banner
 * containers and a registered daily "tasks-safety" section container —
 * mirroring the static markup in standard-work.html.
 */
async function setup() {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];

    await StandardWorkState.init();

    for (const id of [
        "tasks-safety",
        "section-safety",
        "count-safety",
        "kpi-daily-rate",
        "kpi-daily",
        "kpi-weekly-rate",
        "kpi-weekly",
        "kpi-monthly-rate",
        "kpi-monthly",
        "kpi-carryover-count",
    ]) {
        fakeDocument._registerRoot(id, fakeDocument.createElement("div"));
    }

    return { state: StandardWorkState.getState() };
}

/** Finds the carryover button (`.carryover-btn`) within a rendered row. */
function findCarryoverBtn(row) {
    const actions = (row.children || []).find((c) => c.classList && c.classList.contains("sw-task-actions"));
    if (!actions) return null;
    return (actions.children || []).find((c) => c.classList && c.classList.contains("carryover-btn")) || null;
}

test("carryover button: clicking it toggles the flag via toggleCarryover and the re-rendered row reflects the active state (Req 7.1, 7.4)", async () => {
    const { state } = await setup();

    const { task } = StandardWorkState.addTask("daily", "safety", { title: "Carryover test task" });
    StandardWorkRenderer.renderSection("safety", [task], state.dailyStatus);

    const container = fakeDocument.getElementById("tasks-safety");
    const row = container.children.find((r) => r.dataset.taskId === task.id);
    assert.ok(row, "task row should be present in the container");

    // Initially not flagged: no .carryover row class, button not .active.
    assert.equal(row.classList.contains("carryover"), false);
    const btn = findCarryoverBtn(row);
    assert.ok(btn, "daily task row should have a carryover button");
    assert.equal(btn.classList.contains("active"), false);

    // Tap the carryover button.
    btn.click();

    // State was flipped via StandardWorkState.toggleCarryover.
    assert.equal(state.dailyStatus[task.id].carryover, true, "carryover flag should be set on the status entry");

    // Targeted re-render swapped the row in place; the fresh row reflects the flag.
    const newRow = container.children.find((r) => r.dataset.taskId === task.id);
    assert.ok(newRow, "a re-rendered row should still be present");
    assert.equal(container.children.filter((r) => r.dataset.taskId === task.id).length, 1, "exactly one row should remain");
    assert.ok(newRow.classList.contains("carryover"), "row should gain the .carryover class when flagged (Req 7.4)");

    const newBtn = findCarryoverBtn(newRow);
    assert.ok(newBtn, "re-rendered row should still have a carryover button");
    assert.ok(newBtn.classList.contains("active"), "carryover button should be .active when flagged");

    // A visual carryover badge should be present in the meta area (Req 7.4).
    const badge = searchTreeAll(newRow, (el) => el.classList && el.classList.contains("sw-carryover-badge"));
    assert.ok(badge, "a .sw-carryover-badge should be rendered when flagged");
});

test("carryover button: toggling twice returns to the unflagged state", async () => {
    const { state } = await setup();

    const { task } = StandardWorkState.addTask("daily", "safety", { title: "Toggle-twice task" });
    StandardWorkRenderer.renderSection("safety", [task], state.dailyStatus);

    const container = fakeDocument.getElementById("tasks-safety");

    let row = container.children.find((r) => r.dataset.taskId === task.id);
    findCarryoverBtn(row).click();
    assert.equal(state.dailyStatus[task.id].carryover, true);

    row = container.children.find((r) => r.dataset.taskId === task.id);
    findCarryoverBtn(row).click();
    assert.equal(state.dailyStatus[task.id].carryover, false, "second toggle should clear the flag");

    row = container.children.find((r) => r.dataset.taskId === task.id);
    assert.equal(row.classList.contains("carryover"), false, "row should no longer carry the .carryover class");
    assert.equal(findCarryoverBtn(row).classList.contains("active"), false);
});

test("carryover button: NOT rendered for weekly tasks (carryover is daily-only)", async () => {
    const { state } = await setup();

    fakeDocument._registerRoot("tasks-weekly", fakeDocument.createElement("div"));
    fakeDocument._registerRoot("count-weekly", fakeDocument.createElement("div"));

    const { task } = StandardWorkState.addTask("weekly", "quality", { title: "Weekly carryover-less task" });
    StandardWorkRenderer.renderWeeklyMonthlySection("weekly", [task], state.weeklyStatus);

    const container = fakeDocument.getElementById("tasks-weekly");
    const row = container.children.find((r) => r.dataset.taskId === task.id);
    assert.ok(row, "weekly task row should be present");
    assert.equal(findCarryoverBtn(row), null, "weekly task row must NOT include a carryover button");
});

test("carryover button: NOT rendered for monthly tasks (carryover is daily-only)", async () => {
    const { state } = await setup();

    fakeDocument._registerRoot("tasks-monthly", fakeDocument.createElement("div"));
    fakeDocument._registerRoot("count-monthly", fakeDocument.createElement("div"));

    const { task } = StandardWorkState.addTask("monthly", "coaching", { title: "Monthly carryover-less task" });
    StandardWorkRenderer.renderWeeklyMonthlySection("monthly", [task], state.monthlyStatus);

    const container = fakeDocument.getElementById("tasks-monthly");
    const row = container.children.find((r) => r.dataset.taskId === task.id);
    assert.ok(row, "monthly task row should be present");
    assert.equal(findCarryoverBtn(row), null, "monthly task row must NOT include a carryover button");
});

// Local deep-search helper (returns the first matching descendant or null).
function searchTreeAll(node, predicate) {
    if (!node) return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) {
        const found = searchTreeAll(child, predicate);
        if (found) return found;
    }
    return null;
}
