// ============================================================
// IB Problem Solve Dashboard - Application Logic
// ============================================================

(function () {
    "use strict";

    let currentFloor = "all";
    let charts = {};

    const FLOOR_LABELS = { 1: "A02", 2: "A03", 3: "A04", 4: "A05" };
    function floorLabel(id) { return FLOOR_LABELS[id] || `Floor ${id}`; }

    // --- Initialize ---
    async function init() {
        // Detect server availability (shared vs local mode)
        await Storage.checkServer();
        // Load shared/local data
        await CSVImport.loadFromStorage();
        // Load history cache from server
        await History.initialize();
        setupTabs();
        setupFilters();
        setupTrends();
        CSVImport.setupImportUI();
        renderAll();
        startAutoRefresh();
        updateRefreshTime();
        updateModeIndicator();
    }

    function updateModeIndicator() {
        const el = document.getElementById("last-refresh");
        const mode = Storage.isServerMode() ? "Shared" : "Local";
        const modeColor = Storage.isServerMode() ? "#4caf50" : "#ffa726";
        el.innerHTML = `<span style="color:${modeColor};font-weight:600">[${mode}]</span> Last refresh: ${new Date().toLocaleTimeString()}`;
    }

    // --- Tab Navigation ---
    function setupTabs() {
        const btns = document.querySelectorAll(".tab-btn");
        btns.forEach(btn => {
            btn.addEventListener("click", () => {
                btns.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
                document.getElementById(btn.dataset.tab).classList.add("active");
            });
        });
    }

    // --- Filters ---
    function setupFilters() {
        document.getElementById("floor-filter").addEventListener("change", (e) => {
            currentFloor = e.target.value;
            renderAll();
        });
        document.getElementById("roster-search").addEventListener("input", renderRosterTable);
        document.getElementById("roster-sort").addEventListener("change", renderRosterTable);
    }

    // --- Render All Sections ---
    function renderAll() {
        renderKPIs();
        renderFloorGrid();
        renderPileTracking();
        renderRoster();
        renderDamageland();
        renderStaffingUpdate();
        renderShiftReport();
        renderTrends();
    }

    function updateRefreshTime() {
        updateModeIndicator();
    }

    // --- KPI Banner ---
    function renderKPIs() {
        const kpis = DATA.computeKPIs("all", currentFloor);
        const banner = document.getElementById("kpi-banner");

        const rateClass = kpis.avgUPH >= kpis.rateTarget ? "success" : "warning";

        // Calculate overall UIT from all roster members with totalHours data
        const uitAssociates = DATA.roster.filter(r => {
            const p = DATA.performance[r.login];
            return p && p.totalHours && p.totalHours > 0;
        });
        let overallUIT = 0;
        if (uitAssociates.length > 0) {
            const totalInferred = uitAssociates.reduce((s, r) => {
                const p = DATA.performance[r.login];
                return s + (p.totalHours - (p.directHours || 0));
            }, 0);
            const totalHours = uitAssociates.reduce((s, r) => s + DATA.performance[r.login].totalHours, 0);
            overallUIT = totalHours > 0 ? Math.round((totalInferred / totalHours) * 1000) / 10 : 0;
        }
        const uitClass = overallUIT > 35 ? "danger" : overallUIT > 25 ? "warning" : "success";

        banner.innerHTML = `
            <div class="kpi-card">
                <div class="kpi-value">${kpis.totalPile}</div>
                <div class="kpi-label">Total Open Pile</div>
                <div class="kpi-sub">Across all floors</div>
            </div>
            <div class="kpi-card ${rateClass}">
                <div class="kpi-value">${kpis.avgUPH}</div>
                <div class="kpi-label">Avg UPH</div>
                <div class="kpi-sub">Target: ${kpis.rateTarget}</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">${kpis.avgToT}%</div>
                <div class="kpi-label">Avg Time on Task</div>
                <div class="kpi-sub">Target: ${DATA.kpiTargets.totTarget}%</div>
            </div>
            <div class="kpi-card ${uitClass}">
                <div class="kpi-value">${overallUIT}%</div>
                <div class="kpi-label">Overall UIT</div>
                <div class="kpi-sub">${uitAssociates.length} associates</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">${kpis.totalUnits}</div>
                <div class="kpi-label">Total Units Resolved</div>
                <div class="kpi-sub">This shift</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">${kpis.clockedInCount}/${kpis.plannedHeadcount}</div>
                <div class="kpi-label">Clocked In / Planned</div>
                <div class="kpi-sub">This shift/floor</div>
            </div>
            <div class="kpi-card success">
                <div class="kpi-value">${kpis.topPerformer ? kpis.topPerformer.login : '--'}</div>
                <div class="kpi-label">Top Performer</div>
                <div class="kpi-sub">${kpis.topPerformer ? DATA.performance[kpis.topPerformer.login].uph + ' UPH' : ''}</div>
            </div>
            <div class="kpi-card danger">
                <div class="kpi-value">${floorLabel(kpis.highestPileFloor.floor)}</div>
                <div class="kpi-label">Highest Pile</div>
                <div class="kpi-sub">${kpis.highestPileFloor.count} items</div>
            </div>
        `;
    }

    // --- Floor Grid ---
    function renderFloorGrid() {
        const grid = document.getElementById("floor-grid");
        const floorsToShow = currentFloor === "all"
            ? DATA.floors
            : DATA.floors.filter(f => f.id === parseInt(currentFloor));

        grid.innerHTML = floorsToShow.map(floor => {
            const associates = DATA.roster.filter(r => {
                if (r.floor !== floor.id) return false;
                return true;
            });
            const activeAssociates = associates.filter(a => a.clockedIn);
            const targetHC = DATA.targetHC[floor.id] || 3;
            const staffRatio = activeAssociates.length > 0
                ? Math.round(floor.pileCount / activeAssociates.length)
                : 999;
            const staffPct = Math.min(100, Math.round((activeAssociates.length / targetHC) * 100));
            const staffColor = staffPct >= 90 ? "var(--success)" : staffPct >= 70 ? "var(--warning)" : "var(--danger)";

            const sosVal = DATA.pileData.sos[floor.id];
            const currentVal = DATA.pileData.current[floor.id];
            const delta = currentVal - sosVal;
            const trendLabel = delta < 0 ? "down" : delta > 0 ? "up" : "flat";
            const trendText = delta < 0 ? `&#9660; ${Math.abs(delta)}` : delta > 0 ? `&#9650; ${delta}` : "&#9644; 0";

            return `
                <div class="floor-card">
                    <div class="floor-card-header">
                        <h3>${floor.name}</h3>
                        <span class="trend-badge ${trendLabel}">${trendText} from SOS</span>
                    </div>
                    <div class="floor-metrics">
                        <div class="floor-metric">
                            <div class="metric-value">${currentVal}</div>
                            <div class="metric-label">Current Pile</div>
                        </div>
                        <div class="floor-metric">
                            <div class="metric-value">${floor.throughput}</div>
                            <div class="metric-label">Throughput/hr</div>
                        </div>
                        <div class="floor-metric">
                            <div class="metric-value">${staffRatio}:1</div>
                            <div class="metric-label">Items/PS</div>
                        </div>
                    </div>
                    <div class="floor-associates">
                        <h4>Problem Solvers (${activeAssociates.length} active / ${targetHC} target)</h4>
                        <div class="associate-chips">
                            ${activeAssociates.map(a => `<span class="associate-chip">${a.login}</span>`).join("") || '<span style="color:var(--text-secondary)">No one clocked in</span>'}
                        </div>
                    </div>
                    <div class="staffing-bar">
                        <div class="staffing-bar-fill" style="width:${staffPct}%;background:${staffColor}"></div>
                    </div>
                    <div class="staffing-label">Staffing: ${activeAssociates.length}/${targetHC} (${staffPct}%)</div>
                </div>
            `;
        }).join("");
    }

    // --- Pile Tracking ---
    function renderPileTracking() {
        renderPileSummaryCards();
        renderPileCountsTable();
        renderAgingBuckets();
        renderPileTrendChart();
    }

    function renderPileSummaryCards() {
        const container = document.getElementById("pile-summary-cards");
        const pd = DATA.pileData;
        const totalSOS = Object.values(pd.sos).reduce((a, b) => a + b, 0);
        const totalCurrent = Object.values(pd.current).reduce((a, b) => a + b, 0);
        const totalEOS = Object.values(pd.eos).reduce((a, b) => a + b, 0);
        const delta = totalCurrent - totalSOS;
        const deltaClass = delta <= 0 ? "negative" : "positive";
        const deltaSign = delta <= 0 ? "" : "+";

        container.innerHTML = `
            <div class="pile-card">
                <div class="pile-value">${totalSOS}</div>
                <div class="pile-label">SOS Count</div>
            </div>
            <div class="pile-card">
                <div class="pile-value">${totalCurrent}</div>
                <div class="pile-label">Current Count</div>
                <div class="pile-delta ${deltaClass}">${deltaSign}${delta} from SOS</div>
            </div>
            <div class="pile-card">
                <div class="pile-value">${totalEOS}</div>
                <div class="pile-label">Projected EOS</div>
            </div>
            <div class="pile-card">
                <div class="pile-value">${totalSOS - totalEOS}</div>
                <div class="pile-label">Net Reduction</div>
                <div class="pile-delta negative">-${totalSOS - totalEOS} items</div>
            </div>
        `;
    }

    function renderPileCountsTable() {
        const tbody = document.getElementById("pile-counts-body");
        tbody.innerHTML = DATA.pileData.intraShift.map(row => {
            const total = Object.values(row.floors).reduce((a, b) => a + b, 0);
            return `<tr>
                <td><strong>${row.time}</strong></td>
                <td>${row.floors[1]}</td>
                <td>${row.floors[2]}</td>
                <td>${row.floors[3]}</td>
                <td>${row.floors[4]}</td>
                <td><strong>${total}</strong></td>
            </tr>`;
        }).join("");
    }

    function renderAgingBuckets() {
        const container = document.getElementById("aging-buckets");
        const aging = DATA.pileData.aging;
        const total = Object.values(aging).reduce((a, b) => a + b, 0);
        const entries = Object.entries(aging);

        container.innerHTML = `
            <h3>Pile Aging Buckets</h3>
            ${entries.map(([label, count], i) => {
                const pct = Math.round((count / total) * 100);
                return `<div class="aging-bucket-row">
                    <span class="aging-bucket-label">${label}</span>
                    <div class="aging-bucket-bar">
                        <div class="aging-bucket-fill bucket-${i}" style="width:${pct}%">${count} (${pct}%)</div>
                    </div>
                </div>`;
            }).join("")}
        `;
    }

    function renderPileTrendChart() {
        const ctx = document.getElementById("pile-trend-chart");
        if (charts.pileTrend) charts.pileTrend.destroy();

        const labels = DATA.pileData.intraShift.map(r => r.time);
        const floors = [1, 2, 3, 4];
        const colors = ["#1a237e", "#ff6f00", "#2e7d32", "#7b1fa2"];

        charts.pileTrend = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: floors.map((f, i) => ({
                    label: `${floorLabel(f)}`,
                    data: DATA.pileData.intraShift.map(r => r.floors[f]),
                    borderColor: colors[i],
                    backgroundColor: colors[i] + "22",
                    tension: 0.3,
                    fill: false,
                    pointRadius: 3,
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } },
                scales: {
                    y: { beginAtZero: false, title: { display: true, text: "Items" } },
                },
            },
        });
    }



    // --- Roster & Performance ---
    function renderRoster() {
        renderRosterStats();
        renderRosterTable();
        renderUPHChart();
        renderToTChart();
        renderUITReport();
    }

    function renderRosterStats() {
        const container = document.getElementById("roster-stats");
        const allRoster = getFilteredRoster();
        const clockedIn = allRoster.filter(r => r.clockedIn);
        const perfs = clockedIn.map(r => DATA.performance[r.login]).filter(p => p && p.uph > 0);
        const totalUnits = perfs.reduce((a, p) => a + p.unitsShift, 0);

        container.innerHTML = `
            <div class="roster-stat-card">
                <div class="stat-value">${allRoster.length}</div>
                <div class="stat-label">Total Roster</div>
            </div>
            <div class="roster-stat-card">
                <div class="stat-value">${clockedIn.length}</div>
                <div class="stat-label">Clocked In</div>
            </div>
            <div class="roster-stat-card">
                <div class="stat-value">${allRoster.length - clockedIn.length}</div>
                <div class="stat-label">Not Clocked In</div>
            </div>
            <div class="roster-stat-card">
                <div class="stat-value">${totalUnits}</div>
                <div class="stat-label">Units This Shift</div>
            </div>
        `;
    }

    function getFilteredRoster() {
        return DATA.roster.filter(r => {
            if (currentFloor !== "all" && r.floor !== parseInt(currentFloor)) return false;
            return true;
        });
    }

    function renderRosterTable() {
        const tbody = document.getElementById("roster-body");
        const searchTerm = (document.getElementById("roster-search").value || "").toLowerCase();
        const sortMode = document.getElementById("roster-sort").value;
        let roster = getFilteredRoster();

        if (searchTerm) {
            roster = roster.filter(r =>
                (r.firstName + " " + r.lastName).toLowerCase().includes(searchTerm) ||
                r.login.toLowerCase().includes(searchTerm) ||
                (r.badgeId || "").toLowerCase().includes(searchTerm)
            );
        }

        // Apply sorting
        roster = [...roster].sort((a, b) => {
            if (sortMode === "alpha") {
                return (a.lastName || "").localeCompare(b.lastName || "") || (a.firstName || "").localeCompare(b.firstName || "");
            } else if (sortMode === "floor") {
                return (a.floor || 0) - (b.floor || 0);
            } else if (sortMode === "clockedIn") {
                return (b.clockedIn ? 1 : 0) - (a.clockedIn ? 1 : 0);
            } else if (sortMode === "clockedOut") {
                return (a.clockedIn ? 1 : 0) - (b.clockedIn ? 1 : 0);
            }
            return 0;
        });

        tbody.innerHTML = roster.map((r, idx) => {
            const p = DATA.performance[r.login] || {};
            const floorOptions = [1,2,3,4].map(f =>
                `<option value="${f}" ${r.floor === f ? 'selected' : ''}>${floorLabel(f)}</option>`
            ).join("");
            const sideOptions = ["N","S"].map(s =>
                `<option value="${s}" ${r.side === s ? 'selected' : ''}>${s}</option>`
            ).join("");

            return `<tr>
                <td><input type="text" class="cell-edit" value="${r.firstName}" onchange="window.updateRosterField('${r.login}','firstName',this.value)"></td>
                <td><input type="text" class="cell-edit" value="${r.lastName}" onchange="window.updateRosterField('${r.login}','lastName',this.value)"></td>
                <td><strong>${r.login}</strong></td>
                <td><input type="text" class="cell-edit cell-edit-id" value="${r.employeeId || ''}" onchange="window.updateRosterField('${r.login}','employeeId',this.value)" placeholder="—"></td>
                <td>
                    <select class="floor-select-inline" onchange="window.changeFloor('${r.login}', this.value)">
                        ${floorOptions}
                    </select>
                </td>
                <td>
                    <select class="side-select-inline" onchange="window.changeSide('${r.login}', this.value)">
                        ${sideOptions}
                    </select>
                </td>
                <td>
                    <label class="toggle-switch">
                        <input type="checkbox" ${r.clockedIn ? 'checked' : ''} onchange="window.toggleClockedIn('${r.login}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </td>
                <td>${p.uph || '—'}</td>
                <td>${p.tot ? p.tot + '%' : '—'}</td>
                <td>${p.unitsShift || '—'}</td>
                <td class="roster-actions">
                    <button class="btn-icon btn-remove" onclick="window.removePS('${r.login}')" title="Remove">&#10005;</button>
                </td>
            </tr>`;
        }).join("");
    }

    function renderUPHChart() {
        const ctx = document.getElementById("uph-chart");
        if (charts.uph) charts.uph.destroy();

        const roster = getFilteredRoster().filter(r => r.clockedIn && DATA.performance[r.login] && DATA.performance[r.login].uph > 0);
        const sorted = [...roster].sort((a, b) => DATA.performance[b.login].uph - DATA.performance[a.login].uph);

        charts.uph = new Chart(ctx, {
            type: "bar",
            data: {
                labels: sorted.map(r => r.login),
                datasets: [{
                    label: "UPH",
                    data: sorted.map(r => DATA.performance[r.login].uph),
                    backgroundColor: sorted.map(r =>
                        DATA.performance[r.login].uph >= DATA.kpiTargets.rateTarget ? "#66bb6a" : "#ef5350"
                    ),
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                plugins: {
                    legend: { display: false },
                    annotation: {
                        annotations: {
                            target: { type: "line", xMin: DATA.kpiTargets.rateTarget, xMax: DATA.kpiTargets.rateTarget, borderColor: "#1a237e", borderDash: [5, 5], borderWidth: 2 }
                        }
                    }
                },
                scales: { x: { beginAtZero: true, title: { display: true, text: "Units Per Hour" } } },
            },
        });
    }

    function renderToTChart() {
        const ctx = document.getElementById("tot-chart");
        if (charts.tot) charts.tot.destroy();

        const roster = getFilteredRoster().filter(r => r.clockedIn && DATA.performance[r.login] && DATA.performance[r.login].tot > 0);
        const sorted = [...roster].sort((a, b) => DATA.performance[b.login].tot - DATA.performance[a.login].tot);

        charts.tot = new Chart(ctx, {
            type: "bar",
            data: {
                labels: sorted.map(r => r.login),
                datasets: [{
                    label: "ToT %",
                    data: sorted.map(r => DATA.performance[r.login].tot),
                    backgroundColor: sorted.map(r =>
                        DATA.performance[r.login].tot >= DATA.kpiTargets.totTarget ? "#42a5f5" : "#ffa726"
                    ),
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                plugins: { legend: { display: false } },
                scales: { x: { beginAtZero: true, max: 100, title: { display: true, text: "% Time on Task" } } },
            },
        });
    }

    // --- UIT Report ---
    function renderUITReport() {
        const overallEl = document.getElementById("uit-overall");
        const rankingEl = document.getElementById("uit-floor-ranking");
        const detailsEl = document.getElementById("uit-floor-details");

        // Get clocked-in roster with performance data that has totalHours
        const roster = getFilteredRoster().filter(r => {
            if (!r.clockedIn) return false;
            const p = DATA.performance[r.login];
            return p && p.totalHours && p.totalHours > 0;
        });

        if (roster.length === 0) {
            overallEl.innerHTML = '<span style="color:var(--text-secondary)">Upload Process Inspector data to generate UIT report</span>';
            rankingEl.innerHTML = "";
            detailsEl.innerHTML = "";
            return;
        }

        // Calculate UIT per associate: UIT% = (totalHours - directHours) / totalHours * 100
        // which is equivalent to: inferredHours / totalHours * 100
        const associatesWithUIT = roster.map(r => {
            const p = DATA.performance[r.login];
            const directHrs = p.directHours || 0;
            const totalHrs = p.totalHours || 0;
            const inferredHrs = totalHrs - directHrs;
            const uitPct = totalHrs > 0 ? (inferredHrs / totalHrs) * 100 : 0;
            return {
                login: r.login,
                name: `${r.firstName} ${r.lastName}`,
                floor: r.floor,
                inferredHrs: Math.round(inferredHrs * 100) / 100,
                totalHrs: Math.round(totalHrs * 100) / 100,
                uitPct: Math.round(uitPct * 10) / 10,
            };
        });

        // Overall UIT
        const totalInferred = associatesWithUIT.reduce((s, a) => s + a.inferredHrs, 0);
        const totalHours = associatesWithUIT.reduce((s, a) => s + a.totalHrs, 0);
        const overallUIT = totalHours > 0 ? Math.round((totalInferred / totalHours) * 1000) / 10 : 0;

        const uitClass = overallUIT > 35 ? "uit-high" : overallUIT > 25 ? "uit-medium" : "uit-low";
        overallEl.innerHTML = `Overall UIT: <span class="${uitClass}">${overallUIT}%</span> | UIT% = Hrs Inferred &divide; Hrs Total`;

        // Group by floor
        const floorGroups = {};
        associatesWithUIT.forEach(a => {
            if (!floorGroups[a.floor]) floorGroups[a.floor] = [];
            floorGroups[a.floor].push(a);
        });

        // Calculate floor-level UIT and rank
        const floorStats = Object.entries(floorGroups).map(([floorId, associates]) => {
            const floorInferred = associates.reduce((s, a) => s + a.inferredHrs, 0);
            const floorTotal = associates.reduce((s, a) => s + a.totalHrs, 0);
            const floorUIT = floorTotal > 0 ? Math.round((floorInferred / floorTotal) * 1000) / 10 : 0;
            return {
                floorId: parseInt(floorId),
                floorLabel: floorLabel(parseInt(floorId)),
                headcount: associates.length,
                uitPct: floorUIT,
                associates: associates.sort((a, b) => b.uitPct - a.uitPct),
            };
        }).sort((a, b) => b.uitPct - a.uitPct);

        // Floor Ranking Table
        rankingEl.innerHTML = `
            <h4 style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px;">Floor Ranking</h4>
            <table class="uit-ranking-table">
                <thead><tr><th>Rank</th><th>Floor</th><th>Headcount</th><th>Floor UIT %</th></tr></thead>
                <tbody>
                    ${floorStats.map((f, i) => {
                        const cls = f.uitPct > 35 ? "uit-high" : f.uitPct > 25 ? "uit-medium" : "uit-low";
                        return `<tr>
                            <td>${i + 1}</td>
                            <td>${f.floorLabel}</td>
                            <td>${f.headcount}</td>
                            <td class="${cls}">${f.uitPct}%</td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
        `;

        // Per-floor detail sections
        detailsEl.innerHTML = floorStats.map(f => `
            <div class="uit-floor-section">
                <div class="uit-floor-section-header">
                    ${f.floorLabel} &mdash; ${f.uitPct}% UIT (${f.headcount} associate${f.headcount !== 1 ? 's' : ''})
                </div>
                <table class="uit-floor-table">
                    <thead><tr><th>Associate</th><th>Login</th><th>Hrs Inferred</th><th>Hrs Total</th><th>UIT %</th></tr></thead>
                    <tbody>
                        ${f.associates.map(a => {
                            const cls = a.uitPct > 35 ? "uit-high" : a.uitPct > 25 ? "uit-medium" : "uit-low";
                            return `<tr>
                                <td>${a.name}</td>
                                <td>${a.login}</td>
                                <td>${a.inferredHrs.toFixed(2)}</td>
                                <td>${a.totalHrs.toFixed(2)}</td>
                                <td class="${cls}">${a.uitPct}%</td>
                            </tr>`;
                        }).join("")}
                    </tbody>
                </table>
            </div>
        `).join("");
    }

    // --- Damageland ---
    function renderDamageland() {
        renderDamagelandStats();
        renderDamagelandTable();
        loadDamagelandTargets();
    }

    function loadDamagelandTargets() {
        const dlPSInput = document.getElementById("dl-target-dlPS");
        const psInput = document.getElementById("dl-target-ps");
        if (dlPSInput) dlPSInput.value = DATA.damagelandTargetHC.dlPS || 1;
        if (psInput) psInput.value = DATA.damagelandTargetHC.ps || 10;
    }

    function renderDamagelandStats() {
        const container = document.getElementById("damageland-stats");
        if (!container) return;
        const roster = DATA.damagelandRoster;
        const clockedIn = roster.filter(r => r.clockedIn);
        const psCount = clockedIn.filter(r => r.role === "ps").length;
        const dlPSCount = clockedIn.filter(r => r.role === "dlPS").length;

        container.innerHTML = `
            <div class="roster-stat-card">
                <div class="stat-value">${roster.length}</div>
                <div class="stat-label">Total Roster</div>
            </div>
            <div class="roster-stat-card">
                <div class="stat-value">${clockedIn.length}</div>
                <div class="stat-label">Clocked In</div>
            </div>
            <div class="roster-stat-card">
                <div class="stat-value">${psCount}</div>
                <div class="stat-label">PS Active</div>
            </div>
            <div class="roster-stat-card">
                <div class="stat-value">${dlPSCount}</div>
                <div class="stat-label">DL PS Active</div>
            </div>
        `;
    }

    function renderDamagelandTable() {
        const tbody = document.getElementById("damageland-body");
        if (!tbody) return;

        tbody.innerHTML = DATA.damagelandRoster.map(r => {
            const p = DATA.performance[r.login] || {};
            const roleOptions = ["ps", "dlPS"].map(role =>
                `<option value="${role}" ${r.role === role ? 'selected' : ''}>${role === "ps" ? "Problem Solve" : "DL Problem Solve"}</option>`
            ).join("");

            return `<tr>
                <td><input type="text" class="cell-edit" value="${r.firstName}" onchange="window.updateDLField('${r.login}','firstName',this.value)"></td>
                <td><input type="text" class="cell-edit" value="${r.lastName}" onchange="window.updateDLField('${r.login}','lastName',this.value)"></td>
                <td><strong>${r.login}</strong></td>
                <td>
                    <select class="floor-select-inline" onchange="window.changeDLRole('${r.login}', this.value)">
                        ${roleOptions}
                    </select>
                </td>
                <td>
                    <label class="toggle-switch">
                        <input type="checkbox" ${r.clockedIn ? 'checked' : ''} onchange="window.toggleDLClockedIn('${r.login}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </td>
                <td>${p.uph || '—'}</td>
                <td>${p.tot ? p.tot + '%' : '—'}</td>
                <td class="roster-actions">
                    <button class="btn-icon btn-remove" onclick="window.removeDL('${r.login}')" title="Remove">&#10005;</button>
                </td>
            </tr>`;
        }).join("");
    }

    // Damageland window functions
    window.updateDLField = function(login, field, value) {
        const entry = DATA.damagelandRoster.find(r => r.login === login);
        if (entry) {
            entry[field] = value.trim();
            CSVImport.saveToStorage();
        }
    };

    window.changeDLRole = function(login, role) {
        const entry = DATA.damagelandRoster.find(r => r.login === login);
        if (entry) {
            entry.role = role;
            CSVImport.saveToStorage();
            renderDamagelandStats();
        }
    };

    window.toggleDLClockedIn = function(login, checked) {
        const entry = DATA.damagelandRoster.find(r => r.login === login);
        if (entry) {
            entry.clockedIn = checked;
            CSVImport.saveToStorage();
            renderDamagelandStats();
        }
    };

    window.removeDL = function(login) {
        const entry = DATA.damagelandRoster.find(r => r.login === login);
        const name = entry ? `${entry.firstName} ${entry.lastName}` : login;
        if (confirm(`Remove ${name} from Damageland?`)) {
            const idx = DATA.damagelandRoster.findIndex(r => r.login === login);
            if (idx >= 0) DATA.damagelandRoster.splice(idx, 1);
            CSVImport.saveToStorage();
            renderDamageland();
        }
    };

    window.updateDLTargetHC = function(role, value) {
        DATA.damagelandTargetHC[role] = parseInt(value) || 0;
        CSVImport.saveToStorage();
    };

    // --- Staffing Update ---
    function renderStaffingUpdate() {
        const wrapper = document.getElementById("staffing-table-wrapper");
        if (!wrapper) return;

        const floors = [1, 2, 3, 4];
        const sides = ["N", "S"];

        // Build rows: each floor has North and South
        let rows = [];
        floors.forEach(floorId => {
            sides.forEach(side => {
                const associates = DATA.roster.filter(r => r.floor === floorId && r.side === side && r.clockedIn);
                rows.push({
                    floor: floorLabel(floorId),
                    floorId,
                    side: side === "N" ? "North" : "South",
                    actualHC: associates.length,
                    logins: associates.map(a => a.login),
                });
            });
        });

        // Calculate totals per floor
        const floorTotals = {};
        floors.forEach(floorId => {
            const floorAssociates = DATA.roster.filter(r => r.floor === floorId && r.clockedIn);
            const target = DATA.targetHC[floorId] || 3;
            floorTotals[floorId] = {
                target,
                actual: floorAssociates.length,
            };
        });

        // Site total
        const siteTarget = floors.reduce((sum, f) => sum + (DATA.targetHC[f] || 3), 0);
        const siteActual = floors.reduce((sum, f) => sum + floorTotals[f].actual, 0);

        wrapper.innerHTML = `
            <table class="staffing-table">
                <thead>
                    <tr>
                        <th>Floor</th>
                        <th>Side</th>
                        <th>HC (Clocked In)</th>
                        <th>Logins</th>
                        <th>Area HC Target</th>
                        <th>Total Actual HC</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((row, i) => {
                        const isFirstOfFloor = i % 2 === 0;
                        const ft = floorTotals[row.floorId];
                        const actualClass = ft.actual < ft.target ? "staffing-under" : "staffing-met";
                        return `<tr>
                            ${isFirstOfFloor ? `<td rowspan="2" class="staffing-floor-cell"><strong>${row.floor}</strong></td>` : ""}
                            <td>${row.side}</td>
                            <td>${row.actualHC}</td>
                            <td class="staffing-logins">${row.logins.join(", ") || "—"}</td>
                            ${isFirstOfFloor ? `<td rowspan="2" class="staffing-target-cell">${ft.target}</td>` : ""}
                            ${isFirstOfFloor ? `<td rowspan="2" class="staffing-total-cell ${actualClass}">${ft.actual}</td>` : ""}
                        </tr>`;
                    }).join("")}
                </tbody>
                <tfoot>
                    <tr class="staffing-totals-row">
                        <td colspan="3"><strong>Site Total</strong></td>
                        <td></td>
                        <td><strong>${siteTarget}</strong></td>
                        <td class="${siteActual < siteTarget ? 'staffing-under' : 'staffing-met'}"><strong>${siteActual}</strong></td>
                    </tr>
                </tfoot>
            </table>
            ${renderDamagelandStaffingSection()}
        `;
    }

    function renderDamagelandStaffingSection() {
        const dlRoster = DATA.damagelandRoster;
        const allActive = dlRoster.filter(r => r.clockedIn);
        const totalTarget = (DATA.damagelandTargetHC.dlPS || 1) + (DATA.damagelandTargetHC.ps || 10);
        const totalActual = allActive.length;
        const totalClass = totalActual < totalTarget ? "staffing-under" : "staffing-met";

        return `
            <table class="staffing-table" style="margin-top:16px;">
                <thead>
                    <tr>
                        <th>Area</th>
                        <th>HC (Clocked In)</th>
                        <th>Logins</th>
                        <th>Target HC</th>
                        <th>Total Actual HC</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td class="staffing-floor-cell"><strong>Damageland</strong></td>
                        <td>${totalActual}</td>
                        <td class="staffing-logins">${allActive.map(r => r.login).join(", ") || "—"}</td>
                        <td class="staffing-target-cell">${totalTarget}</td>
                        <td class="staffing-total-cell ${totalClass}">${totalActual}</td>
                    </tr>
                </tbody>
            </table>
        `;
    }

    // --- Shift Report ---
    function renderShiftReport() {
        renderHandoffSummary();
        renderDailyPileChart();
        renderDailyResolutionChart();
        renderWeeklyRollup();
    }

    function renderHandoffSummary() {
        const container = document.getElementById("handoff-summary");
        const h = DATA.shiftHandoff;

        container.innerHTML = `
            <h3>Shift Handoff: ${h.outgoingShift} → ${h.incomingShift}</h3>
            <div class="handoff-meta">
                <div class="handoff-meta-item">Timestamp: <strong>${h.timestamp}</strong></div>
                <div class="handoff-meta-item">Pile Inherited: <strong>${h.summary.totalPileInherited}</strong></div>
                <div class="handoff-meta-item">Hot Items: <strong>${h.summary.hotItems}</strong></div>
                <div class="handoff-meta-item">Open Escalations: <strong>${h.summary.openEscalations}</strong></div>
            </div>
            <ul class="handoff-notes">
                ${h.summary.notes.map(n => `<li>${n}</li>`).join("")}
            </ul>
        `;
    }

    function renderDailyPileChart() {
        const ctx = document.getElementById("daily-pile-chart");
        if (charts.dailyPile) charts.dailyPile.destroy();

        charts.dailyPile = new Chart(ctx, {
            type: "line",
            data: {
                labels: DATA.trends.dailyPile.map(d => d.date),
                datasets: [{
                    label: "EOD Pile Count",
                    data: DATA.trends.dailyPile.map(d => d.count),
                    borderColor: "#1a237e",
                    backgroundColor: "#1a237e22",
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: false, title: { display: true, text: "Items" } } },
            },
        });
    }

    function renderDailyResolutionChart() {
        const ctx = document.getElementById("daily-resolution-chart");
        if (charts.dailyRes) charts.dailyRes.destroy();

        charts.dailyRes = new Chart(ctx, {
            type: "line",
            data: {
                labels: DATA.trends.dailyResolution.map(d => d.date),
                datasets: [{
                    label: "Resolution Rate %",
                    data: DATA.trends.dailyResolution.map(d => d.rate),
                    borderColor: "#2e7d32",
                    backgroundColor: "#2e7d3222",
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: false, max: 100, title: { display: true, text: "%" } } },
            },
        });
    }

    function renderWeeklyRollup() {
        const tbody = document.getElementById("weekly-body");
        const active = DATA.roster.filter(r => r.clockedIn);

        tbody.innerHTML = active.map(r => {
            const p = DATA.performance[r.login];
            if (!p || p.uph === 0) return "";
            const trendIcon = p.uph >= DATA.kpiTargets.rateTarget ? "&#9650;" : "&#9660;";
            const trendColor = p.uph >= DATA.kpiTargets.rateTarget ? "var(--success)" : "var(--danger)";

            return `<tr>
                <td><strong>${r.firstName} ${r.lastName}</strong> (${r.login})</td>
                <td>${floorLabel(r.floor)}</td>
                <td>${p.uph}</td>
                <td>${p.tot}%</td>
                <td>${p.unitsWeek}</td>
                <td>${p.firstTouch}%</td>
                <td style="color:${trendColor}">${trendIcon}</td>
            </tr>`;
        }).filter(Boolean).join("");
    }

    // --- Trends ---
    function setupTrends() {
        const rangeSelect = document.getElementById("trends-range");
        const viewSelect = document.getElementById("trends-view");

        if (rangeSelect) rangeSelect.addEventListener("change", renderTrends);
        if (viewSelect) viewSelect.addEventListener("change", renderTrends);

        // Export button
        const exportBtn = document.getElementById("btn-export-history");
        if (exportBtn) {
            exportBtn.addEventListener("click", () => History.exportJSON());
        }

        // Import button
        const importBtn = document.getElementById("btn-import-history");
        const importFile = document.getElementById("import-history-file");
        if (importBtn && importFile) {
            importBtn.addEventListener("click", () => importFile.click());
            importFile.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const statusEl = document.getElementById("status-history");
                const reader = new FileReader();
                reader.onload = (evt) => {
                    try {
                        const msg = History.importJSON(evt.target.result);
                        statusEl.textContent = msg;
                        statusEl.className = "import-status success";
                        renderTrends();
                    } catch (err) {
                        statusEl.textContent = "Error: " + err.message;
                        statusEl.className = "import-status error";
                    }
                };
                reader.readAsText(file);
            });
        }
    }

    function renderTrends() {
        const rangeDays = parseInt(document.getElementById("trends-range").value) || 30;
        const viewMode = document.getElementById("trends-view").value;
        const infoEl = document.getElementById("trends-history-info");

        const summary = History.getSummary();
        infoEl.textContent = summary.totalDays > 0
            ? `${summary.totalDays} days stored (${summary.firstDate} to ${summary.lastDate})`
            : "No historical data yet — upload reports to start tracking";

        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 10);
        const snapshots = History.getRange(startDate, endDate);

        if (snapshots.length === 0) {
            clearTrendCharts();
            return;
        }

        if (viewMode === "floor") {
            renderFloorTrends(snapshots);
        } else {
            renderAssociateTrends(snapshots);
        }

        renderPileTrends(snapshots);
    }

    function clearTrendCharts() {
        if (charts.trendUIT) charts.trendUIT.destroy();
        if (charts.trendToT) charts.trendToT.destroy();
        if (charts.trendUPH) charts.trendUPH.destroy();
        if (charts.trendPile) charts.trendPile.destroy();
        charts.trendUIT = null;
        charts.trendToT = null;
        charts.trendUPH = null;
        charts.trendPile = null;
    }

    const TREND_COLORS = ["#1a237e", "#ff6f00", "#2e7d32", "#7b1fa2", "#c62828", "#00838f", "#4e342e", "#283593"];

    function renderFloorTrends(snapshots) {
        const labels = snapshots.map(s => s.date.slice(5)); // "MM-DD"
        const floorIds = [1, 2, 3, 4];
        const floorColors = ["#1a237e", "#ff6f00", "#2e7d32", "#7b1fa2"];

        // UIT chart
        const uitCtx = document.getElementById("trend-uit-chart");
        if (charts.trendUIT) charts.trendUIT.destroy();
        charts.trendUIT = new Chart(uitCtx, {
            type: "line",
            data: {
                labels,
                datasets: floorIds.map((fId, i) => ({
                    label: floorLabel(fId),
                    data: snapshots.map(s => s.floors[fId] ? s.floors[fId].uit : null),
                    borderColor: floorColors[i],
                    backgroundColor: floorColors[i] + "22",
                    tension: 0.3,
                    fill: false,
                    pointRadius: 3,
                    spanGaps: true,
                })),
            },
            options: trendChartOptions("UIT %"),
        });

        // ToT chart
        const totCtx = document.getElementById("trend-tot-chart");
        if (charts.trendToT) charts.trendToT.destroy();
        charts.trendToT = new Chart(totCtx, {
            type: "line",
            data: {
                labels,
                datasets: floorIds.map((fId, i) => ({
                    label: floorLabel(fId),
                    data: snapshots.map(s => s.floors[fId] ? s.floors[fId].tot : null),
                    borderColor: floorColors[i],
                    backgroundColor: floorColors[i] + "22",
                    tension: 0.3,
                    fill: false,
                    pointRadius: 3,
                    spanGaps: true,
                })),
            },
            options: trendChartOptions("ToT %"),
        });

        // UPH chart
        const uphCtx = document.getElementById("trend-uph-chart");
        if (charts.trendUPH) charts.trendUPH.destroy();
        charts.trendUPH = new Chart(uphCtx, {
            type: "line",
            data: {
                labels,
                datasets: floorIds.map((fId, i) => ({
                    label: floorLabel(fId),
                    data: snapshots.map(s => s.floors[fId] ? s.floors[fId].avgUph : null),
                    borderColor: floorColors[i],
                    backgroundColor: floorColors[i] + "22",
                    tension: 0.3,
                    fill: false,
                    pointRadius: 3,
                    spanGaps: true,
                })),
            },
            options: trendChartOptions("Avg UPH"),
        });
    }

    function renderAssociateTrends(snapshots) {
        const labels = snapshots.map(s => s.date.slice(5));

        // Get all unique associates across snapshots that are on the current roster
        const rosterLogins = new Set(DATA.roster.map(r => r.login));
        const associateSet = new Set();
        snapshots.forEach(s => {
            Object.keys(s.associates).forEach(login => {
                if (rosterLogins.has(login)) associateSet.add(login);
            });
        });
        const associates = Array.from(associateSet);

        // UIT chart
        const uitCtx = document.getElementById("trend-uit-chart");
        if (charts.trendUIT) charts.trendUIT.destroy();
        charts.trendUIT = new Chart(uitCtx, {
            type: "line",
            data: {
                labels,
                datasets: associates.map((login, i) => {
                    const color = TREND_COLORS[i % TREND_COLORS.length];
                    const nameLabel = DATA.roster.find(r => r.login === login);
                    return {
                        label: nameLabel ? `${nameLabel.firstName} ${nameLabel.lastName}` : login,
                        data: snapshots.map(s => s.associates[login] ? s.associates[login].uit : null),
                        borderColor: color,
                        backgroundColor: color + "22",
                        tension: 0.3,
                        fill: false,
                        pointRadius: 2,
                        borderWidth: 2,
                        spanGaps: true,
                    };
                }),
            },
            options: trendChartOptions("UIT %"),
        });

        // ToT chart
        const totCtx = document.getElementById("trend-tot-chart");
        if (charts.trendToT) charts.trendToT.destroy();
        charts.trendToT = new Chart(totCtx, {
            type: "line",
            data: {
                labels,
                datasets: associates.map((login, i) => {
                    const color = TREND_COLORS[i % TREND_COLORS.length];
                    const nameLabel = DATA.roster.find(r => r.login === login);
                    return {
                        label: nameLabel ? `${nameLabel.firstName} ${nameLabel.lastName}` : login,
                        data: snapshots.map(s => s.associates[login] ? s.associates[login].tot : null),
                        borderColor: color,
                        backgroundColor: color + "22",
                        tension: 0.3,
                        fill: false,
                        pointRadius: 2,
                        borderWidth: 2,
                        spanGaps: true,
                    };
                }),
            },
            options: trendChartOptions("ToT %"),
        });

        // UPH chart
        const uphCtx = document.getElementById("trend-uph-chart");
        if (charts.trendUPH) charts.trendUPH.destroy();
        charts.trendUPH = new Chart(uphCtx, {
            type: "line",
            data: {
                labels,
                datasets: associates.map((login, i) => {
                    const color = TREND_COLORS[i % TREND_COLORS.length];
                    const nameLabel = DATA.roster.find(r => r.login === login);
                    return {
                        label: nameLabel ? `${nameLabel.firstName} ${nameLabel.lastName}` : login,
                        data: snapshots.map(s => s.associates[login] ? s.associates[login].uph : null),
                        borderColor: color,
                        backgroundColor: color + "22",
                        tension: 0.3,
                        fill: false,
                        pointRadius: 2,
                        borderWidth: 2,
                        spanGaps: true,
                    };
                }),
            },
            options: trendChartOptions("UPH"),
        });
    }

    function renderPileTrends(snapshots) {
        const pileSnapshots = snapshots.filter(s => s.piles);
        const ctx = document.getElementById("trend-pile-chart");
        if (charts.trendPile) charts.trendPile.destroy();

        if (pileSnapshots.length === 0) {
            charts.trendPile = null;
            return;
        }

        const labels = pileSnapshots.map(s => s.date.slice(5));
        const floorIds = [1, 2, 3, 4];
        const floorColors = ["#1a237e", "#ff6f00", "#2e7d32", "#7b1fa2"];

        // Show SOS total as a dashed line, and per-floor current counts as solid lines
        const datasets = floorIds.map((fId, i) => ({
            label: `${floorLabel(fId)} (Current)`,
            data: pileSnapshots.map(s => s.piles.current[fId] || 0),
            borderColor: floorColors[i],
            backgroundColor: floorColors[i] + "22",
            tension: 0.3,
            fill: false,
            pointRadius: 3,
        }));

        // Add site total lines
        datasets.push({
            label: "Total (SOS)",
            data: pileSnapshots.map(s => s.piles.sosTotal || 0),
            borderColor: "#9e9e9e",
            borderDash: [5, 5],
            tension: 0.3,
            fill: false,
            pointRadius: 2,
            borderWidth: 2,
        });
        datasets.push({
            label: "Total (Current)",
            data: pileSnapshots.map(s => s.piles.currentTotal || 0),
            borderColor: "#212121",
            tension: 0.3,
            fill: false,
            pointRadius: 3,
            borderWidth: 2,
        });

        charts.trendPile = new Chart(ctx, {
            type: "line",
            data: { labels, datasets },
            options: trendChartOptions("Pile Count"),
        });
    }

    function trendChartOptions(yLabel) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
                tooltip: { mode: "index", intersect: false },
            },
            scales: {
                x: { ticks: { maxRotation: 45, font: { size: 10 } } },
                y: { beginAtZero: true, title: { display: true, text: yLabel } },
            },
        };
    }

    // --- Auto Refresh Simulation ---
    function startAutoRefresh() {
        setInterval(() => {
            // Simulate minor data fluctuations
            DATA.floors.forEach(f => {
                const change = Math.floor(Math.random() * 5) - 2;
                DATA.pileData.current[f.id] = Math.max(50, DATA.pileData.current[f.id] + change);
                f.pileCount = DATA.pileData.current[f.id];
            });
            renderAll();
            updateRefreshTime();
        }, 60000); // Every 60 seconds
    }

    // --- Boot ---
    // Expose renderAll globally for CSV import module
    window.renderAll = renderAll;

    // Roster management functions
    window.removePS = function(login) {
        const entry = DATA.roster.find(r => r.login === login);
        const name = entry ? `${entry.firstName} ${entry.lastName}` : login;
        if (confirm(`Remove ${name} from the roster?`)) {
            const idx = DATA.roster.findIndex(r => r.login === login);
            if (idx >= 0) DATA.roster.splice(idx, 1);
            CSVImport.saveToStorage();
            renderAll();
        }
    };

    window.toggleClockedIn = function(login, checked) {
        const entry = DATA.roster.find(r => r.login === login);
        if (entry) {
            entry.clockedIn = checked;
            CSVImport.saveToStorage();
            renderRosterStats();
            renderKPIs();
            renderFloorGrid();
        }
    };

    window.changeFloor = function(login, floorValue) {
        const entry = DATA.roster.find(r => r.login === login);
        if (entry) {
            entry.floor = parseInt(floorValue);
            CSVImport.saveToStorage();
            renderFloorGrid();
            renderKPIs();
        }
    };

    window.changeSide = function(login, sideValue) {
        const entry = DATA.roster.find(r => r.login === login);
        if (entry) {
            entry.side = sideValue;
            CSVImport.saveToStorage();
        }
    };

    window.updateTargetHC = function(floorId, value) {
        DATA.targetHC[floorId] = parseInt(value) || 0;
        CSVImport.saveToStorage();
        renderKPIs();
        renderFloorGrid();
    };

    window.updateRosterField = function(login, field, value) {
        const entry = DATA.roster.find(r => r.login === login);
        if (entry) {
            entry[field] = value.trim();
            CSVImport.saveToStorage();
        }
    };

    document.addEventListener("DOMContentLoaded", init);
})();
