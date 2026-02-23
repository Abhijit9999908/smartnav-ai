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

import math


def _safe_div(n: float, d: float) -> float:
    return n / max(d, 1e-9)


def _safety_score(distance_m: float, n_coords: int) -> float:
    """
    Highway heuristic:
      - Longer routes more likely to use national/state highways (safer)
      - Routes with very many coords have more turns/junctions (less safe)
    Returns a raw float, normalised to 0-1 across the route set.
    """
    highway = math.log1p(distance_m / 1000.0)
    penalty = math.log1p(n_coords / 60.0)
    return highway / max(penalty, 0.01)


def score_routes(routes: list[dict]) -> list[dict]:
    """
    Score and rank a list of routes (best first).

    Input:  [{distance(m), duration(s), geometry([[lon,lat],...])}]
    Output: same list enriched with {distance_km, duration_min,
            score, recommended, tags}, sorted by score descending.
    Handles 1–5 routes.
    """
    if not routes:
        return []

    # Pre-compute raw safety scores for normalisation
    safety_raws = [
        _safety_score(r["distance"], len(r.get("geometry", [[0, 0]])))
        for r in routes
    ]
    max_safety = max(safety_raws) if safety_raws else 1.0
    min_safety = min(safety_raws) if safety_raws else 0.0
    safety_range = max(max_safety - min_safety, 1e-9)

    scored = []
    for i, r in enumerate(routes):
        dist  = r["distance"]       # metres
        dur   = r["duration"]       # seconds
        n_pts = len(r.get("geometry", [[0, 0]]))

        # Individual component scores
        t_score = _safe_div(1.0, dur)
        d_score = _safe_div(1.0, dist)
        # Normalise safety to [0, 1] relative to this route set
        s_score = (safety_raws[i] - min_safety) / safety_range
        c_score = _safe_div(1.0, n_pts)

        raw = (
            0.40 * t_score +
            0.30 * d_score +
            0.20 * s_score +
            0.10 * c_score
        )

        scored.append({
            "distance_km":  round(dist / 1000.0, 2),
            "duration_min": round(dur  / 60.0,   1),
            "score":        round(raw * 1e5,      2),
            "geometry":     r.get("geometry", []),
            "recommended":  False,
            "tags":         [],
            "_safety_raw":  safety_raws[i],
        })

    # Sort best → worst
    scored.sort(key=lambda x: x["score"], reverse=True)
    scored[0]["recommended"] = True

    # Assign tags
    min_dur    = min(x["duration_min"]  for x in scored)
    min_dist   = min(x["distance_km"]   for x in scored)
    max_s_raw  = max(x["_safety_raw"]   for x in scored)

    for r in scored:
        tags = []
        if r["recommended"]:
            tags.append("best")
        if r["duration_min"] == min_dur:
            tags.append("fastest")
        if r["distance_km"] == min_dist:
            tags.append("shortest")
        s_frac = abs(r["_safety_raw"] - max_s_raw) / max(max_s_raw, 1e-9)
        if s_frac < 0.03:
            tags.append("safest")
        r["tags"] = tags
        del r["_safety_raw"]   # remove internal field before sending to client

    return scored
