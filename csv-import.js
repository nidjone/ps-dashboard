// ============================================================
// CSV Import Module for ORF3 IB Problem Solve Dashboard
// ============================================================

const CSVImport = (() => {
    "use strict";

    const STORAGE_KEY = "orf3_ps_dashboard_data";
    const FLOOR_MAP = { "A02": 1, "A03": 2, "A04": 3, "A05": 4 };
    const FLOOR_REVERSE = { 1: "A02", 2: "A03", 3: "A04", 4: "A05" };

    // --- CSV Parser ---
    function parseCSV(text) {
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) return [];
        // Use parseCSVLine for headers too (handles quoted fields with commas)
        const rawHeaders = parseCSVLine(lines[0]);
        const headers = rawHeaders.map(h => h.trim().toLowerCase().replace(/\s+/g, "_").replace(/"/g, ""));
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            if (values.length === 0) continue;
            const row = {};
            headers.forEach((h, idx) => {
                row[h] = (values[idx] || "").trim().replace(/^"|"$/g, "");
            });
            rows.push(row);
        }
        return rows;
    }

    // Handle quoted fields with commas
    function parseCSVLine(line) {
        const result = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === "," && !inQuotes) {
                result.push(current);
                current = "";
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }

    // --- Import Handlers ---

    // Find a column value by partial key match (handles weird header normalization)
    function findColumnValue(row, partialKey) {
        const key = Object.keys(row).find(k => k.includes(partialKey) && k.includes("total"));
        return key ? row[key] : null;
    }

    // Find column by two partial key fragments
    function findColumnByPartial(row, part1, part2) {
        const key = Object.keys(row).find(k => k.includes(part1) && k.includes(part2));
        return key ? row[key] : null;
    }

    function importPerformance(text) {
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error("No data rows found");

        const headers = Object.keys(rows[0]);

        // Detect Function Rollup Report format
        const isFunctionRollup = headers.some(h =>
            h === "process_name" || h === "function_name" || h === "employee_id"
        );

        if (isFunctionRollup) {
            return importFunctionRollup(rows);
        }

        // Simple format: login, uph, tot, units_shift, units_week, first_touch
        const required = ["login", "uph"];
        validateColumns(rows[0], required);

        let count = 0;
        rows.forEach(r => {
            const login = r.login;
            if (!login) return;
            DATA.performance[login] = {
                uph: parseInt(r.uph) || 0,
                tot: parseInt(r.tot) || 0,
                unitsShift: parseInt(r.units_shift || r.unitsshift || r.units) || 0,
                unitsWeek: parseInt(r.units_week || r.unitsweek) || 0,
                dwellAvg: 0,
                firstTouch: parseInt(r.first_touch || r.firsttouch || r.first_touch_pct) || 0,
            };
            count++;
        });

        saveToStorage();
        return `Updated metrics for ${count} associates`;
    }

    // Parse ORF3 Function Rollup Report
    function importFunctionRollup(rows) {
        // Group by Employee Id, aggregate across functions
        // Only use rows where Size = "Total" and Unit Type = "EACH" (or "Records")
        const employeeMap = {};

        rows.forEach(r => {
            const empId = r.employee_id || r["employee_id"] || "";
            const name = r.name || "";
            const size = (r.size || "").toLowerCase();
            const unitType = (r.unit_type || "").toLowerCase();
            const functionName = r.function_name || "";

            // Only aggregate the "Total" size rows with EACH unit type
            if (size !== "total" || unitType !== "each") return;
            if (!empId) return;

            if (!employeeMap[empId]) {
                employeeMap[empId] = {
                    empId: empId,
                    name: name,
                    manager: r.manager || "",
                    totalPaidHours: 0,
                    totalUnits: 0,
                    totalJobs: 0,
                    functions: [],
                };
            }

            const paidHours = parseFloat(
                r["paid_hours-total(function,employee)"] ||
                r["paid_hours-total(function_employee)"] ||
                r["paid_hours-total"] ||
                findColumnValue(r, "paid_hours") ||
                0
            );
            const units = parseInt(r.units) || 0;
            const jobs = parseInt(r.jobs) || 0;

            // Avoid double-counting if same function appears multiple times
            // (e.g. person does Damages + Stow to Prime PSolve)
            employeeMap[empId].totalPaidHours += paidHours;
            employeeMap[empId].totalUnits += units;
            employeeMap[empId].totalJobs += jobs;
            if (functionName && !employeeMap[empId].functions.includes(functionName)) {
                employeeMap[empId].functions.push(functionName);
            }
        });

        // Build roster and performance from the aggregated data
        const associates = Object.values(employeeMap);
        if (associates.length === 0) throw new Error("No associates found in Function Rollup data");

        // Clear mock data on first real import
        const hasMockData = DATA.roster.some(r => r.login === "jsmith" || r.login === "mjones");
        if (hasMockData) {
            DATA.roster.length = 0;
            Object.keys(DATA.performance).forEach(k => delete DATA.performance[k]);
        }

        // Only update performance for people already on roster
        // Mark matched associates as clocked in (don't touch others)
        let matchedCount = 0;
        let unmatchedNames = [];

        associates.forEach(a => {
            const nameParts = a.name.replace(/"/g, "").split(",");
            const displayName = nameParts.length >= 2
                ? `${nameParts[1].trim()} ${nameParts[0].trim()}`
                : a.name;

            const uph = a.totalPaidHours > 0
                ? Math.round(a.totalUnits / a.totalPaidHours)
                : 0;

            const loginKey = a.empId;

            // Match to roster: try Employee ID first, then login, then name
            let rosterEntry = DATA.roster.find(r => r.employeeId && r.employeeId === loginKey);
            if (!rosterEntry) {
                rosterEntry = DATA.roster.find(r => r.login === loginKey);
            }
            if (!rosterEntry) {
                const nameLower = displayName.toLowerCase().trim();
                const rawName = a.name.replace(/"/g, "").toLowerCase().trim();
                rosterEntry = DATA.roster.find(r => {
                    const rName = `${r.firstName} ${r.lastName}`.toLowerCase().trim();
                    if (!rName || rName === r.login) return false;
                    return rName === nameLower ||
                           rName === rawName ||
                           nameLower.includes(rName) ||
                           rName.includes(nameLower.split(" ")[0]);
                });
            }

            if (rosterEntry) {
                rosterEntry.firstName = rosterEntry.firstName || displayName.split(" ")[0];
                rosterEntry.lastName = rosterEntry.lastName || displayName.split(" ").slice(1).join(" ");
                // Store Employee ID if not already set
                if (!rosterEntry.employeeId) rosterEntry.employeeId = loginKey;
                matchedCount++;
                // Store performance under roster's login key
                const rosterKey = rosterEntry.login;
                DATA.performance[rosterKey] = {
                    uph: uph,
                    tot: (DATA.performance[rosterKey] || {}).tot || 0,
                    unitsShift: a.totalUnits,
                    unitsWeek: 0,
                    dwellAvg: 0,
                    firstTouch: 0,
                    paidHours: a.totalPaidHours,
                    jobs: a.totalJobs,
                    functions: a.functions,
                    directHours: (DATA.performance[rosterKey] || {}).directHours || 0,
                    totalHours: (DATA.performance[rosterKey] || {}).totalHours || 0,
                };
            }

            // Always store performance data (in case they get added to roster later)
            DATA.performance[loginKey] = {
                uph: uph,
                tot: (DATA.performance[loginKey] || {}).tot || 0,
                unitsShift: a.totalUnits,
                unitsWeek: 0,
                dwellAvg: 0,
                firstTouch: 0,
                paidHours: a.totalPaidHours,
                jobs: a.totalJobs,
                functions: a.functions,
            };

            if (!rosterEntry) {
                unmatchedNames.push(displayName);
            }
        });

        saveToStorage();
        // Save historical snapshot
        if (typeof History !== "undefined") History.saveSnapshot();
        const unmatchedMsg = unmatchedNames.length > 0
            ? ` (${unmatchedNames.length} not on roster — add them manually if needed)`
            : "";
        return `Updated ${matchedCount}/${associates.length} associates on roster${unmatchedMsg}`;
    }

    // Parse Process Inspector report for Time on Task calculation
    function importProcessInspector(text) {
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error("No data rows found");

        // Group by Employee Id, sum direct hours and total hours across all container types
        const employeeMap = {};

        rows.forEach(r => {
            const empId = r.employee_id || r["employee_id"] || "";
            const name = r.employee_name || r["employee_name"] || "";
            if (!empId) return;

            // Handle various normalizations of "Hours (Direct)" and "Hours (Total)"
            const directHours = parseFloat(
                r["hours_(direct)"] || r["hours_direct"] ||
                findColumnByPartial(r, "hours", "direct") || 0
            );
            const totalHours = parseFloat(
                r["hours_(total)"] || r["hours_total"] ||
                findColumnByPartial(r, "hours", "total") || 0
            );

            if (!employeeMap[empId]) {
                employeeMap[empId] = {
                    empId: empId,
                    name: name,
                    manager: r.manager_name || r["manager_name"] || "",
                    directHours: 0,
                    totalHours: 0,
                    totalUnits: 0,
                };
            }

            employeeMap[empId].directHours += directHours;
            employeeMap[empId].totalHours += totalHours;
            employeeMap[empId].totalUnits += parseInt(r.units) || 0;
        });

        // Calculate ToT and merge into existing performance data
        const associates = Object.values(employeeMap);
        if (associates.length === 0) throw new Error("No associates found in Process Inspector data");

        // Clear mock data on first real import
        const hasMockData = DATA.roster.some(r => r.login === "jsmith" || r.login === "mjones");
        if (hasMockData) {
            DATA.roster.length = 0;
            Object.keys(DATA.performance).forEach(k => delete DATA.performance[k]);
        }

        // Update performance for matched associates (don't touch clocked-in status of others)
        let matchedCount = 0;
        associates.forEach(a => {
            const tot = a.totalHours > 0
                ? Math.round((a.directHours / a.totalHours) * 100)
                : 0;

            const nameParts = a.name.replace(/"/g, "").split(",");
            const displayName = nameParts.length >= 2
                ? `${nameParts[1].trim()} ${nameParts[0].trim()}`
                : a.name;

            // Always store/update performance data
            if (DATA.performance[a.empId]) {
                DATA.performance[a.empId].tot = tot;
                DATA.performance[a.empId].directHours = Math.round(a.directHours * 100) / 100;
                DATA.performance[a.empId].totalHours = Math.round(a.totalHours * 100) / 100;
            } else {
                DATA.performance[a.empId] = {
                    uph: a.totalHours > 0 ? Math.round(a.totalUnits / a.totalHours) : 0,
                    tot: tot,
                    unitsShift: a.totalUnits,
                    unitsWeek: 0,
                    dwellAvg: 0,
                    firstTouch: 0,
                    directHours: Math.round(a.directHours * 100) / 100,
                    totalHours: Math.round(a.totalHours * 100) / 100,
                };
            }

            // Match to roster: try Employee ID first, then login, then name
            let rosterEntry = DATA.roster.find(r => r.employeeId && r.employeeId === a.empId);
            if (!rosterEntry) {
                rosterEntry = DATA.roster.find(r => r.login === a.empId);
            }
            if (!rosterEntry) {
                const nameLower = displayName.toLowerCase().trim();
                const rawName = a.name.replace(/"/g, "").toLowerCase().trim();
                rosterEntry = DATA.roster.find(r => {
                    const rName = `${r.firstName} ${r.lastName}`.toLowerCase().trim();
                    if (!rName || rName === r.login) return false;
                    return rName === nameLower ||
                           rName === rawName ||
                           nameLower.includes(rName) ||
                           rName.includes(nameLower.split(" ")[0]);
                });
            }

            if (rosterEntry) {
                // Store Employee ID if not already set
                if (!rosterEntry.employeeId) rosterEntry.employeeId = a.empId;
                // Store performance under the roster's login key
                const loginKey = rosterEntry.login;
                if (!DATA.performance[loginKey]) DATA.performance[loginKey] = {};
                DATA.performance[loginKey].tot = tot;
                DATA.performance[loginKey].directHours = Math.round(a.directHours * 100) / 100;
                DATA.performance[loginKey].totalHours = Math.round(a.totalHours * 100) / 100;
                if (!DATA.performance[loginKey].uph) {
                    DATA.performance[loginKey].uph = a.totalHours > 0 ? Math.round(a.totalUnits / a.totalHours) : 0;
                }
                if (!DATA.performance[loginKey].unitsShift) {
                    DATA.performance[loginKey].unitsShift = a.totalUnits;
                }
                matchedCount++;
            }
        });

        const avgToT = Math.round(associates.reduce((s, a) => s + (a.totalHours > 0 ? (a.directHours / a.totalHours) * 100 : 0), 0) / associates.length);
        saveToStorage();
        // Save historical snapshot
        if (typeof History !== "undefined") History.saveSnapshot();
        return `ToT for ${matchedCount} roster members (avg ${avgToT}%) — ${associates.length} total in report`;
    }

    function importPileCounts(text) {
        // Detect ORF3 Pile Reporting sheet format vs simple format
        const isORF3PileSheet = text.includes("SOS") && (
            text.includes("2 LOW") || text.includes("3 LOW") ||
            text.includes("Floor totals") || text.includes("TOTAL MOD")
        );

        if (isORF3PileSheet) {
            return importORF3PileReport(text);
        }

        // Simple format fallback: time, A02, A03, A04, A05
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error("No data rows found");

        const intraShift = rows.map(r => ({
            time: r.time,
            floors: {
                1: parseInt(r.a02 || r["a02"]) || 0,
                2: parseInt(r.a03 || r["a03"]) || 0,
                3: parseInt(r.a04 || r["a04"]) || 0,
                4: parseInt(r.a05 || r["a05"]) || 0,
            },
        }));

        const first = intraShift[0].floors;
        const last = intraShift[intraShift.length - 1].floors;

        DATA.pileData.intraShift = intraShift;
        DATA.pileData.sos = { ...first };
        DATA.pileData.current = { ...last };
        DATA.pileData.eos = { ...last };

        DATA.floors.forEach(f => {
            f.pileCount = DATA.pileData.current[f.id] || 0;
        });

        saveToStorage();
        // Save historical pile snapshot
        if (typeof History !== "undefined") History.savePileSnapshot();
        return `Imported ${intraShift.length} time-point readings`;
    }

    // Parse ORF3 PS Pile Reporting sheet (FHD/BHD format)
    function importORF3PileReport(text) {
        const lines = text.trim().split(/\r?\n/);

        // Strategy: Find the "Floor totals" row that has A02, A03, A04, A05
        // Then read the floor total values from the subsequent rows
        // Also parse the per-location detail rows for granular data

        let floorTotals = { 1: {}, 2: {}, 3: {}, 4: {} }; // keyed by floor id
        let detailRows = []; // per-location breakdown
        let staffingLogins = [];
        let totalModPS = {};
        let totalModDamages = {};

        // Find the row with floor labels (A02, A03, etc.) and the totals
        for (let i = 0; i < lines.length; i++) {
            const cells = parseCSVLine(lines[i]);
            const joined = cells.join(",").toLowerCase();

            // Look for floor total rows: "A02", "A03", "A04", "A05"
            const floorIdx = cells.findIndex(c => c.trim().toUpperCase() === "A02");
            if (floorIdx >= 0) {
                // This row and next rows have floor totals
                // Format: ..., A02, SoS, P1, P2, EoS
                for (let j = i; j < Math.min(i + 5, lines.length); j++) {
                    const fCells = parseCSVLine(lines[j]);
                    const floorCell = fCells[floorIdx] ? fCells[floorIdx].trim().toUpperCase() : "";
                    if (floorCell === "A02" || floorCell === "A03" || floorCell === "A04" || floorCell === "A05") {
                        const floorId = FLOOR_MAP[floorCell];
                        const sos = parseInt(fCells[floorIdx + 1]) || 0;
                        const p1 = parseInt(fCells[floorIdx + 2]) || 0;
                        const p2 = parseInt(fCells[floorIdx + 3]) || 0;
                        const eos = parseInt(fCells[floorIdx + 4]) || 0;
                        floorTotals[floorId] = { sos, p1, p2, eos };
                    }
                    if (fCells[floorIdx] && fCells[floorIdx].trim().toUpperCase().includes("TOTAL MOD PS")) {
                        const sos = parseInt(fCells[floorIdx + 1]) || 0;
                        const p1 = parseInt(fCells[floorIdx + 2]) || 0;
                        const p2 = parseInt(fCells[floorIdx + 3]) || 0;
                        const eos = parseInt(fCells[floorIdx + 4]) || 0;
                        totalModPS = { sos, p1, p2, eos };
                    }
                }
                break;
            }
        }

        // Parse detail rows (2 LOW, 2 HIGH, etc.) for per-location data
        const locationPattern = /^([2-5])\s+(LOW|HIGH|NORTH)/i;
        for (let i = 0; i < lines.length; i++) {
            const cells = parseCSVLine(lines[i]);
            const firstCell = (cells[0] || "").trim();
            const match = firstCell.match(locationPattern);
            if (match) {
                const floorNum = parseInt(match[1]);
                const floorId = floorNum - 1; // 2=A02=1, 3=A03=2, 4=A04=3, 5=A05=4
                const zone = match[2].toUpperCase();
                // Columns: location, SOS-PS, SOS-Dmg, (blank), P1-PS, P1-Dmg, (blank), P2-PS, P2-Dmg, (blank), EOS-PS, EOS-Dmg
                const sosPS = parseInt(cells[1]) || 0;
                const sosDmg = parseInt(cells[2]) || 0;
                const p1PS = parseInt(cells[4]) || 0;
                const p1Dmg = parseInt(cells[5]) || 0;
                const p2PS = parseInt(cells[7]) || 0;
                const p2Dmg = parseInt(cells[8]) || 0;
                const eosPS = parseInt(cells[10]) || 0;
                const eosDmg = parseInt(cells[11]) || 0;

                detailRows.push({
                    floor: floorId,
                    zone: `${floorNum} ${zone}`,
                    sosPS, sosDmg,
                    p1PS, p1Dmg,
                    p2PS, p2Dmg,
                    eosPS, eosDmg,
                });
            }
        }

        // Parse staffing logins (look for "PS Login" header area)
        for (let i = 0; i < lines.length; i++) {
            const cells = parseCSVLine(lines[i]);
            // Check the row AFTER "PS Login" headers for actual logins
            if (cells.some(c => (c || "").trim().toLowerCase() === "ps login")) {
                // Next rows in those columns have logins
                for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
                    const lCells = parseCSVLine(lines[j]);
                    for (let k = 12; k <= 14; k++) { // PS Login columns are around index 12-14
                        const login = (lCells[k] || "").trim();
                        if (login && login !== "--" && !login.includes("Floor") && !login.includes("TOTAL")) {
                            staffingLogins.push(login);
                        }
                    }
                }
                break;
            }
        }

        // Build intra-shift data from floor totals
        // Determine which periods have data (non-zero)
        const periods = [];
        const hasData = (ft) => ft.sos > 0 || ft.p1 > 0 || ft.p2 > 0 || ft.eos > 0;
        const anyFloorHasData = Object.values(floorTotals).some(hasData);

        if (anyFloorHasData) {
            if (Object.values(floorTotals).some(f => f.sos > 0)) {
                periods.push({ label: "SOS", key: "sos" });
            }
            if (Object.values(floorTotals).some(f => f.p1 > 0)) {
                periods.push({ label: "Period 1", key: "p1" });
            }
            if (Object.values(floorTotals).some(f => f.p2 > 0)) {
                periods.push({ label: "Period 2", key: "p2" });
            }
            if (Object.values(floorTotals).some(f => f.eos > 0)) {
                periods.push({ label: "EOS", key: "eos" });
            }
        }

        if (periods.length === 0) throw new Error("No pile count data found. Make sure the sheet has floor totals (A02-A05) with values.");

        const intraShift = periods.map(p => ({
            time: p.label,
            floors: {
                1: floorTotals[1][p.key] || 0,
                2: floorTotals[2][p.key] || 0,
                3: floorTotals[3][p.key] || 0,
                4: floorTotals[4][p.key] || 0,
            },
        }));

        const first = intraShift[0].floors;
        const last = intraShift[intraShift.length - 1].floors;

        DATA.pileData.intraShift = intraShift;
        DATA.pileData.sos = { ...first };
        DATA.pileData.current = { ...last };
        DATA.pileData.eos = { ...last };

        // Store detail rows for potential drill-down
        DATA.pileData.detailRows = detailRows;

        // Update floor objects
        DATA.floors.forEach(f => {
            f.pileCount = DATA.pileData.current[f.id] || 0;
        });

        // Note staffing logins from the sheet (informational only, doesn't auto-add)
        // Users manage their own roster via Add PS or Roster CSV import

        const totalPile = Object.values(last).reduce((a, b) => a + b, 0);
        saveToStorage();
        // Save historical pile snapshot
        if (typeof History !== "undefined") History.savePileSnapshot();
        return `Imported pile data: ${periods.length} periods, ${detailRows.length} locations, current total: ${totalPile}${staffingLogins.length > 0 ? ` (${staffingLogins.length} PS logins found)` : ""}`;
    }

    function importFlowData(text) {
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error("No data rows found");
        const required = ["hour", "inflow", "outflow"];
        validateColumns(rows[0], required);

        DATA.pileData.flowData = rows.map(r => ({
            hour: r.hour || r.time,
            inflow: parseInt(r.inflow) || 0,
            outflow: parseInt(r.outflow) || 0,
        }));

        saveToStorage();
        return `Imported ${rows.length} hourly flow records`;
    }

    function importReasonCodes(text) {
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error("No data rows found");
        const required = ["reason", "count"];
        validateColumns(rows[0], required);

        const reasons = {};
        rows.forEach(r => {
            reasons[r.reason] = parseInt(r.count) || 0;
        });

        DATA.quality.reasonCodes = reasons;
        saveToStorage();
        return `Imported ${rows.length} reason codes`;
    }

    function importEscalations(text) {
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error("No data rows found");
        const required = ["id", "reason"];
        validateColumns(rows[0], required);

        DATA.quality.escalations = rows.map(r => ({
            id: r.id,
            item: r.item || "",
            reason: r.reason,
            floor: FLOOR_MAP[r.floor?.toUpperCase()] || parseInt(r.floor) || 1,
            status: (r.status || "open").toLowerCase(),
            age: r.age || "—",
        }));

        DATA.quality.escalationCount = DATA.quality.escalations.filter(e => e.status !== "resolved").length;
        saveToStorage();
        return `Imported ${rows.length} escalations`;
    }

    // --- Helpers ---

    function validateColumns(row, required) {
        const keys = Object.keys(row);
        const missing = required.filter(r => !keys.includes(r));
        if (missing.length > 0) {
            throw new Error(`Missing required columns: ${missing.join(", ")}`);
        }
    }

    function capitalize(str) {
        if (!str) return "";
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    }

    // --- Persistence (uses Storage adapter for server/localStorage) ---

    function saveToStorage() {
        const snapshot = {
            roster: DATA.roster,
            performance: DATA.performance,
            pileData: DATA.pileData,
            floors: DATA.floors,
            quality: DATA.quality,
            targetHC: DATA.targetHC,
            damagelandRoster: DATA.damagelandRoster,
            damagelandTargetHC: DATA.damagelandTargetHC,
            timestamp: new Date().toISOString(),
        };
        // Fire-and-forget async save (also saves to localStorage as backup)
        Storage.saveData(snapshot);
    }

    async function loadFromStorage() {
        const snapshot = await Storage.loadData();
        if (!snapshot) return false;

        if (snapshot.roster) {
            DATA.roster.length = 0;
            snapshot.roster.forEach(r => {
                // Migrate old format (name/status/shift) to new format (firstName/lastName/clockedIn)
                if (r.firstName === undefined && r.name) {
                    const parts = (r.name || "").split(" ");
                    r.firstName = parts[0] || "";
                    r.lastName = parts.slice(1).join(" ") || "";
                    r.employeeId = r.employeeId || r.badgeId || "";
                    r.clockedIn = r.status === "active" || r.clockedIn || false;
                    delete r.name;
                    delete r.status;
                    delete r.shift;
                    delete r.badgeId;
                }
                DATA.roster.push(r);
            });
        }
        if (snapshot.performance) {
            Object.keys(DATA.performance).forEach(k => delete DATA.performance[k]);
            Object.assign(DATA.performance, snapshot.performance);
        }
        if (snapshot.pileData) {
            Object.assign(DATA.pileData, snapshot.pileData);
        }
        if (snapshot.floors) {
            snapshot.floors.forEach((f, i) => {
                if (DATA.floors[i]) Object.assign(DATA.floors[i], f);
            });
        }
        if (snapshot.quality) {
            Object.assign(DATA.quality, snapshot.quality);
        }
        if (snapshot.targetHC) {
            Object.assign(DATA.targetHC, snapshot.targetHC);
        }
        if (snapshot.damagelandRoster) {
            DATA.damagelandRoster.length = 0;
            snapshot.damagelandRoster.forEach(r => DATA.damagelandRoster.push(r));
        }
        if (snapshot.damagelandTargetHC) {
            Object.assign(DATA.damagelandTargetHC, snapshot.damagelandTargetHC);
        }
        return true;
    }

    function clearStorage() {
        Storage.clearAll();
    }

    // --- CSV Template Generator ---

    function downloadTemplates() {
        const templates = {
            "roster_template.csv": "login,name,floor,shift,status\njsmith,John Smith,A02,Day,active\nmjones,Maria Jones,A03,Night,active\n",
            "performance_template.csv": "login,uph,tot,units_shift,units_week,first_touch\njsmith,42,88,336,1680,91\nmjones,38,82,304,1520,87\n",
            "pile_counts_template.csv": "time,A02,A03,A04,A05\n06:00,145,198,167,122\n08:00,152,205,174,130\n10:00,148,195,168,125\n",
            "inflow_outflow_template.csv": "hour,inflow,outflow\n06:00,45,32\n07:00,52,41\n08:00,48,50\n",
            "reason_codes_template.csv": "reason,count\nDamaged,142\nOverage,98\nMislabel,76\nMissing Item,115\n",
            "escalations_template.csv": "id,item,reason,floor,status,age\nESC-001,ASIN B07XYZ123,Hazmat - requires safety team,A02,open,4h\nESC-002,ASIN B09ABC456,High-value item - manager override,A03,pending,2h\n",
        };

        // Create a zip-like download of all templates as individual files
        Object.entries(templates).forEach(([filename, content]) => {
            const blob = new Blob([content], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    // --- Wire Up UI ---

    function setupImportUI() {
        const handlers = {
            "csv-performance": importPerformance,
            "csv-tot": importProcessInspector,
            "csv-piles": importPileCounts,
        };

        const statusMap = {
            "csv-performance": "status-performance",
            "csv-tot": "status-tot",
            "csv-piles": "status-piles",
        };

        Object.entries(handlers).forEach(([inputId, handler]) => {
            const input = document.getElementById(inputId);
            if (!input) return;
            input.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const statusEl = document.getElementById(statusMap[inputId]);
                const reader = new FileReader();
                reader.onload = (evt) => {
                    try {
                        const msg = handler(evt.target.result);
                        statusEl.textContent = msg;
                        statusEl.className = "import-status success";
                        // Re-render dashboard
                        if (typeof window.renderAll === "function") window.renderAll();
                    } catch (err) {
                        statusEl.textContent = "Error: " + err.message;
                        statusEl.className = "import-status error";
                    }
                };
                reader.readAsText(file);
            });
        });

        const clearBtn = document.getElementById("btn-clear-data");
        if (clearBtn) {
            clearBtn.addEventListener("click", () => {
                if (confirm("Clear all imported data and revert to defaults? This will reload the page.")) {
                    clearStorage();
                    location.reload();
                }
            });
        }

        const templateBtn = document.getElementById("btn-download-templates");
        if (templateBtn) {
            templateBtn.addEventListener("click", downloadTemplates);
        }

        // Manual Add Problem Solver button
        const addBtn = document.getElementById("btn-add-ps");
        if (addBtn) {
            addBtn.addEventListener("click", () => {
                const firstName = (document.getElementById("add-firstname").value || "").trim();
                const lastName = (document.getElementById("add-lastname").value || "").trim();
                const login = (document.getElementById("add-login").value || "").trim();
                const badgeId = (document.getElementById("add-badge").value || "").trim();
                const floor = parseInt(document.getElementById("add-floor").value) || 1;
                const statusEl = document.getElementById("status-add-ps");

                if (!login) {
                    statusEl.textContent = "Login (alias) is required";
                    statusEl.className = "import-status error";
                    return;
                }

                if (!firstName && !lastName) {
                    statusEl.textContent = "At least a first or last name is required";
                    statusEl.className = "import-status error";
                    return;
                }

                // Check if already on roster
                const existing = DATA.roster.find(r => r.login === login);
                if (existing) {
                    statusEl.textContent = `${login} is already on the roster`;
                    statusEl.className = "import-status error";
                    return;
                }

                DATA.roster.push({
                    firstName: firstName,
                    lastName: lastName,
                    login: login,
                    employeeId: badgeId,
                    floor: floor,
                    clockedIn: true,
                });

                if (!DATA.performance[login]) {
                    DATA.performance[login] = { uph: 0, tot: 0, unitsShift: 0, unitsWeek: 0, dwellAvg: 0, firstTouch: 0 };
                }

                saveToStorage();
                statusEl.textContent = `Added ${firstName} ${lastName} (${login}) to ${FLOOR_REVERSE[floor]}`;
                statusEl.className = "import-status success";

                // Clear inputs
                document.getElementById("add-firstname").value = "";
                document.getElementById("add-lastname").value = "";
                document.getElementById("add-login").value = "";
                document.getElementById("add-badge").value = "";

                // Re-render
                if (typeof window.renderAll === "function") window.renderAll();
            });
        }

        // Manual Add Damageland Associate button
        const addDLBtn = document.getElementById("btn-add-dl");
        if (addDLBtn) {
            addDLBtn.addEventListener("click", () => {
                const firstName = (document.getElementById("dl-add-firstname").value || "").trim();
                const lastName = (document.getElementById("dl-add-lastname").value || "").trim();
                const login = (document.getElementById("dl-add-login").value || "").trim();
                const role = document.getElementById("dl-add-role").value || "ps";
                const statusEl = document.getElementById("status-add-dl");

                if (!login) {
                    statusEl.textContent = "Login (alias) is required";
                    statusEl.className = "import-status error";
                    return;
                }

                if (!firstName && !lastName) {
                    statusEl.textContent = "At least a first or last name is required";
                    statusEl.className = "import-status error";
                    return;
                }

                const existing = DATA.damagelandRoster.find(r => r.login === login);
                if (existing) {
                    statusEl.textContent = `${login} is already on the Damageland roster`;
                    statusEl.className = "import-status error";
                    return;
                }

                DATA.damagelandRoster.push({
                    firstName: firstName,
                    lastName: lastName,
                    login: login,
                    role: role,
                    clockedIn: false,
                });

                if (!DATA.performance[login]) {
                    DATA.performance[login] = { uph: 0, tot: 0, unitsShift: 0, unitsWeek: 0, dwellAvg: 0, firstTouch: 0 };
                }

                saveToStorage();
                statusEl.textContent = `Added ${firstName} ${lastName} (${login}) to Damageland`;
                statusEl.className = "import-status success";

                document.getElementById("dl-add-firstname").value = "";
                document.getElementById("dl-add-lastname").value = "";
                document.getElementById("dl-add-login").value = "";

                if (typeof window.renderAll === "function") window.renderAll();
            });
        }
    }

    // --- Public API ---
    return {
        setupImportUI,
        loadFromStorage,
        clearStorage,
        saveToStorage,
    };
})();
