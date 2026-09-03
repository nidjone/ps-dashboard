// ============================================================
// Unit Tests — Tab navigation + auto-refresh poll wiring
// Validates: Requirements 9.4, 11.2, 15.3
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-add-task-modal.test.js:
// standard-work-renderer.js manipulates real DOM APIs, so rather than pull in
// jsdom this file installs a minimal fake DOM covering the subset the tab-nav
// code touches (createElement, classList, dataset, querySelectorAll, addEventListener/click).
// The logic under test — initTabNavigation / activateTab and the
// startAutoRefresh / stopAutoRefresh interval management — is the real,
// unmodified implementation.

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
            if (id) idMap.set(id, el);
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
global.StandardWorkRenderer = StandardWorkRenderer;

// --- Tab navigation setup ---

/**
 * Registers the tab buttons + panels that would normally live in
 * standard-work.html, initializes state, and wires initTabNavigation().
 * Returns handles to the buttons and panels keyed by their tab id.
 */
async function setupTabs() {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];
    await StandardWorkState.init();

    const tabIds = ["daily-view", "weekly-monthly-view", "resources-view", "history-view"];
    const buttons = {};
    const panels = {};

    for (const id of tabIds) {
        // Tab button
        const btn = fakeDocument.createElement("button");
        btn.classList.add("sw-tab-btn");
        btn.dataset.tab = id;
        if (id === "daily-view") btn.classList.add("active");
        fakeDocument._registerRoot(null, btn);
        buttons[id] = btn;

        // Panel
        const panel = fakeDocument.createElement("section");
        panel.classList.add("sw-tab-panel");
        if (id === "daily-view") panel.classList.add("active");
        fakeDocument._registerRoot(id, panel);
        panels[id] = panel;
    }

    // Resources/History views refresh on activation; register their containers
    // so the renderers have somewhere to write (null-guarded, but present here).
    fakeDocument._registerRoot("resources-groups", fakeDocument.createElement("div"));
    fakeDocument._registerRoot("history-list", fakeDocument.createElement("div"));

    StandardWorkRenderer.initTabNavigation();

    return { buttons, panels };
}

test("initTabNavigation: only the daily tab/panel is active initially", async () => {
    const { buttons, panels } = await setupTabs();
    assert.ok(buttons["daily-view"].classList.contains("active"));
    assert.ok(panels["daily-view"].classList.contains("active"));
    assert.equal(buttons["resources-view"].classList.contains("active"), false);
    assert.equal(panels["resources-view"].classList.contains("active"), false);
});

test("clicking a tab button activates its panel and deactivates the others (Req 11.2)", async () => {
    const { buttons, panels } = await setupTabs();

    buttons["resources-view"].click();

    // Only resources-view button + panel active
    assert.ok(buttons["resources-view"].classList.contains("active"));
    assert.ok(panels["resources-view"].classList.contains("active"));

    for (const id of ["daily-view", "weekly-monthly-view", "history-view"]) {
        assert.equal(buttons[id].classList.contains("active"), false, `${id} button should be inactive`);
        assert.equal(panels[id].classList.contains("active"), false, `${id} panel should be inactive`);
    }
});

test("switching tabs moves the active class from the previously-active tab", async () => {
    const { buttons, panels } = await setupTabs();

    buttons["history-view"].click();
    assert.ok(panels["history-view"].classList.contains("active"));
    assert.equal(panels["daily-view"].classList.contains("active"), false);

    buttons["daily-view"].click();
    assert.ok(panels["daily-view"].classList.contains("active"));
    assert.equal(panels["history-view"].classList.contains("active"), false);
});

test("initTabNavigation is idempotent — a second call does not double-bind listeners", async () => {
    const { buttons, panels } = await setupTabs();

    // Call again; clicking should still result in exactly one active panel.
    StandardWorkRenderer.initTabNavigation();
    buttons["weekly-monthly-view"].click();

    const activePanels = ["daily-view", "weekly-monthly-view", "resources-view", "history-view"].filter(
        (id) => panels[id].classList.contains("active")
    );
    assert.deepEqual(activePanels, ["weekly-monthly-view"]);
});

// --- Auto-refresh poll ---

test("startAutoRefresh registers an interval and stopAutoRefresh clears it (Req 9.4, 15.3)", () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    let registeredInterval = null;
    let clearedInterval = null;
    let capturedFn = null;
    let capturedMs = null;

    global.setInterval = (fn, ms) => {
        capturedFn = fn;
        capturedMs = ms;
        registeredInterval = { id: 123 };
        return registeredInterval;
    };
    global.clearInterval = (id) => {
        clearedInterval = id;
    };

    try {
        const started = StandardWorkState.startAutoRefresh();
        assert.equal(started, true, "startAutoRefresh should report that a poll started");
        assert.ok(registeredInterval, "setInterval should have been called");
        assert.equal(capturedMs, 30000, "default interval should be 30000ms");
        assert.equal(typeof capturedFn, "function", "an interval callback should be registered");

        // Second call is a no-op while a poll is already running.
        const startedAgain = StandardWorkState.startAutoRefresh();
        assert.equal(startedAgain, false, "a second startAutoRefresh call should be a no-op");

        StandardWorkState.stopAutoRefresh();
        assert.equal(clearedInterval, registeredInterval, "stopAutoRefresh should clear the registered interval");

        // After stopping, startAutoRefresh can start a fresh poll again.
        const restarted = StandardWorkState.startAutoRefresh();
        assert.equal(restarted, true, "startAutoRefresh should start again after stopAutoRefresh");
        StandardWorkState.stopAutoRefresh();
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    }
});

test("startAutoRefresh accepts a custom interval", () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    let capturedMs = null;
    global.setInterval = (fn, ms) => {
        capturedMs = ms;
        return { id: 1 };
    };
    global.clearInterval = () => {};

    try {
        StandardWorkState.startAutoRefresh(5000);
        assert.equal(capturedMs, 5000);
        StandardWorkState.stopAutoRefresh();
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    }
});
