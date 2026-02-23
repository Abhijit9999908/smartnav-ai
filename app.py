"""
app.py - SmartNav AI Flask Application
=======================================
Endpoints:
  GET  /                          — Serve the SPA
  POST /route                     — Geocode + fetch + score routes
  POST /route-coords              — Route to known coordinates
  GET  /suggestions?q=&lat=&lon=  — Autocomplete suggestions
  GET  /nearby?q=&lat=&lon=       — POI nearby search
"""

import os
import re
from flask import Flask, render_template, request, jsonify
from flask_talisman import Talisman
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_cors import CORS
from routing_engine import (
    geocode, fetch_routes, get_suggestions,
    search_nearby, _extract_poi_keyword, CITY_SEARCH_RADIUS_M
)
from scoring_engine import score_routes

app = Flask(__name__)

# ── CORS ──────────────────────────────────────────────────────────────────────
CORS(app, resources={r"/*": {"origins": []}})

# ── Rate limiting ──────────────────────────────────────────────────────────────
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["200 per hour", "60 per minute"],
    storage_uri="memory://",
    headers_enabled=True,
)

# ── Security headers via Talisman ─────────────────────────────────────────────
# On Render, HTTPS is terminated at the load-balancer; the app itself runs HTTP.
# force_https=False prevents redirect loops behind the Render proxy.
csp = {
    'default-src': ["'self'"],
    'script-src':  ["'self'", "'unsafe-inline'",
                    "https://unpkg.com", "https://cdn.jsdelivr.net"],
    'style-src':   ["'self'", "'unsafe-inline'",
                    "https://unpkg.com", "https://cdn.jsdelivr.net",
                    "https://fonts.googleapis.com"],
    'font-src':    ["'self'", "https://fonts.gstatic.com",
                    "https://cdn.jsdelivr.net"],
    'img-src':     ["'self'", "data:", "blob:",
                    "https://*.tile.openstreetmap.org",
                    "https://*.basemaps.cartocdn.com",
                    "https://*.openfreemap.org",
                    "https://tile.openfreemap.org",
                    "https://*.maptiler.com",
                    "https://api.maptiler.com"],
    'connect-src': ["'self'",
                    "https://nominatim.openstreetmap.org",
                    "https://overpass-api.de",
                    "http://router.project-osrm.org",
                    "https://router.project-osrm.org",
                    "https://tile.openfreemap.org",
                    "https://*.tile.openstreetmap.org",
                    "https://*.basemaps.cartocdn.com"],
    'worker-src':  ["blob:"],
    'child-src':   ["blob:"],
}

Talisman(
    app,
    force_https=False,               # Render handles HTTPS at the proxy level
    strict_transport_security=False, # Let Render's proxy set HSTS
    content_security_policy=csp,
    permissions_policy={
        "geolocation": "(self)",
        "camera": "()",
        "microphone": "()",
    },
    referrer_policy="strict-origin-when-cross-origin",
    x_content_type_options=True,
    x_xss_protection=True,
)


# ── Input sanitization helpers ────────────────────────────────────────────────

def _sanitize_text(value, max_len=200):
    """Strip control characters and limit length."""
    if not isinstance(value, str):
        return ""
    # Remove control chars (keep printable Unicode + basic whitespace)
    cleaned = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', value)
    return cleaned[:max_len].strip()


def _validate_coord(value, name, lo, hi):
    """Return float coord or raise ValueError with descriptive message."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number.")
    if not (lo <= f <= hi):
        raise ValueError(f"{name} must be between {lo} and {hi}.")
    return f


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/route", methods=["POST"])
@limiter.limit("30 per minute")
def route():
    body = request.get_json(silent=True)
    if not body or not isinstance(body, dict):
        return jsonify({"error": "Request body must be JSON."}), 400

    try:
        start_lat   = _validate_coord(body.get("start_lat"),   "start_lat", -90,   90)
        start_lon   = _validate_coord(body.get("start_lon"),   "start_lon", -180, 180)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    destination = _sanitize_text(body.get("destination", ""), max_len=200)
    if not destination:
        return jsonify({"error": "Destination cannot be empty."}), 400

    dest_coords = geocode(destination, user_lat=start_lat, user_lon=start_lon)
    if not dest_coords:
        return jsonify({
            "error": (
                f'Location not found: "{destination}". '
                'Try a more specific name like "Mumbai, Maharashtra".'
            )
        }), 404

    raw_routes = fetch_routes(
        start_lat, start_lon,
        dest_coords["lat"], dest_coords["lon"]
    )
    if not raw_routes:
        return jsonify({
            "error": "No routes found. Locations may be unreachable by road."
        }), 502

    scored = score_routes(raw_routes)
    return jsonify({"routes": scored, "destination": dest_coords})


@app.route("/route-coords", methods=["POST"])
@limiter.limit("30 per minute")
def route_coords():
    body = request.get_json(silent=True)
    if not body or not isinstance(body, dict):
        return jsonify({"error": "Request body must be JSON."}), 400

    try:
        start_lat = _validate_coord(body.get("start_lat"), "start_lat", -90,   90)
        start_lon = _validate_coord(body.get("start_lon"), "start_lon", -180, 180)
        dest_lat  = _validate_coord(body.get("dest_lat"),  "dest_lat",  -90,   90)
        dest_lon  = _validate_coord(body.get("dest_lon"),  "dest_lon",  -180, 180)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    raw_routes = fetch_routes(start_lat, start_lon, dest_lat, dest_lon)
    if not raw_routes:
        return jsonify({"error": "No routes found. Location may be unreachable by road."}), 502

    scored = score_routes(raw_routes)
    return jsonify({
        "routes":      scored,
        "destination": {"lat": dest_lat, "lon": dest_lon},
    })


@app.route("/suggestions")
@limiter.limit("60 per minute")
def suggestions():
    q = _sanitize_text(request.args.get("q", ""), max_len=100)
    if len(q) < 2:
        return jsonify([])

    try:
        lat = _validate_coord(request.args.get("lat"), "lat", -90,   90)  if request.args.get("lat") else None
        lon = _validate_coord(request.args.get("lon"), "lon", -180, 180) if request.args.get("lon") else None
    except ValueError:
        lat = lon = None

    results = get_suggestions(q, lat=lat, lon=lon, limit=8)
    return jsonify(results)


@app.route("/nearby")
@limiter.limit("20 per minute")
def nearby():
    q = _sanitize_text(request.args.get("q", ""), max_len=100)
    if not q:
        return jsonify({"error": "q parameter required."}), 400

    try:
        lat    = _validate_coord(request.args.get("lat"),    "lat",    -90,   90)
        lon    = _validate_coord(request.args.get("lon"),    "lon",    -180, 180)
        radius = int(request.args.get("radius", 25000))
        if not (100 <= radius <= CITY_SEARCH_RADIUS_M):
            radius = 25000
    except (ValueError, TypeError):
        return jsonify({"error": "lat and lon must be valid numbers."}), 400

    radius  = min(radius, CITY_SEARCH_RADIUS_M)
    keyword = _extract_poi_keyword(q) or q
    results = search_nearby(keyword, lat, lon, radius_m=radius)

    if not results:
        return jsonify({
            "error": f'No "{keyword}" found within {radius//1000}km of your location. '
                     'Try expanding the search area.'
        }), 404

    return jsonify({"keyword": keyword, "results": results})


@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify({"error": "Too many requests. Please slow down."}), 429


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Use PORT env var (set by Render) or fall back to 5000 for local dev.
    port = int(os.environ.get("PORT", 5000))

    # Local dev: use self-signed cert if available; on Render run plain HTTP
    # (Render terminates TLS at its edge and forwards HTTP to the container).
    cert = os.path.join(os.path.dirname(__file__), "certs", "cert.pem")
    key  = os.path.join(os.path.dirname(__file__), "certs", "key.pem")

    if os.path.exists(cert) and os.path.exists(key) and not os.environ.get("RENDER"):
        print(f"  SmartNav AI  →  https://0.0.0.0:{port}  (HTTPS + secure headers)")
        app.run(host="0.0.0.0", port=port, debug=False, ssl_context=(cert, key))
    else:
        print(f"  SmartNav AI  →  http://0.0.0.0:{port}")
        app.run(host="0.0.0.0", port=port, debug=False)
