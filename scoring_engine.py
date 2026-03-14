"""
scoring_engine.py — SmartNav AI Route Scoring Engine  v5.0
===========================================================
Scores and ranks up to 5 routes using a weighted formula.

SCORING WEIGHTS:
  40% — Time efficiency  (faster ETA)
  30% — Distance/fuel    (shorter = less cost)
  20% — Road safety      (highway heuristic)
  10% — Route simplicity (fewer waypoints = easier navigation)

TAGS assigned after scoring:
  ★  Best     — highest smart score
  ⚡ Fastest  — lowest duration
  📏 Shortest — lowest distance
  🛡 Safest   — highest safety heuristic
"""

import logging
import math

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Scoring weights  (must sum to 1.0)
# ---------------------------------------------------------------------------
W_TIME     = 0.40   # time efficiency
W_DISTANCE = 0.30   # distance / fuel
W_SAFETY   = 0.20   # road-safety heuristic
W_SIMPLICITY = 0.10 # route complexity

assert math.isclose(W_TIME + W_DISTANCE + W_SAFETY + W_SIMPLICITY, 1.0), \
    "Scoring weights must sum to 1.0"

# Safety heuristic tuning knobs
_SAFETY_DIST_SCALE  = 1_000.0   # metres → km divisor for highway proxy
_SAFETY_COORD_SCALE = 60.0      # waypoint count normaliser (≈ coords per turn)

# Tag tolerance: a route is "safest" if its safety score is within this
# fraction of the best safety score in the set
_SAFEST_TOLERANCE = 0.03        # 3 %

# Score multiplier applied before rounding (makes scores human-readable integers)
_SCORE_SCALE = 1e5

# Minimum geometry length assumed when a route has no coordinates
_MIN_GEOMETRY_LEN = 1


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _safe_div(numerator: float, denominator: float) -> float:
    """Return numerator / denominator, guarding against division by zero."""
    return numerator / max(denominator, 1e-9)


def _safety_score(distance_m: float, n_coords: int) -> float:
    """
    Highway-proxy safety heuristic.

    Rationale:
    - Longer routes are more likely to travel on national/state highways,
      which have fewer intersections and better road quality (safer).
    - Routes with very many coordinate points have more turns and junctions
      (less safe), so we penalise them logarithmically.

    The raw value is not meaningful alone — it is always min-max normalised
    to [0, 1] relative to the other routes being scored.
    """
    highway_proxy = math.log1p(distance_m / _SAFETY_DIST_SCALE)
    turn_penalty  = math.log1p(n_coords   / _SAFETY_COORD_SCALE)
    return _safe_div(highway_proxy, turn_penalty)


def _minmax_normalise(values: list[float]) -> list[float]:
    """
    Min-max normalise *values* to [0, 1].

    If all values are equal the function returns a list of 1.0s rather than
    0.0s — every route is equally good on that dimension, so each should
    receive full credit rather than zero.
    """
    lo  = min(values)
    hi  = max(values)
    rng = hi - lo
    if rng < 1e-9:
        return [1.0] * len(values)
    return [(v - lo) / rng for v in values]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def score_routes(routes: list[dict]) -> list[dict]:
    """
    Score and rank a list of route dicts, returning the best route first.

    **Input** (each dict must contain):
    - ``distance``  — float, metres
    - ``duration``  — float, seconds
    - ``geometry``  — list of ``[lon, lat]`` coordinate pairs

    **Output** — same dicts enriched with:
    - ``distance_km``  — rounded to 2 dp
    - ``duration_min`` — rounded to 1 dp
    - ``score``        — composite score (higher = better), scaled by 1e5
    - ``recommended``  — ``True`` for the top-ranked route
    - ``tags``         — list of label strings: ``"best"``, ``"fastest"``,
                         ``"shortest"``, ``"safest"`` (a route may have multiple)

    Handles 1–5 routes.  Returns an empty list when given an empty list.
    """
    if not routes:
        return []

    n = len(routes)

    # ── Extract raw per-route metrics ──────────────────────────────────────
    distances   = [float(r["distance"]) for r in routes]   # metres  (kept for tags)
    durations_s = [float(r["duration"]) for r in routes]   # seconds
    n_coords    = [
        max(len(r.get("geometry", [])), _MIN_GEOMETRY_LEN)
        for r in routes
    ]
    safety_raws = [
        _safety_score(float(r["distance"]), nc)
        for r, nc in zip(routes, n_coords)
    ]

    # ── Normalise each dimension to [0, 1] ────────────────────────────────
    # Time / distance: lower is better → invert before normalising
    inv_duration = [_safe_div(1.0, d) for d in durations_s]
    inv_distance = [_safe_div(1.0, d) for d in distances]
    inv_coords   = [_safe_div(1.0, c) for c in n_coords]

    norm_time     = _minmax_normalise(inv_duration)
    norm_distance = _minmax_normalise(inv_distance)
    norm_safety   = _minmax_normalise(safety_raws)
    norm_simplicity = _minmax_normalise(inv_coords)

    # ── Compute composite score ───────────────────────────────────────────
    scores = [
        round(
            (W_TIME       * norm_time[i]
             + W_DISTANCE   * norm_distance[i]
             + W_SAFETY     * norm_safety[i]
             + W_SIMPLICITY * norm_simplicity[i])
            * _SCORE_SCALE,
            2,
        )
        for i in range(n)
    ]

    log.debug("score_routes  raw scores: %s", scores)

    # ── Build enriched output dicts ───────────────────────────────────────
    enriched = [
        {
            "distance_km":  round(distances[i]   / 1000.0, 2),
            "duration_min": round(durations_s[i] / 60.0,   1),
            "score":        scores[i],
            "geometry":     routes[i].get("geometry", []),
            "recommended":  False,
            "tags":         [],
            # Carried internally for tag assignment; removed before return
            "_safety_raw":  safety_raws[i],
        }
        for i in range(n)
    ]

    # ── Sort best → worst, mark top route as recommended ─────────────────
    enriched.sort(key=lambda x: x["score"], reverse=True)
    enriched[0]["recommended"] = True

    # ── Assign tags ───────────────────────────────────────────────────────
    min_dur_min  = min(x["duration_min"] for x in enriched)
    min_dist_km  = min(x["distance_km"]  for x in enriched)
    max_safety   = max(x["_safety_raw"]  for x in enriched)

    for route in enriched:
        tags: list[str] = []

        if route["recommended"]:
            tags.append("best")

        if route["duration_min"] == min_dur_min:
            tags.append("fastest")

        if route["distance_km"] == min_dist_km:
            tags.append("shortest")

        safety_gap = abs(route["_safety_raw"] - max_safety)
        if _safe_div(safety_gap, max_safety) < _SAFEST_TOLERANCE:
            tags.append("safest")

        route["tags"] = tags
        del route["_safety_raw"]    # internal field — never sent to the client

    log.info(
        "score_routes  ranked %d route(s) — best score %.2f, tags: %s",
        n,
        enriched[0]["score"],
        enriched[0]["tags"],
    )

    return enriched
