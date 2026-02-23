"""
routing_engine.py — SmartNav AI Routing + Geocoding + POI Engine
=================================================================

Geocoding:
  1. Nominatim (India-restricted)
  2. Nominatim (global fallback)
  3. Photon (Komoot) fallback

POI / Nearby search:
  - Overpass API (OpenStreetMap) for amenity/shop/etc near user
  - Returns list of {name, lat, lon, type, address}

Route fetching strategy:
  SHORT  (<15 km)  : city — up to 12 via-waypoints, up to 5 unique routes
  MEDIUM (15–80km) : up to 6 via-waypoints, up to 4 unique routes
  LONG   (>80 km)  : up to 4 via-waypoints, up to 3 unique routes

Autocomplete suggestions:
  - Nominatim structured search with India viewbox
"""

import requests
import math

OSRM_BASE        = "https://router.project-osrm.org/route/v1/driving"
OSRM_NEAREST     = "https://router.project-osrm.org/nearest/v1/driving"
NOMINATIM_BASE   = "https://nominatim.openstreetmap.org/search"
NOMINATIM_SRCH   = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"
OVERPASS_BASE    = "https://overpass-api.de/api/interpreter"
PHOTON_BASE      = "https://photon.komoot.io/api"

# City radius used for nearby search and city-bounded geocoding
CITY_SEARCH_RADIUS_M   = 25000   # 25 km around user = whole city
CITY_GEOCODE_BOX_DEG   = 0.22    # ±0.22° ≈ ±24 km bounding box for geocoding

HEADERS = {
    "User-Agent": "SmartNavAI/5.0 (India navigation; academic; contact: student@edu.in)"
}
TIMEOUT    = 18
TIMEOUT_OV = 22   # Overpass can be slow

# India bounding box
INDIA_BBOX    = "6.5,68.0,37.5,97.5"
INDIA_LAT_MIN = 6.5
INDIA_LAT_MAX = 37.5
INDIA_LON_MIN = 68.0
INDIA_LON_MAX = 97.5

# Overpass amenity/shop keyword → OSM tag mapping
POI_TAG_MAP = {
    # ── Food & Drink ─────────────────────────────────────────────
    "restaurant":      [('amenity', 'restaurant')],
    "food":            [('amenity', 'restaurant'), ('amenity', 'fast_food'), ('amenity', 'cafe'), ('amenity', 'food_court')],
    "cafe":            [('amenity', 'cafe'), ('amenity', 'coffee_shop')],
    "coffee":          [('amenity', 'cafe')],
    "fast food":       [('amenity', 'fast_food')],
    "pizza":           [('amenity', 'fast_food'), ('amenity', 'restaurant')],
    "dhaba":           [('amenity', 'restaurant')],
    "bakery":          [('shop', 'bakery')],
    "sweet shop":      [('shop', 'confectionery'), ('shop', 'pastry')],
    "ice cream":       [('amenity', 'ice_cream'), ('shop', 'ice_cream')],
    "juice":           [('amenity', 'juice_bar'), ('shop', 'beverages')],
    "bar":             [('amenity', 'bar'), ('amenity', 'pub')],

    # ── Shopping — General ────────────────────────────────────────
    "shop":            [('shop', 'mall'), ('shop', 'department_store'), ('shop', 'supermarket'), ('shop', 'convenience')],
    "mall":            [('shop', 'mall'), ('shop', 'department_store'), ('leisure', 'shopping_centre')],
    "market":          [('amenity', 'marketplace'), ('shop', 'market')],
    "supermarket":     [('shop', 'supermarket')],
    "grocery":         [('shop', 'convenience'), ('shop', 'grocery'), ('shop', 'general')],
    "kirana":          [('shop', 'convenience'), ('shop', 'grocery')],
    "general store":   [('shop', 'convenience'), ('shop', 'general')],

    # ── Electronics & Mobile ──────────────────────────────────────
    "mobile shop":     [('shop', 'mobile_phone')],
    "mobile":          [('shop', 'mobile_phone')],
    "phone":           [('shop', 'mobile_phone'), ('shop', 'telecommunication')],
    "electronics":     [('shop', 'electronics'), ('shop', 'computer'), ('shop', 'mobile_phone')],
    "computer":        [('shop', 'computer')],
    "laptop":          [('shop', 'computer')],

    # ── Clothes & Fashion ─────────────────────────────────────────
    "clothes":         [('shop', 'clothes'), ('shop', 'fashion')],
    "fashion":         [('shop', 'clothes'), ('shop', 'fashion'), ('shop', 'boutique')],
    "shoes":           [('shop', 'shoes'), ('shop', 'footwear')],
    "tailoring":       [('shop', 'tailor')],
    "jewellery":       [('shop', 'jewelry'), ('shop', 'jewellery')],

    # ── Home & Hardware ───────────────────────────────────────────
    "hardware":        [('shop', 'hardware'), ('shop', 'doityourself')],
    "furniture":       [('shop', 'furniture')],
    "household":       [('shop', 'household'), ('shop', 'houseware')],

    # ── Health & Medical ──────────────────────────────────────────
    "pharmacy":        [('amenity', 'pharmacy')],
    "chemist":         [('amenity', 'pharmacy'), ('shop', 'chemist')],
    "medical":         [('amenity', 'pharmacy'), ('amenity', 'hospital'), ('amenity', 'clinic'), ('amenity', 'doctors')],
    "medicine":        [('amenity', 'pharmacy'), ('shop', 'chemist')],
    "hospital":        [('amenity', 'hospital')],
    "clinic":          [('amenity', 'clinic'), ('amenity', 'doctors')],
    "doctor":          [('amenity', 'doctors'), ('amenity', 'clinic'), ('amenity', 'health_centre')],
    "dentist":         [('amenity', 'dentist')],
    "eye":             [('amenity', 'optometrist'), ('shop', 'optician')],
    "optician":        [('shop', 'optician'), ('amenity', 'optometrist')],
    "diagnostic":      [('amenity', 'clinic'), ('amenity', 'laboratory')],
    "lab":             [('amenity', 'laboratory'), ('amenity', 'clinic')],
    "gym":             [('leisure', 'fitness_centre'), ('amenity', 'gym'), ('leisure', 'sports_centre')],
    "yoga":            [('leisure', 'yoga'), ('leisure', 'fitness_centre')],

    # ── Banking & Finance ─────────────────────────────────────────
    "bank":            [('amenity', 'bank')],
    "atm":             [('amenity', 'atm')],
    "sbi":             [('amenity', 'bank'), ('brand', 'State Bank of India')],

    # ── Education ─────────────────────────────────────────────────
    "school":          [('amenity', 'school')],
    "college":         [('amenity', 'college'), ('amenity', 'university')],
    "coaching":        [('amenity', 'college'), ('amenity', 'school')],
    "library":         [('amenity', 'library')],

    # ── Fuel & Transport ──────────────────────────────────────────
    "petrol":          [('amenity', 'fuel')],
    "petrol pump":     [('amenity', 'fuel')],
    "fuel":            [('amenity', 'fuel')],
    "gas station":     [('amenity', 'fuel')],
    "cng":             [('amenity', 'fuel')],
    "ev charging":     [('amenity', 'charging_station')],
    "charging":        [('amenity', 'charging_station')],
    "bus stop":        [('highway', 'bus_stop')],
    "bus station":     [('amenity', 'bus_station')],
    "metro":           [('railway', 'station'), ('railway', 'subway_entrance')],
    "railway":         [('railway', 'station')],
    "station":         [('railway', 'station'), ('amenity', 'bus_station')],
    "airport":         [('aeroway', 'aerodrome')],
    "parking":         [('amenity', 'parking')],
    "auto":            [('amenity', 'taxi')],
    "taxi":            [('amenity', 'taxi')],
    "cab":             [('amenity', 'taxi')],

    # ── Government & Services ─────────────────────────────────────
    "police":          [('amenity', 'police')],
    "police station":  [('amenity', 'police')],
    "post office":     [('amenity', 'post_office')],
    "government":      [('amenity', 'townhall'), ('office', 'government')],
    "court":           [('amenity', 'courthouse')],
    "fire station":    [('amenity', 'fire_station')],

    # ── Hotels & Accommodation ────────────────────────────────────
    "hotel":           [('tourism', 'hotel'), ('tourism', 'guest_house'), ('tourism', 'hostel')],
    "lodge":           [('tourism', 'guest_house'), ('tourism', 'hostel')],
    "dharamshala":     [('tourism', 'hostel'), ('tourism', 'guest_house')],

    # ── Recreation & Leisure ──────────────────────────────────────
    "park":            [('leisure', 'park'), ('leisure', 'garden')],
    "garden":          [('leisure', 'garden'), ('leisure', 'park')],
    "cinema":          [('amenity', 'cinema')],
    "theatre":         [('amenity', 'theatre')],
    "stadium":         [('leisure', 'stadium')],
    "swimming":        [('leisure', 'swimming_pool')],
    "sports":          [('leisure', 'sports_centre'), ('leisure', 'sports_hall')],

    # ── Places of Worship ─────────────────────────────────────────
    "temple":          [('amenity', 'place_of_worship'), ('religion', 'hindu')],
    "mandir":          [('amenity', 'place_of_worship')],
    "mosque":          [('amenity', 'place_of_worship'), ('religion', 'muslim')],
    "church":          [('amenity', 'place_of_worship'), ('religion', 'christian')],
    "gurudwara":       [('amenity', 'place_of_worship'), ('religion', 'sikh')],

    # ── Beauty & Personal Care ────────────────────────────────────
    "salon":           [('shop', 'hairdresser'), ('shop', 'beauty'), ('shop', 'massage')],
    "barber":          [('shop', 'hairdresser'), ('shop', 'barber')],
    "beauty":          [('shop', 'beauty'), ('shop', 'cosmetics')],
    "spa":             [('leisure', 'spa'), ('shop', 'beauty')],

    # ── Miscellaneous ─────────────────────────────────────────────
    "stationery":      [('shop', 'stationery'), ('shop', 'books')],
    "book":            [('shop', 'books'), ('amenity', 'library')],
    "toy":             [('shop', 'toys')],
    "sports shop":     [('shop', 'sports'), ('shop', 'outdoor')],
    "laundry":         [('shop', 'laundry'), ('amenity', 'laundry')],
    "tailor":          [('shop', 'tailor')],
    "vehicle repair":  [('shop', 'car_repair'), ('amenity', 'car_repair')],
    "car repair":      [('shop', 'car_repair')],
    "bike repair":     [('shop', 'bicycle'), ('amenity', 'bicycle_repair_station')],
    "photo":           [('shop', 'photo'), ('shop', 'photography')],
    "print":           [('shop', 'copyshop'), ('office', 'printing')],
    "courier":         [('amenity', 'post_office'), ('office', 'courier')],
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clamp(val, lo, hi):
    return max(lo, min(hi, val))


def _snap_to_road(lat: float, lon: float) -> tuple[float, float]:
    """
    Snap a GPS coordinate to the nearest road node via OSRM /nearest.
    Returns (lat, lon) — snapped if successful, original if any error.
    This is critical for GPS coordinates that land in buildings/water/fields:
    OSRM can't route from those, causing wildly wrong routes.
    """
    try:
        url = f"{OSRM_NEAREST}/{lon},{lat}"
        r = requests.get(url, params={"number": 1}, headers=HEADERS, timeout=6)
        r.raise_for_status()
        data = r.json()
        if data.get("code") == "Ok" and data.get("waypoints"):
            wpt = data["waypoints"][0]
            loc = wpt.get("location", [lon, lat])
            snapped_lon, snapped_lat = loc[0], loc[1]
            dist = _haversine(lat, lon, snapped_lat, snapped_lon)
            # Only use snapped point if it's within 300m (avoid snapping to wrong road)
            if dist <= 300:
                print(f"[snap] ({lat:.5f},{lon:.5f}) → ({snapped_lat:.5f},{snapped_lon:.5f}) dist={dist:.0f}m")
                return snapped_lat, snapped_lon
            else:
                print(f"[snap] Snapped point too far ({dist:.0f}m), keeping original")
    except Exception as e:
        print(f"[snap] OSRM nearest failed: {e}")
    return lat, lon


def get_city_name(lat: float, lon: float) -> str | None:
    """
    Reverse-geocode to get city/town name for the user's current location.
    Used to bias geocoding results to the user's own city.
    """
    try:
        r = requests.get(
            NOMINATIM_REVERSE,
            params={
                "lat":    lat,
                "lon":    lon,
                "format": "json",
                "zoom":   10,   # city level
                "addressdetails": 1,
            },
            headers=HEADERS,
            timeout=8,
        )
        r.raise_for_status()
        data = r.json()
        addr = data.get("address", {})
        city = (addr.get("city") or addr.get("town") or
                addr.get("village") or addr.get("county") or
                addr.get("state_district"))
        if city:
            print(f"[city] User city detected: {city}")
        return city
    except Exception as e:
        print(f"[city] Reverse geocode failed: {e}")
        return None


def _extract_poi_keyword(query: str) -> str | None:
    """
    Detect if query is a POI search like 'mobile shop near me'.
    Returns the keyword or None if it's a normal place name.
    """
    q = query.lower().strip()
    near_phrases = ["near me", "nearby", "near by", "close to me", "around me",
                    "close by", "closest", "nearest"]
    is_near = any(p in q for p in near_phrases)
    if not is_near:
        return None

    # Strip "near me" variants to get the keyword
    for p in near_phrases:
        q = q.replace(p, "")
    q = q.strip().rstrip(",")

    # Try exact match
    if q in POI_TAG_MAP:
        return q

    # Partial match
    for key in POI_TAG_MAP:
        if key in q or q in key:
            return key

    # Return cleaned query as generic search term
    return q if q else None


def _build_overpass_query(tags: list, lat: float, lon: float, radius_m: int) -> str:
    """Build an Overpass QL query for given tags near a location."""
    parts = []
    for tag_key, tag_val in tags:
        # Skip 'religion' tags as standalone — use only as filter within amenity
        if tag_key == 'religion':
            continue
        if tag_val == '*':
            parts.append(f'node["{tag_key}"](around:{radius_m},{lat},{lon});')
            parts.append(f'way["{tag_key}"](around:{radius_m},{lat},{lon});')
            parts.append(f'relation["{tag_key}"](around:{radius_m},{lat},{lon});')
        else:
            parts.append(f'node["{tag_key}"="{tag_val}"](around:{radius_m},{lat},{lon});')
            parts.append(f'way["{tag_key}"="{tag_val}"](around:{radius_m},{lat},{lon});')
            parts.append(f'relation["{tag_key}"="{tag_val}"](around:{radius_m},{lat},{lon});')
    union = "\n  ".join(parts)
    return f"[out:json][timeout:25];\n(\n  {union}\n);\nout center tags 30;"


# ---------------------------------------------------------------------------
# POI / Nearby search
# ---------------------------------------------------------------------------

def search_nearby(keyword: str, lat: float, lon: float,
                  radius_m: int = 5000) -> list[dict]:
    """
    Search for POIs near (lat, lon) using Overpass API.
    Returns list of {name, lat, lon, type, address, distance_m}.
    """
    kw = keyword.lower().strip()
    tags = POI_TAG_MAP.get(kw)

    # Fallback: try partial match
    if not tags:
        for k, v in POI_TAG_MAP.items():
            if k in kw or kw in k:
                tags = v
                break

    # Fallback: search by name using Nominatim
    if not tags:
        return _nominatim_nearby(keyword, lat, lon, radius_m)

    query = _build_overpass_query(tags, lat, lon, radius_m)
    results = []

    try:
        r = requests.post(
            OVERPASS_BASE,
            data={"data": query},
            headers=HEADERS,
            timeout=TIMEOUT_OV,
        )
        r.raise_for_status()
        data = r.json()
        elements = data.get("elements", [])

        seen = set()
        for el in elements:
            tags_el = el.get("tags", {})

            # Try multiple name fields for best label
            name = (tags_el.get("name:en") or
                    tags_el.get("name") or
                    tags_el.get("brand") or
                    tags_el.get("operator"))
            if not name:
                continue

            # Normalize name
            name = name.strip()
            name_key = name.lower()
            if name_key in seen:
                continue
            seen.add(name_key)

            # Get coordinates
            if el["type"] == "node":
                elat, elon = el.get("lat"), el.get("lon")
            elif el["type"] in ("way", "relation") and "center" in el:
                elat = el["center"]["lat"]
                elon = el["center"]["lon"]
            else:
                continue

            if elat is None or elon is None:
                continue

            # Distance from user
            dist = _haversine(lat, lon, elat, elon)

            # Build address from OSM tags
            addr_parts = []
            for f in ["addr:housenumber", "addr:street", "addr:suburb",
                      "addr:city", "addr:state"]:
                v = tags_el.get(f)
                if v:
                    addr_parts.append(v)
            address = ", ".join(addr_parts) if addr_parts else None

            # Best type label
            poi_type = (tags_el.get("amenity") or
                        tags_el.get("shop") or
                        tags_el.get("tourism") or
                        tags_el.get("leisure") or
                        tags_el.get("highway") or
                        tags_el.get("railway") or
                        tags_el.get("office") or
                        keyword)

            # Extra info (cuisine, opening_hours, phone, website)
            extra = {}
            for field in ["cuisine", "opening_hours", "phone", "website",
                          "brand", "operator", "description"]:
                v = tags_el.get(field)
                if v:
                    extra[field] = v[:120]

            results.append({
                "name":       name,
                "lat":        round(float(elat), 6),
                "lon":        round(float(elon), 6),
                "type":       poi_type,
                "address":    address,
                "distance_m": round(dist),
                "extra":      extra if extra else None,
            })

        results.sort(key=lambda x: x["distance_m"])
        print(f"[search_nearby] Overpass found {len(results)} results for '{keyword}'")

        # If Overpass gave too few results, supplement with Nominatim
        if len(results) < 5:
            nom = _nominatim_nearby(keyword, lat, lon, radius_m)
            nom_names = {r["name"].lower() for r in results}
            for n in nom:
                if n["name"].lower() not in nom_names:
                    results.append(n)
                    nom_names.add(n["name"].lower())
            results.sort(key=lambda x: x["distance_m"])

        return results[:20]

    except Exception as e:
        print(f"[search_nearby] Overpass failed: {e}")
        return _nominatim_nearby(keyword, lat, lon, radius_m)


def _nominatim_nearby(keyword: str, lat: float, lon: float,
                      radius_m: int) -> list[dict]:
    """Fallback nearby search using Nominatim."""
    try:
        r = requests.get(
            NOMINATIM_BASE,
            params={
                "q":      keyword,
                "format": "json",
                "limit":  12,
                "countrycodes": "in",
                "viewbox": f"{lon-0.2},{lat+0.2},{lon+0.2},{lat-0.2}",
                "bounded": 1,
                "addressdetails": 1,
            },
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        results = []
        for item in data:
            rlat = float(item["lat"])
            rlon = float(item["lon"])
            dist = _haversine(lat, lon, rlat, rlon)
            name = item.get("display_name", "").split(",")[0]
            results.append({
                "name":       name,
                "lat":        round(rlat, 6),
                "lon":        round(rlon, 6),
                "type":       item.get("type", "place"),
                "address":    item.get("display_name"),
                "distance_m": round(dist),
            })
        results.sort(key=lambda x: x["distance_m"])
        return results[:12]
    except Exception as e:
        print(f"[_nominatim_nearby] Failed: {e}")
        return []


def _haversine(lat1, lon1, lat2, lon2) -> float:
    """Return distance in metres between two lat/lon points."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi   = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ---------------------------------------------------------------------------
# Autocomplete suggestions
# ---------------------------------------------------------------------------

def get_suggestions(query: str, lat: float = None, lon: float = None,
                    limit: int = 8) -> list[dict]:
    """
    Return autocomplete suggestions for the search bar.
    Combines Nominatim India results and common POI keywords.
    """
    if not query or len(query.strip()) < 2:
        return []

    results = []
    seen_names = set()

    # Check if it's a POI/nearby-style query
    kw = _extract_poi_keyword(query)
    if kw:
        # Offer POI-type suggestions
        q_lower = query.lower()
        for key in POI_TAG_MAP:
            if key.startswith(q_lower.replace(" near me", "").strip()):
                label = f"{key.title()} near me"
                if label not in seen_names:
                    seen_names.add(label)
                    results.append({
                        "label": label,
                        "type":  "poi",
                        "query": label,
                    })
        # Add generic variations
        base = q_lower.replace(" near me", "").replace(" nearby", "").strip()
        for suffix in [" near me", " nearby"]:
            label = base + suffix
            if label not in seen_names and base:
                seen_names.add(label)
                results.append({"label": label.title(), "type": "poi", "query": label})

    # Nominatim autocomplete
    try:
        params = {
            "q":            query,
            "format":       "json",
            "limit":        limit,
            "countrycodes": "in",
            "addressdetails": 1,
        }
        if lat and lon:
            params["viewbox"] = f"{lon-2},{lat+2},{lon+2},{lat-2}"
            params["bounded"] = 0   # still search outside viewbox
        r = requests.get(NOMINATIM_SRCH, params=params, headers=HEADERS, timeout=10)
        r.raise_for_status()
        for item in r.json():
            name = item.get("display_name", "")
            short = name.split(",")[0].strip()
            addr  = ", ".join(x.strip() for x in name.split(",")[1:4]) if "," in name else ""
            key   = short.lower()
            if key not in seen_names:
                seen_names.add(key)
                results.append({
                    "label":   short,
                    "sublabel": addr,
                    "type":    item.get("type", "place"),
                    "lat":     float(item["lat"]),
                    "lon":     float(item["lon"]),
                    "query":   short,
                })
    except Exception as e:
        print(f"[get_suggestions] Nominatim failed: {e}")

    return results[:limit]


# ---------------------------------------------------------------------------
# Geocoding
# ---------------------------------------------------------------------------

def geocode(place_name: str, user_lat: float = None,
            user_lon: float = None) -> dict | None:
    """
    Convert place name → {lat, lon}.
    If user_lat/lon provided, biases search to user's city bounding box first.
    Tries: City-biased Nominatim → Nominatim India → Photon fallback.
    """
    # 0. City-biased search (tight viewbox around user, bounded=1 then bounded=0)
    if user_lat is not None and user_lon is not None:
        box = CITY_GEOCODE_BOX_DEG
        viewbox = f"{user_lon-box},{user_lat+box},{user_lon+box},{user_lat-box}"
        for bounded in (1, 0):   # first try strict, then relaxed
            try:
                r = requests.get(
                    NOMINATIM_BASE,
                    params={
                        "q":            place_name,
                        "format":       "json",
                        "limit":        3,
                        "countrycodes": "in",
                        "viewbox":      viewbox,
                        "bounded":      bounded,
                        "addressdetails": 0,
                    },
                    headers=HEADERS,
                    timeout=TIMEOUT,
                )
                r.raise_for_status()
                data = r.json()
                if data:
                    rlat = float(data[0]["lat"])
                    rlon = float(data[0]["lon"])
                    dist = _haversine(user_lat, user_lon, rlat, rlon)
                    # Accept if within 50 km of user (same metro area)
                    if dist <= 50000:
                        print(f"[geocode] '{place_name}' city-biased (bounded={bounded}): "
                              f"{rlat:.4f},{rlon:.4f} dist={dist/1000:.1f}km")
                        return {"lat": rlat, "lon": rlon}
            except Exception as e:
                print(f"[geocode] City-biased search failed: {e}")

    # 1. Nominatim India-restricted
    try:
        r = requests.get(
            NOMINATIM_BASE,
            params={
                "q":            place_name,
                "format":       "json",
                "limit":        1,
                "countrycodes": "in",
                "viewbox":      INDIA_BBOX,
                "bounded":      0,
                "addressdetails": 0,
            },
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if data:
            print(f"[geocode] '{place_name}' via Nominatim-India: "
                  f"{data[0]['lat']}, {data[0]['lon']}")
            return {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"])}
    except Exception as e:
        print(f"[geocode] Nominatim-India failed: {e}")

    # 2. Nominatim global
    try:
        r = requests.get(
            NOMINATIM_BASE,
            params={"q": place_name, "format": "json", "limit": 1},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if data:
            lat = float(data[0]["lat"])
            lon = float(data[0]["lon"])
            # Accept only if inside India bounding box
            if (INDIA_LAT_MIN <= lat <= INDIA_LAT_MAX and
                    INDIA_LON_MIN <= lon <= INDIA_LON_MAX):
                print(f"[geocode] '{place_name}' via Nominatim-global (India check passed)")
                return {"lat": lat, "lon": lon}
            print(f"[geocode] Nominatim-global returned coords outside India, ignoring")
    except Exception as e:
        print(f"[geocode] Nominatim-global failed: {e}")

    # 3. Photon (Komoot)
    try:
        r = requests.get(
            PHOTON_BASE,
            params={"q": place_name, "limit": 3, "lang": "en"},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        features = r.json().get("features", [])
        for f in features:
            lon, lat = f["geometry"]["coordinates"]
            if (INDIA_LAT_MIN <= lat <= INDIA_LAT_MAX and
                    INDIA_LON_MIN <= lon <= INDIA_LON_MAX):
                print(f"[geocode] '{place_name}' via Photon")
                return {"lat": float(lat), "lon": float(lon)}
    except Exception as e:
        print(f"[geocode] Photon failed: {e}")

    print(f"[geocode] FAILED for '{place_name}'")
    return None


# ---------------------------------------------------------------------------
# OSRM helper
# ---------------------------------------------------------------------------

def _osrm_request(start_lat, start_lon, end_lat, end_lon,
                  via_lat=None, via_lon=None,
                  alternatives: int = 3) -> list:
    """
    Single OSRM call. Returns list of raw route dicts.
    alternatives: max number of alternatives to request from OSRM.
    """
    if via_lat is not None:
        via_lat = _clamp(via_lat, INDIA_LAT_MIN, INDIA_LAT_MAX)
        via_lon = _clamp(via_lon, INDIA_LON_MIN, INDIA_LON_MAX)
        coord_str = (
            f"{start_lon},{start_lat};"
            f"{via_lon},{via_lat};"
            f"{end_lon},{end_lat}"
        )
    else:
        coord_str = f"{start_lon},{start_lat};{end_lon},{end_lat}"

    url    = f"{OSRM_BASE}/{coord_str}"
    params = {
        "overview":     "full",
        "alternatives": str(alternatives),
        "geometries":   "geojson",
        "steps":        "false",
    }

    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()

        if data.get("code") != "Ok":
            print(f"[OSRM] Error code: {data.get('code')}")
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

    except Exception as e:
        print(f"[OSRM] Request failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Via-waypoint generation
# ---------------------------------------------------------------------------

def _via_points(start_lat, start_lon, end_lat, end_lon, dist_km) -> list:
    """
    Return a list of (via_lat, via_lon) tuples for corridor exploration.
    Offsets are always proportional to actual trip distance so nearby routes
    (e.g. 500m) get tight local alternatives, not km-wide detours.
    """
    mid_lat = (start_lat + end_lat) / 2
    mid_lon = (start_lon + end_lon) / 2

    dlat    = end_lat - start_lat
    dlon    = end_lon - start_lon
    seg_len = math.sqrt(dlat**2 + dlon**2) or 1e-9

    # Unit vectors
    perp_lat = -dlon / seg_len
    perp_lon =  dlat / seg_len
    para_lat =  dlat / seg_len
    para_lon =  dlon / seg_len

    via = []

    if dist_km < 2:
        # Very short (< 2km): micro offsets — tight street-level alternatives
        # Offsets: 8–18% of trip length perpendicular, 20–40% along-track
        for perp_f in (0.12, 0.20, -0.12, -0.20):
            off = seg_len * perp_f
            via.append((mid_lat + perp_lat * off, mid_lon + perp_lon * off))
        # Along-track shifted midpoints
        for para_f in (0.30, -0.30):
            for perp_f in (0.10, -0.10):
                p_off = seg_len * para_f
                o_off = seg_len * perp_f
                via.append((
                    mid_lat + para_lat * p_off + perp_lat * o_off,
                    mid_lon + para_lon * p_off + perp_lon * o_off,
                ))
        # Quarter-points perpendicular
        q1_lat = start_lat + dlat * 0.25
        q1_lon = start_lon + dlon * 0.25
        q3_lat = start_lat + dlat * 0.75
        q3_lon = start_lon + dlon * 0.75
        for q_lat, q_lon in [(q1_lat, q1_lon), (q3_lat, q3_lon)]:
            for perp_f in (0.15, -0.15):
                off = seg_len * perp_f
                via.append((q_lat + perp_lat * off, q_lon + perp_lon * off))

    elif dist_km < 15:
        # City (2–15 km): radial sampling scaled to distance
        # Use 3 rings at 12%, 22%, 35% of trip length
        scale = seg_len
        offsets = [scale * 0.12, scale * 0.22, scale * 0.35]
        angles_deg = [0, 45, 90, 135, 180, 225, 270, 315]
        cos_lat = math.cos(math.radians(mid_lat)) or 1
        for off in offsets:
            for deg in angles_deg:
                rad  = math.radians(deg)
                vlat = mid_lat + off * math.cos(rad)
                vlon = mid_lon + off * math.sin(rad) / cos_lat
                via.append((vlat, vlon))

    elif dist_km < 80:
        # Medium: perpendicular both sides + shifted quarter-points
        for factor in (0.15, 0.25, -0.15, -0.25):
            off = seg_len * factor
            via.append((mid_lat + perp_lat * off, mid_lon + perp_lon * off))
        q1_lat = start_lat + dlat * 0.25
        q1_lon = start_lon + dlon * 0.25
        q3_lat = start_lat + dlat * 0.75
        q3_lon = start_lon + dlon * 0.75
        for q_lat, q_lon in [(q1_lat, q1_lon), (q3_lat, q3_lon)]:
            for off_f in (0.12, -0.12):
                off = seg_len * off_f
                via.append((q_lat + perp_lat * off, q_lon + perp_lon * off))

    else:
        # Long distance: perpendicular + forward/backward bias
        for factor in (0.18, 0.30, -0.18, -0.30):
            off = seg_len * factor
            via.append((mid_lat + perp_lat * off, mid_lon + perp_lon * off))
        for bias in (0.25, -0.25):
            boff = seg_len * bias
            via.append((
                mid_lat + para_lat * boff + perp_lat * seg_len * 0.15,
                mid_lon + para_lon * boff + perp_lon * seg_len * 0.15,
            ))

    return via


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def _is_duplicate(route, accepted, dist_thr=0.04, geom_thr=0.08,
                  dur_thr=0.04) -> bool:
    """
    Returns True if route is too similar to any accepted route.
    Uses distance, duration AND geometry point count.
    For very short routes the absolute thresholds kick in too:
    two 800m routes that differ by 80m ARE different streets.
    """
    d    = route["distance"]
    dur  = route["duration"]
    npts = len(route.get("geometry", []))
    for u in accepted:
        ud   = u["distance"]
        uu   = u["duration"]
        upts = len(u.get("geometry", []))

        # Relative similarity
        rel_dist = abs(ud - d)   / max(ud,  1)
        rel_dur  = abs(uu - dur) / max(uu,  1)
        rel_geom = abs(upts - npts) / max(upts, 1)

        # Absolute distance diff (metres)
        abs_dist_diff = abs(ud - d)

        # For short routes (<3km): require at least 120m or 6% difference
        if d < 3000 or ud < 3000:
            if abs_dist_diff < 120 and rel_dur < 0.06 and rel_geom < 0.10:
                return True
        else:
            if rel_dist < dist_thr and rel_dur < dur_thr and rel_geom < geom_thr:
                return True
    return False


# ---------------------------------------------------------------------------
# Main routing entry point
# ---------------------------------------------------------------------------

def fetch_routes(start_lat: float, start_lon: float,
                 end_lat: float, end_lon: float,
                 max_routes: int = 5) -> list[dict]:
    """
    Fetch up to max_routes distinct driving routes.
    Snaps start+end to nearest road node first (fixes GPS-in-building issues).
    """
    # ── Snap both endpoints to nearest drivable road ────────────────
    start_lat, start_lon = _snap_to_road(start_lat, start_lon)
    end_lat,   end_lon   = _snap_to_road(end_lat,   end_lon)

    dist_deg = math.sqrt((end_lat-start_lat)**2 + (end_lon-start_lon)**2)
    dist_km  = dist_deg * 111.0

    print(f"[fetch_routes] Distance estimate: {dist_km:.1f} km")

    # Adjust max_routes by distance
    if dist_km < 15:
        cap = min(max_routes, 5)
    elif dist_km < 80:
        cap = min(max_routes, 4)
    else:
        cap = min(max_routes, 3)

    all_routes = []

    # Direct call (up to 3 alternatives from OSRM itself)
    direct = _osrm_request(start_lat, start_lon, end_lat, end_lon, alternatives=3)
    all_routes.extend(direct)
    print(f"[fetch_routes] Direct: {len(direct)} route(s)")

    # Via-waypoint calls
    vias = _via_points(start_lat, start_lon, end_lat, end_lon, dist_km)

    for idx, (vlat, vlon) in enumerate(vias):
        routes = _osrm_request(
            start_lat, start_lon, end_lat, end_lon,
            vlat, vlon, alternatives=2
        )
        all_routes.extend(routes)
        print(f"[fetch_routes] Via {idx+1}: {len(routes)} route(s), total pool: {len(all_routes)}")

        # Stop sampling once we have a large enough candidate pool
        target_pool = cap * 6
        if len(all_routes) >= target_pool:
            break

    # Deduplicate
    unique = []
    for route in all_routes:
        if not _is_duplicate(route, unique):
            unique.append(route)

    # Sort by duration
    unique.sort(key=lambda r: r["duration"])

    result = unique[:cap]
    print(f"[fetch_routes] Final: {len(result)} unique route(s) "
          f"from {len(all_routes)} candidates")
    return result
