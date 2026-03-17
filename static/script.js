/* ================================================================
   SmartNav AI — script.js  v8.1
   - Kalman-filtered GPS positions (latitude, longitude)
   - Smooth bearing interpolation (exponential low-pass)
   - Real-time speed readout (km/h) in nav HUD
   - Direction arrow rotates live with heading
   - Off-route detection with reroute prompt
   - Fan-out route animation, best route = bright green
   - City-bounded search, road-snapped routing

   Fixes vs v8.0:
   - SVG renderer instances from _drawRouteTracer / _addGlowLine
     tracked and removed from DOM on clearRoutes/stopScanAnimation
   - dotMarker in scan animation promoted to module-level
     (_scanDotMarker) so stopScanAnimation reliably removes it
   - zoomToRoute opacity restoration uses correct values
     (isBest ? 1.0 : fo*0.55 instead of bare fo)
   - GPS watchPosition cleared on page unload
   - map.invalidateSize() called after panel open/close
   - _toggleMapStyle wired via addEventListener (no inline onclick)
   - aria-selected + aria-activedescendant on autocomplete list
   - Stale suggestion results suppressed when input is empty/changed
   - clearRoutes() hides stale error toasts
   - handleRouteSearch/handleNearbySearch finally-blocks ensure
     scan animation is always stopped on any exit path
   - fetchSuggestions guards against rendering when input cleared
================================================================ */

'use strict';

/* ── Library guard ───────────────────────────────────────────── */
// Show a helpful message if Leaflet failed to load from CDN
if (typeof L === 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
        var mapEl = document.getElementById('map');
        if (mapEl) {
            mapEl.style.cssText = 'display:flex;align-items:center;justify-content:center;' +
                'background:#060b13;color:#e8f0ff;font-family:system-ui;font-size:.9rem;' +
                'text-align:center;padding:2rem;position:fixed;inset:0;z-index:999;';
            mapEl.innerHTML = '<div><div style="font-size:2.5rem;margin-bottom:1rem">⚠️</div>' +
                '<strong style="font-size:1.1rem">Map library failed to load</strong><br><br>' +
                '<span style="color:#4a6a8a;font-size:.85rem">Check your internet connection and reload.</span><br>' +
                '<button onclick="location.reload()" style="margin-top:1.2rem;padding:.55rem 1.6rem;' +
                'background:#4f9eff;color:#fff;border:none;border-radius:8px;cursor:pointer;' +
                'font-size:.85rem;font-weight:600">Reload Page</button></div>';
        }
    });
    throw new Error('Leaflet (L) is not defined — CDN script failed to load.');
}

/* ── Canvas renderer ────────────────────────────────────────────── */
const CANVAS = L.canvas({ padding: 0.5, tolerance: 10 });

/* ── Map ────────────────────────────────────────────────────────── */
const map = L.map('map', {
    center: [22.5, 80.0],
    zoom: 5,
    zoomControl: false,
    minZoom: 4,
    maxZoom: 19,
    renderer: CANVAS,
    preferCanvas: true,
    tap: true,
    tapTolerance: 20,
    bounceAtZoomLimits: false,
    zoomSnap: 0.5,
    wheelDebounceTime: 40,
});

L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 110 }).addTo(map);

/* ── Map styles ─────────────────────────────────────────────────── */
const MAP_STYLE_DEFS = {
    liberty: {
        label: 'Liberty',
        engine: 'vector',
        style: 'https://tiles.openfreemap.org/styles/liberty',
        panelMeta: 'Detailed labels, roads, and places',
    },
    bright: {
        label: 'Bright',
        engine: 'vector',
        style: 'https://tiles.openfreemap.org/styles/bright',
        panelMeta: 'High-contrast road and city view',
    },
    positron: {
        label: 'Positron',
        engine: 'vector',
        style: 'https://tiles.openfreemap.org/styles/positron',
        panelMeta: 'Clean planning view for routes',
    },
    night: {
        label: 'Night',
        engine: 'raster',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        panelMeta: 'Low-glare night map for live tracking',
        options: {
            attribution: '© OpenStreetMap © CARTO',
            maxZoom: 19,
            subdomains: 'abcd',
            crossOrigin: true,
            keepBuffer: 4,
        },
    },
};

const BROWSER_ROUTING_BASE = 'https://routing.openstreetmap.de/routed-car';
const MAP_MODE_STORAGE_KEY = 'smartnav.mapMode';
const GPS_WARNING_MS = 12_000;
const GPS_STALE_MS = 22_000;
const GPS_RESTART_MS = 30_000;
const GPS_HEALTH_POLL_MS = 4_000;
const GPS_FOLLOW_IDLE_MS = 3_200;
const GPS_FOLLOW_NAV_IDLE_MS = 1_400;
const GPS_FOLLOW_MIN_MOVE_M = 12;
const GPS_FOLLOW_NAV_MIN_MOVE_M = 6;
const DEFAULT_FALLBACK_LOCATION = {
    lat: 28.6139,
    lon: 77.2090,
    label: 'New Delhi',
};

const _vectorAttribution = '© <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const _mapToggleBtn = document.getElementById('map-toggle-btn');
const _mapStylePanel = document.getElementById('map-style-panel');
const _mapStyleMeta = document.getElementById('map-style-meta');
const _mapStyleChips = Array.from(document.querySelectorAll('.map-style-chip'));

function _isKnownMapStyle(styleId) {
    return Object.prototype.hasOwnProperty.call(MAP_STYLE_DEFS, styleId);
}

function _readStoredMapMode() {
    try {
        const stored = window.localStorage.getItem(MAP_MODE_STORAGE_KEY);
        return _isKnownMapStyle(stored) ? stored : null;
    } catch (_) {
        return null;
    }
}

function _storeMapMode(styleId) {
    try {
        window.localStorage.setItem(MAP_MODE_STORAGE_KEY, styleId);
    } catch (_) {
        // Ignore private-mode/localStorage failures.
    }
}

let _mapMode = _readStoredMapMode() || 'night';
let _mapBaseLayer = null;
let _tileErrCount = 0;
let _tileFallbackInProgress = false;

function _buildMapBaseLayer(styleId) {
    const styleDef = MAP_STYLE_DEFS[styleId] || MAP_STYLE_DEFS.liberty;

    if (styleDef.engine === 'vector' && typeof L.maplibreGL === 'function') {
        return L.maplibreGL({
            style: styleDef.style,
            attribution: _vectorAttribution,
            noWrap: true,
        });
    }

    if (styleDef.engine === 'raster') {
        return L.tileLayer(styleDef.url, styleDef.options);
    }

    return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19,
        crossOrigin: true,
        keepBuffer: 4,
    });
}

function _syncMapStyleUi() {
    const styleDef = MAP_STYLE_DEFS[_mapMode] || MAP_STYLE_DEFS.night;
    if (_mapStyleMeta) {
        _mapStyleMeta.textContent = styleDef.panelMeta;
    }
    if (_mapToggleBtn) {
        const panelOpen = Boolean(_mapStylePanel && !_mapStylePanel.classList.contains('hidden'));
        _mapToggleBtn.title = `Map styles · ${styleDef.label}`;
        _mapToggleBtn.setAttribute('aria-label', `Open map styles. Current style: ${styleDef.label}`);
        _mapToggleBtn.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
        _mapToggleBtn.classList.toggle('is-active', panelOpen);
    }
    _mapStyleChips.forEach(chip => {
        const isActive = chip.dataset.styleId === _mapMode;
        chip.classList.toggle('active', isActive);
        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function _closeMapStylePanel() {
    if (_mapStylePanel) {
        _mapStylePanel.classList.add('hidden');
    }
    _syncMapStyleUi();
}

function _toggleMapStylePanel() {
    if (!_mapStylePanel) {
        return;
    }
    _mapStylePanel.classList.toggle('hidden');
    _syncMapStyleUi();
}

function _applyMapStyle(styleId) {
    const nextStyleId = _isKnownMapStyle(styleId) ? styleId : 'night';
    const styleDef = MAP_STYLE_DEFS[nextStyleId];

    if (_mapBaseLayer) {
        try {
            map.removeLayer(_mapBaseLayer);
        } catch (_) { }
        _mapBaseLayer = null;
    }

    _tileErrCount = 0;
    _mapMode = nextStyleId;
    _storeMapMode(_mapMode);
    _mapBaseLayer = _buildMapBaseLayer(_mapMode);
    _mapBaseLayer.addTo(map);

    if (styleDef.engine === 'raster' && _mapBaseLayer?.on) {
        _mapBaseLayer.on('tileerror', () => {
            if (_tileFallbackInProgress) return;
            _tileErrCount++;
            if (_tileErrCount > 5) {
                _tileFallbackInProgress = true;
                _applyMapStyle('liberty');
            }
        });
    }

    _syncMapStyleUi();
}

if (_mapToggleBtn) {
    _mapToggleBtn.addEventListener('click', event => {
        event.stopPropagation();
        _toggleMapStylePanel();
    });
}

_mapStyleChips.forEach(chip => {
    chip.addEventListener('click', event => {
        event.stopPropagation();
        _applyMapStyle(chip.dataset.styleId || 'liberty');
        _closeMapStylePanel();
    });
});

document.addEventListener('click', event => {
    const clickedInsidePanel = _mapStylePanel?.contains(event.target);
    const clickedToggle = _mapToggleBtn?.contains(event.target);
    if (!clickedInsidePanel && !clickedToggle) {
        _closeMapStylePanel();
    }
});

map.on('click', () => _closeMapStylePanel());
_applyMapStyle(_mapMode);

window.addEventListener('resize', () => {
    clearTimeout(window._resizeT);
    window._resizeT = setTimeout(() => map.invalidateSize({ animate: false }), 80);
});
setTimeout(() => map.invalidateSize(), 300);

/* ── Route visuals ────────────────────────────────────────────── */
const ROUTE_STYLE_LIBRARY = {
    best: {
        name: 'Best Route', badgeCls: 'badge-r1', cardAccent: '#00e676',
        fill: '#00e676', border: '#002d14',
        fw: 7, bw: 13, fo: 1.0, bo: 0.75, scanFo: 0.28, scanBo: 0.14,
        glow: 'rgba(0,230,118,0.55)', drawColor: '#00ff88',
    },
    fastest: {
        name: 'Fastest', badgeCls: 'badge-r2', cardAccent: '#4fc3f7',
        fill: '#4fc3f7', border: '#002a45',
        fw: 5, bw: 10, fo: 0.76, bo: 0.45, scanFo: 0.30, scanBo: 0.16,
        glow: 'rgba(79,195,247,0.40)', drawColor: '#4fc3f7',
    },
    shortest: {
        name: 'Shortcut', badgeCls: 'badge-r3', cardAccent: '#ffb300',
        fill: '#ffb300', border: '#3a2200',
        fw: 5, bw: 10, fo: 0.72, bo: 0.42, scanFo: 0.28, scanBo: 0.14,
        glow: 'rgba(255,179,0,0.38)', drawColor: '#ffb300',
    },
    alternate: {
        name: 'Alternate', badgeCls: 'badge-r4', cardAccent: '#ff5252',
        fill: '#ff5252', border: '#3a0000',
        fw: 4, bw: 9, fo: 0.68, bo: 0.38, scanFo: 0.25, scanBo: 0.12,
        glow: 'rgba(255,82,82,0.35)', drawColor: '#ff5252',
    },
    safest: {
        name: 'Safest', badgeCls: 'badge-r5', cardAccent: '#ea80fc',
        fill: '#ea80fc', border: '#2a0038',
        fw: 4, bw: 9, fo: 0.64, bo: 0.34, scanFo: 0.22, scanBo: 0.10,
        glow: 'rgba(234,128,252,0.32)', drawColor: '#ea80fc',
    },
};

const ROUTE_OFFSET_PATTERN_M = [0, 14, -14, 24, -24];

function _routeOffsetMeters(index) {
    if (index < ROUTE_OFFSET_PATTERN_M.length) {
        return ROUTE_OFFSET_PATTERN_M[index];
    }
    const magnitude = 24 + (Math.floor((index - ROUTE_OFFSET_PATTERN_M.length + 2) / 2) * 10);
    return index % 2 === 0 ? -magnitude : magnitude;
}

function _routeHasTag(route, tag) {
    return Array.isArray(route?.tags) && route.tags.includes(tag);
}

function _routeLabelForRole(role, alternateIndex = 1) {
    switch (role) {
        case 'best':
            return 'Best Route';
        case 'fastest':
            return 'Fastest';
        case 'shortest':
            return 'Shortcut';
        case 'safest':
            return 'Safest';
        default:
            return alternateIndex > 1 ? `Alternate ${alternateIndex}` : 'Alternate';
    }
}

function _decorateRouteVisuals(routes) {
    const usedRoles = new Set();
    let alternateCount = 0;

    return routes.map((route, index) => {
        let role = 'alternate';

        if (index === 0 || route.recommended || _routeHasTag(route, 'best')) {
            role = 'best';
            usedRoles.add(role);
        } else {
            const preferredRoles = [];
            if (_routeHasTag(route, 'fastest')) preferredRoles.push('fastest');
            if (_routeHasTag(route, 'shortest')) preferredRoles.push('shortest');
            if (_routeHasTag(route, 'safest')) preferredRoles.push('safest');
            preferredRoles.push('alternate');

            role = preferredRoles.find(candidate => !usedRoles.has(candidate)) || 'alternate';
            usedRoles.add(role);
        }

        const base = ROUTE_STYLE_LIBRARY[role] || ROUTE_STYLE_LIBRARY.alternate;
        if (role === 'alternate') {
            alternateCount += 1;
        }

        route._visualRole = role;
        route._label = _routeLabelForRole(role, alternateCount || 1);
        route._visual = {
            ...base,
            name: route._label,
            offsetMeters: _routeOffsetMeters(index),
        };
        return route;
    });
}

const POI_ICONS = {
    restaurant: '🍽️', food: '🍽️', cafe: '☕', coffee: '☕',
    fast_food: '🍔', bakery: '🥐', ice_cream: '🍦', bar: '🍺', pub: '🍺',
    mobile: '📱', mobile_phone: '📱', phone: '📱', telecommunication: '📡',
    electronics: '🖥️', computer: '💻',
    shop: '🛒', mall: '🏬', supermarket: '🛒', grocery: '🛒',
    convenience: '🏪', department_store: '🏬', marketplace: '🏪',
    clothes: '👗', fashion: '👗', shoes: '👟', jewellery: '💍', jewelry: '💍',
    hardware: '🔧', furniture: '🪑',
    bank: '🏦', atm: '🏧',
    hospital: '🏥', clinic: '🏥', pharmacy: '💊', chemist: '💊',
    doctors: '👨‍⚕️', dentist: '🦷', optician: '👓', laboratory: '🔬',
    school: '🏫', college: '🎓', university: '🎓', library: '📚',
    fuel: '⛽', petrol: '⛽', charging_station: '⚡',
    hotel: '🏨', guest_house: '🏠', hostel: '🏠',
    park: '🌳', garden: '🌻',
    gym: '💪', fitness_centre: '💪', sports_centre: '⚽', stadium: '🏟️',
    swimming_pool: '🏊', spa: '💆',
    cinema: '🎬', theatre: '🎭',
    place_of_worship: '🛕', temple: '🛕', mosque: '🕌', church: '⛪',
    police: '👮', post_office: '📮', parking: '🅿️', fire_station: '🚒',
    bus_stop: '🚌', bus_station: '🚌', station: '🚉', railway: '🚉', metro: '🚇',
    taxi: '🚕', aerodrome: '✈️',
    hairdresser: '💇', beauty: '💄', barber: '💈',
    tailor: '🧵', laundry: '👕',
    car_repair: '🔧', bicycle: '🚲',
    books: '📚', stationery: '📝', toys: '🧸',
    sports: '⚽', photo: '📷', copyshop: '🖨️',
    townhall: '🏛️', courthouse: '⚖️',
    default: '📍',
};

/* ================================================================
   KALMAN FILTER — 1-D position smoother
================================================================ */
class KalmanFilter1D {
    constructor(Q = 1e-5, R = 4e-8) {
        this.Q = Q;
        this.R = R;
        this.P = 1.0;
        this.x = null;
    }

    update(measurement) {
        if (this.x === null) { this.x = measurement; return measurement; }
        this.P += this.Q;
        const K = this.P / (this.P + this.R);
        this.x += K * (measurement - this.x);
        this.P *= (1 - K);
        return this.x;
    }

    setAccuracy(acc) {
        this.R = Math.pow(acc / 111320, 2);
        this.R = Math.max(1e-10, Math.min(this.R, 1e-5));
    }

    reset() { this.x = null; this.P = 1.0; }
}

const _kfLat = new KalmanFilter1D(2.5e-5, 4e-8); // tuned for India road speeds
const _kfLon = new KalmanFilter1D(2.5e-5, 4e-8);

/* ── State ──────────────────────────────────────────────────────── */
let userLat = null;
let userLon = null;
let userHeading = null;
let _rawHeading = null;
let userSpeedKmh = 0;
let userMarker = null;
let userAccuracyRing = null;
let destMarker = null;
let destPulseRing = null;
let routeGrps = [];
let poiMarkers = [];
let _lastBounds = null;
let _poiBounds = null;
let _firstFix = true;
let _gpsWatchId = null;
let _suggestAbort = null;
let _suggestTimer = null;
let _selectedDestination = null;
let _lastGpsTs = null;
let _prevRawLat = null;
let _prevRawLon = null;
let _lastFixAccuracy = null;
let _gpsHealthTimer = null;
let _gpsPermissionState = 'prompt';
let _gpsWatching = false;
let _gpsUsingFallback = false;
let _lastFollowLat = null;
let _lastFollowLon = null;
let _lastFollowTs = 0;
let _lastGpsRestartTs = 0;

/* ── SVG renderer pools (track for DOM cleanup) ─────────────────── */
// Tracer renderers are temporary (animation only); route renderers are permanent
let _tracerRenderers = [];
let _routeRenderers = [];

/* ── Scan animation state ───────────────────────────────────────── */
let _scanCircle = null;
let _scanTracer = null;
let _scanRings = [];
let _scanDotMarker = null;   // promoted from local to module-level to allow cleanup
let _scanDotTimer = null;
let _scanStepTimer = null;

/* ── NAVIGATION state ───────────────────────────────────────────── */
let _navActive = false;
let _navRouteIdx = 0;
let _navLls = [];
let _navArrow = null;
let _navArrowTrail = null;
let _navTravelledLls = [];
let _navRemainLine = null;
let _navDestLat = null;
let _navDestLon = null;
let _navOffRouteCount = 0;
let _navCentering = true;
let _navSpeedHistory = [];
let _navRouteLabel = 'Route';
let _lastNavPauseToastTs = 0;
let _navCameraLockUntil = 0;

/* ── DOM refs ───────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const searchForm = $('search-form');
const destInput = $('dest-input');
const navBtn = $('nav-btn');
const clearBtn = $('clear-btn');
const gpsPill = $('gps-pill');
const loader = $('loader');
const loaderStep = $('loader-step');
const loaderProg = $('loader-progress-fill');
const errorBox = $('error-msg');
const infoBox = $('info-msg');
const routePanel = $('route-panel');
const cardsWrap = $('cards-wrap');
const gpsHUD = $('gps-coords');
const closePanel = $('close-panel');
const panelExpand = $('panel-expand');
const routeBadge = $('route-count-badge');
const scanEl = $('scan-status');
const legendEl = $('map-legend');
const legendItems = $('legend-items');
const suggestList = $('suggestions-list');
const httpsBanner = $('https-banner');
const httpsCloseBtn = $('https-close-btn');
const mapStylePanel = $('map-style-panel');
const locPrompt = $('location-prompt');
const lpAllow = $('lp-allow');
const lpDeny = $('lp-deny');
const poiPanel = $('poi-panel');
const poiList = $('poi-list');
const poiClose = $('poi-close');
const poiTitle = $('poi-title');
const poiCount = $('poi-count');
const myLocBtn = $('my-location-btn');
const routeOverviewBtn = $('route-overview-btn');
const navHUD = $('nav-hud');
const navHudDist = $('nav-hud-dist');
const navHudTime = $('nav-hud-time');
const navHudStreet = $('nav-hud-street');
const navFollowBtn = $('nav-follow-btn');
const navStopBtn = $('nav-stop-btn');
const navSpeedVal = $('nav-speed-val');
const navDirArrow = $('nav-direction-arrow');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _updateOverviewButtonVisibility() {
    if (!routeOverviewBtn) {
        return;
    }
    const hasOverview = Boolean((_lastBounds && _lastBounds.isValid?.()) || (_poiBounds && _poiBounds.isValid?.()));
    routeOverviewBtn.classList.toggle('hidden', !hasOverview);
}

function _fitActiveOverview() {
    if (_lastBounds?.isValid?.()) {
        fitBoundsNow(_lastBounds, routePanel?.classList.contains('show'), false);
        return;
    }
    if (_poiBounds?.isValid?.()) {
        fitBoundsNow(_poiBounds, false, true);
        return;
    }
    if (userLat !== null && userLon !== null) {
        map.flyTo([userLat, userLon], Math.max(map.getZoom(), 15), { duration: 0.9 });
    }
}

function _syncFloatingUiState() {
    const routeSheetOpen = Boolean(routePanel?.classList.contains('show') && !_navActive);
    const poiSheetOpen = Boolean(poiPanel && !poiPanel.classList.contains('hidden'));

    document.body.classList.toggle('route-sheet-open', routeSheetOpen);
    document.body.classList.toggle('poi-sheet-open', poiSheetOpen);

    if ((routeSheetOpen || poiSheetOpen) && mapStylePanel && !mapStylePanel.classList.contains('hidden')) {
        mapStylePanel.classList.add('hidden');
        _syncMapStyleUi();
    }
}

function _syncNavControls() {
    if (!navFollowBtn) {
        return;
    }

    const isFollowing = _navActive && _navCentering;
    navFollowBtn.disabled = !_navActive || (isFollowing && userLat !== null && userLon !== null);
    navFollowBtn.classList.toggle('is-following', isFollowing);
    navFollowBtn.textContent = isFollowing ? 'Following Route' : 'Resume Follow';
    navFollowBtn.setAttribute(
        'aria-label',
        isFollowing ? 'Map is following your route' : 'Resume map follow',
    );
}

function _setNavCameraLock(ms = 1400) {
    _navCameraLockUntil = Date.now() + ms;
}

function _navCameraLocked() {
    return Date.now() < _navCameraLockUntil;
}

function _resetFollowState() {
    _lastFollowLat = null;
    _lastFollowLon = null;
    _lastFollowTs = 0;
}

function _formatGpsAccuracy(acc) {
    if (!Number.isFinite(acc) || acc <= 0 || acc >= 9999) {
        return '>999m';
    }
    return `±${Math.round(acc)}m`;
}

function _formatGpsAge(ageMs) {
    if (!Number.isFinite(ageMs) || ageMs <= 0) {
        return 'just now';
    }
    const seconds = Math.round(ageMs / 1000);
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    const minutes = Math.round(seconds / 60);
    return `${minutes}m ago`;
}

function _gpsLevelForAccuracy(acc) {
    if (!Number.isFinite(acc) || acc >= 150) {
        return 'error';
    }
    if (acc >= 40) {
        return 'medium';
    }
    return 'ok';
}

function _renderGpsHud(lat, lon, acc, statusText, statusLevel = '') {
    if (!gpsHUD) {
        return;
    }

    const safeLat = Number.isFinite(lat) ? Number(lat).toFixed(6) : '—';
    const safeLon = Number.isFinite(lon) ? Number(lon).toFixed(6) : '—';
    const speedText = `${Math.round(userSpeedKmh || 0)}km/h`;

    gpsHUD.className = statusLevel || '';
    gpsHUD.innerHTML =
        `<span class="hud-lbl">LAT</span> ${safeLat}\n` +
        `<span class="hud-lbl">LON</span> ${safeLon}\n` +
        `<span class="hud-acc">${statusText || `${_formatGpsAccuracy(acc)} · ${speedText}`}</span>`;
}

function _setGpsUi(label, state, title, hudStatus, lat = userLat, lon = userLon, acc = _lastFixAccuracy) {
    if (gpsPill) {
        gpsPill.title = title || 'GPS status';
    }
    setGpsPill(label, state);
    _renderGpsHud(lat, lon, acc, hudStatus, state);
}

function _startGpsHealthMonitor() {
    if (_gpsHealthTimer !== null) {
        return;
    }
    _gpsHealthTimer = window.setInterval(_refreshGpsHealth, GPS_HEALTH_POLL_MS);
    _refreshGpsHealth();
}

function _stopGpsHealthMonitor() {
    if (_gpsHealthTimer !== null) {
        window.clearInterval(_gpsHealthTimer);
        _gpsHealthTimer = null;
    }
}

function _stopWatchingGPS() {
    if (_gpsWatchId !== null && navigator.geolocation?.clearWatch) {
        navigator.geolocation.clearWatch(_gpsWatchId);
    }
    _gpsWatchId = null;
    _gpsWatching = false;
}

function _restartGPSWatch(reason = '') {
    if (!navigator.geolocation || _gpsPermissionState === 'denied') {
        return;
    }

    const now = Date.now();
    if (now - _lastGpsRestartTs < 15_000) {
        return;
    }

    _lastGpsRestartTs = now;
    if (reason) {
        console.warn(`Restarting GPS watch: ${reason}`);
    }
    _stopWatchingGPS();
    _startWatchingGPS(true);
}

function _shouldUpdateFollowCenter(lat, lon, now, navMode) {
    if (_lastFollowLat === null || _lastFollowLon === null || !_lastFollowTs) {
        return true;
    }

    const movedM = _haversineJS(_lastFollowLat, _lastFollowLon, lat, lon);
    const maxIdleMs = navMode ? GPS_FOLLOW_NAV_IDLE_MS : GPS_FOLLOW_IDLE_MS;
    const minMoveM = navMode ? GPS_FOLLOW_NAV_MIN_MOVE_M : GPS_FOLLOW_MIN_MOVE_M;
    return movedM >= minMoveM || (now - _lastFollowTs) >= maxIdleMs;
}

function _updateFollowView(lat, lon, { navMode = false, force = false, zoom = null, now = Date.now() } = {}) {
    if (!_navCentering) {
        return;
    }

    if (!force && !_shouldUpdateFollowCenter(lat, lon, now, navMode)) {
        return;
    }

    _lastFollowLat = lat;
    _lastFollowLon = lon;
    _lastFollowTs = now;

    const targetZoom = Number.isFinite(zoom) ? zoom : map.getZoom();
    const currentZoom = map.getZoom();

    if (force && Math.abs(targetZoom - currentZoom) > 0.2) {
        if (navMode) {
            _setNavCameraLock();
        }
        map.flyTo([lat, lon], targetZoom, {
            duration: navMode ? 0.85 : 1.0,
            easeLinearity: 0.4,
        });
        return;
    }

    map.panTo([lat, lon], {
        animate: true,
        duration: navMode ? 0.35 : 0.5,
        easeLinearity: navMode ? 0.6 : 0.5,
    });
}

function _refreshGpsHealth() {
    if (_gpsUsingFallback) {
        _setGpsUi(
            '📍 Default city',
            'medium',
            `Live GPS unavailable. Using ${DEFAULT_FALLBACK_LOCATION.label} as the fallback center.`,
            `DEFAULT · ${DEFAULT_FALLBACK_LOCATION.label}`,
            userLat,
            userLon,
            null,
        );
        return;
    }

    if (_lastGpsTs === null) {
        if (_gpsPermissionState === 'denied') {
            _setGpsUi(
                '⚠ GPS blocked',
                'error',
                'Location permission is blocked in the browser.',
                userLat !== null ? 'LAST FIX · permission blocked' : 'GPS BLOCKED',
            );
        } else {
            _setGpsUi(
                '⌛ Locating…',
                'loading',
                'Waiting for a live GPS fix.',
                userLat !== null ? 'SEARCHING AGAIN' : 'SEARCHING GPS',
            );
        }
        return;
    }

    const ageMs = Date.now() - _lastGpsTs;
    if (ageMs >= GPS_STALE_MS) {
        const ageLabel = _formatGpsAge(ageMs);
        const accuracyLabel = _formatGpsAccuracy(_lastFixAccuracy);
        _setGpsUi(
            `⌛ ${ageLabel}`,
            'error',
            `GPS fix is stale. Last update was ${ageLabel}.`,
            `STALE · ${accuracyLabel}`,
        );

        if (ageMs >= GPS_RESTART_MS) {
            _restartGPSWatch('stale location data');
        }
        return;
    }

    if (ageMs >= GPS_WARNING_MS) {
        const accuracyLabel = _formatGpsAccuracy(_lastFixAccuracy);
        const level = _gpsLevelForAccuracy(_lastFixAccuracy);
        _setGpsUi(
            `📡 ${accuracyLabel}`,
            level,
            `Live GPS updated ${_formatGpsAge(ageMs)}.`,
            `LIVE · ${accuracyLabel} · ${_formatGpsAge(ageMs)}`,
        );
    }
}

function _normalizeDestinationText(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function _clearSelectedDestination() {
    _selectedDestination = null;
}

function _rememberSelectedDestination(label, lat, lon, query = label) {
    const destLat = Number(lat);
    const destLon = Number(lon);
    if (!Number.isFinite(destLat) || !Number.isFinite(destLon)) {
        _clearSelectedDestination();
        return;
    }
    _selectedDestination = {
        label: String(label || query || '').trim(),
        query: String(query || label || '').trim(),
        lat: destLat,
        lon: destLon,
    };
}

function _getSelectedDestinationForQuery(query) {
    if (!_selectedDestination) {
        return null;
    }

    const normalizedQuery = _normalizeDestinationText(query);
    const matchesQuery = normalizedQuery === _normalizeDestinationText(_selectedDestination.query);
    const matchesLabel = normalizedQuery === _normalizeDestinationText(_selectedDestination.label);
    return matchesQuery || matchesLabel ? _selectedDestination : null;
}

/* ── Custom marker icons ────────────────────────────────────────── */
const userIcon = L.divIcon({
    className: '',
    html: `<div class="m-user"><div class="m-pulse"></div><div class="m-dot"></div></div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
});

function makeNavArrowIcon(heading, offRoute) {
    const deg = (heading != null && isFinite(heading)) ? heading : 0;
    const cls = offRoute ? 'off-route' : '';
    return L.divIcon({
        className: '',
        html: `<div class="m-nav-arrow ${cls}" style="transform:rotate(${deg}deg)">
             <div class="m-nav-chevron"></div>
           </div>`,
        iconSize: [44, 44], iconAnchor: [22, 22],
    });
}

const destIcon = L.divIcon({
    className: '',
    html: `<div class="m-dest"><div class="m-dest-pin"></div></div>`,
    iconSize: [28, 38], iconAnchor: [14, 38],
});

function makePOIIcon(type) {
    const emoji = POI_ICONS[type] || POI_ICONS.default;
    return L.divIcon({
        className: '',
        html: `<div class="m-poi"><span class="m-poi-emoji">${emoji}</span></div>`,
        iconSize: [34, 34], iconAnchor: [17, 34],
    });
}

/* ================================================================
   BEARING UTILITIES
================================================================ */

function _bearingDeg(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function _angleDiff(a, b) {
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

function _smoothBearing(current, raw, alpha = 0.25) {
    if (current === null) return raw;
    const diff = _angleDiff(current, raw);
    return (current + alpha * diff + 360) % 360;
}

function _bearingToDirection(deg) {
    const dirs = ['↑ North', '↗ NE', '→ East', '↘ SE', '↓ South', '↙ SW', '← West', '↖ NW'];
    return dirs[Math.round(deg / 45) % 8];
}

function _updateDirectionArrow(heading) {
    if (!navDirArrow) return;
    navDirArrow.style.transform = `rotate(${heading}deg)`;
    navDirArrow.textContent = '';
}

function _resumeNavigationFollow(showToast = false) {
    if (!_navActive || userLat === null || userLon === null) {
        return;
    }

    _navCentering = true;
    _resetFollowState();
    _updateFollowView(userLat, userLon, {
        navMode: true,
        force: true,
        zoom: Math.max(map.getZoom(), 17),
    });
    _syncNavControls();

    if (showToast) {
        showInfo(`Following ${_navRouteLabel}.`, 2200);
    }
}

/* ================================================================
   GPS / Location
================================================================ */

function initGPS() {
    if (!navigator.geolocation) {
        _gpsPermissionState = 'denied';
        _setGpsUi(
            'No GPS',
            'error',
            'This browser does not support geolocation.',
            'GPS NOT SUPPORTED',
            null,
            null,
            null,
        );
        fallbackGPS('This browser does not support live GPS. Using New Delhi as the fallback center.');
        return;
    }

    _startGpsHealthMonitor();

    if (navigator.permissions?.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(status => {
            _gpsPermissionState = status.state;
            status.onchange = () => {
                _gpsPermissionState = status.state;

                if (status.state === 'granted') {
                    if (locPrompt) {
                        locPrompt.classList.add('hidden');
                    }
                    _startWatchingGPS(true);
                    return;
                }

                if (status.state === 'denied' && userLat === null) {
                    if (locPrompt) {
                        locPrompt.classList.add('hidden');
                    }
                    fallbackGPS('Location permission is blocked in the browser. Using New Delhi as the fallback center.');
                }
            };

            if (status.state === 'granted') {
                _startWatchingGPS(true);
                return;
            }

            if (status.state === 'denied') {
                if (locPrompt) {
                    locPrompt.classList.add('hidden');
                }

                if (userLat === null) {
                    fallbackGPS('Location permission is blocked in the browser. Using New Delhi as the fallback center.');
                } else {
                    _setGpsUi(
                        '⚠ GPS blocked',
                        'error',
                        'Location permission was denied. Showing your last known position.',
                        'LAST FIX · permission blocked',
                    );
                }
                return;
            }

            if (locPrompt) {
                locPrompt.classList.remove('hidden');
            } else {
                _startWatchingGPS();
            }
        }).catch(() => {
            if (locPrompt) {
                locPrompt.classList.remove('hidden');
            } else {
                _startWatchingGPS();
            }
        });
        return;
    }

    if (locPrompt) {
        locPrompt.classList.remove('hidden');
    } else {
        _startWatchingGPS();
    }
}

if (lpAllow) lpAllow.addEventListener('click', () => {
    _gpsPermissionState = 'prompt';
    locPrompt.classList.add('hidden');
    _startWatchingGPS(true);
});
if (lpDeny) lpDeny.addEventListener('click', () => {
    locPrompt.classList.add('hidden');
    fallbackGPS(`Live GPS was skipped. Using ${DEFAULT_FALLBACK_LOCATION.label} as the fallback center.`);
});
if (httpsCloseBtn) httpsCloseBtn.addEventListener('click', () => {
    if (httpsBanner) {
        httpsBanner.classList.add('hidden');
        document.body.classList.remove('has-banner');
    }
});

function _startWatchingGPS(forceRestart = false) {
    if (_gpsWatching && !forceRestart) {
        return;
    }

    _startGpsHealthMonitor();
    _stopWatchingGPS();
    _gpsWatching = true;
    _gpsUsingFallback = false;
    _setGpsUi('⌛ Locating…', 'loading', 'Searching for a live GPS fix.', 'SEARCHING GPS');
    _kfLat.reset();
    _kfLon.reset();

    // Respect GPS accuracy mode from settings
    let highAccuracy = true;
    try {
        const p = JSON.parse(localStorage.getItem('smartnav.prefs.v2') || '{}');
        highAccuracy = p.gpsMode !== 'low';
        // Balance mode uses high accuracy but with slightly more maxAge
    } catch(_) {}

    navigator.geolocation.getCurrentPosition(onGPSFix, onGPSError, {
        enableHighAccuracy: false, timeout: 8000, maximumAge: 10000,
    });

    _gpsWatchId = navigator.geolocation.watchPosition(onGPSFix, onGPSError, {
        enableHighAccuracy: highAccuracy,
        timeout: 15000,
        maximumAge: highAccuracy ? 0 : 2000,
    });
}

function onGPSFix(pos) {
    const rawLat = pos.coords.latitude;
    const rawLon = pos.coords.longitude;
    const now = pos.timestamp || Date.now();

    let acc = pos.coords.accuracy;
    if (!isFinite(acc) || acc <= 0 || acc > 50000) acc = 9999;

    if (acc > 2000 && userLat !== null) {
        const weakAcc = _formatGpsAccuracy(acc);
        _setGpsUi(
            `📶 ${weakAcc}`,
            'loading',
            `GPS signal is weak (${weakAcc}). Keeping the last reliable position on the map.`,
            `WEAK FIX · ${weakAcc}`,
        );
        return;
    }

    // Respect Kalman smoothing preference
    let lat = rawLat, lon = rawLon;
    try {
        const p = JSON.parse(localStorage.getItem('smartnav.prefs.v2') || '{}');
        if (p.kalmanSmoothing !== false) {
            _kfLat.setAccuracy(Math.min(acc, 300));
            _kfLon.setAccuracy(Math.min(acc, 300));
            lat = _kfLat.update(rawLat);
            lon = _kfLon.update(rawLon);
        }
    } catch(_) {
        _kfLat.setAccuracy(Math.min(acc, 300));
        _kfLon.setAccuracy(Math.min(acc, 300));
        lat = _kfLat.update(rawLat);
        lon = _kfLon.update(rawLon);
    }

    const gpsSpeed = pos.coords.speed;
    const gpsHeading = pos.coords.heading;

    let speedKmh = 0;
    if (gpsSpeed !== null && gpsSpeed !== undefined && isFinite(gpsSpeed) && gpsSpeed >= 0) {
        speedKmh = gpsSpeed * 3.6;
    } else if (_prevRawLat !== null && _lastGpsTs !== null) {
        const dt = (now - _lastGpsTs) / 1000;
        if (dt > 0 && dt < 60) {
            const dm = _haversineJS(_prevRawLat, _prevRawLon, rawLat, rawLon);
            speedKmh = (dm / dt) * 3.6;
        }
    }
    speedKmh = Math.min(speedKmh, 200);

    _navSpeedHistory.push(speedKmh);
    if (_navSpeedHistory.length > 8) _navSpeedHistory.shift();
    // Use median for speed to reject GPS outlier spikes
    const _sortedSpd = [..._navSpeedHistory].sort((a,b)=>a-b);
    const _mid = Math.floor(_sortedSpd.length/2);
    userSpeedKmh = _sortedSpd.length%2 ? _sortedSpd[_mid] : (_sortedSpd[_mid-1]+_sortedSpd[_mid])/2;

    let rawBearing = null;
    if (gpsHeading !== null && gpsHeading !== undefined && isFinite(gpsHeading) && !isNaN(gpsHeading) && speedKmh > 0.5) {
        rawBearing = gpsHeading;
    } else if (_prevRawLat !== null &&
        (Math.abs(rawLat - _prevRawLat) > 1e-6 || Math.abs(rawLon - _prevRawLon) > 1e-6)) {
        rawBearing = _bearingDeg(_prevRawLat, _prevRawLon, rawLat, rawLon);
    }

    if (rawBearing !== null) {
        _rawHeading = rawBearing;
        // Adaptive alpha: fast movement → trust GPS heading more, slow → gentle smooth
        const alpha = userSpeedKmh > 60 ? 0.65
                    : userSpeedKmh > 30 ? 0.45
                    : userSpeedKmh > 5  ? 0.28
                    : 0.15;
        userHeading = _smoothBearing(userHeading, rawBearing, alpha);
    }

    _prevRawLat = rawLat;
    _prevRawLon = rawLon;
    _lastGpsTs = now;
    _lastFixAccuracy = acc;
    _gpsPermissionState = 'granted';
    _gpsUsingFallback = false;

    userLat = lat;
    userLon = lon;

    const accDisplay = _formatGpsAccuracy(acc);
    const pillClass = _gpsLevelForAccuracy(acc);
    const pillIcon = pillClass === 'ok' ? '📡' : pillClass === 'medium' ? '📍' : '📶';
    _setGpsUi(
        `${pillIcon} ${accDisplay}`,
        pillClass,
        `Live GPS fix • accuracy ${accDisplay} • updated just now.`,
        `LIVE · ${accDisplay} · ${Math.round(userSpeedKmh)}km/h`,
        lat,
        lon,
        acc,
    );

    if (!userMarker) {
        userMarker = L.marker([lat, lon], {
            icon: userIcon, zIndexOffset: 4000, title: 'Your Location',
        }).addTo(map).bindPopup(buildLocationPopup(lat, lon, acc), { maxWidth: 240 });

        if (_firstFix) {
            _firstFix = false;
            map.flyTo([lat, lon], 15, { duration: 1.6, easeLinearity: 0.4 });
        }
    } else {
        userMarker.setLatLng([lat, lon]);
        userMarker.setPopupContent(buildLocationPopup(lat, lon, acc));
    }

    const ringRadius = Math.max(18, Math.min(acc, 180));
    if (!userAccuracyRing) {
        userAccuracyRing = L.circle([lat, lon], {
            renderer: CANVAS,
            radius: ringRadius,
            color: '#4f9eff',
            weight: 1.2,
            opacity: 0.35,
            fillColor: '#4f9eff',
            fillOpacity: 0.08,
            interactive: false,
        }).addTo(map);
    } else {
        userAccuracyRing.setLatLng([lat, lon]);
        userAccuracyRing.setRadius(ringRadius);
    }

    if (!_navActive && _navCentering) {
        _updateFollowView(lat, lon, { now });
    }

    if (_navActive) {
        _onNavGPSUpdate(lat, lon, acc);
    }
}

function buildLocationPopup(lat, lon, acc) {
    const accStr = (!isFinite(acc) || acc >= 9999) ? '>999m' : `±${Math.round(acc)}m`;
    return `<div class="pop-inner">
    <div class="pop-title" style="color:#4f9eff">📍 Your Location</div>
    <div class="pop-row"><span>Latitude</span><span>${lat.toFixed(6)}°</span></div>
    <div class="pop-row"><span>Longitude</span><span>${lon.toFixed(6)}°</span></div>
    <div class="pop-row"><span>Accuracy</span><span>${accStr}</span></div>
    <div class="pop-row"><span>Speed</span><span>${Math.round(userSpeedKmh)} km/h</span></div>
  </div>`;
}

function onGPSError(err) {
    const msgs = { 1: 'Location permission denied.', 2: 'Position unavailable.', 3: 'GPS timed out.' };
    const message = msgs[err?.code] || 'GPS error.';
    const hasReliablePosition = userLat !== null && !_gpsUsingFallback;

    if (err?.code === 1) {
        _gpsPermissionState = 'denied';
    }

    if (hasReliablePosition) {
        _setGpsUi(
            err?.code === 1 ? '⚠ GPS blocked' : '⚠ Signal lost',
            'error',
            `${message} Showing the last known position until GPS recovers.`,
            `LAST FIX · ${_formatGpsAccuracy(_lastFixAccuracy)}`,
        );
        if (err?.code === 1) {
            showError('Location permission was denied. Keeping the last known position on the map.', 7000);
        } else if (err?.code === 3) {
            _restartGPSWatch('watchPosition timeout');
        }
        return;
    }

    _setGpsUi(
        '⚠ GPS off',
        'error',
        `${message} Using ${DEFAULT_FALLBACK_LOCATION.label} as the fallback center.`,
        `GPS OFF · ${DEFAULT_FALLBACK_LOCATION.label}`,
    );
    showError(`${message} Using ${DEFAULT_FALLBACK_LOCATION.label} as the fallback center.`, 8000);
    fallbackGPS(`${message} Using ${DEFAULT_FALLBACK_LOCATION.label} as the fallback center.`);
}

function fallbackGPS(reason = `Using ${DEFAULT_FALLBACK_LOCATION.label} as the fallback center.`) {
    if (userLat !== null && !_gpsUsingFallback) {
        return;
    }

    _gpsUsingFallback = true;
    _lastGpsTs = null;
    _lastFixAccuracy = null;
    userLat = DEFAULT_FALLBACK_LOCATION.lat;
    userLon = DEFAULT_FALLBACK_LOCATION.lon;

    _setGpsUi(
        '📍 Default city',
        'medium',
        reason,
        `DEFAULT · ${DEFAULT_FALLBACK_LOCATION.label}`,
        userLat,
        userLon,
        null,
    );

    if (_firstFix) {
        _firstFix = false;
        _resetFollowState();
        map.flyTo([userLat, userLon], 11, { duration: 1.1, easeLinearity: 0.4 });
    }
}

if (myLocBtn) myLocBtn.addEventListener('click', () => {
    _closeMapStylePanel();
    if (userLat !== null) {
        _navCentering = true;
        _resetFollowState();
        _updateFollowView(userLat, userLon, {
            force: true,
            zoom: Math.max(map.getZoom(), _gpsUsingFallback ? 11 : 16),
        });
        if (userMarker) userMarker.openPopup();
    } else {
        showError('Location not yet available. Please allow location access.', 4000);
        if (locPrompt) locPrompt.classList.remove('hidden');
    }
});
if (routeOverviewBtn) routeOverviewBtn.addEventListener('click', () => {
    if (mapStylePanel && !mapStylePanel.classList.contains('hidden')) {
        mapStylePanel.classList.add('hidden');
    }
    _fitActiveOverview();
});

/* ── Clean up GPS watch on page unload ──────────────────────────── */
window.addEventListener('beforeunload', () => {
    _stopGpsHealthMonitor();
    _stopWatchingGPS();
});

/* ================================================================
   LIVE NAVIGATION ENGINE
================================================================ */

function startNavigation(routeIdx) {
    const grp = routeGrps[routeIdx];
    if (!grp || !grp.lls || grp.lls.length < 2) {
        showError('Cannot start navigation — route not available.'); return;
    }

    stopNavigation(false);
    _closeMapStylePanel();

    _navActive = true;
    document.body.classList.add('nav-mode');
    _navRouteIdx = routeIdx;
    _navLls = grp.lls.slice();
    _navTravelledLls = [];
    _navOffRouteCount = 0;
    _navCentering = true;
    _resetFollowState();
    _navRouteLabel = grp.routeLabel || grp.pal?.name || 'Route';
    _navDestLat = _navLls[_navLls.length - 1][0];
    _navDestLon = _navLls[_navLls.length - 1][1];
    _navSpeedHistory = [];
    _syncFloatingUiState();
    _syncNavControls();

    routeGrps.forEach((g, i) => {
        if (i === routeIdx || g._glowOnly) return;
        g.fill.setStyle({ opacity: 0.12 });
        g.border.setStyle({ opacity: 0.08 });
    });

    grp.fill.setStyle({ color: '#00e676', opacity: 1.0, weight: grp.pal.fw + 2 });
    grp.border.setStyle({ color: '#001a0a', opacity: 0.9, weight: grp.pal.bw + 2 });
    grp.fill.bringToFront();
    grp.border.bringToFront();

    _navRemainLine = L.polyline(_navLls, {
        renderer: CANVAS, color: '#ffffff', weight: 3,
        opacity: 0.15, dashArray: '6 8',
        interactive: false, smoothFactor: 1.0,
    }).addTo(map);

    _navArrowTrail = L.polyline([[userLat ?? _navLls[0][0], userLon ?? _navLls[0][1]]], {
        renderer: CANVAS, color: '#00e676', weight: 5, opacity: 0.5,
        lineJoin: 'round', lineCap: 'round',
        interactive: false,
    }).addTo(map);

    const startLat = userLat ?? _navLls[0][0];
    const startLon = userLon ?? _navLls[0][1];
    _navArrow = L.marker([startLat, startLon], {
        icon: makeNavArrowIcon(userHeading || 0, false),
        zIndexOffset: 5000,
        interactive: false,
    }).addTo(map);

    if (navHUD) {
        navHUD.classList.add('show');
        navHUD.classList.remove('arrived');
    }
    if (navHudStreet) {
        navHudStreet.textContent = `Starting ${_navRouteLabel}…`;
    }

    _setNavCameraLock();
    map.flyTo([startLat, startLon], 16, { duration: 1.2 });
    _updateNavHUD(startLat, startLon);

    showInfo(`Navigation started on ${_navRouteLabel}. Follow the highlighted line.`, 4000);
}

function stopNavigation(showMsg = true) {
    if (!_navActive && !_navArrow) return;
    _navActive = false;
    document.body.classList.remove('nav-mode');

    if (_navArrow) { try { map.removeLayer(_navArrow); } catch (_) { } _navArrow = null; }
    if (_navArrowTrail) { try { map.removeLayer(_navArrowTrail); } catch (_) { } _navArrowTrail = null; }
    if (_navRemainLine) { try { map.removeLayer(_navRemainLine); } catch (_) { } _navRemainLine = null; }

    _navLls = []; _navTravelledLls = []; _navOffRouteCount = 0;
    _navSpeedHistory = [];
    _navRouteLabel = 'Route';
    _resetFollowState();
    _syncFloatingUiState();
    _syncNavControls();

    routeGrps.forEach((g) => {
        if (g._glowOnly) return;
        const pal = g.pal || ROUTE_STYLE_LIBRARY.best;
        const isBest = g.isBest;
        g.fill.setStyle({
            color: isBest ? '#00e676' : pal.fill,
            opacity: isBest ? 1.0 : pal.fo * 0.55,
            weight: pal.fw,
        });
        g.border.setStyle({
            opacity: isBest ? pal.bo : pal.bo * 0.4,
            weight: pal.bw,
        });
    });

    if (navHUD) {
        navHUD.classList.remove('show');
        navHUD.classList.remove('arrived');
    }
    if (showMsg) showInfo('Navigation stopped.', 3000);
    // Close 3D view if active
    if (typeof close3DView === 'function' && _3DM && _3DM.active) {
        close3DView();
        const nb = $('nav-3d-btn'); if (nb) nb.classList.remove('is-active');
    }
}

function _onNavGPSUpdate(lat, lon, acc) {
    if (!_navActive || !_navLls.length) return;

    if (_navArrow) {
        _navArrow.setLatLng([lat, lon]);
        if (userHeading !== null) {
            _navArrow.setIcon(makeNavArrowIcon(userHeading, false));
        }
    }

    if (userHeading !== null) _updateDirectionArrow(userHeading);

    if (navSpeedVal) navSpeedVal.textContent = Math.round(userSpeedKmh);

    _navTravelledLls.push([lat, lon]);
    if (_navTravelledLls.length > 1500) {
        _navTravelledLls.shift();
    }
    if (_navArrowTrail && _navTravelledLls.length >= 2) {
        _navArrowTrail.setLatLngs(_navTravelledLls);
    }

    if (_navCentering) {
        if (_navTravelledLls.length <= 2) {
            _updateFollowView(lat, lon, { navMode: true, force: true, zoom: Math.max(map.getZoom(), 17) });
        } else {
            _updateFollowView(lat, lon, { navMode: true });
        }
    }

    if (acc < 80) {
        const nearest = _nearestPointOnRoute(lat, lon, _navLls);
        const distToRoute = _haversineJS(lat, lon, nearest.lat, nearest.lon);
        if (distToRoute > 80) {
            _navOffRouteCount++;
            if (_navOffRouteCount >= 4) {
                _navOffRouteCount = 0;
                _promptReroute(lat, lon);
            }
        } else {
            _navOffRouteCount = 0;
        }
    }

    _updateNavHUD(lat, lon);

    const distToDest = _haversineJS(lat, lon, _navDestLat, _navDestLon);
    if (distToDest < 40) {
        _onNavArrived();
    }
}

function _updateNavHUD(lat, lon) {
    if (!navHUD || !_navLls.length) return;

    const distM = _remainingDistOnRoute(lat, lon, _navLls);
    const speedForEta = userSpeedKmh > 5 ? userSpeedKmh : 30;
    const timeMin = Math.max(1, Math.round((distM / 1000) / speedForEta * 60));

    if (navHudDist) navHudDist.textContent = distM < 1000
        ? `${Math.round(distM)}m` : `${(distM / 1000).toFixed(1)}km`;
    if (navHudTime) navHudTime.textContent = timeMin < 1 ? '<1 min' : `${timeMin} min`;
    if (navSpeedVal) navSpeedVal.textContent = Math.round(userSpeedKmh);

    const nearest = _nearestPointOnRoute(lat, lon, _navLls);
    const remaining = _navLls.slice(nearest.idx);
    if (remaining.length >= 2) {
        const lookAhead = Math.min(6, remaining.length - 1);
        const bearing = _bearingDeg(
            remaining[0][0], remaining[0][1],
            remaining[lookAhead][0], remaining[lookAhead][1]
        );
        const hudHeading = _smoothBearing(userHeading, bearing, 0.3);
        if (navHudStreet) navHudStreet.textContent = _bearingToDirection(hudHeading);
        _updateDirectionArrow(hudHeading);
    }
}

function _onNavArrived() {
    _navActive = false;
    _syncNavControls();
    if (navHUD) {
        navHUD.classList.add('arrived');
        if (navHudDist) navHudDist.textContent = 'Arrived!';
        if (navHudTime) navHudTime.textContent = '🎉';
        if (navHudStreet) navHudStreet.textContent = 'You have reached your destination';
        if (navSpeedVal) navSpeedVal.textContent = '0';
    }
    if (navDirArrow) navDirArrow.style.transform = 'rotate(0deg)';
    if (_navArrow) _navArrow.setIcon(L.divIcon({
        className: '',
        html: `<div class="m-arrived">🏁</div>`,
        iconSize: [40, 40], iconAnchor: [20, 20],
    }));
    setTimeout(() => stopNavigation(false), 5000);
}

function _promptReroute() {
    if (!_navActive) return;
    showError('You are off route. Tap GO again to recalculate.', 6000);
    if (_navArrow) {
        _navArrow.setIcon(makeNavArrowIcon(userHeading || 0, true));
        setTimeout(() => {
            if (_navArrow && _navActive) _navArrow.setIcon(makeNavArrowIcon(userHeading || 0, false));
        }, 2000);
    }
}

/* ── Route geometry helpers ──────────────────────────────────── */

function _nearestPointOnRoute(lat, lon, lls) {
    let bestDist = Infinity, bestIdx = 0;
    let bestLat = lls[0][0], bestLon = lls[0][1];
    for (let i = 0; i < lls.length - 1; i++) {
        const a = lls[i], b = lls[i + 1];
        const proj = _projectPointOnSegment(lat, lon, a[0], a[1], b[0], b[1]);
        const d = _haversineJS(lat, lon, proj.lat, proj.lon);
        if (d < bestDist) {
            bestDist = d; bestIdx = i;
            bestLat = proj.lat; bestLon = proj.lon;
        }
    }
    return { lat: bestLat, lon: bestLon, idx: bestIdx, dist: bestDist };
}

function _remainingDistOnRoute(lat, lon, lls) {
    const nearest = _nearestPointOnRoute(lat, lon, lls);
    let dist = _haversineJS(lat, lon, nearest.lat, nearest.lon);
    for (let i = nearest.idx + 1; i < lls.length - 1; i++) {
        dist += _haversineJS(lls[i][0], lls[i][1], lls[i + 1][0], lls[i + 1][1]);
    }
    return dist;
}

function _projectPointOnSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
    const dx = bLat - aLat, dy = bLon - aLon;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { lat: aLat, lon: aLon };
    let t = ((pLat - aLat) * dx + (pLon - aLon) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return { lat: aLat + t * dx, lon: aLon + t * dy };
}

if (navFollowBtn) navFollowBtn.addEventListener('click', () => _resumeNavigationFollow(true));
if (navStopBtn) {
    navStopBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        stopNavigation(true);
    });
}
map.on('dragstart', () => {
    if (_navActive && _navCameraLocked()) {
        return;
    }
    const wasFollowing = _navCentering;
    _navCentering = false;
    _resetFollowState();
    if (_navActive) {
        _syncNavControls();
        const now = Date.now();
        if (wasFollowing && now - _lastNavPauseToastTs > 2500) {
            _lastNavPauseToastTs = now;
            showInfo('Map follow paused. Tap Resume Follow to recenter.', 2600);
        }
    }
});
map.on('zoomstart', () => {
    if (_navActive) {
        if (_navCameraLocked()) {
            return;
        }
        _navCentering = false;
        _resetFollowState();
        _syncNavControls();
        return;
    }
    _navCentering = false;
    _resetFollowState();
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && _navActive) {
        stopNavigation(true);
    }
});

/* ================================================================
   Autocomplete Suggestions
================================================================ */

destInput.addEventListener('input', () => {
    const q = destInput.value.trim();
    clearBtn.style.display = q ? 'flex' : 'none';
    if (!_getSelectedDestinationForQuery(q)) {
        _clearSelectedDestination();
    }
    if (!q || q.length < 2) { hideSuggestions(); return; }
    clearTimeout(_suggestTimer);
    _suggestTimer = setTimeout(() => fetchSuggestions(q), 280);
});

destInput.addEventListener('focus', () => {
    const q = destInput.value.trim();
    if (q.length >= 2) fetchSuggestions(q);
});

destInput.addEventListener('blur', () => setTimeout(hideSuggestions, 180));

destInput.addEventListener('keydown', (e) => {
    const items = suggestList.querySelectorAll('.suggest-item');
    const active = suggestList.querySelector('.suggest-item[aria-selected="true"]');
    let idx = active ? Array.from(items).indexOf(active) : -1;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = Math.min(idx + 1, items.length - 1);
        _updateSuggestSelection(items, idx);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(idx - 1, 0);
        _updateSuggestSelection(items, idx);
    } else if (e.key === 'Enter') {
        if (active) { e.preventDefault(); active.click(); }
    } else if (e.key === 'Escape') {
        hideSuggestions(); destInput.blur();
    }
});

function _updateSuggestSelection(items, idx) {
    items.forEach((el, i) => {
        const selected = i === idx;
        el.classList.toggle('active', selected);
        el.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) {
            el.scrollIntoView({ block: 'nearest' });
            destInput.setAttribute('aria-activedescendant', el.id);
        }
    });
    if (idx < 0) destInput.setAttribute('aria-activedescendant', '');
}

clearBtn.addEventListener('click', () => {
    destInput.value = '';
    clearBtn.style.display = 'none';
    _clearSelectedDestination();
    hideSuggestions();
    destInput.focus();
});

async function fetchSuggestions(q) {
    if (_suggestAbort) _suggestAbort.abort();
    _suggestAbort = new AbortController();
    try {
        const params = new URLSearchParams({ q });
        if (userLat !== null) { params.set('lat', userLat); params.set('lon', userLon); }
        const res = await fetch(`/suggestions?${params}`, { signal: _suggestAbort.signal });
        const data = await res.json();

        // Guard: input may have been cleared while request was in-flight
        if (!destInput.value.trim()) { hideSuggestions(); return; }

        renderSuggestions(data, q);
    } catch (err) {
        if (err.name !== 'AbortError') console.warn('Suggestions error:', err);
    }
}

function renderSuggestions(items, query) {
    suggestList.innerHTML = '';
    if (!items?.length) { hideSuggestions(); return; }

    const selectSuggestion = item => {
        destInput.value = item.query || item.label;
        clearBtn.style.display = 'flex';

        if (Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon))) {
            _rememberSelectedDestination(
                item.label || item.query,
                item.lat,
                item.lon,
                item.query || item.label,
            );
        } else {
            _clearSelectedDestination();
        }

        hideSuggestions();
        destInput.blur();
        searchForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };

    items.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'suggest-item';
        li.id = `suggest-item-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        const isPOI = item.type === 'poi';
        li.innerHTML = `
      <span class="sug-icon">${isPOI ? '🔍' : '📍'}</span>
      <div class="sug-text">
        <span class="sug-main">${highlightMatch(item.label, query)}</span>
        ${item.sublabel ? `<span class="sug-sub">${escapeHtml(item.sublabel)}</span>` : ''}
      </div>
      ${isPOI ? '<span class="sug-badge">Near me</span>' : ''}
    `;
        li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            selectSuggestion(item);
        });
        li.addEventListener('click', (e) => {
            e.preventDefault();
            selectSuggestion(item);
        });
        suggestList.appendChild(li);
    });
    suggestList.classList.remove('hidden');
    destInput.setAttribute('aria-expanded', 'true');
    destInput.setAttribute('aria-activedescendant', '');
}

function highlightMatch(text, query) {
    const sourceText = String(text ?? '');
    const sourceQuery = String(query ?? '').trim();
    if (!sourceQuery) {
        return escapeHtml(sourceText);
    }

    const matchPattern = new RegExp(`(${escapeRegExp(sourceQuery)})`, 'gi');
    return sourceText
        .split(matchPattern)
        .map(part => (
            part.toLowerCase() === sourceQuery.toLowerCase()
                ? `<strong>${escapeHtml(part)}</strong>`
                : escapeHtml(part)
        ))
        .join('');
}

function hideSuggestions() {
    suggestList.classList.add('hidden');
    destInput.setAttribute('aria-expanded', 'false');
    destInput.setAttribute('aria-activedescendant', '');
}

/* ================================================================
   Scan / Route-finding Animation
================================================================ */

function startScanAnimation(destLat, destLon) {
    stopScanAnimation();

    const sLat = userLat ?? 28.6139;
    const sLon = userLon ?? 77.2090;
    const distM = _haversineJS(sLat, sLon, destLat, destLon);

    const baseR = Math.max(distM * 0.10, 180);
    const maxR = Math.max(distM * 0.85, 400);

    _scanTracer = L.polyline([[sLat, sLon], [destLat, destLon]], {
        color: '#4f9eff', weight: 1.5, opacity: 0.30,
        dashArray: '6 7', interactive: false,
    }).addTo(map);

    const ringColors = ['#4f9eff', '#00d4ff', '#ce93d8'];
    ringColors.forEach((color, i) => {
        const t0 = performance.now() + i * 420;
        const r0 = baseR * (1 + i * 0.12);
        const circle = L.circle([sLat, sLon], {
            radius: r0, color, weight: i === 0 ? 2.5 : 1.8,
            opacity: 0, fill: i === 0, fillColor: '#4f9eff', fillOpacity: 0,
            interactive: false,
        }).addTo(map);
        _scanRings.push(circle);

        function animRing(now) {
            if (!circle._map) return;
            const elapsed = now - t0;
            if (elapsed < 0) { requestAnimationFrame(animRing); return; }
            const dur = 1800 + i * 150;
            const t = Math.min(elapsed / dur, 1);
            const ease = 1 - Math.pow(1 - t, 2.5);
            circle.setRadius(r0 + (maxR - r0) * ease);
            circle.setStyle({
                opacity: (1 - ease) * (i === 0 ? 0.90 : 0.65),
                fillOpacity: i === 0 ? (1 - ease) * 0.05 : 0,
            });
            if (t < 1) {
                requestAnimationFrame(animRing);
            } else {
                try { map.removeLayer(circle); } catch (_) { }
                const idx = _scanRings.indexOf(circle);
                if (idx !== -1) _scanRings.splice(idx, 1);
                if (_scanCircle) {
                    const nc = L.circle([sLat, sLon], {
                        radius: r0, color, weight: i === 0 ? 2.5 : 1.8,
                        opacity: 0, fill: i === 0, fillColor: '#4f9eff', fillOpacity: 0, interactive: false,
                    }).addTo(map);
                    _scanRings.push(nc);
                    const newT0 = performance.now();
                    function loopRing(now2) {
                        if (!nc._map) return;
                        const el2 = now2 - newT0, dur2 = 1800 + i * 150;
                        const t2 = Math.min(el2 / dur2, 1);
                        const e2 = 1 - Math.pow(1 - t2, 2.5);
                        nc.setRadius(r0 + (maxR - r0) * e2);
                        nc.setStyle({ opacity: (1 - e2) * (i === 0 ? 0.90 : 0.65), fillOpacity: i === 0 ? (1 - e2) * 0.05 : 0 });
                        if (t2 < 1) requestAnimationFrame(loopRing);
                    }
                    requestAnimationFrame(loopRing);
                }
            }
        }
        requestAnimationFrame(animRing);
    });

    _scanCircle = L.circle([sLat, sLon], { radius: 1, opacity: 0, fill: false, interactive: false }).addTo(map);

    // Use module-level _scanDotMarker so stopScanAnimation can remove it
    let dotPhase = 0;
    try {
        _scanDotMarker = L.circleMarker([sLat, sLon], {
            radius: 5, color: '#00d4ff', fillColor: '#00d4ff',
            fillOpacity: 0.9, weight: 2, opacity: 0.9, interactive: false,
        }).addTo(map);
    } catch (_) { _scanDotMarker = null; }

    _scanDotTimer = setInterval(() => {
        if (!_scanCircle || !_scanDotMarker?._map) {
            clearInterval(_scanDotTimer);
            _scanDotTimer = null;
            if (_scanDotMarker) {
                try { map.removeLayer(_scanDotMarker); } catch (_) { }
                _scanDotMarker = null;
            }
            return;
        }
        dotPhase = (dotPhase + 0.032) % 1;
        const t = dotPhase < 0.5 ? dotPhase * 2 : (1 - dotPhase) * 2;
        _scanDotMarker.setLatLng([sLat + (destLat - sLat) * t, sLon + (destLon - sLon) * t]);
        _scanDotMarker.setRadius(4 + Math.sin(dotPhase * Math.PI * 4) * 2);
    }, 30);
}

function stopScanAnimation() {
    if (_scanStepTimer) { clearTimeout(_scanStepTimer); _scanStepTimer = null; }
    if (_scanDotTimer) { clearInterval(_scanDotTimer); _scanDotTimer = null; }

    // Remove the dot marker that was previously a local variable (now module-level)
    if (_scanDotMarker) {
        try { map.removeLayer(_scanDotMarker); } catch (_) { }
        _scanDotMarker = null;
    }

    if (_scanCircle) { try { map.removeLayer(_scanCircle); } catch (_) { } _scanCircle = null; }
    if (_scanTracer) { try { map.removeLayer(_scanTracer); } catch (_) { } _scanTracer = null; }
    _scanRings.forEach(c => { try { map.removeLayer(c); } catch (_) { } });
    _scanRings = [];

    // Remove SVG renderer DOM elements created by tracer animations
    _tracerRenderers.forEach(r => { try { map.removeLayer(r); } catch (_) { } });
    _tracerRenderers = [];
}

/* Haversine distance (metres) */
function _haversineJS(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.min(1, Math.max(0, Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _scoreRoutesLocally(rawRoutes) {
    if (!rawRoutes?.length) {
        return [];
    }

    const distances = rawRoutes.map(route => Number(route.distance) || 0);
    const durations = rawRoutes.map(route => Number(route.duration) || 0);
    const coordCounts = rawRoutes.map(route => Math.max(route.geometry?.length || 0, 1));
    const minDist = Math.min(...distances);
    const maxDist = Math.max(...distances);
    const minDur = Math.min(...durations);
    const maxDur = Math.max(...durations);
    const minCoords = Math.min(...coordCounts);
    const maxCoords = Math.max(...coordCounts);

    const scored = rawRoutes.map((route, index) => {
        const distance = distances[index];
        const duration = durations[index];
        const coordCount = coordCounts[index];

        const timeScore = maxDur === minDur ? 1 : 1 - ((duration - minDur) / (maxDur - minDur));
        const distanceScore = maxDist === minDist ? 1 : 1 - ((distance - minDist) / (maxDist - minDist));
        const simplicityScore = maxCoords === minCoords ? 1 : 1 - ((coordCount - minCoords) / (maxCoords - minCoords));
        const score = Math.round(
            (timeScore * 0.55 + distanceScore * 0.30 + simplicityScore * 0.15) * 100000,
        ) / 100;

        return {
            distance_km: Math.round((distance / 1000) * 100) / 100,
            duration_min: Math.round((duration / 60) * 10) / 10,
            score,
            geometry: route.geometry || [],
            recommended: false,
            tags: [],
        };
    }).sort((a, b) => b.score - a.score);

    const bestScore = scored[0]?.score ?? 0;
    const fastest = Math.min(...scored.map(route => route.duration_min));
    const shortest = Math.min(...scored.map(route => route.distance_km));

    scored.forEach(route => {
        if (route.score === bestScore) {
            route.recommended = true;
            route.tags.push('best');
        }
        if (route.duration_min === fastest) {
            route.tags.push('fastest');
        }
        if (route.distance_km === shortest) {
            route.tags.push('shortest');
        }
    });

    return scored;
}

function _routeDistanceMeters(route) {
    if (Number.isFinite(Number(route?.distance))) {
        return Number(route.distance);
    }
    if (Number.isFinite(Number(route?.distance_km))) {
        return Number(route.distance_km) * 1000;
    }
    return 0;
}

function _routeDurationSeconds(route) {
    if (Number.isFinite(Number(route?.duration))) {
        return Number(route.duration);
    }
    if (Number.isFinite(Number(route?.duration_min))) {
        return Number(route.duration_min) * 60;
    }
    return 0;
}

function _routeGeometryToLatLngs(route) {
    return (route?.geometry || [])
        .map(([lon, lat]) => [lat, lon])
        .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

function _sampleRouteLatLngs(lls, sampleCount = 24) {
    if (!Array.isArray(lls) || lls.length <= sampleCount) {
        return lls || [];
    }

    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
        const idx = Math.round((i * (lls.length - 1)) / Math.max(sampleCount - 1, 1));
        samples.push(lls[idx]);
    }
    return samples;
}

function _routeOverlapMetrics(routeA, routeB) {
    const aLls = _routeGeometryToLatLngs(routeA);
    const bLls = _routeGeometryToLatLngs(routeB);
    if (aLls.length < 2 || bLls.length < 2) {
        return { closeRatio: 0, maxGapM: Infinity };
    }

    const sampleSource = aLls.length <= bLls.length ? aLls : bLls;
    const compareTo = sampleSource === aLls ? bLls : aLls;
    const sampleCount = Math.min(28, Math.max(12, Math.floor(sampleSource.length / 3)));
    const samples = _sampleRouteLatLngs(sampleSource, sampleCount);
    const shorterDistance = Math.min(_routeDistanceMeters(routeA), _routeDistanceMeters(routeB));
    const closeThresholdM = shorterDistance < 3000 ? 24 : shorterDistance < 15000 ? 36 : 55;

    let closeCount = 0;
    let maxGapM = 0;

    samples.forEach(([lat, lon]) => {
        const nearest = _nearestPointOnRoute(lat, lon, compareTo);
        if (nearest.dist <= closeThresholdM) {
            closeCount += 1;
        }
        maxGapM = Math.max(maxGapM, nearest.dist);
    });

    return {
        closeRatio: closeCount / Math.max(samples.length, 1),
        maxGapM,
    };
}

function _routePassesEndpointCheck(route, startLat, startLon, destLat, destLon) {
    const geometry = route?.geometry || [];
    if (geometry.length < 2) {
        return false;
    }

    const [routeStartLon, routeStartLat] = geometry[0];
    const [routeEndLon, routeEndLat] = geometry[geometry.length - 1];
    const tripKm = _estimateTripDistanceKm(startLat, startLon, destLat, destLon);
    const endpointGapLimit = tripKm < 6 ? 320 : tripKm < 20 ? 450 : 900;
    const startGap = _haversineJS(startLat, startLon, routeStartLat, routeStartLon);
    const endGap = _haversineJS(destLat, destLon, routeEndLat, routeEndLon);

    return startGap <= endpointGapLimit && endGap <= endpointGapLimit;
}

function _filterMeaningfulRoutes(routes, startLat, startLon, destLat, destLon) {
    const accepted = [];

    (routes || []).forEach(route => {
        if (!_routePassesEndpointCheck(route, startLat, startLon, destLat, destLon)) {
            return;
        }

        const tooSimilar = accepted.some(existing => {
            const overlap = _routeOverlapMetrics(route, existing);
            const distanceDiffM = Math.abs(_routeDistanceMeters(existing) - _routeDistanceMeters(route));
            const durationDiffS = Math.abs(_routeDurationSeconds(existing) - _routeDurationSeconds(route));
            return overlap.closeRatio >= 0.96
                || (overlap.closeRatio >= 0.90
                    && overlap.maxGapM < 85
                    && distanceDiffM < 700
                    && durationDiffS < 120);
        });

        if (!tooSimilar) {
            accepted.push(route);
        }
    });

    if (!accepted.length) {
        return (routes || []).slice(0, 5);
    }

    return accepted.slice(0, 5);
}

function _offsetRouteLatLngs(lls, offsetMeters) {
    if (!offsetMeters || !Array.isArray(lls) || lls.length < 2) {
        return Array.isArray(lls) ? lls.slice() : [];
    }

    const offsetLls = [];

    for (let i = 0; i < lls.length; i++) {
        const prev = lls[Math.max(0, i - 1)];
        const next = lls[Math.min(lls.length - 1, i + 1)];
        const avgLat = ((prev?.[0] ?? lls[i][0]) + (next?.[0] ?? lls[i][0])) / 2;
        const cosLat = Math.max(Math.cos(avgLat * Math.PI / 180), 0.1);
        const dx = ((next?.[1] ?? lls[i][1]) - (prev?.[1] ?? lls[i][1])) * 111320 * cosLat;
        const dy = ((next?.[0] ?? lls[i][0]) - (prev?.[0] ?? lls[i][0])) * 111320;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const eastOffset = nx * offsetMeters;
        const northOffset = ny * offsetMeters;
        offsetLls.push([
            lls[i][0] + (northOffset / 111320),
            lls[i][1] + (eastOffset / (111320 * cosLat)),
        ]);
    }

    return offsetLls;
}

function _prepareRoutesForPresentation(routes, startLat, startLon, destLat, destLon) {
    const filtered = _filterMeaningfulRoutes(routes, startLat, startLon, destLat, destLon);
    return _decorateRouteVisuals(filtered);
}

function _normaliseOsrmRoutes(routes) {
    return (routes || [])
        .map(route => ({
            distance: Number(route?.distance) || 0,
            duration: Number(route?.duration) || 0,
            geometry: Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [],
        }))
        .filter(route => route.geometry.length >= 2);
}

function _isDuplicateRouteCandidate(route, accepted) {
    const distance = Number(route.distance) || 0;
    const duration = Number(route.duration) || 0;
    const pointCount = route.geometry?.length || 0;

    return accepted.some(existing => {
        const existingDistance = Number(existing.distance) || 0;
        const existingDuration = Number(existing.duration) || 0;
        const existingPointCount = existing.geometry?.length || 0;
        const relDistance = Math.abs(existingDistance - distance) / Math.max(existingDistance, 1);
        const relDuration = Math.abs(existingDuration - duration) / Math.max(existingDuration, 1);
        const relGeometry = Math.abs(existingPointCount - pointCount) / Math.max(existingPointCount, 1);
        const absDistanceDiff = Math.abs(existingDistance - distance);

        if (distance < 3000 || existingDistance < 3000) {
            if (absDistanceDiff < 120 && relDuration < 0.06 && relGeometry < 0.10) {
                return true;
            }
        } else if (relDistance < 0.04 && relDuration < 0.04 && relGeometry < 0.08) {
            return true;
        }

        const overlap = _routeOverlapMetrics(route, existing);
        return overlap.closeRatio >= 0.95
            || (overlap.closeRatio >= 0.90 && overlap.maxGapM < 70 && relDuration < 0.12);
    });
}

function _dedupeRawRoutes(routes) {
    const unique = [];

    routes
        .filter(route => Number(route.distance) > 0 && Number(route.duration) > 0 && (route.geometry?.length || 0) >= 2)
        .sort((a, b) => (Number(a.duration) || 0) - (Number(b.duration) || 0))
        .forEach(route => {
            if (!_isDuplicateRouteCandidate(route, unique)) {
                unique.push(route);
            }
        });

    return unique;
}

function _estimateTripDistanceKm(startLat, startLon, endLat, endLon) {
    return _haversineJS(startLat, startLon, endLat, endLon) / 1000;
}

function _generateBrowserViaPoints(startLat, startLon, endLat, endLon) {
    const distKm = _estimateTripDistanceKm(startLat, startLon, endLat, endLon);
    const midLat = (startLat + endLat) / 2;
    const midLon = (startLon + endLon) / 2;
    const dLat = endLat - startLat;
    const dLon = endLon - startLon;
    const segLen = Math.hypot(dLat, dLon) || 1e-9;
    const perpLat = -dLon / segLen;
    const perpLon = dLat / segLen;
    const paraLat = dLat / segLen;
    const paraLon = dLon / segLen;
    const via = [];

    if (distKm < 2) {
        [0.12, 0.20, -0.12, -0.20].forEach(perpFactor => {
            const off = segLen * perpFactor;
            via.push([midLat + perpLat * off, midLon + perpLon * off]);
        });

        [0.30, -0.30].forEach(paraFactor => {
            [0.10, -0.10].forEach(perpFactor => {
                via.push([
                    midLat + paraLat * segLen * paraFactor + perpLat * segLen * perpFactor,
                    midLon + paraLon * segLen * paraFactor + perpLon * segLen * perpFactor,
                ]);
            });
        });

        [0.25, 0.75].forEach(frac => {
            const qLat = startLat + dLat * frac;
            const qLon = startLon + dLon * frac;
            [0.15, -0.15].forEach(perpFactor => {
                const off = segLen * perpFactor;
                via.push([qLat + perpLat * off, qLon + perpLon * off]);
            });
        });
    } else if (distKm < 15) {
        const cosLat = Math.cos(midLat * Math.PI / 180) || 1;
        [0.12, 0.22, 0.35].forEach(ringFactor => {
            const off = segLen * ringFactor;
            for (let deg = 0; deg < 360; deg += 45) {
                const rad = deg * Math.PI / 180;
                via.push([
                    midLat + off * Math.cos(rad),
                    midLon + (off * Math.sin(rad)) / cosLat,
                ]);
            }
        });
    } else if (distKm < 80) {
        [0.15, 0.25, -0.15, -0.25].forEach(perpFactor => {
            const off = segLen * perpFactor;
            via.push([midLat + perpLat * off, midLon + perpLon * off]);
        });

        [0.25, 0.75].forEach(frac => {
            const qLat = startLat + dLat * frac;
            const qLon = startLon + dLon * frac;
            [0.12, -0.12].forEach(perpFactor => {
                const off = segLen * perpFactor;
                via.push([qLat + perpLat * off, qLon + perpLon * off]);
            });
        });
    } else {
        [0.18, 0.30, -0.18, -0.30].forEach(perpFactor => {
            const off = segLen * perpFactor;
            via.push([midLat + perpLat * off, midLon + perpLon * off]);
        });

        [0.25, -0.25].forEach(bias => {
            via.push([
                midLat + paraLat * segLen * bias + perpLat * segLen * 0.15,
                midLon + paraLon * segLen * bias + perpLon * segLen * 0.15,
            ]);
        });
    }

    return via;
}

function _browserViaTaskLimit(distKm) {
    if (distKm < 15) {
        return 8;
    }
    if (distKm < 80) {
        return 6;
    }
    return 4;
}

function _buildBrowserRouteUrl(startLat, startLon, endLat, endLon, viaLat = null, viaLon = null, alternatives = 3) {
    const coords = viaLat !== null && viaLon !== null
        ? `${startLon},${startLat};${viaLon},${viaLat};${endLon},${endLat}`
        : `${startLon},${startLat};${endLon},${endLat}`;
    const params = new URLSearchParams({
        overview: 'full',
        alternatives: String(alternatives),
        geometries: 'geojson',
        steps: 'false',
    });

    return `${BROWSER_ROUTING_BASE}/route/v1/driving/${coords}?${params}`;
}

async function _fetchBrowserRouteRequest(startLat, startLon, endLat, endLon, viaLat = null, viaLon = null, alternatives = 3) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    let res, data;
    try {
        res = await fetch(_buildBrowserRouteUrl(startLat, startLon, endLat, endLon, viaLat, viaLon, alternatives), { signal: ctrl.signal });
        data = await res.json();
    } catch (e) {
        throw new Error(e?.name === 'AbortError' ? 'Routing timed out. Check your connection.' : (e.message || 'Live routing service is unavailable.'));
    } finally { clearTimeout(tid); }

    if (!res.ok || data.code !== 'Ok') {
        throw new Error(data.message || data.error || 'Live routing service is unavailable.');
    }

    return _normaliseOsrmRoutes(data.routes);
}

async function _collectBrowserRawRoutes(startLat, startLon, destLat, destLon) {
    const distKm = _estimateTripDistanceKm(startLat, startLon, destLat, destLon);
    const targetCount = distKm < 15 ? 5 : distKm < 80 ? 4 : 3;
    let uniqueRoutes = [];

    const directRoutes = await _fetchBrowserRouteRequest(startLat, startLon, destLat, destLon, null, null, 3);
    uniqueRoutes = _dedupeRawRoutes(directRoutes);

    if (uniqueRoutes.length >= targetCount) {
        return uniqueRoutes.slice(0, 5);
    }

    const viaPoints = _generateBrowserViaPoints(startLat, startLon, destLat, destLon)
        .slice(0, _browserViaTaskLimit(distKm));

    for (let batchStart = 0; batchStart < viaPoints.length; batchStart += 3) {
        const batch = viaPoints.slice(batchStart, batchStart + 3);
        const results = await Promise.allSettled(
            batch.map(([viaLat, viaLon]) =>
                _fetchBrowserRouteRequest(startLat, startLon, destLat, destLon, viaLat, viaLon, 1),
            ),
        );

        const batchRoutes = results.flatMap(result => (
            result.status === 'fulfilled' ? result.value : []
        ));
        uniqueRoutes = _dedupeRawRoutes([...uniqueRoutes, ...batchRoutes]);

        if (uniqueRoutes.length >= targetCount) {
            break;
        }
    }

    return uniqueRoutes.slice(0, 5);
}

async function _scoreRoutesOnServer(rawRoutes) {
    const res = await fetch('/score-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routes: rawRoutes }),
    });
    const data = await res.json();

    if (!res.ok || !data.routes?.length) {
        throw new Error(data.error || 'Could not score routes.');
    }

    return data.routes;
}

async function _fetchBrowserRouteSet(startLat, startLon, destLat, destLon) {
    const rawRoutes = await _collectBrowserRawRoutes(startLat, startLon, destLat, destLon);
    if (!rawRoutes.length) {
        throw new Error('No drivable route found.');
    }

    try {
        return await _scoreRoutesOnServer(rawRoutes);
    } catch (err) {
        console.warn('Route scoring fallback:', err);
        return _scoreRoutesLocally(rawRoutes);
    }
}

async function _requestRoutesByCoords(startLat, startLon, destLat, destLon) {
    let browserError = null;

    try {
        const routes = await _fetchBrowserRouteSet(startLat, startLon, destLat, destLon);
        return {
            routes,
            destination: { lat: destLat, lon: destLon },
        };
    } catch (err) {
        browserError = err;
        console.warn('Browser routing fallback failed:', err);
    }

    const res = await fetch('/route-coords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_lat: startLat, start_lon: startLon, end_lat: destLat, end_lon: destLon }),
    });
    const data = await res.json();

    if (!res.ok || !data.routes?.length) {
        throw new Error(data.error || browserError?.message || 'Could not find route.');
    }

    return {
        routes: data.routes,
        destination: data.destination || { lat: destLat, lon: destLon },
    };
}

async function _enhanceRouteChoices(existingRoutes, startLat, startLon, destLat, destLon) {
    const safeExisting = Array.isArray(existingRoutes) ? existingRoutes : [];

    try {
        const liveResult = await _requestRoutesByCoords(startLat, startLon, destLat, destLon);
        if ((liveResult.routes?.length || 0) >= (safeExisting.length || 0)) {
            return liveResult;
        }
    } catch (err) {
        console.warn('Route enhancement skipped:', err);
    }

    return {
        routes: safeExisting,
        destination: { lat: destLat, lon: destLon },
    };
}

async function _presentRoutes(routes, destination, startLat, startLon, label = '') {
    setProgress(95);
    showLoader(false);

    startScanAnimation(destination.lat, destination.lon);
    setScanStatus('scanning');

    if (label) {
        _rememberSelectedDestination(label, destination.lat, destination.lon, label);
    }

    fitBoundsNow(
        L.latLngBounds([[startLat, startLon], [destination.lat, destination.lon]]),
        false,
        false,
    );

    await sleep(700);
    stopScanAnimation();
    const preparedRoutes = _prepareRoutesForPresentation(
        routes,
        startLat,
        startLon,
        destination.lat,
        destination.lon,
    );
    await renderRoutes(preparedRoutes, destination);
}

/* ================================================================
   Search / Navigate
================================================================ */

searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideSuggestions();
    _closeMapStylePanel();
    const query = destInput.value.trim();
    if (!query) { destInput.focus(); return; }

    const lat = userLat ?? 28.6139;
    const lon = userLon ?? 77.2090;

    const isNear = /near\s*me|nearby|near by|close to me|around me/i.test(query);
    if (isNear) {
        _clearSelectedDestination();
        await handleNearbySearch(query, lat, lon);
        return;
    }

    const selectedDestination = _getSelectedDestinationForQuery(query);
    if (selectedDestination) {
        await handleRouteToCoords(
            selectedDestination.lat,
            selectedDestination.lon,
            selectedDestination.label || query,
        );
        return;
    }

    await handleRouteSearch(query, lat, lon);
});

let _routeAbort = null;

async function handleRouteSearch(dest, lat, lon) {
    // Cancel any in-flight route request
    if (_routeAbort) { _routeAbort.abort(); }
    _routeAbort = new AbortController();
    const signal = _routeAbort.signal;

    stopNavigation(false);
    clearRoutes();
    clearPOI();
    hideError();
    navBtn.disabled = true;
    showLoader(true, 0);
    setLoaderStep('Finding routes…');
    setProgress(20);

    try {
        const res = await fetch('/route', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_lat: lat, user_lon: lon, destination: dest }),
            signal,
        });
        const data = await res.json();
        setProgress(75);

        const resolvedDestination = data.destination &&
            Number.isFinite(Number(data.destination.lat)) &&
            Number.isFinite(Number(data.destination.lon))
            ? { lat: Number(data.destination.lat), lon: Number(data.destination.lon) }
            : null;

        if ((!res.ok || !data.routes?.length) && resolvedDestination) {
            setLoaderStep('Routing live in browser…');
            setProgress(55);

            try {
                const liveResult = await _requestRoutesByCoords(
                    lat,
                    lon,
                    resolvedDestination.lat,
                    resolvedDestination.lon,
                );
                await _presentRoutes(
                    liveResult.routes,
                    liveResult.destination,
                    userLat ?? lat,
                    userLon ?? lon,
                    dest,
                );
                return;
            } catch (fallbackErr) {
                console.warn('Route fallback failed:', fallbackErr);
            }
        }

        if (!res.ok || !data.routes?.length) {
            showError(data.error || 'No routes found. Try a different destination.');
            showLoader(false);
            return;
        }

        let chosenRoutes = data.routes;
        let chosenDestination = data.destination;

        if (resolvedDestination && data.routes.length < 3) {
            setLoaderStep('Finding more route choices…');
            setProgress(60);

            const enriched = await _enhanceRouteChoices(
                data.routes,
                lat,
                lon,
                resolvedDestination.lat,
                resolvedDestination.lon,
            );
            chosenRoutes = enriched.routes;
            chosenDestination = enriched.destination;
        }

        // Guard: ensure all routes have valid geometry before rendering
        chosenRoutes = chosenRoutes.filter(r =>
            r && Array.isArray(r.geometry) && r.geometry.length >= 2
        );
        if (!chosenRoutes.length) {
            showError('Routes found but had invalid geometry. Try again.');
            showLoader(false); return;
        }
        await _presentRoutes(
            chosenRoutes,
            chosenDestination,
            userLat ?? lat,
            userLon ?? lon,
            dest,
        );

    } catch (err) {
        if (err?.name === 'AbortError') return; // cancelled by newer search
        showError(err?.message || 'Network error. Is the server running?');
        showLoader(false);
        stopScanAnimation();
        setScanStatus('hide');
    } finally {
        if (!signal.aborted) navBtn.disabled = false;
    }
}

async function handleNearbySearch(query, lat, lon) {
    stopNavigation(false);
    clearRoutes();
    clearPOI();
    hideError();
    showLoader(true, 0);
    setLoaderStep('Scanning nearby places…');
    setProgress(30);
    navBtn.disabled = true;

    try {
        const params = new URLSearchParams({ q: query, lat, lon, radius: 25000 });
        const res = await fetch(`/nearby?${params}`);
        const data = await res.json();
        setProgress(80);

        if (!res.ok) { showError(data.error || 'No places found.'); return; }

        setLoaderStep(`Found ${data.results.length} places`);
        setProgress(100);
        await sleep(200);
        showLoader(false);
        await renderPOIResults(data.results, data.keyword, lat, lon);

    } catch (err) {
        showError('Network error. Is the server running?');
    } finally {
        showLoader(false);
        navBtn.disabled = false;
    }
}

/* ================================================================
   Render POI Results
================================================================ */

async function renderPOIResults(results, keyword, uLat, uLon) {
    clearPOI();
    if (!results?.length) {
        showError('No nearby places found. Try a different search.', 5000);
        return;
    }

    poiTitle.textContent = `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} Near You`;
    poiCount.textContent = `${results.length} found`;
    poiList.innerHTML = '';

    const bounds = L.latLngBounds([[uLat, uLon]]);

    results.forEach((poi, i) => {
        bounds.extend([poi.lat, poi.lon]);

        const icon = makePOIIcon(poi.type);
        const marker = L.marker([poi.lat, poi.lon], { icon, zIndexOffset: 2000 - i, title: poi.name }).addTo(map);
        const safePoiName = escapeHtml(poi.name);
        const safePoiType = escapeHtml(poi.type);
        const safePoiAddress = poi.address ? escapeHtml(poi.address.substring(0, 60)) : '';
        const safePoiCuisine = poi.extra?.cuisine ? escapeHtml(poi.extra.cuisine) : '';
        const safePoiHours = poi.extra?.opening_hours ? escapeHtml(poi.extra.opening_hours.substring(0, 40)) : '';
        const safePoiPhone = poi.extra?.phone ? escapeHtml(poi.extra.phone) : '';

        marker.bindPopup(`<div class="pop-inner">
      <div class="pop-title" style="color:#00e676">${POI_ICONS[poi.type] || '📍'} ${safePoiName}</div>
      <div class="pop-row"><span>Type</span><span>${safePoiType}</span></div>
      <div class="pop-row"><span>Distance</span><span>${formatDist(poi.distance_m)}</span></div>
      ${poi.address ? `<div class="pop-row"><span>Address</span><span style="max-width:130px;text-align:right">${safePoiAddress}</span></div>` : ''}
      ${poi.extra?.cuisine ? `<div class="pop-row"><span>Cuisine</span><span>${safePoiCuisine}</span></div>` : ''}
      ${poi.extra?.opening_hours ? `<div class="pop-row"><span>Hours</span><span style="max-width:130px;text-align:right">${safePoiHours}</span></div>` : ''}
      ${poi.extra?.phone ? `<div class="pop-row"><span>Phone</span><span>${safePoiPhone}</span></div>` : ''}
      <button class="pop-route-btn" data-poi-idx="${i}">🗺 Get Directions</button>
    </div>`, { maxWidth: 270 });

        marker.on('popupopen', () => {
            const btn = marker.getPopup().getElement()?.querySelector('.pop-route-btn');
            if (btn) btn.onclick = () => routeToPOI(poi.lat, poi.lon, poi.name);
        });

        poiMarkers.push(marker);

        const item = document.createElement('div');
        item.className = 'poi-item';
        item.setAttribute('role', 'listitem');
        item.innerHTML = `
      <div class="poi-item-icon">${POI_ICONS[poi.type] || '📍'}</div>
      <div class="poi-item-info">
        <div class="poi-item-name">${safePoiName}</div>
        <div class="poi-item-meta">${safePoiType} · ${formatDist(poi.distance_m)}</div>
        ${poi.extra?.cuisine ? `<div class="poi-item-addr">🍽 ${safePoiCuisine}</div>` :
                poi.address ? `<div class="poi-item-addr">${escapeHtml(poi.address.substring(0, 55))}</div>` : ''}
        ${poi.extra?.opening_hours ? `<div class="poi-item-addr">🕐 ${safePoiHours}</div>` : ''}
      </div>
      <button type="button" class="poi-route-btn" title="Get directions" aria-label="Get directions to ${safePoiName}">▶</button>
    `;
        item.querySelector('.poi-route-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            routeToPOI(poi.lat, poi.lon, poi.name);
        });
        item.addEventListener('click', () => {
            map.flyTo([poi.lat, poi.lon], 17, { duration: 1.0 });
            marker.openPopup();
            item.classList.add('active');
            setTimeout(() => item.classList.remove('active'), 2000);
        });
        poiList.appendChild(item);
    });

    _poiBounds = bounds;
    _updateOverviewButtonVisibility();
    routePanel.classList.remove('show', 'expanded'); // Prevent overlap
    clearRoutes(); // Prevent overlapping polylines
    poiPanel.classList.remove('hidden');
    _syncFloatingUiState();
    fitBoundsNow(bounds, false, true);
}

async function routeToPOI(poiLat, poiLon, name) {
    poiPanel.classList.add('hidden');
    _syncFloatingUiState();
    destInput.value = name;
    clearBtn.style.display = 'flex';
    _rememberSelectedDestination(name, poiLat, poiLon, name);
    await handleRouteToCoords(poiLat, poiLon, name);
}

async function handleRouteToCoords(destLat, destLon, destName) {
    stopNavigation(false);
    clearRoutes();
    clearPOI();
    hideError();
    navBtn.disabled = true;
    showLoader(true, 0);
    setLoaderStep(`Routes to ${destName}…`);
    setProgress(15);

    const sLat = userLat ?? 28.6139, sLon = userLon ?? 77.2090;

    startScanAnimation(destLat, destLon);
    setScanStatus('scanning');
    fitBoundsNow(L.latLngBounds([[sLat, sLon], [destLat, destLon]]), false, false);

    try {
        setLoaderStep(`Finding live routes to ${destName}…`);
        setProgress(50);

        const data = await _requestRoutesByCoords(sLat, sLon, destLat, destLon);
        setProgress(85);

        await _presentRoutes(
            data.routes,
            data.destination,
            sLat,
            sLon,
            destName,
        );

    } catch (err) {
        stopScanAnimation();
        setScanStatus('hide');
        showError(err?.message || 'Network error. Is the server running?');
    } finally {
        showLoader(false);
        navBtn.disabled = false;
    }
}

poiClose.addEventListener('click', () => {
    poiPanel.classList.add('hidden');
    _syncFloatingUiState();
});

function clearPOI() {
    poiMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) { } });
    poiMarkers = [];
    _poiBounds = null;
    poiPanel.classList.add('hidden');
    poiList.innerHTML = '';
    _updateOverviewButtonVisibility();
    _syncFloatingUiState();
}

function formatDist(m) {
    return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

/* ================================================================
   Render Routes — Fan-out animation, best route green last
================================================================ */

function _drawRouteTracer(lls, color, weight, opacity, dur, delay = 0) {
    return new Promise(resolve => {
        if (!lls || lls.length < 2) return resolve();

        const svgR = L.svg({ padding: 0.8 });
        _tracerRenderers.push(svgR);

        const line = L.polyline(lls, {
            renderer: svgR, color, weight, opacity,
            lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0,
            interactive: false, pane: 'overlayPane',
        }).addTo(map);

        requestAnimationFrame(() => {
            const el = line.getElement?.();
            if (!el) {
                try { map.removeLayer(line); } catch (_) { }
                // Clean up renderer immediately if layer failed
                const ri = _tracerRenderers.indexOf(svgR);
                if (ri !== -1) _tracerRenderers.splice(ri, 1);
                try { map.removeLayer(svgR); } catch (_) { }
                return resolve();
            }

            const paths = el.tagName?.toLowerCase() === 'path'
                ? [el] : Array.from(el.querySelectorAll?.('path') || []);

            if (!paths.length) {
                try { map.removeLayer(line); } catch (_) { }
                const ri = _tracerRenderers.indexOf(svgR);
                if (ri !== -1) _tracerRenderers.splice(ri, 1);
                try { map.removeLayer(svgR); } catch (_) { }
                return resolve();
            }

            paths.forEach(path => {
                let len = 0;
                try { len = path.getTotalLength?.() || 0; } catch (_) { }
                if (len <= 0) len = 80000;
                path.style.transition = 'none';
                path.style.strokeDasharray = `${len}`;
                path.style.strokeDashoffset = `${len}`;
            });

            void el.getBoundingClientRect();

            paths.forEach(path => {
                let len = 0;
                try { len = path.getTotalLength?.() || 0; } catch (_) { }
                if (len <= 0) len = 80000;
                path.style.transition = `stroke-dashoffset ${dur}ms cubic-bezier(0.25,0.05,0.15,1) ${delay}ms`;
                path.style.strokeDashoffset = '0';
            });

            setTimeout(() => {
                try { map.removeLayer(line); } catch (_) { }
                // Remove renderer from DOM and pool
                const ri = _tracerRenderers.indexOf(svgR);
                if (ri !== -1) _tracerRenderers.splice(ri, 1);
                try { map.removeLayer(svgR); } catch (_) { }
                resolve();
            }, dur + delay + 60);
        });
    });
}

async function renderRoutes(routes, destination) {
    clearRoutes();

    const sLat = userLat ?? 28.6139, sLon = userLon ?? 77.2090;

    destMarker = L.marker([destination.lat, destination.lon], {
        icon: destIcon, zIndexOffset: 3500, title: 'Destination',
    }).addTo(map);
    destMarker.bindPopup(`<div class="pop-inner">
    <div class="pop-title" style="color:#00e676">🏁 Destination</div>
    <div class="pop-row"><span>Lat</span><span>${destination.lat.toFixed(5)}°</span></div>
    <div class="pop-row"><span>Lon</span><span>${destination.lon.toFixed(5)}°</span></div>
  </div>`, { maxWidth: 220 });

    destPulseRing = L.circle([destination.lat, destination.lon], {
        renderer: CANVAS,
        radius: 120,
        color: '#00e676',
        weight: 1.2,
        opacity: 0.42,
        fillColor: '#00e676',
        fillOpacity: 0.07,
        interactive: false,
    }).addTo(map);

    const bounds = L.latLngBounds([[sLat, sLon], [destination.lat, destination.lon]]);

    for (let i = routes.length - 1; i >= 0; i--) {
        const route = routes[i];
        const pal = route._visual || ROUTE_STYLE_LIBRARY.alternate;
        const lls = route.geometry.map(([ln, lt]) => [lt, ln]);
        const displayLls = _offsetRouteLatLngs(lls, route._visual?.offsetMeters || 0);
        lls.forEach(ll => bounds.extend(ll));

        const bLine = L.polyline(displayLls, {
            renderer: CANVAS, color: pal.border, weight: pal.bw, opacity: 0,
            lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0, interactive: false,
        }).addTo(map);

        const fLine = L.polyline(displayLls, {
            renderer: CANVAS, color: i === 0 ? '#00e676' : pal.fill,
            weight: pal.fw, opacity: 0,
            lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0,
        }).addTo(map);

        fLine.bindPopup(buildRoutePopup(route, i, pal), { maxWidth: 260 });
        fLine.on('popupopen', () => {
            const popupButton = fLine.getPopup().getElement()?.querySelector('.pop-route-btn');
            if (popupButton) {
                popupButton.addEventListener('click', event => {
                    event.preventDefault();
                    startNavigation(i);
                }, { once: true });
            }
        });

        fLine.on('mouseover', function () { this.setStyle({ weight: pal.fw + 4, opacity: 1.0 }); bLine.setStyle({ weight: pal.bw + 4 }); });
        fLine.on('mouseout', function () {
            const grp = routeGrps.find(g => g.fill === fLine);
            if (!grp) return;
            const rev = grp._revealed;
            const isBest = grp.isBest;
            this.setStyle({ weight: pal.fw, opacity: rev ? (isBest ? 1.0 : pal.fo * 0.55) : 0 });
            bLine.setStyle({ weight: pal.bw, opacity: rev ? (isBest ? pal.bo : pal.bo * 0.4) : 0 });
        });

        routeGrps.unshift({
            border: bLine,
            fill: fLine,
            pal,
            routeLabel: route._label || pal.name,
            lls,
            displayLls,
            _revealed: false,
            isBest: i === 0,
        });
    }

    _lastBounds = bounds;
    _updateOverviewButtonVisibility();
    fitBoundsNow(bounds, false, false);
    setScanStatus('scanning');

    const altGrps = routeGrps.slice(1);
    const bestGrp = routeGrps[0];

    const altPromises = altGrps.map((g, i) => {
        const delay = i * 60, dur = 1100 + i * 80;
        setTimeout(() => {
            g.fill.setStyle({ opacity: g.pal.scanFo });
            g.border.setStyle({ opacity: g.pal.scanBo });
        }, delay + 80);
        return _drawRouteTracer(g.displayLls || g.lls, g.pal.drawColor, g.pal.fw + 2, 0.80, dur, delay)
            .then(() => {
                g.fill.setStyle({ opacity: g.pal.fo * 0.55 });
                g.border.setStyle({ opacity: g.pal.bo * 0.40 });
                g._revealed = true;
            });
    });

    await Promise.all(altPromises);

    if (bestGrp) {
        bestGrp.fill.setStyle({ color: '#00e676', opacity: 0.12, weight: bestGrp.pal.fw });
        bestGrp.border.setStyle({ color: '#002d14', opacity: 0.08, weight: bestGrp.pal.bw });

        await _drawRouteTracer(bestGrp.displayLls || bestGrp.lls, '#00ff88', bestGrp.pal.fw + 5, 1.0, 1600, 0);

        bestGrp.fill.setStyle({ color: '#ffffff', weight: bestGrp.pal.fw + 8, opacity: 1 });
        bestGrp.border.setStyle({ color: '#ccffdd', weight: bestGrp.pal.bw + 8, opacity: 0.9 });
        await sleep(80);

        bestGrp.fill.setStyle({ color: '#00e676', weight: bestGrp.pal.fw, opacity: 1.0 });
        bestGrp.border.setStyle({ color: '#002d14', weight: bestGrp.pal.bw, opacity: 0.80 });
        bestGrp._revealed = true;
        bestGrp.isBest = true;
        bestGrp.border.bringToFront();
        bestGrp.fill.bringToFront();

        _drawRouteTracer(bestGrp.displayLls || bestGrp.lls, '#ffffff', bestGrp.pal.fw + 3, 0.55, 1200, 0);
        _addGlowLine(bestGrp.displayLls || bestGrp.lls, '#00e676');
    }

    setScanStatus('found');
    stopScanAnimation();

    await sleep(200);
    routeBadge.textContent = `${routes.length} ROUTE${routes.length !== 1 ? 'S' : ''}`;
    buildCards(routes);
    updateLegend(routes);
    routePanel.classList.add('show');
    _syncFloatingUiState();
    legendEl.classList.remove('hidden');
    // Allow the browser to measure the panel before adjusting bounds
    setTimeout(() => map.invalidateSize({ animate: false }), 50);

    await sleep(300);
    fitBoundsNow(bounds, true, false);
}

function _addGlowLine(lls, color) {
    const svgR = L.svg({ padding: 0.8 });
    _routeRenderers.push(svgR);

    const glow = L.polyline(lls, {
        renderer: svgR, color, weight: 18, opacity: 0.08,
        lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0,
        interactive: false, pane: 'overlayPane',
    }).addTo(map);
    routeGrps.push({ border: glow, fill: glow, pal: ROUTE_STYLE_LIBRARY.best, lls, displayLls: lls, _revealed: true, _glowOnly: true });
}

/* ── fitBoundsNow ─────────────────────────────────────────────── */
function fitBoundsNow(bounds, panelVisible, isPOI) {
    if (!bounds?.isValid()) return;
    const topH = ($('topbar')?.offsetHeight || 60) + 16;
    const panelH = panelVisible
        ? Math.min(routePanel.offsetHeight || 220, window.innerHeight * 0.44) + 24 : 16;
    const rightPad = legendEl && !legendEl.classList.contains('hidden') ? 90 : 20;
    map.fitBounds(bounds, {
        paddingTopLeft: [20, topH], paddingBottomRight: [rightPad, panelH],
        maxZoom: isPOI ? 16 : 14, animate: true, duration: 0.9,
    });
}

/* ── Route popup ─────────────────────────────────────────────── */
function buildRoutePopup(route, index, pal) {
    const label = route._label || pal.name;
    const tags = (route.tags || []).map(t => `<span class="ptag">${escapeHtml(tagLabel(t))}</span>`).join('') || '—';
    return `<div class="pop-inner">
    <div class="pop-title" style="color:${pal.fill}">${escapeHtml(label)}</div>
    <div class="pop-row"><span>Distance</span><span>${route.distance_km} km</span></div>
    <div class="pop-row"><span>Duration</span><span>${route.duration_min} min</span></div>
    <div class="pop-row"><span>Score</span><span>${route.score}</span></div>
    <div class="pop-row"><span>Tags</span><span class="ptags">${tags}</span></div>
    <button type="button" class="pop-route-btn" data-route-idx="${index}">▶ Start Navigation</button>
  </div>`;
}

/* ── Route cards ─────────────────────────────────────────────── */
function buildCards(routes) {
    cardsWrap.innerHTML = '';
    const maxScore = Math.max(...routes.map(r => r.score), 1);

    routes.forEach((route, i) => {
        const pal = route._visual || ROUTE_STYLE_LIBRARY.alternate;
        const pct = Math.round((route.score / maxScore) * 100);
        const tagsHTML = (route.tags || []).map(t =>
            `<span class="tag ${tagClass(t)}">${escapeHtml(tagLabel(t))}</span>`).join('');
        const label = route._label || pal.name;

        const card = document.createElement('div');
        card.className = 'route-card';
        card.setAttribute('role', 'listitem');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `${label}: ${route.distance_km}km, ${route.duration_min}min`);
        card.style.setProperty('--accent', pal.cardAccent);
        card.style.animationDelay = `${i * 0.07}s`;

        card.innerHTML = `
      <div class="card-top">
        <span class="badge ${pal.badgeCls}">${escapeHtml(label)}</span>
        <div class="card-tags">${tagsHTML}</div>
      </div>
      <div class="card-stats">
        <div class="stat">
          <span class="stat-lbl">DISTANCE</span>
          <span class="stat-val" style="color:${pal.fill}">${route.distance_km}<span class="stat-unit"> km</span></span>
        </div>
        <div class="stat">
          <span class="stat-lbl">DURATION</span>
          <span class="stat-val" style="color:${pal.fill}">${route.duration_min}<span class="stat-unit"> min</span></span>
        </div>
      </div>
      <div class="score-row">
        <span class="score-lbl">SMART SCORE</span>
        <span class="score-num">${route.score}</span>
      </div>
      <div class="score-bg">
        <div class="score-fill" style="--pct:${pct}%; background:linear-gradient(90deg,${pal.fill},${pal.cardAccent})"></div>
      </div>
      <div class="card-btn-row">
        <button type="button" class="card-nav-btn" data-route-idx="${i}" aria-label="Navigate using ${escapeHtml(label)}">▶ Navigate</button>
        <button type="button" class="card-3d-btn" data-route-idx="${i}" aria-label="3D preview of ${escapeHtml(label)}">🏙️ 3D</button>
      </div>
    `;

        card.querySelector('.card-nav-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            startNavigation(i);
        });

        card.querySelector('.card-3d-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            open3DView(i);
        });

        card.addEventListener('click', () => zoomToRoute(i));
        card.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zoomToRoute(i); }
        });
        cardsWrap.appendChild(card);
    });
}

function zoomToRoute(i) {
    const grp = routeGrps[i];
    if (!grp) return;
    fitBoundsNow(L.latLngBounds(grp.lls), true, false);
    // Highlight
    grp.fill.setStyle({ weight: grp.pal.fw + 5, opacity: 1 });
    grp.border.setStyle({ weight: grp.pal.bw + 5 });
    setTimeout(() => {
        // Restore to correct post-reveal opacity (not raw pal.fo which ignores the 0.55 dim)
        grp.fill.setStyle({ weight: grp.pal.fw, opacity: grp.isBest ? 1.0 : grp.pal.fo * 0.55 });
        grp.border.setStyle({ weight: grp.pal.bw, opacity: grp.isBest ? grp.pal.bo : grp.pal.bo * 0.4 });
    }, 1600);
    setTimeout(() => {
        const popupLls = grp.displayLls?.length ? grp.displayLls : grp.lls;
        const mid = popupLls[Math.floor(popupLls.length / 2)];
        grp.fill.openPopup(mid);
    }, 600);
}

/* ── Legend ──────────────────────────────────────────────────── */
function updateLegend(routes) {
    legendItems.innerHTML = '';
    routes.forEach((route, i) => {
        const pal = route._visual || ROUTE_STYLE_LIBRARY.alternate;
        const label = route._label || pal.name;
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = `
      <div class="leg-line" style="background:${pal.fill};box-shadow:0 0 5px ${pal.fill}55"></div>
      <span class="leg-label">${escapeHtml(label)}</span>
    `;
        legendItems.appendChild(item);
    });
}

/* ── Scan status ─────────────────────────────────────────────── */
const SCAN_STEPS = [
    '📡  Locking GPS coordinates…',
    '🛣️  Snapping to nearest roads…',
    '🔍  Scanning road network…',
    '🗺️  Calculating route corridors…',
    '⚡  Optimising alternatives…',
    '🏆  Ranking by smart score…',
];

function setScanStatus(phase) {
    if (!scanEl) return;
    if (_scanStepTimer) { clearTimeout(_scanStepTimer); _scanStepTimer = null; }

    if (phase === 'scanning') {
        scanEl.className = 'scanning';
        let step = 0;
        function nextStep() {
            if (!scanEl || scanEl.className !== 'scanning') return;
            scanEl.textContent = SCAN_STEPS[step % SCAN_STEPS.length];
            step++;
            _scanStepTimer = setTimeout(nextStep, 780);
        }
        nextStep();
    } else if (phase === 'found') {
        scanEl.textContent = '✅  Best route identified!';
        scanEl.className = 'found';
        setTimeout(() => { if (scanEl) scanEl.className = 'hidden'; }, 3200);
    } else {
        scanEl.className = 'hidden';
        scanEl.textContent = '';
    }
}

/* ── Clear routes ────────────────────────────────────────────── */
function clearRoutes() {
    stopScanAnimation();
    stopNavigation(false);
    hideError();

    routeGrps.forEach(({ border, fill }) => {
        try { map.removeLayer(border); } catch (_) { }
        try { map.removeLayer(fill); } catch (_) { }
    });
    routeGrps = [];
    _lastBounds = null;

    // Remove permanent SVG renderer DOM elements (glow lines etc.)
    _routeRenderers.forEach(r => { try { map.removeLayer(r); } catch (_) { } });
    _routeRenderers = [];

    if (destMarker) { try { map.removeLayer(destMarker); } catch (_) { } destMarker = null; }
    if (destPulseRing) { try { map.removeLayer(destPulseRing); } catch (_) { } destPulseRing = null; }
    routePanel.classList.remove('show', 'expanded');
    legendEl.classList.add('hidden');
    cardsWrap.innerHTML = '';
    setScanStatus('hide');
    _updateOverviewButtonVisibility();
    _syncFloatingUiState();
}

/* ── Panel controls ──────────────────────────────────────────── */
closePanel.addEventListener('click', () => {
    routePanel.classList.remove('show', 'expanded');
    _syncFloatingUiState();
    if (_lastBounds) fitBoundsNow(_lastBounds, false, false);
    setTimeout(() => map.invalidateSize({ animate: false }), 300);
});
panelExpand.addEventListener('click', () => {
    routePanel.classList.toggle('expanded');
    _syncFloatingUiState();
    panelExpand.innerHTML = routePanel.classList.contains('expanded')
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    setTimeout(() => {
        map.invalidateSize({ animate: false });
        if (_lastBounds) fitBoundsNow(_lastBounds, true, false);
    }, 320);
});

/* ── Tag helpers ─────────────────────────────────────────────── */
const TAG_MAP = {
    best: ['★ Best', 'tag-best'],
    fastest: ['⚡ Fastest', 'tag-fast'],
    shortest: ['📏 Shortcut', 'tag-short'],
    safest: ['🛡 Safest', 'tag-safe'],
};
function tagLabel(t) { return TAG_MAP[t]?.[0] || t; }
function tagClass(t) { return TAG_MAP[t]?.[1] || 'tag-other'; }

/* ── Helpers ─────────────────────────────────────────────────── */
function showLoader(v, pct = 0) { loader.classList.toggle('show', v); if (v) setProgress(pct); }
function setLoaderStep(t) { if (loaderStep) loaderStep.textContent = t; }
function setProgress(pct) { if (loaderProg) loaderProg.style.width = `${pct}%`; }
function showError(msg, ms = 8000) {
    errorBox.textContent = msg; errorBox.classList.add('show');
    clearTimeout(errorBox._t);
    errorBox._t = setTimeout(() => errorBox.classList.remove('show'), ms);
}
function hideError() { errorBox.classList.remove('show'); clearTimeout(errorBox._t); }
function showInfo(msg, ms = 5000) {
    infoBox.textContent = msg; infoBox.classList.add('show');
    clearTimeout(infoBox._t);
    infoBox._t = setTimeout(() => infoBox.classList.remove('show'), ms);
}
function setGpsPill(txt, s) {
    gpsPill.className = s || '';
    const textSpan = document.getElementById('gps-pill-text');
    if (textSpan) { textSpan.textContent = txt; }
    else { gpsPill.textContent = txt; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ================================================================
   3D MAP NAVIGATION ENGINE — MapLibre GL  v3.0
   ─────────────────────────────────────────────────────────────
   REAL GPS ONLY — zero simulation. Vehicle moves ONLY when
   your device actually moves. Full device-orientation heading.
   India-bounded map (SW 6.5°N 68°E → NE 37.6°N 97.5°E).
   ─────────────────────────────────────────────────────────────
   • Real MapLibre GL vector tiles (openfreemap liberty)
   • India-only maxBounds + optimised zoom 14-20
   • Deep navy night theme — vivid India street colours
   • 4-layer building extrusions (shadow / body / accent / roof)
   • Accurate horizontal accuracy ring on map
   • Device orientation API for heading when speed < 3 km/h
   • Kalman-smoothed position from main GPS engine
   • Multi-layer glowing route + travelled overlay
   • Custom SVG top-down vehicle markers per type
   • 60 fps exponential camera chase (no jumps)
   • Speed-colour badge (green/yellow/orange/red)
================================================================ */

/* ================================================================
   3D MAP ENGINE — MapLibre GL  v4.0  (SmartNav India)
   Real GPS. India-bounded. 5-layer buildings. Animated routes.
   Speed-reactive zoom. Device-orientation heading. Fog/sky.
================================================================ */

const INDIA_BOUNDS = [[68.1, 6.5], [97.5, 37.6]];
const INDIA_CENTER = [78.9629, 20.5937];

/* ── Safe layer/source helpers — prevent "already exists" crashes ── */
function _3dmSafeAddLayer(map, layerDef, beforeId) {
    try {
        if (map.getLayer(layerDef.id)) {
            try { map.removeLayer(layerDef.id); } catch(_) {}
        }
        if (beforeId && map.getLayer(beforeId)) map.addLayer(layerDef, beforeId);
        else map.addLayer(layerDef);
    } catch(e) { console.warn('[3D layer]', layerDef.id, e.message); }
}
function _3dmSafeAddSource(map, id, spec) {
    try {
        if (map.getSource(id)) { try { map.removeSource(id); } catch(_) {} }
        map.addSource(id, spec);
    } catch(e) { console.warn('[3D source]', id, e.message); }
}
function _3dmSafeRemoveLayers(map, ids) {
    ids.forEach(id => {
        try { if (map.getLayer(id)) map.removeLayer(id); } catch(_) {}
        // try remove matching source too
        const srcId = id.replace(/[A-Z]/g,'').replace(/_3(r|b|dest|strt|acc)/,'_3$1').split('.')[0];
        try { if (id.match(/^_3(r|b|dest|strt|acc)/) && map.getSource(id)) map.removeSource(id); } catch(_) {}
    });
}

const _3DM = {
    map:null, active:false, styleReady:false,
    routeLLs:[], routeCoords:[], totalDist:0, travelledDist:0,
    vehicle:'car', vehicleMarker:null,
    curLat:null, curLon:null, curAcc:null,
    rndLat:null, rndLon:null,
    gpsBearing:0, devBearing:0, tgtBearing:0, camBearing:0,
    camLat:0, camLon:0,
    pitchMode:63, zoomNav:18.0,
    followMode:true, followHeading:true, userRotating:false,
    devOrient:false, _devOrFn:null,
    _routeTimer:0, _accTimer:0, _dashTs:0,
};

/* ── Vehicle catalogue ──────────────────────────────────── */
const _3DM_V = {
    car:        {color:'#4f9eff',hi:'#c0e0ff',w:48,h:62},
    suv:        {color:'#00e676',hi:'#9affd4',w:52,h:66},
    motorcycle: {color:'#ff9100',hi:'#ffd080',w:30,h:60},
    bus:        {color:'#ffd740',hi:'#fff5a0',w:60,h:68},
    truck:      {color:'#ce93d8',hi:'#eadaff',w:54,h:64},
};

function _3dmLight(hex,amt){const n=parseInt(hex.replace('#',''),16);return `rgb(${Math.min(255,((n>>16)&255)+amt)},${Math.min(255,((n>>8)&255)+amt)},${Math.min(255,(n&255)+amt)})`;}

/* ── Vehicle marker HTML ────────────────────────────────── */
function _3dmMarkerHTML(key) {
    const v = _3DM_V[key] || _3DM_V.car;
    const {color,hi,w,h} = v;
    const hw=w/2, hh=h/2;
    const isMoto=key==='motorcycle', isBus=key==='bus', isTruck=key==='truck';

    const bPath = isMoto
        ? `M0,${-hh*.9} L${hw*.5},${hh*.55} Q0,${hh*.8} ${-hw*.5},${hh*.55}Z`
        : isBus
        ? `M${-hw*.88},${-hh*.9} L${hw*.88},${-hh*.9} L${hw*.9},${hh*.9} L${-hw*.9},${hh*.9}Z`
        : isTruck
        ? `M0,${-hh*.94} L${hw*.82},${-hh*.38} L${hw*.94},${hh*.9} L${-hw*.94},${hh*.9} L${-hw*.82},${-hh*.38}Z`
        : `M0,${-hh*.96} C${hw*.4},${-hh*.96} ${hw*.76},${hh*.28} ${hw*.72},${hh*.55} Q${hw*.64},${hh*.84} 0,${hh*.76} Q${-hw*.64},${hh*.84} ${-hw*.72},${hh*.55} C${-hw*.76},${hh*.28} ${-hw*.4},${-hh*.96} 0,${-hh*.96}Z`;

    const wPath = isMoto
        ? `M${-hw*.28},${-hh*.64} Q0,${-hh*.82} ${hw*.28},${-hh*.64} L${hw*.18},${-hh*.34} Q0,${-hh*.52} ${-hw*.18},${-hh*.34}Z`
        : isBus
        ? `M${-hw*.72},${-hh*.76} L${hw*.72},${-hh*.76} L${hw*.72},${-hh*.42} L${-hw*.72},${-hh*.42}Z`
        : `M${-hw*.44},${-hh*.74} Q0,${-hh*.88} ${hw*.44},${-hh*.74} L${hw*.32},${-hh*.46} Q0,${-hh*.64} ${-hw*.32},${-hh*.46}Z`;

    const hlX=[[-hw*.55,-hh*.86],[hw*.55,-hh*.86]];
    const tlY=hh*(isBus?.84:.70), tlW=hw*.20, tlH=hh*.11;
    const wFrY=-hh*(isBus?.58:.48), wRrY=hh*(isBus?.68:.64), wR=hw*(isMoto?.2:.14);
    const wEls=isMoto?'':[-hw*.58,hw*.58].flatMap(cx=>[
        `<ellipse cx="${cx}" cy="${wFrY}" rx="${wR}" ry="${wR*1.08}" fill="#050810"/>`,
        `<ellipse cx="${cx}" cy="${wRrY}" rx="${wR}" ry="${wR*1.08}" fill="#050810"/>`,
        `<ellipse cx="${cx}" cy="${wFrY}" rx="${wR*.5}" ry="${wR*.5}" fill="rgba(60,65,80,.9)"/>`,
        `<ellipse cx="${cx}" cy="${wRrY}" rx="${wR*.5}" ry="${wR*.5}" fill="rgba(60,65,80,.9)"/>`,
    ]).join('');

    const roofLine=isMoto?'':`<line x1="0" y1="${-hh*.62}" x2="0" y2="${hh*.6}" stroke="rgba(255,255,255,.18)" stroke-width="${isBus?2:1.4}"/>`;
    const sideWins=(key==='car'||key==='suv')?`<rect x="${-hw*.66}" y="${-hh*.22}" width="${hw*.24}" height="${hh*.28}" rx="3" fill="rgba(140,210,255,.38)"/><rect x="${hw*.42}" y="${-hh*.22}" width="${hw*.24}" height="${hh*.28}" rx="3" fill="rgba(140,210,255,.38)"/>`:'';
    const busWins=isBus?[0,1,2,3,4].map(i=>`<rect x="${-hw*.68+i*hw*.28}" y="${-hh*.3}" width="${hw*.22}" height="${hh*.3}" rx="2" fill="rgba(140,210,255,.35)"/>`).join(''):'';

    return `<div style="width:${w}px;height:${h}px;position:relative;pointer-events:none;transform-origin:${hw}px ${hh}px">
  <div style="position:absolute;inset:-${Math.round(w*.55)}px;background:radial-gradient(circle,${color}32 0%,transparent 58%);border-radius:50%;animation:_3dmPulse 2.6s ease-in-out infinite;pointer-events:none;will-change:opacity,transform"></div>
  <svg width="${w}" height="${h}" viewBox="${-hw} ${-hh} ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">
    <defs>
      <linearGradient id="_vg${key}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${hi}"/><stop offset="45%" stop-color="${color}"/><stop offset="100%" stop-color="${color}88"/>
      </linearGradient>
      <linearGradient id="_vsg${key}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="rgba(255,255,255,.22)"/><stop offset="50%" stop-color="rgba(255,255,255,.40)"/><stop offset="100%" stop-color="rgba(255,255,255,.08)"/>
      </linearGradient>
      <filter id="_vf${key}" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="4.5" result="b"/>
        <feFlood flood-color="${color}" flood-opacity=".65" result="c"/>
        <feComposite in="c" in2="b" operator="in" result="g"/>
        <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <ellipse cx="2.5" cy="${hh*.75}" rx="${hw*.62}" ry="${hh*.1}" fill="rgba(0,0,0,.5)"/>
    ${wEls}
    <path d="${bPath}" fill="url(#_vg${key})" filter="url(#_vf${key})"/>
    <path d="${bPath}" fill="url(#_vsg${key})" opacity=".35"/>
    <path d="${wPath}" fill="rgba(165,228,255,.62)" stroke="rgba(255,255,255,.25)" stroke-width=".8"/>
    ${sideWins}${busWins}${roofLine}
    ${hlX.map(([x,y])=>`<ellipse cx="${x}" cy="${y}" rx="${hw*.13}" ry="${hh*.055}" fill="rgba(255,250,220,.96)"/><ellipse cx="${x}" cy="${y}" rx="${hw*.24}" ry="${hh*.11}" fill="rgba(255,250,220,.16)"/>`).join('')}
    <rect x="${-hw*.85}" y="${tlY}" width="${tlW}" height="${tlH}" rx="2.5" fill="rgba(255,38,38,.94)"/>
    <rect x="${hw*.65}" y="${tlY}" width="${tlW}" height="${tlH}" rx="2.5" fill="rgba(255,38,38,.94)"/>
    <rect x="${-hw*.86}" y="${tlY}" width="${tlW*1.6}" height="${tlH*1.5}" rx="3" fill="rgba(255,38,38,.12)"/>
    <rect x="${hw*.54}" y="${tlY}" width="${tlW*1.6}" height="${tlH*1.5}" rx="3" fill="rgba(255,38,38,.12)"/>
    <ellipse cx="0" cy="${-hh*.91}" rx="${hw*.1}" ry="${hh*.048}" fill="rgba(255,255,255,.94)"/>
    <path d="${bPath}" fill="none" stroke="rgba(255,255,255,.16)" stroke-width=".75"/>
  </svg>
</div>`;
}

/* ── Night theme v3 ─────────────────────────────────────── */
function _3dmNightTheme(map) {
    const ls = map.getStyle()?.layers || [];
    ls.forEach(({id,type}) => {
        try {
            if (type==='background') {
                map.setPaintProperty(id,'background-color','#020710');
            } else if (type==='fill') {
                let c='#040912';
                if (/water|ocean|sea|lake|reservoir|bay|wetland/.test(id))            c='#010818';
                else if (/park|garden|forest|wood|grass|green|nature|meadow/.test(id)) c='#021006';
                else if (/building/.test(id))                                          c='#06101c';
                else if (/sand|beach|desert/.test(id))                                c='#07090f';
                else if (/industrial/.test(id))                                        c='#050c16';
                else if (/commercial|retail/.test(id))                                c='#05101e';
                else if (/residential|suburb/.test(id))                               c='#040818';
                else if (/pitch|playground|sport/.test(id))                           c='#030d06';
                map.setPaintProperty(id,'fill-color',c);
                try{map.setPaintProperty(id,'fill-outline-color','rgba(6,18,45,.25)');}catch(_){}
            } else if (type==='line') {
                let c='#0a1628';
                if (/motorway/.test(id))                      c='#263e7a';
                else if (/trunk/.test(id))                    c='#1e3670';
                else if (/primary/.test(id))                  c='#182e5e';
                else if (/secondary/.test(id))                c='#12244a';
                else if (/tertiary/.test(id))                 c='#0e1d38';
                else if (/residential|living_street/.test(id)) c='#0b152c';
                else if (/service|alley/.test(id))            c='#08101e';
                else if (/footway|path|steps/.test(id))       c='#070c18';
                else if (/water|river|canal|stream/.test(id)) c='#040f24';
                else if (/rail|railway|transit/.test(id))     c='#101e36';
                else if (/bridge/.test(id))                   c='#1a2648';
                else if (/boundary|country|state/.test(id))   c='#1c2a48';
                else if (/tunnel/.test(id))                   c='#060c1a';
                map.setPaintProperty(id,'line-color',c);
            } else if (type==='symbol') {
                const isM=/motorway|highway/.test(id), isP=/trunk|primary/.test(id);
                const isC=/city|capital|town|village|place/.test(id);
                const isR=/road|street|secondary|tertiary/.test(id);
                const isW=/water|ocean|sea|lake|river/.test(id);
                let tc='#0c1c36';
                if(isM)tc='#213e76'; else if(isP)tc='#1c3268'; else if(isC)tc='#1e3668'; else if(isR)tc='#121e3c'; else if(isW)tc='#091c3c';
                try{map.setPaintProperty(id,'text-color',tc);}catch(_){}
                try{map.setPaintProperty(id,'text-halo-color','#01040a');}catch(_){}
                try{map.setPaintProperty(id,'text-halo-width',isC?1.6:isP?1.2:0.9);}catch(_){}
                try{map.setPaintProperty(id,'text-halo-blur',0.5);}catch(_){}
                try{map.setPaintProperty(id,'icon-opacity',isC?0.55:isM||isP?0.38:0.14);}catch(_){}
            }
        } catch(_) {}
    });

    // Sky atmosphere
    try {
        if (!map.getLayer('sky')) {
            _3dmSafeAddLayer(map,{id:'sky',type:'sky',paint:{
                'sky-type':'gradient',
                'sky-gradient':['interpolate',['linear'],['sky-radial-progress'],0,'rgba(1,3,10,1)',0.4,'rgba(2,5,16,1)',0.8,'rgba(3,7,22,1)',1,'rgba(5,10,28,1)'],
                'sky-gradient-center':[0,0],'sky-gradient-radius':90,
                'sky-opacity':['interpolate',['linear'],['zoom'],0,0,7,1]
            }});
        }
    } catch(_) {}

    // Road casing
    try {
        if (!map.getLayer('_3rc')) {
            const srcs=map.getStyle()?.sources||{};
            const sk=Object.keys(srcs).find(k=>k==='openmaptiles'||/tile|planet|basemap/.test(k));
            if(sk){
                _3dmSafeAddLayer(map,{id:'_3rc',source:sk,'source-layer':'transportation',type:'line',minzoom:12,
                    layout:{'line-join':'round','line-cap':'butt'},
                    paint:{
                        'line-color':'rgba(0,0,0,.88)',
                        'line-width':['interpolate',['linear'],['zoom'],
                            12,['case',['==',['get','class'],'motorway'],6,['==',['get','class'],'primary'],3.5,1.8],
                            18,['case',['==',['get','class'],'motorway'],16,['==',['get','class'],'primary'],10,4]],
                    }
                },'_3rG');
            }
        }
    } catch(_) {}
}

/* ── 5-layer buildings ──────────────────────────────────── */
function _3dmBuildings(map) {
    const srcs=map.getStyle()?.sources||{};
    const sk=Object.keys(srcs).find(k=>k==='openmaptiles'||k==='maptiler'||/tile|planet|basemap/.test(k));
    if(!sk) return;
    const hE=['coalesce',['get','render_height'],['get','height'],['get','building:height'],8];
    const bE=['coalesce',['get','render_min_height'],['get','min_height'],['get','building:min_height'],0];
    const hA=['interpolate',['linear'],['zoom'],13.5,0,15,hE];
    const bA=['interpolate',['linear'],['zoom'],13.5,0,15,bE];
    const oA=['interpolate',['linear'],['zoom'],13,0,14.5,1];
    try {
        try{map.setLight({anchor:'viewport',color:'hsl(220,60%,85%)',position:[1.2,220,45],intensity:0.6});}catch(_){}
        // L1 Wide shadow
        _3dmSafeAddLayer(map,{id:'_3bs',source:sk,'source-layer':'building',type:'fill-extrusion',minzoom:13,
            paint:{'fill-extrusion-color':'#010309','fill-extrusion-height':hE,'fill-extrusion-base':bE,
                   'fill-extrusion-opacity':['interpolate',['linear'],['zoom'],13,0,14.5,0.80],
                   'fill-extrusion-translate':[7,10],'fill-extrusion-translate-anchor':'viewport'}});
        // L2 Main body
        _3dmSafeAddLayer(map,{id:'_3bm',source:sk,'source-layer':'building',type:'fill-extrusion',minzoom:13,
            paint:{'fill-extrusion-color':['interpolate',['linear'],['zoom'],
                       13,'#06101e',14,'#081528',15,'#0a1932',16,'#0c1f40',17,'#0e2750',18,'#112d60'],
                   'fill-extrusion-height':hA,'fill-extrusion-base':bA,'fill-extrusion-opacity':oA,
                   'fill-extrusion-vertical-gradient':true,
                   'fill-extrusion-ambient-occlusion-intensity':0.85,'fill-extrusion-ambient-occlusion-radius':8}});
        // L3 Warm face (>15m)
        _3dmSafeAddLayer(map,{id:'_3bw',source:sk,'source-layer':'building',type:'fill-extrusion',minzoom:14,
            filter:['>=',['coalesce',['get','height'],0],15],
            paint:{'fill-extrusion-color':['interpolate',['linear'],['zoom'],14,'#0a1930',17,'#0e2646'],
                   'fill-extrusion-height':hE,'fill-extrusion-base':bE,
                   'fill-extrusion-opacity':['interpolate',['linear'],['zoom'],14,0,16,0.30],
                   'fill-extrusion-translate':[-2,-2],'fill-extrusion-translate-anchor':'viewport'}});
        // L4 Cool accent (>30m)
        _3dmSafeAddLayer(map,{id:'_3ba',source:sk,'source-layer':'building',type:'fill-extrusion',minzoom:15,
            filter:['>=',['coalesce',['get','height'],0],30],
            paint:{'fill-extrusion-color':['interpolate',['linear'],['zoom'],15,'#0e2044',18,'#1a3a7a'],
                   'fill-extrusion-height':hE,'fill-extrusion-base':bE,
                   'fill-extrusion-opacity':['interpolate',['linear'],['zoom'],15,0,17,0.35],
                   'fill-extrusion-translate':[-4,-4],'fill-extrusion-translate-anchor':'viewport'}});
        // L5 Roof cap glow
        _3dmSafeAddLayer(map,{id:'_3br',source:sk,'source-layer':'building',type:'fill-extrusion',minzoom:16,
            paint:{'fill-extrusion-color':['interpolate',['linear'],['zoom'],16,'#1e3e6a',19,'#2a6aff'],
                   'fill-extrusion-height':hE,'fill-extrusion-base':['max',['coalesce',['get','height'],0],0.2],
                   'fill-extrusion-opacity':['interpolate',['linear'],['zoom'],15,0,17,0.42,20,0.72]}});
    } catch(e){console.warn('[3D buildings]',e);}
}

/* ── Accuracy ring ──────────────────────────────────────── */
function _3dmAccuracyGeoJSON(lat,lon,accM){
    const safe=Math.max(accM||5,2),steps=64,coords=[],latRad=lat*Math.PI/180,mpd=111320*Math.cos(latRad);
    for(let i=0;i<=steps;i++){const a=(i/steps)*2*Math.PI;coords.push([lon+Math.sin(a)*safe/mpd,lat+Math.cos(a)*safe/111320]);}
    return{type:'Feature',geometry:{type:'Polygon',coordinates:[coords]}};
}
function _3dmUpdateAccRing(lat,lon,acc){
    if(!_3DM.map||!_3DM.styleReady)return;
    const now=performance.now();if(now-_3DM._accTimer<600)return;_3DM._accTimer=now;
    const data=_3dmAccuracyGeoJSON(lat,lon,acc??15);
    try{
        const src=_3DM.map.getSource('_3acc');
        if(src){src.setData(data);return;}
        _3DM.map.addSource('_3acc',{type:'geojson',data});
        _3dmSafeAddLayer(_3DM.map,{id:'_3accF',type:'fill',source:'_3acc',paint:{'fill-color':'rgba(79,158,255,.07)'}});
        _3dmSafeAddLayer(_3DM.map,{id:'_3accL',type:'line',source:'_3acc',paint:{'line-color':'rgba(79,158,255,.55)','line-width':1.5,'line-dasharray':[4,3]}});
    }catch(_){}
}

/* ── Route layers ───────────────────────────────────────── */
function _3dmRouteLayer(map,coords){
    const feat=c=>({type:'Feature',geometry:{type:'LineString',coordinates:c}});
    const seed=coords.length>=2?[coords[0],coords[0]]:[[0,0],[0,0]];
    _3dmSafeAddSource(map,'_3r', {type:'geojson',data:feat(coords)});
    _3dmSafeAddSource(map,'_3rd',{type:'geojson',data:feat(seed)});
    _3dmSafeAddSource(map,'_3rr',{type:'geojson',data:feat(coords)});
    // Outer glow
    _3dmSafeAddLayer(map,{id:'_3rG',type:'line',source:'_3rr',layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'rgba(0,230,118,.09)','line-width':['interpolate',['linear'],['zoom'],10,28,18,56],'line-blur':20}});
    // Mid glow
    _3dmSafeAddLayer(map,{id:'_3rH',type:'line',source:'_3rr',layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'rgba(0,230,118,.32)','line-width':['interpolate',['linear'],['zoom'],10,12,18,26],'line-blur':7}});
    // Main — vivid green
    _3dmSafeAddLayer(map,{id:'_3rM',type:'line',source:'_3rr',layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'#06f080','line-width':['interpolate',['linear'],['zoom'],10,4.5,18,13],'line-opacity':0.95}});
    // Inner core — bright white-green
    _3dmSafeAddLayer(map,{id:'_3rI',type:'line',source:'_3rr',layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'rgba(220,255,238,.95)','line-width':['interpolate',['linear'],['zoom'],10,1.6,18,4.0]}});
    // Animated direction dashes
    _3dmSafeAddLayer(map,{id:'_3rF',type:'line',source:'_3rr',layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'rgba(255,255,255,.65)','line-width':['interpolate',['linear'],['zoom'],10,2.5,18,6],
               'line-dasharray':[2.5,5.5]}});
    // Travelled — dark overlay
    _3dmSafeAddLayer(map,{id:'_3rD',type:'line',source:'_3rd',layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'rgba(0,25,12,.88)','line-width':['interpolate',['linear'],['zoom'],10,5,18,14]}});
    // Destination
    if(coords.length){
        const dest=coords[coords.length-1];
        _3dmSafeAddSource(map,'_3dest',{type:'geojson',data:{type:'Feature',geometry:{type:'Point',coordinates:dest}}});
        _3dmSafeAddLayer(map,{id:'_3destH',type:'circle',source:'_3dest',
            paint:{'circle-radius':['interpolate',['linear'],['zoom'],12,18,18,40],'circle-color':'rgba(255,69,69,.14)','circle-blur':0.5}});
        _3dmSafeAddLayer(map,{id:'_3destO',type:'circle',source:'_3dest',
            paint:{'circle-radius':['interpolate',['linear'],['zoom'],12,8,18,18],'circle-color':'#ff4545',
                   'circle-stroke-color':'rgba(255,255,255,.85)','circle-stroke-width':2.5}});
        _3dmSafeAddLayer(map,{id:'_3destP',type:'circle',source:'_3dest',
            paint:{'circle-radius':4,'circle-color':'rgba(255,255,255,.95)','circle-stroke-color':'#ff4545','circle-stroke-width':2}});
        // Start dot
        const start=coords[0];
        _3dmSafeAddSource(map,'_3strt',{type:'geojson',data:{type:'Feature',geometry:{type:'Point',coordinates:start}}});
        _3dmSafeAddLayer(map,{id:'_3strtO',type:'circle',source:'_3strt',
            paint:{'circle-radius':['interpolate',['linear'],['zoom'],12,6,18,12],'circle-color':'#4f9eff',
                   'circle-stroke-color':'rgba(255,255,255,.8)','circle-stroke-width':2}});
    }
}

/* ── Animate flow dashes ────────────────────────────────── */
let _3dmDashStep=0;
function _3dmAnimateDashes(){
    if(!_3DM.map||!_3DM.styleReady)return;
    const now=performance.now();if(now-_3DM._dashTs<80)return;_3DM._dashTs=now;
    _3dmDashStep=(_3dmDashStep+0.5)%9;
    try{
        const d=_3dmDashStep;
        _3DM.map.setPaintProperty('_3rF','line-dasharray',[Math.max(0.1,3-d%3),Math.max(0.1,6-d%6)]);
    }catch(_){}
}

/* ── Update route ───────────────────────────────────────── */
function _3dmUpdateRoute(lat,lon){
    if(!_3DM.map||!_3DM.styleReady)return;
    const lls=_3DM.routeLLs;if(lls.length<2)return;
    const now=performance.now();if(now-_3DM._routeTimer<150)return;_3DM._routeTimer=now;
    try{
        const near=_nearestPointOnRoute(lat,lon,lls);
        const doneLL=[...lls.slice(0,near.idx+1),[near.lat,near.lon]];
        const remainLL=[[near.lat,near.lon],...lls.slice(near.idx+1)];
        const toC=a=>a.map(([x,y])=>[y,x]);
        _3DM.map.getSource('_3rd')?.setData({type:'Feature',geometry:{type:'LineString',coordinates:toC(doneLL)}});
        _3DM.map.getSource('_3rr')?.setData({type:'Feature',geometry:{type:'LineString',coordinates:toC(remainLL)}});
        let d=0;for(let i=0;i<doneLL.length-1;i++)d+=_haversineJS(doneLL[i][0],doneLL[i][1],doneLL[i+1][0],doneLL[i+1][1]);
        _3DM.travelledDist=d;
    }catch(_){}
}

/* ── Vehicle marker ─────────────────────────────────────── */
function _3dmAddVehicle(map,lon,lat,bear,key){
    if(!map||!isFinite(lon)||!isFinite(lat))return;
    const el=document.createElement('div');
    el.innerHTML=_3dmMarkerHTML(key);
    el.style.cssText='pointer-events:none;transform-origin:center center';
    try{
        _3DM.vehicleMarker=new maplibregl.Marker({element:el,rotationAlignment:'map',pitchAlignment:'map',anchor:'center'})
            .setLngLat([lon,lat]).setRotation(bear).addTo(map);
    }catch(e){console.warn('[3D vehicle]',e);}
}

/* ── Device orientation ─────────────────────────────────── */
function _3dmStartDeviceOrientation(){
    if(_3DM._devOrFn)return;
    const h=e=>{if(!_3DM.active)return;const a=e.webkitCompassHeading??(e.alpha!=null?(360-e.alpha):null);if(a==null)return;_3DM.devBearing=a;_3DM.devOrient=true;};
    window.addEventListener('deviceorientationabsolute',h,{passive:true});
    window.addEventListener('deviceorientation',h,{passive:true});
    _3DM._devOrFn=h;
}
function _3dmStopDeviceOrientation(){
    if(!_3DM._devOrFn)return;
    window.removeEventListener('deviceorientationabsolute',_3DM._devOrFn);
    window.removeEventListener('deviceorientation',_3DM._devOrFn);
    _3DM._devOrFn=null;_3DM.devOrient=false;
}

/* ── Speed-reactive zoom ────────────────────────────────── */
function _3dmSpeedZoom(kmh){
    if(kmh<2)  return 18.5;
    if(kmh<15) return 18.0;
    if(kmh<40) return 17.5;
    if(kmh<80) return 17.0;
    return 16.5;
}

/* ── Camera follow ──────────────────────────────────────── */
function _3dmFollowCam(dt){
    if(!_3DM.map||!_3DM.styleReady||_3DM.rndLat===null)return;
    if(_3DM.userRotating||(_3DM.map.isMoving?.()&&!_3DM.followMode))return;
    const jp={pitch:_3DM.pitchMode};
    if(_3DM.followMode){
        const aPos=Math.min(1,dt*7.0); // faster catch-up
        _3DM.camLat+=(_3DM.rndLat-_3DM.camLat)*aPos;
        _3DM.camLon+=(_3DM.rndLon-_3DM.camLon)*aPos;
        jp.center=[_3DM.camLon,_3DM.camLat];
        const spd=_navActive?userSpeedKmh:0;
        const tZ=_3dmSpeedZoom(spd);
        _3DM.zoomNav+=((tZ)-_3DM.zoomNav)*Math.min(1,dt*1.2); // faster zoom
        jp.zoom=Math.round(_3DM.zoomNav*10)/10; // no sub-pixel jitter
    }
    if(_3DM.followHeading){
        // Speed-adaptive bearing: faster when moving, gentler when stationary
        const bSpd=typeof userSpeedKmh!=='undefined'?userSpeedKmh:0;
        const aBear=Math.min(1,dt*(bSpd>10?5.5:bSpd>2?3.5:1.5));
        const bd=_angleDiff(_3DM.camBearing,_3DM.tgtBearing);
        if(Math.abs(bd)>0.1){ // skip tiny corrections
            _3DM.camBearing=(_3DM.camBearing+bd*aBear+360)%360;
            jp.bearing=Math.round(_3DM.camBearing*10)/10;
        }
    }
    if(Object.keys(jp).length>1){try{_3DM.map.jumpTo(jp);}catch(_){}}
    const rb=_3DM.followHeading?_3DM.camBearing:(_3DM.map?.getBearing()??0);
    const cp=$('nav3d-compass');if(cp)cp.style.transform=`rotate(${-rb}deg)`;
}

/* ── Speed colour ───────────────────────────────────────── */
function _3dmSpeedColor(kmh){
    if(kmh<1)  return '#4a6a8a';
    if(kmh<30) return '#00e676';
    if(kmh<60) return '#4f9eff';
    if(kmh<90) return '#ffd740';
    return '#ff4545';
}

/* ── HUD ────────────────────────────────────────────────── */
function _3dmHUD(){
    const spd=_navActive?Math.round(userSpeedKmh||0):0;
    const sEl=$('nav3d-speed'),sBadge=$('nav3d-speed-badge');
    if(sEl)sEl.textContent=spd;
    if(sBadge){const sc=_3dmSpeedColor(spd);sBadge.style.borderColor=sc;sBadge.style.boxShadow=spd>2?`0 0 18px ${sc}50,inset 0 0 20px ${sc}10`:'inset 0 0 20px rgba(79,158,255,.05)';}
    const dEl=$('nav3d-dist'),eEl=$('nav3d-eta');
    const nhDist=$('nav-hud-dist'),nhTime=$('nav-hud-time');
    const rem=Math.max(0,_3DM.totalDist-_3DM.travelledDist);
    if(dEl)dEl.textContent=(_navActive&&nhDist?.textContent&&nhDist.textContent!=='—')?nhDist.textContent:_3dmFmtD(rem);
    if(eEl)eEl.textContent=(_navActive&&nhTime?.textContent&&nhTime.textContent!=='—')?nhTime.textContent:_3dmFmtT(rem);
    const dirs=['↑','↗','→','↘','↓','↙','←','↖'];
    const dArr=$('nav3d-dir-arrow');if(dArr)dArr.textContent=dirs[Math.round(_3DM.tgtBearing/45)%8];
    const tDist=$('nav3d-turn-dist');if(tDist)tDist.textContent=(_navActive&&nhDist?.textContent&&nhDist.textContent!=='—')?nhDist.textContent:_3dmFmtD(rem);
    const nhStreet=$('nav-hud-street'),streetEl=$('nav3d-turn-street');
    if(streetEl)streetEl.textContent=(_navActive&&nhStreet?.textContent&&nhStreet.textContent.length>3)?nhStreet.textContent:_bearingToDirection(_3DM.tgtBearing);
    const rcBtn=$('nav3d-recenter');if(rcBtn){const lost=!_3DM.followMode||!_3DM.followHeading;rcBtn.classList.toggle('active',lost);}
    const gpsStat=$('nav3d-gps-status');
    if(gpsStat){
        if(!_navActive){gpsStat.textContent='⬛ Tap Navigate first';gpsStat.style.color='rgba(79,158,255,.45)';}
        else if(_gpsUsingFallback||userLat===null){gpsStat.textContent='📡 Acquiring GPS…';gpsStat.style.color='rgba(255,173,0,.75)';}
        else{const acc=_lastFixAccuracy;const aStr=(acc&&acc<9999)?`±${Math.round(acc)}m`:'';gpsStat.textContent=`📍 GPS ${aStr}${_3DM.devOrient?' 🧭':''}`;gpsStat.style.color=acc<15?'rgba(0,230,118,.85)':acc<50?'rgba(255,215,0,.8)':'rgba(255,120,0,.8)';}
    }
    const hBtn=$('nav3d-heading-lock');if(hBtn)hBtn.classList.toggle('is-active',_3DM.followHeading);
    const pFill=$('nav3d-progress-fill');
    if(pFill&&_3DM.totalDist>0)pFill.style.width=`${Math.min(100,(_3DM.travelledDist/_3DM.totalDist)*100).toFixed(1)}%`;
}
function _3dmFmtD(m){if(!isFinite(m)||m<=0)return '—';return m<1000?`${Math.round(m)}m`:`${(m/1000).toFixed(1)}km`;}
function _3dmFmtT(rem){if(!isFinite(rem)||rem<=0)return '—';const sp=_navActive?(userSpeedKmh>3?userSpeedKmh:30):30;const min=Math.max(1,Math.round((rem/1000)/sp*60));return min<60?`${min} min`:`${Math.floor(min/60)}h ${min%60}m`;}

/* ── Main loop ──────────────────────────────────────────── */
function _3dmLoop(ts){
    if(!_3DM.active)return;
    const dt=_3DM.lastTs?Math.min((ts-_3DM.lastTs)/1000,0.08):0.016;
    _3DM.lastTs=ts;
    if(userLat!==null&&userLon!==null&&!_gpsUsingFallback){_3DM.curLat=userLat;_3DM.curLon=userLon;_3DM.curAcc=_lastFixAccuracy??15;}
    if(_3DM.curLat===null){_3dmHUD();_3DM.rafId=requestAnimationFrame(_3dmLoop);return;}
    if(_3DM.rndLat===null){_3DM.rndLat=_3DM.curLat;_3DM.rndLon=_3DM.curLon;}
    else{const a=Math.min(1,dt*12.0);_3DM.rndLat+=(_3DM.curLat-_3DM.rndLat)*a;_3DM.rndLon+=(_3DM.curLon-_3DM.rndLon)*a;}
    if(_navActive&&userHeading!==null&&userSpeedKmh>2.5){_3DM.gpsBearing=userHeading;if(_3DM.followHeading)_3DM.tgtBearing=userHeading;}
    else if(_3DM.devOrient&&_3DM.followHeading){_3DM.tgtBearing=_3DM.devBearing;}
    if(_3DM.vehicleMarker&&_3DM.styleReady){try{_3DM.vehicleMarker.setLngLat([_3DM.rndLon,_3DM.rndLat]);_3DM.vehicleMarker.setRotation(_3DM.tgtBearing);}catch(_){}}
    if(_3DM.styleReady)_3dmUpdateAccRing(_3DM.rndLat,_3DM.rndLon,_3DM.curAcc);
    if(_3DM.styleReady&&_navActive&&_3DM.routeLLs.length>=2)_3dmUpdateRoute(_3DM.rndLat,_3DM.rndLon);
    if(_3DM.styleReady)_3dmAnimateDashes();
    _3dmFollowCam(dt);_3dmHUD();
    _3DM.rafId=requestAnimationFrame(_3dmLoop);
}

function _3dComputeRouteLen(lls){let d=0;for(let i=0;i+1<lls.length;i++)d+=_haversineJS(lls[i][0],lls[i][1],lls[i+1][0],lls[i+1][1]);return d;}

/* ── Open 3D ────────────────────────────────────────────── */
function open3DView(routeIdx){
    const idx=(routeIdx!=null)?routeIdx:(_navRouteIdx??0);
    const grp=routeGrps[idx];
    if(!grp?.lls?.length||grp.lls.length<2){showError('Search a route first.',4000);return;}
    if(typeof maplibregl==='undefined'){showError('3D map loading…',3500);return;}
    if(_3DM.active)close3DView();
    _3DM.routeLLs=grp.lls.slice();_3DM.routeCoords=grp.lls.map(([a,b])=>[b,a]);
    _3DM.totalDist=_3dComputeRouteLen(grp.lls);_3DM.travelledDist=0;_3DM._routeTimer=0;_3DM._accTimer=0;
    const hasGPS=userLat!==null&&userLon!==null&&!_gpsUsingFallback;
    const sLat=hasGPS?userLat:grp.lls[0][0],sLon=hasGPS?userLon:grp.lls[0][1];
    const sBear=grp.lls.length>=2?_bearingDeg(grp.lls[0][0],grp.lls[0][1],grp.lls[1][0],grp.lls[1][1]):0;
    Object.assign(_3DM,{active:true,styleReady:false,lastTs:null,followMode:true,followHeading:true,userRotating:false,
        curLat:hasGPS?userLat:null,curLon:hasGPS?userLon:null,curAcc:_lastFixAccuracy??20,
        rndLat:hasGPS?userLat:null,rndLon:hasGPS?userLon:null,camLat:sLat,camLon:sLon,
        camBearing:sBear,tgtBearing:hasGPS?(userHeading??sBear):sBear,gpsBearing:sBear,zoomNav:18.0});
    const ov=$('nav-3d-overlay');if(ov){ov.classList.remove('hidden');requestAnimationFrame(()=>ov.classList.add('show'));}
    document.body.classList.add('nav-3d-mode');
    const loaderEl=$('nav3d-loader');if(loaderEl)loaderEl.classList.remove('hidden');
    _3dmStartDeviceOrientation();
    setTimeout(()=>{
        if(!_3DM.active)return;
        _3DM.map=new maplibregl.Map({
            container:'nav-3d-map',style:'https://tiles.openfreemap.org/styles/liberty',
            center:[sLon,sLat],zoom:_3DM.zoomNav,pitch:_3DM.pitchMode,bearing:sBear,
            antialias:true,attributionControl:false,logoPosition:'bottom-right',
            maxBounds:INDIA_BOUNDS,minZoom:4,maxZoom:20,maxTileCacheSize:300,
            dragRotate:true,touchZoomRotate:true,touchPitch:true,keyboard:false,renderWorldCopies:false,
        });
        _3DM.map.on('load',()=>{
            if(!_3DM.active){try{_3DM.map?.remove();}catch(_){}return;}
            try{
                _3dmNightTheme(_3DM.map);_3dmBuildings(_3DM.map);
                _3dmRouteLayer(_3DM.map,_3DM.routeCoords);
                _3dmAddVehicle(_3DM.map,sLon,sLat,sBear,_3DM.vehicle);
                _3dmUpdateAccRing(sLat,sLon,_3DM.curAcc);
                _3DM.map.addControl(new maplibregl.ScaleControl({unit:'metric',maxWidth:90}),'bottom-right');
                _3DM.styleReady=true;if(loaderEl)loaderEl.classList.add('hidden');
            }catch(e){console.error('[3D load]',e);}
        });
        _3DM.map.on('error',e=>{const m=e?.error?.message||String(e);if(!m.includes('404')&&!m.includes('cancel')&&!m.includes('abort'))console.warn('[3D]',m);});
        _3DM.map.on('dragstart',()=>{_3DM.followMode=false;});
        _3DM.map.on('zoomstart',()=>{_3DM.followMode=false;_3DM.zoomNav=_3DM.map?.getZoom()??18;});
        _3DM.map.on('zoomend',()=>{_3DM.zoomNav=_3DM.map?.getZoom()??18;});
        _3DM.map.on('rotatestart',()=>{_3DM.userRotating=true;_3DM.followHeading=false;});
        _3DM.map.on('rotateend',()=>{_3DM.userRotating=false;_3DM.camBearing=(_3DM.map?.getBearing()??0);_3DM.tgtBearing=_3DM.camBearing;});
        _3DM.map.on('pitchend',()=>{_3DM.pitchMode=Math.round(_3DM.map.getPitch());});
        _3DM.rafId=requestAnimationFrame(_3dmLoop);
        window._3dmRzFn=()=>{try{_3DM.map?.resize();}catch(_){}};
        window.addEventListener('resize',window._3dmRzFn);
    },80);
}

/* ── Close 3D ───────────────────────────────────────────── */
/* All 3D layer/source IDs — clean before map.remove() to avoid WebGL leaks */
const _3DM_LAYER_IDS = ['_3bs','_3bm','_3bw','_3ba','_3br','sky','_3rc','_3pg',
    '_3rG','_3rH','_3rM','_3rI','_3rF','_3rD','_3destH','_3destO','_3destP','_3strtO',
    '_3accF','_3accL'];
const _3DM_SOURCE_IDS = ['_3r','_3rd','_3rr','_3dest','_3strt','_3acc'];

function close3DView(){
    _3DM.active=false;_3DM.styleReady=false;
    if(_3DM.rafId){cancelAnimationFrame(_3DM.rafId);_3DM.rafId=null;}
    _3dmStopDeviceOrientation();
    if(window._3dmRzFn){window.removeEventListener('resize',window._3dmRzFn);window._3dmRzFn=null;}
    try{_3DM.vehicleMarker?.remove();}catch(_){}_3DM.vehicleMarker=null;
    // Cleanly remove all layers+sources before map.remove() to prevent WebGL leaks
    if(_3DM.map){
        try{
            _3DM_LAYER_IDS.forEach(id=>{try{if(_3DM.map.getLayer&&_3DM.map.getLayer(id))_3DM.map.removeLayer(id);}catch(_){}});
            _3DM_SOURCE_IDS.forEach(id=>{try{if(_3DM.map.getSource&&_3DM.map.getSource(id))_3DM.map.removeSource(id);}catch(_){}});
        }catch(_){}
        try{_3DM.map.remove();}catch(_){}
    }
    _3DM.map=null;
    _3DM.rndLat=null;_3DM.rndLon=null;_3DM.curLat=null;_3DM.curLon=null;
    const ov=$('nav-3d-overlay');
    if(ov){ov.classList.remove('show');setTimeout(()=>ov.classList.add('hidden'),380);}
    document.body.classList.remove('nav-3d-mode');
}

function _3dmSyncRecenter(){const btn=$('nav3d-recenter');if(btn)btn.classList.toggle('active',!_3DM.followMode||!_3DM.followHeading);}

/* ── Controls ───────────────────────────────────────────── */
(function _setup3DControls(){
    const nav3dBtn=$('nav-3d-btn');
    if(nav3dBtn)nav3dBtn.addEventListener('click',()=>{
        if(_3DM.active){close3DView();nav3dBtn.classList.remove('is-active');}
        else{if(!_navActive&&routeGrps.length===0){showError('Search a route first.',4000);return;}open3DView(_navActive?_navRouteIdx:0);nav3dBtn.classList.add('is-active');}
    });
    const exitBtn=$('nav-3d-exit');if(exitBtn)exitBtn.addEventListener('click',()=>{close3DView();if(nav3dBtn)nav3dBtn.classList.remove('is-active');});
    const rcBtn=$('nav3d-recenter');if(rcBtn)rcBtn.addEventListener('click',()=>{
        _3DM.followMode=true;_3DM.followHeading=true;_3DM.userRotating=false;
        if(_3DM.map&&_3DM.styleReady&&_3DM.rndLat!==null)_3DM.map.easeTo({center:[_3DM.rndLon,_3DM.rndLat],bearing:_3DM.tgtBearing,pitch:_3DM.pitchMode,zoom:_3DM.zoomNav,duration:650,easing:t=>1-Math.pow(1-t,3)});
    });
    const tiltBtn=$('nav3d-tilt');if(tiltBtn)tiltBtn.addEventListener('click',()=>{
        _3DM.pitchMode=_3DM.pitchMode>10?0:63;tiltBtn.classList.toggle('is-active',_3DM.pitchMode<10);
        if(_3DM.map&&_3DM.styleReady)_3DM.map.easeTo({pitch:_3DM.pitchMode,duration:700,easing:t=>1-Math.pow(1-t,3)});
    });
    const hBtn=$('nav3d-heading-lock');if(hBtn)hBtn.addEventListener('click',()=>{
        _3DM.followHeading=!_3DM.followHeading;hBtn.classList.toggle('is-active',_3DM.followHeading);
        if(_3DM.followHeading&&_3DM.map&&_3DM.styleReady)_3DM.map.easeTo({bearing:_3DM.tgtBearing,duration:500,easing:t=>1-Math.pow(1-t,3)});
    });
    document.querySelectorAll('.vehicle-chip').forEach(chip=>{
        chip.addEventListener('click',()=>{
            const v=chip.dataset.vehicle;if(!v)return;
            _3DM.vehicle=v;
            document.querySelectorAll('.vehicle-chip').forEach(c=>{c.classList.toggle('active',c.dataset.vehicle===v);c.setAttribute('aria-pressed',String(c.dataset.vehicle===v));});
            if(_3DM.active&&_3DM.vehicleMarker&&_3DM.map){const pos=_3DM.vehicleMarker.getLngLat(),rot=_3DM.tgtBearing;try{_3DM.vehicleMarker.remove();}catch(_){}_3DM.vehicleMarker=null;_3dmAddVehicle(_3DM.map,pos.lng,pos.lat,rot,v);}
        });
    });
})();

/* ── Boot ───────────────────────────────────────────────────── */

/* roundRect polyfill for Safari < 15.4 and older Android WebView */
if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        const rad = Array.isArray(r) ? r[0] : (r || 0);
        this.beginPath();
        this.moveTo(x + rad, y);
        this.lineTo(x + w - rad, y);
        this.quadraticCurveTo(x + w, y, x + w, y + rad);
        this.lineTo(x + w, y + h - rad);
        this.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
        this.lineTo(x + rad, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - rad);
        this.lineTo(x, y + rad);
        this.quadraticCurveTo(x, y, x + rad, y);
        this.closePath();
        return this;
    };
}

(function checkHttps() {
    const proto = location.protocol;
    const host = location.hostname;
    const isSecure = proto === 'https:' || host === 'localhost' || host === '127.0.0.1';
    if (!isSecure) {
        const urlEl = document.getElementById('https-url');
        if (httpsBanner && urlEl) {
            const port = location.port ? `:${location.port}` : '';
            urlEl.textContent = `https://${host}${port}`;
            httpsBanner.classList.remove('hidden');
            document.body.classList.add('has-banner');
        }
    }
})();

_syncNavControls();
initGPS();

/* ================================================================
   SMARTNAV UI v13 — Bottom Nav + Pages + AI Routes + Trip History
================================================================ */

'use strict'; // scoped via closure

/* ================================================================
   SMARTNAV UI v14 — Settings, Themes, Trip History, Bottom Nav
================================================================ */
(function SmartNavUI() {

const TRIPS_KEY = 'smartnav.trips.v2';
const PREFS_KEY = 'smartnav.prefs.v2';

/* ── Prefs helpers ──────────────────────────────────────── */
function _loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)||'{}'); } catch(_){return{};} }
function _savePrefs(p){ try { localStorage.setItem(PREFS_KEY,JSON.stringify(p)); } catch(_){} }
function _loadTrips()  { try { return JSON.parse(localStorage.getItem(TRIPS_KEY)||'[]'); } catch(_){return[];} }
function _saveTrips(t) { try { localStorage.setItem(TRIPS_KEY,JSON.stringify(t.slice(0,150))); } catch(_){} }

/* ── Theme engine ───────────────────────────────────────── */
const THEMES = ['dark','amoled','midnight','light'];

function _applyTheme(name) {
    const t = THEMES.includes(name) ? name : 'dark';
    document.body.className = document.body.className
        .split(' ')
        .filter(c => !c.startsWith('theme-'))
        .join(' ') + ` theme-${t}`;
    // Update meta theme-color
    const meta = document.getElementById('meta-theme-color');
    const colors = {dark:'#060b13',amoled:'#000000',midnight:'#03060e',light:'#f0f4f8'};
    if (meta) meta.content = colors[t] || '#060b13';
    // Update theme picker UI
    document.querySelectorAll('.theme-chip').forEach(c => {
        const active = c.dataset.theme === t;
        c.classList.toggle('active', active);
        c.setAttribute('aria-checked', String(active));
    });
    // Persist
    const p = _loadPrefs(); p.theme = t; _savePrefs(p);
}

function _initThemePicker() {
    document.querySelectorAll('.theme-chip').forEach(btn => {
        btn.addEventListener('click', () => _applyTheme(btn.dataset.theme));
    });
}

/* ── Trip recording ─────────────────────────────────────── */
function _recordTrip(dest, distKm, durMin, label) {
    const trips = _loadTrips();
    const tags = _inferTags(dest, distKm);
    trips.unshift({ id:Date.now(), dest:dest||'Unknown',
        distKm:Math.round(distKm*10)/10, durMin:Math.round(durMin),
        ts:Date.now(), tags, routeLabel:label||'' });
    _saveTrips(trips);
    _renderProfileStats(); _renderRecentTrips();
}

function _inferTags(dest, km) {
    const d=(dest||'').toLowerCase(), tags=[];
    if(/office|work|tech|hub|corporate|it park|business/.test(d)) tags.push('work');
    else if(/beach|park|garden|mall|cinema|hotel|resort|lake|hill/.test(d)) tags.push('leisure');
    else if(/airport|railway|station|bus stand|terminal/.test(d)) tags.push('travel');
    if(km<10&&km>0) tags.push('eco');
    return tags;
}

function _calcStats(trips) {
    const totalKm = Math.round(trips.reduce((s,t)=>s+(t.distKm||0),0)*10)/10;
    const totalHrs= Math.round(trips.reduce((s,t)=>s+(t.durMin||0),0)/60*10)/10;
    const ai = trips.length>0?Math.min(99,70+Math.floor(trips.length*1.8)):0;
    return {totalKm, trips:trips.length, totalHrs, ai};
}

/* ── Render stats ───────────────────────────────────────── */
function _renderProfileStats() {
    const s = _calcStats(_loadTrips());
    const set = (id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
    set('stat-trips',   s.trips);
    set('act-total-km', s.totalKm);
    set('act-total-trips', s.trips);
    set('act-total-hrs', s.totalHrs);
    const sd=document.getElementById('stat-distance');
    if(sd) sd.innerHTML=`${s.totalKm} <span class="stat-unit">km</span>`;
    const sh=document.getElementById('stat-hours');
    if(sh) sh.innerHTML=`${s.totalHrs} <span class="stat-unit">h</span>`;
    const sa=document.getElementById('stat-ai');
    if(sa) sa.textContent=`${s.ai}%`;
}

/* ── Animated counter ───────────────────────────────────── */
function _animNum(el,target,dur=700){
    if(!el)return;
    const start=parseFloat(el.textContent)||0;
    if(Math.abs(start-target)<0.01){el.textContent=target;return;}
    const t0=performance.now();
    const step=ts=>{
        const p=Math.min(1,(ts-t0)/dur),e=1-Math.pow(1-p,3);
        const v=start+(target-start)*e;
        el.textContent=Number.isInteger(target)?Math.round(v):v.toFixed(1);
        if(p<1)requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

/* ── Trip card HTML ─────────────────────────────────────── */
function _esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function _destEmoji(dest){
    const d=(dest||'').toLowerCase();
    if(/airport|terminal|fly/.test(d))return'✈️';
    if(/railway|station|metro|bus/.test(d))return'🚉';
    if(/hospital|medical|clinic/.test(d))return'🏥';
    if(/beach|lake|park|garden/.test(d))return'🌊';
    if(/mall|market|bazaar|shop/.test(d))return'🛒';
    if(/hotel|resort|inn/.test(d))return'🏨';
    if(/restaurant|food|dhaba|café|coffee/.test(d))return'🍽️';
    if(/office|corporate|tech|it park/.test(d))return'🏢';
    if(/temple|mandir|mosque|church|gurudwara/.test(d))return'🛕';
    return'📍';
}

function _tripCardHTML(trip){
    const d=new Date(trip.ts);
    const dateStr=d.toLocaleDateString('en-IN',{month:'short',day:'numeric'});
    const tags=(trip.tags||[]).map(t=>`<span class="trip-tag trip-tag-${_esc(t)}">${_esc(t.charAt(0).toUpperCase()+t.slice(1))}</span>`).join('');
    const prefs=_loadPrefs();
    const distLabel=prefs.units==='mi'?`${(trip.distKm*0.621371).toFixed(1)} mi`:`${trip.distKm} km`;
    return `<div class="trip-card" role="listitem" tabindex="0" data-dest="${_esc(trip.dest)}">
    <div class="trip-map-thumb">${_destEmoji(trip.dest)}</div>
    <div class="trip-info">
        <div class="trip-dest">${_esc(trip.dest)}</div>
        <div class="trip-meta">${dateStr} • ${distLabel} • ${trip.durMin} min</div>
        <div class="trip-tags">${tags}</div>
    </div>
    <svg class="trip-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
</div>`;
}

function _bindTripClicks(container){
    container.querySelectorAll('.trip-card').forEach(card=>{
        const go=()=>{
            _openPage(null);
            const inp=document.getElementById('dest-input');
            if(inp) inp.value=card.dataset.dest||'';
            const form=document.getElementById('search-form');
            if(form) form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        };
        card.addEventListener('click',go);
        card.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
    });
}

function _renderRecentTrips(filter){
    let trips=_loadTrips();
    if(filter&&filter!=='all') trips=trips.filter(t=>(t.tags||[]).includes(filter));
    const recent3=_loadTrips().slice(0,3);

    const rList=document.getElementById('recent-trips-list');
    if(rList){
        if(!recent3.length){rList.innerHTML='<div class="trips-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(79,158,255,.3)" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg><p>No trips yet. Start navigating!</p></div>';}
        else{rList.innerHTML=recent3.map(_tripCardHTML).join('');_bindTripClicks(rList);}
    }
    const aList=document.getElementById('activity-list');
    if(aList){
        if(!trips.length){aList.innerHTML='<div class="trips-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(79,158,255,.3)" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><p>No activity yet.</p></div>';}
        else{aList.innerHTML=trips.map(_tripCardHTML).join('');_bindTripClicks(aList);}
    }
    _renderRecentPlaces();
}

function _renderRecentPlaces(){
    const trips=_loadTrips().slice(0,8);
    const list=document.getElementById('recent-places-list');
    if(!list)return;
    if(!trips.length){list.innerHTML='<div style="padding:10px 0;color:var(--muted);font-size:.78rem">No recent places yet.</div>';return;}
    const seen=new Set();
    const uniq=trips.filter(t=>{if(seen.has(t.dest))return false;seen.add(t.dest);return true;}).slice(0,6);
    list.innerHTML=uniq.map(t=>`<div class="recent-place-item" role="listitem" tabindex="0" data-dest="${_esc(t.dest)}">
    <div class="recent-place-icon">${_destEmoji(t.dest)}</div>
    <div class="recent-place-info"><div class="recent-place-name">${_esc(t.dest)}</div>
    <div class="recent-place-sub">${t.distKm}km • ${new Date(t.ts).toLocaleDateString('en-IN',{month:'short',day:'numeric'})}</div></div>
</div>`).join('');
    list.querySelectorAll('.recent-place-item').forEach(item=>{
        const go=()=>{_openPage(null);const inp=document.getElementById('dest-input');if(inp)inp.value=item.dataset.dest||'';const form=document.getElementById('search-form');if(form)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));};
        item.addEventListener('click',go);item.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
    });
}

/* ── Settings page logic ────────────────────────────────── */
function _initSettings(){
    const prefs=_loadPrefs();

    // Load saved values
    document.querySelectorAll('[data-pref]').forEach(btn=>{
        const key=btn.dataset.pref;
        const val=btn.dataset.val;
        if(prefs[key]===val){btn.classList.add('active');}
        btn.addEventListener('click',()=>{
            document.querySelectorAll(`[data-pref="${key}"]`).forEach(b=>b.classList.remove('active'));
            btn.classList.add('active');
            const p=_loadPrefs();p[key]=val;_savePrefs(p);
            _onPrefChange(key,val);
        });
    });

    // Checkboxes
    const swMap={
        'sw-speed-alerts':'speedAlerts','sw-auto-reroute':'autoReroute',
        'sw-wakelock':'wakelock','sw-traffic':'showTraffic',
        'sw-3d-buildings':'show3dBuildings','sw-kalman':'kalmanSmoothing',
        'sw-acc-ring':'showAccRing',
    };
    Object.entries(swMap).forEach(([id,key])=>{
        const el=document.getElementById(id);
        if(!el)return;
        if(prefs[key]===false) el.checked=false;
        el.addEventListener('change',()=>{const p=_loadPrefs();p[key]=el.checked;_savePrefs(p);_onPrefChange(key,el.checked);});
    });

    // WakeLock management
    let _wakeLock=null;
    async function _requestWakeLock(){
        if(!('wakeLock' in navigator)) return;
        const p=_loadPrefs();if(p.wakelock===false) return;
        try{
            _wakeLock=await navigator.wakeLock.request('screen');
            _wakeLock.addEventListener('release',()=>{ _wakeLock=null; });
        }catch(_){}
    }
    async function _releaseWakeLock(){
        if(_wakeLock){try{await _wakeLock.release();}catch(_){}_wakeLock=null;}
    }
    document.getElementById('sw-wakelock')?.addEventListener('change',e=>{
        e.target.checked?_requestWakeLock():_releaseWakeLock();
    });
    // Re-acquire on visibility change (browser revokes on tab switch)
    document.addEventListener('visibilitychange',async()=>{
        if(document.visibilityState==='visible'&&typeof _navActive!=='undefined'&&_navActive){
            await _requestWakeLock();
        }
    });
    if(prefs.wakelock!==false) _requestWakeLock();

    // GPS diagnostics button
    const gpsDiag=document.getElementById('gps-diag-btn');
    if(gpsDiag){
        let panel=null;
        gpsDiag.addEventListener('click',()=>{
            if(!panel){
                panel=document.createElement('div');
                panel.className='gps-diag-panel';
                gpsDiag.parentElement.appendChild(panel);
            }
            const show=!panel.classList.contains('show');
            panel.classList.toggle('show',show);
            if(show) _updateGpsDiag(panel);
        });
    }

    // Edit profile name
    const editProfileBtn=document.getElementById('edit-profile-btn');
    if(editProfileBtn) editProfileBtn.addEventListener('click',()=>{
        _showModal('Enter your name','Your Name',(val)=>{
            if(!val.trim())return;
            const p=_loadPrefs();p.name=val.trim();_savePrefs(p);
            const el=document.getElementById('profile-name');if(el)el.textContent=val.trim();
            const disp=document.getElementById('profile-name-display');if(disp)disp.textContent=val.trim();
        },_loadPrefs().name||'');
    });

    // Set home
    const homeBtn=document.getElementById('set-home-btn');
    if(homeBtn) homeBtn.addEventListener('click',()=>{
        _showModal('Set Home Location','e.g. My House, Pune',(val)=>{
            if(!val.trim())return;
            const p=_loadPrefs();p.home=val.trim();_savePrefs(p);
            const sub=document.getElementById('home-label-sub');if(sub)sub.textContent=val.trim();
        },_loadPrefs().home||'');
    });

    // Set work
    const workBtn=document.getElementById('set-work-btn');
    if(workBtn) workBtn.addEventListener('click',()=>{
        _showModal('Set Work Location','e.g. Office, Whitefield Bangalore',(val)=>{
            if(!val.trim())return;
            const p=_loadPrefs();p.work=val.trim();_savePrefs(p);
            const sub=document.getElementById('work-label-sub');if(sub)sub.textContent=val.trim();
        },_loadPrefs().work||'');
    });

    // Clear data
    const clearDataBtn=document.getElementById('clear-data-btn');
    if(clearDataBtn) clearDataBtn.addEventListener('click',()=>{
        if(confirm('Clear all trip history? This cannot be undone.')){
            _saveTrips([]);_renderProfileStats();_renderRecentTrips();
        }
    });
    const clearPrefsBtn=document.getElementById('clear-prefs-btn');
    if(clearPrefsBtn) clearPrefsBtn.addEventListener('click',()=>{
        if(confirm('Reset all settings to defaults?')){
            localStorage.removeItem(PREFS_KEY);
            _applyTheme('dark');
            setTimeout(()=>window.location.reload(),200);
        }
    });

    // Load label values
    const p=_loadPrefs();
    const profNameDisp=document.getElementById('profile-name-display');if(profNameDisp&&p.name)profNameDisp.textContent=p.name;
    const homeDisp=document.getElementById('home-label-sub');if(homeDisp&&p.home)homeDisp.textContent=p.home;
    const workDisp=document.getElementById('work-label-sub');if(workDisp&&p.work)workDisp.textContent=p.work;
}

function _updateGpsDiag(panel){
    if(typeof userLat==='undefined'||typeof _lastFixAccuracy==='undefined'){panel.innerHTML='GPS module not ready.';return;}
    const lines=[
        `Status: <span>${typeof _gpsUsingFallback!=='undefined'&&_gpsUsingFallback?'Fallback':'Live GPS'}</span>`,
        `Lat: <span>${userLat!==null?userLat.toFixed(6):'—'}</span>`,
        `Lon: <span>${userLon!==null?userLon.toFixed(6):'—'}</span>`,
        `Accuracy: <span>${_lastFixAccuracy?Math.round(_lastFixAccuracy)+'m':'—'}</span>`,
        `Speed: <span>${typeof userSpeedKmh!=='undefined'?Math.round(userSpeedKmh)+' km/h':'—'}</span>`,
        `Heading: <span>${typeof userHeading!=='undefined'&&userHeading!==null?Math.round(userHeading)+'°':'—'}</span>`,
        `GPS Watch: <span>${typeof _gpsWatching!=='undefined'&&_gpsWatching?'Active':'Inactive'}</span>`,
    ];
    panel.innerHTML=lines.join('<br>');
    setTimeout(()=>{if(panel.classList.contains('show'))_updateGpsDiag(panel);},1500);
}

function _onPrefChange(key, val){
    if(key==='units') _renderRecentTrips();
    if(key==='mapStyle'){
        const meta=document.getElementById('map-style-meta');
        if(meta) meta.textContent=val.charAt(0).toUpperCase()+val.slice(1)+' style';
        const sub=document.getElementById('map-style-label-sub');
        if(sub) sub.textContent=val.charAt(0).toUpperCase()+val.slice(1);
        // Apply map style change
        document.querySelectorAll('.map-style-chip').forEach(c=>c.classList.toggle('active',c.dataset.styleId===val));
        const btn=document.querySelector(`.map-style-chip[data-style-id="${val}"]`);
        if(btn) btn.click();
    }
    if(key==='gpsMode'){
        const sub=document.getElementById('gps-mode-sub');
        const labels={high:'High accuracy (battery intensive)',balanced:'Balanced mode',low:'Power saver mode'};
        if(sub) sub.textContent=labels[val]||val;
    }
}

/* ── Modal helper ───────────────────────────────────────── */
function _showModal(title, placeholder, onOk, initialValue=''){
    const overlay=document.getElementById('input-modal');
    const titleEl=document.getElementById('modal-title');
    const input=document.getElementById('modal-input');
    const cancelBtn=document.getElementById('modal-cancel');
    const okBtn=document.getElementById('modal-ok');
    if(!overlay||!input)return;
    if(titleEl) titleEl.textContent=title;
    input.placeholder=placeholder;
    input.value=initialValue;
    overlay.classList.remove('hidden');
    requestAnimationFrame(()=>{overlay.classList.add('visible');input.focus();input.select();});
    const close=()=>{overlay.classList.remove('visible');setTimeout(()=>overlay.classList.add('hidden'),250);};
    const ok=()=>{onOk(input.value);close();};
    cancelBtn.onclick=close;
    okBtn.onclick=ok;
    input.onkeydown=e=>{if(e.key==='Enter')ok();if(e.key==='Escape')close();};
    overlay.onclick=e=>{if(e.target===overlay)close();};
}

/* ── Page navigation ────────────────────────────────────── */
let _currentPage=null;

function _openPage(pageId){
    const allPages=['profile','activity','navigate','settings'];
    allPages.forEach(id=>{
        const el=document.getElementById(`page-${id}`);
        if(el){el.classList.remove('visible');el.classList.add('hidden');}
    });
    const qa=document.getElementById('quick-add-sheet');
    if(qa){qa.classList.remove('visible');qa.classList.add('hidden');}
    _currentPage=pageId;
    if(!pageId||pageId==='explore'){_setActiveTab('explore');return;}
    if(pageId==='quick-add'){
        const sheet=document.getElementById('quick-add-sheet');
        if(sheet){sheet.classList.remove('hidden');requestAnimationFrame(()=>sheet.classList.add('visible'));}
        return;
    }
    const panel=document.getElementById(`page-${pageId}`);
    if(!panel)return;
    panel.classList.remove('hidden');
    requestAnimationFrame(()=>panel.classList.add('visible'));
    if(pageId==='profile'||pageId==='activity'){_renderProfileStats();_renderRecentTrips();}
    if(pageId==='navigate'){_renderRecentPlaces();setTimeout(()=>{const inp=document.getElementById('nav-page-dest');if(inp)inp.focus();},350);}
    if(pageId==='settings'){_refreshSettingsUI();}
}

function _refreshSettingsUI(){
    const p=_loadPrefs();
    // Sync checkboxes
    const swMap={'sw-speed-alerts':'speedAlerts','sw-auto-reroute':'autoReroute','sw-wakelock':'wakelock','sw-traffic':'showTraffic','sw-3d-buildings':'show3dBuildings','sw-kalman':'kalmanSmoothing','sw-acc-ring':'showAccRing'};
    Object.entries(swMap).forEach(([id,key])=>{const el=document.getElementById(id);if(el)el.checked=p[key]!==false;});
    // Sync toggle groups
    document.querySelectorAll('[data-pref]').forEach(btn=>{
        const key=btn.dataset.pref,val=btn.dataset.val;
        const active=p[key]?p[key]===val:(btn.classList.contains('active'));
        btn.classList.toggle('active',active);
    });
}

function _setActiveTab(tab){
    document.querySelectorAll('.bnav-item').forEach(btn=>{
        btn.classList.toggle('active',btn.dataset.page===tab);
    });
}

/* ── Bottom nav init ────────────────────────────────────── */
function _initBottomNav(){
    document.querySelectorAll('.bnav-item').forEach(btn=>{
        btn.addEventListener('click',()=>{
            const page=btn.dataset.page;
            _setActiveTab(page==='explore'?'explore':page);
            _openPage(page);
        });
    });

    document.querySelectorAll('[data-page-close]').forEach(btn=>{
        btn.addEventListener('click',()=>{_openPage(null);_setActiveTab('explore');});
    });

    document.getElementById('qa-backdrop')?.addEventListener('click',()=>{_openPage(null);_setActiveTab('explore');});
    document.getElementById('clear-history-btn')?.addEventListener('click',()=>{
        if(confirm('Clear all trip history?')){_saveTrips([]);_renderProfileStats();_renderRecentTrips();}
    });
    document.getElementById('view-all-trips-btn')?.addEventListener('click',()=>{_openPage('activity');_setActiveTab('activity');});

    // Settings access from profile
    document.getElementById('profile-settings-btn')?.addEventListener('click',()=>{_openPage('settings');});
    document.getElementById('open-settings-from-profile')?.addEventListener('click',()=>{_openPage('settings');});

    // Activity filter tabs
    document.querySelectorAll('.act-tab').forEach(tab=>{
        tab.addEventListener('click',()=>{
            document.querySelectorAll('.act-tab').forEach(t=>{t.classList.remove('active');t.setAttribute('aria-selected','false');});
            tab.classList.add('active');tab.setAttribute('aria-selected','true');
            _renderRecentTrips(tab.dataset.filter);
        });
    });

    // Profile vehicle selector
    document.querySelectorAll('.pv-chip').forEach(chip=>{
        chip.addEventListener('click',()=>{
            document.querySelectorAll('.pv-chip').forEach(c=>c.classList.remove('active'));
            chip.classList.add('active');
            const v=chip.dataset.vehicle;
            const p=_loadPrefs();p.vehicle=v;_savePrefs(p);
            document.querySelectorAll('.vehicle-chip').forEach(c=>{c.classList.toggle('active',c.dataset.vehicle===v);c.setAttribute('aria-pressed',String(c.dataset.vehicle===v));});
            if(typeof _3DM!=='undefined') _3DM.vehicle=v;
        });
    });

    // Navigate page
    const navPageDest=document.getElementById('nav-page-dest');
    const navPageGo=document.getElementById('nav-page-go-btn');
    const navPageSugg=document.getElementById('nav-page-suggestions');
    if(navPageDest){
        let _npTimer=null;
        navPageDest.addEventListener('input',()=>{
            const q=navPageDest.value.trim();
            if(!q||q.length<2){if(navPageSugg)navPageSugg.classList.add('hidden');return;}
            clearTimeout(_npTimer);_npTimer=setTimeout(()=>_fetchNavPageSugg(q),280);
        });
        navPageDest.addEventListener('blur',()=>setTimeout(()=>navPageSugg?.classList.add('hidden'),200));
        navPageDest.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();_doNavPageSearch();}});
    }
    navPageGo?.addEventListener('click',_doNavPageSearch);

    // India quick places
    document.querySelectorAll('.india-place-chip').forEach(chip=>{
        chip.addEventListener('click',()=>{
            _openPage(null);_setActiveTab('explore');
            const inp=document.getElementById('dest-input');if(inp)inp.value=chip.dataset.dest||'';
            document.getElementById('search-form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        });
    });

    // Search chips
    document.querySelectorAll('.search-chip').forEach(chip=>{
        chip.addEventListener('click',()=>{
            const inp=document.getElementById('dest-input');if(inp)inp.value=chip.dataset.query||'';
            document.getElementById('search-form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        });
    });

    // Quick actions
    document.querySelectorAll('.qa-btn').forEach(btn=>{
        btn.addEventListener('click',()=>{
            const action=btn.dataset.action;
            _openPage(null);_setActiveTab('explore');
            const p=_loadPrefs();
            const qMap={fuel:'petrol station near me',food:'restaurant near me',atm:'ATM near me',hospital:'hospital near me','navigate-home':p.home||'','navigate-work':p.work||''};
            if(action==='settings'){_openPage('settings');return;}
            if(action==='share'){_shareLocation();return;}
            if(action==='report'){typeof showInfo==='function'&&showInfo('Thank you for your report!',3000);return;}
            const q=qMap[action]||'';
            if(q){const inp=document.getElementById('dest-input');if(inp)inp.value=q;document.getElementById('search-form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
        });
    });

    // Suggestions close on outside click
    document.addEventListener('click',e=>{
        ['suggestions-list','nav-page-suggestions'].forEach(id=>{
            const el=document.getElementById(id);if(!el)return;
            if(!e.target.closest('#search-form')&&!e.target.closest('#page-navigate')) el.classList.add('hidden');
        });
    },{passive:true});
}

/* ── Nav page autocomplete ──────────────────────────────── */
async function _fetchNavPageSugg(q){
    const navPageSugg=document.getElementById('nav-page-suggestions');
    if(!navPageSugg)return;
    try{
        const params=new URLSearchParams({q});
        if(typeof userLat!=='undefined'&&userLat){params.set('lat',userLat);params.set('lon',userLon);}
        const res=await fetch(`/suggestions?${params}`);const data=await res.json();
        if(!data?.length){navPageSugg.classList.add('hidden');return;}
        navPageSugg.innerHTML=data.slice(0,6).map((item,i)=>`<li class="suggest-item" role="option" id="nps-${i}"><span class="sug-icon">📍</span><div class="sug-text"><span class="sug-main">${_esc(item.label)}</span>${item.sublabel?`<span class="sug-sub">${_esc(item.sublabel)}</span>`:''}</div></li>`).join('');
        navPageSugg.classList.remove('hidden');
        navPageSugg.querySelectorAll('.suggest-item').forEach((li,i)=>{
            li.addEventListener('click',()=>{
                const inp=document.getElementById('nav-page-dest');if(inp)inp.value=data[i].label||'';
                navPageSugg.classList.add('hidden');_doNavPageSearch();
            });
        });
    }catch(_){navPageSugg?.classList.add('hidden');}
}

function _doNavPageSearch(){
    const inp=document.getElementById('nav-page-dest');if(!inp?.value?.trim())return;
    const val=inp.value.trim();
    _openPage(null);_setActiveTab('explore');
    const d=document.getElementById('dest-input');if(d)d.value=val;
    document.getElementById('search-form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
}

function _shareLocation(){
    if(typeof userLat==='undefined'||!userLat){typeof showError==='function'&&showError('GPS not available yet.',3000);return;}
    const url=`https://maps.google.com/maps?q=${userLat},${userLon}`;
    if(navigator.share){navigator.share({title:'My Location',url}).catch(()=>{});}
    else{navigator.clipboard?.writeText(url);typeof showInfo==='function'&&showInfo('Location link copied!',2500);}
}

/* ── Trip recording hooks ───────────────────────────────── */
function _hookTripRecording(){
    document.addEventListener('click',e=>{
        const btn=e.target.closest('.card-nav-btn,#start-nav-cta-btn');
        if(!btn)return;
        setTimeout(()=>{
            const destText=document.getElementById('dest-input')?.value?.trim()||'Destination';
            const nhDist=document.getElementById('nav-hud-dist');
            const nhTime=document.getElementById('nav-hud-time');
            let distKm=0,durMin=0;
            if(nhDist){const m=nhDist.textContent.match(/([\d.]+)/);if(m){distKm=parseFloat(m[1]);if(nhDist.textContent.includes('m')&&!nhDist.textContent.includes('km'))distKm/=1000;}}
            if(nhTime){const m=nhTime.textContent.match(/([\d]+)/);if(m)durMin=parseInt(m[1]);}
            _recordTrip(destText,distKm,durMin,'');
        },1200);
    },{passive:true});
}

/* ── Route panel upgrades ───────────────────────────────── */
function _upgradeRoutePanelUI(){
    const _cw=document.getElementById('cards-wrap');
    if(!_cw)return;
    new MutationObserver(()=>{
        _enhanceRouteCards();
        const banner=document.getElementById('route-dest-banner');
        const destText=document.getElementById('route-dest-text');
        const input=document.getElementById('dest-input');
        const cta=document.getElementById('route-start-cta');
        if(banner&&destText&&input?.value){destText.textContent=input.value;banner.classList.add('show');}
        if(cta)cta.classList.add('show');
    }).observe(_cw,{childList:true});
}

function _enhanceRouteCards(){
    document.querySelectorAll('.route-card').forEach((card,idx)=>{
        if(card.dataset.enhanced)return;
        card.dataset.enhanced='1';
        if(idx===0)card.classList.add('is-best');
        // AI badge
        if(idx===0&&!card.querySelector('.ai-badge')){
            const b=document.createElement('div');
            b.className='ai-badge';b.textContent='AI RECOMMENDED';
            card.insertBefore(b,card.firstChild);
        }
        // Big time + meta
        const allStats=card.querySelectorAll('.stat-val');
        let distKm=0,durMin=0;
        allStats.forEach(el=>{
            const t=el.textContent.trim(),u=el.querySelector('.stat-unit')?.textContent?.trim(),n=parseFloat(t);
            if(!isNaN(n)){if(u==='km'||u===' km')distKm=n;if(u==='min'||u===' min')durMin=n;}
        });
        if(!card.querySelector('.card-big-time')&&durMin>0){
            const bt=document.createElement('div');bt.className='card-big-time';
            const h=Math.floor(durMin/60),m=Math.round(durMin%60);
            bt.innerHTML=`<span class="card-big-time-val">${h>0?h+'h ':''} ${m}</span><span class="card-big-time-unit">min</span>`;
            const badge=card.querySelector('.ai-badge')||card.querySelector('.card-top');
            if(badge)card.insertBefore(bt,badge.nextSibling);else card.prepend(bt);
        }
        if(!card.querySelector('.card-route-meta')&&distKm>0){
            const meta=document.createElement('div');meta.className='card-route-meta';
            const eta=new Date(Date.now()+durMin*60000);
            const prefs=_loadPrefs();
            const dist=prefs.units==='mi'?`${(distKm*0.621371).toFixed(1)} mi`:`${distKm} km`;
            meta.textContent=`${dist} • ${eta.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})} arrival`;
            const bt=card.querySelector('.card-big-time');
            if(bt)bt.insertAdjacentElement('afterend',meta);
        }
        if(idx===0&&!card.querySelector('.ai-insight-box')){
            const ins=document.createElement('div');ins.className='ai-insight-box';
            const msgs=['Optimised for fuel efficiency and fewer traffic signals.','Avoids known congestion zones in your city.','Fastest path via major roads with low signal density.','AI: balanced speed, distance, and road quality.','Less traffic detected on this route right now.'];
            ins.innerHTML=`<span class="ai-insight-icon">🔄</span><div class="ai-insight-text"><span class="ai-insight-label">Why this route?</span>${msgs[Math.floor(Math.random()*msgs.length)]}</div>`;
            const meta=card.querySelector('.card-route-meta');
            if(meta)meta.insertAdjacentElement('afterend',ins);else card.appendChild(ins);
        }
        if(idx>0&&!card.querySelector('.card-alt-row')){
            const ar=document.createElement('div');ar.className='card-alt-row';
            const bads=[{cls:'badge-traffic',text:'+Traffic delay'},{cls:'badge-shortest',text:'Shortest distance'},{cls:'badge-eco',text:'Eco friendly'}];
            const b=bads[Math.min(idx-1,bads.length-1)];
            ar.innerHTML=`<span></span><span class="card-alt-badge ${b.cls}">${b.text}</span>`;
            card.appendChild(ar);
        }
    });
}

/* ── Start nav CTA ──────────────────────────────────────── */
function _initStartNavCTA(){
    document.getElementById('start-nav-cta-btn')?.addEventListener('click',()=>{
        document.querySelector('.card-nav-btn')?.click();
    });
}

/* ── Profile init ───────────────────────────────────────── */
function _initProfile(){
    const p=_loadPrefs();
    if(p.name){const el=document.getElementById('profile-name');if(el)el.textContent=p.name;}
    const sub=document.getElementById('profile-sub');
    if(sub)sub.textContent=`Premium Member · ${p.city||'India'}`;
    if(p.vehicle){
        document.querySelectorAll('.pv-chip').forEach(c=>c.classList.toggle('active',c.dataset.vehicle===p.vehicle));
        document.querySelectorAll('.vehicle-chip').forEach(c=>{c.classList.toggle('active',c.dataset.vehicle===p.vehicle);c.setAttribute('aria-pressed',String(c.dataset.vehicle===p.vehicle));});
        if(typeof _3DM!=='undefined') _3DM.vehicle=p.vehicle;
    }
    // Profile open → animate stats
    const profilePage=document.getElementById('page-profile');
    if(profilePage){
        new MutationObserver(muts=>{
            muts.forEach(m=>{
                if(m.type==='attributes'&&m.attributeName==='class'&&profilePage.classList.contains('visible')){
                    setTimeout(()=>{
                        const s=_calcStats(_loadTrips());
                        _animNum(document.getElementById('stat-trips'),s.trips);
                        _animNum(document.getElementById('stat-hours'),s.totalHrs);
                        _animNum(document.getElementById('stat-ai'),s.ai,700);
                    },120);
                }
            });
        }).observe(profilePage,{attributes:true});
    }
}

/* ── Kalman filter is pre-tuned at construction, no runtime upgrade needed ── */
function _upgradeKalmanFilter(){ /* no-op — tuned at init */ }

/* ── Main init ──────────────────────────────────────────── */
function _init(){
    // Restore theme immediately
    const p=_loadPrefs();
    _applyTheme(p.theme||'dark');

    _initThemePicker();
    _initBottomNav();
    _initProfile();
    _initSettings();
    _renderProfileStats();
    _renderRecentTrips();
    _upgradeRoutePanelUI();
    _hookTripRecording();
    _initStartNavCTA();
    _upgradeKalmanFilter();

    // GPS accuracy ring toggle
    const swAccRing=document.getElementById('sw-acc-ring');
    if(swAccRing){
        swAccRing.addEventListener('change',()=>{
            if(typeof userAccuracyRing!=='undefined'&&userAccuracyRing){
                if(swAccRing.checked)userAccuracyRing.addTo(typeof map!=='undefined'?map:{});
                else userAccuracyRing.remove();
            }
        });
    }

    // ── Speed colour on main nav HUD (poll every 400ms) ──────
    const _spEl=document.getElementById('nav-speed-val');
    window._smartnavPollId=null; // module-level so close3DView can clear it
    function _pollGPS(){
        // Speed colour
        if(_spEl){
            const spd=typeof userSpeedKmh!=='undefined'?userSpeedKmh:0;
            _spEl.classList.remove('nav-speed-val-green','nav-speed-val-blue','nav-speed-val-yellow','nav-speed-val-red');
            if(spd>80)      _spEl.classList.add('nav-speed-val-red');
            else if(spd>50) _spEl.classList.add('nav-speed-val-yellow');
            else if(spd>10) _spEl.classList.add('nav-speed-val-blue');
            else if(spd>1)  _spEl.classList.add('nav-speed-val-green');
        }
        // GPS pill quality
        const pill=document.getElementById('gps-pill');
        if(pill){
            const acc=typeof _lastFixAccuracy!=='undefined'?_lastFixAccuracy:null;
            pill.classList.remove('good','warn','error');
            if(!acc||acc>9000)pill.classList.add('warn');
            else if(acc<15)pill.classList.add('good');
            else if(acc>50)pill.classList.add('error');
            else pill.classList.add('warn');
        }
        // 3D GPS status - _3dmHUD is called by the 3D RAF loop, no need to call here
        // Just ensure 3D badge reflects GPS state when active
        if(typeof _3DM!=='undefined'&&_3DM.active&&_3DM.styleReady){
            const gpsStat=document.getElementById('nav3d-gps-status');
            if(gpsStat){
                const acc=typeof _lastFixAccuracy!=='undefined'?_lastFixAccuracy:null;
                if(typeof _gpsUsingFallback!=='undefined'&&_gpsUsingFallback){gpsStat.textContent='📡 Acquiring GPS…';gpsStat.style.color='rgba(255,173,0,.75)';}
                else if(acc&&acc<9999){const aStr=`±${Math.round(acc)}m`;gpsStat.textContent=`📍 GPS ${aStr}`;gpsStat.style.color=acc<15?'rgba(0,230,118,.85)':acc<50?'rgba(255,215,0,.8)':'rgba(255,120,0,.8)';}
            }
        }
    }
    window._smartnavPollId=setInterval(_pollGPS,400);

    // ── Back button closes open pages ────────────────────────
    window.addEventListener('popstate',()=>{
        ['profile','activity','navigate','settings'].forEach(id=>{
            const el=document.getElementById(`page-${id}`);
            if(el?.classList.contains('visible')){el.classList.remove('visible');el.classList.add('hidden');}
        });
        const qa=document.getElementById('quick-add-sheet');
        if(qa?.classList.contains('visible')){qa.classList.remove('visible');qa.classList.add('hidden');}
    });

    // ── Direction arrow bounce on change ────────────────────
    let _lastArrow='';
    setInterval(()=>{
        const arr=document.getElementById('nav-direction-arrow');
        if(arr&&arr.textContent!==_lastArrow){
            const prev=arr.style.transform||'';
            const rot=prev.match(/rotate\([^)]+\)/)?.[0]||'';
            arr.style.transform=rot?`${rot} scale(1.28)`:'scale(1.28)';
            setTimeout(()=>{arr.style.transform=rot;},180);
            _lastArrow=arr.textContent;
        }
    },300);

    // Demo trips
    if(_loadTrips().length===0){
        _recordTrip('Connaught Place, New Delhi',8.2,24,'Best Route');
        _recordTrip('Cyber City, Gurugram',15.4,38,'Fastest');
        _recordTrip('Indira Gandhi International Airport',22.1,52,'Best Route');
    }
}

if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',_init);}
else{setTimeout(_init,100);}

})(); // end SmartNavUI IIFE


/* ================================================================
   UX POLISH v4 — Speed colours, transitions, search fixes
================================================================ */

/* ================================================================
   ADMIN PANEL v1.0 — Login, Dashboard, Live Map, Beacon Sender
================================================================ */
(function SmartNavAdmin() {
'use strict';

/* ── Beacon sender ──────────────────────────────────────────── */
// Sends the user's GPS position to /api/beacon after they grant permission.
// Fires every 30 s while the page is visible. All data is anonymous and
// tied only to the server-assigned session cookie — no user identity.
let _beaconTimer = null;
let _beaconActive = false;

async function _sendBeacon() {
    if (typeof userLat === 'undefined' || userLat === null) return;
    if (typeof _gpsUsingFallback !== 'undefined' && _gpsUsingFallback) return;
    try {
        await fetch('/api/beacon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lat: userLat,
                lon: userLon,
                acc: typeof _lastFixAccuracy !== 'undefined' ? (_lastFixAccuracy || 0) : 0,
                spd: typeof userSpeedKmh !== 'undefined' ? Math.round(userSpeedKmh || 0) : 0,
                city: '', address: '',
            }),
            keepalive: true,
        });
    } catch (_) {}
}

function _startBeacon() {
    if (_beaconActive) return;
    _beaconActive = true;
    _sendBeacon(); // immediate first ping
    _beaconTimer = setInterval(_sendBeacon, 30_000);
}

// Start beaconing once GPS is live (detect via polling)
let _beaconCheckTimer = setInterval(() => {
    if (typeof userLat !== 'undefined' && userLat !== null &&
        typeof _gpsUsingFallback !== 'undefined' && !_gpsUsingFallback) {
        clearInterval(_beaconCheckTimer);
        _startBeacon();
    }
}, 5_000);

// Stop on page hide, restart on page show
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        if (_beaconTimer) { clearInterval(_beaconTimer); _beaconTimer = null; _beaconActive = false; }
    } else {
        if (typeof userLat !== 'undefined' && userLat !== null) _startBeacon();
    }
});

/* ── Admin state ────────────────────────────────────────────── */
let _adminLoggedIn = false;
let _adminPollTimer = null;
let _adminLiveMap = null;
let _adminLiveMarkers = {};
let _adminData = null;
let _adminCurrentUser = null;
let _adminDrawerMap = null;

/* ── DOM refs ───────────────────────────────────────────────── */
const _adminLoginOverlay = document.getElementById('admin-login-overlay');
const _adminPanel        = document.getElementById('admin-panel');
const _adminEmailInp     = document.getElementById('admin-email-inp');
const _adminPassInp      = document.getElementById('admin-pass-inp');
const _adminLoginBtn     = document.getElementById('admin-login-btn');
const _adminLoginCancel  = document.getElementById('admin-login-cancel');
const _adminLoginErr     = document.getElementById('admin-login-err');
const _adminLogoutBtn    = document.getElementById('admin-logout-btn');
const _adminRefreshBtn   = document.getElementById('admin-refresh-btn');
const _adminDrawer       = document.getElementById('admin-user-drawer');
const _adminDrawerBody   = document.getElementById('admin-drawer-body');
const _adminDrawerClose  = document.getElementById('admin-drawer-close');
const _adminLastRefresh  = document.getElementById('admin-last-refresh');
const _adminLiveCount    = document.getElementById('admin-live-count');

/* ── Utilities ──────────────────────────────────────────────── */
function _adminEsc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmtTs(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000), now = Date.now();
    const diff = Math.floor((now - ts * 1000) / 1000);
    if (diff < 60)  return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return d.toLocaleDateString('en-IN', { month:'short', day:'numeric' });
}

function _fmtCoord(v) {
    return v != null ? Number(v).toFixed(5) : '—';
}

function _showAdminOverlay(el) {
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('visible'));
}

function _hideAdminOverlay(el) {
    el.classList.remove('visible');
    setTimeout(() => el.classList.add('hidden'), 300);
}

/* ── Open admin (from settings) ─────────────────────────────── */
document.getElementById('open-admin-btn')?.addEventListener('click', () => {
    // Close settings panel first
    const settingsPanel = document.getElementById('page-settings');
    if (settingsPanel) { settingsPanel.classList.remove('visible'); setTimeout(() => settingsPanel.classList.add('hidden'), 320); }
    setTimeout(() => {
        if (_adminLoggedIn) {
            _openDashboard();
        } else {
            _showAdminOverlay(_adminLoginOverlay);
            _adminEmailInp?.focus();
        }
    }, 160);
});

/* ── Login ──────────────────────────────────────────────────── */
async function _doLogin() {
    const email = _adminEmailInp?.value.trim() || '';
    const pass  = _adminPassInp?.value || '';
    if (!email || !pass) { _showLoginErr('Enter email and password'); return; }

    _adminLoginBtn.textContent = 'Signing in…';
    _adminLoginBtn.classList.add('loading');
    _hideLoginErr();

    try {
        const res = await fetch('/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: pass }),
        });
        const data = await res.json();
        if (data.ok) {
            _adminLoggedIn = true;
            _hideAdminOverlay(_adminLoginOverlay);
            setTimeout(_openDashboard, 350);
        } else {
            _showLoginErr(data.error || 'Invalid credentials');
        }
    } catch (_) {
        _showLoginErr('Connection error — is the server running?');
    } finally {
        _adminLoginBtn.textContent = 'Sign In';
        _adminLoginBtn.classList.remove('loading');
    }
}

function _showLoginErr(msg) {
    if (_adminLoginErr) { _adminLoginErr.textContent = msg; _adminLoginErr.classList.remove('hidden'); }
}
function _hideLoginErr() { _adminLoginErr?.classList.add('hidden'); }

_adminLoginBtn?.addEventListener('click', _doLogin);
_adminLoginCancel?.addEventListener('click', () => _hideAdminOverlay(_adminLoginOverlay));
_adminEmailInp?.addEventListener('keydown', e => { if (e.key === 'Enter') _adminPassInp?.focus(); });
_adminPassInp?.addEventListener('keydown', e => { if (e.key === 'Enter') _doLogin(); });

/* ── Dashboard open ─────────────────────────────────────────── */
function _openDashboard() {
    _showAdminOverlay(_adminPanel);
    _loadAdminData();
    _startAdminPoll();
}

async function _logout() {
    await fetch('/admin/logout', { method: 'POST' }).catch(() => {});
    _adminLoggedIn = false;
    _stopAdminPoll();
    _closeDrawer();
    if (_adminLiveMap) { try { _adminLiveMap.remove(); } catch(_){} _adminLiveMap = null; _adminLiveMarkers = {}; }
    if (_adminDrawerMap) { try { _adminDrawerMap.remove(); } catch(_){} _adminDrawerMap = null; }
    _hideAdminOverlay(_adminPanel);
}

_adminLogoutBtn?.addEventListener('click', _logout);

/* ── Tabs ────────────────────────────────────────────────────── */
document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabId = tab.dataset.tab;
        document.querySelectorAll('.admin-content').forEach(c => c.classList.add('hidden'));
        const target = document.getElementById(`admin-tab-${tabId}`);
        if (target) target.classList.remove('hidden');
        if (tabId === 'live') _renderLiveMap();
    });
});

/* ── Refresh ─────────────────────────────────────────────────── */
_adminRefreshBtn?.addEventListener('click', () => {
    _adminRefreshBtn.classList.add('spinning');
    _loadAdminData().finally(() => {
        setTimeout(() => _adminRefreshBtn.classList.remove('spinning'), 500);
    });
});

function _startAdminPoll() {
    if (_adminPollTimer) return;
    _adminPollTimer = setInterval(_loadAdminData, 15_000);
}
function _stopAdminPoll() {
    if (_adminPollTimer) { clearInterval(_adminPollTimer); _adminPollTimer = null; }
}

/* ── Load admin data ──────────────────────────────────────────── */
let _adminUserSearchBound = false;   // guard: only bind search input once

async function _loadAdminData() {
    try {
        const res = await fetch('/admin/data');
        if (res.status === 401) { _adminLoggedIn = false; _stopAdminPoll(); _logout(); return; }
        const data = await res.json();
        _adminData = data;
        _renderStats(data.stats);
        _renderOverviewTable(data.sessions);
        _renderUsersTable(data.sessions);
        _updateLiveMarkers(data.live || []);
        if (_adminLastRefresh) {
            _adminLastRefresh.textContent = new Date().toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        }
    } catch (_) { /* network hiccup — retry on next poll */ }
}

/* ── Stats ─────────────────────────────────────────────────────── */
function _renderStats(s) {
    if (!s) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '—'; };
    set('asc-total',   s.total_sessions);
    set('asc-live',    s.live_now);
    set('asc-loc',     s.location_granted);
    set('asc-today',   s.today);
    set('asc-mobile',  s.mobile);
    set('asc-beacons', s.total_beacons);
}

/* ── Overview table ─────────────────────────────────────────────── */
function _renderOverviewTable(sessions) {
    const el = document.getElementById('admin-overview-table');
    const countEl = document.getElementById('admin-overview-count');
    if (!el) return;

    if (!sessions?.length) {
        el.innerHTML = '<div class="admin-empty"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(79,158,255,.25)" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg><span>No sessions yet</span></div>';
        if (countEl) countEl.textContent = '';
        return;
    }

    const top20 = sessions.slice(0, 20);
    if (countEl) countEl.textContent = `Showing ${top20.length} of ${sessions.length}`;

    const rows = top20.map(s => `
        <tr data-sid="${_adminEsc(s.session_id)}" style="cursor:pointer">
            <td>${s.is_live
                ? '<span class="admin-live-badge">&#9679;&nbsp;Live</span>'
                : '<span class="admin-offline-badge">Offline</span>'}</td>
            <td title="${_adminEsc(s.ip)}" style="font-family:monospace;font-size:.72rem">${_adminEsc(s.ip || '—')}</td>
            <td>
                <div style="font-weight:500">${_adminEsc(s.browser || '—')}</div>
                <div style="font-size:.62rem;color:#3a5a7a;margin-top:2px">${_adminEsc(s.os_name || '')}${s.device_type ? ' · ' + _adminEsc(s.device_type) : ''}</div>
            </td>
            <td>${s.lat != null
                ? `<span style="color:#4f9eff;font-family:monospace;font-size:.72rem">${Number(s.lat).toFixed(4)},&thinsp;${Number(s.lon).toFixed(4)}</span>`
                : '<span style="color:#2a4060;font-size:.70rem">No GPS</span>'}</td>
            <td>${_adminEsc(s.city || '—')}</td>
            <td style="font-size:.72rem;color:#8ab0d0">${_fmtTs(s.last_seen)}</td>
            <td style="text-align:center;color:#6090b0">${s.page_views || 1}</td>
        </tr>`).join('');

    el.innerHTML = `<table class="admin-table">
        <thead><tr>
            <th>Status</th><th>IP Address</th><th>Browser / OS</th>
            <th>Last Location</th><th>City</th><th>Last Seen</th><th>Views</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
    el.querySelectorAll('tr[data-sid]').forEach(row =>
        row.addEventListener('click', () => _openDrawer(row.dataset.sid)));
}

/* ── Users table ────────────────────────────────────────────────── */
function _renderUsersTable(sessions) {
    // Bind search box only once (not on every data refresh)
    if (!_adminUserSearchBound) {
        const searchEl = document.getElementById('admin-user-search');
        if (searchEl) {
            searchEl.addEventListener('input', function () {
                _renderFilteredUsers(_adminData?.sessions || [], this.value.toLowerCase().trim());
            });
            _adminUserSearchBound = true;
        }
    }
    const q = document.getElementById('admin-user-search')?.value?.toLowerCase().trim() || '';
    _renderFilteredUsers(sessions, q);
}

function _renderFilteredUsers(sessions, filter) {
    const el = document.getElementById('admin-users-table');
    if (!el) return;
    const filtered = filter
        ? sessions.filter(s =>
            (s.ip || '').includes(filter) ||
            (s.browser || '').toLowerCase().includes(filter) ||
            (s.city || '').toLowerCase().includes(filter) ||
            (s.os_name || '').toLowerCase().includes(filter) ||
            (s.device_type || '').toLowerCase().includes(filter))
        : sessions;

    if (!filtered.length) {
        el.innerHTML = '<div class="admin-empty"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(79,158,255,.25)" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg><span>No matching sessions</span></div>';
        return;
    }

    const rows = filtered.map(s => `
        <tr data-sid="${_adminEsc(s.session_id)}" style="cursor:pointer">
            <td>${s.is_live
                ? '<span class="admin-live-badge">&#9679;&nbsp;Live</span>'
                : '<span class="admin-offline-badge">Offline</span>'}</td>
            <td style="font-family:monospace;font-size:.70rem">${_adminEsc(s.ip || '—')}</td>
            <td style="font-weight:500">${_adminEsc(s.browser || '—')}</td>
            <td>${_adminEsc(s.os_name || '—')}</td>
            <td>${_adminEsc(s.device_type || '—')}</td>
            <td style="font-family:monospace;font-size:.70rem;color:#4f9eff">${
                s.lat != null ? `${Number(s.lat).toFixed(4)},&thinsp;${Number(s.lon).toFixed(4)}` : '<span style="color:#2a4060">—</span>'}</td>
            <td>${_adminEsc(s.city || '—')}</td>
            <td title="${_adminEsc(s.user_agent || '')}"
                style="max-width:130px;overflow:hidden;text-overflow:ellipsis;font-size:.66rem;color:#5a8aaa">
                ${_adminEsc((s.user_agent || '').substring(0, 55))}${(s.user_agent||'').length > 55 ? '…' : ''}</td>
            <td style="font-size:.70rem;color:#8ab0d0">${_fmtTs(s.first_seen)}</td>
            <td style="font-size:.70rem;color:#8ab0d0">${_fmtTs(s.last_seen)}</td>
            <td style="text-align:center;color:#6090b0">${s.page_views || 1}</td>
        </tr>`).join('');

    el.innerHTML = `<table class="admin-table">
        <thead><tr>
            <th>Status</th><th>IP</th><th>Browser</th><th>OS</th><th>Device</th>
            <th>Coordinates</th><th>City</th><th>User Agent</th>
            <th>First Seen</th><th>Last Seen</th><th>Views</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
    el.querySelectorAll('tr[data-sid]').forEach(row =>
        row.addEventListener('click', () => _openDrawer(row.dataset.sid)));
}

/* ── Live Map ──────────────────────────────────────────────────── */
function _renderLiveMap() {
    const container = document.getElementById('admin-live-map');
    if (!container) return;
    if (!_adminLiveMap) {
        _adminLiveMap = L.map('admin-live-map', {
            center: [20.5937, 78.9629], zoom: 5,
            zoomControl: true, attributionControl: false,
        });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19,
        }).addTo(_adminLiveMap);
        // Invalidate after brief delay so the container has final dimensions
        setTimeout(() => { try { _adminLiveMap.invalidateSize(); } catch(_){} }, 120);
    }
    _updateLiveMarkers(_adminData?.live || []);
}

function _updateLiveMarkers(liveUsers) {
    if (!_adminLiveMap) return;
    if (_adminLiveCount) {
        const n = liveUsers.length;
        _adminLiveCount.textContent = `${n} user${n !== 1 ? 's' : ''} live`;
    }
    const seenIds = new Set();
    liveUsers.forEach(u => {
        if (u.lat == null || u.lon == null) return;
        seenIds.add(u.session_id);
        const lat = Number(u.lat), lon = Number(u.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;

        const popContent = `<div style="font-size:.74rem;line-height:1.7;color:#c0d0e8">
            <b style="color:#00e676">&#9679; Live</b><br>
            <b>IP:</b> ${_adminEsc(u.ip)}<br>
            <b>Browser:</b> ${_adminEsc(u.browser || '—')}<br>
            <b>OS:</b> ${_adminEsc(u.os_name || '—')}<br>
            <b>Device:</b> ${_adminEsc(u.device_type || '—')}<br>
            <b>Speed:</b> ${u.speed_kmh != null ? Math.round(u.speed_kmh) + ' km/h' : '—'}<br>
            <b>Accuracy:</b> ${u.accuracy_m != null ? Math.round(u.accuracy_m) + ' m' : '—'}<br>
            <b>City:</b> ${_adminEsc(u.city || '—')}<br>
            <b>Updated:</b> ${_fmtTs(u.last_beacon_ts)}
        </div>`;

        if (_adminLiveMarkers[u.session_id]) {
            _adminLiveMarkers[u.session_id].setLatLng([lat, lon]);
            _adminLiveMarkers[u.session_id].getPopup()?.setContent(popContent);
        } else {
            const icon = L.divIcon({
                className: '',
                html: `<div style="width:14px;height:14px;border-radius:50%;background:#00e676;border:2px solid rgba(255,255,255,.85);box-shadow:0 0 12px rgba(0,230,118,.75),0 0 0 4px rgba(0,230,118,.18)"></div>`,
                iconSize: [14, 14], iconAnchor: [7, 7],
            });
            const marker = L.marker([lat, lon], { icon })
                .addTo(_adminLiveMap)
                .bindPopup(popContent, { className: 'admin-map-popup', maxWidth: 230 });
            marker.on('click', () => _openDrawer(u.session_id));
            _adminLiveMarkers[u.session_id] = marker;
        }
    });
    // Remove stale markers
    Object.keys(_adminLiveMarkers).forEach(sid => {
        if (!seenIds.has(sid)) {
            try { _adminLiveMap.removeLayer(_adminLiveMarkers[sid]); } catch(_) {}
            delete _adminLiveMarkers[sid];
        }
    });
}

/* ── User detail drawer ─────────────────────────────────────────── */
async function _openDrawer(sessionId) {
    if (!_adminData) return;
    _adminCurrentUser = (_adminData.sessions || []).find(s => s.session_id === sessionId);
    if (!_adminCurrentUser) return;
    const u = _adminCurrentUser;

    // Show drawer immediately with skeleton while beacons load
    const title = document.getElementById('adr-title');
    if (title) title.textContent = u.ip || 'User Detail';
    _adminDrawerBody.innerHTML = '<div class="admin-loading">Loading location data\u2026</div>';
    _adminDrawer.classList.remove('hidden');
    requestAnimationFrame(() => _adminDrawer.classList.add('visible'));

    // Fetch beacon history
    let beacons = [];
    try {
        const res = await fetch(`/admin/session/${encodeURIComponent(sessionId)}`);
        if (res.ok) {
            const data = await res.json();
            beacons = data.beacons || [];
        }
    } catch (_) {}

    const locSection = beacons.length ? `
        <div>
            <div class="adr-section">Last Known Location</div>
            <div id="adr-mini-map" class="adr-map"></div>
            <div class="adr-row" style="margin-top:8px">
                <span class="adr-key">Coordinates</span>
                <span class="adr-val">${_fmtCoord(beacons[0]?.lat)},&thinsp;${_fmtCoord(beacons[0]?.lon)}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">Accuracy</span>
                <span class="adr-val">${beacons[0]?.accuracy_m != null ? Math.round(beacons[0].accuracy_m) + ' m' : '—'}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">Speed</span>
                <span class="adr-val">${beacons[0]?.speed_kmh != null ? Math.round(beacons[0].speed_kmh) + ' km/h' : '—'}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">City</span>
                <span class="adr-val">${_adminEsc(beacons[0]?.city || '—')}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">When</span>
                <span class="adr-val">${_fmtTs(beacons[0]?.ts)}</span>
            </div>
        </div>
        <div>
            <div class="adr-section">Location History (${beacons.length} ping${beacons.length !== 1 ? 's' : ''})</div>
            ${beacons.map((b, i) => `
            <div class="adr-beacon-row">
                <div class="adr-beacon-dot${i === 0 ? ' latest' : ''}"></div>
                <div class="adr-beacon-info">
                    <div class="adr-beacon-coord">${_fmtCoord(b.lat)},&thinsp;${_fmtCoord(b.lon)}</div>
                    <div class="adr-beacon-meta">${_fmtTs(b.ts)}&ensp;&middot;&ensp;&plusmn;${
                        b.accuracy_m != null ? Math.round(b.accuracy_m) : '?'}m&ensp;&middot;&ensp;${
                        b.speed_kmh != null ? Math.round(b.speed_kmh) : 0} km/h${
                        b.city ? '&ensp;&middot;&ensp;' + _adminEsc(b.city) : ''}</div>
                </div>
            </div>`).join('')}
        </div>` : `
        <div class="admin-empty" style="padding:24px 12px">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(79,158,255,.25)" stroke-width="1.5">
                <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
            </svg>
            <span>No location data<br><small style="color:#2a4060">User has not granted GPS</small></span>
        </div>`;

    _adminDrawerBody.innerHTML = `
        <div>
            <div class="adr-section">Identity</div>
            <div class="adr-row">
                <span class="adr-key">Session ID</span>
                <span class="adr-val" style="font-size:.58rem">${_adminEsc(sessionId.substring(0, 16))}&hellip;</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">IP Address</span>
                <span class="adr-val">${_adminEsc(u.ip || '—')}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">Status</span>
                <span class="adr-val">${u.is_live
                    ? '<span style="color:#00e676;font-weight:600">&#9679;&nbsp;Live</span>'
                    : '<span style="color:#3a5a7a">Offline</span>'}</span>
            </div>
        </div>
        <div>
            <div class="adr-section">Device</div>
            <div class="adr-row">
                <span class="adr-key">Browser</span>
                <span class="adr-val">${_adminEsc(u.browser || '—')}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">OS</span>
                <span class="adr-val">${_adminEsc(u.os_name || '—')}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">Device Type</span>
                <span class="adr-val">${_adminEsc(u.device_type || '—')}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">User Agent</span>
                <span class="adr-val" style="font-size:.58rem;word-break:break-all;white-space:normal">
                    ${_adminEsc((u.user_agent || '').substring(0, 130))}${(u.user_agent||'').length > 130 ? '…' : ''}</span>
            </div>
        </div>
        <div>
            <div class="adr-section">Activity</div>
            <div class="adr-row">
                <span class="adr-key">First Seen</span>
                <span class="adr-val">${_fmtTs(u.first_seen)}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">Last Seen</span>
                <span class="adr-val">${_fmtTs(u.last_seen)}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">Page Views</span>
                <span class="adr-val">${u.page_views || 1}</span>
            </div>
            <div class="adr-row">
                <span class="adr-key">GPS Granted</span>
                <span class="adr-val">${u.loc_granted
                    ? '<span style="color:#00e676">Yes</span>'
                    : '<span style="color:#3a5a7a">No</span>'}</span>
            </div>
        </div>
        ${locSection}
    `;

    // Render mini-map if we have beacon coordinates
    if (beacons.length && beacons[0]?.lat != null) {
        setTimeout(() => {
            const mapEl = document.getElementById('adr-mini-map');
            if (!mapEl) return;
            if (_adminDrawerMap) {
                try { _adminDrawerMap.remove(); } catch(_) {}
                _adminDrawerMap = null;
            }
            _adminDrawerMap = L.map('adr-mini-map', {
                center: [Number(beacons[0].lat), Number(beacons[0].lon)],
                zoom: 14, zoomControl: false, attributionControl: false,
            });
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd', maxZoom: 19,
            }).addTo(_adminDrawerMap);
            beacons.forEach((b, i) => {
                if (b.lat == null || b.lon == null) return;
                const sz = i === 0 ? 13 : 7;
                const col = i === 0 ? '#00e676' : '#4f9eff';
                const icon = L.divIcon({
                    className: '',
                    html: `<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${col};opacity:${i===0?1:0.55};${i===0?'border:2px solid rgba(255,255,255,.85);box-shadow:0 0 8px rgba(0,230,118,.7)':''}"></div>`,
                    iconSize: [sz, sz], iconAnchor: [sz/2, sz/2],
                });
                L.marker([Number(b.lat), Number(b.lon)], { icon }).addTo(_adminDrawerMap);
            });
            setTimeout(() => { try { _adminDrawerMap.invalidateSize(); } catch(_){} }, 80);
        }, 60);
    }
}

function _closeDrawer() {
    _adminDrawer.classList.remove('visible');
    setTimeout(() => _adminDrawer.classList.add('hidden'), 300);
    if (_adminDrawerMap) {
        try { _adminDrawerMap.remove(); } catch(_) {}
        _adminDrawerMap = null;
    }
}

_adminDrawerClose?.addEventListener('click', _closeDrawer);

// Close drawer on Escape key
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _adminPanel && !_adminPanel.classList.contains('hidden')) {
        if (_adminDrawer && !_adminDrawer.classList.contains('hidden')) {
            _closeDrawer();
        }
    }
});

})(); // end SmartNavAdmin
