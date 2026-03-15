"""
app.py — SmartNav AI Flask Application
=======================================
Endpoints:
  GET  /                          — Serve the SPA
  POST /route                     — Geocode + fetch + score routes
  POST /route-coords              — Route between two known coordinates
  GET  /suggestions?q=&lat=&lon=  — Autocomplete place suggestions
  GET  /nearby?q=&lat=&lon=       — POI nearby search
"""

import logging
import os
import re

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_talisman import Talisman

from routing_engine import (
    CITY_SEARCH_RADIUS_M,
    _extract_poi_keyword,
    fetch_routes,
    geocode,
    get_suggestions,
    search_nearby,
)
from scoring_engine import score_routes

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_TEXT_MAX_LEN        = 200    # max chars for destination / query strings
_SUGGESTION_MAX_LEN  = 100    # max chars for autocomplete query
_NEARBY_MAX_LEN      = 100    # max chars for nearby query
_SUGGESTION_LIMIT    = 8      # max autocomplete results returned
_NEARBY_RADIUS_MIN   = 100    # metres — lower bound for ?radius= param
_NEARBY_RADIUS_DEFAULT = 25_000   # metres — default when not supplied

_RENDER_ENV_VAR      = "RENDER"   # set by Render.com at runtime
_DEFAULT_PORT        = 5000
_CERT_PATH           = os.path.join(os.path.dirname(__file__), "certs", "cert.pem")
_KEY_PATH            = os.path.join(os.path.dirname(__file__), "certs",  "key.pem")
_RATE_LIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
_ALLOWED_CORS_ORIGINS = [
    "https://smartnav-ai.onrender.com",
    "http://localhost:5000",
    "https://localhost:5000",
    "http://127.0.0.1:5000",
    "https://127.0.0.1:5000",
]

# ---------------------------------------------------------------------------
# Content-Security-Policy
# ---------------------------------------------------------------------------
_CSP = {
    "default-src": ["'self'"],
    "script-src":  ["'self'",
                    "https://unpkg.com", "https://cdn.jsdelivr.net"],
    "style-src":   ["'self'", "'unsafe-inline'",
                    "https://unpkg.com", "https://cdn.jsdelivr.net",
                    "https://fonts.googleapis.com"],
    "font-src":    ["'self'",
                    "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
    "img-src":     ["'self'", "data:", "blob:",
                    "https://*.tile.openstreetmap.org",
                    "https://*.basemaps.cartocdn.com",
                    "https://*.openfreemap.org",
                    "https://tile.openfreemap.org",
                    "https://*.maptiler.com",
                    "https://api.maptiler.com"],
    "connect-src": ["'self'",
                    "https://tiles.openfreemap.org",
                    "https://routing.openstreetmap.de"],
    "worker-src":  ["blob:"],
    "child-src":   ["blob:"],
}

# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> Flask:
    """
    Create and configure the Flask application.

    Separating construction from the module-level ``app`` object makes the
    app testable via ``create_app()`` without side-effects on import.
    """
    application = Flask(__name__)

    # ── CORS ──────────────────────────────────────────────────────────────
    CORS(application, resources={r"/*": {"origins": _ALLOWED_CORS_ORIGINS}})

    # ── Rate limiting ──────────────────────────────────────────────────────
    limiter = Limiter(
        key_func=get_remote_address,
        app=application,
        default_limits=["200 per hour", "60 per minute"],
        storage_uri=_RATE_LIMIT_STORAGE_URI,
        headers_enabled=True,
    )

    # ── Security headers ───────────────────────────────────────────────────
    # force_https=False: Render terminates TLS at its load-balancer and
    # forwards plain HTTP to the container, so redirecting to HTTPS here
    # would cause a redirect loop.
    Talisman(
        application,
        force_https=False,
        force_https_permanent=False,
        strict_transport_security=False,        # Render sets HSTS at the edge
        content_security_policy=_CSP,
        permissions_policy={
            "geolocation": "(self)",
            "camera":      "()",
            "microphone":  "()",
        },
        referrer_policy="strict-origin-when-cross-origin",
        x_content_type_options=True,
        x_xss_protection=True,
        session_cookie_secure=False,            # no session cookies in use
        session_cookie_http_only=True,
    )

    # ── Register routes ────────────────────────────────────────────────────
    _register_routes(application, limiter)

    return application


# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------

def _sanitize_text(value: object, max_len: int = _TEXT_MAX_LEN) -> str:
    """
    Strip ASCII control characters from *value* and truncate to *max_len*.

    Keeps printable Unicode and normal whitespace (\\t, \\n, \\r, space).
    Returns an empty string for non-string input.
    """
    if not isinstance(value, str):
        return ""
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    return cleaned[:max_len].strip()


def _parse_coord(value: object, name: str,
                 lo: float, hi: float) -> float:
    """
    Parse and range-check a coordinate value.

    Raises ``ValueError`` with a human-readable message on failure so callers
    can surface it directly in a 400 response.
    """
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ValueError(f"'{name}' must be a number.")
    if not (lo <= f <= hi):
        raise ValueError(f"'{name}' must be between {lo} and {hi}, got {value!r}.")
    return f


def _parse_optional_coord(raw: str | None, name: str,
                           lo: float, hi: float) -> float | None:
    """Parse an optional query-string coordinate; return None when absent."""
    if raw is None:
        return None
    try:
        return _parse_coord(raw, name, lo, hi)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def _register_routes(application: Flask, limiter: Limiter) -> None:
    """Attach all URL rules to *application* using the provided *limiter*."""

    # ── SPA ──────────────────────────────────────────────────────────────

    @application.get("/")
    def index():                                    # noqa: ANN202
        return render_template("index.html")

    # ── POST /route ───────────────────────────────────────────────────────

    @application.post("/route")
    @limiter.limit("30 per minute")
    def route():                                    # noqa: ANN202
        body = request.get_json(silent=True)
        if not body or not isinstance(body, dict):
            return jsonify({"error": "Request body must be JSON."}), 400

        try:
            start_lat = _parse_coord(body.get("start_lat"), "start_lat", -90,   90)
            start_lon = _parse_coord(body.get("start_lon"), "start_lon", -180, 180)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        destination = _sanitize_text(body.get("destination", ""))
        if not destination:
            return jsonify({"error": "Destination cannot be empty."}), 400

        dest_coords = geocode(destination, user_lat=start_lat, user_lon=start_lon)
        if not dest_coords:
            return jsonify({
                "error": (
                    f'Location not found: "{destination}". '
                    'Try a more specific name, e.g. "Mumbai, Maharashtra".'
                )
            }), 404

        raw_routes = fetch_routes(
            start_lat, start_lon,
            dest_coords["lat"], dest_coords["lon"],
        )
        if not raw_routes:
            return jsonify({
                "error": "No routes found. Locations may be unreachable by road.",
                "destination": dest_coords,
            }), 502

        log.info("route  '%s' → %.4f,%.4f  (%d route(s))",
                 destination, dest_coords["lat"], dest_coords["lon"],
                 len(raw_routes))

        scored = score_routes(raw_routes)
        return jsonify({"routes": scored, "destination": dest_coords})

    # ── POST /route-coords ────────────────────────────────────────────────

    @application.post("/route-coords")
    @limiter.limit("30 per minute")
    def route_coords():                             # noqa: ANN202
        body = request.get_json(silent=True)
        if not body or not isinstance(body, dict):
            return jsonify({"error": "Request body must be JSON."}), 400

        try:
            start_lat = _parse_coord(body.get("start_lat"), "start_lat", -90,   90)
            start_lon = _parse_coord(body.get("start_lon"), "start_lon", -180, 180)
            dest_lat  = _parse_coord(body.get("dest_lat"),  "dest_lat",  -90,   90)
            dest_lon  = _parse_coord(body.get("dest_lon"),  "dest_lon",  -180, 180)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        raw_routes = fetch_routes(start_lat, start_lon, dest_lat, dest_lon)
        if not raw_routes:
            return jsonify({
                "error": "No routes found. Location may be unreachable by road.",
                "destination": {"lat": dest_lat, "lon": dest_lon},
            }), 502

        log.info("route-coords  (%.4f,%.4f)→(%.4f,%.4f)  (%d route(s))",
                 start_lat, start_lon, dest_lat, dest_lon, len(raw_routes))

        scored = score_routes(raw_routes)
        return jsonify({
            "routes":      scored,
            "destination": {"lat": dest_lat, "lon": dest_lon},
        })

    # ── POST /score-routes ────────────────────────────────────────────────

    @application.post("/score-routes")
    @limiter.limit("60 per minute")
    def score_routes_endpoint():                    # noqa: ANN202
        body = request.get_json(silent=True)
        if not body or not isinstance(body, dict):
            return jsonify({"error": "Request body must be JSON."}), 400

        raw_routes = body.get("routes")
        if not isinstance(raw_routes, list) or not raw_routes:
            return jsonify({"error": "Routes must be a non-empty list."}), 400

        normalised: list[dict] = []
        for idx, route in enumerate(raw_routes[:5]):
            if not isinstance(route, dict):
                return jsonify({"error": f"Route {idx + 1} must be an object."}), 400

            try:
                distance = float(route.get("distance"))
                duration = float(route.get("duration"))
            except (TypeError, ValueError):
                return jsonify({
                    "error": f"Route {idx + 1} must include numeric distance and duration."
                }), 400

            geometry = route.get("geometry")
            if not isinstance(geometry, list):
                return jsonify({"error": f"Route {idx + 1} geometry must be a list."}), 400

            normalised.append({
                "distance": distance,
                "duration": duration,
                "geometry": geometry,
            })

        return jsonify({"routes": score_routes(normalised)})

    # ── GET /suggestions ──────────────────────────────────────────────────

    @application.get("/suggestions")
    @limiter.limit("60 per minute")
    def suggestions():                              # noqa: ANN202
        q = _sanitize_text(request.args.get("q", ""), max_len=_SUGGESTION_MAX_LEN)
        if len(q) < 2:
            return jsonify([])

        lat = _parse_optional_coord(request.args.get("lat"), "lat", -90,   90)
        lon = _parse_optional_coord(request.args.get("lon"), "lon", -180, 180)

        results = get_suggestions(q, lat=lat, lon=lon, limit=_SUGGESTION_LIMIT)
        return jsonify(results)

    # ── GET /nearby ───────────────────────────────────────────────────────

    @application.get("/nearby")
    @limiter.limit("20 per minute")
    def nearby():                                   # noqa: ANN202
        q = _sanitize_text(request.args.get("q", ""), max_len=_NEARBY_MAX_LEN)
        if not q:
            return jsonify({"error": "Query parameter 'q' is required."}), 400

        try:
            lat = _parse_coord(request.args.get("lat"), "lat", -90,   90)
            lon = _parse_coord(request.args.get("lon"), "lon", -180, 180)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            radius = int(request.args.get("radius", _NEARBY_RADIUS_DEFAULT))
        except (ValueError, TypeError):
            radius = _NEARBY_RADIUS_DEFAULT

        # Clamp radius to valid range — never exceed city-search cap
        radius = max(_NEARBY_RADIUS_MIN,
                     min(radius, CITY_SEARCH_RADIUS_M))

        keyword = _extract_poi_keyword(q) or q
        results = search_nearby(keyword, lat, lon, radius_m=radius)

        if not results:
            return jsonify({
                "error": (
                    f'No "{keyword}" found within {radius // 1000} km '
                    "of your location. Try expanding the search area."
                )
            }), 404

        log.info("nearby  '%s'  lat=%.4f lon=%.4f  r=%dm  → %d result(s)",
                 keyword, lat, lon, radius, len(results))

        return jsonify({"keyword": keyword, "results": results})

    # ── Error handlers ────────────────────────────────────────────────────

    @application.errorhandler(429)
    def ratelimit_handler(exc):                     # noqa: ANN001,ANN202
        log.warning("rate-limit hit from %s", request.remote_addr)
        return jsonify({"error": "Too many requests — please slow down."}), 429

    @application.errorhandler(404)
    def not_found_handler(exc):                     # noqa: ANN001,ANN202
        return jsonify({"error": "Endpoint not found."}), 404

    @application.errorhandler(405)
    def method_not_allowed_handler(exc):            # noqa: ANN001,ANN202
        return jsonify({"error": "Method not allowed."}), 405

    @application.errorhandler(500)
    def internal_error_handler(exc):               # noqa: ANN001,ANN202
        log.exception("Unhandled exception")
        return jsonify({"error": "Internal server error."}), 500


# ---------------------------------------------------------------------------
# Module-level app instance  (used by Gunicorn / Render)
# ---------------------------------------------------------------------------
app = create_app()


# ---------------------------------------------------------------------------
# Development entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", _DEFAULT_PORT))
    on_render = bool(os.environ.get(_RENDER_ENV_VAR))

    if (not on_render
            and os.path.exists(_CERT_PATH)
            and os.path.exists(_KEY_PATH)):
        log.info("SmartNav AI  →  https://0.0.0.0:%d  (HTTPS + secure headers)", port)
        app.run(host="0.0.0.0", port=port, debug=False,
                ssl_context=(_CERT_PATH, _KEY_PATH))
    else:
        log.info("SmartNav AI  →  http://0.0.0.0:%d", port)
        app.run(host="0.0.0.0", port=port, debug=False)
