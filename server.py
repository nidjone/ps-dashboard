"""
ORF3 IB Problem Solve Dashboard - Shared Server
Run: python server.py
Access: http://localhost:8080

Serves the dashboard and provides a shared JSON data store
so multiple users can import data and see the same state.
"""

import http.server
import json
import os
import threading
from pathlib import Path

PORT = int(os.environ.get("PORT", 8080))
DATA_DIR = Path(__file__).parent / "server_data"
DATA_FILE = DATA_DIR / "dashboard_data.json"
HISTORY_FILE = DATA_DIR / "history_data.json"

# Ensure data directory exists
DATA_DIR.mkdir(exist_ok=True)

# Thread lock for file writes
lock = threading.Lock()


def read_json(filepath):
    if filepath.exists():
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def write_json(filepath, data):
    with lock:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    """Serves static files + handles /api/* endpoints for shared data."""

    def do_GET(self):
        if self.path == "/api/data":
            self._send_json(read_json(DATA_FILE) or {})
        elif self.path == "/api/history":
            self._send_json(read_json(HISTORY_FILE) or [])
        elif self.path == "/api/status":
            self._send_json({
                "server": "ORF3 PS Dashboard",
                "dataExists": DATA_FILE.exists(),
                "historyExists": HISTORY_FILE.exists(),
            })
        else:
            super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._send_error(400, "Invalid JSON")
            return

        if self.path == "/api/data":
            write_json(DATA_FILE, payload)
            self._send_json({"ok": True, "message": "Data saved"})

        elif self.path == "/api/data/merge":
            # Merge only the provided top-level sections into existing data.
            # This prevents one user's save from wiping another user's changes
            # to a different section (roster, damagelandRoster, pileData, etc.)
            with lock:
                existing = read_json(DATA_FILE) or {}
                for key, value in payload.items():
                    existing[key] = value
                with open(DATA_FILE, "w", encoding="utf-8") as f:
                    json.dump(existing, f, indent=2)
            self._send_json({"ok": True, "message": "Data merged", "keys": list(payload.keys())})

        elif self.path == "/api/roster/update":
            # Update or add individual roster entries by login, without
            # replacing the whole roster. Optionally remove specific logins.
            # Payload: { roster: [...changed entries...],
            #            damagelandRoster: [...],
            #            removeLogins: [...], removeDamagelandLogins: [...],
            #            targetHC: {...}, damagelandTargetHC: {...} }
            with lock:
                existing = read_json(DATA_FILE) or {}

                def merge_list(existing_list, incoming, remove_logins):
                    existing_list = existing_list or []
                    by_login = {r.get("login"): r for r in existing_list}
                    for entry in (incoming or []):
                        login = entry.get("login")
                        if login:
                            by_login[login] = entry
                    for login in (remove_logins or []):
                        by_login.pop(login, None)
                    return list(by_login.values())

                existing["roster"] = merge_list(
                    existing.get("roster"),
                    payload.get("roster"),
                    payload.get("removeLogins"),
                )
                existing["damagelandRoster"] = merge_list(
                    existing.get("damagelandRoster"),
                    payload.get("damagelandRoster"),
                    payload.get("removeDamagelandLogins"),
                )
                if "targetHC" in payload:
                    existing["targetHC"] = payload["targetHC"]
                if "damagelandTargetHC" in payload:
                    existing["damagelandTargetHC"] = payload["damagelandTargetHC"]

                with open(DATA_FILE, "w", encoding="utf-8") as f:
                    json.dump(existing, f, indent=2)
            self._send_json({"ok": True, "message": "Roster updated"})

        elif self.path == "/api/history":
            write_json(HISTORY_FILE, payload)
            self._send_json({"ok": True, "message": "History saved"})

        elif self.path == "/api/history/merge":
            # Merge incoming snapshots with existing (no duplicates by date)
            existing = read_json(HISTORY_FILE) or []
            incoming = payload if isinstance(payload, list) else payload.get("snapshots", [])
            date_set = {s["date"] for s in existing}
            added = 0
            for snap in incoming:
                if snap.get("date") and snap["date"] not in date_set:
                    existing.append(snap)
                    date_set.add(snap["date"])
                    added += 1
                elif snap.get("date") and snap["date"] in date_set:
                    # Update existing date's snapshot
                    idx = next(i for i, s in enumerate(existing) if s["date"] == snap["date"])
                    existing[idx] = snap
            existing.sort(key=lambda s: s["date"])
            write_json(HISTORY_FILE, existing)
            self._send_json({"ok": True, "added": added, "total": len(existing)})

        else:
            self._send_error(404, "Not found")

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def _send_json(self, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, code, message):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        # Quieter logging - only log API calls
        if "/api/" in (args[0] if args else ""):
            super().log_message(format, *args)


if __name__ == "__main__":
    os.chdir(Path(__file__).parent)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), DashboardHandler)
    print(f"{'='*50}")
    print(f"  ORF3 IB Problem Solve Dashboard")
    print(f"  Server running on http://localhost:{PORT}")
    print(f"  Share with team: http://<your-hostname>:{PORT}")
    print(f"  Data stored in: {DATA_DIR}")
    print(f"{'='*50}")
    print(f"  Press Ctrl+C to stop")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.shutdown()
