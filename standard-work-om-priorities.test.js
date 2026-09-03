// ============================================================
// Unit Tests — OM priority daily tasks + Metrics & Reports links
// Covers:
//   Part A — two new "Metrics & Reports" default resources, seeded into
//            fresh state and merged into legacy state via the
//            metricsResourcesV1 migration (deduped by URL).
//   Part B — the Engages/Adapts coaching-task split and the six new
//            OM-priority daily tasks, seeded into fresh state and merged into
//            legacy state via the omPriorityTasksV1 migration (deduped by title).
// ============================================================
//
// Follows the same fake-DOM/browser-shim approach as
// standard-work-resources.test.js: standard-work.js manipulates real
// DOM/storage/network APIs, so a minimal fake environment is installed before
// the modules are required. The migration + data-layer logic under test is the
// real, unmodified implementation.

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
    click() {}
    focus() {}

    appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
}

function createFakeDocument() {
    const idMap = new Map();
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
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
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

// --- Helpers ---

const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

function countByTitle(tasks, title) {
    return tasks.filter((t) => norm(t.title) === norm(title)).length;
}

function countByUrl(resources, url) {
    return resources.filter((r) => norm(r.url) === norm(url)).length;
}

function clearStorage() {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];
}

async function freshInit() {
    clearStorage();
    return StandardWorkState.init();
}

// The two new Metrics & Reports links (by URL) added in Part A.
const NEW_RESOURCE_URLS = [
    "https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/apps/744e92a0-5fb0-4a2f-a8d6-d9b873027eab/view/ORF3-IB-Input-Metrics-Tracker?qs-signin-user-auth=false&sso_login=true#",
    "https://vantage.amazon.com/app/home/404?redirectFrom=%2Fstow-dashboard&view=landing",
];

// The six new OM-priority daily tasks (by title) added in Part B.
const NEW_TASK_TITLES = [
    "Quality STUs \u2014 coach high-consistency low-quality stowers",
    "RBIs / ARCs / iCares / Dragonflys",
    "Submit Thrives (A to Z)",
    "GCAs \u2014 verify PA completion, call out when due",
    "Share PS staffing updates in Slack channels",
    "EYT tote count per floor \u2014 SOS count + EOS photos",
];

const OLD_COMBINED_TITLE = "Submit Engages and Adapts (A to Z)";
const ENGAGES_TITLE = "Submit Engages (A to Z)";
const ADAPTS_TITLE = "Submit Adapts (A to Z)";

// ---------------------------------------------------------------
// Part B — createInitialState: split + new tasks present
// ---------------------------------------------------------------

test("createInitialState splits Engages/Adapts and omits the old combined title", () => {
    const state = StandardWorkData.createInitialState();
    assert.equal(countByTitle(state.tasks, OLD_COMBINED_TITLE), 0, "combined title should be gone");
    assert.equal(countByTitle(state.tasks, ENGAGES_TITLE), 1, "exactly one Engages task");
    assert.equal(countByTitle(state.tasks, ADAPTS_TITLE), 1, "exactly one Adapts task");

    for (const title of [ENGAGES_TITLE, ADAPTS_TITLE]) {
        const task = state.tasks.find((t) => norm(t.title) === norm(title));
        assert.equal(task.category, "coaching");
        assert.equal(task.frequency, "daily");
        assert.equal(task.editable, false);
    }
});

test("createInitialState includes the six OM-priority tasks with correct categories/editable flags", () => {
    const state = StandardWorkData.createInitialState();

    const expected = {
        "Quality STUs \u2014 coach high-consistency low-quality stowers": { category: "quality", editable: true },
        "RBIs / ARCs / iCares / Dragonflys": { category: "safety", editable: false },
        "Submit Thrives (A to Z)": { category: "coaching", editable: false },
        "GCAs \u2014 verify PA completion, call out when due": { category: "coaching", editable: false },
        "Share PS staffing updates in Slack channels": { category: "staffing", editable: false },
        "EYT tote count per floor \u2014 SOS count + EOS photos": { category: "operations", editable: true },
    };

    for (const [title, meta] of Object.entries(expected)) {
        assert.equal(countByTitle(state.tasks, title), 1, `exactly one "${title}"`);
        const task = state.tasks.find((t) => norm(t.title) === norm(title));
        assert.equal(task.category, meta.category, `${title} category`);
        assert.equal(task.frequency, "daily", `${title} frequency`);
        assert.equal(task.editable, meta.editable, `${title} editable flag`);
    }
});

test("createInitialState keeps exactly one each of the KEEP items (TNL, SWCL, WHS huddle)", () => {
    const state = StandardWorkData.createInitialState();
    assert.equal(countByTitle(state.tasks, "Review and clear TNL"), 1);
    assert.equal(countByTitle(state.tasks, "Complete Standard Work Checklist"), 1);
    assert.equal(
        state.tasks.filter((t) => /whs huddle/i.test(t.title)).length,
        1,
        "exactly one WHS huddle task"
    );
    assert.equal(countByTitle(state.tasks, "Complete all necessary STUs"), 1);
});

test("createInitialState marks both seed migrations as already applied", () => {
    const state = StandardWorkData.createInitialState();
    assert.ok(state.migrations, "migrations object present");
    assert.equal(state.migrations.omPriorityTasksV1, true);
    assert.equal(state.migrations.metricsResourcesV1, true);
});

// ---------------------------------------------------------------
// Part A — createInitialState: new resources present
// ---------------------------------------------------------------

test("createInitialState resources include both new Metrics & Reports links", () => {
    const state = StandardWorkData.createInitialState();
    for (const url of NEW_RESOURCE_URLS) {
        assert.equal(countByUrl(state.resources, url), 1, `exactly one resource with url ${url}`);
        const res = state.resources.find((r) => norm(r.url) === norm(url));
        assert.equal(res.group, "Metrics & Reports");
    }
});

// ---------------------------------------------------------------
// Migration from a legacy state (both parts)
// ---------------------------------------------------------------

/**
 * Builds a valid state that looks like an OLD persisted state predating both
 * additions: no migrations flag, the old combined coaching task, none of the
 * six new tasks, and neither new resource.
 */
function makeLegacyState() {
    const state = StandardWorkData.createInitialState();

    // Make it look old.
    delete state.migrations;

    // Restore the OLD combined coaching task in place of the split pair.
    const engages = state.tasks.find((t) => norm(t.title) === norm(ENGAGES_TITLE));
    // Rename Engages -> combined, then drop Adapts.
    if (engages) engages.title = OLD_COMBINED_TITLE;
    state.tasks = state.tasks.filter((t) => norm(t.title) !== norm(ADAPTS_TITLE));

    // Remove the six new tasks and their status entries.
    for (const title of NEW_TASK_TITLES) {
        const removed = state.tasks.filter((t) => norm(t.title) === norm(title));
        for (const r of removed) delete state.dailyStatus[r.id];
        state.tasks = state.tasks.filter((t) => norm(t.title) !== norm(title));
    }

    // Remove the two new resources.
    state.resources = state.resources.filter(
        (r) => !NEW_RESOURCE_URLS.some((u) => norm(u) === norm(r.url))
    );

    return state;
}

test("init() migrates a legacy state: split, six tasks, both resources, flags set", async () => {
    clearStorage();
    const legacy = makeLegacyState();

    // Sanity: legacy really lacks everything.
    assert.equal(countByTitle(legacy.tasks, OLD_COMBINED_TITLE), 1);
    assert.equal(countByTitle(legacy.tasks, ADAPTS_TITLE), 0);
    for (const title of NEW_TASK_TITLES) assert.equal(countByTitle(legacy.tasks, title), 0);
    for (const url of NEW_RESOURCE_URLS) assert.equal(countByUrl(legacy.resources, url), 0);

    fakeLocalStorageStore[StandardWorkState.STORAGE_KEY] = JSON.stringify(legacy);

    const state = await StandardWorkState.init();

    // Split: combined renamed to Engages, and Adapts now exists.
    assert.equal(countByTitle(state.tasks, OLD_COMBINED_TITLE), 0, "combined title gone after migration");
    assert.equal(countByTitle(state.tasks, ENGAGES_TITLE), 1, "one Engages task");
    assert.equal(countByTitle(state.tasks, ADAPTS_TITLE), 1, "one Adapts task");

    // All six new tasks exist exactly once, each with a dailyStatus entry.
    for (const title of NEW_TASK_TITLES) {
        assert.equal(countByTitle(state.tasks, title), 1, `one "${title}"`);
        const task = state.tasks.find((t) => norm(t.title) === norm(title));
        assert.ok(state.dailyStatus[task.id], `dailyStatus entry for "${title}"`);
        assert.equal(state.dailyStatus[task.id].status, "not_started");
    }

    // Both resources present exactly once.
    for (const url of NEW_RESOURCE_URLS) {
        assert.equal(countByUrl(state.resources, url), 1, `one resource for ${url}`);
    }

    // Flags set.
    assert.equal(state.migrations.omPriorityTasksV1, true);
    assert.equal(state.migrations.metricsResourcesV1, true);
});

// ---------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------

test("a second init() creates no duplicates", async () => {
    clearStorage();
    fakeLocalStorageStore[StandardWorkState.STORAGE_KEY] = JSON.stringify(makeLegacyState());

    await StandardWorkState.init();
    const state = await StandardWorkState.init();

    assert.equal(countByTitle(state.tasks, ENGAGES_TITLE), 1);
    assert.equal(countByTitle(state.tasks, ADAPTS_TITLE), 1);
    for (const title of NEW_TASK_TITLES) assert.equal(countByTitle(state.tasks, title), 1);
    for (const url of NEW_RESOURCE_URLS) assert.equal(countByUrl(state.resources, url), 1);
});

test("deleting a seeded task/resource then re-init() does not resurrect it", async () => {
    clearStorage();
    fakeLocalStorageStore[StandardWorkState.STORAGE_KEY] = JSON.stringify(makeLegacyState());

    let state = await StandardWorkState.init();

    // Delete a seeded task and a seeded resource.
    const seededTask = state.tasks.find((t) => norm(t.title) === norm("Submit Thrives (A to Z)"));
    StandardWorkState.removeTask(seededTask.id);
    const seededRes = state.resources.find((r) => norm(r.url) === norm(NEW_RESOURCE_URLS[0]));
    StandardWorkState.removeResource(seededRes.id);

    // Persist the mutated state, then reload.
    fakeLocalStorageStore[StandardWorkState.STORAGE_KEY] = JSON.stringify(StandardWorkState.getState());
    state = await StandardWorkState.init();

    assert.equal(countByTitle(state.tasks, "Submit Thrives (A to Z)"), 0, "deleted task stays gone");
    assert.equal(countByUrl(state.resources, NEW_RESOURCE_URLS[0]), 0, "deleted resource stays gone");
});

// ---------------------------------------------------------------
// No-duplicate guard: pre-existing entries are not duplicated
// ---------------------------------------------------------------

test("pre-existing 'Submit Thrives (A to Z)' is not duplicated by migration", async () => {
    clearStorage();
    const legacy = makeLegacyState();

    // User already has a Thrives task (different id) before migration.
    const now = new Date().toISOString();
    const preId = "pre-existing-thrives";
    legacy.tasks.push({
        id: preId,
        title: "Submit Thrives (A to Z)",
        category: "coaching",
        frequency: "daily",
        notes: "",
        editable: false,
        editableField: null,
        carryover: false,
        sortOrder: 99,
        createdAt: now,
        updatedAt: now,
    });
    legacy.dailyStatus[preId] = { status: "in_progress", periodCompleted: null, notes: "mine" };

    fakeLocalStorageStore[StandardWorkState.STORAGE_KEY] = JSON.stringify(legacy);
    const state = await StandardWorkState.init();

    assert.equal(countByTitle(state.tasks, "Submit Thrives (A to Z)"), 1, "not duplicated");
    // The user's own task (and its status) is preserved.
    const kept = state.tasks.find((t) => t.id === preId);
    assert.ok(kept, "user's pre-existing task preserved");
    assert.equal(state.dailyStatus[preId].status, "in_progress");
});

test("pre-existing resource with a new URL is not duplicated by migration", async () => {
    clearStorage();
    const legacy = makeLegacyState();

    // User already has the QuickSight link (different id/label/group).
    const now = new Date().toISOString();
    legacy.resources.push({
        id: "pre-existing-qs",
        label: "My QuickSight bookmark",
        url: NEW_RESOURCE_URLS[0],
        group: "IT & Admin",
        sortOrder: 50,
        createdAt: now,
        updatedAt: now,
    });

    fakeLocalStorageStore[StandardWorkState.STORAGE_KEY] = JSON.stringify(legacy);
    const state = await StandardWorkState.init();

    assert.equal(countByUrl(state.resources, NEW_RESOURCE_URLS[0]), 1, "QuickSight link not duplicated");
    // The user's own entry (label/group) is preserved.
    const kept = state.resources.find((r) => r.id === "pre-existing-qs");
    assert.ok(kept, "user's pre-existing resource preserved");
    assert.equal(kept.label, "My QuickSight bookmark");
    // The second new link is still seeded (it was missing).
    assert.equal(countByUrl(state.resources, NEW_RESOURCE_URLS[1]), 1);
});
