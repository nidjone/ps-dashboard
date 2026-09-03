// ============================================================
// Standard Work Data Layer — AM Standard Work Dashboard
// Data models, default task template, and utility functions
// ============================================================

const StandardWorkData = (() => {
    "use strict";

    // --- Utility: UUID Generation ---
    /**
     * Generates a UUID v4 string.
     * Uses crypto.randomUUID() if available, otherwise falls back to manual generation.
     * @returns {string} A UUID string (e.g., "550e8400-e29b-41d4-a716-446655440000")
     */
    function generateUUID() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    // --- Utility: ISO Week Number ---
    /**
     * Returns the ISO 8601 week number (1-53) for a given date.
     * Consistent with ISO week numbering where Monday is the first day of the week
     * and the week containing the year's first Thursday is week 1.
     *
     * @param {Date} date - A valid JavaScript Date object
     * @returns {number} ISO week number (1-53)
     */
    function getWeekNumber(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        // Set to nearest Thursday: current date + 4 - current day number (Monday=1, Sunday=7)
        const dayNum = d.getUTCDay() || 7; // Make Sunday = 7
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        // Get first day of year
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        // Calculate full weeks to nearest Thursday
        const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
        return weekNo;
    }

    // --- Valid Enum Values ---
    const VALID_STATUSES = ["not_started", "in_progress", "done", "na"];
    const VALID_FREQUENCIES = ["daily", "weekly", "monthly"];
    const VALID_CATEGORIES = ["staffing", "quality", "coaching", "metrics", "safety", "operations", "handoff"];

    // --- Category Display Order (fixed) ---
    const CATEGORY_ORDER = ["staffing", "quality", "coaching", "metrics", "safety", "operations", "handoff"];

    // --- Category Display Names ---
    const CATEGORY_LABELS = {
        staffing: "Staffing & Labor",
        quality: "Audits & Quality",
        coaching: "Coaching & Development",
        metrics: "Standard Work & Metrics",
        safety: "Safety & Compliance",
        operations: "Floor Presence & Operations",
        handoff: "Shift Handoff",
    };

    // --- Shared Resource URLs (single source of truth) ---
    // These are reused verbatim by both DEFAULT_RESOURCES (the Resources tab)
    // and DEFAULT_TASKS (per-task quick links, `links` arrays below), so a URL
    // is defined exactly once and can never drift between the two features.
    const URL_VANTAGE_FULFILLMENT =
        "https://vantage.amazon.com/app/fulfillment-dashboards/current-station-work?customer=AMZN&warehouse=ORF3&region=us-east-1&zones=paKivaA02%2CpaKivaA03%2CpaKivaA04%2CpaKivaA05";
    const URL_STAFFING_COMMAND_CENTER =
        "https://staffingcommandcenter-na.aka.amazon.com/ORF3/plan/AR_RSP/paKivaA02/IB";
    const URL_FCLM_PROCESS_PATH_ROLLUP =
        "https://fclm-portal.amazon.com/reports/processPathRollup?reportFormat=HTML&warehouseId=ORF3&maxIntradayDays=1&spanType=Intraday&startDateIntraday=2026%2F03%2F24&startHourIntraday=7&startMinuteIntraday=30&endDateIntraday=2026%2F03%2F24&endHourIntraday=18&endMinuteIntraday=0&_adjustPlanHours=on&_hideEmptyLineItems=on&_rememberViewForWarehouse=on&employmentType=AllEmployees";
    const URL_FCLM_FUNCTION_ROLLUP =
        "https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=HTML&warehouseId=ORF3&processId=1002976&maxIntradayDays=1&spanType=Intraday&startDateIntraday=2026%2F03%2F24&startHourIntraday=7&startMinuteIntraday=30&endDateIntraday=2026%2F03%2F24&endHourIntraday=18&endMinuteIntraday=0";
    const URL_QUICKSIGHT_METRICS_TRACKER =
        "https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/apps/744e92a0-5fb0-4a2f-a8d6-d9b873027eab/view/ORF3-IB-Input-Metrics-Tracker?qs-signin-user-auth=false&sso_login=true#";
    const URL_VANTAGE_STOW_DASHBOARD =
        "https://vantage.amazon.com/app/home/404?redirectFrom=%2Fstow-dashboard&view=landing";
    const URL_ATLAS_STANDARD_WORK =
        "https://atlas.qubit.amazon.dev/standard-work?hideCompleted=true&hideNA=true";
    const URL_FCLM_TIME_ON_TASK =
        "https://fclm-portal.amazon.com/reports/timeOnTask?&warehouseId=ORF3";
    const URL_ATOZ_ADAPT_ACTIONS =
        "https://atoz.amazon.work/engage/adapt-actions/employee/206993248";
    const URL_EHS = "https://na.ehs-amazon.com/home";
    const URL_APOLLO_AUDIT = "https://apollo-audit.corp.amazon.com/";
    // Local PS dashboard served alongside this app on the same origin. This is
    // a RELATIVE url on purpose (no scheme/host) so it works regardless of the
    // host/port the server is running on; normalizeLinks() accepts scheme-less
    // relative paths (see its docs) so it survives sanitization.
    const URL_PS_DASHBOARD = "index.html";
    const URL_GCA_MENU =
        "https://d34wrqb3xn2znf.cloudfront.net/idp-selection?redirect_uri=https%3A%2F%2Fmenu.na.aft.amazonoperations.app%2Fdo%2Fmfa%2Flogin&nonce=50dc6bd41284426969c1ae9f3015378ed344fc6494e645e1d113bb2489114c69&scope=openid+tenantId%3A1545ed74-d2cd-11ec-9d64-0242ac120002&client_id=fc-menu-prod-na&state&response_type=code&otp&user_code&authorize_url=https%3A%2F%2Fprod.us-east-1.federated-auth.aft.a2z.com%2F1545ed74-d2cd-11ec-9d64-0242ac120002%2Fauthorize&data=%5B%7B%22id%22%3A%22maask-prod-na%22%2C%22displayString%22%3A%22Login+with+MAASK%22%7D%2C%7B%22id%22%3A%22amazon-federate-prod%22%2C%22displayString%22%3A%22IT+Service+Login%22%7D%5D&code_challenge&code_challenge_method&referrer=https%3A%2F%2Fmenu.na.aft.amazonoperations.app%2Fmidway%2Flogin&ui_locales=en_US";

    // --- Default Task Template ---
    // Pre-configured tasks loaded on first use (Requirement 16.1, 16.2, 16.3, 16.4)
    const DEFAULT_TASKS = [
        // --- Daily: Staffing & Labor ---
        { title: "Support staffing decisions (oversight/PA support)", category: "staffing", frequency: "daily", editable: false, editableField: null },
        { title: "PS staffing headcount update (per period)", category: "staffing", frequency: "daily", editable: false, editableField: null, links: [
            { label: "PS Dashboard", url: URL_PS_DASHBOARD },
        ] },

        // --- Daily: Staffing & Labor (OM priority) ---
        { title: "Share PS staffing updates in Slack channels", category: "staffing", frequency: "daily", editable: false, editableField: null, links: [
            { label: "PS Dashboard", url: URL_PS_DASHBOARD },
        ] },

        // --- Daily: Audits & Quality ---
        { title: "Conduct required audits", category: "quality", frequency: "daily", editable: true, editableField: "3 bin audits + 2 ASIN audits", links: [
            { label: "Apollo Audit", url: URL_APOLLO_AUDIT },
        ] },
        { title: "Quality STUs \u2014 coach high-consistency low-quality stowers", category: "quality", frequency: "daily", editable: true, editableField: "", links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },

        // --- Daily: Coaching & Development ---
        { title: "Complete all necessary STUs", category: "coaching", frequency: "daily", editable: false, editableField: null, links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "Submit 5+ Feedbacks (myGrow)", category: "coaching", frequency: "daily", editable: true, editableField: "5", links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "Submit Engages (A to Z)", category: "coaching", frequency: "daily", editable: false, editableField: null, links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "Submit Adapts (A to Z)", category: "coaching", frequency: "daily", editable: false, editableField: null, links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "Submit Thrives (A to Z)", category: "coaching", frequency: "daily", editable: false, editableField: null, links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "GCAs \u2014 verify PA completion, call out when due", category: "coaching", frequency: "daily", editable: false, editableField: null, links: [
            { label: "GCA Menu", url: URL_GCA_MENU },
        ] },

        // --- Daily: Standard Work & Metrics ---
        { title: "Complete Standard Work Checklist", category: "metrics", frequency: "daily", editable: false, editableField: null, links: [
            { label: "Atlas SWCL", url: URL_ATLAS_STANDARD_WORK },
        ] },
        { title: "Complete Inbound Metrics Tracker inputs", category: "metrics", frequency: "daily", editable: false, editableField: null, links: [
            { label: "Metrics Tracker", url: URL_QUICKSIGHT_METRICS_TRACKER },
            { label: "Metric Performance", url: URL_VANTAGE_STOW_DASHBOARD },
        ] },
        { title: "Review and clear TNL", category: "metrics", frequency: "daily", editable: false, editableField: null, links: [
            { label: "TNL", url: URL_FCLM_TIME_ON_TASK },
        ] },

        // --- Daily: Safety & Compliance ---
        { title: "Safety Gemba / floor observations", category: "safety", frequency: "daily", editable: false, editableField: null },
        { title: "WHS huddle tracking (associates current)", category: "safety", frequency: "daily", editable: false, editableField: null, links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "RBIs / ARCs / iCares / Dragonflys", category: "safety", frequency: "daily", editable: false, editableField: null, links: [
            { label: "EHS", url: URL_EHS },
        ] },
        { title: "Address open safety escalations", category: "safety", frequency: "daily", editable: false, editableField: null },

        // --- Daily: Floor Presence & Operations ---
        { title: "Gemba walks (floor presence, 5S, stow quality)", category: "operations", frequency: "daily", editable: false, editableField: null },
        { title: "Monitor rate/UPH \u2014 coach bottom performers", category: "operations", frequency: "daily", editable: false, editableField: null, links: [
            { label: "Metric Performance", url: URL_VANTAGE_STOW_DASHBOARD },
        ] },
        { title: "Manage bottlenecks (induct, water spider, pallets, bins)", category: "operations", frequency: "daily", editable: false, editableField: null },
        { title: "UIT monitoring \u2014 address high-UIT associates", category: "operations", frequency: "daily", editable: false, editableField: null, links: [
            { label: "TNL", url: URL_FCLM_TIME_ON_TASK },
        ] },
        { title: "EYT tote count per floor \u2014 SOS count + EOS photos", category: "operations", frequency: "daily", editable: true, editableField: "5 AAs assigned; logins shared w/ ship dock", links: [
            { label: "Metric Performance", url: URL_VANTAGE_STOW_DASHBOARD },
        ] },

        // --- Daily: Shift Handoff ---
        { title: "Review prior shift handoff notes (SOS)", category: "handoff", frequency: "daily", editable: false, editableField: null },
        { title: "Write shift handoff notes for next AM (EOS)", category: "handoff", frequency: "daily", editable: false, editableField: null },
        { title: "Escalate open/unresolved items", category: "handoff", frequency: "daily", editable: false, editableField: null },

        // --- Weekly ---
        { title: "Complete 2 ARCs (Associate Recognition / Andon Response)", category: "coaching", frequency: "weekly", editable: true, editableField: "2" },
        { title: "Weekly audit targets", category: "quality", frequency: "weekly", editable: true, editableField: "" },
        { title: "Quality deep-dive / DPMO review", category: "quality", frequency: "weekly", editable: false, editableField: null },

        // --- Monthly ---
        { title: "1:1 with PA \u2014 Khire", category: "coaching", frequency: "monthly", editable: false, editableField: null },
        { title: "1:1 with PA \u2014 Bishop", category: "coaching", frequency: "monthly", editable: false, editableField: null },
    ];

    // --- OM-Priority Task Seed (migration for existing users) ---
    // The OM-assigned priority deliverables that were added to DEFAULT_TASKS
    // above. New states pick these up automatically via createInitialState().
    // Existing (persisted) states are seeded once, idempotently, by the
    // omPriorityTasksV1 migration in StandardWorkState.init(). These templates
    // (and the split constants below) describe exactly what that migration
    // adds, so the state manager and the tests share a single source of truth.
    //
    // The combined coaching task that was split into two:
    const OM_PRIORITY_SPLIT_OLD_TITLE = "Submit Engages and Adapts (A to Z)";
    const OM_PRIORITY_SPLIT_NEW_TITLES = ["Submit Engages (A to Z)", "Submit Adapts (A to Z)"];

    // The six brand-new daily priority tasks (title-deduped on seed).
    const OM_PRIORITY_NEW_TASKS = [
        { title: "Quality STUs \u2014 coach high-consistency low-quality stowers", category: "quality", frequency: "daily", editable: true, editableField: "", links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "RBIs / ARCs / iCares / Dragonflys", category: "safety", frequency: "daily", editable: false, editableField: null, links: [
            { label: "EHS", url: URL_EHS },
        ] },
        { title: "Submit Thrives (A to Z)", category: "coaching", frequency: "daily", editable: false, editableField: null, links: [
            { label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS },
        ] },
        { title: "GCAs \u2014 verify PA completion, call out when due", category: "coaching", frequency: "daily", editable: false, editableField: null, links: [
            { label: "GCA Menu", url: URL_GCA_MENU },
        ] },
        { title: "Share PS staffing updates in Slack channels", category: "staffing", frequency: "daily", editable: false, editableField: null, links: [
            { label: "PS Dashboard", url: URL_PS_DASHBOARD },
        ] },
        { title: "EYT tote count per floor \u2014 SOS count + EOS photos", category: "operations", frequency: "daily", editable: true, editableField: "5 AAs assigned; logins shared w/ ship dock", links: [
            { label: "Metric Performance", url: URL_VANTAGE_STOW_DASHBOARD },
        ] },
    ];

    // --- Resource Directory Defaults ---
    // Editable link directory of the websites/tools an Area Manager needs,
    // embedded into the dashboard as a "Resources" tab. Seeded on first load
    // (and back-filled for existing users — see StandardWorkState.init()).

    // Fixed display order for resource groups.
    const RESOURCE_GROUP_ORDER = [
        "Staffing & Labor",
        "Metrics & Reports",
        "Standard Work",
        "Coaching & People",
        "Safety",
        "IT & Admin",
    ];

    // Default resource links, grouped. Rendered in RESOURCE_GROUP_ORDER.
    const DEFAULT_RESOURCES = [
        // --- Staffing & Labor ---
        {
            label: "Vantage \u2014 Fulfillment Dashboards",
            url: URL_VANTAGE_FULFILLMENT,
            group: "Staffing & Labor",
        },
        {
            label: "VTO (Instant)",
            url: "https://scheduling.amazon.com/#/instant-vto?siteId=ORF3",
            group: "Staffing & Labor",
        },
        {
            label: "Staffing Command Center",
            url: URL_STAFFING_COMMAND_CENTER,
            group: "Staffing & Labor",
        },
        {
            label: "PS Dashboard",
            url: URL_PS_DASHBOARD,
            group: "Staffing & Labor",
        },

        // --- Metrics & Reports ---
        {
            label: "Process Path Roll-up",
            url: URL_FCLM_PROCESS_PATH_ROLLUP,
            group: "Metrics & Reports",
        },
        {
            label: "Function Roll-up",
            url: URL_FCLM_FUNCTION_ROLLUP,
            group: "Metrics & Reports",
        },
        {
            label: "Process Inspector",
            url: "https://fclm-portal.amazon.com/ppa/inspect/process?primaryAttribute=ACTION_TYPE&secondaryAttribute=CONTAINER_TYPE&nodeType=FC&warehouseId=ORF3&processId=1002980&startDateDay=2020%2F06%2F15&startDateWeek=2020%2F08%2F25&startDateMonth=2026%2F06%2F01&maxIntradayDays=1&spanType=Intraday&startDateIntraday=2026%2F06%2F18&startHourIntraday=6&startMinuteIntraday=0&endDateIntraday=2026%2F06%2F18&endHourIntraday=18&endMinuteIntraday=0&startHourIntraday1=0&startMinuteIntraday1=0&startHourIntraday2=0&startMinuteIntraday2=0&startHourIntraday3=0&startMinuteIntraday3=0&startHourIntraday4=0&startMinuteIntraday4=0",
            group: "Metrics & Reports",
        },
        {
            label: "Inbound Metrics Tracker (QuickSight)",
            url: URL_QUICKSIGHT_METRICS_TRACKER,
            group: "Metrics & Reports",
        },
        {
            label: "Metric Performance \u2014 Stow Dashboard (Vantage)",
            url: URL_VANTAGE_STOW_DASHBOARD,
            group: "Metrics & Reports",
        },

        // --- Standard Work ---
        {
            label: "Atlas \u2014 Standard Work Checklist",
            url: URL_ATLAS_STANDARD_WORK,
            group: "Standard Work",
        },
        {
            label: "Check & Clear TNL (Time on Task)",
            url: URL_FCLM_TIME_ON_TASK,
            group: "Standard Work",
        },
        {
            label: "Apollo Audit",
            url: URL_APOLLO_AUDIT,
            group: "Standard Work",
        },

        // --- Coaching & People ---
        {
            label: "A to Z \u2014 Adapts / Engages / Thrives / Huddles",
            url: URL_ATOZ_ADAPT_ACTIONS,
            group: "Coaching & People",
        },
        {
            label: "A to Z \u2014 Timecards (Manager View)",
            url: "https://atoz.amazon.work/timecard/managerView",
            group: "Coaching & People",
        },
        {
            label: "GCA Menu (AFT/MAASK)",
            url: URL_GCA_MENU,
            group: "Coaching & People",
        },

        // --- Safety ---
        {
            label: "EHS \u2014 RBIs / iCares / Safety",
            url: URL_EHS,
            group: "Safety",
        },

        // --- IT & Admin ---
        {
            label: "IT Tickets (OTS)",
            url: "https://amazonots.service-now.com/esc?id=ec_dashboard",
            group: "IT & Admin",
        },
        {
            label: "Reset Badges (Auth Admin Portal)",
            url: "https://prod.authadminportal.amazonoperations.com/services",
            group: "IT & Admin",
        },
    ];

    /**
     * Builds a fresh array of Resource objects from DEFAULT_RESOURCES, each
     * with a generated UUID, timestamps, and a `sortOrder` sequential within
     * its group. Used both when creating initial state and when back-filling
     * an existing state that predates the resources feature.
     *
     * @returns {Object[]} Array of { id, label, url, group, sortOrder, createdAt, updatedAt }
     */
    function createDefaultResources() {
        const now = new Date().toISOString();
        const groupSortCounters = {};
        return DEFAULT_RESOURCES.map((template) => {
            if (!groupSortCounters[template.group]) {
                groupSortCounters[template.group] = 0;
            }
            groupSortCounters[template.group]++;
            return {
                id: generateUUID(),
                label: template.label,
                url: template.url,
                group: template.group,
                sortOrder: groupSortCounters[template.group],
                createdAt: now,
                updatedAt: now,
            };
        });
    }

    // --- Task Links helpers ---
    /**
     * Returns whether a candidate url is accepted as a task/resource link.
     * Two shapes are allowed:
     *   1. An absolute http(s) URL (e.g. "https://example.com/x").
     *   2. A same-origin RELATIVE path with no scheme (e.g. "index.html" or
     *      "/reports/foo.html") — this lets us link to local pages served
     *      alongside the app (like the PS dashboard) without hardcoding a
     *      host/port. A relative path must contain only word chars, dots,
     *      slashes and hyphens (/^[\w./-]+$/) and therefore cannot contain a
     *      colon, so dangerous schemes like `javascript:`, `data:`, `vbscript:`
     *      or `mailto:` are structurally impossible and are rejected. An empty
     *      string is rejected.
     * @param {string} url - Trimmed candidate url
     * @returns {boolean}
     */
    function isAcceptedLinkUrl(url) {
        if (typeof url !== "string") return false;
        const trimmed = url.trim();
        if (!trimmed) return false;
        if (/^https?:\/\//i.test(trimmed)) return true;
        // Scheme-less relative path only (no colon → no javascript:/data:/etc.).
        return /^[\w./-]+$/.test(trimmed);
    }

    /**
     * Sanitizes an arbitrary `links` value into a clean array of
     * `{ label, url }` objects. Each entry must have a non-empty (trimmed)
     * label and an accepted url — either an absolute http(s) URL or a
     * scheme-less same-origin relative path (see isAcceptedLinkUrl); invalid
     * entries (including dangerous schemes such as javascript:/data:) are
     * silently dropped. A missing/non-array input yields an empty array.
     * Returns fresh objects so callers never share references with a template.
     *
     * @param {*} links - Candidate links value (array of {label,url}, or anything)
     * @returns {{label: string, url: string}[]}
     */
    function normalizeLinks(links) {
        if (!Array.isArray(links)) return [];
        const out = [];
        for (const link of links) {
            if (!link || typeof link !== "object") continue;
            const label = typeof link.label === "string" ? link.label.trim() : "";
            const url = typeof link.url === "string" ? link.url.trim() : "";
            if (!label) continue;
            if (!isAcceptedLinkUrl(url)) continue;
            out.push({ label, url });
        }
        return out;
    }

    /**
     * Builds a map of `{ [normalizedTitle]: links[] }` derived from the
     * DEFAULT_TASKS entries that carry a non-empty `links` array. Titles are
     * normalized (trimmed + lower-cased) so the migration in the state manager
     * can match legacy tasks case-insensitively. Each call returns fresh copies
     * of the link objects, so mutating the result never affects the templates.
     *
     * This is the single source of truth the taskLinksV1 migration uses to
     * decide which default title should get which links.
     *
     * @returns {Object<string, {label: string, url: string}[]>}
     */
    function getDefaultTaskLinksByTitle() {
        const map = {};
        for (const template of DEFAULT_TASKS) {
            const links = normalizeLinks(template.links);
            if (links.length === 0) continue;
            const key = template.title.trim().toLowerCase();
            map[key] = links;
        }
        return map;
    }

    /**
     * Single source of truth for the linkCorrectionsV1 migration: describes,
     * per task title, which OLD default link URL(s) a persisted state may
     * currently hold and the corrected NEW links to replace them with.
     *
     * The migration only rewrites a task when its CURRENT link URLs are exactly
     * the recorded `oldUrls` set (or the task has no links at all). That guard
     * preserves any genuine user customization — a task whose links differ from
     * the known-old default is left untouched.
     *
     * Titles are normalized (trimmed + lower-cased) so matching is
     * case-insensitive, mirroring getDefaultTaskLinksByTitle(). Each call
     * returns fresh copies of the new link objects and fresh `oldUrls` arrays.
     *
     * Only titles whose links CHANGED are listed here — unchanged tasks (e.g.
     * "RBIs / ARCs / iCares / Dragonflys") are intentionally omitted.
     *
     * @returns {Object<string, {oldUrls: string[], newLinks: {label: string, url: string}[]}>}
     */
    function getTaskLinkCorrections() {
        const entries = [
            // title, oldUrls (old default set; [] means "previously no links"), newLinks
            ["PS staffing headcount update (per period)",
                [URL_VANTAGE_FULFILLMENT],
                [{ label: "PS Dashboard", url: URL_PS_DASHBOARD }]],
            ["Share PS staffing updates in Slack channels",
                [URL_VANTAGE_FULFILLMENT, URL_STAFFING_COMMAND_CENTER],
                [{ label: "PS Dashboard", url: URL_PS_DASHBOARD }]],
            ["Conduct required audits",
                [],
                [{ label: "Apollo Audit", url: URL_APOLLO_AUDIT }]],
            ["Submit 5+ Feedbacks (myGrow)",
                [],
                [{ label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS }]],
            ["Complete all necessary STUs",
                [],
                [{ label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS }]],
            ["Quality STUs \u2014 coach high-consistency low-quality stowers",
                [],
                [{ label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS }]],
            ["GCAs \u2014 verify PA completion, call out when due",
                [URL_ATLAS_STANDARD_WORK],
                [{ label: "GCA Menu", url: URL_GCA_MENU }]],
            ["WHS huddle tracking (associates current)",
                [],
                [{ label: "A to Z", url: URL_ATOZ_ADAPT_ACTIONS }]],
            ["Monitor rate/UPH \u2014 coach bottom performers",
                [URL_FCLM_PROCESS_PATH_ROLLUP, URL_FCLM_FUNCTION_ROLLUP],
                [{ label: "Metric Performance", url: URL_VANTAGE_STOW_DASHBOARD }]],
            ["UIT monitoring \u2014 address high-UIT associates",
                [],
                [{ label: "TNL", url: URL_FCLM_TIME_ON_TASK }]],
        ];

        const map = {};
        for (const [title, oldUrls, newLinks] of entries) {
            map[title.trim().toLowerCase()] = {
                oldUrls: oldUrls.slice(),
                newLinks: newLinks.map((l) => ({ label: l.label, url: l.url })),
            };
        }
        return map;
    }

    /**
     * The three new resource links that the linkCorrectionsV1 migration merges
     * into an existing (persisted) state's resources directory. Single source
     * of truth shared by the migration and its tests.
     * @returns {{label: string, url: string, group: string}[]}
     */
    function getLinkCorrectionResourceAdditions() {
        return [
            { label: "Apollo Audit", url: URL_APOLLO_AUDIT, group: "Standard Work" },
            { label: "GCA Menu (AFT/MAASK)", url: URL_GCA_MENU, group: "Coaching & People" },
            { label: "PS Dashboard", url: URL_PS_DASHBOARD, group: "Staffing & Labor" },
        ];
    }

    // --- Build Initial State from Default Tasks ---
    /**
     * Creates a fresh StandardWorkState with generated UUIDs for all default tasks.
     * Used on first load when no existing state is found.
     *
     * @returns {Object} A valid StandardWorkState object
     */
    function createInitialState() {
        const now = new Date().toISOString();
        const today = now.slice(0, 10);

        // Generate tasks with UUIDs and sort orders
        const tasks = [];
        const categorySortCounters = {}; // Track sort order per frequency+category

        for (const template of DEFAULT_TASKS) {
            const key = `${template.frequency}_${template.category}`;
            if (!categorySortCounters[key]) {
                categorySortCounters[key] = 0;
            }
            categorySortCounters[key]++;

            tasks.push({
                id: generateUUID(),
                title: template.title,
                category: template.category,
                frequency: template.frequency,
                notes: "",
                editable: template.editable,
                editableField: template.editableField,
                links: normalizeLinks(template.links),
                carryover: false,
                sortOrder: categorySortCounters[key],
                createdAt: now,
                updatedAt: now,
            });
        }

        // Initialize daily status entries for all daily tasks
        const dailyStatus = {};
        const weeklyStatus = {};
        const monthlyStatus = {};

        for (const task of tasks) {
            if (task.frequency === "daily") {
                dailyStatus[task.id] = { status: "not_started", periodCompleted: null, notes: "" };
            } else if (task.frequency === "weekly") {
                weeklyStatus[task.id] = { status: "not_started", periodCompleted: null, notes: "" };
            } else if (task.frequency === "monthly") {
                monthlyStatus[task.id] = { status: "not_started", periodCompleted: null, notes: "" };
            }
        }

        return {
            version: 1,
            // Fresh states already include the OM-priority tasks, the new
            // Metrics & Reports resource links, the per-task quick links, and
            // the corrected link values (they're all baked into DEFAULT_TASKS /
            // DEFAULT_RESOURCES), so mark every seed/correction migration as
            // already-applied to keep them no-ops on subsequent loads
            // (see StandardWorkState.init()).
            migrations: { omPriorityTasksV1: true, metricsResourcesV1: true, taskLinksV1: true, linkCorrectionsV1: true },
            lastResetDate: today,
            weeklyObjectives: "",
            shiftConfig: {
                periodsPerShift: 4,
                shiftStart: "06:00",
                shiftEnd: "16:30",
            },
            tasks: tasks,
            dailyStatus: dailyStatus,
            weeklyStatus: weeklyStatus,
            monthlyStatus: monthlyStatus,
            resources: createDefaultResources(),
        };
    }

    // --- Public API ---
    return {
        generateUUID,
        getWeekNumber,
        createInitialState,
        createDefaultResources,
        normalizeLinks,
        isAcceptedLinkUrl,
        getDefaultTaskLinksByTitle,
        getTaskLinkCorrections,
        getLinkCorrectionResourceAdditions,
        DEFAULT_TASKS,
        OM_PRIORITY_SPLIT_OLD_TITLE,
        OM_PRIORITY_SPLIT_NEW_TITLES,
        OM_PRIORITY_NEW_TASKS,
        DEFAULT_RESOURCES,
        RESOURCE_GROUP_ORDER,
        VALID_STATUSES,
        VALID_FREQUENCIES,
        VALID_CATEGORIES,
        CATEGORY_ORDER,
        CATEGORY_LABELS,
    };
})();

// Node.js module export (for test runners); no-op in the browser.
if (typeof module !== "undefined" && module.exports) {
    module.exports = StandardWorkData;
}
