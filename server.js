/**
 * ORF3 IB Problem Solve Dashboard - Shared Server (Node.js)
 * Run: node server.js
 * Access: http://localhost:8080
 *
 * Serves the dashboard and provides a shared JSON data store
 * so multiple users can import data and see the same state.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const DATA_DIR = path.join(__dirname, "server_data");
const DATA_FILE = path.join(DATA_DIR, "dashboard_data.json");
const HISTORY_FILE = path.join(DATA_DIR, "history_data.json");
const SW_DATA_FILE = path.join(DATA_DIR, "standard_work.json");
const SW_HISTORY_FILE = path.join(DATA_DIR, "standard_work_history.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// MIME types for static files
const MIME = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

function readJSON(filepath) {
    try {
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, "utf-8"));
        }
    } catch (e) { /* ignore */ }
    return null;
}

function writeJSON(filepath, data) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
}

function sendJSON(res, data) {
    const body = JSON.stringify(data);
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(body);
}

function sendError(res, code, message) {
    res.writeHead(code, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ error: message }));
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => resolve(body));
    });
}

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        res.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
    }

    // API routes
    if (req.url === "/api/status" && req.method === "GET") {
        sendJSON(res, {
            server: "ORF3 PS Dashboard",
            dataExists: fs.existsSync(DATA_FILE),
            historyExists: fs.existsSync(HISTORY_FILE),
        });
        return;
    }

    if (req.url === "/api/data" && req.method === "GET") {
        sendJSON(res, readJSON(DATA_FILE) || {});
        return;
    }

    if (req.url === "/api/data" && req.method === "POST") {
        const body = await readBody(req);
        try {
            writeJSON(DATA_FILE, JSON.parse(body));
            sendJSON(res, { ok: true, message: "Data saved" });
        } catch (e) {
            sendError(res, 400, "Invalid JSON");
        }
        return;
    }

    if (req.url === "/api/data/merge" && req.method === "POST") {
        const body = await readBody(req);
        try {
            const payload = JSON.parse(body);
            const existing = readJSON(DATA_FILE) || {};
            Object.keys(payload).forEach(key => { existing[key] = payload[key]; });
            writeJSON(DATA_FILE, existing);
            sendJSON(res, { ok: true, message: "Data merged", keys: Object.keys(payload) });
        } catch (e) {
            sendError(res, 400, "Invalid JSON");
        }
        return;
    }

    if (req.url === "/api/roster/update" && req.method === "POST") {
        const body = await readBody(req);
        try {
            const payload = JSON.parse(body);
            const existing = readJSON(DATA_FILE) || {};

            const mergeList = (existingList, incoming, removeLogins) => {
                const byLogin = {};
                (existingList || []).forEach(r => { if (r.login) byLogin[r.login] = r; });
                (incoming || []).forEach(entry => { if (entry.login) byLogin[entry.login] = entry; });
                (removeLogins || []).forEach(login => { delete byLogin[login]; });
                return Object.values(byLogin);
            };

            existing.roster = mergeList(existing.roster, payload.roster, payload.removeLogins);
            existing.damagelandRoster = mergeList(existing.damagelandRoster, payload.damagelandRoster, payload.removeDamagelandLogins);
            if (payload.targetHC) existing.targetHC = payload.targetHC;
            if (payload.damagelandTargetHC) existing.damagelandTargetHC = payload.damagelandTargetHC;

            writeJSON(DATA_FILE, existing);
            sendJSON(res, { ok: true, message: "Roster updated" });
        } catch (e) {
            sendError(res, 400, "Invalid JSON");
        }
        return;
    }

    if (req.url === "/api/history" && req.method === "GET") {
        sendJSON(res, readJSON(HISTORY_FILE) || []);
        return;
    }

    if (req.url === "/api/history" && req.method === "POST") {
        const body = await readBody(req);
        try {
            writeJSON(HISTORY_FILE, JSON.parse(body));
            sendJSON(res, { ok: true, message: "History saved" });
        } catch (e) {
            sendError(res, 400, "Invalid JSON");
        }
        return;
    }

    if (req.url === "/api/history/merge" && req.method === "POST") {
        const body = await readBody(req);
        try {
            const incoming = JSON.parse(body);
            const snapshots = Array.isArray(incoming) ? incoming : (incoming.snapshots || []);
            const existing = readJSON(HISTORY_FILE) || [];
            const dateSet = new Set(existing.map(s => s.date));
            let added = 0;
            snapshots.forEach(snap => {
                if (snap.date && !dateSet.has(snap.date)) {
                    existing.push(snap);
                    dateSet.add(snap.date);
                    added++;
                } else if (snap.date) {
                    const idx = existing.findIndex(s => s.date === snap.date);
                    if (idx >= 0) existing[idx] = snap;
                }
            });
            existing.sort((a, b) => a.date.localeCompare(b.date));
            writeJSON(HISTORY_FILE, existing);
            sendJSON(res, { ok: true, added, total: existing.length });
        } catch (e) {
            sendError(res, 400, "Invalid JSON");
        }
        return;
    }

    // --- Standard Work API routes ---
    if (req.url === "/api/standard-work/data" && req.method === "GET") {
        sendJSON(res, readJSON(SW_DATA_FILE) || {});
        return;
    }

    if (req.url === "/api/standard-work/data" && req.method === "POST") {
        const body = await readBody(req);
        try {
            writeJSON(SW_DATA_FILE, JSON.parse(body));
            sendJSON(res, { ok: true, message: "Standard work data saved" });
        } catch (e) {
            sendError(res, 400, "Invalid JSON");
        }
        return;
    }

    if (req.url === "/api/standard-work/history" && req.method === "GET") {
        sendJSON(res, readJSON(SW_HISTORY_FILE) || []);
        return;
    }

    if (req.url === "/api/standard-work/history" && req.method === "POST") {
        const body = await readBody(req);
        try {
            writeJSON(SW_HISTORY_FILE, JSON.parse(body));
            sendJSON(res, { ok: true, message: "Standard work history saved" });
        } catch (e) {
            sendError(res, 400, "Invalid JSON");
        }
        return;
    }

    // Static file serving
    let filePath = req.url === "/" ? "/index.html" : req.url;
    filePath = path.join(__dirname, filePath.split("?")[0]);

    // Security: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        sendError(res, 403, "Forbidden");
        return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";

    try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
    } catch (e) {
        sendError(res, 404, "Not found");
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("==================================================");
    console.log("  ORF3 IB Problem Solve Dashboard");
    console.log(`  Server running on http://localhost:${PORT}`);
    console.log(`  Share with team: http://<your-hostname>:${PORT}`);
    console.log(`  Data stored in: ${DATA_DIR}`);
    console.log("==================================================");
    console.log("  Press Ctrl+C to stop");
    console.log();
});
