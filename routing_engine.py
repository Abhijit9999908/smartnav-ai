"""
routing_engine.py — SmartNav AI Routing + Geocoding + POI Engine
=================================================================

Geocoding:
  1. Nominatim (India-restricted, city-biased)
  2. Nominatim (India-restricted, global viewbox)
  3. Nominatim (global fallback, India bbox check)
  4. Photon (Komoot) fallback

POI / Nearby search:
  - Overpass API (OpenStreetMap) for amenity/shop/etc near user
  - Returns list of {name, lat, lon, type, address, distance_m, extra}

Route fetching strategy:
  SHORT  (<15 km)  : city — up to 12 via-waypoints, up to 5 unique routes
  MEDIUM (15–80km) : up to 6 via-waypoints, up to 4 unique routes
  LONG   (>80 km)  : up to 4 via-waypoints, up to 3 unique routes

Autocomplete suggestions:
  - Nominatim structured search with India viewbox

NOTE: Nominatim policy requires max 1 request/second and a valid User-Agent.
"""

import logging
import math
import re
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from typing import Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ---------------------------------------------------------------------------
# Logging  (callers configure handlers; we just emit records)
# ---------------------------------------------------------------------------
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------
OSRM_BASE         = "https://router.project-osrm.org/route/v1/driving"
OSRM_NEAREST      = "https://router.project-osrm.org/nearest/v1/driving"
NOMINATIM_BASE    = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"
OVERPASS_BASE     = "https://overpass-api.de/api/interpreter"
PHOTON_BASE       = "https://photon.komoot.io/api"

# ---------------------------------------------------------------------------
# Tuneable constants  (all in one place for easy tweaking)
# ---------------------------------------------------------------------------
CITY_SEARCH_RADIUS_M   = 25_000   # 25 km — POI nearby search radius
CITY_GEOCODE_BOX_DEG   = 0.22     # ±0.22° ≈ ±24 km city bounding box
GEOCODE_CITY_MAX_DIST  = 50_000   # accept city-biased geocode result within 50 km
SNAP_MAX_DIST_M        = 300      # discard road-snap if snapped point is farther
POI_SUPPLEMENT_MIN     = 5        # supplement Overpass with Nominatim if below this
POI_MAX_RESULTS        = 20       # cap on returned POI results
NOMINATIM_NEARBY_LIMIT = 12       # max results from Nominatim nearby fallback

TIMEOUT    = 18   # seconds — Nominatim / Overpass / Photon
TIMEOUT_OV = 22   # seconds — Overpass can be slow

# OSRM-specific timeouts (separate from geocoding — different failure mode)
_SNAP_TIMEOUT        = 2     # seconds — snap is "nice to have"; fail fast, use original
_OSRM_TIMEOUT        = 5     # seconds — per individual routing call
_OSRM_FALLBACK_TIMEOUT = 8   # seconds — one relaxed direct retry before giving up
_OSRM_WORKERS        = 4     # max parallel OSRM threads (>4 triggers 429 on public instance)
_OSRM_SUBMIT_DELAY   = 0.05  # seconds between task submissions to avoid request burst
_OSRM_TOTAL_BUDGET   = 12.0  # seconds — total wall-clock budget for one fetch_routes() call

# India bounding box (lat_min, lat_max, lon_min, lon_max)
INDIA_BBOX    = "6.5,68.0,37.5,97.5"   # Nominatim viewbox format
INDIA_LAT_MIN = 6.5
INDIA_LAT_MAX = 37.5
INDIA_LON_MIN = 68.0
INDIA_LON_MAX = 97.5

# OSM name tags tried in priority order when labelling a POI
_POI_NAME_FIELDS = ("name:en", "name", "brand", "operator")

# OSM detail fields extracted as "extra" info on a POI
_POI_EXTRA_FIELDS = ("cuisine", "opening_hours", "phone", "website",
                     "brand", "operator", "description")

# Phrases that signal a "near me" / POI-style query
_NEAR_PHRASES: frozenset[str] = frozenset({
    "near me", "nearby", "near by", "close to me",
    "around me", "close by", "closest", "nearest",
})

# HTTP headers required by all upstream APIs
_HEADERS = {
    "User-Agent": "SmartNavAI/5.0 (India navigation; academic; contact: student@edu.in)"
}

# ---------------------------------------------------------------------------
# Shared HTTP session  (connection pooling + automatic retry on transient errors)
# ---------------------------------------------------------------------------

def _make_session() -> requests.Session:
    """
    Build a requests.Session with:
    - shared User-Agent header
    - automatic retry (2 attempts) on 429 / 5xx with exponential back-off
    """
    session = requests.Session()
    retry = Retry(
        total=2,
        backoff_factor=0.4,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods={"GET", "POST"},
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://",  adapter)
    session.headers.update(_HEADERS)
    return session


_session = _make_session()

# OSRM session — no retry policy.
# A timed-out or failed routing/snap call is simply skipped; retrying would
# just add latency since we fire many parallel calls and only need a few to
# succeed.  Connection pooling is still active via the shared adapter.
_osrm_session = requests.Session()
_osrm_session.headers.update(_HEADERS)
_osrm_adapter = HTTPAdapter(pool_connections=2, pool_maxsize=_OSRM_WORKERS * 2)
_osrm_session.mount("https://", _osrm_adapter)
_osrm_session.mount("http://",  _osrm_adapter)

# ---------------------------------------------------------------------------
# Lightweight TTL caches (reduce upstream API churn)
# ---------------------------------------------------------------------------

_CACHE_NONE = object()


class _TTLCache:
    def __init__(self, maxsize: int, ttl_s: float) -> None:
        self.maxsize = maxsize
        self.ttl_s = ttl_s
        self._data: OrderedDict[object, tuple[float, object]] = OrderedDict()
        self._lock = Lock()

    def get(self, key: object) -> object | None:
        now = time.monotonic()
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return None
            expires, value = item
            if expires < now:
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    def set(self, key: object, value: object) -> None:
        now = time.monotonic()
        with self._lock:
            self._data[key] = (now + self.ttl_s, value)
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)


def _cache_get(cache: _TTLCache, key: object) -> tuple[bool, object | None]:
    cached = cache.get(key)
    if cached is None:
        return False, None
    if cached is _CACHE_NONE:
        return True, None
    return True, cached


def _cache_set(cache: _TTLCache, key: object, value: object | None) -> None:
    cache.set(key, _CACHE_NONE if value is None else value)


def _cache_return(cache: _TTLCache, key: object, value: object | None) -> object | None:
    _cache_set(cache, key, value)
    return value


def _round_coord(value: Optional[float], places: int = 4) -> Optional[float]:
    if value is None:
        return None
    try:
        return round(float(value), places)
    except (TypeError, ValueError):
        return None


_GEOCODE_CACHE = _TTLCache(maxsize=512, ttl_s=60 * 60)   # 1 hour
_SUGGEST_CACHE = _TTLCache(maxsize=512, ttl_s=10 * 60)  # 10 minutes
_NEARBY_CACHE  = _TTLCache(maxsize=256, ttl_s=5 * 60)   # 5 minutes
_ROUTE_CACHE   = _TTLCache(maxsize=128, ttl_s=2 * 60)   # 2 minutes


# ---------------------------------------------------------------------------
# POI tag map  (keyword → OSM tag tuples)
# ---------------------------------------------------------------------------
POI_TAG_MAP: dict[str, list[tuple[str, str]]] = {
    # ── Food & Drink ─────────────────────────────────────────────
    "restaurant":    [("amenity", "restaurant")],
    "food":          [("amenity", "restaurant"), ("amenity", "fast_food"),
                      ("amenity", "cafe"), ("amenity", "food_court")],
    "cafe":          [("amenity", "cafe"), ("amenity", "coffee_shop")],
    "coffee":        [("amenity", "cafe")],
    "fast food":     [("amenity", "fast_food")],
    "pizza":         [("amenity", "fast_food"), ("amenity", "restaurant")],
    "dhaba":         [("amenity", "restaurant")],
    "bakery":        [("shop", "bakery")],
    "sweet shop":    [("shop", "confectionery"), ("shop", "pastry")],
    "ice cream":     [("amenity", "ice_cream"), ("shop", "ice_cream")],
    "juice":         [("amenity", "juice_bar"), ("shop", "beverages")],
    "bar":           [("amenity", "bar"), ("amenity", "pub")],

    # ── Shopping — General ────────────────────────────────────────
    "shop":          [("shop", "mall"), ("shop", "department_store"),
                      ("shop", "supermarket"), ("shop", "convenience")],
    "mall":          [("shop", "mall"), ("shop", "department_store"),
                      ("leisure", "shopping_centre")],
    "market":        [("amenity", "marketplace"), ("shop", "market")],
    "supermarket":   [("shop", "supermarket")],
    "grocery":       [("shop", "convenience"), ("shop", "grocery"), ("shop", "general")],
    "kirana":        [("shop", "convenience"), ("shop", "grocery")],
    "general store": [("shop", "convenience"), ("shop", "general")],

    # ── Electronics & Mobile ──────────────────────────────────────
    "mobile shop":   [("shop", "mobile_phone")],
    "mobile":        [("shop", "mobile_phone")],
    "phone":         [("shop", "mobile_phone"), ("shop", "telecommunication")],
    "electronics":   [("shop", "electronics"), ("shop", "computer"),
                      ("shop", "mobile_phone")],
    "computer":      [("shop", "computer")],
    "laptop":        [("shop", "computer")],

    # ── Clothes & Fashion ─────────────────────────────────────────
    "clothes":       [("shop", "clothes"), ("shop", "fashion")],
    "fashion":       [("shop", "clothes"), ("shop", "fashion"), ("shop", "boutique")],
    "shoes":         [("shop", "shoes"), ("shop", "footwear")],
    "tailoring":     [("shop", "tailor")],
    "jewellery":     [("shop", "jewelry"), ("shop", "jewellery")],

    # ── Home & Hardware ───────────────────────────────────────────
    "hardware":      [("shop", "hardware"), ("shop", "doityourself")],
    "furniture":     [("shop", "furniture")],
    "household":     [("shop", "household"), ("shop", "houseware")],

    # ── Health & Medical ──────────────────────────────────────────
    "pharmacy":      [("amenity", "pharmacy")],
    "chemist":       [("amenity", "pharmacy"), ("shop", "chemist")],
    "medical":       [("amenity", "pharmacy"), ("amenity", "hospital"),
                      ("amenity", "clinic"), ("amenity", "doctors")],
    "medicine":      [("amenity", "pharmacy"), ("shop", "chemist")],
    "hospital":      [("amenity", "hospital")],
    "clinic":        [("amenity", "clinic"), ("amenity", "doctors")],
    "doctor":        [("amenity", "doctors"), ("amenity", "clinic"),
                      ("amenity", "health_centre")],
    "dentist":       [("amenity", "dentist")],
    "eye":           [("amenity", "optometrist"), ("shop", "optician")],
    "optician":      [("shop", "optician"), ("amenity", "optometrist")],
    "diagnostic":    [("amenity", "clinic"), ("amenity", "laboratory")],
    "lab":           [("amenity", "laboratory"), ("amenity", "clinic")],
    "gym":           [("leisure", "fitness_centre"), ("amenity", "gym"),
                      ("leisure", "sports_centre")],
    "yoga":          [("leisure", "yoga"), ("leisure", "fitness_centre")],

    # ── Banking & Finance ─────────────────────────────────────────
    "bank":          [("amenity", "bank")],
    "atm":           [("amenity", "atm")],
    "sbi":           [("amenity", "bank"), ("brand", "State Bank of India")],

    # ── Education ─────────────────────────────────────────────────
    "school":        [("amenity", "school")],
    "college":       [("amenity", "college"), ("amenity", "university")],
    "coaching":      [("amenity", "college"), ("amenity", "school")],
    "library":       [("amenity", "library")],

    # ── Fuel & Transport ──────────────────────────────────────────
    "petrol":        [("amenity", "fuel")],
    "petrol pump":   [("amenity", "fuel")],
    "fuel":          [("amenity", "fuel")],
    "gas station":   [("amenity", "fuel")],
    "cng":           [("amenity", "fuel")],
    "ev charging":   [("amenity", "charging_station")],
    "charging":      [("amenity", "charging_station")],
    "bus stop":      [("highway", "bus_stop")],
    "bus station":   [("amenity", "bus_station")],
    "metro":         [("railway", "station"), ("railway", "subway_entrance")],
    "railway":       [("railway", "station")],
    "station":       [("railway", "station"), ("amenity", "bus_station")],
    "airport":       [("aeroway", "aerodrome")],
    "parking":       [("amenity", "parking")],
    "auto":          [("amenity", "taxi")],
    "taxi":          [("amenity", "taxi")],
    "cab":           [("amenity", "taxi")],

    # ── Government & Services ─────────────────────────────────────
    "police":           [("amenity", "police")],
    "police station":   [("amenity", "police")],
    "post office":      [("amenity", "post_office")],
    "government":       [("amenity", "townhall"), ("office", "government")],
    "court":            [("amenity", "courthouse")],
    "fire station":     [("amenity", "fire_station")],

    # ── Hotels & Accommodation ────────────────────────────────────
    "hotel":         [("tourism", "hotel"), ("tourism", "guest_house"),
                      ("tourism", "hostel")],
    "lodge":         [("tourism", "guest_house"), ("tourism", "hostel")],
    "dharamshala":   [("tourism", "hostel"), ("tourism", "guest_house")],

    # ── Recreation & Leisure ──────────────────────────────────────
    "park":          [("leisure", "park"), ("leisure", "garden")],
    "garden":        [("leisure", "garden"), ("leisure", "park")],
    "cinema":        [("amenity", "cinema")],
    "theatre":       [("amenity", "theatre")],
    "stadium":       [("leisure", "stadium")],
    "swimming":      [("leisure", "swimming_pool")],
    "sports":        [("leisure", "sports_centre"), ("leisure", "sports_hall")],

    # ── Places of Worship ─────────────────────────────────────────
    "temple":        [("amenity", "place_of_worship"), ("religion", "hindu")],
    "mandir":        [("amenity", "place_of_worship")],
    "mosque":        [("amenity", "place_of_worship"), ("religion", "muslim")],
    "church":        [("amenity", "place_of_worship"), ("religion", "christian")],
    "gurudwara":     [("amenity", "place_of_worship"), ("religion", "sikh")],

    # ── Beauty & Personal Care ────────────────────────────────────
    "salon":         [("shop", "hairdresser"), ("shop", "beauty"), ("shop", "massage")],
    "barber":        [("shop", "hairdresser"), ("shop", "barber")],
    "beauty":        [("shop", "beauty"), ("shop", "cosmetics")],
    "spa":           [("leisure", "spa"), ("shop", "beauty")],

    # ── Miscellaneous ─────────────────────────────────────────────
    "stationery":    [("shop", "stationery"), ("shop", "books")],
    "book":          [("shop", "books"), ("amenity", "library")],
    "toy":           [("shop", "toys")],
    "sports shop":   [("shop", "sports"), ("shop", "outdoor")],
    "laundry":       [("shop", "laundry"), ("amenity", "laundry")],
    "tailor":        [("shop", "tailor")],
    "vehicle repair":[("shop", "car_repair"), ("amenity", "car_repair")],
    "car repair":    [("shop", "car_repair")],
    "bike repair":   [("shop", "bicycle"), ("amenity", "bicycle_repair_station")],
    "photo":         [("shop", "photo"), ("shop", "photography")],
    "print":         [("shop", "copyshop"), ("office", "printing")],
    "courier":       [("amenity", "post_office"), ("office", "courier")],
}

_GEOCODE_PLACE_TYPES: frozenset[str] = frozenset({
    "city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood",
    "neighborhood", "county", "state", "state_district", "district",
    "administrative", "municipality", "locality",
})

_GEOCODE_MAJOR_POI_CLASSES: frozenset[str] = frozenset({
    "amenity", "tourism", "historic", "leisure", "railway", "aeroway",
    "highway", "building", "man_made", "natural", "office",
})


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _clamp(val: float, lo: float, hi: float) -> float:
    """Clamp *val* to [lo, hi]."""
    return max(lo, min(hi, val))


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return great-circle distance in metres between two WGS-84 points."""
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi    = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2)
    return R * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def _in_india(lat: float, lon: float) -> bool:
    """Return True if the coordinate lies within India's bounding box."""
    return (INDIA_LAT_MIN <= lat <= INDIA_LAT_MAX and
            INDIA_LON_MIN <= lon <= INDIA_LON_MAX)


def _snap_to_road(lat: float, lon: float) -> tuple[float, float]:
    """
    Snap a GPS coordinate to the nearest drivable road node via OSRM /nearest.

    Returns the snapped (lat, lon) when the snapped point is ≤ SNAP_MAX_DIST_M
    from the original; otherwise returns the original unchanged.  This is
    critical for GPS fixes that land inside buildings, water bodies, or fields
    where OSRM cannot start/end a route.

    Uses ``_SNAP_TIMEOUT`` (3 s) with **no retries** — the snap is a best-effort
    improvement; if OSRM is slow we keep the original coordinate immediately
    rather than stalling the whole request.
    """
    try:
        url = f"{OSRM_NEAREST}/{lon},{lat}"
        r = _osrm_session.get(url, params={"number": 1}, timeout=_SNAP_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if data.get("code") == "Ok" and data.get("waypoints"):
            snapped_lon, snapped_lat = data["waypoints"][0]["location"]
            dist = _haversine(lat, lon, snapped_lat, snapped_lon)
            if dist <= SNAP_MAX_DIST_M:
                log.debug("snap  (%f,%f) → (%f,%f)  dist=%.0fm",
                          lat, lon, snapped_lat, snapped_lon, dist)
                return snapped_lat, snapped_lon
            log.debug("snap  snapped point %.0fm away — keeping original", dist)
    except Exception as exc:
        log.warning("snap  OSRM nearest failed: %s", exc)
    return lat, lon


# ---------------------------------------------------------------------------
# Reverse geocoding
# ---------------------------------------------------------------------------

def get_city_name(lat: float, lon: float) -> Optional[str]:
    """
    Reverse-geocode to retrieve the city/town name for a coordinate.
    Used to bias forward geocoding results to the user's own city.

    Results are **not** cached here because the user's location can change
    across sessions; callers that need caching should wrap this themselves.
    """
    try:
        r = _session.get(
            NOMINATIM_REVERSE,
            params={
                "lat":          lat,
                "lon":          lon,
                "format":       "json",
                "zoom":         10,   # city-level granularity
                "addressdetails": 1,
            },
            timeout=8,
        )
        r.raise_for_status()
        addr = r.json().get("address", {})
        city = (addr.get("city") or addr.get("town") or
                addr.get("village") or addr.get("county") or
                addr.get("state_district"))
        if city:
            log.debug("city  detected: %s", city)
        return city
    except Exception as exc:
        log.warning("city  reverse geocode failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# POI helpers
# ---------------------------------------------------------------------------

def _extract_poi_keyword(query: str) -> Optional[str]:
    """
    Detect whether *query* is a POI/nearby search such as ``'mobile shop near me'``.

    Returns the cleaned keyword (e.g. ``'mobile shop'``) on a match, or
    ``None`` if the query looks like an ordinary place name.
    """
    q = query.lower().strip()
    if not any(phrase in q for phrase in _NEAR_PHRASES):
        return None

    # Strip all near-me variants to isolate the keyword
    for phrase in _NEAR_PHRASES:
        q = q.replace(phrase, "")
    q = q.strip().rstrip(",").strip()

    if not q:
        return None

    # Exact match first, then partial
    if q in POI_TAG_MAP:
        return q
    for key in POI_TAG_MAP:
        if key in q or q in key:
            return key

    # Return cleaned query as a generic search term
    return q


def _normalize_search_text(value: str) -> str:
    """
    Lower-case and collapse a free-form place string to comparable ASCII words.
    """
    cleaned = re.sub(r"[^0-9a-z]+", " ", value.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _primary_geocode_label(item: dict) -> str:
    """
    Return the leading human-readable label from a geocoder candidate.
    """
    display_name = str(item.get("display_name", "")).strip()
    if not display_name:
        return ""
    return display_name.split(",")[0].strip()


def _looks_generic_destination(query: str) -> bool:
    """
    Return ``True`` for broad local intent such as ``hospital`` or ``market``.

    Those searches should prefer nearby candidates, while named destinations
    like ``Mumbai`` or ``Mysore Palace`` should prefer exact place matches.
    """
    q = _normalize_search_text(query)
    if not q:
        return False

    if q in POI_TAG_MAP:
        return True

    if len(q.split()) > 3:
        return False

    for key in POI_TAG_MAP:
        key_norm = _normalize_search_text(key)
        if q == key_norm or q in key_norm or key_norm in q:
            return True

    return False


def _score_geocode_candidate(query: str,
                             item: dict,
                             user_lat: Optional[float] = None,
                             user_lon: Optional[float] = None) -> float:
    """
    Score a geocoder candidate for *query*.

    The scorer heavily rewards exact label matches and proper place/admin
    results, while penalising unrelated nearby shops that merely contain the
    query text (e.g. ``Royal Mumbai Jewellery`` for ``Mumbai``).
    """
    query_norm = _normalize_search_text(query)
    label = _primary_geocode_label(item)
    label_norm = _normalize_search_text(label)
    display_norm = _normalize_search_text(str(item.get("display_name", "")))
    query_tokens = [token for token in query_norm.split() if token]
    label_tokens = set(label_norm.split())
    display_tokens = set(display_norm.split())

    geocode_type = str(item.get("type") or item.get("addresstype") or "").lower()
    geocode_class = str(item.get("class") or item.get("category") or "").lower()
    addresstype = str(item.get("addresstype") or "").lower()
    generic_query = _looks_generic_destination(query)

    score = 0.0

    if label_norm == query_norm:
        score += 220
    elif label_norm.startswith(query_norm) or query_norm.startswith(label_norm):
        score += 130
    elif query_norm and query_norm in label_norm:
        score += 70

    shared_label_tokens = sum(1 for token in query_tokens if token in label_tokens)
    if shared_label_tokens:
        score += shared_label_tokens * 22
        if shared_label_tokens == len(query_tokens):
            score += 30
    elif query_tokens:
        shared_display_tokens = sum(1 for token in query_tokens if token in display_tokens)
        score += shared_display_tokens * 8

    if geocode_type in _GEOCODE_PLACE_TYPES or addresstype in _GEOCODE_PLACE_TYPES:
        score += 90 if not generic_query else 45
    elif geocode_class == "place":
        score += 75 if not generic_query else 36
    elif geocode_class in _GEOCODE_MAJOR_POI_CLASSES:
        score += 55

    if geocode_class == "shop" and label_norm != query_norm:
        score -= 120
    elif geocode_class == "shop":
        score -= 35

    if geocode_class in {"office", "craft"} and label_norm != query_norm:
        score -= 40

    if user_lat is not None and user_lon is not None:
        try:
            dist_m = _haversine(
                user_lat, user_lon,
                float(item["lat"]), float(item["lon"]),
            )
        except (KeyError, TypeError, ValueError):
            dist_m = None

        if dist_m is not None:
            if generic_query:
                if dist_m <= 2_000:
                    score += 70
                elif dist_m <= 10_000:
                    score += 40
                elif dist_m <= GEOCODE_CITY_MAX_DIST:
                    score += 18
            else:
                if dist_m <= 10_000:
                    score += 12
                elif dist_m <= GEOCODE_CITY_MAX_DIST:
                    score += 5

    return score


def _choose_best_geocode_candidate(query: str,
                                   items: list[dict],
                                   user_lat: Optional[float] = None,
                                   user_lon: Optional[float] = None,
                                   max_dist_m: Optional[float] = None,
                                   min_score: Optional[float] = None) -> Optional[dict]:
    """
    Pick the highest-confidence candidate for *query* from *items*.
    """
    best_item: Optional[dict] = None
    best_rank: tuple[float, float] | None = None

    for item in items:
        try:
            lat = float(item["lat"])
            lon = float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue

        dist_m: Optional[float] = None
        if user_lat is not None and user_lon is not None:
            dist_m = _haversine(user_lat, user_lon, lat, lon)
            if max_dist_m is not None and dist_m > max_dist_m:
                continue

        score = _score_geocode_candidate(query, item, user_lat=user_lat, user_lon=user_lon)
        if min_score is not None and score < min_score:
            continue

        rank = (score, -(dist_m if dist_m is not None else float("inf")))
        if best_rank is None or rank > best_rank:
            best_rank = rank
            best_item = item

    return best_item


def _build_overpass_query(tags: list[tuple[str, str]],
                          lat: float, lon: float,
                          radius_m: int) -> str:
    """
    Build an Overpass QL query that finds nodes/ways/relations matching *tags*
    within *radius_m* metres of (*lat*, *lon*).

    ``religion`` tags are skipped as standalone predicates — they only make
    sense as filters within a combined ``place_of_worship`` query and would
    return no results alone.
    """
    parts: list[str] = []
    for tag_key, tag_val in tags:
        if tag_key == "religion":
            continue
        for element in ("node", "way", "relation"):
            if tag_val == "*":
                parts.append(
                    f'{element}["{tag_key}"](around:{radius_m},{lat},{lon});'
                )
            else:
                parts.append(
                    f'{element}["{tag_key}"="{tag_val}"]'
                    f"(around:{radius_m},{lat},{lon});"
                )
    union = "\n  ".join(parts)
    return f"[out:json][timeout:25];\n(\n  {union}\n);\nout center tags 30;"


# ---------------------------------------------------------------------------
# POI / Nearby search
# ---------------------------------------------------------------------------

def search_nearby(keyword: str, lat: float, lon: float,
                  radius_m: int = 5000) -> list[dict]:
    """
    Find points of interest near (*lat*, *lon*) that match *keyword*.

    Strategy:
    1. Look up OSM tags in ``POI_TAG_MAP`` (exact, then partial).
    2. Query Overpass API with those tags.
    3. If Overpass yields < ``POI_SUPPLEMENT_MIN`` results, supplement with
       a Nominatim bounding-box search.
    4. Fall back to Nominatim entirely if Overpass fails.

    Returns up to ``POI_MAX_RESULTS`` dicts sorted by distance:
    ``{name, lat, lon, type, address, distance_m, extra}``.
    """
    if not keyword or not keyword.strip():
        return []

    cache_key = (
        keyword.strip().lower(),
        _round_coord(lat, 4),
        _round_coord(lon, 4),
        int(radius_m),
    )
    hit, cached = _cache_get(_NEARBY_CACHE, cache_key)
    if hit:
        return cached or []

    kw = keyword.lower().strip()
    tags = POI_TAG_MAP.get(kw)

    # Partial keyword match
    if not tags:
        for key, val in POI_TAG_MAP.items():
            if key in kw or kw in key:
                tags = val
                break

    if not tags:
        result = _nominatim_nearby(keyword, lat, lon, radius_m)
        _cache_set(_NEARBY_CACHE, cache_key, result)
        return result

    query = _build_overpass_query(tags, lat, lon, radius_m)

    try:
        r = _session.post(
            OVERPASS_BASE,
            data={"data": query},
            timeout=TIMEOUT_OV,
        )
        r.raise_for_status()
        elements = r.json().get("elements", [])

        results: list[dict] = []
        seen: set[str] = set()

        for el in elements:
            el_tags = el.get("tags", {})

            name = next(
                (el_tags.get(f) for f in _POI_NAME_FIELDS if el_tags.get(f)),
                None,
            )
            if not name:
                continue

            name = name.strip()
            name_key = name.lower()
            if name_key in seen:
                continue
            seen.add(name_key)

            # Coordinates — nodes have lat/lon directly; ways/relations use center
            if el["type"] == "node":
                elat, elon = el.get("lat"), el.get("lon")
            elif el["type"] in ("way", "relation") and "center" in el:
                elat = el["center"]["lat"]
                elon = el["center"]["lon"]
            else:
                continue

            if elat is None or elon is None:
                continue

            dist = _haversine(lat, lon, elat, elon)

            addr_parts = [
                el_tags[f]
                for f in ("addr:housenumber", "addr:street",
                          "addr:suburb", "addr:city", "addr:state")
                if el_tags.get(f)
            ]
            address = ", ".join(addr_parts) or None

            poi_type = next(
                (el_tags.get(k)
                 for k in ("amenity", "shop", "tourism", "leisure",
                           "highway", "railway", "office")
                 if el_tags.get(k)),
                keyword,
            )

            extra = {
                field: el_tags[field][:120]
                for field in _POI_EXTRA_FIELDS
                if el_tags.get(field)
            }

            results.append({
                "name":       name,
                "lat":        round(float(elat), 6),
                "lon":        round(float(elon), 6),
                "type":       poi_type,
                "address":    address,
                "distance_m": round(dist),
                "extra":      extra or None,
            })

        results.sort(key=lambda x: x["distance_m"])
        log.debug("search_nearby  Overpass found %d result(s) for '%s'",
                  len(results), keyword)

        # Supplement with Nominatim if Overpass returned too few hits
        if len(results) < POI_SUPPLEMENT_MIN:
            nom_results = _nominatim_nearby(keyword, lat, lon, radius_m)
            existing_names = {r["name"].lower() for r in results}
            for item in nom_results:
                if item["name"].lower() not in existing_names:
                    results.append(item)
                    existing_names.add(item["name"].lower())
            results.sort(key=lambda x: x["distance_m"])

        final = results[:POI_MAX_RESULTS]
        _cache_set(_NEARBY_CACHE, cache_key, final)
        return final

    except Exception as exc:
        log.warning("search_nearby  Overpass failed: %s — falling back to Nominatim", exc)
        final = _nominatim_nearby(keyword, lat, lon, radius_m)
        _cache_set(_NEARBY_CACHE, cache_key, final)
        return final


def _nominatim_nearby(keyword: str, lat: float, lon: float,
                      radius_m: int) -> list[dict]:
    """
    Fallback nearby POI search via Nominatim bounded viewbox.
    Degree offset is a rough conversion: radius_m / 111_000 ≈ degrees.
    """
    deg_offset = max(radius_m / 111_000, 0.05)
    try:
        r = _session.get(
            NOMINATIM_BASE,
            params={
                "q":            keyword,
                "format":       "json",
                "limit":        NOMINATIM_NEARBY_LIMIT,
                "countrycodes": "in",
                "viewbox": (f"{lon - deg_offset},{lat + deg_offset},"
                            f"{lon + deg_offset},{lat - deg_offset}"),
                "bounded":      1,
                "addressdetails": 1,
            },
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        results = [
            {
                "name":       item.get("display_name", "").split(",")[0].strip(),
                "lat":        round(float(item["lat"]), 6),
                "lon":        round(float(item["lon"]), 6),
                "type":       item.get("type", "place"),
                "address":    item.get("display_name"),
                "distance_m": round(_haversine(lat, lon,
                                               float(item["lat"]),
                                               float(item["lon"]))),
                "extra":      None,
            }
            for item in r.json()
        ]
        results.sort(key=lambda x: x["distance_m"])
        return results[:NOMINATIM_NEARBY_LIMIT]
    except Exception as exc:
        log.warning("_nominatim_nearby  failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Autocomplete suggestions
# ---------------------------------------------------------------------------

def get_suggestions(query: str,
                    lat: Optional[float] = None,
                    lon: Optional[float] = None,
                    limit: int = 8) -> list[dict]:
    """
    Return autocomplete suggestions for the search bar.

    Combines Nominatim place results with POI keyword hints when the query
    looks like a "near me"-style search.  Returns up to *limit* items.
    """
    if not query or len(query.strip()) < 2:
        return []

    cache_key = (
        query.strip().lower(),
        _round_coord(lat, 3),
        _round_coord(lon, 3),
        int(limit),
    )
    hit, cached = _cache_get(_SUGGEST_CACHE, cache_key)
    if hit:
        return cached or []

    results: list[dict] = []
    seen: set[str] = set()

    # POI keyword suggestions
    kw = _extract_poi_keyword(query)
    if kw:
        base = query.lower()
        for phrase in _NEAR_PHRASES:
            base = base.replace(phrase, "")
        base = base.strip()

        for key in POI_TAG_MAP:
            if key.startswith(base):
                for suffix in (" near me", " nearby"):
                    label = f"{key.title()}{suffix}"
                    if label not in seen:
                        seen.add(label)
                        results.append({
                            "label": label,
                            "type":  "poi",
                            "query": label.lower(),
                        })

        for suffix in (" near me", " nearby"):
            label = base + suffix
            if label and label not in seen:
                seen.add(label)
                results.append({
                    "label": label.title(),
                    "type":  "poi",
                    "query": label,
                })

    # Nominatim place suggestions
    try:
        params: dict = {
            "q":              query,
            "format":         "json",
            "limit":          limit,
            "countrycodes":   "in",
            "addressdetails": 1,
        }
        # Soft bias toward user location (bounded=0 so we still search beyond)
        if lat is not None and lon is not None:
            params["viewbox"] = f"{lon - 2},{lat + 2},{lon + 2},{lat - 2}"
            params["bounded"] = 0

        r = _session.get(NOMINATIM_BASE, params=params, timeout=10)
        r.raise_for_status()

        sorted_items = sorted(
            r.json(),
            key=lambda item: _score_geocode_candidate(query, item, user_lat=lat, user_lon=lon),
            reverse=True,
        )

        for item in sorted_items:
            display = item.get("display_name", "")
            parts   = [p.strip() for p in display.split(",")]
            short   = parts[0]
            sublabel = ", ".join(parts[1:4]) if len(parts) > 1 else ""
            key     = short.lower()
            if key not in seen:
                seen.add(key)
                results.append({
                    "label":    short,
                    "sublabel": sublabel,
                    "type":     item.get("type", "place"),
                    "lat":      float(item["lat"]),
                    "lon":      float(item["lon"]),
                    "query":    short,
                })
    except Exception as exc:
        log.warning("get_suggestions  Nominatim failed: %s", exc)

    final = results[:limit]
    _cache_set(_SUGGEST_CACHE, cache_key, final)
    return final


# ---------------------------------------------------------------------------
# Geocoding
# ---------------------------------------------------------------------------

def geocode(place_name: str,
            user_lat: Optional[float] = None,
            user_lon: Optional[float] = None) -> Optional[dict]:
    """
    Convert a place name to ``{"lat": float, "lon": float}``.

    Resolution order:
    1. **City-biased Nominatim** — tight viewbox around the user's location
       (bounded=1, then bounded=0), accepting results within
       ``GEOCODE_CITY_MAX_DIST`` metres of the user.
    2. **Nominatim India** — India-restricted search with no viewbox.
    3. **Nominatim global** — global search; result accepted only if inside
       India's bounding box.
    4. **Photon (Komoot)** — last resort; result accepted only if in India.

    Returns ``None`` if every strategy fails.
    """
    if not place_name or not place_name.strip():
        log.warning("geocode  called with empty place_name")
        return None

    cache_key = (
        place_name.strip().lower(),
        _round_coord(user_lat, 4),
        _round_coord(user_lon, 4),
    )
    hit, cached = _cache_get(_GEOCODE_CACHE, cache_key)
    if hit:
        return cached

    generic_query = _looks_generic_destination(place_name)

    # 1. City-biased search (strict viewbox first, then relaxed)
    if user_lat is not None and user_lon is not None:
        box = CITY_GEOCODE_BOX_DEG
        viewbox = (f"{user_lon - box},{user_lat + box},"
                   f"{user_lon + box},{user_lat - box}")
        for bounded in (1, 0):
            try:
                r = _session.get(
                    NOMINATIM_BASE,
                    params={
                        "q":              place_name,
                        "format":         "json",
                        "limit":          5,
                        "countrycodes":   "in",
                        "viewbox":        viewbox,
                        "bounded":        bounded,
                        "addressdetails": 1,
                    },
                    timeout=TIMEOUT,
                )
                r.raise_for_status()
                data = r.json()
                if data:
                    candidate = _choose_best_geocode_candidate(
                        place_name,
                        data,
                        user_lat=user_lat,
                        user_lon=user_lon,
                        max_dist_m=GEOCODE_CITY_MAX_DIST,
                        min_score=30 if generic_query else 110,
                    )
                    if candidate:
                        rlat = float(candidate["lat"])
                        rlon = float(candidate["lon"])
                        dist = _haversine(user_lat, user_lon, rlat, rlon)
                        log.debug("geocode  '%s' city-biased (bounded=%d): "
                                  "%.4f,%.4f  dist=%.1fkm",
                                  place_name, bounded, rlat, rlon, dist / 1000)
                        return _cache_return(
                            _GEOCODE_CACHE,
                            cache_key,
                            {"lat": rlat, "lon": rlon},
                        )
            except Exception as exc:
                log.warning("geocode  city-biased search failed: %s", exc)

    # 2. Nominatim India-restricted
    try:
        r = _session.get(
            NOMINATIM_BASE,
            params={
                "q":              place_name,
                "format":         "json",
                "limit":          5,
                "countrycodes":   "in",
                "viewbox":        INDIA_BBOX,
                "bounded":        0,
                "addressdetails": 1,
            },
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if data:
            candidate = _choose_best_geocode_candidate(
                place_name,
                data,
                user_lat=user_lat,
                user_lon=user_lon,
                min_score=20 if generic_query else 60,
            )
            if candidate:
                log.debug("geocode  '%s' via Nominatim-India: %s, %s",
                          place_name, candidate["lat"], candidate["lon"])
                return _cache_return(
                    _GEOCODE_CACHE,
                    cache_key,
                    {"lat": float(candidate["lat"]), "lon": float(candidate["lon"])},
                )
    except Exception as exc:
        log.warning("geocode  Nominatim-India failed: %s", exc)

    # 3. Nominatim global (India bbox guard)
    try:
        r = _session.get(
            NOMINATIM_BASE,
            params={
                "q": place_name,
                "format": "json",
                "limit": 5,
                "addressdetails": 1,
            },
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if data:
            india_candidates = []
            for item in data:
                try:
                    rlat = float(item["lat"])
                    rlon = float(item["lon"])
                except (KeyError, TypeError, ValueError):
                    continue
                if _in_india(rlat, rlon):
                    india_candidates.append(item)
            candidate = _choose_best_geocode_candidate(
                place_name,
                india_candidates,
                user_lat=user_lat,
                user_lon=user_lon,
                min_score=20 if generic_query else 60,
            )
            if candidate:
                log.debug("geocode  '%s' via Nominatim-global", place_name)
                return _cache_return(
                    _GEOCODE_CACHE,
                    cache_key,
                    {"lat": float(candidate["lat"]), "lon": float(candidate["lon"])},
                )
            log.debug("geocode  Nominatim-global results outside India or low-confidence")
    except Exception as exc:
        log.warning("geocode  Nominatim-global failed: %s", exc)

    # 4. Photon (Komoot) — final fallback
    try:
        r = _session.get(
            PHOTON_BASE,
            params={"q": place_name, "limit": 3, "lang": "en"},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        photon_candidates: list[dict] = []
        for feature in r.json().get("features", []):
            rlon, rlat = feature["geometry"]["coordinates"]
            if not _in_india(float(rlat), float(rlon)):
                continue

            props = feature.get("properties", {})
            label_parts = [
                props.get("name"),
                props.get("city"),
                props.get("state"),
                props.get("country"),
            ]
            photon_candidates.append({
                "display_name": ", ".join(part for part in label_parts if part),
                "type": props.get("osm_value") or props.get("type"),
                "class": props.get("osm_key"),
                "lat": float(rlat),
                "lon": float(rlon),
            })

        candidate = _choose_best_geocode_candidate(
            place_name,
            photon_candidates,
            user_lat=user_lat,
            user_lon=user_lon,
            min_score=20 if generic_query else 50,
        )
        if candidate:
            log.debug("geocode  '%s' via Photon", place_name)
            return _cache_return(
                _GEOCODE_CACHE,
                cache_key,
                {"lat": float(candidate["lat"]), "lon": float(candidate["lon"])},
            )
    except Exception as exc:
        log.warning("geocode  Photon failed: %s", exc)

    log.error("geocode  FAILED for '%s'", place_name)
    return _cache_return(_GEOCODE_CACHE, cache_key, None)


# ---------------------------------------------------------------------------
# OSRM helper
# ---------------------------------------------------------------------------

def _osrm_request(start_lat: float, start_lon: float,
                  end_lat: float, end_lon: float,
                  via_lat: Optional[float] = None,
                  via_lon: Optional[float] = None,
                  alternatives: int = 3,
                  timeout_s: Optional[float] = None) -> list[dict]:
    """
    Make a single OSRM routing request, optionally via one waypoint.

    Returns a list of raw route dicts:
    ``{"distance": float, "duration": float, "geometry": [[lon, lat], ...]}``.
    An empty list is returned on any failure.
    """
    if via_lat is not None and via_lon is not None:
        via_lat = _clamp(via_lat, INDIA_LAT_MIN, INDIA_LAT_MAX)
        via_lon = _clamp(via_lon, INDIA_LON_MIN, INDIA_LON_MAX)
        coord_str = (f"{start_lon},{start_lat};"
                     f"{via_lon},{via_lat};"
                     f"{end_lon},{end_lat}")
    else:
        coord_str = f"{start_lon},{start_lat};{end_lon},{end_lat}"

    url = f"{OSRM_BASE}/{coord_str}"
    params = {
        "overview":     "full",
        "alternatives": str(alternatives),
        "geometries":   "geojson",
        "steps":        "false",
    }

    try:
        r = _osrm_session.get(url, params=params, timeout=timeout_s or _OSRM_TIMEOUT)
        r.raise_for_status()
        data = r.json()

        if data.get("code") != "Ok":
            log.warning("OSRM  error code: %s", data.get("code"))
            return []

        routes = []
        for route in data.get("routes", []):
            geom   = route.get("geometry", {})
            coords = geom.get("coordinates", []) if isinstance(geom, dict) else []
            if not coords:
                continue
            routes.append({
                "distance": float(route.get("distance", 0)),
                "duration": float(route.get("duration", 0)),
                "geometry": coords,
            })
        return routes

    except Exception as exc:
        log.warning("OSRM  request failed: %s", exc)
        return []


def _recover_direct_route(start_lat: float, start_lon: float,
                          end_lat: float, end_lon: float,
                          orig_start_lat: float, orig_start_lon: float,
                          orig_end_lat: float, orig_end_lon: float) -> list[dict]:
    """
    Retry the direct route once with a longer timeout, then once with the
    original unsnapped endpoints if they differ.
    """
    attempts = [
        ("snapped", start_lat, start_lon, end_lat, end_lon),
        ("raw", orig_start_lat, orig_start_lon, orig_end_lat, orig_end_lon),
    ]
    seen: set[tuple[float, float, float, float]] = set()

    for label, s_lat, s_lon, e_lat, e_lon in attempts:
        key = (
            round(s_lat, 6), round(s_lon, 6),
            round(e_lat, 6), round(e_lon, 6),
        )
        if key in seen:
            continue
        seen.add(key)

        routes = _osrm_request(
            s_lat, s_lon, e_lat, e_lon,
            alternatives=1,
            timeout_s=_OSRM_FALLBACK_TIMEOUT,
        )
        if routes:
            log.info("fetch_routes  recovered route via %s direct fallback", label)
            return routes

    return []


# ---------------------------------------------------------------------------
# Via-waypoint generation
# ---------------------------------------------------------------------------

def _via_points(start_lat: float, start_lon: float,
                end_lat: float, end_lon: float,
                dist_km: float) -> list[tuple[float, float]]:
    """
    Generate candidate via-waypoints for corridor exploration.

    All offsets are proportional to the actual straight-line trip distance so
    that very short routes (e.g. 500 m) get tight local alternatives rather
    than kilometre-wide detours.

    Returns a list of (lat, lon) tuples.
    """
    mid_lat = (start_lat + end_lat) / 2.0
    mid_lon = (start_lon + end_lon) / 2.0

    dlat    = end_lat - start_lat
    dlon    = end_lon - start_lon
    seg_len = math.sqrt(dlat ** 2 + dlon ** 2) or 1e-9

    # Unit perpendicular and parallel vectors in lat/lon space
    perp_lat =  -dlon / seg_len
    perp_lon =   dlat / seg_len
    para_lat =   dlat / seg_len
    para_lon =   dlon / seg_len

    via: list[tuple[float, float]] = []

    if dist_km < 2:
        # ── Very short (<2 km): micro offsets for street-level alternatives ──
        for perp_f in (0.12, 0.20, -0.12, -0.20):
            off = seg_len * perp_f
            via.append((mid_lat + perp_lat * off,
                         mid_lon + perp_lon * off))

        for para_f in (0.30, -0.30):
            for perp_f in (0.10, -0.10):
                via.append((
                    mid_lat + para_lat * seg_len * para_f
                            + perp_lat * seg_len * perp_f,
                    mid_lon + para_lon * seg_len * para_f
                            + perp_lon * seg_len * perp_f,
                ))

        for frac in (0.25, 0.75):
            q_lat = start_lat + dlat * frac
            q_lon = start_lon + dlon * frac
            for perp_f in (0.15, -0.15):
                off = seg_len * perp_f
                via.append((q_lat + perp_lat * off,
                             q_lon + perp_lon * off))

    elif dist_km < 15:
        # ── City (2–15 km): radial sampling at 3 rings × 8 compass bearings ──
        cos_lat = math.cos(math.radians(mid_lat)) or 1.0
        ring_factors = (0.12, 0.22, 0.35)
        angles_deg   = range(0, 360, 45)

        for ring_f in ring_factors:
            off = seg_len * ring_f
            for deg in angles_deg:
                rad  = math.radians(deg)
                via.append((
                    mid_lat + off * math.cos(rad),
                    mid_lon + off * math.sin(rad) / cos_lat,
                ))

    elif dist_km < 80:
        # ── Medium (15–80 km): perpendicular both sides + shifted quarter-points ──
        for perp_f in (0.15, 0.25, -0.15, -0.25):
            off = seg_len * perp_f
            via.append((mid_lat + perp_lat * off,
                         mid_lon + perp_lon * off))

        for frac in (0.25, 0.75):
            q_lat = start_lat + dlat * frac
            q_lon = start_lon + dlon * frac
            for perp_f in (0.12, -0.12):
                off = seg_len * perp_f
                via.append((q_lat + perp_lat * off,
                             q_lon + perp_lon * off))

    else:
        # ── Long (>80 km): perpendicular + forward/backward para bias ──
        for perp_f in (0.18, 0.30, -0.18, -0.30):
            off = seg_len * perp_f
            via.append((mid_lat + perp_lat * off,
                         mid_lon + perp_lon * off))

        for bias in (0.25, -0.25):
            via.append((
                mid_lat + para_lat * seg_len * bias
                        + perp_lat * seg_len * 0.15,
                mid_lon + para_lon * seg_len * bias
                        + perp_lon * seg_len * 0.15,
            ))

    return via


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def _is_duplicate(route: dict, accepted: list[dict],
                  dist_thr: float = 0.04,
                  geom_thr: float = 0.08,
                  dur_thr:  float = 0.04) -> bool:
    """
    Return ``True`` if *route* is too similar to any route in *accepted*.

    Similarity is judged by three relative thresholds (distance, duration,
    geometry point count) *plus* an absolute distance floor for short trips:
    two 800 m routes that differ by 80 m are on different streets and both
    deserve to be shown.
    """
    d    = route["distance"]
    dur  = route["duration"]
    npts = len(route.get("geometry", []))

    for u in accepted:
        ud    = u["distance"]
        udur  = u["duration"]
        upts  = len(u.get("geometry", []))

        rel_dist = abs(ud - d)    / max(ud,   1.0)
        rel_dur  = abs(udur - dur) / max(udur, 1.0)
        rel_geom = abs(upts - npts) / max(upts, 1.0)
        abs_dist_diff = abs(ud - d)

        if d < 3000 or ud < 3000:
            # Short route: require at least 120 m OR 6 % difference
            if abs_dist_diff < 120 and rel_dur < 0.06 and rel_geom < 0.10:
                return True
        else:
            if rel_dist < dist_thr and rel_dur < dur_thr and rel_geom < geom_thr:
                return True

    return False


def _dedupe_and_sort_routes(routes: list[dict]) -> list[dict]:
    """
    Return routes sorted by duration after removing near-duplicates.

    Keeping this logic in one helper lets ``fetch_routes()`` re-check the
    collected pool after each small batch of OSRM calls and stop early once
    enough distinct routes are available.
    """
    unique: list[dict] = []
    for route in routes:
        if not _is_duplicate(route, unique):
            unique.append(route)
    unique.sort(key=lambda r: r["duration"])
    return unique


# ---------------------------------------------------------------------------
# Main routing entry point
# ---------------------------------------------------------------------------

def fetch_routes(start_lat: float, start_lon: float,
                 end_lat: float, end_lon: float,
                 max_routes: int = 5) -> list[dict]:
    """
    Fetch up to *max_routes* distinct driving routes between two points.

    Steps:
    1. Snap both endpoints to the nearest drivable road node **in parallel**.
    2. Run the direct OSRM call first (no via-waypoint) synchronously.
    3. If that fast direct call fails, retry one relaxed direct request with a
       longer timeout and then once more with the original unsnapped endpoints.
    4. Only after at least one direct route is recovered, fan out via-waypoint
       calls in short batches to look for distinct alternatives.
    5. Deduplicate the collected pool and return the fastest ``cap`` routes.

    Route cap by distance:
    - < 15 km → max 5 routes
    - 15–80 km → max 4 routes
    - > 80 km → max 3 routes
    """
    if not all(math.isfinite(v) for v in (start_lat, start_lon, end_lat, end_lon)):
        log.error("fetch_routes  non-finite coordinates supplied")
        return []

    orig_start_lat, orig_start_lon = start_lat, start_lon
    orig_end_lat, orig_end_lon = end_lat, end_lon

    # ── Step 1: Snap both endpoints in parallel ───────────────────────────
    with ThreadPoolExecutor(max_workers=2) as snap_pool:
        f_start = snap_pool.submit(_snap_to_road, start_lat, start_lon)
        f_end   = snap_pool.submit(_snap_to_road, end_lat,   end_lon)
        start_lat, start_lon = f_start.result()
        end_lat,   end_lon   = f_end.result()

    dist_km = math.sqrt((end_lat - start_lat) ** 2 +
                        (end_lon - start_lon) ** 2) * 111.0
    deadline = time.monotonic() + _OSRM_TOTAL_BUDGET

    log.debug("fetch_routes  estimated distance: %.1f km", dist_km)

    if dist_km < 15:
        cap = min(max_routes, 5)
    elif dist_km < 80:
        cap = min(max_routes, 4)
    else:
        cap = min(max_routes, 3)

    # ── Step 2: Direct call first — guaranteed baseline ───────────────────
    # Running this synchronously before the parallel batch means we always
    # have at least the direct result even if all via-waypoint calls are
    # rate-limited or timed out.
    all_routes: list[dict] = _osrm_request(
        start_lat, start_lon, end_lat, end_lon, alternatives=3
    )
    if not all_routes and time.monotonic() < deadline:
        log.warning("fetch_routes  direct call failed — trying relaxed fallback")
        all_routes = _recover_direct_route(
            start_lat, start_lon,
            end_lat, end_lon,
            orig_start_lat, orig_start_lon,
            orig_end_lat, orig_end_lon,
        )
    log.debug("fetch_routes  direct: %d route(s)", len(all_routes))
    unique = _dedupe_and_sort_routes(all_routes)

    if not unique:
        log.warning("fetch_routes  no direct route recovered; skipping via exploration")
        return []

    # ── Step 3: Via-waypoint calls (only if more routes needed) ───────────
    if dist_km < 15:
        max_via_tasks = 12
    elif dist_km < 80:
        max_via_tasks = 6
    else:
        max_via_tasks = 4

    if len(unique) < cap:
        via_points = _via_points(start_lat, start_lon, end_lat, end_lon, dist_km)
        via_tasks = [
            (start_lat, start_lon, end_lat, end_lon, vlat, vlon, 2)
            for vlat, vlon in via_points[:max_via_tasks]
        ]

        if via_tasks:
            log.debug("fetch_routes  submitting up to %d via task(s) with %d worker(s)",
                      len(via_tasks), _OSRM_WORKERS)

            for batch_start in range(0, len(via_tasks), _OSRM_WORKERS):
                if time.monotonic() >= deadline:
                    log.warning("fetch_routes  OSRM budget exhausted before batch %d",
                                (batch_start // _OSRM_WORKERS) + 1)
                    break

                batch = via_tasks[batch_start: batch_start + _OSRM_WORKERS]
                n_workers = min(len(batch), _OSRM_WORKERS)
                batch_results: list[dict] = []

                with ThreadPoolExecutor(max_workers=n_workers) as pool:
                    futures: dict = {}
                    for offset, task in enumerate(batch):
                        task_idx = batch_start + offset
                        futures[pool.submit(_osrm_request, *task)] = task_idx
                        if offset < len(batch) - 1:
                            time.sleep(_OSRM_SUBMIT_DELAY)

                    for fut in as_completed(futures):
                        try:
                            batch_results.extend(fut.result())
                        except Exception as exc:
                            log.warning("fetch_routes  via task %d raised: %s",
                                        futures[fut], exc)

                if batch_results:
                    all_routes.extend(batch_results)
                    unique = _dedupe_and_sort_routes(all_routes)
                    log.debug("fetch_routes  after batch %d → %d unique route(s)",
                              (batch_start // _OSRM_WORKERS) + 1, len(unique))
                    if len(unique) >= cap:
                        break

                if time.monotonic() >= deadline:
                    log.warning("fetch_routes  OSRM budget exhausted after batch %d",
                                (batch_start // _OSRM_WORKERS) + 1)
                    break

    # ── Step 4: Deduplicate and rank by duration ──────────────────────────
    unique = _dedupe_and_sort_routes(all_routes)

    result = unique[:cap]
    log.info("fetch_routes  %d unique route(s) from %d candidates (%.1f km trip)",
             len(result), len(all_routes), dist_km)
    return result



