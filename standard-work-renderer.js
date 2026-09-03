// ============================================================
// Standard Work Renderer — AM Standard Work Dashboard
// Renders UI from state: daily checklist grouped by category,
// task rows, status badges, and inline-editable fields.
// ============================================================

const StandardWorkRenderer = (() => {
    "use strict";

    // --- XSS-safe HTML escape helper ---
    // Not strictly needed by the DOM-building code below (which uses
    // textContent/setAttribute exclusively for user-provided values —
    // Req 15.4), but exposed for any future string-based rendering and
    // for unit testing.
    /**
     * Escapes HTML-significant characters in a string.
     * @param {string} str
     * @returns {string}
     */
    function escapeHtml(str) {
        if (typeof str !== "string") return "";
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * Returns whether a string is a safe URL suitable for a task-link href.
     * Accepts absolute http(s) URLs and scheme-less same-origin relative paths
     * (e.g. "index.html"), while still rejecting dangerous schemes like
     * javascript:/data: (a relative path can't contain a colon). Delegates to
     * the data layer's shared acceptance rule (StandardWorkData.isAcceptedLinkUrl)
     * when available so the renderer and normalizeLinks stay in lock-step, with
     * an equivalent inline fallback for non-browser/test contexts.
     * @param {string} url
     * @returns {boolean}
     */
    function isSafeTaskLinkUrl(url) {
        if (typeof StandardWorkData !== "undefined" && StandardWorkData && typeof StandardWorkData.isAcceptedLinkUrl === "function") {
            return StandardWorkData.isAcceptedLinkUrl(url);
        }
        if (typeof url !== "string") return false;
        const trimmed = url.trim();
        if (!trimmed) return false;
        if (/^https?:\/\//i.test(trimmed)) return true;
        return /^[\w./-]+$/.test(trimmed);
    }

    // --- Status Display Labels (for aria-label/title; the badge itself
    // is color/icon coded per standard-work.css) ---
    const STATUS_LABELS = {
        not_started: "Not started",
        in_progress: "In progress",
        done: "Done",
        na: "N/A",
    };

    // --- DOM ID helpers ---
    function getContainerId(category) {
        return `tasks-${category}`;
    }
    function getSectionId(category) {
        return `section-${category}`;
    }
    function getCountId(category) {
        return `count-${category}`;
    }

    // --- Status Map Lookup ---
    /**
     * Returns the status map on `state` corresponding to a task's frequency.
     * @param {Object} state
     * @param {'daily'|'weekly'|'monthly'} frequency
     * @returns {Object}
     */
    function getStatusMapForFrequency(state, frequency) {
        if (frequency === "daily") return state.dailyStatus;
        if (frequency === "weekly") return state.weeklyStatus;
        return state.monthlyStatus;
    }

    // --- Render: Single Task Row ---
    /**
     * Builds a DOM element for one task row.
     *
     * - Status badge is color-coded via CSS class matching the status value
     *   (`.sw-status-badge.not_started|in_progress|done|na`)
     * - Title and notes are inserted via `textContent` (never innerHTML with
     *   raw strings) so user-provided text can never be interpreted as
     *   markup — Req 15.4
     * - A category indicator badge is always shown (Req 4.3)
     * - When `task.editable` is true, the editable field value is rendered
     *   as an inline text input (Req 4.4)
     * - Notes (if non-empty) are shown as secondary text beneath the title
     *   (Req 4.5)
     *
     * @param {Object} task - A Task object (see design doc Task schema)
     * @param {Object} [statusEntry] - { status, periodCompleted, notes, carryover }
     * @returns {HTMLElement} The task row element (not yet attached to the DOM)
     */
    function renderTaskRow(task, statusEntry) {
        const entry = statusEntry || { status: "not_started", periodCompleted: null, notes: "" };
        const status = entry.status || "not_started";

        const row = document.createElement("div");
        // Carryover visual indicator at the row level (Req 7.4): the existing
        // `.sw-task-row.carryover` CSS applies a left-border/background highlight.
        row.className = entry.carryover
            ? `sw-task-row status-${status} carryover`
            : `sw-task-row status-${status}`;
        row.dataset.taskId = task.id;

        // --- Status badge (Req 4.3, 11.3, 11.4) ---
        const badge = document.createElement("button");
        badge.type = "button";
        badge.className = `sw-status-badge ${status}`;
        badge.title = STATUS_LABELS[status] || status;
        badge.setAttribute("aria-label", `${task.title}: ${STATUS_LABELS[status] || status}. Tap to change status.`);
        badge.addEventListener("click", () => handleStatusToggle(task.id));
        row.appendChild(badge);

        // --- Task content: title, notes, meta ---
        const content = document.createElement("div");
        content.className = "sw-task-content";

        const titleEl = document.createElement("div");
        titleEl.className = "sw-task-title";
        titleEl.textContent = task.title; // Req 15.4: textContent, never innerHTML
        content.appendChild(titleEl);

        // Notes as secondary text beneath the title (Req 4.5)
        if (task.notes && task.notes.trim()) {
            const notesEl = document.createElement("div");
            notesEl.className = "sw-task-notes";
            notesEl.textContent = task.notes;
            content.appendChild(notesEl);
        }

        const meta = document.createElement("div");
        meta.className = "sw-task-meta";

        // Category indicator (Req 4.3)
        const categoryBadge = document.createElement("span");
        categoryBadge.className = "sw-category-badge";
        const categoryLabel = (typeof StandardWorkData !== "undefined" && StandardWorkData.CATEGORY_LABELS)
            ? StandardWorkData.CATEGORY_LABELS[task.category]
            : null;
        categoryBadge.textContent = categoryLabel || task.category;
        meta.appendChild(categoryBadge);

        // Carryover badge (Req 7.4): a ↻ badge shown in the meta row when this
        // task is flagged for carryover. The ↻ glyph is supplied by the
        // `.sw-carryover-badge::before` CSS rule.
        if (entry.carryover) {
            const carryoverBadge = document.createElement("span");
            carryoverBadge.className = "sw-carryover-badge";
            carryoverBadge.textContent = "Carryover";
            carryoverBadge.title = "Flagged for carryover to next shift";
            meta.appendChild(carryoverBadge);
        }

        // Period indicator, when the task was completed in a given period
        if (entry.periodCompleted != null) {
            const periodBadge = document.createElement("span");
            periodBadge.className = "sw-period-badge";
            periodBadge.textContent = `P${entry.periodCompleted}`;
            meta.appendChild(periodBadge);
        }

        // Completion date badge, for weekly/monthly tasks marked done
        // (Req 5.3, 5.4) — `completedDate` is set by
        // StandardWorkState.updateTaskStatus() for non-daily tasks.
        if (entry.completedDate) {
            const completionDateEl = document.createElement("span");
            completionDateEl.className = "sw-completion-date";
            completionDateEl.textContent = `Completed ${entry.completedDate}`;
            meta.appendChild(completionDateEl);
        }

        // Inline-editable field (Req 4.4)
        if (task.editable) {
            const editInput = document.createElement("input");
            editInput.type = "text";
            editInput.className = "sw-editable-field";
            editInput.value = task.editableField != null ? task.editableField : "";
            editInput.setAttribute("aria-label", `${task.title} — editable value`);
            editInput.addEventListener("change", () => {
                if (typeof StandardWorkState !== "undefined" && StandardWorkState.editTask) {
                    StandardWorkState.editTask(task.id, { editableField: editInput.value });
                }
            });
            // Prevent the click-to-cycle-status handler on the row's badge
            // from also firing when interacting with the input.
            editInput.addEventListener("click", (e) => e.stopPropagation());
            meta.appendChild(editInput);
        }

        content.appendChild(meta);

        // --- Per-task quick links (Change 3) ---
        // Render a row of link chips for each of the task's `links`. Each chip
        // is an anchor opening in a new tab; labels use textContent and hrefs
        // setAttribute (never innerHTML) so user text can't be parsed as markup.
        // Only http(s) urls render as anchors (same guard as the resources
        // renderer). Clicking a chip must not toggle status, so we stop click
        // propagation (anchors don't hit the badge handler, but be safe).
        const taskLinks = Array.isArray(task.links) ? task.links : [];
        if (taskLinks.length) {
            const linksWrap = document.createElement("div");
            linksWrap.className = "sw-task-links";
            for (const link of taskLinks) {
                if (!link || !isSafeTaskLinkUrl(link.url)) continue;
                const chip = document.createElement("a");
                chip.className = "sw-task-link";
                chip.textContent = link.label != null ? String(link.label) : link.url;
                chip.setAttribute("href", link.url);
                chip.setAttribute("target", "_blank");
                chip.setAttribute("rel", "noopener noreferrer");
                chip.addEventListener("click", (e) => {
                    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                });
                linksWrap.appendChild(chip);
            }
            if (linksWrap.children.length) {
                content.appendChild(linksWrap);
            }
        }

        row.appendChild(content);

        // --- Task actions (edit / remove) — Req 3.4, 3.5 ---
        // Shared actions container. Task 10.3 also appends to this same
        // container, so container creation is intentionally additive: it holds
        // whatever buttons each concern appends without assuming an order.
        const actions = document.createElement("div");
        actions.className = "sw-task-actions";

        // Carryover toggle button (Req 7.1, 7.4) — daily tasks only, since
        // carryover is a daily-only concept per the design (and
        // StandardWorkState.toggleCarryover rejects non-daily frequencies).
        // The `.active` modifier reflects the current flag state via CSS.
        if (task.frequency === "daily") {
            const carryoverBtn = document.createElement("button");
            carryoverBtn.type = "button";
            carryoverBtn.className = entry.carryover
                ? "sw-task-action-btn carryover-btn active"
                : "sw-task-action-btn carryover-btn";
            carryoverBtn.textContent = "\u21BB"; // ↻
            carryoverBtn.title = entry.carryover ? "Remove carryover flag" : "Flag for carryover";
            carryoverBtn.setAttribute(
                "aria-label",
                `${entry.carryover ? "Remove carryover flag from" : "Flag for carryover"}: ${task.title}`
            );
            carryoverBtn.setAttribute("aria-pressed", entry.carryover ? "true" : "false");
            carryoverBtn.addEventListener("click", (e) => {
                if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                handleCarryoverToggle(task.id, row);
            });
            actions.appendChild(carryoverBtn);
        }

        // Edit button: opens the full Add/Edit modal in edit mode, prefilled
        // with the task's title/category/notes/editable-field/links (Req 3.4).
        // Using the full modal (rather than inline title-only editing) is what
        // lets the user manage a task's quick links (Change 3).
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "sw-task-action-btn edit-btn";
        editBtn.textContent = "\u270E"; // ✎ pencil
        editBtn.title = "Edit task";
        editBtn.setAttribute("aria-label", `Edit task: ${task.title}`);
        editBtn.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
            showEditTaskModal(task);
        });
        actions.appendChild(editBtn);

        // Remove button: confirms, then deletes the task (Req 3.5)
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "sw-task-action-btn remove-btn";
        removeBtn.textContent = "\u00D7"; // ×
        removeBtn.title = "Remove task";
        removeBtn.setAttribute("aria-label", `Remove task: ${task.title}`);
        removeBtn.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
            handleRemoveTask(task, row);
        });
        actions.appendChild(removeBtn);

        row.appendChild(actions);

        return row;
    }

    // --- Targeted Row Re-render Helper ---
    /**
     * Re-renders a single task row in place (targeted re-render — Req 11.5),
     * reading the latest state so the row reflects any edits.
     * @param {string} taskId
     * @param {HTMLElement} oldRow - The currently-mounted row element to replace
     * @returns {HTMLElement|null} The freshly rendered row, or null if not found
     */
    function rerenderTaskRow(taskId, oldRow) {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.getState) return null;
        const state = StandardWorkState.getState();
        if (!state) return null;

        const task = state.tasks.find((t) => t.id === taskId);
        if (!task) return null;

        const statusMap = getStatusMapForFrequency(state, task.frequency);
        const newRow = renderTaskRow(task, statusMap[taskId]);

        if (oldRow && oldRow.parentNode) {
            oldRow.parentNode.replaceChild(newRow, oldRow);
        }

        return newRow;
    }

    // --- Inline Title Editing (Req 3.4) ---
    /**
     * Replaces a task row's title display with a text input pre-filled with
     * the current title. Committing (Enter or blur) delegates to
     * `StandardWorkState.editTask(taskId, { title })`:
     *   - On success, the row is re-rendered in place (targeted re-render).
     *   - On failure (e.g. empty title, Req 15.1), the input stays open, gains
     *     an `.error` class, and surfaces the error via its `title` attribute.
     * Pressing Escape cancels the edit and restores the original title.
     *
     * @param {Object} task - The Task being edited
     * @param {HTMLElement} row - The mounted row element for this task
     * @param {HTMLElement} titleEl - The `.sw-task-title` element within the row
     */
    function beginTitleEdit(task, row, titleEl) {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.editTask) return;
        if (!titleEl || !titleEl.parentNode) return;

        const input = document.createElement("input");
        input.type = "text";
        input.className = "sw-title-edit-input";
        input.value = task.title;
        input.setAttribute("aria-label", `Edit title for ${task.title}`);

        // Guards against commit()/cancel() running twice (e.g. Enter followed
        // by the blur that firing focus-loss triggers).
        let settled = false;

        function commit() {
            if (settled) return;
            const result = StandardWorkState.editTask(task.id, { title: input.value });
            if (!result || result.success === false) {
                // Keep the input open and surface the validation error (Req 15.1).
                input.classList.add("error");
                input.setAttribute("title", (result && result.error) || "Invalid title");
                if (typeof input.focus === "function") input.focus();
                return;
            }
            settled = true;
            rerenderTaskRow(task.id, row);
        }

        function cancel() {
            if (settled) return;
            settled = true;
            // Restore the original row from unchanged state.
            rerenderTaskRow(task.id, row);
        }

        input.addEventListener("keydown", (e) => {
            if (!e) return;
            if (e.key === "Enter") {
                if (typeof e.preventDefault === "function") e.preventDefault();
                commit();
            } else if (e.key === "Escape") {
                if (typeof e.preventDefault === "function") e.preventDefault();
                cancel();
            }
        });
        input.addEventListener("blur", commit);
        // Don't let clicks inside the input bubble to row-level handlers.
        input.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        });

        titleEl.parentNode.replaceChild(input, titleEl);
        if (typeof input.focus === "function") input.focus();
    }

    // --- Section Re-render Helper (after add/remove) ---
    /**
     * Re-renders whichever section a task belongs to.
     * Daily tasks re-render their category section (which auto-hides when it
     * becomes empty — Req 4.2); weekly/monthly tasks re-render their flat list.
     * @param {Object} task - A Task object (used for its frequency/category)
     */
    function refreshSectionForTask(task) {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.getState) return;
        const state = StandardWorkState.getState();
        if (!state) return;

        if (task.frequency === "daily") {
            const categoryTasks = state.tasks.filter(
                (t) => t.frequency === "daily" && t.category === task.category
            );
            renderSection(task.category, categoryTasks, state.dailyStatus);
        } else if (typeof renderWeeklyMonthlySection === "function") {
            const freqTasks = state.tasks.filter((t) => t.frequency === task.frequency);
            const statusMap = task.frequency === "weekly" ? state.weeklyStatus : state.monthlyStatus;
            renderWeeklyMonthlySection(task.frequency, freqTasks, statusMap);
        } else {
            renderAll(state);
        }
    }

    // --- Remove Task Handler (Req 3.5) ---
    /**
     * Handles a remove-button click: asks for confirmation (a native
     * `confirm()` is acceptable for this on-the-floor tool), and on
     * confirmation delegates to `StandardWorkState.removeTask()` and
     * re-renders the affected section so the row disappears.
     *
     * @param {Object} task - The Task to remove
     * @param {HTMLElement} row - The mounted row element (unused once the
     *   section re-renders, but kept for signature symmetry / future use)
     */
    function handleRemoveTask(task, row) {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.removeTask) return;

        const confirmed = typeof confirm === "function" ? confirm("Remove this task?") : true;
        if (!confirmed) return;

        const result = StandardWorkState.removeTask(task.id);
        if (!result || result.success === false) return;

        refreshSectionForTask(task);
    }

    // --- Carryover Toggle Handler (Req 7.1, 7.4) ---
    /**
     * Handles a carryover-button click: flips the task's carryover flag via
     * `StandardWorkState.toggleCarryover()` and re-renders only that task's
     * row (targeted re-render — reuses `rerenderTaskRow`, which also refreshes
     * the KPI banner so the carryover count updates). The row re-render picks
     * up the `.carryover` row class, the `.active` button state, and the
     * `.sw-carryover-badge` from the latest state.
     *
     * @param {string} taskId
     * @param {HTMLElement} row - The mounted row element for this task
     */
    function handleCarryoverToggle(taskId, row) {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.toggleCarryover) {
            return;
        }

        const result = StandardWorkState.toggleCarryover(taskId);
        if (!result || result.success === false) return;

        rerenderTaskRow(taskId, row);
    }

    // --- Status Toggle Handler ---
    /**
     * Handles a status badge tap: cycles the task's status via
     * `StandardWorkState.updateTaskStatus()` and re-renders only that
     * task's row (targeted re-render — Req 11.5), rather than the whole page.
     *
     * @param {string} taskId
     */
    function handleStatusToggle(taskId) {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.updateTaskStatus) {
            return;
        }

        StandardWorkState.updateTaskStatus(taskId);

        const state = StandardWorkState.getState();
        if (!state) return;

        const task = state.tasks.find((t) => t.id === taskId);
        if (!task) return;

        const statusMap = getStatusMapForFrequency(state, task.frequency);
        const newRow = renderTaskRow(task, statusMap[taskId]);

        const oldRow = document.querySelector(`.sw-task-row[data-task-id="${taskId}"]`);
        if (oldRow && oldRow.parentNode) {
            oldRow.parentNode.replaceChild(newRow, oldRow);
        }
    }

    // --- Render: Section Count Badge ---
    function updateSectionCount(category, count) {
        const countEl = document.getElementById(getCountId(category));
        if (countEl) {
            countEl.textContent = String(count);
        }
    }

    // --- Render: One Category Section ---
    /**
     * Renders one category section's task list into its container
     * (e.g. `#tasks-staffing`), sorted by `sortOrder`.
     *
     * Hides the entire section (header + list) when it contains zero tasks,
     * and shows it otherwise (Req 4.2).
     *
     * @param {string} category - One of StandardWorkData.VALID_CATEGORIES
     * @param {Object[]} tasks - Tasks belonging to this category (any frequency filter already applied by caller)
     * @param {Object} statusMap - The status map (e.g. state.dailyStatus) keyed by task ID
     */
    function renderSection(category, tasks, statusMap) {
        const container = document.getElementById(getContainerId(category));
        if (!container) return;

        const sectionEl = document.getElementById(getSectionId(category));
        const list = Array.isArray(tasks) ? tasks : [];

        // Req 4.2: only display a section header for categories with >= 1 task
        if (list.length === 0) {
            if (sectionEl) sectionEl.style.display = "none";
            container.textContent = "";
            return;
        }
        if (sectionEl) sectionEl.style.display = "";

        const sorted = list.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

        // Clear existing rows (safe: no user content passed to innerHTML)
        container.textContent = "";

        const fragment = document.createDocumentFragment();
        for (const task of sorted) {
            const entry = statusMap ? statusMap[task.id] : null;
            fragment.appendChild(renderTaskRow(task, entry));
        }
        container.appendChild(fragment);

        updateSectionCount(category, sorted.length);
    }

    // --- Render: Weekly/Monthly Section (flat list) ---
    /**
     * Renders a flat list of weekly or monthly tasks into their dedicated
     * section container (`#tasks-weekly` / `#tasks-monthly`), sorted by
     * `sortOrder`. Unlike daily tasks, weekly/monthly tasks are displayed as
     * a single flat list rather than grouped by category (Req 5.1, 5.2).
     *
     * Reuses `renderTaskRow()` for each row, which appends a
     * `.sw-completion-date` badge whenever the task's status entry has a
     * `completedDate` — set by `StandardWorkState.updateTaskStatus()` when a
     * weekly/monthly task is marked `done` (Req 5.3, 5.4).
     *
     *
     * @param {'weekly'|'monthly'} frequency
     * @param {Object[]} tasks - Tasks of the given frequency
     * @param {Object} statusMap - state.weeklyStatus or state.monthlyStatus, keyed by task ID
     */
    function renderWeeklyMonthlySection(frequency, tasks, statusMap) {
        const container = document.getElementById(getContainerId(frequency));
        if (!container) return;

        const list = Array.isArray(tasks) ? tasks : [];
        const sorted = list.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

        // Clear existing rows (safe: no user content passed to innerHTML)
        container.textContent = "";

        const fragment = document.createDocumentFragment();
        for (const task of sorted) {
            const entry = statusMap ? statusMap[task.id] : null;
            fragment.appendChild(renderTaskRow(task, entry));
        }
        container.appendChild(fragment);

        const countEl = document.getElementById(`count-${frequency}`);
        if (countEl) {
            countEl.textContent = String(sorted.length);
        }
    }

    // --- Render: Weekly Objectives Text Area ---
    /**
     * Sets the weekly objectives textarea's current value from state.
     * (Persistence on edit is wired separately — task 11.2.)
     * @param {string} objectives
     */
    function renderWeeklyObjectives(objectives) {
        const el = document.getElementById("weekly-objectives-text");
        if (el) {
            el.value = objectives || "";
        }
    }

    /**
     * Wires up the weekly objectives textarea so edits persist via the State
     * Manager (Req 13.2). Listens on the `input` event rather than `change`:
     * `StandardWorkState.setWeeklyObjectives()` already schedules a debounced
     * (300ms) save downstream, so per-keystroke `input` gives live persistence
     * without flooding the save path, and we don't need to wait for blur.
     *
     * Idempotent per-element via a `data-sw-bound` guard (matching the pattern
     * used by initTaskModal) and null-guarded so it's safe to call before the
     * markup exists (e.g. in non-browser test contexts).
     *
     * Requirements: 13.1, 13.2
     */
    function initWeeklyObjectives() {
        const textarea = document.getElementById("weekly-objectives-text");
        if (!textarea || textarea.dataset.swBound) return;
        textarea.dataset.swBound = "true";
        textarea.addEventListener("input", () => {
            if (typeof StandardWorkState !== "undefined" && StandardWorkState.setWeeklyObjectives) {
                StandardWorkState.setWeeklyObjectives(textarea.value);
            }
        });
    }

    // --- Render: Full Page (Daily View) ---
    /**
     * Top-level render. Renders all daily task sections grouped by category
     * in the fixed display order (Req 4.1), the weekly objectives textarea
     * (Req 13.1), and — once task 9.2 lands — the KPI banner (Req 6.1).
     *
     * This is the default view: "today's shift" showing all daily tasks
     * (Req 11.2).
     *
     * @param {Object} state - The current StandardWorkState
     */
    function renderAll(state) {
        if (!state) return;

        const categories = (typeof StandardWorkData !== "undefined" && StandardWorkData.CATEGORY_ORDER)
            ? StandardWorkData.CATEGORY_ORDER
            : ["staffing", "quality", "coaching", "metrics", "safety", "operations", "handoff"];

        for (const category of categories) {
            const categoryTasks = state.tasks.filter(
                (t) => t.frequency === "daily" && t.category === category
            );
            renderSection(category, categoryTasks, state.dailyStatus);
        }

        // Weekly and Monthly sections (flat lists, not grouped by category) — Req 5.1, 5.2
        renderWeeklyMonthlySection("weekly", state.tasks.filter((t) => t.frequency === "weekly"), state.weeklyStatus);
        renderWeeklyMonthlySection("monthly", state.tasks.filter((t) => t.frequency === "monthly"), state.monthlyStatus);

        renderWeeklyObjectives(state.weeklyObjectives);

        // Populate the Resources tab so it's ready when activated.
        // Null-guarded internally (safe when the Resources markup isn't present).
        renderResourcesView(state);

        // Populate the History/Trends tab so it's ready when activated.
        // Null-guarded internally (safe when the History markup isn't present).
        renderHistoryView();
    }

    // ============================================================
    // Add Task Modal (Req 3.1, 3.2, 3.3, 3.6, 15.1, 15.2, 15.4)
    // ============================================================
    //
    // The modal markup lives in standard-work.html (#task-modal-overlay).
    // Visibility is toggled purely via the `.active` CSS class (see
    // standard-work.css `.sw-modal-overlay.active`) rather than inline
    // styles, so showModal/hideModal only need to add/remove that class.

    /**
     * Shows the "Add Task" modal, pre-filled with the given frequency and
     * category. Clears any previous title/notes/editable-field values and
     * validation error state so the form always opens fresh (Req 3.1, 3.2, 3.3).
     *
     * @param {'daily'|'weekly'|'monthly'} [frequency='daily']
     * @param {string} [category='staffing'] - One of StandardWorkData.VALID_CATEGORIES
     */
    function showAddTaskModal(frequency, category) {
        const overlay = document.getElementById("task-modal-overlay");
        if (!overlay) return;

        const titleEl = document.getElementById("modal-title");
        const titleInput = document.getElementById("modal-task-title");
        const categorySelect = document.getElementById("modal-task-category");
        const frequencySelect = document.getElementById("modal-task-frequency");
        const notesInput = document.getElementById("modal-task-notes");
        const editableCheckbox = document.getElementById("modal-task-editable");
        const editableFieldGroup = document.getElementById("modal-editable-field-group");
        const editableFieldInput = document.getElementById("modal-task-editable-field");
        const linksInput = document.getElementById("modal-task-links");

        if (titleEl) titleEl.textContent = "Add Task"; // Req 15.4: textContent, never innerHTML
        if (titleInput) titleInput.value = "";
        if (notesInput) notesInput.value = "";
        if (editableCheckbox) editableCheckbox.checked = false;
        if (editableFieldGroup) editableFieldGroup.style.display = "none";
        if (editableFieldInput) editableFieldInput.value = "";
        if (linksInput) linksInput.value = "";
        if (frequencySelect) frequencySelect.disabled = false;
        clearModalError();

        if (frequencySelect && frequency) frequencySelect.value = frequency;
        if (categorySelect && category) categorySelect.value = category;

        // Track which frequency/category the modal is currently targeting so
        // handleModalSave() knows which section to re-render on success.
        overlay.dataset.mode = "add";
        delete overlay.dataset.taskId;

        overlay.classList.add("active");

        if (titleInput && typeof titleInput.focus === "function") titleInput.focus();
    }

    // --- Task Links <-> textarea serialization ---
    /**
     * Serializes a task's `links` array into the "Label | https://url"
     * one-per-line format used by the modal's Links textarea.
     * @param {{label: string, url: string}[]} links
     * @returns {string}
     */
    function serializeTaskLinks(links) {
        if (!Array.isArray(links)) return "";
        return links
            .filter((l) => l && (l.label != null || l.url != null))
            .map((l) => `${l.label != null ? l.label : ""} | ${l.url != null ? l.url : ""}`)
            .join("\n");
    }

    /**
     * Parses the modal Links textarea (one "Label | https://url" per line)
     * into an array of { label, url } objects. Blank lines are skipped;
     * malformed lines (missing the pipe, empty label, or empty url) are
     * dropped here, and the State Manager re-validates each entry too.
     * @param {string} text
     * @returns {{label: string, url: string}[]}
     */
    function parseTaskLinks(text) {
        if (typeof text !== "string" || !text.trim()) return [];
        const out = [];
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            const idx = line.indexOf("|");
            if (idx === -1) continue; // malformed: no separator
            const label = line.slice(0, idx).trim();
            const url = line.slice(idx + 1).trim();
            if (!label || !url) continue;
            out.push({ label, url });
        }
        return out;
    }

    /**
     * Shows the Task modal in EDIT mode, pre-filled from an existing task so
     * its title/category/notes/editable-field/links can be updated. The
     * frequency select is disabled (editTask does not move a task between
     * frequencies). Stores the task id + "edit" mode on the overlay so
     * handleModalSave() routes to StandardWorkState.editTask().
     *
     * @param {Object} task - The Task to edit
     */
    function showEditTaskModal(task) {
        const overlay = document.getElementById("task-modal-overlay");
        if (!overlay || !task) return;

        const titleEl = document.getElementById("modal-title");
        const titleInput = document.getElementById("modal-task-title");
        const categorySelect = document.getElementById("modal-task-category");
        const frequencySelect = document.getElementById("modal-task-frequency");
        const notesInput = document.getElementById("modal-task-notes");
        const editableCheckbox = document.getElementById("modal-task-editable");
        const editableFieldGroup = document.getElementById("modal-editable-field-group");
        const editableFieldInput = document.getElementById("modal-task-editable-field");
        const linksInput = document.getElementById("modal-task-links");

        if (titleEl) titleEl.textContent = "Edit Task";
        if (titleInput) titleInput.value = task.title != null ? task.title : "";
        if (categorySelect && task.category) categorySelect.value = task.category;
        if (frequencySelect) {
            if (task.frequency) frequencySelect.value = task.frequency;
            // Frequency isn't editable via editTask — lock it so the user
            // can't imply a move that won't happen.
            frequencySelect.disabled = true;
        }
        if (notesInput) notesInput.value = task.notes != null ? task.notes : "";
        if (editableCheckbox) editableCheckbox.checked = !!task.editable;
        if (editableFieldGroup) editableFieldGroup.style.display = task.editable ? "" : "none";
        if (editableFieldInput) editableFieldInput.value = task.editableField != null ? task.editableField : "";
        if (linksInput) linksInput.value = serializeTaskLinks(task.links);
        clearModalError();

        overlay.dataset.mode = "edit";
        overlay.dataset.taskId = task.id || "";

        overlay.classList.add("active");
        if (titleInput && typeof titleInput.focus === "function") titleInput.focus();
    }

    /**
     * Hides the Add/Edit Task modal without saving.
     */
    function hideTaskModal() {
        const overlay = document.getElementById("task-modal-overlay");
        if (overlay) overlay.classList.remove("active");
    }

    /**
     * Displays a validation error message beneath the title field
     * (Req 15.1, 15.2). Uses textContent exclusively (Req 15.4).
     * @param {string} message
     */
    function showModalError(message) {
        const errorEl = document.getElementById("modal-title-error");
        if (!errorEl) return;
        errorEl.textContent = message;
        errorEl.classList.add("visible");
    }

    /**
     * Clears any currently-displayed modal validation error.
     */
    function clearModalError() {
        const errorEl = document.getElementById("modal-title-error");
        if (!errorEl) return;
        errorEl.textContent = "";
        errorEl.classList.remove("visible");
    }

    /**
     * Re-renders whichever view section is affected by a task addition.
     * Daily tasks re-render their category section; weekly/monthly tasks use
     * `renderWeeklyMonthlySection` if it has landed (task 9.4), otherwise fall
     * back to a full `renderAll()`.
     *
     * @param {Object} task - The newly-created Task object
     */
    function refreshAfterTaskAdd(task) {
        const state = (typeof StandardWorkState !== "undefined" && StandardWorkState.getState)
            ? StandardWorkState.getState()
            : null;
        if (!state) return;

        if (task.frequency === "daily") {
            const categoryTasks = state.tasks.filter(
                (t) => t.frequency === "daily" && t.category === task.category
            );
            renderSection(task.category, categoryTasks, state.dailyStatus);
        } else if (typeof renderWeeklyMonthlySection === "function") {
            const freqTasks = state.tasks.filter((t) => t.frequency === task.frequency);
            const statusMap = task.frequency === "weekly" ? state.weeklyStatus : state.monthlyStatus;
            renderWeeklyMonthlySection(task.frequency, freqTasks, statusMap);
        } else {
            renderAll(state);
        }
    }

    /**
     * Handles the "Save" button click in the Add/Edit Task modal: reads form
     * values (including the Links textarea), then routes to
     * `StandardWorkState.addTask()` (add mode) or `StandardWorkState.editTask()`
     * (edit mode) based on the overlay's `data-mode`. Either shows an inline
     * validation error (Req 15.1, 15.2) or closes the modal and re-renders the
     * affected view (Req 3.1-3.4).
     */
    function handleModalSave() {
        if (typeof StandardWorkState === "undefined") return;

        const overlay = document.getElementById("task-modal-overlay");
        const titleInput = document.getElementById("modal-task-title");
        const categorySelect = document.getElementById("modal-task-category");
        const frequencySelect = document.getElementById("modal-task-frequency");
        const notesInput = document.getElementById("modal-task-notes");
        const editableCheckbox = document.getElementById("modal-task-editable");
        const editableFieldInput = document.getElementById("modal-task-editable-field");
        const linksInput = document.getElementById("modal-task-links");

        const title = titleInput ? titleInput.value : "";
        const category = categorySelect ? categorySelect.value : "";
        const frequency = frequencySelect ? frequencySelect.value : "";
        const notes = notesInput ? notesInput.value : "";
        const editable = editableCheckbox ? editableCheckbox.checked : false;
        const editableField = editableFieldInput ? editableFieldInput.value : "";
        const links = parseTaskLinks(linksInput ? linksInput.value : "");

        // Client-side guard against whitespace-only titles (Req 3.6, 15.1),
        // in addition to the same check performed by the State Manager.
        if (!title || !title.trim()) {
            showModalError("Title is required");
            return;
        }

        const mode = overlay && overlay.dataset ? overlay.dataset.mode : "add";

        if (mode === "edit" && overlay && overlay.dataset.taskId) {
            if (!StandardWorkState.editTask) return;
            const result = StandardWorkState.editTask(overlay.dataset.taskId, {
                title,
                category,
                notes,
                editable,
                editableField: editable ? editableField : null,
                links,
            });
            if (!result || result.success === false) {
                showModalError((result && result.error) || "Unable to save task");
                return;
            }
            clearModalError();
            hideTaskModal();
            // Re-render the affected section from the latest state.
            refreshAfterTaskAdd(result.task);
            return;
        }

        if (!StandardWorkState.addTask) return;
        const result = StandardWorkState.addTask(frequency, category, {
            title,
            notes,
            editable,
            editableField: editable ? editableField : null,
            links,
        });

        if (!result || result.success === false) {
            showModalError((result && result.error) || "Unable to add task");
            return;
        }

        clearModalError();
        hideTaskModal();
        refreshAfterTaskAdd(result.task);
    }

    /**
     * Wires up all Add Task modal interactions:
     * - Each `.sw-section-add-btn` (category "+" buttons) opens the modal
     *   pre-filled with its `data-frequency`/`data-category` attributes
     * - The editable checkbox shows/hides the editable-field input group
     * - Save / Cancel / Close / overlay-background-click close or submit the modal
     *
     * Safe to call multiple times (listeners are idempotent per-element via
     * a `data-sw-bound` guard) and safe to call before the modal markup
     * exists (e.g. in non-browser test contexts) — all lookups are
     * null-guarded.
     */
    function initTaskModal() {
        const addButtons = document.querySelectorAll(".sw-section-add-btn");
        addButtons.forEach((btn) => {
            if (btn.dataset.swBound) return;
            btn.dataset.swBound = "true";
            btn.addEventListener("click", () => {
                showAddTaskModal(btn.dataset.frequency, btn.dataset.category);
            });
        });

        const editableCheckbox = document.getElementById("modal-task-editable");
        const editableFieldGroup = document.getElementById("modal-editable-field-group");
        if (editableCheckbox && editableFieldGroup && !editableCheckbox.dataset.swBound) {
            editableCheckbox.dataset.swBound = "true";
            editableCheckbox.addEventListener("change", () => {
                editableFieldGroup.style.display = editableCheckbox.checked ? "" : "none";
            });
        }

        const saveBtn = document.getElementById("modal-save");
        if (saveBtn && !saveBtn.dataset.swBound) {
            saveBtn.dataset.swBound = "true";
            saveBtn.addEventListener("click", handleModalSave);
        }

        const cancelBtn = document.getElementById("modal-cancel");
        if (cancelBtn && !cancelBtn.dataset.swBound) {
            cancelBtn.dataset.swBound = "true";
            cancelBtn.addEventListener("click", hideTaskModal);
        }

        const closeBtn = document.getElementById("modal-close");
        if (closeBtn && !closeBtn.dataset.swBound) {
            closeBtn.dataset.swBound = "true";
            closeBtn.addEventListener("click", hideTaskModal);
        }

        const overlay = document.getElementById("task-modal-overlay");
        if (overlay && !overlay.dataset.swBound) {
            overlay.dataset.swBound = "true";
            overlay.addEventListener("click", (e) => {
                // Only close when the backdrop itself (not the modal card) is clicked
                if (e && e.target === overlay) hideTaskModal();
            });
        }
    }

    // ============================================================
    // History / Trends View (Req 8.3, 8.4, 8.5, 15.4)
    // ============================================================
    //
    // The History tab markup lives in standard-work.html (#history-view):
    // a header with export (#btn-export-sw-history) / import
    // (#btn-import-sw-history + hidden #import-sw-history-file) controls and
    // a status line (#status-sw-history), plus a list container
    // (#history-list) into which snapshots are rendered.

    /**
     * Sets the import/export status line text (Req 8.5). Uses textContent
     * exclusively so any message text can never be interpreted as markup
     * (Req 15.4). The `.error` modifier lets CSS colour failures distinctly.
     * @param {string} message
     * @param {boolean} [isError=false]
     */
    function setHistoryStatus(message, isError) {
        const statusEl = document.getElementById("status-sw-history");
        if (!statusEl) return;
        statusEl.textContent = message || "";
        if (isError) {
            statusEl.classList.add("error");
        } else {
            statusEl.classList.remove("error");
        }
    }

    /**
     * Reads every stored snapshot from StandardWorkHistory. Uses getSummary()
     * to find the date range and getRange() to pull the entries; falls back
     * to an extremely wide range if the summary is unavailable. Returns an
     * array (possibly empty), never null.
     * @returns {Object[]}
     */
    function getAllHistorySnapshots() {
        if (typeof StandardWorkHistory === "undefined") return [];

        if (typeof StandardWorkHistory.getSummary === "function" &&
            typeof StandardWorkHistory.getRange === "function") {
            const summary = StandardWorkHistory.getSummary();
            if (!summary || !summary.firstDate || !summary.lastDate) return [];
            const range = StandardWorkHistory.getRange(summary.firstDate, summary.lastDate);
            return Array.isArray(range) ? range : [];
        }

        if (typeof StandardWorkHistory.getRange === "function") {
            const range = StandardWorkHistory.getRange("0000-01-01", "9999-12-31");
            return Array.isArray(range) ? range : [];
        }

        return [];
    }

    /**
     * Builds a `.sw-history-entry` element for a single snapshot, showing the
     * date, completion rate, and a meta line (task/carryover counts and a
     * weekly-objectives snippet). All snapshot-derived text is inserted via
     * textContent so it can never be parsed as markup (Req 15.4).
     * @param {Object} snapshot - A HistorySnapshot object
     * @returns {HTMLElement}
     */
    function renderHistoryEntry(snapshot) {
        const entry = document.createElement("div");
        entry.className = "sw-history-entry";
        entry.dataset.date = snapshot.date || "";

        const dateEl = document.createElement("div");
        dateEl.className = "sw-history-date";
        dateEl.textContent = snapshot.date || "(no date)";
        entry.appendChild(dateEl);

        const rate = typeof snapshot.completionRate === "number" ? snapshot.completionRate : 0;
        const rateEl = document.createElement("div");
        rateEl.className = "sw-history-rate";
        rateEl.textContent = `${rate}%`;
        entry.appendChild(rateEl);

        const metaEl = document.createElement("div");
        metaEl.className = "sw-history-meta";
        const taskCount = Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0;
        const carryoverCount = Array.isArray(snapshot.carryoverItems) ? snapshot.carryoverItems.length : 0;
        const parts = [
            `${taskCount} task${taskCount === 1 ? "" : "s"}`,
            `${carryoverCount} carryover${carryoverCount === 1 ? "" : "s"}`,
        ];
        const objectives = typeof snapshot.weeklyObjectives === "string" ? snapshot.weeklyObjectives.trim() : "";
        if (objectives) {
            const snippet = objectives.length > 60 ? `${objectives.slice(0, 60)}\u2026` : objectives;
            parts.push(snippet);
        }
        metaEl.textContent = parts.join(" \u00B7 ");
        entry.appendChild(metaEl);

        return entry;
    }

    /**
     * Renders the History/Trends view: reads all snapshots from
     * StandardWorkHistory and renders each as a `.sw-history-entry` into
     * `#history-list`, sorted most-recent-first. Shows an empty-state message
     * when there are no snapshots (Req 8.3). All snapshot-derived text is
     * inserted via textContent (Req 15.4).
     *
     * Null-guarded on the container lookup so it's safe to call before the
     * History markup exists (e.g. on initial render or in test contexts).
     */
    function renderHistoryView() {
        const container = document.getElementById("history-list");
        if (!container) return;

        const snapshots = getAllHistorySnapshots();

        // Clear existing rows (safe: no user content passed to innerHTML)
        container.textContent = "";

        if (!snapshots.length) {
            const empty = document.createElement("div");
            empty.className = "sw-empty-state";
            const icon = document.createElement("div");
            icon.className = "sw-empty-state-icon";
            icon.textContent = "\uD83D\uDCC5"; // 📅
            const text = document.createElement("div");
            text.className = "sw-empty-state-text";
            text.textContent = "No shift history yet. Snapshots appear here after each daily reset.";
            empty.appendChild(icon);
            empty.appendChild(text);
            container.appendChild(empty);
            return;
        }

        // Most-recent-first
        const sorted = snapshots.slice().sort((a, b) => {
            const da = a.date || "";
            const db = b.date || "";
            return da < db ? 1 : da > db ? -1 : 0;
        });

        const fragment = document.createDocumentFragment();
        for (const snapshot of sorted) {
            fragment.appendChild(renderHistoryEntry(snapshot));
        }
        container.appendChild(fragment);
    }

    /**
     * Handles a selected history-import file: reads it via FileReader, passes
     * the text to StandardWorkHistory.importJSON(), and on success re-renders
     * the history view and shows a success message; on failure surfaces the
     * error message (Req 8.5). FileReader usage is guarded for non-browser
     * test contexts.
     * @param {File} file
     */
    function handleHistoryImportFile(file) {
        if (!file) return;
        if (typeof StandardWorkHistory === "undefined" || typeof StandardWorkHistory.importJSON !== "function") {
            return;
        }

        function applyImport(text) {
            const result = StandardWorkHistory.importJSON(text);
            if (result && result.success) {
                renderHistoryView();
                setHistoryStatus("History imported successfully.", false);
            } else {
                setHistoryStatus(`Import failed: ${(result && result.error) || "Invalid history file"}`, true);
            }
        }

        if (typeof FileReader === "undefined") {
            // No FileReader (e.g. Node test environment). Fall back to reading
            // a `.text()`-capable file or its `_text` stub, so tests can drive
            // the import path without a real browser.
            if (typeof file.text === "function") {
                file.text().then(applyImport).catch(() => {
                    setHistoryStatus("Import failed: could not read file", true);
                });
            } else if (typeof file._text === "string") {
                applyImport(file._text);
            }
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            applyImport(String(reader.result));
        };
        reader.onerror = () => {
            setHistoryStatus("Import failed: could not read file", true);
        };
        reader.readAsText(file);
    }

    /**
     * Produces a full-backup JSON string (state + history) via
     * StandardWorkState.exportFullBackup() and, when running in a browser-like
     * environment, triggers a client-side file download via a temporary
     * `<a download>` element. In non-DOM environments (e.g. Node test runner)
     * the download step is skipped and the JSON string is simply returned.
     * Mirrors StandardWorkHistory.downloadExport()'s node-guard pattern.
     *
     * @param {string} [filename] - Desired download filename. Defaults to
     *   `standard-work-backup-<today's ISO date>.json`.
     * @returns {string} The exported JSON string.
     */
    function downloadFullBackup(filename) {
        if (typeof StandardWorkState === "undefined" || typeof StandardWorkState.exportFullBackup !== "function") {
            return "";
        }
        const json = StandardWorkState.exportFullBackup();

        if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
            // No DOM available (e.g. Node test environment) — nothing to
            // trigger a download with, just return the JSON string.
            return json;
        }

        const name = filename || `standard-work-backup-${new Date().toISOString().slice(0, 10)}.json`;

        try {
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.warn("[StandardWorkRenderer] downloadFullBackup failed to trigger download:", e.message);
        }

        return json;
    }

    /**
     * Reads a selected full-backup file and delegates to
     * StandardWorkState.importFullBackup(). On success, refreshes the entire
     * UI (renderAll with the freshly-imported state, plus the history view) and
     * surfaces a status message (any warning takes precedence). Mirrors
     * handleHistoryImportFile()'s FileReader + node-fallback structure.
     *
     * @param {File} file
     */
    function handleFullBackupImportFile(file) {
        if (!file) return;
        if (typeof StandardWorkState === "undefined" || typeof StandardWorkState.importFullBackup !== "function") {
            return;
        }

        function applyImport(text) {
            const result = StandardWorkState.importFullBackup(text);
            if (result && result.success) {
                const state =
                    typeof StandardWorkState.getState === "function" ? StandardWorkState.getState() : null;
                if (state && typeof renderAll === "function") {
                    renderAll(state);
                }
                renderHistoryView();
                setHistoryStatus(result.warning || "Backup imported successfully.", false);
            } else {
                setHistoryStatus(`Import failed: ${(result && result.error) || "Invalid backup file"}`, true);
            }
        }

        if (typeof FileReader === "undefined") {
            // No FileReader (e.g. Node test environment). Fall back to reading
            // a `.text()`-capable file or its `_text` stub, so tests can drive
            // the import path without a real browser.
            if (typeof file.text === "function") {
                file.text().then(applyImport).catch(() => {
                    setHistoryStatus("Import failed: could not read file", true);
                });
            } else if (typeof file._text === "string") {
                applyImport(file._text);
            }
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            applyImport(String(reader.result));
        };
        reader.onerror = () => {
            setHistoryStatus("Import failed: could not read file", true);
        };
        reader.readAsText(file);
    }

    /**
     * Wires up the History tab's export/import controls (Req 8.4, 8.5):
     * - Export button triggers StandardWorkHistory.downloadExport() (JSON download)
     * - Import button opens the hidden file input; the file input's `change`
     *   event reads the file and delegates to StandardWorkHistory.importJSON()
     *
     * Idempotent per-element via `data-sw-bound` guards and null-guarded so
     * it's safe to call before the markup exists (test contexts).
     */
    function initHistoryControls() {
        const exportBtn = document.getElementById("btn-export-sw-history");
        if (exportBtn && !exportBtn.dataset.swBound) {
            exportBtn.dataset.swBound = "true";
            exportBtn.addEventListener("click", () => {
                if (typeof StandardWorkHistory !== "undefined" && typeof StandardWorkHistory.downloadExport === "function") {
                    StandardWorkHistory.downloadExport();
                    setHistoryStatus("History exported.", false);
                }
            });
        }

        const importBtn = document.getElementById("btn-import-sw-history");
        const fileInput = document.getElementById("import-sw-history-file");
        if (importBtn && fileInput && !importBtn.dataset.swBound) {
            importBtn.dataset.swBound = "true";
            importBtn.addEventListener("click", () => {
                if (typeof fileInput.click === "function") fileInput.click();
            });
        }
        if (fileInput && !fileInput.dataset.swBound) {
            fileInput.dataset.swBound = "true";
            fileInput.addEventListener("change", (e) => {
                const target = (e && e.target) || fileInput;
                const files = target.files;
                const file = files && files.length ? files[0] : null;
                if (file) handleHistoryImportFile(file);
                // Reset so selecting the same file again re-triggers `change`.
                try {
                    target.value = "";
                } catch (err) {
                    /* some inputs disallow programmatic value reset; ignore */
                }
            });
        }

        // --- Full Backup (state + history) export/import ---
        const exportBackupBtn = document.getElementById("btn-export-sw-backup");
        if (exportBackupBtn && !exportBackupBtn.dataset.swBound) {
            exportBackupBtn.dataset.swBound = "true";
            exportBackupBtn.addEventListener("click", () => {
                downloadFullBackup();
                setHistoryStatus("Backup exported.", false);
            });
        }

        const importBackupBtn = document.getElementById("btn-import-sw-backup");
        const backupFileInput = document.getElementById("import-sw-backup-file");
        if (importBackupBtn && backupFileInput && !importBackupBtn.dataset.swBound) {
            importBackupBtn.dataset.swBound = "true";
            importBackupBtn.addEventListener("click", () => {
                if (typeof backupFileInput.click === "function") backupFileInput.click();
            });
        }
        if (backupFileInput && !backupFileInput.dataset.swBound) {
            backupFileInput.dataset.swBound = "true";
            backupFileInput.addEventListener("change", (e) => {
                const target = (e && e.target) || backupFileInput;
                const files = target.files;
                const file = files && files.length ? files[0] : null;
                if (file) handleFullBackupImportFile(file);
                // Reset so selecting the same file again re-triggers `change`.
                try {
                    target.value = "";
                } catch (err) {
                    /* some inputs disallow programmatic value reset; ignore */
                }
            });
        }
    }

    // ============================================================
    // Resources Directory View
    // ============================================================
    //
    // An editable link directory of the websites/tools an Area Manager needs,
    // grouped by StandardWorkData.RESOURCE_GROUP_ORDER and rendered into
    // `#resources-groups`. The Add/Edit Resource modal markup lives in
    // standard-work.html (#resource-modal-overlay). All user-provided values
    // (labels, urls) are inserted via textContent/setAttribute — never
    // innerHTML — so they can never be interpreted as markup (XSS safety).

    /**
     * Returns whether a string is a safe URL suitable for a resource href.
     * Accepts absolute http(s) URLs and scheme-less same-origin relative paths
     * (e.g. "index.html" for the local PS dashboard), while still rejecting
     * dangerous schemes like javascript:/data:. Delegates to the shared data-layer
     * acceptance rule (StandardWorkData.isAcceptedLinkUrl) so resources, task
     * links, and normalizeLinks stay in lock-step, with an equivalent inline
     * fallback for non-browser/test contexts.
     * @param {string} url
     * @returns {boolean}
     */
    function isSafeResourceUrl(url) {
        if (typeof StandardWorkData !== "undefined" && StandardWorkData && typeof StandardWorkData.isAcceptedLinkUrl === "function") {
            return StandardWorkData.isAcceptedLinkUrl(url);
        }
        if (typeof url !== "string") return false;
        const trimmed = url.trim();
        if (!trimmed) return false;
        if (/^https?:\/\//i.test(trimmed)) return true;
        return /^[\w./-]+$/.test(trimmed);
    }

    /**
     * Builds a single resource row: a clickable link (label) that opens in a
     * new tab, plus edit/remove action buttons. If the URL is not a safe
     * http(s) URL, the label is rendered as non-clickable text instead of an
     * anchor (defensive guard).
     * @param {Object} resource - { id, label, url, group, ... }
     * @returns {HTMLElement}
     */
    function renderResourceRow(resource) {
        const row = document.createElement("div");
        row.className = "sw-resource-row";
        row.dataset.resourceId = resource.id;

        if (isSafeResourceUrl(resource.url)) {
            const link = document.createElement("a");
            link.className = "sw-resource-link";
            link.textContent = resource.label; // textContent — never innerHTML
            link.setAttribute("href", resource.url);
            link.setAttribute("target", "_blank");
            link.setAttribute("rel", "noopener noreferrer");
            row.appendChild(link);
        } else {
            const text = document.createElement("span");
            text.className = "sw-resource-link sw-resource-link-disabled";
            text.textContent = resource.label;
            text.title = "This resource has an invalid URL";
            row.appendChild(text);
        }

        const actions = document.createElement("div");
        actions.className = "sw-resource-actions";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "sw-task-action-btn edit-btn";
        editBtn.textContent = "\u270E"; // ✎ pencil
        editBtn.title = "Edit resource";
        editBtn.setAttribute("aria-label", `Edit resource: ${resource.label}`);
        editBtn.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
            showResourceModal("edit", resource);
        });
        actions.appendChild(editBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "sw-task-action-btn remove-btn";
        removeBtn.textContent = "\u00D7"; // ×
        removeBtn.title = "Remove resource";
        removeBtn.setAttribute("aria-label", `Remove resource: ${resource.label}`);
        removeBtn.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
            handleRemoveResource(resource);
        });
        actions.appendChild(removeBtn);

        row.appendChild(actions);
        return row;
    }

    /**
     * Renders the Resources directory: groups resources by
     * StandardWorkData.RESOURCE_GROUP_ORDER into `#resources-groups`, each
     * group as a `.sw-section` with a header (title + count + add button) and
     * its resource rows. Any groups present in state but not in the fixed
     * order are appended afterwards so no resource is ever hidden.
     *
     * Null-guarded on the container lookup so it's safe to call before the
     * markup exists (initial render / test contexts).
     *
     * @param {Object} state - The current StandardWorkState
     */
    function renderResourcesView(state) {
        const container = document.getElementById("resources-groups");
        if (!container) return;

        const resources = state && Array.isArray(state.resources) ? state.resources : [];

        const groupOrder = (typeof StandardWorkData !== "undefined" && StandardWorkData.RESOURCE_GROUP_ORDER)
            ? StandardWorkData.RESOURCE_GROUP_ORDER.slice()
            : [];

        // Include any extra groups (e.g. custom ones added by the user) after
        // the fixed order, preserving first-seen order.
        for (const r of resources) {
            if (r && r.group && !groupOrder.includes(r.group)) {
                groupOrder.push(r.group);
            }
        }

        // Clear existing content (safe: no user content passed to innerHTML)
        container.textContent = "";

        const fragment = document.createDocumentFragment();

        for (const group of groupOrder) {
            const groupResources = resources
                .filter((r) => r.group === group)
                .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

            const section = document.createElement("div");
            section.className = "sw-section sw-resource-group";
            section.dataset.group = group;

            const header = document.createElement("div");
            header.className = "sw-section-header";

            const title = document.createElement("span");
            title.className = "sw-section-title";
            title.textContent = group; // textContent — never innerHTML
            header.appendChild(title);

            const count = document.createElement("span");
            count.className = "sw-section-count";
            count.textContent = String(groupResources.length);
            header.appendChild(count);

            const addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.className = "sw-resource-add-btn";
            addBtn.dataset.group = group;
            addBtn.title = "Add resource";
            addBtn.setAttribute("aria-label", `Add resource to ${group}`);
            addBtn.textContent = "+";
            addBtn.addEventListener("click", () => {
                showResourceModal("add", { group });
            });
            header.appendChild(addBtn);

            section.appendChild(header);

            const list = document.createElement("div");
            list.className = "sw-resource-list";
            const rowFragment = document.createDocumentFragment();
            for (const resource of groupResources) {
                rowFragment.appendChild(renderResourceRow(resource));
            }
            list.appendChild(rowFragment);
            section.appendChild(list);

            fragment.appendChild(section);
        }

        container.appendChild(fragment);
    }

    /**
     * Re-renders the Resources view from the latest state. Helper used after
     * add/edit/remove operations.
     */
    function refreshResourcesView() {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.getState) return;
        const state = StandardWorkState.getState();
        if (state) renderResourcesView(state);
    }

    /**
     * Shows a validation error inside the resource modal (textContent only).
     * @param {string} message
     */
    function showResourceError(message) {
        const errorEl = document.getElementById("resource-error");
        if (!errorEl) return;
        errorEl.textContent = message;
        errorEl.classList.add("visible");
    }

    /**
     * Clears any resource-modal validation error.
     */
    function clearResourceError() {
        const errorEl = document.getElementById("resource-error");
        if (!errorEl) return;
        errorEl.textContent = "";
        errorEl.classList.remove("visible");
    }

    /**
     * Shows the Add/Edit Resource modal.
     * - mode "add": clears fields, pre-selects the given group.
     * - mode "edit": pre-fills label/url/group from the resource and stores
     *   its id so handleResourceSave() knows to edit rather than add.
     *
     * @param {'add'|'edit'} mode
     * @param {Object} [data] - { group } for add; a full resource for edit
     */
    function showResourceModal(mode, data) {
        const overlay = document.getElementById("resource-modal-overlay");
        if (!overlay) return;

        const titleEl = document.getElementById("resource-modal-title");
        const labelInput = document.getElementById("resource-label");
        const urlInput = document.getElementById("resource-url");
        const groupSelect = document.getElementById("resource-group");

        clearResourceError();

        if (mode === "edit" && data) {
            if (titleEl) titleEl.textContent = "Edit Resource";
            if (labelInput) labelInput.value = data.label != null ? data.label : "";
            if (urlInput) urlInput.value = data.url != null ? data.url : "";
            if (groupSelect && data.group) groupSelect.value = data.group;
            overlay.dataset.mode = "edit";
            overlay.dataset.resourceId = data.id || "";
        } else {
            if (titleEl) titleEl.textContent = "Add Resource";
            if (labelInput) labelInput.value = "";
            if (urlInput) urlInput.value = "";
            if (groupSelect && data && data.group) groupSelect.value = data.group;
            overlay.dataset.mode = "add";
            delete overlay.dataset.resourceId;
        }

        overlay.classList.add("active");
        if (labelInput && typeof labelInput.focus === "function") labelInput.focus();
    }

    /**
     * Hides the resource modal without saving.
     */
    function hideResourceModal() {
        const overlay = document.getElementById("resource-modal-overlay");
        if (overlay) overlay.classList.remove("active");
    }

    /**
     * Handles the resource modal Save: reads the form, delegates to
     * StandardWorkState.addResource() or editResource() based on the modal
     * mode, and either shows an inline error (textContent) or closes the modal
     * and re-renders the Resources view.
     */
    function handleResourceSave() {
        if (typeof StandardWorkState === "undefined") return;

        const overlay = document.getElementById("resource-modal-overlay");
        const labelInput = document.getElementById("resource-label");
        const urlInput = document.getElementById("resource-url");
        const groupSelect = document.getElementById("resource-group");

        const label = labelInput ? labelInput.value : "";
        const url = urlInput ? urlInput.value : "";
        const group = groupSelect ? groupSelect.value : "";
        const mode = overlay && overlay.dataset ? overlay.dataset.mode : "add";

        let result;
        if (mode === "edit" && overlay && overlay.dataset.resourceId) {
            if (!StandardWorkState.editResource) return;
            result = StandardWorkState.editResource(overlay.dataset.resourceId, { label, url, group });
        } else {
            if (!StandardWorkState.addResource) return;
            result = StandardWorkState.addResource(group, { label, url });
        }

        if (!result || result.success === false) {
            showResourceError((result && result.error) || "Unable to save resource");
            return;
        }

        clearResourceError();
        hideResourceModal();
        refreshResourcesView();
    }

    /**
     * Handles a resource remove-button click: confirms, then delegates to
     * StandardWorkState.removeResource() and re-renders the Resources view.
     * @param {Object} resource
     */
    function handleRemoveResource(resource) {
        if (typeof StandardWorkState === "undefined" || !StandardWorkState.removeResource) return;

        const confirmed = typeof confirm === "function" ? confirm("Remove this resource?") : true;
        if (!confirmed) return;

        const result = StandardWorkState.removeResource(resource.id);
        if (!result || result.success === false) return;

        refreshResourcesView();
    }

    /**
     * Wires up the Resources view controls: the resource modal Save / Cancel /
     * Close / backdrop-click. Add-button and per-row edit/remove handlers are
     * attached during renderResourcesView() (rows are re-created on each
     * render). Idempotent per-element via `data-sw-bound` guards and
     * null-guarded so it's safe to call before the markup exists.
     */
    function initResourcesControls() {
        const saveBtn = document.getElementById("resource-save");
        if (saveBtn && !saveBtn.dataset.swBound) {
            saveBtn.dataset.swBound = "true";
            saveBtn.addEventListener("click", handleResourceSave);
        }

        const cancelBtn = document.getElementById("resource-cancel");
        if (cancelBtn && !cancelBtn.dataset.swBound) {
            cancelBtn.dataset.swBound = "true";
            cancelBtn.addEventListener("click", hideResourceModal);
        }

        const closeBtn = document.getElementById("resource-modal-close");
        if (closeBtn && !closeBtn.dataset.swBound) {
            closeBtn.dataset.swBound = "true";
            closeBtn.addEventListener("click", hideResourceModal);
        }

        const overlay = document.getElementById("resource-modal-overlay");
        if (overlay && !overlay.dataset.swBound) {
            overlay.dataset.swBound = "true";
            overlay.addEventListener("click", (e) => {
                if (e && e.target === overlay) hideResourceModal();
            });
        }
    }

    // ============================================================
    // Tab Navigation (Req 11.2, 12.1, 8.3)
    // ============================================================
    //
    // The tab buttons (`.sw-tab-btn`) live in standard-work.html and each
    // carries a `data-tab` attribute naming the panel id it controls
    // ("daily-view", "weekly-monthly-view", "resources-view", "history-view").
    // The panels themselves are `.sw-tab-panel` sections; visibility is driven
    // purely by the `.active` class (see standard-work.css:
    // `.sw-tab-panel { display:none } / .sw-tab-panel.active { display:block }`).

    /**
     * Activates a single tab: clears `.active` from every tab button and every
     * `.sw-tab-panel`, then marks the given button and its target panel active.
     * When switching to the Resources or History tab, the corresponding view
     * is re-rendered first so it reflects the latest state (those views are
     * only eagerly populated on `renderAll`, and state may have changed since).
     *
     * All lookups are null-guarded so a missing target panel is a harmless
     * no-op rather than an error.
     *
     * @param {HTMLElement} btn - The `.sw-tab-btn` that was activated
     */
    function activateTab(btn) {
        if (!btn) return;
        const targetId = btn.dataset ? btn.dataset.tab : null;
        if (!targetId) return;

        const targetPanel = document.getElementById(targetId);
        if (!targetPanel) return;

        // Refresh the target view with the latest state before showing it.
        if (typeof StandardWorkState !== "undefined" && StandardWorkState.getState) {
            const state = StandardWorkState.getState();
            if (state) {
                if (targetId === "resources-view") {
                    renderResourcesView(state);
                } else if (targetId === "history-view") {
                    renderHistoryView();
                }
            }
        }

        const buttons = document.querySelectorAll(".sw-tab-btn");
        buttons.forEach((b) => b.classList.remove("active"));

        const panels = document.querySelectorAll(".sw-tab-panel");
        panels.forEach((p) => p.classList.remove("active"));

        btn.classList.add("active");
        targetPanel.classList.add("active");
    }

    /**
     * Wires each `.sw-tab-btn` so clicking it shows the matching
     * `.sw-tab-panel` and hides the rest (Req 11.2). Idempotent per-button via
     * a `data-sw-bound` guard, and null-guarded so it's safe to call before the
     * tab markup exists (e.g. in non-browser test contexts).
     */
    function initTabNavigation() {
        const buttons = document.querySelectorAll(".sw-tab-btn");
        buttons.forEach((btn) => {
            if (btn.dataset.swBound) return;
            btn.dataset.swBound = "true";
            btn.addEventListener("click", () => activateTab(btn));
        });
    }

    // Auto-wire modal interactions once the DOM is ready. Guarded for
    // non-browser/test contexts where `document` may be undefined.
    if (typeof document !== "undefined") {
        document.addEventListener("DOMContentLoaded", () => {
            initTaskModal();
            initWeeklyObjectives();
            initHistoryControls();
            initResourcesControls();
            initTabNavigation();
        });
    }

    // --- Public API ---
    return {
        renderAll,
        renderSection,
        renderWeeklyMonthlySection,
        renderTaskRow,
        renderWeeklyObjectives,
        initWeeklyObjectives,
        renderHistoryView,
        initHistoryControls,
        downloadFullBackup,
        handleFullBackupImportFile,
        renderResourcesView,
        initResourcesControls,
        showResourceModal,
        hideResourceModal,
        initTabNavigation,
        showAddTaskModal,
        showEditTaskModal,
        hideTaskModal,
        initTaskModal,
        beginTitleEdit,
        handleRemoveTask,
        escapeHtml,
    };
})();

// Node.js module export (for test runners); no-op in the browser.
if (typeof module !== "undefined" && module.exports) {
    module.exports = StandardWorkRenderer;
}
