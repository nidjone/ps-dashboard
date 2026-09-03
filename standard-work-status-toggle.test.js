// ============================================================
// Unit Tests — Task status toggle interaction (single-tap cycling)
// Validates: Requirements 2.1, 11.3, 11.5
// ============================================================
//
// standard-work-renderer.js is written as a browser script that builds DOM
// nodes via document.createElement/appendChild/replaceChild etc. To exercise
// the click-to-cycle-status wiring under Node's test runner without adding
// a jsdom dependency, this file installs a minimal fake DOM: elements
// support the small subset of the DOM API the renderer actually uses
// (createElement, appendChild, replaceChild, classList, dataset,
// addEventListener/click, querySelector for the exact selector shape used
// in standard-work-renderer.js). This stubs the *environment* only — the
// business logic under test (StandardWorkState.updateTaskStatus and the
// renderer's targeted re-render) is the real, unmodified implementation.

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
    // event per tap on a <button> — no separate confirmation step (Req 11.3).
    click() {
        (this._listeners.click || []).forEach((fn) => fn());
    }

    appendChild(child) {
        // Appending a fragment moves its children into this element and
        // empties the fragment, matching real DOM semantics.
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
            // Only pattern actually used by standard-work-renderer.js:
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
        // Test-only helper to register the static container elements that
        // would normally already exist in standard-work.html.
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
 * Sets up: a fresh StandardWorkState (default template), the KPI banner
 * containers, and one registered "tasks-<category>" section container —
 * mirroring the static markup in standard-work.html — then adds a single
 * known daily task into it and renders it.
 */
async function setup() {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];

    const state = await StandardWorkState.init();

    // Register static container elements normally provided by standard-work.html
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

    const { task } = StandardWorkState.addTask("daily", "safety", { title: "Toggle test task" });

    StandardWorkRenderer.renderSection("safety", [task], StandardWorkState.getState().dailyStatus);

    const container = fakeDocument.getElementById("tasks-safety");
    return { state: StandardWorkState.getState(), task, container };
}

function getBadge(container, taskId) {
    const row = container.children.find((r) => r.dataset.taskId === taskId);
    assert.ok(row, "task row should be present in the container");
    const badge = row.children[0];
    assert.ok(badge.classList, "badge should be the row's first child");
    return { row, badge };
}

test("status toggle: cycles not_started -> in_progress -> done -> na -> not_started on each tap (Req 2.1)", async () => {
    const { container, task, state } = await setup();

    const expectedCycle = ["in_progress", "done", "na", "not_started"];
    for (const expectedStatus of expectedCycle) {
        const { badge } = getBadge(container, task.id);
        badge.click();
        assert.equal(state.dailyStatus[task.id].status, expectedStatus);

        const { badge: updatedBadge } = getBadge(container, task.id);
        assert.ok(updatedBadge.classList.contains(expectedStatus), `badge should carry the '${expectedStatus}' class`);
    }
});

test("status toggle: a single click is sufficient — no double-tap/confirmation required (Req 11.3)", async () => {
    const { container, task, state } = await setup();

    const { badge } = getBadge(container, task.id);
    assert.equal(badge.tagName, "BUTTON");
    // Exactly one 'click' listener is registered — no dblclick handler and
    // no confirm()/modal step gating the status change.
    assert.equal((badge._listeners.click || []).length, 1);
    assert.equal(badge._listeners.dblclick, undefined);

    badge.click();
    assert.equal(state.dailyStatus[task.id].status, "in_progress", "a single click should register the change immediately");
});

test("status toggle: re-renders only the affected row, never the whole page (Req 11.5)", async () => {
    const { container, task } = await setup();

    const originalRow = container.children.find((r) => r.dataset.taskId === task.id);

    let renderAllCalls = 0;
    let renderSectionCalls = 0;
    const originalRenderAll = StandardWorkRenderer.renderAll;
    const originalRenderSection = StandardWorkRenderer.renderSection;
    StandardWorkRenderer.renderAll = (...args) => {
        renderAllCalls++;
        return originalRenderAll(...args);
    };
    StandardWorkRenderer.renderSection = (...args) => {
        renderSectionCalls++;
        return originalRenderSection(...args);
    };

    try {
        const { badge } = getBadge(container, task.id);
        badge.click();
    } finally {
        StandardWorkRenderer.renderAll = originalRenderAll;
        StandardWorkRenderer.renderSection = originalRenderSection;
    }

    assert.equal(renderAllCalls, 0, "a status tap must not trigger a full-page renderAll()");
    assert.equal(renderSectionCalls, 0, "a status tap must not trigger a full-section renderSection()");

    // Exactly one row for this task should exist in the container (the old
    // row was swapped out via replaceChild, not appended alongside it).
    const matchingRows = container.children.filter((r) => r.dataset.taskId === task.id);
    assert.equal(matchingRows.length, 1, "exactly one row for the task should remain in the DOM");
    assert.notEqual(matchingRows[0], originalRow, "the row should be a freshly rendered replacement, not the original node");
});
