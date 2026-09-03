// ============================================================
// Unit Tests — Per-task quick links (data layer, CRUD, migration, renderer)
// Covers: createInitialState task links for mapped titles, addTask/editTask
// link validation, the taskLinksV1 back-fill migration, and renderTaskRow
// link-chip output (anchors with target=_blank rel=noopener + textContent).
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-resources.test.js:
// standard-work.js and standard-work-renderer.js are browser scripts that
// manipulate real DOM/storage/network APIs. Rather than pull in jsdom, a
// minimal fake DOM/localStorage/fetch environment is installed before the
// modules are required. The business logic under test — task-link CRUD in
// StandardWorkState and renderTaskRow in StandardWorkRenderer — is the real,
// unmodified implementation.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Minimal fake DOM (mirrors standard-work-resources.test.js) ---

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
        (this._listeners.click || []).forEach((fn) => fn({ target: this, stopPropagation() {} }));
    }

    focus() {}

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
global.confirm = () => true;

const StandardWorkData = require("./standard-work-data.js");
global.StandardWorkData = StandardWorkData;
global.StandardWorkHistory = { saveShiftSnapshot: () => {} };

const StandardWorkState = require("./standard-work.js");
global.StandardWorkState = StandardWorkState;

const StandardWorkRenderer = require("./standard-work-renderer.js");

/**
 * Initializes a fresh StandardWorkState (defaults, since storage/server are
 * empty) before each test.
 */
async function freshState() {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];
    return StandardWorkState.init();
}

// Titles (with the em-dash \u2014 used in the data layer) referenced below.
const TITLE_TNL = "Review and clear TNL";
const TITLE_METRICS_TRACKER = "Complete Inbound Metrics Tracker inputs";
const TITLE_SUPPORT_STAFFING = "Support staffing decisions (oversight/PA support)";

function findTaskByTitle(tasks, title) {
    return tasks.find((t) => t.title === title);
}

// ---------------------------------------------------------------
// Data layer — createInitialState carries links for mapped titles
// ---------------------------------------------------------------

test("createInitialState: mapped tasks carry the expected links; others default to []", () => {
    const state = StandardWorkData.createInitialState();

    // TNL task has exactly one link, labeled "TNL", to the fclm time-on-task URL.
    const tnl = findTaskByTitle(state.tasks, TITLE_TNL);
    assert.ok(tnl, "TNL task exists");
    assert.equal(tnl.links.length, 1);
    assert.equal(tnl.links[0].label, "TNL");
    assert.match(tnl.links[0].url, /^https:\/\/fclm-portal\.amazon\.com\/reports\/timeOnTask/);

    // Metrics Tracker task has two links.
    const metrics = findTaskByTitle(state.tasks, TITLE_METRICS_TRACKER);
    assert.ok(metrics, "Metrics Tracker task exists");
    assert.equal(metrics.links.length, 2);
    assert.deepEqual(
        metrics.links.map((l) => l.label),
        ["Metrics Tracker", "Metric Performance"]
    );
    for (const l of metrics.links) {
        assert.match(l.url, /^https?:\/\//);
    }

    // A task with no mapped links gets an empty array (never undefined).
    const support = findTaskByTitle(state.tasks, TITLE_SUPPORT_STAFFING);
    assert.ok(support, "support staffing task exists");
    assert.ok(Array.isArray(support.links));
    assert.equal(support.links.length, 0);

    // Every task has a links array.
    for (const task of state.tasks) {
        assert.ok(Array.isArray(task.links), `task "${task.title}" has a links array`);
    }
});

test("createInitialState: links reuse the exact URLs from DEFAULT_RESOURCES", () => {
    const state = StandardWorkData.createInitialState();
    const resourceUrls = new Set(StandardWorkData.DEFAULT_RESOURCES.map((r) => r.url));

    for (const task of state.tasks) {
        for (const link of task.links) {
            assert.ok(
                resourceUrls.has(link.url),
                `task link url should be reused verbatim from a resource: ${link.url}`
            );
        }
    }
});

// ---------------------------------------------------------------
// normalizeLinks / getDefaultTaskLinksByTitle helpers
// ---------------------------------------------------------------

test("normalizeLinks drops entries with a bad url or empty label, trims the rest", () => {
    const cleaned = StandardWorkData.normalizeLinks([
        { label: "Good", url: "https://example.com/a" },
        { label: "  Trimmed  ", url: "  http://example.com/b  " },
        { label: "Bad scheme", url: "javascript:alert(1)" },
        { label: "", url: "https://example.com/c" },
        { label: "No url", url: "" },
        "not-an-object",
        null,
    ]);
    assert.deepEqual(cleaned, [
        { label: "Good", url: "https://example.com/a" },
        { label: "Trimmed", url: "http://example.com/b" },
    ]);
    // Non-array input yields an empty array.
    assert.deepEqual(StandardWorkData.normalizeLinks(undefined), []);
    assert.deepEqual(StandardWorkData.normalizeLinks("nope"), []);
});

test("getDefaultTaskLinksByTitle maps normalized titles to links", () => {
    const map = StandardWorkData.getDefaultTaskLinksByTitle();
    assert.ok(map[TITLE_TNL.toLowerCase()], "TNL title is in the map");
    assert.equal(map[TITLE_TNL.toLowerCase()].length, 1);
    assert.equal(map[TITLE_METRICS_TRACKER.toLowerCase()].length, 2);
    // A title with no links isn't present in the map.
    assert.equal(map[TITLE_SUPPORT_STAFFING.toLowerCase()], undefined);
});

// ---------------------------------------------------------------
// State manager — addTask / editTask link handling
// ---------------------------------------------------------------

test("addTask accepts valid links and drops invalid link entries", async () => {
    await freshState();
    const result = StandardWorkState.addTask("daily", "metrics", {
        title: "Task with links",
        links: [
            { label: "Good", url: "https://example.com/ok" },
            { label: "Bad", url: "ftp://example.com/nope" },
            { label: "", url: "https://example.com/nolabel" },
        ],
    });
    assert.equal(result.success, true);
    // Only the single valid link survives; the whole add still succeeds.
    assert.equal(result.task.links.length, 1);
    assert.equal(result.task.links[0].label, "Good");
    assert.equal(result.task.links[0].url, "https://example.com/ok");
});

test("addTask defaults links to [] when none are provided", async () => {
    await freshState();
    const result = StandardWorkState.addTask("daily", "metrics", { title: "No links task" });
    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.task.links));
    assert.equal(result.task.links.length, 0);
});

test("editTask replaces the links array wholesale (with per-link validation)", async () => {
    await freshState();
    const { newTaskId } = StandardWorkState.addTask("daily", "metrics", {
        title: "Editable links task",
        links: [{ label: "First", url: "https://example.com/first" }],
    });

    const result = StandardWorkState.editTask(newTaskId, {
        links: [
            { label: "Replaced", url: "https://example.com/replaced" },
            // A dangerous-scheme url is still dropped (contains a colon, so it
            // matches neither http(s) nor the scheme-less relative-path rule).
            { label: "Dropped", url: "javascript:alert(1)" },
        ],
    });
    assert.equal(result.success, true);
    assert.equal(result.task.links.length, 1);
    assert.equal(result.task.links[0].label, "Replaced");
    assert.equal(result.task.links[0].url, "https://example.com/replaced");

    // Editing with an empty array clears the links.
    const cleared = StandardWorkState.editTask(newTaskId, { links: [] });
    assert.equal(cleared.success, true);
    assert.equal(cleared.task.links.length, 0);
});

// ---------------------------------------------------------------
// Migration — migrateTaskLinksV1 back-fill
// ---------------------------------------------------------------

test("migrateTaskLinksV1 back-fills default links, preserves customized links, and is idempotent", () => {
    // Build a legacy state: strip links + the taskLinksV1 flag, and give one
    // matching task a custom link that must be preserved.
    const legacy = StandardWorkData.createInitialState();
    delete legacy.migrations.taskLinksV1;
    for (const task of legacy.tasks) {
        delete task.links;
    }
    const tnl = findTaskByTitle(legacy.tasks, TITLE_TNL);
    const metrics = findTaskByTitle(legacy.tasks, TITLE_METRICS_TRACKER);
    // The Metrics Tracker task already has a custom link — must NOT be overwritten.
    metrics.links = [{ label: "My custom link", url: "https://custom.example.com" }];

    const ran = StandardWorkState.migrateTaskLinksV1(legacy);
    assert.equal(ran, true, "migration runs for a legacy state");
    assert.equal(legacy.migrations.taskLinksV1, true, "flag is set after running");

    // The TNL task (no prior links) gets the default back-filled.
    const tnlAfter = findTaskByTitle(legacy.tasks, TITLE_TNL);
    assert.equal(tnlAfter.links.length, 1);
    assert.equal(tnlAfter.links[0].label, "TNL");

    // The customized task is left untouched.
    const metricsAfter = findTaskByTitle(legacy.tasks, TITLE_METRICS_TRACKER);
    assert.equal(metricsAfter.links.length, 1);
    assert.equal(metricsAfter.links[0].label, "My custom link");

    // Every task ends up with a links array (unmapped ones become []).
    for (const task of legacy.tasks) {
        assert.ok(Array.isArray(task.links), `task "${task.title}" normalized to a links array`);
    }
    const support = findTaskByTitle(legacy.tasks, TITLE_SUPPORT_STAFFING);
    assert.equal(support.links.length, 0);

    // Idempotent: a second run is a no-op and reports no change.
    const ranAgain = StandardWorkState.migrateTaskLinksV1(legacy);
    assert.equal(ranAgain, false, "second run does nothing");
    assert.equal(findTaskByTitle(legacy.tasks, TITLE_TNL).links.length, 1);
    assert.equal(findTaskByTitle(legacy.tasks, TITLE_METRICS_TRACKER).links[0].label, "My custom link");
});

test("migrateTaskLinksV1 is a no-op on a fresh state (flag already set)", () => {
    const fresh = StandardWorkData.createInitialState();
    assert.equal(fresh.migrations.taskLinksV1, true);
    const ran = StandardWorkState.migrateTaskLinksV1(fresh);
    assert.equal(ran, false);
});

// ---------------------------------------------------------------
// Renderer — renderTaskRow link chips
// ---------------------------------------------------------------

test("renderTaskRow renders one anchor per link with target/rel and textContent label", () => {
    const task = {
        id: "t1",
        title: "Task with two links",
        category: "metrics",
        frequency: "daily",
        editable: false,
        editableField: null,
        links: [
            { label: "Metrics Tracker", url: "https://example.com/metrics" },
            { label: "Metric Performance", url: "https://example.com/perf" },
        ],
    };

    const row = StandardWorkRenderer.renderTaskRow(task, { status: "not_started" });

    const anchors = [];
    searchTree(row, (el) => el.tagName === "A" && el.classList.contains("sw-task-link"), anchors);
    assert.equal(anchors.length, 2, "one anchor per link");

    assert.equal(anchors[0].textContent, "Metrics Tracker");
    assert.equal(anchors[0].getAttribute("href"), "https://example.com/metrics");
    assert.equal(anchors[0].getAttribute("target"), "_blank");
    assert.equal(anchors[0].getAttribute("rel"), "noopener noreferrer");
    // Label inserted via textContent (no child nodes → not parsed as HTML).
    assert.equal(anchors[0].children.length, 0);

    assert.equal(anchors[1].textContent, "Metric Performance");
    assert.equal(anchors[1].getAttribute("href"), "https://example.com/perf");

    // A .sw-task-links wrapper holds the chips.
    const wrappers = [];
    searchTree(row, (el) => el.classList && el.classList.contains("sw-task-links"), wrappers);
    assert.equal(wrappers.length, 1);
});

test("renderTaskRow renders no link chips for a task with empty links", () => {
    const task = {
        id: "t2",
        title: "No links task",
        category: "metrics",
        frequency: "daily",
        editable: false,
        editableField: null,
        links: [],
    };

    const row = StandardWorkRenderer.renderTaskRow(task, { status: "not_started" });

    const anchors = [];
    searchTree(row, (el) => el.tagName === "A" && el.classList.contains("sw-task-link"), anchors);
    assert.equal(anchors.length, 0, "no link chips when links is empty");

    const wrappers = [];
    searchTree(row, (el) => el.classList && el.classList.contains("sw-task-links"), wrappers);
    assert.equal(wrappers.length, 0, "no .sw-task-links wrapper when there are no links");
});

test("renderTaskRow skips a chip for a link with an unsafe url", () => {
    const task = {
        id: "t3",
        title: "Mixed links task",
        category: "metrics",
        frequency: "daily",
        editable: false,
        editableField: null,
        links: [
            { label: "Safe", url: "https://example.com/safe" },
            { label: "Unsafe", url: "javascript:alert(1)" },
        ],
    };

    const row = StandardWorkRenderer.renderTaskRow(task, { status: "not_started" });

    const anchors = [];
    searchTree(row, (el) => el.tagName === "A" && el.classList.contains("sw-task-link"), anchors);
    assert.equal(anchors.length, 1, "only the safe link renders as an anchor");
    assert.equal(anchors[0].getAttribute("href"), "https://example.com/safe");
});
