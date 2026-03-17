"""
app.py — SmartNav AI  (self-contained, no external auth/security packages)
===========================================================================
All admin persistence is embedded here — no external admin_store module.
The SQLite database is stored at  .data/.nav.db  (hidden from project listing).

Dependencies (all available in base Python + Flask):
  flask, requests  — everything else is stdlib

Public endpoints
  GET  /                          SPA shell
  POST /route                     Geocode + route + score
  POST /route-coords              Route between raw coordinates
  GET  /suggestions               Autocomplete suggestions
  GET  /nearby                    POI search

Admin (server-session authenticated)
  POST /api/beacon                Anonymous GPS beacon (opt-in, GPS-granted users)
  POST /admin/login               Credential check → sets server session
  GET  /admin/data                All sessions + live users + stats
  GET  /admin/session/<sid>       Beacon history for one session
  POST /admin/logout              Clear admin session
  GET  /admin/export/sessions     Download sessions CSV
"""

# ── Standard library ───────────────────────────────────────────────────────
import csv
import hashlib
import io
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from collections import defaultdict
from functools import wraps

# ── Third-party (only Flask + requests required) ────────────────────────────
from flask import Flask, Response, jsonify, render_template, request, session

# ── Project modules ────────────────────────────────────────────────────────
from routing_engine import (
    CITY_SEARCH_RADIUS_M,
    _extract_poi_keyword,
    fetch_routes,
    geocode,
    get_suggestions,
    search_nearby,
)
from scoring_engine import score_routes

# ===========================================================================
# Logging
# ===========================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ===========================================================================
# Application constants
# ===========================================================================
_TEXT_MAX_LEN          = 200
_SUGGESTION_MAX_LEN    = 100
_NEARBY_MAX_LEN        = 100
_SUGGESTION_LIMIT      = 8
_NEARBY_RADIUS_MIN     = 100
_NEARBY_RADIUS_DEFAULT = 25_000

_RENDER_ENV_VAR        = "RENDER"
_DEFAULT_PORT          = 5000
_CERT_PATH = os.path.join(os.path.dirname(__file__), "certs", "cert.pem")
_KEY_PATH  = os.path.join(os.path.dirname(__file__), "certs",  "key.pem")

_ALLOWED_CORS_ORIGINS = {
    "https://smartnav-ai.onrender.com",
    "http://localhost:5000",
    "https://localhost:5000",
    "http://127.0.0.1:5000",
    "https://127.0.0.1:5000",
}

# ===========================================================================
# Content-Security-Policy  (single header string — no flask-talisman needed)
# ===========================================================================
_CSP = (
    "default-src 'self'; "
    # 'unsafe-eval' required by MapLibre GL for WebGL shader compilation
    # 'wasm-unsafe-eval' required for WebAssembly tile workers
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' "
        "https://unpkg.com https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net "
        "https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net "
        "https://unpkg.com; "
    "img-src 'self' data: blob: "
        "https://*.tile.openstreetmap.org "
        "https://*.basemaps.cartocdn.com "
        "https://*.openfreemap.org "
        "https://tile.openfreemap.org "
        "https://*.maptiler.com "
        "https://api.maptiler.com; "
    "connect-src 'self' "
        "https://tiles.openfreemap.org "
        "https://*.openfreemap.org "
        "https://*.basemaps.cartocdn.com "
        "https://routing.openstreetmap.de "
        "https://router.project-osrm.org "
        "https://nominatim.openstreetmap.org "
        "https://overpass-api.de "
        "https://photon.komoot.io "
        "https://unpkg.com; "
    "worker-src blob: 'self'; "
    "child-src blob: 'self';"
)


# ===========================================================================
# NATIVE CORS  (replaces flask-cors)
# ===========================================================================

def _apply_cors(response):
    origin = request.headers.get("Origin", "")
    if origin in _ALLOWED_CORS_ORIGINS:
        response.headers["Access-Control-Allow-Origin"]      = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Methods"]     = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"]     = "Content-Type,Authorization"
        response.headers["Vary"]                             = "Origin"
    return response


# ===========================================================================
# NATIVE SECURITY HEADERS  (replaces flask-talisman)
# ===========================================================================

def _apply_security_headers(response):
    response.headers["X-Content-Type-Options"]    = "nosniff"
    response.headers["X-XSS-Protection"]          = "1; mode=block"
    response.headers["X-Frame-Options"]           = "SAMEORIGIN"
    response.headers["Referrer-Policy"]           = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]        = "geolocation=(self), camera=(), microphone=()"
    response.headers["Content-Security-Policy"]   = _CSP
    return response


# ===========================================================================
# NATIVE RATE LIMITER  (replaces flask-limiter)
# Thread-safe sliding-window rate limiter keyed on client IP
# ===========================================================================

class _RateLimiter:
    def __init__(self):
        self._lock = threading.Lock()
        self._hits: dict = defaultdict(list)

    def _prune(self, key: str, window: float, now: float):
        cutoff = now - window
        self._hits[key] = [t for t in self._hits[key] if t > cutoff]

    def is_allowed(self, key: str, limit: int, window_s: float) -> bool:
        now = time.monotonic()
        with self._lock:
            self._prune(key, window_s, now)
            if len(self._hits[key]) >= limit:
                return False
            self._hits[key].append(now)
            return True

    def cleanup(self):
        cutoff = time.monotonic() - 3600
        with self._lock:
            stale = [k for k, ts in self._hits.items()
                     if not ts or ts[-1] < cutoff]
            for k in stale:
                del self._hits[k]


_limiter = _RateLimiter()


def _bg_cleanup():
    while True:
        time.sleep(600)
        _limiter.cleanup()


threading.Thread(target=_bg_cleanup, daemon=True).start()


def _rate_limit(limit: int, window_s: float):
    """Decorator: returns 429 if IP exceeds `limit` requests per `window_s` seconds."""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            ip = (
                request.headers.get("X-Forwarded-For", request.remote_addr) or "127.0.0.1"
            ).split(",")[0].strip()
            # Use route + IP as key so limits are per-endpoint
            key = f"{request.endpoint}:{ip}"
            if not _limiter.is_allowed(key, limit, window_s):
                return jsonify({"error": "Too many requests"}), 429
            return fn(*args, **kwargs)
        return wrapper
    return decorator


# ===========================================================================
# ADMIN DATA STORE  (SQLite — hidden .data/.nav.db)
# ===========================================================================
_ADMIN_EMAIL     = "admin@gmail.com"
_ADMIN_PASS_HASH = hashlib.sha256(b"admin@123").hexdigest()

_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".data")
_DB_FILE  = os.path.join(_DATA_DIR, ".nav.db")
_db_lock  = threading.Lock()


def _db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_FILE, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _init_db() -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)
    gi = os.path.join(_DATA_DIR, ".gitignore")
    if not os.path.exists(gi):
        with open(gi, "w") as fh:
            fh.write("*\n")
    with _db_lock, _db_connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id   TEXT PRIMARY KEY,
                ip           TEXT,
                user_agent   TEXT,
                browser      TEXT,
                os_name      TEXT,
                device_type  TEXT,
                first_seen   REAL,
                last_seen    REAL,
                page_views   INTEGER DEFAULT 1,
                loc_granted  INTEGER DEFAULT 0
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS beacons (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  TEXT,
                ts          REAL,
                lat         REAL,
                lon         REAL,
                accuracy_m  REAL,
                speed_kmh   REAL,
                city        TEXT,
                address     TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id)
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_b_sess ON beacons(session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_b_ts   ON beacons(ts)")
        conn.commit()
    log.info("admin-db  ready  path=%s", _DB_FILE)


def _parse_ua(ua: str) -> tuple:
    u = ua.lower()
    if "edg/" in u or "edge/" in u:       browser = "Edge"
    elif "opr/" in u or "opera" in u:     browser = "Opera"
    elif "firefox/" in u:                 browser = "Firefox"
    elif "samsungbrowser" in u:           browser = "Samsung Browser"
    elif "ucbrowser" in u:                browser = "UC Browser"
    elif "chrome/" in u:                  browser = "Chrome"
    elif "safari/" in u:                  browser = "Safari"
    else:                                 browser = "Unknown"
    if "android" in u:                    os_name = "Android"
    elif "iphone" in u or "ipad" in u:    os_name = "iOS"
    elif "windows" in u:                  os_name = "Windows"
    elif "mac os" in u or "macos" in u:   os_name = "macOS"
    elif "linux" in u:                    os_name = "Linux"
    else:                                 os_name = "Unknown"
    if any(k in u for k in ("mobile", "android", "iphone", "ipod")):
        device = "Mobile"
    elif any(k in u for k in ("ipad", "tablet")):
        device = "Tablet"
    else:
        device = "Desktop"
    return browser, os_name, device


def _upsert_session(sid: str, ip: str, ua: str) -> None:
    browser, os_name, device = _parse_ua(ua)
    now = time.time()
    with _db_lock, _db_connect() as conn:
        conn.execute("""
            INSERT INTO sessions
              (session_id,ip,user_agent,browser,os_name,device_type,first_seen,last_seen,page_views)
            VALUES (?,?,?,?,?,?,?,?,1)
            ON CONFLICT(session_id) DO UPDATE SET
              last_seen=excluded.last_seen, ip=excluded.ip,
              page_views=page_views+1
        """, (sid, ip, ua[:512], browser, os_name, device, now, now))
        conn.commit()


def _add_beacon(sid: str, lat: float, lon: float,
                acc: float, spd: float, city: str = "", address: str = "") -> None:
    now = time.time()
    with _db_lock, _db_connect() as conn:
        conn.execute("""
            INSERT INTO beacons (session_id,ts,lat,lon,accuracy_m,speed_kmh,city,address)
            VALUES (?,?,?,?,?,?,?,?)
        """, (sid, now, lat, lon, acc, spd, city[:80], address[:120]))
        conn.execute(
            "UPDATE sessions SET loc_granted=1, last_seen=? WHERE session_id=?",
            (now, sid))
        conn.execute("""
            DELETE FROM beacons WHERE session_id=? AND id NOT IN (
                SELECT id FROM beacons WHERE session_id=? ORDER BY ts DESC LIMIT 50)
        """, (sid, sid))
        conn.commit()


def _get_sessions(limit: int = 100) -> list:
    with _db_connect() as conn:
        rows = conn.execute("""
            SELECT s.*, b.lat, b.lon, b.accuracy_m, b.speed_kmh,
                   b.city, b.address, b.ts AS last_beacon_ts
            FROM sessions s
            LEFT JOIN beacons b ON b.id = (
                SELECT id FROM beacons WHERE session_id=s.session_id
                ORDER BY ts DESC LIMIT 1)
            ORDER BY s.last_seen DESC LIMIT ?
        """, (limit,)).fetchall()
    return [dict(r) for r in rows]


def _get_live(stale_s: float = 120.0) -> list:
    cutoff = time.time() - stale_s
    with _db_connect() as conn:
        rows = conn.execute("""
            SELECT s.*, b.lat, b.lon, b.accuracy_m, b.speed_kmh,
                   b.city, b.address, b.ts AS last_beacon_ts
            FROM sessions s
            JOIN beacons b ON b.id = (
                SELECT id FROM beacons WHERE session_id=s.session_id
                ORDER BY ts DESC LIMIT 1)
            WHERE b.ts >= ?
            ORDER BY b.ts DESC
        """, (cutoff,)).fetchall()
    return [dict(r) for r in rows]


def _get_beacons(sid: str, limit: int = 30) -> list:
    with _db_connect() as conn:
        rows = conn.execute(
            "SELECT * FROM beacons WHERE session_id=? ORDER BY ts DESC LIMIT ?",
            (sid, limit)).fetchall()
    return [dict(r) for r in rows]


def _get_stats() -> dict:
    now = time.time()
    with _db_connect() as conn:
        total   = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        loc     = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE loc_granted=1").fetchone()[0]
        live    = conn.execute(
            "SELECT COUNT(DISTINCT session_id) FROM beacons WHERE ts>=?",
            (now - 120,)).fetchone()[0]
        bcount  = conn.execute("SELECT COUNT(*) FROM beacons").fetchone()[0]
        today   = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE first_seen>=?",
            (now - 86400,)).fetchone()[0]
        mobile  = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE device_type='Mobile'").fetchone()[0]
    return dict(total_sessions=total, location_granted=loc, live_now=live,
                total_beacons=bcount, today=today, mobile=mobile)


def _verify_admin(email: str, password: str) -> bool:
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    return email.strip().lower() == _ADMIN_EMAIL and pw_hash == _ADMIN_PASS_HASH


# ===========================================================================
# Input sanitisers
# ===========================================================================

def _sanitize_text(value, max_len: int = _TEXT_MAX_LEN) -> str:
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    return value[:max_len].strip()


def _parse_coord(value, name: str, lo: float, hi: float) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"'{name}' must be a number")
    if not lo <= f <= hi:
        raise ValueError(f"'{name}' out of range [{lo}, {hi}]")
    return f


def _parse_optional_coord(value, name: str, lo: float, hi: float):
    if value is None or value == "":
        return None
    try:
        return _parse_coord(value, name, lo, hi)
    except ValueError:
        return None


# ===========================================================================
# App factory
# ===========================================================================

def create_app() -> Flask:
    application = Flask(__name__)
    application.secret_key = os.environ.get(
        "FLASK_SECRET_KEY", "snav-" + secrets.token_hex(16))
    application.config["SESSION_COOKIE_HTTPONLY"]    = True
    application.config["SESSION_COOKIE_SAMESITE"]    = "Lax"
    application.config["SESSION_COOKIE_SECURE"]      = False  # set True behind HTTPS proxy
    application.config["PERMANENT_SESSION_LIFETIME"] = 3600

    # Apply CORS + security headers on every response
    @application.after_request
    def _after(response):
        _apply_cors(response)
        _apply_security_headers(response)
        return response

    # Handle CORS pre-flight globally
    @application.before_request
    def _preflight():
        if request.method == "OPTIONS":
            resp = application.make_default_options_response()
            _apply_cors(resp)
            return resp

    # Session tracking (runs on every non-static request)
    @application.before_request
    def _track():
        if request.path.startswith("/static"):
            return
        if "vid" not in session:
            session["vid"] = uuid.uuid4().hex
            session.permanent = True
        ip = (
            request.headers.get("X-Forwarded-For", request.remote_addr) or ""
        ).split(",")[0].strip()
        ua = request.headers.get("User-Agent", "")
        _upsert_session(session["vid"], ip, ua)

    _register_routes(application)
    return application


def _register_routes(application: Flask) -> None:

    # ── Public SPA ─────────────────────────────────────────────────────────
    @application.get("/")
    def index():
        return render_template("index.html")

    # ── Routing ─────────────────────────────────────────────────────────────
    @application.post("/route")
    @_rate_limit(30, 60)
    def route():
        body = request.get_json(silent=True) or {}
        dest = _sanitize_text(body.get("destination", ""))
        if not dest:
            return jsonify({"error": "destination is required"}), 400
        user_lat = _parse_optional_coord(body.get("user_lat"), "user_lat", -90, 90)
        user_lon = _parse_optional_coord(body.get("user_lon"), "user_lon", -180, 180)
        coords = geocode(dest, user_lat=user_lat, user_lon=user_lon)
        if not coords:
            return jsonify({"error": f'Could not find "{dest}"'}), 404
        if user_lat is None or user_lon is None:
            return jsonify({"error": "user location required for routing"}), 400
        raw = fetch_routes(user_lat, user_lon, coords["lat"], coords["lon"])
        if not raw:
            return jsonify({"error": "No routes found"}), 404
        valid = [r for r in raw if r.get("geometry") and len(r["geometry"]) >= 2]
        if not valid:
            return jsonify({"error": "No valid route geometries"}), 404
        normalised = []
        for r in valid:
            try:
                normalised.append({
                    "distance": float(r["distance"]),
                    "duration": float(r["duration"]),
                    "geometry": [[float(p[0]), float(p[1])] for p in r["geometry"]],
                })
            except (KeyError, TypeError, ValueError):
                continue
        log.info("route  '%s'  %.4f,%.4f  %d route(s)",
                 dest, coords["lat"], coords["lon"], len(normalised))
        return jsonify({"destination": coords, "routes": score_routes(normalised)})

    @application.post("/route-coords")
    @_rate_limit(30, 60)
    def route_coords():
        body = request.get_json(silent=True) or {}
        try:
            slat = _parse_coord(body.get("start_lat"), "start_lat", -90, 90)
            slon = _parse_coord(body.get("start_lon"), "start_lon", -180, 180)
            elat = _parse_coord(body.get("end_lat"),   "end_lat",   -90, 90)
            elon = _parse_coord(body.get("end_lon"),   "end_lon",   -180, 180)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        raw = fetch_routes(slat, slon, elat, elon)
        if not raw:
            return jsonify({"error": "No routes found"}), 404
        valid = [r for r in raw if r.get("geometry") and len(r["geometry"]) >= 2]
        normalised = []
        for r in valid:
            try:
                normalised.append({
                    "distance": float(r["distance"]),
                    "duration": float(r["duration"]),
                    "geometry": [[float(p[0]), float(p[1])] for p in r["geometry"]],
                })
            except (KeyError, TypeError, ValueError):
                continue
        return jsonify({"routes": score_routes(normalised)})

    # ── Score routes (browser-collected OSRM routes, scored server-side) ────────
    @application.post("/score-routes")
    @_rate_limit(60, 60)
    def score_routes_endpoint():
        body = request.get_json(silent=True) or {}
        raw = body.get("routes")
        if not isinstance(raw, list) or not raw:
            return jsonify({"error": "routes array required"}), 400
        normalised = []
        for r in raw:
            try:
                normalised.append({
                    "distance": float(r["distance"]),
                    "duration": float(r["duration"]),
                    "geometry": [[float(p[0]), float(p[1])] for p in r["geometry"]],
                })
            except (KeyError, TypeError, ValueError):
                continue
        if not normalised:
            return jsonify({"error": "No valid routes to score"}), 400
        return jsonify({"routes": score_routes(normalised)})

    # ── Suggestions + nearby ─────────────────────────────────────────────────
    @application.get("/suggestions")
    @_rate_limit(60, 60)
    def suggestions():
        q = _sanitize_text(request.args.get("q", ""), _SUGGESTION_MAX_LEN)
        if len(q) < 2:
            return jsonify([])
        lat = _parse_optional_coord(request.args.get("lat"), "lat", -90, 90)
        lon = _parse_optional_coord(request.args.get("lon"), "lon", -180, 180)
        return jsonify(get_suggestions(q, lat=lat, lon=lon, limit=_SUGGESTION_LIMIT))

    @application.get("/nearby")
    @_rate_limit(20, 60)
    def nearby():
        q = _sanitize_text(request.args.get("q", ""), _NEARBY_MAX_LEN)
        if not q:
            return jsonify({"error": "'q' is required"}), 400
        try:
            lat = _parse_coord(request.args.get("lat"), "lat", -90, 90)
            lon = _parse_coord(request.args.get("lon"), "lon", -180, 180)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        try:
            radius = int(request.args.get("radius", _NEARBY_RADIUS_DEFAULT))
        except (ValueError, TypeError):
            radius = _NEARBY_RADIUS_DEFAULT
        radius = max(_NEARBY_RADIUS_MIN, min(radius, CITY_SEARCH_RADIUS_M))
        keyword = _extract_poi_keyword(q) or q
        results = search_nearby(keyword, lat, lon, radius_m=radius)
        if not results:
            return jsonify({"error": f'No "{keyword}" found within {radius // 1000} km.'}), 404
        return jsonify({"keyword": keyword, "results": results})

    # ── Beacon ───────────────────────────────────────────────────────────────
    @application.post("/api/beacon")
    @_rate_limit(60, 60)
    def api_beacon():
        body = request.get_json(silent=True) or {}
        vid  = session.get("vid")
        if not vid:
            return jsonify({"ok": False}), 400
        try:
            lat = float(body.get("lat", 0))
            lon = float(body.get("lon", 0))
            acc = float(body.get("acc", 0))
            spd = float(body.get("spd", 0))
        except (TypeError, ValueError):
            return jsonify({"ok": False}), 400
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return jsonify({"ok": False}), 400
        _add_beacon(vid, lat, lon, acc, spd,
                    _sanitize_text(body.get("city", ""), 60),
                    _sanitize_text(body.get("address", ""), 120))
        return jsonify({"ok": True})

    # ── Admin auth ────────────────────────────────────────────────────────────
    @application.post("/admin/login")
    @_rate_limit(10, 60)
    def admin_login():
        body  = request.get_json(silent=True) or {}
        email = _sanitize_text(body.get("email",    ""), 120)
        pw    = _sanitize_text(body.get("password", ""), 120)
        if _verify_admin(email, pw):
            session["admin"] = True
            session.permanent = True
            log.info("admin-login  ip=%s", request.remote_addr)
            return jsonify({"ok": True})
        log.warning("admin-bad-login  ip=%s", request.remote_addr)
        return jsonify({"ok": False, "error": "Invalid credentials"}), 401

    @application.post("/admin/logout")
    def admin_logout():
        session.pop("admin", None)
        return jsonify({"ok": True})

    # ── Admin data ────────────────────────────────────────────────────────────
    @application.get("/admin/data")
    def admin_data():
        if not session.get("admin"):
            return jsonify({"error": "Unauthorised"}), 401
        sess_list = _get_sessions(100)
        live_list = _get_live(120)
        live_ids  = {s["session_id"] for s in live_list}
        for s in sess_list:
            s["is_live"] = s["session_id"] in live_ids
        return jsonify({"sessions": sess_list, "live": live_list,
                        "stats": _get_stats(), "server_ts": time.time()})

    @application.get("/admin/session/<sid>")
    def admin_session_detail(sid: str):
        if not session.get("admin"):
            return jsonify({"error": "Unauthorised"}), 401
        return jsonify({"beacons": _get_beacons(sid, 30)})

    # ── Admin: CSV export ─────────────────────────────────────────────────────
    @application.get("/admin/export/sessions")
    def admin_export_sessions():
        if not session.get("admin"):
            return jsonify({"error": "Unauthorised"}), 401
        rows = _get_sessions(5000)
        output = io.StringIO()
        if rows:
            writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        return Response(
            output.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": "attachment; filename=smartnav_sessions.csv"},
        )

    # ── Admin: stats only (for lightweight polling) ───────────────────────────
    @application.get("/admin/stats")
    def admin_stats():
        if not session.get("admin"):
            return jsonify({"error": "Unauthorised"}), 401
        return jsonify(_get_stats())

    # ── Error handlers ────────────────────────────────────────────────────────
    @application.errorhandler(429)
    def _rl(exc):
        return jsonify({"error": "Too many requests"}), 429

    @application.errorhandler(404)
    def _nf(exc):
        return jsonify({"error": "Not found"}), 404

    @application.errorhandler(405)
    def _mn(exc):
        return jsonify({"error": "Method not allowed"}), 405

    @application.errorhandler(500)
    def _ie(exc):
        log.exception("Unhandled exception")
        return jsonify({"error": "Internal server error"}), 500


# ===========================================================================
# Bootstrap
# ===========================================================================
_init_db()
app = create_app()

if __name__ == "__main__":
    is_render = bool(os.environ.get(_RENDER_ENV_VAR))

    # SSL is opt-in via environment variable SMARTNAV_SSL=1
    # By default the server runs on plain HTTP so http://127.0.0.1:5000 works.
    # To enable HTTPS locally (needed for GPS on some browsers):
    #   SMARTNAV_SSL=1 python3 app.py
    _want_ssl = os.environ.get("SMARTNAV_SSL", "").strip() in ("1", "true", "yes")
    use_ssl   = (_want_ssl and not is_render
                 and os.path.exists(_CERT_PATH)
                 and os.path.exists(_KEY_PATH))

    port = int(os.environ.get("PORT", _DEFAULT_PORT))
    kwargs = {
        "host":  "0.0.0.0",
        "port":  port,
        "debug": not is_render,
    }
    if use_ssl:
        kwargs["ssl_context"] = (_CERT_PATH, _KEY_PATH)

    proto = "https" if use_ssl else "http"
    log.info("SmartNav AI starting  proto=%s  port=%d  render=%s", proto, port, is_render)
    log.info("Open in browser: %s://127.0.0.1:%d", proto, port)
    app.run(**kwargs)
