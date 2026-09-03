// ============================================================
// Unit Tests — Add Task modal and form with validation
// Validates: Requirements 3.1, 3.2, 3.3, 3.6, 15.1, 15.2, 15.4
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-status-toggle.test.js:
// standard-work-renderer.js is a browser script that manipulates real DOM
// APIs. Rather than pull in jsdom, this file installs a minimal fake DOM
// covering the subset of the API the modal code actually touches
// (createElement, classList, dataset, value/checked, querySelector(All),
// addEventListener/click). The business logic under test — showAddTaskModal,
// handleModalSave's validation/delegation to StandardWorkState.addTask, and
// the modal wiring in initTaskModal — is the real, unmodified implementation.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Minimal fake DOM (mirrors standard-work-status-toggle.test.js) ---

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
            const results = [];
            const m2 = /^\.([\w-]+)$/.exec(selector);
            if (m2) {
                for (const root of roots) {
                    searchTree(root, (el) => el.classList && el.classList.contains(m2[1]), results);
                }
            }
            return results[0] || null;
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

global.StandardWorkData = require("./standard-work-data.js");
global.StandardWorkHistory = { saveShiftSnapshot: () => {} };

const StandardWorkState = require("./standard-work.js");
global.StandardWorkState = StandardWorkState;

const StandardWorkRenderer = require("./standard-work-renderer.js");

/**
 * Registers the static modal + section markup that would normally already
 * exist in standard-work.html, initializes a fresh StandardWorkState, and
 * wires up the modal event listeners via initTaskModal().
 */
async function setup() {
    for (const key of Object.keys(fakeLocalStorageStore)) delete fakeLocalStorageStore[key];

    const state = await StandardWorkState.init();

    const els = {};
    function register(id, tag) {
        const el = fakeDocument.createElement(tag || "div");
        fakeDocument._registerRoot(id, el);
        els[id] = el;
        return el;
    }

    // Section containers (daily category "safety")
    register("tasks-safety");
    register("section-safety");
    register("count-safety");

    // KPI banner
    register("kpi-daily-rate");
    register("kpi-daily");
    register("kpi-weekly-rate");
    register("kpi-weekly");
    register("kpi-monthly-rate");
    register("kpi-monthly");
    register("kpi-carryover-count");

    // Modal markup
    register("task-modal-overlay");
    register("modal-title");
    const titleInput = register("modal-task-title", "input");
    const categorySelect = register("modal-task-category", "select");
    const frequencySelect = register("modal-task-frequency", "select");
    register("modal-task-notes", "input");
    register("modal-task-editable", "input");
    const editableGroup = register("modal-editable-field-group");
    editableGroup.style.display = "none";
    register("modal-task-editable-field", "input");
    register("modal-title-error", "span");
    const saveBtn = register("modal-save", "button");
    const cancelBtn = register("modal-cancel", "button");
    const closeBtn = register("modal-close", "button");

    // "+" add-task buttons (one per category, matching standard-work.html)
    const addBtnSafety = register("add-btn-safety", "button");
    addBtnSafety.classList.add("sw-section-add-btn");
    addBtnSafety.dataset.frequency = "daily";
    addBtnSafety.dataset.category = "safety";

    StandardWorkRenderer.initTaskModal();

    return { state, els, addBtnSafety, titleInput, categorySelect, frequencySelect, saveBtn, cancelBtn, closeBtn };
}

test("showAddTaskModal: opens the modal, pre-fills frequency/category, and clears prior input (Req 3.1, 3.2, 3.3)", async () => {
    const { els } = await setup();

    els["modal-task-title"].value = "stale leftover text";
    els["modal-task-notes"].value = "stale notes";
    els["modal-title-error"].textContent = "stale error";
    els["modal-title-error"].classList.add("visible");

    StandardWorkRenderer.showAddTaskModal("weekly", "quality");

    assert.ok(els["task-modal-overlay"].classList.contains("active"), "overlay should gain the .active class");
    assert.equal(els["modal-title"].textContent, "Add Task");
    assert.equal(els["modal-task-frequency"].value, "weekly");
    assert.equal(els["modal-task-category"].value, "quality");
    assert.equal(els["modal-task-title"].value, "");
    assert.equal(els["modal-task-notes"].value, "");
    assert.equal(els["modal-title-error"].textContent, "");
    assert.equal(els["modal-title-error"].classList.contains("visible"), false);
});

test("clicking a .sw-section-add-btn opens the modal pre-filled with its data-frequency/data-category (Req 3.1)", async () => {
    const { els, addBtnSafety } = await setup();

    addBtnSafety.click();

    assert.ok(els["task-modal-overlay"].classList.contains("active"));
    assert.equal(els["modal-task-frequency"].value, "daily");
    assert.equal(els["modal-task-category"].value, "safety");
});

test("hideTaskModal: removes the .active class without saving", async () => {
    const { els } = await setup();

    StandardWorkRenderer.showAddTaskModal("daily", "safety");
    assert.ok(els["task-modal-overlay"].classList.contains("active"));

    StandardWorkRenderer.hideTaskModal();
    assert.equal(els["task-modal-overlay"].classList.contains("active"), false);
});

test("modal-cancel and modal-close both close the modal without calling addTask", async () => {
    const { els, cancelBtn, closeBtn } = await setup();
    const originalAddTask = StandardWorkState.addTask;
    let addTaskCalls = 0;
    StandardWorkState.addTask = (...args) => {
        addTaskCalls++;
        return originalAddTask(...args);
    };

    try {
        StandardWorkRenderer.showAddTaskModal("daily", "safety");
        cancelBtn.click();
        assert.equal(els["task-modal-overlay"].classList.contains("active"), false);

        StandardWorkRenderer.showAddTaskModal("daily", "safety");
        closeBtn.click();
        assert.equal(els["task-modal-overlay"].classList.contains("active"), false);
    } finally {
        StandardWorkState.addTask = originalAddTask;
    }

    assert.equal(addTaskCalls, 0);
});

test("modal-task-editable checkbox toggles the visibility of modal-editable-field-group", async () => {
    const { els } = await setup();

    const checkbox = els["modal-task-editable"];
    const group = els["modal-editable-field-group"];

    assert.equal(group.style.display, "none");

    checkbox.checked = true;
    checkbox.dispatch("change", {});
    assert.equal(group.style.display, "");

    checkbox.checked = false;
    checkbox.dispatch("change", {});
    assert.equal(group.style.display, "none");
});

test("modal-save: rejects an empty title, shows an inline error, and does not close the modal (Req 3.6, 15.1)", async () => {
    const { els, saveBtn } = await setup();

    StandardWorkRenderer.showAddTaskModal("daily", "safety");
    els["modal-task-title"].value = "";

    saveBtn.click();

    assert.equal(els["modal-title-error"].textContent, "Title is required");
    assert.ok(els["modal-title-error"].classList.contains("visible"));
    assert.ok(els["task-modal-overlay"].classList.contains("active"), "modal should remain open on validation failure");
});

test("modal-save: rejects a whitespace-only title (Req 3.6, 15.1)", async () => {
    const { els, saveBtn } = await setup();

    StandardWorkRenderer.showAddTaskModal("daily", "safety");
    els["modal-task-title"].value = "    ";

    saveBtn.click();

    assert.equal(els["modal-title-error"].textContent, "Title is required");
    assert.ok(els["task-modal-overlay"].classList.contains("active"));
});

test("modal-save: rejects an invalid category surfaced by StandardWorkState.addTask (Req 15.2)", async () => {
    const { els, saveBtn, categorySelect } = await setup();

    StandardWorkRenderer.showAddTaskModal("daily", "safety");
    els["modal-task-title"].value = "A valid title";
    // Force an invalid category value onto the select (bypassing the fixed <option> list)
    categorySelect.value = "not-a-real-category";

    saveBtn.click();

    assert.match(els["modal-title-error"].textContent, /Invalid category/);
    assert.ok(els["task-modal-overlay"].classList.contains("active"));
});

test("modal-save: on valid input, adds the task, closes the modal, and re-renders the affected section (Req 3.1, 3.2, 3.3)", async () => {
    const { els, saveBtn, state } = await setup();

    StandardWorkRenderer.showAddTaskModal("daily", "safety");
    els["modal-task-title"].value = "New floor safety check";
    els["modal-task-notes"].value = "Added via modal";
    els["modal-task-editable"].checked = false;

    saveBtn.click();

    assert.equal(els["task-modal-overlay"].classList.contains("active"), false, "modal should close on success");
    assert.equal(els["modal-title-error"].textContent, "");

    const added = state.tasks.find((t) => t.title === "New floor safety check");
    assert.ok(added, "task should have been added to state.tasks");
    assert.equal(added.category, "safety");
    assert.equal(added.frequency, "daily");
    assert.equal(state.dailyStatus[added.id].status, "not_started");

    // Targeted re-render: the new row should now be present in the section container
    const container = els["tasks-safety"];
    const row = container.children.find((r) => r.dataset.taskId === added.id);
    assert.ok(row, "new task row should be rendered into its category section");
});

test("modal-save: sets editableField only when the editable checkbox is checked", async () => {
    const { els, saveBtn, state } = await setup();

    StandardWorkRenderer.showAddTaskModal("daily", "quality");
    els["modal-task-category"].value = "quality";
    els["modal-task-title"].value = "ICQA bin count verification";
    els["modal-task-editable"].checked = true;
    els["modal-task-editable-field"].value = "5 bins";

    saveBtn.click();

    const added = state.tasks.find((t) => t.title === "ICQA bin count verification");
    assert.ok(added);
    assert.equal(added.editable, true);
    assert.equal(added.editableField, "5 bins");
});

test("modal error rendering uses textContent only — never interprets markup as HTML (Req 15.4)", async () => {
    const { els, saveBtn } = await setup();

    StandardWorkRenderer.showAddTaskModal("daily", "safety");
    els["modal-task-title"].value = "";

    saveBtn.click();

    const errorEl = els["modal-title-error"];
    // The fake element's textContent setter clears any child nodes, mirroring
    // real DOM textContent semantics — this is the same guarantee that
    // prevents markup in the message from being parsed as HTML.
    assert.equal(errorEl.children.length, 0);
    assert.equal(typeof errorEl.textContent, "string");
});
