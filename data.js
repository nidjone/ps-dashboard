// ============================================================
// IB Problem Solve Dashboard - Mock Data Layer
// ============================================================

const DATA = (() => {
    // --- Roster ---
    // Permanently managed roster - added manually by the user
    // Each entry: { firstName, lastName, login, badgeId, floor, clockedIn }
    const roster = [];

    // --- Individual Performance Metrics ---
    const performance = {
        "jsmith":      { uph: 42, tot: 88, unitsShift: 336, unitsWeek: 1680, dwellAvg: 18, firstTouch: 91 },
        "mjones":      { uph: 38, tot: 82, unitsShift: 304, unitsWeek: 1520, dwellAvg: 22, firstTouch: 87 },
        "dlee":        { uph: 35, tot: 79, unitsShift: 280, unitsWeek: 1400, dwellAvg: 25, firstTouch: 83 },
        "kwilson":     { uph: 40, tot: 85, unitsShift: 320, unitsWeek: 1600, dwellAvg: 19, firstTouch: 89 },
        "rbrown":      { uph: 45, tot: 91, unitsShift: 360, unitsWeek: 1800, dwellAvg: 15, firstTouch: 94 },
        "agarcia":     { uph: 37, tot: 80, unitsShift: 296, unitsWeek: 1480, dwellAvg: 23, firstTouch: 85 },
        "tmartin":     { uph: 0,  tot: 0,  unitsShift: 0,   unitsWeek: 0,    dwellAvg: 0,  firstTouch: 0 },
        "lchen":       { uph: 44, tot: 90, unitsShift: 352, unitsWeek: 1760, dwellAvg: 16, firstTouch: 92 },
        "jdavis":      { uph: 33, tot: 76, unitsShift: 264, unitsWeek: 1320, dwellAvg: 28, firstTouch: 80 },
        "pthompson":   { uph: 41, tot: 87, unitsShift: 328, unitsWeek: 1640, dwellAvg: 20, firstTouch: 90 },
        "mrodriguez":  { uph: 39, tot: 84, unitsShift: 312, unitsWeek: 1560, dwellAvg: 21, firstTouch: 88 },
        "swilliams":   { uph: 36, tot: 81, unitsShift: 288, unitsWeek: 1440, dwellAvg: 24, firstTouch: 86 },
        "bwhite":      { uph: 0,  tot: 0,  unitsShift: 0,   unitsWeek: 0,    dwellAvg: 0,  firstTouch: 0 },
        "jmiller":     { uph: 43, tot: 89, unitsShift: 344, unitsWeek: 1720, dwellAvg: 17, firstTouch: 93 },
        "canderson":   { uph: 46, tot: 92, unitsShift: 368, unitsWeek: 1840, dwellAvg: 14, firstTouch: 95 },
        "ntaylor":     { uph: 34, tot: 77, unitsShift: 272, unitsWeek: 1360, dwellAvg: 26, firstTouch: 82 },
        "dharris":     { uph: 38, tot: 83, unitsShift: 304, unitsWeek: 1520, dwellAvg: 22, firstTouch: 87 },
        "kclark":      { uph: 41, tot: 86, unitsShift: 328, unitsWeek: 1640, dwellAvg: 19, firstTouch: 90 },
        "mlewis":      { uph: 47, tot: 93, unitsShift: 376, unitsWeek: 1880, dwellAvg: 13, firstTouch: 96 },
        "awalker":     { uph: 32, tot: 74, unitsShift: 256, unitsWeek: 1280, dwellAvg: 29, firstTouch: 78 },
    };

    // --- Pile Tracking ---
    const pileData = {
        // SOS and EOS counts by floor
        sos: { 1: 145, 2: 198, 3: 167, 4: 122 },
        eos: { 1: 128, 2: 175, 3: 152, 4: 108 },
        // Current counts
        current: { 1: 134, 2: 182, 3: 158, 4: 115 },
        // Intra-shift counts (every 2 hours)
        intraShift: [
            { time: "06:00", floors: { 1: 145, 2: 198, 3: 167, 4: 122 } },
            { time: "08:00", floors: { 1: 152, 2: 205, 3: 174, 4: 130 } },
            { time: "10:00", floors: { 1: 148, 2: 195, 3: 168, 4: 125 } },
            { time: "12:00", floors: { 1: 140, 2: 188, 3: 162, 4: 118 } },
            { time: "14:00", floors: { 1: 136, 2: 184, 3: 159, 4: 116 } },
            { time: "16:00", floors: { 1: 134, 2: 182, 3: 158, 4: 115 } },
        ],
        // Aging buckets (site-wide)
        aging: {
            "0-24hrs": 312,
            "24-48hrs": 145,
            "48-72hrs": 67,
            "72hrs+": 65,
        },
        // Hourly inflow vs outflow
        flowData: [
            { hour: "06:00", inflow: 45, outflow: 32 },
            { hour: "07:00", inflow: 52, outflow: 41 },
            { hour: "08:00", inflow: 48, outflow: 50 },
            { hour: "09:00", inflow: 38, outflow: 45 },
            { hour: "10:00", inflow: 42, outflow: 48 },
            { hour: "11:00", inflow: 35, outflow: 44 },
            { hour: "12:00", inflow: 50, outflow: 42 },
            { hour: "13:00", inflow: 44, outflow: 47 },
            { hour: "14:00", inflow: 39, outflow: 43 },
            { hour: "15:00", inflow: 36, outflow: 40 },
            { hour: "16:00", inflow: 33, outflow: 38 },
        ],
    };

    // --- Floor-Level Data ---
    const floors = [
        {
            id: 1,
            name: "A02 - Stow",
            pileCount: 134,
            trend: "down",
            throughput: 152,
            targetStaffing: 4,
            idealRatio: 35, // items per PS
        },
        {
            id: 2,
            name: "A03 - Stow",
            pileCount: 182,
            trend: "down",
            throughput: 138,
            targetStaffing: 5,
            idealRatio: 35,
        },
        {
            id: 3,
            name: "A04 - Stow",
            pileCount: 158,
            trend: "down",
            throughput: 144,
            targetStaffing: 4,
            idealRatio: 35,
        },
        {
            id: 4,
            name: "A05 - Stow",
            pileCount: 115,
            trend: "down",
            throughput: 165,
            targetStaffing: 4,
            idealRatio: 35,
        },
    ];

    // --- Quality / Accountability ---
    const quality = {
        errorRate: 4.2,  // % rework
        escalationCount: 7,
        reasonCodes: {
            "Damaged": 142,
            "Overage": 98,
            "Mislabel": 76,
            "Missing Item": 115,
            "Wrong Location": 64,
            "Other": 44,
        },
        // Rework trend (last 7 days)
        reworkTrend: [5.1, 4.8, 4.5, 4.9, 4.3, 4.0, 4.2],
        // Coaching flags
        coachingFlags: [
            { login: "awalker", name: "Amanda Walker", reason: "UPH below threshold (32 vs 35 target)", type: "rate" },
            { login: "jdavis", name: "James Davis", reason: "ToT below threshold (76% vs 80% target)", type: "tot" },
            { login: "ntaylor", name: "Nicole Taylor", reason: "UPH below threshold (34 vs 35 target)", type: "rate" },
            { login: "dlee", name: "David Lee", reason: "First Touch below threshold (83% vs 85% target)", type: "quality" },
        ],
        // Escalations
        escalations: [
            { id: "ESC-001", item: "ASIN B07XYZ123", reason: "Hazmat - requires safety team", floor: 2, status: "open", age: "4h" },
            { id: "ESC-002", item: "ASIN B09ABC456", reason: "High-value item - manager override needed", floor: 1, status: "open", age: "2h" },
            { id: "ESC-003", item: "ASIN B08DEF789", reason: "System error - IT ticket filed", floor: 3, status: "pending", age: "6h" },
            { id: "ESC-004", item: "ASIN B06GHI012", reason: "Vendor return - needs approval", floor: 4, status: "open", age: "1h" },
            { id: "ESC-005", item: "ASIN B05JKL345", reason: "Damaged pallet - dock team needed", floor: 1, status: "resolved", age: "8h" },
            { id: "ESC-006", item: "ASIN B04MNO678", reason: "Missing shipment - carrier claim", floor: 2, status: "pending", age: "12h" },
            { id: "ESC-007", item: "ASIN B03PQR901", reason: "Customer escalation - priority", floor: 3, status: "open", age: "30m" },
        ],
    };

    // --- Shift Handoff ---
    const shiftHandoff = {
        outgoingShift: "Day",
        incomingShift: "Night",
        timestamp: "2026-07-28 18:00",
        summary: {
            totalPileInherited: 589,
            hotItems: 12,
            openEscalations: 5,
            notes: [
                "A03 had a surge at 12:00 due to truck arrivals — pile peaked at 205, now trending down.",
                "A02 Amanda Walker needs coaching on rate — assigned lighter area for remainder of shift.",
                "3 hazmat escalations still open — safety team ETA is next hour.",
                "ICQA audit running on A05 — may generate additional PS volume tonight.",
            ],
        },
    };

    // --- Daily/Weekly Trends ---
    const trends = {
        // Last 7 days pile counts (end of day)
        dailyPile: [
            { date: "Jul 22", count: 645 },
            { date: "Jul 23", count: 612 },
            { date: "Jul 24", count: 598 },
            { date: "Jul 25", count: 621 },
            { date: "Jul 26", count: 575 },
            { date: "Jul 27", count: 560 },
            { date: "Jul 28", count: 589 },
        ],
        // Daily resolution rates
        dailyResolution: [
            { date: "Jul 22", rate: 82 },
            { date: "Jul 23", rate: 85 },
            { date: "Jul 24", rate: 87 },
            { date: "Jul 25", rate: 84 },
            { date: "Jul 26", rate: 89 },
            { date: "Jul 27", rate: 91 },
            { date: "Jul 28", rate: 88 },
        ],
        // Daily staffing
        dailyStaffing: [14, 15, 14, 13, 15, 16, 15],
    };

    // --- KPI Targets ---
    const kpiTargets = {
        rateTarget: 60,       // UPH site target
        totTarget: 85,        // % target
        slaTarget: 85,        // % resolved within 24hrs
        firstTouchTarget: 85, // %
    };

    // --- Target Headcount per Floor (configurable at SOS) ---
    const targetHC = { 1: 3, 2: 3, 3: 3, 4: 3 };

    // --- Computed KPIs ---
    function computeKPIs(shiftFilter = "all", floorFilter = "all") {
        // Full roster (everyone added)
        const shiftRoster = roster.filter(r => {
            if (floorFilter !== "all" && r.floor !== parseInt(floorFilter)) return false;
            return true;
        });

        // Clocked in = those toggled on
        const clockedIn = shiftRoster.filter(r => r.clockedIn);

        const perfs = clockedIn.map(r => performance[r.login]).filter(p => p && p.uph > 0);

        const totalPile = Object.values(pileData.current).reduce((a, b) => a + b, 0);
        const avgUPH = perfs.length ? Math.round(perfs.reduce((a, p) => a + p.uph, 0) / perfs.length) : 0;
        const avgToT = perfs.length ? Math.round(perfs.reduce((a, p) => a + p.tot, 0) / perfs.length) : 0;
        const within24 = pileData.aging["0-24hrs"];
        const totalAging = Object.values(pileData.aging).reduce((a, b) => a + b, 0);
        const slaPct = totalAging > 0 ? Math.round((within24 / totalAging) * 100) : 0;

        // Top and bottom performers (from those clocked in with data)
        const sorted = [...clockedIn]
            .filter(r => performance[r.login] && performance[r.login].uph > 0)
            .sort((a, b) => performance[b.login].uph - performance[a.login].uph);
        const topPerformer = sorted[0] || null;
        const bottomPerformer = sorted[sorted.length - 1] || null;

        // Floor with highest/lowest pile
        const floorEntries = Object.entries(pileData.current);
        const highestPileFloor = floorEntries.reduce((a, b) => b[1] > a[1] ? b : a);
        const lowestPileFloor = floorEntries.reduce((a, b) => b[1] < a[1] ? b : a);

        return {
            totalPile,
            avgUPH,
            avgToT,
            totalUnits: perfs.reduce((a, p) => a + (p.unitsShift || 0), 0),
            plannedHeadcount: floorFilter !== "all" ? (targetHC[parseInt(floorFilter)] || 3) : Object.values(targetHC).reduce((a, b) => a + b, 0),
            clockedInCount: clockedIn.length,
            topPerformer,
            bottomPerformer,
            highestPileFloor: { floor: highestPileFloor[0], count: highestPileFloor[1] },
            lowestPileFloor: { floor: lowestPileFloor[0], count: lowestPileFloor[1] },
            rateTarget: kpiTargets.rateTarget,
            slaTarget: kpiTargets.slaTarget,
        };
    }

    // --- Damageland ---
    const damagelandRoster = [];
    const damagelandTargetHC = { dlPS: 1, ps: 10 };

    return {
        roster,
        performance,
        pileData,
        floors,
        quality,
        shiftHandoff,
        trends,
        kpiTargets,
        targetHC,
        damagelandRoster,
        damagelandTargetHC,
        computeKPIs,
    };
})();
