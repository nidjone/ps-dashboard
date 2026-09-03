// ============================================================
// Unit Tests — Link corrections (data layer + linkCorrectionsV1 migration)
// Covers:
//   - New URL consts wired into the correct DEFAULT_TASKS entries (by title).
//   - getTaskLinkCorrections() old->new mapping correctness.
//   - migrateLinkCorrectionsV1: legacy correction, customization preserved,
//     idempotence, fresh-state no-op, resource merge/dedupe + duplicate EHS
//     removal.
//   - normalizeLinks/isAcceptedLinkUrl now accepts a relative "index.html"
//     path but still rejects javascript:/data:/empty.
//   - createInitialState() migrations includes linkCorrectionsV1: true.
// ============================================================
//
// Follows the same fake-DOM approach as standard-work-task-links.test.js:
// a minimal fake DOM/localStorage/fetch environment is installed before the
// modules are required. The business logic under test is the real,
// unmodified implementation.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Install browser-shaped globals before requiring the modules under test ---
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
global.document = {
    addEventListener() {},
    getElementById() {
        return null;
    },
    querySelector() {
        return null;
    },
    querySelectorAll() {
        return [];
    },
};
global.fetch = () => Promise.reject(new Error("no network in test environment"));
global.AbortSignal = global.AbortSignal || { timeout: () => undefined };
global.confirm = () => true;

const StandardWorkData = require("./standard-work-data.js");
global.StandardWorkData = StandardWorkData;
global.StandardWorkHistory = { saveShiftSnapshot: () => {} };

const StandardWorkState = require("./standard-work.js");
global.StandardWorkState = StandardWorkState;

// --- Known URLs (kept in sync with standard-work-data.js) ---
const URL_APOLLO_AUDIT = "https://apollo-audit.corp.amazon.com/";
const URL_PS_DASHBOARD = "index.html";
const URL_GCA_MENU_PREFIX = "https://d34wrqb3xn2znf.cloudfront.net/idp-selection";
const URL_ATOZ = "https://atoz.amazon.work/engage/adapt-actions/employee/206993248";
const URL_TNL = "https://fclm-portal.amazon.com/reports/timeOnTask?&warehouseId=ORF3";
const URL_VANTAGE_STOW = "https://vantage.amazon.com/app/home/404?redirectFrom=%2Fstow-dashboard&view=landing";
const URL_EHS = "https://na.ehs-amazon.com/home";
const URL_VANTAGE_FULFILLMENT =
    "https://vantage.amazon.com/app/fulfillment-dashboards/current-station-work?customer=AMZN&warehouse=ORF3&region=us-east-1&zones=paKivaA02%2CpaKivaA03%2CpaKivaA04%2CpaKivaA05";
const URL_STAFFING_CC = "https://staffingcommandcenter-na.aka.amazon.com/ORF3/plan/AR_RSP/paKivaA02/IB";
const URL_ATLAS_SW = "https://atlas.qubit.amazon.dev/standard-work?hideCompleted=true&hideNA=true";

function findTaskByTitle(tasks, title) {
    return tasks.find((t) => t.title === title);
}
function labels(links) {
    return links.map((l) => l.label);
}
function urls(links) {
    return links.map((l) => l.url);
}

// ---------------------------------------------------------------
// New URL consts wired into DEFAULT_TASKS
// ---------------------------------------------------------------

test("DEFAULT_TASKS carry the corrected links by title", () => {
    const state = StandardWorkData.createInitialState();
    const byTitle = (t) => findTaskByTitle(state.tasks, t);

    const psHead = byTitle("PS staffing headcount update (per period)");
    assert.deepEqual(labels(psHead.links), ["PS Dashboard"]);
    assert.deepEqual(urls(psHead.links), [URL_PS_DASHBOARD]);

    const sharePs = byTitle("Share PS staffing updates in Slack channels");
    assert.deepEqual(labels(sharePs.links), ["PS Dashboard"]);
    assert.deepEqual(urls(sharePs.links), [URL_PS_DASHBOARD]);

    const audits = byTitle("Conduct required audits");
    assert.deepEqual(labels(audits.links), ["Apollo Audit"]);
    assert.deepEqual(urls(audits.links), [URL_APOLLO_AUDIT]);

    const feedbacks = byTitle("Submit 5+ Feedbacks (myGrow)");
    assert.deepEqual(labels(feedbacks.links), ["A to Z"]);
    assert.deepEqual(urls(feedbacks.links), [URL_ATOZ]);

    const stus = byTitle("Complete all necessary STUs");
    assert.deepEqual(labels(stus.links), ["A to Z"]);

    const qualStus = byTitle("Quality STUs \u2014 coach high-consistency low-quality stowers");
    assert.deepEqual(labels(qualStus.links), ["A to Z"]);

    const gcas = byTitle("GCAs \u2014 verify PA completion, call out when due");
    assert.deepEqual(labels(gcas.links), ["GCA Menu"]);
    assert.ok(gcas.links[0].url.startsWith(URL_GCA_MENU_PREFIX));

    const whs = byTitle("WHS huddle tracking (associates current)");
    assert.deepEqual(labels(whs.links), ["A to Z"]);

    const rate = byTitle("Monitor rate/UPH \u2014 coach bottom performers");
    assert.deepEqual(labels(rate.links), ["Metric Performance"]);
    assert.deepEqual(urls(rate.links), [URL_VANTAGE_STOW]);

    const uit = byTitle("UIT monitoring \u2014 address high-UIT associates");
    assert.deepEqual(labels(uit.links), ["TNL"]);
    assert.deepEqual(urls(uit.links), [URL_TNL]);

    // RBIs is unchanged (still EHS).
    const rbis = byTitle("RBIs / ARCs / iCares / Dragonflys");
    assert.deepEqual(labels(rbis.links), ["EHS"]);
    assert.deepEqual(urls(rbis.links), [URL_EHS]);
});

test("OM_PRIORITY_NEW_TASKS mirror the corrected links", () => {
    const byTitle = (t) => StandardWorkData.OM_PRIORITY_NEW_TASKS.find((x) => x.title === t);
    assert.deepEqual(labels(byTitle("Quality STUs \u2014 coach high-consistency low-quality stowers").links), ["A to Z"]);
    assert.deepEqual(labels(byTitle("GCAs \u2014 verify PA completion, call out when due").links), ["GCA Menu"]);
    assert.deepEqual(labels(byTitle("Share PS staffing updates in Slack channels").links), ["PS Dashboard"]);
    assert.deepEqual(labels(byTitle("RBIs / ARCs / iCares / Dragonflys").links), ["EHS"]);
});

test("createInitialState migrations includes linkCorrectionsV1: true", () => {
    const state = StandardWorkData.createInitialState();
    assert.equal(state.migrations.linkCorrectionsV1, true);
});

test("new resource links exist in DEFAULT_RESOURCES under sensible existing groups", () => {
    const byLabel = (l) => StandardWorkData.DEFAULT_RESOURCES.find((r) => r.label === l);
    const groups = new Set(StandardWorkData.RESOURCE_GROUP_ORDER);

    const apollo = byLabel("Apollo Audit");
    assert.ok(apollo);
    assert.equal(apollo.url, URL_APOLLO_AUDIT);
    assert.ok(groups.has(apollo.group), "Apollo uses an existing group");

    const gca = byLabel("GCA Menu (AFT/MAASK)");
    assert.ok(gca);
    assert.equal(gca.group, "Coaching & People");

    const ps = byLabel("PS Dashboard");
    assert.ok(ps);
    assert.equal(ps.url, URL_PS_DASHBOARD);
    assert.equal(ps.group, "Staffing & Labor");

    // No new groups introduced.
    for (const r of StandardWorkData.DEFAULT_RESOURCES) {
        assert.ok(groups.has(r.group), `resource "${r.label}" uses an existing group`);
    }
});

// ---------------------------------------------------------------
// getTaskLinkCorrections mapping
// ---------------------------------------------------------------

test("getTaskLinkCorrections maps normalized titles to old->new links", () => {
    const map = StandardWorkData.getTaskLinkCorrections();

    const psHead = map["ps staffing headcount update (per period)"];
    assert.deepEqual(psHead.oldUrls, [URL_VANTAGE_FULFILLMENT]);
    assert.deepEqual(labels(psHead.newLinks), ["PS Dashboard"]);

    const sharePs = map["share ps staffing updates in slack channels"];
    assert.deepEqual(sharePs.oldUrls, [URL_VANTAGE_FULFILLMENT, URL_STAFFING_CC]);
    assert.deepEqual(urls(sharePs.newLinks), [URL_PS_DASHBOARD]);

    const gcas = map["gcas \u2014 verify pa completion, call out when due"];
    assert.deepEqual(gcas.oldUrls, [URL_ATLAS_SW]);
    assert.deepEqual(labels(gcas.newLinks), ["GCA Menu"]);

    const audits = map["conduct required audits"];
    assert.deepEqual(audits.oldUrls, []); // previously no links
    assert.deepEqual(labels(audits.newLinks), ["Apollo Audit"]);

    // RBIs is NOT in the corrections map (unchanged).
    assert.equal(map["rbis / arcs / icares / dragonflys"], undefined);

    // Returns fresh copies (mutating result never affects a subsequent call).
    psHead.newLinks[0].label = "MUTATED";
    const fresh = StandardWorkData.getTaskLinkCorrections();
    assert.equal(fresh["ps staffing headcount update (per period)"].newLinks[0].label, "PS Dashboard");
});

// ---------------------------------------------------------------
// migrateLinkCorrectionsV1
// ---------------------------------------------------------------

/**
 * Builds a legacy (persisted-shape) state: takes a fresh state, clears the
 * linkCorrectionsV1 flag, and rewrites the corrected tasks back to their OLD
 * link values so the migration has something to fix.
 */
function makeLegacyState() {
    const state = StandardWorkData.createInitialState();
    delete state.migrations.linkCorrectionsV1;

    const set = (title, links) => {
        const t = findTaskByTitle(state.tasks, title);
        if (t) t.links = links;
    };
    set("PS staffing headcount update (per period)", [{ label: "Vantage", url: URL_VANTAGE_FULFILLMENT }]);
    set("Share PS staffing updates in Slack channels", [
        { label: "Vantage", url: URL_VANTAGE_FULFILLMENT },
        { label: "Staffing Command Center", url: URL_STAFFING_CC },
    ]);
    set("GCAs \u2014 verify PA completion, call out when due", [{ label: "Atlas SWCL", url: URL_ATLAS_SW }]);
    set("Monitor rate/UPH \u2014 coach bottom performers", [
        { label: "Process Path Roll-up", url: "https://fclm-portal.amazon.com/reports/processPathRollup?x=1" },
        { label: "Function Roll-up", url: "https://fclm-portal.amazon.com/reports/functionRollup?y=1" },
    ]);
    // Tasks that previously had no links.
    set("Conduct required audits", []);
    set("Submit 5+ Feedbacks (myGrow)", []);
    set("WHS huddle tracking (associates current)", []);
    set("UIT monitoring \u2014 address high-UIT associates", []);
    return state;
}

test("migrateLinkCorrectionsV1 corrects legacy links matching the old default", () => {
    const legacy = makeLegacyState();
    // The old Monitor rate/UPH urls in makeLegacyState don't match the exact
    // recorded old defaults, so make them match here to exercise the multi-url
    // replacement path deterministically.
    const rate = findTaskByTitle(legacy.tasks, "Monitor rate/UPH \u2014 coach bottom performers");
    const corr = StandardWorkData.getTaskLinkCorrections()["monitor rate/uph \u2014 coach bottom performers"];
    rate.links = corr.oldUrls.map((u, i) => ({ label: "Old" + i, url: u }));

    const ran = StandardWorkState.migrateLinkCorrectionsV1(legacy);
    assert.equal(ran, true);
    assert.equal(legacy.migrations.linkCorrectionsV1, true);

    const byTitle = (t) => findTaskByTitle(legacy.tasks, t);
    assert.deepEqual(labels(byTitle("PS staffing headcount update (per period)").links), ["PS Dashboard"]);
    assert.deepEqual(labels(byTitle("Share PS staffing updates in Slack channels").links), ["PS Dashboard"]);
    assert.deepEqual(labels(byTitle("GCAs \u2014 verify PA completion, call out when due").links), ["GCA Menu"]);
    assert.deepEqual(labels(byTitle("Monitor rate/UPH \u2014 coach bottom performers").links), ["Metric Performance"]);
    // Previously-empty tasks get the new links.
    assert.deepEqual(labels(byTitle("Conduct required audits").links), ["Apollo Audit"]);
    assert.deepEqual(labels(byTitle("Submit 5+ Feedbacks (myGrow)").links), ["A to Z"]);
    assert.deepEqual(labels(byTitle("WHS huddle tracking (associates current)").links), ["A to Z"]);
    assert.deepEqual(labels(byTitle("UIT monitoring \u2014 address high-UIT associates").links), ["TNL"]);
});

test("migrateLinkCorrectionsV1 preserves user-customized links", () => {
    const legacy = makeLegacyState();
    // User customized GCAs to their own bookmark — must NOT be overwritten.
    const gcas = findTaskByTitle(legacy.tasks, "GCAs \u2014 verify PA completion, call out when due");
    gcas.links = [{ label: "My GCA bookmark", url: "https://my.example.com/gca" }];
    // User customized PS headcount to a different link — preserved.
    const psHead = findTaskByTitle(legacy.tasks, "PS staffing headcount update (per period)");
    psHead.links = [{ label: "Custom PS", url: "https://custom.example.com/ps" }];

    StandardWorkState.migrateLinkCorrectionsV1(legacy);

    const gcasAfter = findTaskByTitle(legacy.tasks, "GCAs \u2014 verify PA completion, call out when due");
    assert.deepEqual(labels(gcasAfter.links), ["My GCA bookmark"]);
    const psAfter = findTaskByTitle(legacy.tasks, "PS staffing headcount update (per period)");
    assert.deepEqual(labels(psAfter.links), ["Custom PS"]);
});

test("migrateLinkCorrectionsV1 is idempotent and no-ops on fresh state", () => {
    const legacy = makeLegacyState();
    assert.equal(StandardWorkState.migrateLinkCorrectionsV1(legacy), true);
    // Second run: flag already set, no-op.
    assert.equal(StandardWorkState.migrateLinkCorrectionsV1(legacy), false);
    assert.equal(legacy.migrations.linkCorrectionsV1, true);
    assert.deepEqual(
        labels(findTaskByTitle(legacy.tasks, "Conduct required audits").links),
        ["Apollo Audit"]
    );

    // Fresh state: flag already true, migration is a no-op.
    const fresh = StandardWorkData.createInitialState();
    assert.equal(fresh.migrations.linkCorrectionsV1, true);
    assert.equal(StandardWorkState.migrateLinkCorrectionsV1(fresh), false);
});

test("migrateLinkCorrectionsV1 merges the three new resource links (dedupe by URL)", () => {
    const legacy = makeLegacyState();
    // Give the state a resources array WITHOUT the three additions, plus one
    // that already matches (PS Dashboard) to prove dedupe.
    legacy.resources = [
        { id: "r1", label: "Existing PS", url: URL_PS_DASHBOARD, group: "Staffing & Labor", sortOrder: 1, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" },
    ];

    StandardWorkState.migrateLinkCorrectionsV1(legacy);

    const countByUrl = (u) => legacy.resources.filter((r) => r.url.toLowerCase() === u.toLowerCase()).length;
    assert.equal(countByUrl(URL_PS_DASHBOARD), 1, "PS Dashboard not duplicated");
    assert.equal(countByUrl(URL_APOLLO_AUDIT), 1, "Apollo Audit added");
    assert.equal(legacy.resources.filter((r) => r.url.startsWith(URL_GCA_MENU_PREFIX)).length, 1, "GCA Menu added");
    // The user's pre-existing PS resource label is untouched.
    assert.equal(legacy.resources.find((r) => r.id === "r1").label, "Existing PS");
});

test("migrateLinkCorrectionsV1 removes a duplicate EHS/RBIs Safety entry, keeping the earliest", () => {
    const legacy = makeLegacyState();
    legacy.resources = [
        { id: "ehs-a", label: "EHS \u2014 RBIs / iCares / Safety", url: URL_EHS, group: "Safety", sortOrder: 1, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" },
        { id: "ehs-b", label: "RBIs (duplicate)", url: URL_EHS, group: "Safety", sortOrder: 2, createdAt: "2021-01-01T00:00:00.000Z", updatedAt: "2021-01-01T00:00:00.000Z" },
    ];

    StandardWorkState.migrateLinkCorrectionsV1(legacy);

    const ehs = legacy.resources.filter((r) => r.group === "Safety" && r.url === URL_EHS);
    assert.equal(ehs.length, 1, "only one EHS Safety entry remains");
    assert.equal(ehs[0].id, "ehs-a", "the earliest (lowest sortOrder) is kept");
});

// ---------------------------------------------------------------
// normalizeLinks / isAcceptedLinkUrl — relative path acceptance
// ---------------------------------------------------------------

test("isAcceptedLinkUrl accepts http(s) and scheme-less relative paths, rejects dangerous/empty", () => {
    const ok = StandardWorkData.isAcceptedLinkUrl;
    assert.equal(ok("https://example.com/x"), true);
    assert.equal(ok("http://example.com/x"), true);
    assert.equal(ok("index.html"), true);
    assert.equal(ok("/reports/foo.html"), true);
    assert.equal(ok("  index.html  "), true); // trimmed

    assert.equal(ok("javascript:alert(1)"), false);
    assert.equal(ok("data:text/html,<script>"), false);
    assert.equal(ok("mailto:me@example.com"), false);
    assert.equal(ok(""), false);
    assert.equal(ok("   "), false);
    assert.equal(ok(null), false);
    assert.equal(ok(undefined), false);
});

test("normalizeLinks keeps a relative index.html link but drops dangerous/empty", () => {
    const cleaned = StandardWorkData.normalizeLinks([
        { label: "PS Dashboard", url: "index.html" },
        { label: "Rooted", url: "/reports/foo.html" },
        { label: "Danger", url: "javascript:alert(1)" },
        { label: "Data", url: "data:text/html,x" },
        { label: "Empty", url: "" },
        { label: "", url: "index.html" }, // empty label dropped
    ]);
    assert.deepEqual(cleaned, [
        { label: "PS Dashboard", url: "index.html" },
        { label: "Rooted", url: "/reports/foo.html" },
    ]);
});
