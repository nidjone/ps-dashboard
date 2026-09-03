// ============================================================
// Standard Work State Manager — AM Standard Work Dashboard
// Central state management: load, persist, reset, and track
// ============================================================

const StandardWorkState = (() => {
    "use strict";

    // --- Private State ---
    let currentState = null;
    let serverAvailable = false;

    // Number of consecutive failed server-sync attempts since the last
    // successful sync. Used to surface a "Sync pending" warning (Req 9.2, 9.4,
    // 15.3) and to decide whether retryServerSync() should re-push local state.
    let pendingSyncCount = 0;

    // Guards against registering the `visibilitychange` listener more than
    // once (initVisibilityReload is idempotent, Req 14.1).
    let visibilityReloadRegistered = false;

    const STORAGE_KEY = "sw_state";

    // --- Server Detection ---
    /**
     * Checks if the server's standard-work API is reachable.
     * Uses a GET to /api/standard-work/data with a 2-second timeout.
     * Sets `serverAvailable` accordingly.
     * @returns {Promise<boolean>} Whether the server is available
     */
    async function checkServer() {
        try {
            const resp = await fetch("/api/standard-work/data", {
                method: "GET",
                signal: AbortSignal.timeout(2000),
            });
            if (resp.ok) {
                serverAvailable = true;
                console.log("[StandardWorkState] Server mode — data shared");
            } else {
                serverAvailable = false;
                console.log("[StandardWorkState] Server returned non-OK; falling back to local mode");
            }
        } catch (e) {
            serverAvailable = false;
            console.log("[StandardWorkState] Local mode — data stored in this browser only");
        }
        return serverAvailable;
    }

    // --- Load State from Server ---
    /**
     * Attempts to load state JSON from the server endpoint.
     * @returns {Promise<Object|null>} Parsed state or null on failure
     */
    async function loadFromServer() {
        try {
            const resp = await fetch("/api/standard-work/data");
            if (resp.ok) {
                const data = await resp.json();
                // Check if the response is a non-empty object (not just {})
                if (data && typeof data === "object" && data.version) {
                    return data;
                }
            }
        } catch (e) {
            console.warn("[StandardWorkState] Server load failed:", e.message);
        }
        return null;
    }

    // --- Load State from localStorage ---
    /**
     * Attempts to load and parse state from localStorage.
     * @returns {Object|null} Parsed state or null
     */
    function loadFromLocalStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                if (data && typeof data === "object" && data.version) {
                    return data;
                }
            }
        } catch (e) {
            console.warn("[StandardWorkState] localStorage parse failed:", e.message);
        }
        return null;
    }

    // --- Validate State Structure ---
    /**
     * Performs basic structural validation on a loaded state object.
     * Checks for required top-level keys and correct types.
     * @param {*} state - The object to validate
     * @returns {boolean} True if state appears valid
     */
    function isValidState(state) {
        if (!state || typeof state !== "object") return false;
        if (typeof state.version !== "number") return false;
        if (!Array.isArray(state.tasks)) return false;
        if (typeof state.dailyStatus !== "object" || state.dailyStatus === null) return false;
        if (typeof state.weeklyStatus !== "object" || state.weeklyStatus === null) return false;
        if (typeof state.monthlyStatus !== "object" || state.monthlyStatus === null) return false;
        if (typeof state.lastResetDate !== "string") return false;
        return true;
    }

    // --- Backup Corrupted Data ---
    /**
     * Saves corrupted data to a timestamped backup key in localStorage.
     * @param {string} rawData - The raw corrupted string/data to backup
     */
    function backupCorruptedData(rawData) {
        const timestamp = Date.now();
        const backupKey = `${STORAGE_KEY}_backup_${timestamp}`;
        try {
            localStorage.setItem(backupKey, typeof rawData === "string" ? rawData : JSON.stringify(rawData));
            console.log(`[StandardWorkState] Corrupted data backed up to: ${backupKey}`);
        } catch (e) {
            console.warn("[StandardWorkState] Could not backup corrupted data:", e.message);
        }
    }

    // --- Build Shift Snapshot ---
    /**
     * Builds a HistorySnapshot object capturing the current (about-to-be-archived)
     * day's daily task state. Uses `state.lastResetDate` as the snapshot date since
     * this is called immediately before the daily statuses are cleared and the
     * reset date is advanced.
     *
     * The completion rate here is a minimal daily-only calculation (excluding N/A
     * tasks). The full `computeCompletionStats` implementation lands in task 4.2.
     *
     * @param {Object} state - The current StandardWorkState (pre-reset)
     * @returns {Object} A HistorySnapshot object per the design's schema
     */
    function buildSnapshot(state) {
        const dailyTasks = state.tasks.filter((t) => t.frequency === "daily");

        let applicable = 0;
        let completed = 0;
        const snapshotTasks = [];
        const carryoverItems = [];

        for (const task of dailyTasks) {
            const entry = (state.dailyStatus && state.dailyStatus[task.id]) || {
                status: "not_started",
                periodCompleted: null,
                notes: "",
            };

            if (entry.status !== "na") {
                applicable++;
                if (entry.status === "done") completed++;
            }

            snapshotTasks.push({
                id: task.id,
                title: task.title,
                category: task.category,
                status: entry.status,
                periodCompleted: entry.periodCompleted != null ? entry.periodCompleted : null,
                notes: entry.notes || "",
            });

            if (entry.carryover && entry.status !== "done") {
                carryoverItems.push({
                    id: task.id,
                    title: task.title,
                    reason: entry.notes || "",
                });
            }
        }

        const completionRate = applicable > 0 ? Math.round((completed / applicable) * 100) : 0;

        return {
            date: state.lastResetDate,
            shift: "day",
            weeklyObjectives: state.weeklyObjectives || "",
            completionRate,
            tasks: snapshotTasks,
            carryoverItems,
        };
    }

    // --- Daily Reset ---
    /**
     * Detects a shift-day change and performs the daily reset:
     * - Archives the previous day's state as a history snapshot
     * - Resets all daily task statuses to 'not_started'
     * - Preserves weekly/monthly statuses unless a week/month boundary was crossed
     * - Processes carryover items: prefixes next day's notes with '[CARRYOVER]'
     *   for incomplete flagged tasks, then clears all carryover flags
     * - Advances `lastResetDate` to today
     *
     * Idempotent: calling this multiple times on the same day is a no-op after
     * the first call (Requirement 1.6).
     *
     * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 7.2, 7.3
     *
     * @param {Object} state - The current StandardWorkState
     * @returns {Object} The updated state (or unchanged state if no reset needed)
     */
    function dailyReset(state) {
        const today = new Date().toISOString().slice(0, 10);

        // Idempotence guard: no-op if already reset for today
        if (state.lastResetDate === today) {
            return state;
        }

        const previousDate = state.lastResetDate;

        // Step 1: Archive previous day's state as a history snapshot before clearing
        const snapshot = buildSnapshot(state);
        if (typeof StandardWorkHistory !== "undefined" && StandardWorkHistory && typeof StandardWorkHistory.saveShiftSnapshot === "function") {
            StandardWorkHistory.saveShiftSnapshot(previousDate, snapshot);
        } else {
            console.log("[StandardWorkState] StandardWorkHistory not yet available — skipping snapshot save");
        }

        // Step 2: Identify carryover items (incomplete daily tasks flagged for carryover)
        const carryoverIds = [];
        for (const [taskId, dailyState] of Object.entries(state.dailyStatus || {})) {
            if (dailyState && dailyState.carryover && dailyState.status !== "done") {
                carryoverIds.push(taskId);
            }
        }

        // Step 3: Reset all daily task statuses to 'not_started', applying carryover prefix
        const newDailyStatus = {};
        const dailyTasks = state.tasks.filter((t) => t.frequency === "daily");
        for (const task of dailyTasks) {
            const isCarryover = carryoverIds.includes(task.id);
            newDailyStatus[task.id] = {
                status: "not_started",
                periodCompleted: null,
                notes: isCarryover ? "[CARRYOVER] " : "",
                carryover: false,
            };
        }

        // Step 4: Determine week/month boundary crossing
        const lastDate = new Date(previousDate);
        const todayDate = new Date(today);

        const crossedWeek =
            StandardWorkData.getWeekNumber(lastDate) !== StandardWorkData.getWeekNumber(todayDate) ||
            lastDate.getUTCFullYear() !== todayDate.getUTCFullYear();
        const crossedMonth =
            lastDate.getMonth() !== todayDate.getMonth() || lastDate.getFullYear() !== todayDate.getFullYear();

        // Step 5: Reset weekly statuses only if an ISO week boundary was crossed
        if (crossedWeek) {
            const weeklyTasks = state.tasks.filter((t) => t.frequency === "weekly");
            const newWeeklyStatus = {};
            for (const task of weeklyTasks) {
                newWeeklyStatus[task.id] = { status: "not_started", periodCompleted: null, notes: "" };
            }
            state.weeklyStatus = newWeeklyStatus;
        }

        // Step 6: Reset monthly statuses only if a month boundary was crossed
        if (crossedMonth) {
            const monthlyTasks = state.tasks.filter((t) => t.frequency === "monthly");
            const newMonthlyStatus = {};
            for (const task of monthlyTasks) {
                newMonthlyStatus[task.id] = { status: "not_started", periodCompleted: null, notes: "" };
            }
            state.monthlyStatus = newMonthlyStatus;
        }

        // Step 7: Commit reset daily status and advance lastResetDate (clears carryover flags)
        state.dailyStatus = newDailyStatus;
        state.lastResetDate = today;

        return state;
    }

    // --- Persistence: Sync to Server ---
    /**
     * Pushes the given state to the server via POST /api/standard-work/data.
     *
     * - No-ops (without incrementing `pendingSyncCount`) when the server is
     *   not currently believed to be available — there's nothing to retry
     *   against, so this isn't treated as a failed sync attempt.
     * - On success, resets `pendingSyncCount` to 0 and refreshes the sync
     *   indicator.
     * - On failure, increments `pendingSyncCount` so callers (and a future
     *   "Sync pending" UI element, task 10.2/14.1) can detect that local
     *   state has not yet reached the server.
     *
     * Requirements: 9.2, 9.4, 15.3
     *
     * @param {Object} [state=currentState] - The state to push to the server
     * @returns {Promise<{success: boolean, reason?: string}>}
     */
    async function syncToServer(state = currentState) {
        if (!state) {
            return { success: false, reason: "no-state" };
        }
        if (!serverAvailable) {
            return { success: false, reason: "offline" };
        }

        try {
            const resp = await fetch("/api/standard-work/data", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(state),
            });
            if (!resp.ok) {
                throw new Error(`Server responded with status ${resp.status}`);
            }
            pendingSyncCount = 0;
            updateSyncIndicator();
            return { success: true };
        } catch (e) {
            pendingSyncCount++;
            console.warn("[StandardWorkState] Server sync failed:", e.message);
            updateSyncIndicator();
            return { success: false, reason: e.message };
        }
    }

    // --- Persistence: Retry Server Sync (Reconnect Handling) ---
    /**
     * Re-checks server availability and, if the server has just transitioned
     * from unavailable to available, pushes the current local state up to it
     * (Req 9.4). Also used to retry a previously failed sync once the server
     * is confirmed reachable again, without needing a fresh reconnect edge.
     *
     * This function does not schedule itself — periodic polling (e.g. a
     * setInterval calling this on a timer) is wired up separately in task
     * 14.1. It's exposed here so that future polling logic has something to
     * call.
     *
     * @returns {Promise<{success: boolean, reason?: string}>}
     */
    async function retryServerSync() {
        const wasAvailable = serverAvailable;
        await checkServer();

        if (serverAvailable && (!wasAvailable || pendingSyncCount > 0)) {
            if (!wasAvailable) {
                console.log("[StandardWorkState] Server reconnected — syncing local state to server");
            }
            return syncToServer(currentState);
        }

        updateSyncIndicator();
        return serverAvailable ? { success: true } : { success: false, reason: "offline" };
    }

    // --- Persistence: Save State ---
    /**
     * Persists the current state.
     * - Always writes to localStorage synchronously as the primary backup
     *   (Req 9.1), so a slow/unreachable server never risks data loss.
     * - Additionally pushes to the server when available (Req 9.2), fired
     *   without awaiting so the localStorage save above is never delayed or
     *   blocked by network latency (fire-and-forget).
     *
     * @param {Object} [state] - Optional state to save; defaults to currentState
     * @returns {Promise<void>}
     */
    async function saveState(state = currentState) {
        if (!state) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            console.warn("[StandardWorkState] Failed to save state to localStorage:", e.message);
        }

        if (serverAvailable) {
            // Fire-and-forget: syncToServer() already catches/logs its own
            // errors and never rejects, but guard here too in case that
            // changes so saveState() itself never throws.
            syncToServer(state).catch((e) => {
                console.warn("[StandardWorkState] Unexpected error during server sync:", e.message);
            });
        }
    }

    // --- Persistence: Debounced Save ---
    let saveDebounceTimer = null;

    /**
     * Schedules a save of the current state, debounced by 300ms.
     * Repeated calls within the debounce window reset the timer so only the
     * last call actually triggers a save (Requirement 2.4).
     */
    function debouncedSave() {
        if (saveDebounceTimer !== null) {
            clearTimeout(saveDebounceTimer);
        }
        saveDebounceTimer = setTimeout(() => {
            saveState(currentState);
            saveDebounceTimer = null;
        }, 300);
    }

    // --- Status Cycling ---
    const STATUS_CYCLE = ["not_started", "in_progress", "done", "na"];

    /**
     * Returns the next status in the cycle: not_started -> in_progress -> done -> na -> not_started.
     * @param {string} currentStatus - The task's current status
     * @returns {string} The next status in the cycle
     */
    function getNextStatus(currentStatus) {
        const idx = STATUS_CYCLE.indexOf(currentStatus);
        if (idx === -1) return STATUS_CYCLE[0];
        return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
    }

    // --- Update Task Status ---
    /**
     * Updates a task's completion status, optionally recording the period it
     * was completed in. If `newStatus` is omitted (or invalid), the status is
     * cycled to the next value in STATUS_CYCLE.
     *
     * - Stores the updated status entry in the appropriate map (dailyStatus,
     *   weeklyStatus, monthlyStatus) based on the task's `frequency`.
     * - Records `periodCompleted` when the task is marked `done` and a period
     *   is supplied.
     * - Clears `periodCompleted` when the task is returned to `not_started`.
     * - Records `completedDate` for weekly/monthly tasks marked `done`.
     * - Triggers a debounced (300ms) save after the change.
     *
     * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
     *
     * @param {string} taskId - The UUID of the task to update
     * @param {string} [newStatus=null] - One of 'not_started', 'in_progress', 'done', 'na'.
     *   If omitted/invalid, the current status is cycled to the next value.
     * @param {number|null} [period=null] - The period (1-based) the task was completed in
     * @returns {Object} The updated state
     */
    function updateTaskStatus(taskId, newStatus = null, period = null) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot update task status: state not initialized");
        }

        const task = currentState.tasks.find((t) => t.id === taskId);
        if (!task) {
            throw new Error(`[StandardWorkState] Task not found: ${taskId}`);
        }

        // Determine which status map to update based on frequency (Req 2.5, 2.6, 2.7)
        let statusMap;
        if (task.frequency === "daily") {
            statusMap = currentState.dailyStatus;
        } else if (task.frequency === "weekly") {
            statusMap = currentState.weeklyStatus;
        } else {
            statusMap = currentState.monthlyStatus;
        }

        // Initialize the status entry if it doesn't exist yet
        if (!statusMap[taskId]) {
            statusMap[taskId] = { status: "not_started", periodCompleted: null, notes: "" };
        }
        const entry = statusMap[taskId];

        // Resolve the target status: explicit valid newStatus, otherwise cycle (Req 2.1)
        const validStatuses = (typeof StandardWorkData !== "undefined" && StandardWorkData.VALID_STATUSES)
            ? StandardWorkData.VALID_STATUSES
            : STATUS_CYCLE;
        let resolvedStatus = newStatus;
        if (!resolvedStatus || !validStatuses.includes(resolvedStatus)) {
            resolvedStatus = getNextStatus(entry.status);
        }

        entry.status = resolvedStatus;

        // Record period when marked done, if provided (Req 2.2)
        if (resolvedStatus === "done" && period !== null && period !== undefined) {
            entry.periodCompleted = period;
        }

        // Clear period when returned to not_started (Req 2.3)
        if (resolvedStatus === "not_started") {
            entry.periodCompleted = null;
        }

        // Record completion date for weekly/monthly tasks marked done
        if (resolvedStatus === "done" && task.frequency !== "daily") {
            entry.completedDate = new Date().toISOString().slice(0, 10);
        }

        task.updatedAt = new Date().toISOString();

        // Persist the change, debounced within 300ms (Req 2.4)
        debouncedSave();

        return currentState;
    }

    // --- Completion Statistics ---
    /**
     * Calculates completion rates and progress indicators for the KPI banner.
     *
     * For each frequency (daily, weekly, monthly):
     * - `total` is the count of tasks with that frequency
     * - `applicable` excludes tasks with status `na`
     * - `completed`/`inProgress`/`notStarted` are counted among applicable tasks
     * - `rate` is `Math.round((completed / applicable) * 100)`, or 0 when
     *   `applicable === 0` (e.g. all applicable tasks are `na`)
     *
     * Also counts carryover-flagged items across `dailyStatus` entries.
     *
     * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
     *
     * @param {Object} [state=currentState] - The StandardWorkState to compute stats for
     * @returns {{daily: Object, weekly: Object, monthly: Object, carryoverCount: number}}
     */
    function computeCompletionStats(state = currentState) {
        if (!state) {
            throw new Error("[StandardWorkState] Cannot compute completion stats: state not initialized");
        }

        const dailyTasks = state.tasks.filter((t) => t.frequency === "daily");
        const weeklyTasks = state.tasks.filter((t) => t.frequency === "weekly");
        const monthlyTasks = state.tasks.filter((t) => t.frequency === "monthly");

        function calcRate(tasks, statusMap) {
            let applicable = 0;
            let completed = 0;
            let inProgress = 0;

            for (const task of tasks) {
                const s = statusMap ? statusMap[task.id] : undefined;
                const status = s ? s.status : "not_started";
                if (status === "na") continue; // Skip N/A items (Req 6.2)
                applicable++;
                if (status === "done") completed++;
                if (status === "in_progress") inProgress++;
            }

            return {
                total: tasks.length,
                applicable,
                completed,
                inProgress,
                notStarted: applicable - completed - inProgress,
                rate: applicable > 0 ? Math.round((completed / applicable) * 100) : 0,
            };
        }

        return {
            daily: calcRate(dailyTasks, state.dailyStatus),
            weekly: calcRate(weeklyTasks, state.weeklyStatus),
            monthly: calcRate(monthlyTasks, state.monthlyStatus),
            carryoverCount: Object.values(state.dailyStatus || {}).filter((s) => s && s.carryover).length,
        };
    }

    // ============================================================
    // Task CRUD Operations — addTask, editTask, removeTask, reorderTask
    // ============================================================
    //
    // Error handling convention for this section:
    //   - Validation failures (bad input: empty title, invalid category/frequency,
    //     invalid sortOrder) return a result object: { success: false, error: string }
    //     rather than throwing. This lets calling UI code display an inline error
    //     (Requirements 3.6, 15.1, 15.2) without needing try/catch.
    //   - Logic errors (operating on a taskId that does not exist) throw an Error,
    //     matching the existing convention used by updateTaskStatus() above — a
    //     missing task indicates a programming error/stale reference, not a user
    //     input mistake.
    //   - All successful mutations return { success: true, ... } and trigger a
    //     debounced save.

    /**
     * Returns the status map (dailyStatus/weeklyStatus/monthlyStatus) on
     * currentState that corresponds to the given task frequency.
     * @param {'daily'|'weekly'|'monthly'} frequency
     * @returns {Object} The corresponding status map
     */
    function getStatusMapForFrequency(frequency) {
        if (frequency === "daily") return currentState.dailyStatus;
        if (frequency === "weekly") return currentState.weeklyStatus;
        return currentState.monthlyStatus;
    }

    /**
     * Adds a new task to the specified frequency/category section.
     *
     * - Generates a UUID via StandardWorkData.generateUUID() (Req 3.1)
     * - Initializes a `not_started` status entry in the appropriate status map (Req 3.2)
     * - Assigns sortOrder placing the task at the end of its category section (Req 3.3)
     * - Rejects empty/whitespace-only titles and invalid frequency/category values (Req 3.6, 15.1, 15.2)
     *
     * @param {'daily'|'weekly'|'monthly'} frequency
     * @param {string} category - One of StandardWorkData.VALID_CATEGORIES
     * @param {Object} taskData - { title, notes?, editable?, editableField?, links? }
     *   `links` is an optional array of { label, url }; each entry must have a
     *   non-empty label and an http(s) url. Invalid link entries are silently
     *   dropped (a bad link never fails the whole add).
     * @returns {{success: boolean, error?: string, task?: Object, newTaskId?: string, state?: Object}}
     */
    function addTask(frequency, category, taskData = {}) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot add task: state not initialized");
        }

        const title = typeof taskData.title === "string" ? taskData.title.trim() : "";
        if (!title) {
            return { success: false, error: "Title is required" };
        }

        const validFrequencies = StandardWorkData.VALID_FREQUENCIES;
        if (!validFrequencies.includes(frequency)) {
            return { success: false, error: `Invalid frequency: ${frequency}` };
        }

        const validCategories = StandardWorkData.VALID_CATEGORIES;
        if (!validCategories.includes(category)) {
            return { success: false, error: `Invalid category: ${category}` };
        }

        const now = new Date().toISOString();
        const id = StandardWorkData.generateUUID();

        // sortOrder: end of the same frequency+category section (Req 3.3)
        const sameSectionTasks = currentState.tasks.filter(
            (t) => t.frequency === frequency && t.category === category
        );
        const maxOrder = sameSectionTasks.length > 0
            ? Math.max(...sameSectionTasks.map((t) => t.sortOrder || 0))
            : 0;

        const newTask = {
            id,
            title,
            category,
            frequency,
            notes: typeof taskData.notes === "string" ? taskData.notes : "",
            editable: !!taskData.editable,
            editableField: taskData.editableField != null ? taskData.editableField : null,
            links: StandardWorkData.normalizeLinks(taskData.links),
            carryover: false,
            sortOrder: maxOrder + 1,
            createdAt: now,
            updatedAt: now,
        };

        currentState.tasks.push(newTask);

        // Initialize status entry (Req 3.2)
        const statusMap = getStatusMapForFrequency(frequency);
        statusMap[id] = { status: "not_started", periodCompleted: null, notes: "" };

        debouncedSave();

        return { success: true, task: newTask, newTaskId: id, state: currentState };
    }

    /**
     * Edits an existing task's editable fields (title, notes, editableField,
     * editable flag, category). Sets `updatedAt` on success (Req 3.4).
     *
     * Validates: if `title` is provided it must be non-empty after trimming;
     * if `category` is provided it must be a valid category value (Req 15.1, 15.2).
     *
     * @param {string} taskId
     * @param {Object} updates - Partial fields to update: { title?, notes?, editableField?, editable?, category?, links? }
     *   Providing `links` replaces the task's link array wholesale; each entry
     *   is validated the same way as addTask (non-empty label + http(s) url),
     *   with invalid entries silently dropped.
     * @returns {{success: boolean, error?: string, task?: Object}}
     */
    function editTask(taskId, updates = {}) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot edit task: state not initialized");
        }

        const task = currentState.tasks.find((t) => t.id === taskId);
        if (!task) {
            throw new Error(`[StandardWorkState] Task not found: ${taskId}`);
        }

        if (Object.prototype.hasOwnProperty.call(updates, "title")) {
            const trimmedTitle = typeof updates.title === "string" ? updates.title.trim() : "";
            if (!trimmedTitle) {
                return { success: false, error: "Title is required" };
            }
            task.title = trimmedTitle;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "category")) {
            if (!StandardWorkData.VALID_CATEGORIES.includes(updates.category)) {
                return { success: false, error: `Invalid category: ${updates.category}` };
            }
            task.category = updates.category;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "notes")) {
            task.notes = typeof updates.notes === "string" ? updates.notes : "";
        }

        if (Object.prototype.hasOwnProperty.call(updates, "editableField")) {
            task.editableField = updates.editableField != null ? updates.editableField : null;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "editable")) {
            task.editable = !!updates.editable;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "links")) {
            task.links = StandardWorkData.normalizeLinks(updates.links);
        }

        task.updatedAt = new Date().toISOString();

        debouncedSave();

        return { success: true, task };
    }

    /**
     * Removes a task from state.tasks and deletes its corresponding entry
     * from the appropriate status map (Req 3.5).
     *
     * @param {string} taskId
     * @returns {{success: boolean}}
     */
    function removeTask(taskId) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot remove task: state not initialized");
        }

        const index = currentState.tasks.findIndex((t) => t.id === taskId);
        if (index === -1) {
            throw new Error(`[StandardWorkState] Task not found: ${taskId}`);
        }

        const [removedTask] = currentState.tasks.splice(index, 1);

        const statusMap = getStatusMapForFrequency(removedTask.frequency);
        delete statusMap[taskId];

        debouncedSave();

        return { success: true };
    }

    /**
     * Reorders a task within its frequency+category section, renumbering
     * sortOrder values sequentially (1-based) to reflect the new position (Req 3.7).
     *
     * `newSortOrder` is treated as the desired 1-based position among the
     * task's siblings (tasks sharing the same frequency and category). It is
     * clamped to the valid range [1, siblingCount].
     *
     * @param {string} taskId
     * @param {number} newSortOrder - Desired 1-based position within the section
     * @returns {{success: boolean, error?: string, state?: Object}}
     */
    function reorderTask(taskId, newSortOrder) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot reorder task: state not initialized");
        }

        const task = currentState.tasks.find((t) => t.id === taskId);
        if (!task) {
            throw new Error(`[StandardWorkState] Task not found: ${taskId}`);
        }

        if (typeof newSortOrder !== "number" || !Number.isFinite(newSortOrder)) {
            return { success: false, error: "newSortOrder must be a finite number" };
        }

        // Siblings sharing the same frequency+category, sorted by current sortOrder
        const siblings = currentState.tasks
            .filter((t) => t.frequency === task.frequency && t.category === task.category && t.id !== taskId)
            .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

        const clampedPosition = Math.min(Math.max(Math.round(newSortOrder), 1), siblings.length + 1);

        // Insert the task at the clamped position, then renumber sequentially
        siblings.splice(clampedPosition - 1, 0, task);
        siblings.forEach((t, i) => {
            t.sortOrder = i + 1;
        });

        task.updatedAt = new Date().toISOString();

        debouncedSave();

        return { success: true, state: currentState };
    }

    // ============================================================
    // Carryover — toggleCarryover
    // ============================================================

    /**
     * Toggles the carryover flag on a daily task's status entry
     * (`currentState.dailyStatus[taskId].carryover`). Carryover only applies
     * to daily tasks per the design; other frequencies are rejected.
     *
     * Initializes the dailyStatus entry (matching the shape used elsewhere:
     * `{ status, periodCompleted, notes }`) if one doesn't exist yet, then
     * flips its `carryover` boolean. Triggers a debounced save on success.
     *
     * Requirements: 7.1, 7.3
     *
     * @param {string} taskId - The UUID of the daily task to flag/unflag
     * @returns {{success: boolean, error?: string, carryover?: boolean}}
     */
    function toggleCarryover(taskId) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot toggle carryover: state not initialized");
        }

        const task = currentState.tasks.find((t) => t.id === taskId);
        if (!task) {
            throw new Error(`[StandardWorkState] Task not found: ${taskId}`);
        }

        if (task.frequency !== "daily") {
            return { success: false, error: "Carryover only applies to daily tasks" };
        }

        if (!currentState.dailyStatus[taskId]) {
            currentState.dailyStatus[taskId] = { status: "not_started", periodCompleted: null, notes: "" };
        }
        const entry = currentState.dailyStatus[taskId];

        entry.carryover = !entry.carryover;

        debouncedSave();

        return { success: true, carryover: entry.carryover };
    }

    // ============================================================
    // Resource Directory CRUD — getResources, addResource,
    // editResource, removeResource
    // ============================================================
    //
    // Mirrors the Task CRUD conventions above: validation failures (empty
    // label/url, malformed url) return { success: false, error } so calling
    // UI can surface an inline message; operating on a missing resource id
    // throws (a programming error / stale reference). Successful mutations
    // return { success: true, ... } and trigger a debounced save.

    /**
     * Returns whether a string looks like an acceptable http(s) URL. Kept
     * intentionally lenient (prefix check only) — the goal is to prevent
     * javascript:/data: style links and blank values, not to fully validate
     * every URL shape.
     * @param {string} url
     * @returns {boolean}
     */
    function isHttpUrl(url) {
        return typeof url === "string" && /^https?:\/\//i.test(url.trim());
    }

    /**
     * Returns the resources directory array, or an empty array if state is
     * not initialized / has no resources.
     * @returns {Object[]}
     */
    function getResources() {
        return (currentState && Array.isArray(currentState.resources)) ? currentState.resources : [];
    }

    /**
     * Adds a new resource link to the given group.
     *
     * - Requires a non-empty (trimmed) label and url.
     * - Requires the url to start with http:// or https:// (basic sanity).
     * - Generates a UUID, places the resource at the end of its group
     *   (sortOrder), stamps createdAt/updatedAt, and pushes onto resources.
     *
     * @param {string} group - The group name (e.g. one of RESOURCE_GROUP_ORDER)
     * @param {Object} resourceData - { label, url }
     * @returns {{success: boolean, error?: string, resource?: Object, newResourceId?: string}}
     */
    function addResource(group, resourceData = {}) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot add resource: state not initialized");
        }
        if (!Array.isArray(currentState.resources)) {
            currentState.resources = [];
        }

        const label = typeof resourceData.label === "string" ? resourceData.label.trim() : "";
        if (!label) {
            return { success: false, error: "Label is required" };
        }

        const url = typeof resourceData.url === "string" ? resourceData.url.trim() : "";
        if (!url) {
            return { success: false, error: "URL is required" };
        }
        if (!isHttpUrl(url)) {
            return { success: false, error: "URL must start with http:// or https://" };
        }

        const groupName = typeof group === "string" && group.trim() ? group.trim() : "IT & Admin";

        const now = new Date().toISOString();
        const id = StandardWorkData.generateUUID();

        // sortOrder: end of the same group
        const sameGroup = currentState.resources.filter((r) => r.group === groupName);
        const maxOrder = sameGroup.length > 0
            ? Math.max(...sameGroup.map((r) => r.sortOrder || 0))
            : 0;

        const newResource = {
            id,
            label,
            url,
            group: groupName,
            sortOrder: maxOrder + 1,
            createdAt: now,
            updatedAt: now,
        };

        currentState.resources.push(newResource);

        debouncedSave();

        return { success: true, resource: newResource, newResourceId: id };
    }

    /**
     * Edits an existing resource's label, url, and/or group. Validates any
     * provided field (non-empty label, non-empty http(s) url) and stamps
     * updatedAt on success. Throws for a missing resource id.
     *
     * @param {string} id
     * @param {Object} updates - Partial: { label?, url?, group? }
     * @returns {{success: boolean, error?: string, resource?: Object}}
     */
    function editResource(id, updates = {}) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot edit resource: state not initialized");
        }
        const resources = Array.isArray(currentState.resources) ? currentState.resources : [];
        const resource = resources.find((r) => r.id === id);
        if (!resource) {
            throw new Error(`[StandardWorkState] Resource not found: ${id}`);
        }

        if (Object.prototype.hasOwnProperty.call(updates, "label")) {
            const trimmedLabel = typeof updates.label === "string" ? updates.label.trim() : "";
            if (!trimmedLabel) {
                return { success: false, error: "Label is required" };
            }
            resource.label = trimmedLabel;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "url")) {
            const trimmedUrl = typeof updates.url === "string" ? updates.url.trim() : "";
            if (!trimmedUrl) {
                return { success: false, error: "URL is required" };
            }
            if (!isHttpUrl(trimmedUrl)) {
                return { success: false, error: "URL must start with http:// or https://" };
            }
            resource.url = trimmedUrl;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "group")) {
            const trimmedGroup = typeof updates.group === "string" ? updates.group.trim() : "";
            if (!trimmedGroup) {
                return { success: false, error: "Group is required" };
            }
            resource.group = trimmedGroup;
        }

        resource.updatedAt = new Date().toISOString();

        debouncedSave();

        return { success: true, resource };
    }

    /**
     * Removes a resource from the directory. Throws for a missing id.
     * @param {string} id
     * @returns {{success: boolean}}
     */
    function removeResource(id) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot remove resource: state not initialized");
        }
        const resources = Array.isArray(currentState.resources) ? currentState.resources : [];
        const index = resources.findIndex((r) => r.id === id);
        if (index === -1) {
            throw new Error(`[StandardWorkState] Resource not found: ${id}`);
        }

        resources.splice(index, 1);

        debouncedSave();

        return { success: true };
    }

    // --- One-Time Migration: OM-Priority Task Seed ---
    /**
     * Seeds the OM-assigned priority deliverables into an existing (persisted)
     * state so users who already have local/server state gain the new tasks
     * without losing their customizations. Mirrors the resources back-fill in
     * init(): it only mutates data, never wipes user tasks/edits/statuses.
     *
     * Behavior (all title comparisons are trimmed + case-insensitive):
     * - Split: if the old combined "Submit Engages and Adapts (A to Z)" task
     *   exists, it is renamed in place to "Submit Engages (A to Z)" (preserving
     *   id/status/sortOrder/createdAt) and a new sibling "Submit Adapts (A to Z)"
     *   is added right after it. If the combined task is gone (user edited/removed
     *   it), each of the two split titles is simply ensured to exist.
     * - New tasks: each of the six OM-priority daily tasks is added only if no
     *   existing task shares its title. Each new task gets a UUID, the right
     *   frequency/category/editable/editableField, a sortOrder at the end of its
     *   daily category group, and a not_started dailyStatus entry.
     *
     * Idempotent and one-time per state: gated behind
     * state.migrations.omPriorityTasksV1. Fresh states created via
     * createInitialState() already set that flag, so this runs only for legacy
     * states loaded from server/localStorage.
     *
     * @param {Object} state - The loaded StandardWorkState to migrate (mutated in place)
     * @returns {boolean} Whether any seeding actually occurred (i.e. the migration ran)
     */
    function migrateOmPriorityTasks(state) {
        state.migrations = state.migrations || {};
        if (state.migrations.omPriorityTasksV1) {
            return false;
        }

        const now = new Date().toISOString();
        const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");
        const hasTitle = (title) => state.tasks.some((t) => norm(t.title) === norm(title));

        // Ensure dailyStatus exists (defensive; legacy states always have it).
        if (typeof state.dailyStatus !== "object" || state.dailyStatus === null) {
            state.dailyStatus = {};
        }

        // Computes the next sortOrder at the end of a given daily category group.
        const nextDailySortOrder = (category) => {
            const sameSection = state.tasks.filter(
                (t) => t.frequency === "daily" && t.category === category
            );
            return sameSection.length > 0
                ? Math.max(...sameSection.map((t) => t.sortOrder || 0)) + 1
                : 1;
        };

        // Adds a brand-new daily task from a template, with status entry.
        const addSeedTask = (template, sortOrder) => {
            const id = StandardWorkData.generateUUID();
            state.tasks.push({
                id,
                title: template.title,
                category: template.category,
                frequency: template.frequency,
                notes: "",
                editable: !!template.editable,
                editableField: template.editableField != null ? template.editableField : null,
                carryover: false,
                sortOrder: sortOrder != null ? sortOrder : nextDailySortOrder(template.category),
                createdAt: now,
                updatedAt: now,
            });
            state.dailyStatus[id] = { status: "not_started", periodCompleted: null, notes: "" };
            return id;
        };

        const oldTitle = StandardWorkData.OM_PRIORITY_SPLIT_OLD_TITLE;
        const [engagesTitle, adaptsTitle] = StandardWorkData.OM_PRIORITY_SPLIT_NEW_TITLES;

        // --- Handle the Engages/Adapts split ---
        const combined = state.tasks.find((t) => norm(t.title) === norm(oldTitle));
        if (combined) {
            // Rename the combined task in place -> "Submit Engages (A to Z)"
            combined.title = engagesTitle;
            combined.updatedAt = now;
            // Add "Submit Adapts (A to Z)" right after it in sort order, unless
            // it already exists.
            if (!hasTitle(adaptsTitle)) {
                addSeedTask(
                    { title: adaptsTitle, category: "coaching", frequency: "daily", editable: false, editableField: null },
                    (combined.sortOrder || 0) + 0.5
                );
            }
        } else {
            // Combined task not present — ensure both split titles exist.
            if (!hasTitle(engagesTitle)) {
                addSeedTask({ title: engagesTitle, category: "coaching", frequency: "daily", editable: false, editableField: null });
            }
            if (!hasTitle(adaptsTitle)) {
                addSeedTask({ title: adaptsTitle, category: "coaching", frequency: "daily", editable: false, editableField: null });
            }
        }

        // --- Add the six new priority tasks (title-deduped) ---
        for (const template of StandardWorkData.OM_PRIORITY_NEW_TASKS) {
            if (!hasTitle(template.title)) {
                addSeedTask(template);
            }
        }

        // Normalize any fractional sortOrders introduced by the in-place split
        // insertion, per daily category group, back to sequential integers.
        const dailyCategories = new Set(
            state.tasks.filter((t) => t.frequency === "daily").map((t) => t.category)
        );
        for (const category of dailyCategories) {
            const group = state.tasks
                .filter((t) => t.frequency === "daily" && t.category === category)
                .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
            group.forEach((t, i) => {
                t.sortOrder = i + 1;
            });
        }

        state.migrations.omPriorityTasksV1 = true;
        return true;
    }

    // --- One-Time Migration: Metrics & Reports Resource Links ---
    /**
     * Merges any DEFAULT_RESOURCES entries that an existing (persisted) state
     * is missing into state.resources, so users who already seeded the
     * Resources directory pick up newly-added default links (e.g. the two new
     * "Metrics & Reports" links) without duplicating anything they already
     * have and without touching their customizations.
     *
     * Matching is by URL (trimmed, case-insensitive). Each added link gets a
     * fresh UUID, the default's group, and a sortOrder at the end of that
     * group. Existing links (same URL) are left untouched.
     *
     * Idempotent and one-time per state: gated behind
     * state.migrations.metricsResourcesV1. Fresh states created via
     * createInitialState() already set that flag (their resources already
     * include every default), so this runs only for legacy states loaded from
     * server/localStorage. Because it's flag-gated, a link the user deletes
     * after migration will not reappear on reload.
     *
     * @param {Object} state - The loaded StandardWorkState to migrate (mutated in place)
     * @returns {boolean} Whether any resource was actually added (i.e. the migration ran)
     */
    function migrateMetricsResources(state) {
        state.migrations = state.migrations || {};
        if (state.migrations.metricsResourcesV1) {
            return false;
        }

        if (!Array.isArray(state.resources)) {
            state.resources = [];
        }

        const now = new Date().toISOString();
        const normUrl = (u) => (typeof u === "string" ? u.trim().toLowerCase() : "");
        const existingUrls = new Set(state.resources.map((r) => normUrl(r.url)));

        // Next sortOrder at the end of a given group.
        const nextGroupSortOrder = (group) => {
            const sameGroup = state.resources.filter((r) => r.group === group);
            return sameGroup.length > 0
                ? Math.max(...sameGroup.map((r) => r.sortOrder || 0)) + 1
                : 1;
        };

        let addedAny = false;
        for (const template of StandardWorkData.DEFAULT_RESOURCES) {
            if (existingUrls.has(normUrl(template.url))) {
                continue; // User already has this link — never duplicate.
            }
            state.resources.push({
                id: StandardWorkData.generateUUID(),
                label: template.label,
                url: template.url,
                group: template.group,
                sortOrder: nextGroupSortOrder(template.group),
                createdAt: now,
                updatedAt: now,
            });
            existingUrls.add(normUrl(template.url));
            addedAny = true;
        }

        state.migrations.metricsResourcesV1 = true;
        return addedAny;
    }

    // --- One-Time Migration: Per-Task Quick Links ---
    /**
     * Back-fills the per-task `links` arrays onto an existing (persisted)
     * state so users who already have local/server state gain the default
     * quick links on their matching tasks — without clobbering any links they
     * may have customized.
     *
     * Behavior:
     * - For each task whose title (trimmed + case-insensitive) matches a
     *   default title that has links, if the task currently has no links
     *   (missing field or empty array), its `links` is set to a fresh copy of
     *   the default links. A task that already has one or more links is left
     *   untouched (the user may have customized it).
     * - Every task ends up with a `links` array: any task still missing the
     *   field (or holding a non-array) is normalized to `[]`.
     *
     * Idempotent and one-time per state: gated behind
     * state.migrations.taskLinksV1. Fresh states created via
     * createInitialState() already set that flag (their tasks already carry
     * links), so this runs only for legacy states loaded from
     * server/localStorage. Because it's flag-gated, links a user later clears
     * won't reappear on reload.
     *
     * @param {Object} state - The loaded StandardWorkState to migrate (mutated in place)
     * @returns {boolean} Whether the migration ran (always true on first run for a legacy state)
     */
    function migrateTaskLinksV1(state) {
        state.migrations = state.migrations || {};
        if (state.migrations.taskLinksV1) {
            return false;
        }

        const defaultsByTitle = StandardWorkData.getDefaultTaskLinksByTitle();
        const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

        if (Array.isArray(state.tasks)) {
            for (const task of state.tasks) {
                const existing = StandardWorkData.normalizeLinks(task.links);
                if (existing.length > 0) {
                    // User already has (valid) links — preserve them as-is.
                    task.links = existing;
                    continue;
                }
                const defaults = defaultsByTitle[norm(task.title)];
                task.links = defaults ? defaults.map((l) => ({ label: l.label, url: l.url })) : [];
            }
        }

        state.migrations.taskLinksV1 = true;
        return true;
    }

    // --- One-Time Migration: Link Corrections ---
    /**
     * Corrects per-task quick links (and merges three new resource links) on an
     * existing (persisted) state. Unlike migrateTaskLinksV1 — which only
     * back-filled EMPTY link arrays — this is a CORRECTION migration: it
     * overwrites specific known-old default links with their corrected values.
     *
     * Task links: for each title in StandardWorkData.getTaskLinkCorrections(),
     * the task's links are replaced ONLY when its current link URL set is
     * exactly the recorded old-default set (or the task currently has no
     * links). If the user customized the links to anything else, they're left
     * untouched. This preserves genuine customizations while fixing the stale
     * defaults everyone else still has.
     *
     * Resources: merges getLinkCorrectionResourceAdditions() into
     * state.resources (deduped by normalized URL, same approach as
     * migrateMetricsResources), and removes a DUPLICATE EHS/RBIs Safety entry
     * if the persisted state accumulated more than one (keeps the earliest by
     * sortOrder, then createdAt).
     *
     * Idempotent and one-time per state: gated behind
     * state.migrations.linkCorrectionsV1. Fresh states created via
     * createInitialState() already set that flag (their data is already
     * correct), so this runs only for legacy states loaded from
     * server/localStorage. Because it's flag-gated, a link the user later
     * re-customizes won't be re-corrected on reload.
     *
     * @param {Object} state - The loaded StandardWorkState to migrate (mutated in place)
     * @returns {boolean} Whether the migration ran (always true on first run for a legacy state)
     */
    function migrateLinkCorrectionsV1(state) {
        state.migrations = state.migrations || {};
        if (state.migrations.linkCorrectionsV1) {
            return false;
        }

        const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");
        const normUrl = (u) => (typeof u === "string" ? u.trim().toLowerCase() : "");
        const corrections = StandardWorkData.getTaskLinkCorrections();

        // --- Correct per-task links ---
        if (Array.isArray(state.tasks)) {
            for (const task of state.tasks) {
                const correction = corrections[norm(task.title)];
                if (!correction) continue;

                const current = StandardWorkData.normalizeLinks(task.links);
                const currentUrls = new Set(current.map((l) => normUrl(l.url)));
                const oldUrls = new Set(correction.oldUrls.map((u) => normUrl(u)));

                // Replace only when current links exactly match the old default
                // set (same size + same members) or the task has no links.
                // Otherwise the user customized them — leave untouched.
                const matchesOld =
                    current.length === 0 ||
                    (currentUrls.size === oldUrls.size &&
                        [...currentUrls].every((u) => oldUrls.has(u)));

                if (matchesOld) {
                    task.links = correction.newLinks.map((l) => ({ label: l.label, url: l.url }));
                }
            }
        }

        // --- Merge the three new resource links (dedupe by URL) ---
        if (!Array.isArray(state.resources)) {
            state.resources = [];
        }
        const now = new Date().toISOString();
        const existingUrls = new Set(state.resources.map((r) => normUrl(r.url)));
        const nextGroupSortOrder = (group) => {
            const sameGroup = state.resources.filter((r) => r.group === group);
            return sameGroup.length > 0
                ? Math.max(...sameGroup.map((r) => r.sortOrder || 0)) + 1
                : 1;
        };
        for (const template of StandardWorkData.getLinkCorrectionResourceAdditions()) {
            if (existingUrls.has(normUrl(template.url))) {
                continue; // Already present — never duplicate.
            }
            state.resources.push({
                id: StandardWorkData.generateUUID(),
                label: template.label,
                url: template.url,
                group: template.group,
                sortOrder: nextGroupSortOrder(template.group),
                createdAt: now,
                updatedAt: now,
            });
            existingUrls.add(normUrl(template.url));
        }

        // --- Remove a duplicate EHS/RBIs Safety entry, if one accumulated ---
        // Keep the earliest (lowest sortOrder, then earliest createdAt).
        const ehsUrl = normUrl("https://na.ehs-amazon.com/home");
        const ehsEntries = state.resources.filter(
            (r) => r.group === "Safety" && normUrl(r.url) === ehsUrl
        );
        if (ehsEntries.length > 1) {
            ehsEntries.sort((a, b) => {
                const so = (a.sortOrder || 0) - (b.sortOrder || 0);
                if (so !== 0) return so;
                return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
            });
            const keep = ehsEntries[0];
            state.resources = state.resources.filter(
                (r) => r === keep || !(r.group === "Safety" && normUrl(r.url) === ehsUrl)
            );
        }

        state.migrations.linkCorrectionsV1 = true;
        return true;
    }

    // --- Init ---
    /**
     * Initializes the StandardWorkState module.
     * - Detects server availability
     * - Loads state from server or localStorage
     * - Handles malformed/corrupted data (backup + reinitialize)
     * - Initializes with defaults if no state exists
     * - Applies daily reset if date has changed
     * - Stores result in currentState
     *
     * Requirements: 9.1, 9.2, 9.3, 9.5, 9.6, 16.1
     *
     * @returns {Promise<Object>} The loaded/initialized state
     */
    async function init() {
        // Step 1: Check server availability
        await checkServer();

        let state = null;
        let loadedRaw = null;

        // Step 2: Attempt to load from server (if available)
        if (serverAvailable) {
            try {
                const resp = await fetch("/api/standard-work/data");
                if (resp.ok) {
                    loadedRaw = await resp.text();
                    const parsed = JSON.parse(loadedRaw);
                    if (parsed && typeof parsed === "object" && parsed.version) {
                        state = parsed;
                    }
                }
            } catch (e) {
                console.warn("[StandardWorkState] Server data load/parse failed:", e.message);
                // If server data is malformed, backup and fall through to localStorage
                if (loadedRaw) {
                    console.error("[StandardWorkState] Server returned malformed data");
                    backupCorruptedData(loadedRaw);
                    loadedRaw = null;
                }
            }
        }

        // Step 3: Fallback to localStorage if no valid server data
        if (!state) {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    loadedRaw = raw;
                    const parsed = JSON.parse(raw);
                    if (isValidState(parsed)) {
                        state = parsed;
                    } else {
                        // Data exists but is invalid/corrupted
                        console.error("[StandardWorkState] localStorage data is malformed or has schema mismatch");
                        backupCorruptedData(raw);
                    }
                }
            } catch (e) {
                // JSON parse failed — corrupted data
                console.error("[StandardWorkState] localStorage JSON parse error:", e.message);
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    backupCorruptedData(raw);
                }
            }
        }

        // Step 4: If still no valid state, initialize with default template
        if (!state) {
            console.log("[StandardWorkState] No existing state found — initializing with defaults");
            state = StandardWorkData.createInitialState();
        }

        // Step 5: Validate the loaded state structure as a safety check
        if (!isValidState(state)) {
            console.error("[StandardWorkState] Loaded state failed validation — reinitializing");
            backupCorruptedData(state);
            state = StandardWorkData.createInitialState();
        }

        // Step 6: Check if daily reset is needed (new day since last reset)
        const today = new Date().toISOString().slice(0, 10);
        if (state.lastResetDate !== today) {
            console.log(`[StandardWorkState] New day detected (last: ${state.lastResetDate}, today: ${today}) — applying daily reset`);
            state = dailyReset(state);
        }

        // Step 6b: Back-fill the resources directory for older states.
        // Existing users have persisted state that predates the Resources
        // feature and therefore lacks a `resources` array. Seed it from the
        // data-layer defaults so they still get the link directory. New states
        // created via createInitialState() already include resources, so this
        // only fires for legacy/imported states.
        if (!Array.isArray(state.resources)) {
            state.resources = StandardWorkData.createDefaultResources();
        }

        // Step 6c: One-time OM-priority task seed for older states. Fresh states
        // (createInitialState) already set migrations.omPriorityTasksV1, so this
        // is a no-op for them; legacy states loaded from server/localStorage get
        // the new priority tasks merged in idempotently, preserving their edits.
        const seededTasks = migrateOmPriorityTasks(state);

        // Step 6d: One-time Metrics & Reports resource-link seed for older
        // states. Runs after the resources back-fill above so it can merge the
        // two new default links into a directory the user already had. Fresh
        // states set migrations.metricsResourcesV1 in createInitialState(), so
        // this is a no-op for them; legacy states pick up any missing default
        // links (deduped by URL) without losing customizations.
        const seededResources = migrateMetricsResources(state);

        // Step 6e: One-time per-task quick-links back-fill for older states.
        // Fresh states set migrations.taskLinksV1 in createInitialState(), so
        // this is a no-op for them; legacy states get default links merged onto
        // matching tasks (never overwriting user-customized links) and every
        // task normalized to have a `links` array.
        const seededLinks = migrateTaskLinksV1(state);

        // Step 6f: One-time link-corrections migration for older states. Runs
        // after taskLinksV1 so it operates on tasks that already have their
        // (possibly stale) default links. Fresh states set
        // migrations.linkCorrectionsV1 in createInitialState(), so this is a
        // no-op for them; legacy states get stale default links rewritten to
        // the corrected values (user customizations preserved) and the three
        // new resource links merged in (deduped by URL).
        const correctedLinks = migrateLinkCorrectionsV1(state);

        const seeded = seededTasks || seededResources || seededLinks || correctedLinks;

        // Step 7: Store in module-level variable
        currentState = state;

        // Persist the migrated state so the seed sticks across reloads (the
        // flag then prevents re-seeding — e.g. a deleted seeded task won't
        // reappear). Fire-and-forget via the same save path other mutations use.
        if (seeded) {
            saveState(currentState).catch((e) => {
                console.warn("[StandardWorkState] Failed to persist OM-priority migration:", e && e.message);
            });
        }

        // Step 8: Update sync status indicator
        updateSyncIndicator();

        // Step 9: Register the multi-tab visibility-reload listener (Req 14.1)
        initVisibilityReload();

        return currentState;
    }

    // --- Multi-Tab Consistency: Reload from Server ---
    /**
     * Reloads state from the server, applying a last-write-wins strategy: the
     * server's copy replaces the in-memory `currentState` (Req 14.2). This is
     * invoked when a tab regains focus (see initVisibilityReload) so that a
     * tab that has been inactive picks up changes made by another tab.
     *
     * - No-ops when the server is not currently available (re-checks via
     *   checkServer() first so a server that came back online is detected).
     * - Fetches the latest state via loadFromServer(); if a valid state is
     *   returned it replaces currentState, applies dailyReset if the date has
     *   changed, refreshes the sync indicator, and re-renders (if a renderer
     *   is available).
     *
     * Requirements: 14.1, 14.2
     *
     * @returns {Promise<Object|null>} The reloaded state, or null if nothing was reloaded
     */
    async function reloadFromServer() {
        // Re-check availability so a reconnected server is picked up; if still
        // offline there's nothing authoritative to reload from (Req 14.1).
        await checkServer();
        if (!serverAvailable) {
            return null;
        }

        const serverState = await loadFromServer();
        if (!isValidState(serverState)) {
            return null;
        }

        // Last-write-wins: the server copy wins on tab refocus (Req 14.2)
        currentState = serverState;

        // Apply a daily reset if the shift day has changed since the server
        // copy was written.
        const today = new Date().toISOString().slice(0, 10);
        if (currentState.lastResetDate !== today) {
            currentState = dailyReset(currentState);
        }

        updateSyncIndicator();

        // Re-render with the freshly loaded state, if a renderer is present.
        if (typeof StandardWorkRenderer !== "undefined" && StandardWorkRenderer && typeof StandardWorkRenderer.renderAll === "function") {
            StandardWorkRenderer.renderAll(currentState);
        }

        return currentState;
    }

    // --- Multi-Tab Consistency: Visibility-Change Listener ---
    /**
     * Registers a `visibilitychange` listener on `document` so that when a tab
     * gains focus (`document.visibilityState === 'visible'`) the state is
     * reloaded from the server (Req 14.1). Guards for non-browser/test
     * contexts and against double-registration (idempotent).
     *
     * Requirements: 14.1, 14.2
     */
    function initVisibilityReload() {
        if (visibilityReloadRegistered) return;
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
            return;
        }

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                reloadFromServer().catch((e) => {
                    console.warn("[StandardWorkState] Visibility reload failed:", e.message);
                });
            }
        });

        visibilityReloadRegistered = true;
    }

    // --- Update Sync Status Indicator ---
    /**
     * Updates the UI sync indicator based on server availability and
     * whether a server sync attempt is currently pending/failed.
     *
     * Dedicated markup for the "Sync pending" warning is wired up in task
     * 10.2/14.1. Until that lands, this looks for an optional `.sw-sync-warning`
     * element (the CSS for it already exists in standard-work.css) and toggles
     * its `.visible` class; if no such element is present yet, it falls back
     * to a console warning so the pending state is still observable.
     *
     * Requirements: 9.3, 9.4, 15.3
     */
    function updateSyncIndicator() {
        const statusEl = document.getElementById("sync-status");
        const dotEl = document.querySelector(".pulse-dot");
        const warningEl = document.querySelector(".sw-sync-warning");

        if (statusEl) {
            if (serverAvailable) {
                statusEl.textContent = "Synced";
                if (dotEl) dotEl.classList.remove("offline");
            } else {
                statusEl.textContent = "Local Mode";
                if (dotEl) dotEl.classList.add("offline");
            }
        }

        if (warningEl) {
            warningEl.classList.toggle("visible", pendingSyncCount > 0);
        } else if (pendingSyncCount > 0) {
            console.warn(`[StandardWorkState] Sync pending (${pendingSyncCount} failed attempt${pendingSyncCount === 1 ? "" : "s"})`);
        }
    }

    /**
     * Returns whether a server sync attempt is currently pending/failed
     * (i.e. local state has changes not yet confirmed saved to the server).
     * Exposed as a hook for a future "Sync pending" UI element.
     * @returns {boolean}
     */
    function isSyncPending() {
        return pendingSyncCount > 0;
    }

    // --- Weekly Objectives ---
    /**
     * Returns the current weekly objectives text.
     * @returns {string} The weekly objectives text, or an empty string if unset
     */
    function getWeeklyObjectives() {
        return (currentState && currentState.weeklyObjectives) || "";
    }

    /**
     * Updates the weekly objectives text and persists the change.
     * The value is included in shift Snapshots via `buildSnapshot()`, which
     * reads `state.weeklyObjectives` (Req 13.3).
     *
     * Requirements: 13.1, 13.2, 13.3
     *
     * @param {string} text - The new weekly objectives text
     * @returns {{success: boolean}}
     */
    function setWeeklyObjectives(text) {
        if (!currentState) {
            throw new Error("[StandardWorkState] Cannot set weekly objectives: state not initialized");
        }

        currentState.weeklyObjectives = typeof text === "string" ? text : "";

        debouncedSave();

        return { success: true };
    }

    // --- Auto-Refresh Poll (Req 9.4, 15.3, 14.1) ---
    // Interval id for the auto-refresh poll, stored so it can be cleared via
    // stopAutoRefresh(). null when no poll is currently running.
    let autoRefreshTimer = null;

    /**
     * Starts a periodic poll that calls `retryServerSync()` every `intervalMs`
     * (default 30s). retryServerSync() re-checks server availability and, when
     * the server is reachable, pushes any pending local changes up to it — so
     * this poll doubles as (a) reconnect detection after "Local Mode", (b) a
     * retry path for a previously-failed "Sync pending" save (Req 9.4, 15.3),
     * and (c) a freshness mechanism for multi-tab consistency.
     *
     * This is intentionally NOT started from init() so that unit tests which
     * call init() directly don't spin up a background timer; it's wired only
     * from the browser DOMContentLoaded flow. Guarded for non-browser/test
     * contexts (no setInterval) and idempotent (a second call is a no-op while
     * a poll is already running).
     *
     * @param {number} [intervalMs=30000] - Poll interval in milliseconds
     * @returns {boolean} Whether a poll was started
     */
    function startAutoRefresh(intervalMs = 30000) {
        if (typeof setInterval !== "function") return false;
        if (autoRefreshTimer !== null) return false;

        autoRefreshTimer = setInterval(() => {
            retryServerSync().catch((e) => {
                console.warn("[StandardWorkState] Auto-refresh sync failed:", e && e.message);
            });
        }, intervalMs);

        return true;
    }

    /**
     * Stops the auto-refresh poll started by startAutoRefresh(), if any.
     * Safe to call when no poll is running.
     */
    function stopAutoRefresh() {
        if (autoRefreshTimer !== null && typeof clearInterval === "function") {
            clearInterval(autoRefreshTimer);
        }
        autoRefreshTimer = null;
    }

    // --- Full Backup Export / Import ---
    /**
     * Exports the ENTIRE dashboard (state + history) as a single JSON string
     * suitable for downloading and re-importing on another instance (e.g. a
     * fresh Render deploy). The bundle carries both the current dashboard
     * state and the full history snapshot array.
     *
     * State is read from `currentState`; if that is null (e.g. before init),
     * it falls back to parsing localStorage "sw_state". History is read
     * directly from localStorage "sw_history" (JSON.parse), defaulting to an
     * empty array on any failure.
     *
     * @returns {string} A pretty-printed JSON string of the backup bundle:
     *   { type: "sw-full-backup", version, exportedAt, state, history }
     */
    function exportFullBackup() {
        let state = currentState;
        if (!state && typeof localStorage !== "undefined") {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                state = raw ? JSON.parse(raw) : null;
            } catch (e) {
                state = null;
            }
        }

        let history = [];
        if (typeof localStorage !== "undefined") {
            try {
                const rawHistory = localStorage.getItem("sw_history");
                const parsed = rawHistory ? JSON.parse(rawHistory) : [];
                history = Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                history = [];
            }
        }

        const bundle = {
            type: "sw-full-backup",
            version: 1,
            exportedAt: new Date().toISOString(),
            state: state || null,
            history,
        };

        return JSON.stringify(bundle, null, 2);
    }

    /**
     * Imports a full-backup bundle produced by exportFullBackup(). Replaces the
     * current dashboard state and (best-effort) the history snapshots.
     *
     * Validation:
     * - Invalid JSON -> { success: false, error: "Invalid JSON" }.
     * - Not an object or wrong/absent `type` -> error "Not a Standard Work backup file".
     * - `state` failing isValidState() -> error "Backup is missing valid dashboard state".
     *
     * On success the state is set as `currentState` and persisted via
     * saveState() (localStorage + best-effort server POST). History, when a
     * valid array, is handed to StandardWorkHistory.importJSON() which
     * validates + persists + server-syncs it. A history failure does not fail
     * the whole import — success is still returned with a `warning`.
     *
     * @param {string} jsonString - The backup JSON produced by exportFullBackup()
     * @returns {{success: boolean, error?: string, warning?: string}}
     */
    function importFullBackup(jsonString) {
        let bundle;
        try {
            bundle = JSON.parse(jsonString);
        } catch (e) {
            return { success: false, error: "Invalid JSON" };
        }

        if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
            return { success: false, error: "Not a Standard Work backup file" };
        }
        if (bundle.type !== "sw-full-backup") {
            return { success: false, error: "Not a Standard Work backup file" };
        }

        if (!isValidState(bundle.state)) {
            return { success: false, error: "Backup is missing valid dashboard state" };
        }

        // Apply state: set the module-level currentState and persist it (writes
        // localStorage + best-effort server sync).
        currentState = bundle.state;
        saveState(currentState);

        let warning;
        if (
            typeof StandardWorkHistory !== "undefined" &&
            StandardWorkHistory &&
            typeof StandardWorkHistory.importJSON === "function"
        ) {
            if (Array.isArray(bundle.history)) {
                try {
                    const result = StandardWorkHistory.importJSON(JSON.stringify(bundle.history));
                    if (!result || !result.success) {
                        warning = "Dashboard imported; history could not be imported";
                    }
                } catch (e) {
                    warning = "Dashboard imported; history could not be imported";
                }
            } else {
                warning = "Dashboard imported; history could not be imported";
            }
        }

        return warning ? { success: true, warning } : { success: true };
    }

    // --- Getters ---
    /**
     * Returns the current state object.
     * @returns {Object|null} The current StandardWorkState
     */
    function getState() {
        return currentState;
    }

    /**
     * Returns whether the server is currently available.
     * @returns {boolean}
     */
    function isServerMode() {
        return serverAvailable;
    }

    // --- Public API ---
    return {
        init,
        getState,
        isServerMode,
        migrateOmPriorityTasks,
        migrateMetricsResources,
        migrateTaskLinksV1,
        migrateLinkCorrectionsV1,
        dailyReset,
        buildSnapshot,
        updateTaskStatus,
        computeCompletionStats,
        addTask,
        editTask,
        removeTask,
        reorderTask,
        toggleCarryover,
        getResources,
        addResource,
        editResource,
        removeResource,
        getWeeklyObjectives,
        setWeeklyObjectives,
        saveState,
        exportFullBackup,
        importFullBackup,
        syncToServer,
        retryServerSync,
        isSyncPending,
        reloadFromServer,
        initVisibilityReload,
        startAutoRefresh,
        stopAutoRefresh,
        STORAGE_KEY,
    };
})();

// ============================================================
// Application Initialization
// ============================================================
// Guarded so this file can be `require()`d in Node (e.g. from unit tests)
// without a DOM present. In the browser, `document` is always defined.
if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", async () => {
        try {
            const state = await StandardWorkState.init();
            console.log("[StandardWork] Initialized with", state.tasks.length, "tasks");

            // Render the initial view once state is ready. Guarded since
            // StandardWorkRenderer is defined in a separate script (loaded
            // after this one) — by the time DOMContentLoaded fires all
            // scripts have executed, but the guard keeps this file safe to
            // load standalone (e.g. in Node-based tests).
            if (typeof StandardWorkRenderer !== "undefined" && StandardWorkRenderer && typeof StandardWorkRenderer.renderAll === "function") {
                StandardWorkRenderer.renderAll(state);
            }

            // Start the 30s auto-refresh poll (server re-check + pending-sync
            // retry). Started here rather than inside init() so unit tests that
            // call init() directly don't spin up a background timer (Req 9.4, 15.3).
            StandardWorkState.startAutoRefresh();
        } catch (e) {
            console.error("[StandardWork] Initialization failed:", e);
        }
    });
}

// Node.js module export (for test runners); no-op in the browser.
if (typeof module !== "undefined" && module.exports) {
    module.exports = StandardWorkState;
}
