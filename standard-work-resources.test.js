// ============================================================
// Unit Tests — Resources directory (data layer, CRUD, renderer)
// Covers: DEFAULT_RESOURCES seeding, addResource/editResource/
// removeResource, backward-compat back-fill on init(), and
// renderResourcesView output (hrefs + target/rel + XSS-safe text).
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-add-task-modal.test.js:
// standard-work.js and standard-work-renderer.js are browser scripts that
// manipulate real DOM/storage/network APIs. Rather than pull in jsdom, a
// minimal fake DOM/localStorage/fetch environment is installed before the
// modules are required. The business logic under test — the resource CRUD in
// StandardWorkState and renderResourcesView in StandardWorkRenderer — is the
// real, unmodified implementation.

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

    dispatch(type, evt) {
        (this._listeners[type] || []).forEach((fn) => fn(evt));
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
// confirm() defaults to true so remove flows proceed unless a test overrides it.
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

// ---------------------------------------------------------------
// Data layer — DEFAULT_RESOURCES + createInitialState
// ---------------------------------------------------------------

test("createInitialState includes a resources array seeded from DEFAULT_RESOURCES", () => {
    const state = StandardWorkData.createInitialState();
    assert.ok(Array.isArray(state.resources), "state should have a resources array");
    assert.equal(state.resources.length, StandardWorkData.DEFAULT_RESOURCES.length);

    // Every resource has id/label/url/group/sortOrder/timestamps
    for (const r of state.resources) {
        assert.equal(typeof r.id, "string");
        assert.ok(r.id.length > 0);
        assert.equal(typeof r.label, "string");
        // URLs are either absolute http(s) or an accepted scheme-less relative
        // path (e.g. the local "index.html" PS dashboard link).
        assert.ok(StandardWorkData.isAcceptedLinkUrl(r.url), `resource url accepted: ${r.url}`);
        assert.equal(typeof r.group, "string");
        assert.equal(typeof r.sortOrder, "number");
        assert.equal(typeof r.createdAt, "string");
        assert.equal(typeof r.updatedAt, "string");
    }

    // Every default group is represented
    for (const group of StandardWorkData.RESOURCE_GROUP_ORDER) {
        assert.ok(state.resources.some((r) => r.group === group), `group present: ${group}`);
    }
});

test("createDefaultResources assigns sequential sortOrder within each group", () => {
    const resources = StandardWorkData.createDefaultResources();
    const byGroup = {};
    for (const r of resources) {
        (byGroup[r.group] = byGroup[r.group] || []).push(r);
    }
    for (const group of Object.keys(byGroup)) {
        const orders = byGroup[group].map((r) => r.sortOrder).sort((a, b) => a - b);
        assert.deepEqual(orders, orders.map((_, i) => i + 1), `sortOrder is 1..n in ${group}`);
    }
    // Resource ids are unique across the whole set
    const ids = new Set(resources.map((r) => r.id));
    assert.equal(ids.size, resources.length);
});

test("RESOURCE_GROUP_ORDER lists the six groups in the expected order", () => {
    assert.deepEqual(StandardWorkData.RESOURCE_GROUP_ORDER, [
        "Staffing & Labor",
        "Metrics & Reports",
        "Standard Work",
        "Coaching & People",
        "Safety",
        "IT & Admin",
    ]);
});

// ---------------------------------------------------------------
// State manager — CRUD
// ---------------------------------------------------------------

test("getResources returns the seeded resources after init()", async () => {
    await freshState();
    const resources = StandardWorkState.getResources();
    assert.ok(Array.isArray(resources));
    assert.equal(resources.length, StandardWorkData.DEFAULT_RESOURCES.length);
});

test("addResource adds a resource with sortOrder at the end of its group", async () => {
    await freshState();
    const before = StandardWorkState.getResources().filter((r) => r.group === "Safety");
    const maxOrder = Math.max(...before.map((r) => r.sortOrder || 0));

    const result = StandardWorkState.addResource("Safety", { label: "New EHS tool", url: "https://example.com/ehs" });
    assert.equal(result.success, true);
    assert.equal(typeof result.newResourceId, "string");
    assert.equal(result.resource.group, "Safety");
    assert.equal(result.resource.sortOrder, maxOrder + 1);
    assert.equal(result.resource.label, "New EHS tool");
});

test("addResource rejects an empty label", async () => {
    await freshState();
    const before = StandardWorkState.getResources().length;
    const result = StandardWorkState.addResource("Safety", { label: "   ", url: "https://example.com" });
    assert.equal(result.success, false);
    assert.match(result.error, /label/i);
    assert.equal(StandardWorkState.getResources().length, before);
});

test("addResource rejects an empty url", async () => {
    await freshState();
    const result = StandardWorkState.addResource("Safety", { label: "Has label", url: "  " });
    assert.equal(result.success, false);
    assert.match(result.error, /url/i);
});

test("addResource rejects a non-http(s) url", async () => {
    await freshState();
    const before = StandardWorkState.getResources().length;
    const result = StandardWorkState.addResource("Safety", { label: "Sneaky", url: "javascript:alert(1)" });
    assert.equal(result.success, false);
    assert.match(result.error, /http/i);
    assert.equal(StandardWorkState.getResources().length, before, "no resource should be added");
});

test("editResource updates label/url/group and refreshes updatedAt", async () => {
    await freshState();
    const { newResourceId } = StandardWorkState.addResource("Safety", { label: "Old", url: "https://old.example.com" });
    const original = StandardWorkState.getResources().find((r) => r.id === newResourceId);
    const originalUpdatedAt = original.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = StandardWorkState.editResource(newResourceId, {
        label: "New label",
        url: "https://new.example.com",
        group: "IT & Admin",
    });
    assert.equal(result.success, true);
    assert.equal(result.resource.label, "New label");
    assert.equal(result.resource.url, "https://new.example.com");
    assert.equal(result.resource.group, "IT & Admin");
    assert.notEqual(result.resource.updatedAt, originalUpdatedAt);
});

test("editResource rejects an empty label and a bad url", async () => {
    await freshState();
    const { newResourceId } = StandardWorkState.addResource("Safety", { label: "Keep", url: "https://keep.example.com" });

    const emptyLabel = StandardWorkState.editResource(newResourceId, { label: "   " });
    assert.equal(emptyLabel.success, false);

    const badUrl = StandardWorkState.editResource(newResourceId, { url: "ftp://nope" });
    assert.equal(badUrl.success, false);

    const unchanged = StandardWorkState.getResources().find((r) => r.id === newResourceId);
    assert.equal(unchanged.label, "Keep");
    assert.equal(unchanged.url, "https://keep.example.com");
});

test("editResource throws for a non-existent id", async () => {
    await freshState();
    assert.throws(() => StandardWorkState.editResource("does-not-exist", { label: "x" }));
});

test("removeResource deletes the resource", async () => {
    await freshState();
    const { newResourceId } = StandardWorkState.addResource("Safety", { label: "Temp", url: "https://temp.example.com" });

    const result = StandardWorkState.removeResource(newResourceId);
    assert.equal(result.success, true);
    assert.equal(StandardWorkState.getResources().find((r) => r.id === newResourceId), undefined);
});

test("removeResource throws for a non-existent id", async () => {
    await freshState();
    assert.throws(() => StandardWorkState.removeResource("does-not-exist"));
});

// ---------------------------------------------------------------
// Backward compatibility — legacy state without a resources array
// ---------------------------------------------------------------

test("init() back-fills resources for a pre-existing state that has no resources array", async () => {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];

    // Simulate an older persisted state (valid schema, but predates resources).
    const legacy = StandardWorkData.createInitialState();
    delete legacy.resources;
    assert.equal(legacy.resources, undefined);
    fakeLocalStorageStore[StandardWorkState.STORAGE_KEY] = JSON.stringify(legacy);

    const state = await StandardWorkState.init();
    assert.ok(Array.isArray(state.resources), "resources should be seeded on load");
    assert.equal(state.resources.length, StandardWorkData.DEFAULT_RESOURCES.length);
    // The rest of the legacy state is preserved (still a valid, task-bearing state).
    assert.ok(Array.isArray(state.tasks) && state.tasks.length > 0);
});

// ---------------------------------------------------------------
// Renderer — renderResourcesView
// ---------------------------------------------------------------

test("renderResourcesView renders one row per resource with correct hrefs and safe link attributes", async () => {
    await freshState();

    const container = fakeDocument.createElement("div");
    fakeDocument._registerRoot("resources-groups", container);

    StandardWorkRenderer.renderResourcesView(StandardWorkState.getState());

    // Collect all rendered anchor links
    const links = [];
    searchTree(container, (el) => el.tagName === "A", links);

    const resources = StandardWorkState.getResources();
    assert.equal(links.length, resources.length, "one anchor per resource");

    // Every link opens in a new tab with a safe rel, and its href matches a resource url.
    const urls = new Set(resources.map((r) => r.url));
    for (const link of links) {
        assert.equal(link.getAttribute("target"), "_blank");
        assert.equal(link.getAttribute("rel"), "noopener noreferrer");
        assert.ok(urls.has(link.getAttribute("href")), "href matches a known resource url");
        // Label is inserted via textContent (no child nodes → not parsed as HTML)
        assert.equal(link.children.length, 0);
        assert.equal(typeof link.textContent, "string");
    }

    // One group section per group that has resources, count badge matches.
    const sections = [];
    searchTree(container, (el) => el.classList && el.classList.contains("sw-resource-group"), sections);
    assert.ok(sections.length >= StandardWorkData.RESOURCE_GROUP_ORDER.length - 1);
});

test("renderResourcesView renders a non-clickable span for a resource with an unsafe URL", async () => {
    await freshState();

    // Inject a resource with a bad URL directly into state (bypassing addResource's
    // validation) to exercise the renderer's defensive guard.
    const state = StandardWorkState.getState();
    state.resources.push({
        id: "unsafe-1",
        label: "Bad link",
        url: "javascript:alert(1)",
        group: "IT & Admin",
        sortOrder: 999,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    const container = fakeDocument.createElement("div");
    fakeDocument._registerRoot("resources-groups", container);
    StandardWorkRenderer.renderResourcesView(state);

    // The unsafe resource should NOT produce an anchor.
    const links = [];
    searchTree(container, (el) => el.tagName === "A", links);
    assert.ok(!links.some((l) => l.getAttribute("href") === "javascript:alert(1)"), "no anchor for unsafe url");

    // It should render as a disabled span instead.
    const disabled = [];
    searchTree(container, (el) => el.classList && el.classList.contains("sw-resource-link-disabled"), disabled);
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0].textContent, "Bad link");
});
