// ============================================================
// Unit Tests — History/Trends view: snapshot display + import
// Validates: Requirements 8.3, 8.4, 8.5, 15.4
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-add-task-modal.test.js:
// standard-work-renderer.js is a browser script that manipulates real DOM
// APIs. Rather than pull in jsdom, this file installs a minimal fake DOM
// covering the subset of the API the history-view code touches
// (createElement, classList, dataset, textContent, querySelector(All),
// addEventListener/click/dispatch). StandardWorkHistory is required as a REAL
// module (not stubbed) and seeded with snapshots via saveShiftSnapshot before
// rendering.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Minimal fake DOM (mirrors standard-work-add-task-modal.test.js) ---

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
        this.files = null;

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

    click() {
        (this._listeners.click || []).forEach((fn) => fn({ target: this }));
    }

    dispatch(type, evt) {
        (this._listeners[type] || []).forEach((fn) => fn(evt));
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

function searchTree(node, predicate, results) {
    if (!node) return;
    if (predicate(node)) results.push(node);
    for (const child of node.children || []) {
        searchTree(child, predicate, results);
    }
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
            return this.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
            const results = [];
            const m2 = /^\.([\w-]+)$/.exec(selector);
            if (m2) {
                for (const root of roots) {
                    searchTree(root, (el) => el.classList && el.classList.contains(m2[1]), results);
                }
            }
            return results;
        },
        _registerRoot(id, el) {
            idMap.set(id, el);
            roots.push(el);
        },
        _reset() {
            idMap.clear();
            roots.length = 0;
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

// Real modules — StandardWorkHistory is NOT stubbed here.
global.StandardWorkData = require("./standard-work-data.js");
const StandardWorkHistory = require("./standard-work-history.js");
global.StandardWorkHistory = StandardWorkHistory;

const StandardWorkRenderer = require("./standard-work-renderer.js");

/**
 * A fake File-like object that the renderer's non-browser import path can
 * read via its `_text` string (since FileReader is undefined in Node).
 */
function fakeFile(text) {
    return { name: "history.json", _text: text };
}

/**
 * Registers the History tab markup that would normally live in
 * standard-work.html, resets the history store, seeds it with the given
 * snapshots, and wires the import/export controls.
 * @param {Object[]} [seedSnapshots]
 */
function setup(seedSnapshots) {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];
    fakeDocument._reset();

    // Reset the (real) history store to a known-empty state, then seed.
    StandardWorkHistory.importJSON("[]");
    for (const snap of seedSnapshots || []) {
        StandardWorkHistory.saveShiftSnapshot(snap.date, snap);
    }

    const els = {};
    function register(id, tag) {
        const el = fakeDocument.createElement(tag || "div");
        fakeDocument._registerRoot(id, el);
        els[id] = el;
        return el;
    }

    register("history-list");
    register("btn-export-sw-history", "button");
    register("btn-import-sw-history", "button");
    register("import-sw-history-file", "input");
    register("status-sw-history", "span");

    StandardWorkRenderer.initHistoryControls();

    return els;
}

function makeSnapshot(date, completionRate, taskCount, carryoverCount, weeklyObjectives) {
    return {
        date,
        shift: "day",
        weeklyObjectives: weeklyObjectives || "",
        completionRate,
        tasks: Array.from({ length: taskCount || 0 }, (_, i) => ({
            id: `t-${date}-${i}`,
            title: `Task ${i}`,
            category: "safety",
            status: "done",
            periodCompleted: 1,
            notes: "",
        })),
        carryoverItems: Array.from({ length: carryoverCount || 0 }, (_, i) => ({
            id: `c-${date}-${i}`,
            title: `Carryover ${i}`,
            reason: "",
        })),
    };
}

test("renderHistoryView renders one .sw-history-entry per snapshot with correct date/rate text (Req 8.3)", () => {
    const els = setup([
        makeSnapshot("2026-07-26", 80, 3, 1, ""),
        makeSnapshot("2026-07-27", 90, 5, 0, ""),
    ]);

    StandardWorkRenderer.renderHistoryView();

    const entries = fakeDocument.querySelectorAll(".sw-history-entry");
    assert.equal(entries.length, 2, "should render one entry per snapshot");

    // Most-recent-first ordering
    const dates = entries.map((e) => e.children.find((c) => c.classList.contains("sw-history-date")).textContent);
    assert.deepEqual(dates, ["2026-07-27", "2026-07-26"]);

    const rates = entries.map((e) => e.children.find((c) => c.classList.contains("sw-history-rate")).textContent);
    assert.deepEqual(rates, ["90%", "80%"]);

    // Meta line reflects task/carryover counts
    const firstMeta = entries[0].children.find((c) => c.classList.contains("sw-history-meta")).textContent;
    assert.match(firstMeta, /5 tasks/);
    assert.match(firstMeta, /0 carryovers/);
});

test("renderHistoryView shows an empty state when there are no snapshots (Req 8.3)", () => {
    const els = setup([]);

    StandardWorkRenderer.renderHistoryView();

    const entries = fakeDocument.querySelectorAll(".sw-history-entry");
    assert.equal(entries.length, 0, "no history entries when empty");

    const empty = fakeDocument.querySelector(".sw-empty-state");
    assert.ok(empty, "empty-state element should be rendered");
    const text = empty.children.find((c) => c.classList.contains("sw-empty-state-text"));
    assert.ok(text && text.textContent.length > 0);
});

test("importing valid JSON calls StandardWorkHistory.importJSON, re-renders, and shows success (Req 8.5)", () => {
    const els = setup([makeSnapshot("2026-07-20", 50, 2, 0, "")]);

    StandardWorkRenderer.renderHistoryView();
    assert.equal(fakeDocument.querySelectorAll(".sw-history-entry").length, 1);

    // A valid history payload with two new snapshots.
    const payload = JSON.stringify([
        makeSnapshot("2026-08-01", 100, 4, 0, "Focus on bin audits"),
        makeSnapshot("2026-08-02", 75, 4, 2, ""),
    ]);

    const fileInput = els["import-sw-history-file"];
    fileInput.files = [fakeFile(payload)];
    fileInput.dispatch("change", { target: fileInput });

    // importJSON replaces the store, so the view now shows the two imported entries.
    const entries = fakeDocument.querySelectorAll(".sw-history-entry");
    assert.equal(entries.length, 2, "view should re-render with imported snapshots");

    const status = els["status-sw-history"];
    assert.match(status.textContent, /imported/i);
    assert.equal(status.classList.contains("error"), false);
});

test("importing invalid JSON surfaces an error message and does not clobber the view (Req 8.5)", () => {
    const els = setup([makeSnapshot("2026-07-20", 50, 2, 0, "")]);

    StandardWorkRenderer.renderHistoryView();
    assert.equal(fakeDocument.querySelectorAll(".sw-history-entry").length, 1);

    const fileInput = els["import-sw-history-file"];
    fileInput.files = [fakeFile("this is not valid json {{{")];
    fileInput.dispatch("change", { target: fileInput });

    const status = els["status-sw-history"];
    assert.match(status.textContent, /failed/i);
    assert.ok(status.classList.contains("error"), "error class should be applied on failure");

    // The existing snapshot should still be there (import failed, no re-render clobber).
    const entries = fakeDocument.querySelectorAll(".sw-history-entry");
    assert.equal(entries.length, 1, "original entry preserved after failed import");
});

test("export button delegates to StandardWorkHistory.downloadExport (Req 8.4)", () => {
    const els = setup([makeSnapshot("2026-07-20", 50, 2, 0, "")]);

    const original = StandardWorkHistory.downloadExport;
    let calls = 0;
    StandardWorkHistory.downloadExport = (...args) => {
        calls++;
        return original.apply(StandardWorkHistory, args);
    };
    try {
        els["btn-export-sw-history"].click();
    } finally {
        StandardWorkHistory.downloadExport = original;
    }

    assert.equal(calls, 1, "clicking export should trigger downloadExport once");
    assert.match(els["status-sw-history"].textContent, /export/i);
});

test("history entry text is inserted via textContent (no child nodes from markup) (Req 15.4)", () => {
    const els = setup([makeSnapshot("2026-07-26", 80, 1, 0, "<script>alert(1)</script>")]);

    StandardWorkRenderer.renderHistoryView();

    const meta = fakeDocument.querySelector(".sw-history-meta");
    assert.ok(meta);
    // textContent setter clears children — markup can never become child nodes.
    assert.equal(meta.children.length, 0);
    assert.match(meta.textContent, /<script>/);
});
