/* ================================================================
   SmartNav AI — script.js  v8.0
   - Kalman-filtered GPS positions (latitude, longitude)
   - Smooth bearing interpolation (exponential low-pass)
   - Real-time speed readout (km/h) in nav HUD
   - Direction arrow rotates live with heading
   - Off-route detection with reroute prompt
   - Fan-out route animation, best route = bright green
   - City-bounded search, road-snapped routing
================================================================ */

'use strict';

/* ── Canvas renderer ────────────────────────────────────────────── */
const CANVAS = L.canvas({ padding: 0.5, tolerance: 10 });

/* ── Map ────────────────────────────────────────────────────────── */
const map = L.map('map', {
  center:             [22.5, 80.0],
  zoom:               5,
  zoomControl:        false,
  minZoom:            4,
  maxZoom:            19,
  renderer:           CANVAS,
  preferCanvas:       true,
  tap:                true,
  tapTolerance:       20,
  bounceAtZoomLimits: false,
  zoomSnap:           0.5,
  wheelDebounceTime:  40,
});

L.control.zoom({ position: 'bottomright' }).addTo(map);

/* ── Tile layers ────────────────────────────────────────────────── */
const lightLayer = L.tileLayer(
  'https://tiles.openfreemap.org/styles/positron/{z}/{x}/{y}.png',
  {
    attribution:   '© <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom:       19,
    maxNativeZoom: 14,
    crossOrigin:   true,
    keepBuffer:    4,
  }
);

const darkLayer = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  {
    attribution:   '© OpenStreetMap © CARTO',
    maxZoom:       19,
    subdomains:    'abcd',
    crossOrigin:   true,
    keepBuffer:    4,
  }
);

const osmLayer = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '© OpenStreetMap', maxZoom: 19 }
);

let _mapMode     = 'dark';
let _tileErrCount = 0;

darkLayer.addTo(map);
darkLayer.on('tileerror', () => {
  _tileErrCount++;
  if (_tileErrCount > 5) {
    map.removeLayer(darkLayer);
    osmLayer.addTo(map);
  }
});

window._toggleMapStyle = function() {
  const btn = document.getElementById('map-toggle-btn');
  if (_mapMode === 'dark') {
    map.removeLayer(darkLayer);
    lightLayer.addTo(map);
    _mapMode = 'light';
    if (btn) { btn.title = 'Switch to Dark Map'; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>'; }
  } else {
    map.removeLayer(lightLayer);
    darkLayer.addTo(map);
    _mapMode = 'dark';
    if (btn) { btn.title = 'Switch to Light Map'; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'; }
  }
};

window.addEventListener('resize', () => {
  clearTimeout(window._resizeT);
  window._resizeT = setTimeout(() => map.invalidateSize({ animate: false }), 80);
});
setTimeout(() => map.invalidateSize(), 300);

/* ── Route colour palette ─────────────────────────────────────── */
const PALETTE = [
  { name: 'Best Route', badgeCls: 'badge-r1', cardAccent: '#00e676',
    fill: '#00e676', border: '#002d14',
    fw: 7, bw: 13, fo: 1.0, bo: 0.75, scanFo: 0.28, scanBo: 0.14,
    glow: 'rgba(0,230,118,0.55)', drawColor: '#00ff88' },
  { name: 'Route 2',    badgeCls: 'badge-r2', cardAccent: '#4fc3f7',
    fill: '#4fc3f7', border: '#002a45',
    fw: 5, bw: 10, fo: 0.75, bo: 0.45, scanFo: 0.30, scanBo: 0.16,
    glow: 'rgba(79,195,247,0.40)', drawColor: '#4fc3f7' },
  { name: 'Route 3',    badgeCls: 'badge-r3', cardAccent: '#ffb300',
    fill: '#ffb300', border: '#3a2200',
    fw: 5, bw: 10, fo: 0.70, bo: 0.42, scanFo: 0.28, scanBo: 0.14,
    glow: 'rgba(255,179,0,0.38)', drawColor: '#ffb300' },
  { name: 'Route 4',    badgeCls: 'badge-r4', cardAccent: '#ff5252',
    fill: '#ff5252', border: '#3a0000',
    fw: 4, bw: 9,  fo: 0.65, bo: 0.38, scanFo: 0.25, scanBo: 0.12,
    glow: 'rgba(255,82,82,0.35)', drawColor: '#ff5252' },
  { name: 'Route 5',    badgeCls: 'badge-r5', cardAccent: '#ea80fc',
    fill: '#ea80fc', border: '#2a0038',
    fw: 4, bw: 9,  fo: 0.60, bo: 0.34, scanFo: 0.22, scanBo: 0.10,
    glow: 'rgba(234,128,252,0.32)', drawColor: '#ea80fc' },
];

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
   Adapted for lat/lon independently.
   Q = process noise: how fast real position can change (m/s → degrees)
   R = measurement noise: GPS accuracy covariance
================================================================ */
class KalmanFilter1D {
  constructor(Q = 1e-5, R = 4e-8) {
    this.Q = Q;       // process noise (tuned for walking/driving)
    this.R = R;       // measurement noise (default: ~22m accuracy)
    this.P = 1.0;     // error covariance
    this.x = null;    // state (estimated value)
  }

  update(measurement) {
    if (this.x === null) { this.x = measurement; return measurement; }
    // Predict
    this.P += this.Q;
    // Update (Kalman gain)
    const K   = this.P / (this.P + this.R);
    this.x   += K * (measurement - this.x);
    this.P   *= (1 - K);
    return this.x;
  }

  /**
   * Tune R based on GPS accuracy (metres).
   * acc=5m → R≈2e-9, acc=20m → R≈3.2e-8, acc=100m → R≈8e-7
   */
  setAccuracy(acc) {
    // 1° ≈ 111 320 m → convert accuracy² in m² to degree²
    this.R = Math.pow(acc / 111320, 2);
    // Clamp to prevent over/under-trusting
    this.R = Math.max(1e-10, Math.min(this.R, 1e-5));
  }

  reset() { this.x = null; this.P = 1.0; }
}

const _kfLat = new KalmanFilter1D();
const _kfLon = new KalmanFilter1D();

/* ── State ──────────────────────────────────────────────────────── */
let userLat    = null;
let userLon    = null;
let userHeading = null;        // smoothed heading (degrees)
let _rawHeading = null;        // last raw heading for interpolation
let userSpeedKmh = 0;          // current speed in km/h
let userMarker = null;
let destMarker = null;
let routeGrps  = [];
let poiMarkers = [];
let _lastBounds  = null;
let _firstFix    = true;
let _gpsWatchId  = null;
let _suggestAbort = null;
let _suggestTimer = null;
let _lastGpsTs   = null;       // timestamp of last GPS fix (ms)
let _prevRawLat  = null;
let _prevRawLon  = null;

/* ── Scan animation state ───────────────────────────────────────── */
let _scanCircle    = null;
let _scanTracer    = null;
let _scanTimer     = null;
let _scanFrame     = null;
let _scanRings     = [];
let _scanDotTimer  = null;
let _scanStepTimer = null;

/* ── NAVIGATION (live tracking) state ──────────────────────────── */
let _navActive      = false;
let _navRouteIdx    = 0;
let _navLls         = [];
let _navArrow       = null;
let _navArrowTrail  = null;
let _navTravelledLls = [];
let _navRemainLine  = null;
let _navDestLat     = null;
let _navDestLon     = null;
let _navOffRouteCount = 0;
let _navCentering   = true;
let _navSpeedHistory = [];    // rolling window for speed smoothing

/* ── DOM refs ───────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const searchForm    = $('search-form');
const destInput     = $('dest-input');
const navBtn        = $('nav-btn');
const clearBtn      = $('clear-btn');
const gpsPill       = $('gps-pill');
const loader        = $('loader');
const loaderStep    = $('loader-step');
const loaderProg    = $('loader-progress-fill');
const errorBox      = $('error-msg');
const infoBox       = $('info-msg');
const routePanel    = $('route-panel');
const cardsWrap     = $('cards-wrap');
const gpsHUD        = $('gps-coords');
const closePanel    = $('close-panel');
const panelExpand   = $('panel-expand');
const routeBadge    = $('route-count-badge');
const scanEl        = $('scan-status');
const legendEl      = $('map-legend');
const legendItems   = $('legend-items');
const suggestList   = $('suggestions-list');
const locPrompt     = $('location-prompt');
const lpAllow       = $('lp-allow');
const lpDeny        = $('lp-deny');
const poiPanel      = $('poi-panel');
const poiList       = $('poi-list');
const poiClose      = $('poi-close');
const poiTitle      = $('poi-title');
const poiCount      = $('poi-count');
const myLocBtn      = $('my-location-btn');
const navHUD        = $('nav-hud');
const navHudDist    = $('nav-hud-dist');
const navHudTime    = $('nav-hud-time');
const navHudStreet  = $('nav-hud-street');
const navStopBtn    = $('nav-stop-btn');
const navSpeedVal   = $('nav-speed-val');
const navDirArrow   = $('nav-direction-arrow');

/* ── Custom marker icons ────────────────────────────────────────── */
const userIcon = L.divIcon({
  className: '',
  html: `<div class="m-user"><div class="m-pulse"></div><div class="m-dot"></div></div>`,
  iconSize: [30, 30], iconAnchor: [15, 15],
});

/** Navigation arrow — rotates with smoothed heading */
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

/** Compass bearing in degrees from A→B */
function _bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Shortest angular difference between two headings (−180…+180) */
function _angleDiff(a, b) {
  let d = b - a;
  while (d >  180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Exponential low-pass bearing smoothing.
 * alpha = 0 → fully sticky (old), alpha = 1 → fully raw (new).
 * Handles 0/360 wrap-around correctly via shortest-path interpolation.
 */
function _smoothBearing(current, raw, alpha = 0.25) {
  if (current === null) return raw;
  const diff = _angleDiff(current, raw);
  return (current + alpha * diff + 360) % 360;
}

function _bearingToDirection(deg) {
  const dirs = ['↑ North','↗ NE','→ East','↘ SE','↓ South','↙ SW','← West','↖ NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/** Update the direction arrow element to point in the given heading */
function _updateDirectionArrow(heading) {
  if (!navDirArrow) return;
  navDirArrow.style.transform = `rotate(${heading}deg)`;
  navDirArrow.textContent = '';   // clear text; arrow is CSS triangle via ::before
}

/* ================================================================
   GPS / Location
================================================================ */

function initGPS() {
  if (!navigator.geolocation) {
    setGpsPill('No GPS', 'error');
    fallbackGPS();
    return;
  }
  if (locPrompt) {
    locPrompt.classList.remove('hidden');
  } else {
    _startWatchingGPS();
  }
}

if (lpAllow) lpAllow.addEventListener('click', () => {
  locPrompt.classList.add('hidden');
  _startWatchingGPS();
});
if (lpDeny) lpDeny.addEventListener('click', () => {
  locPrompt.classList.add('hidden');
  fallbackGPS();
});

function _startWatchingGPS() {
  setGpsPill('⌛ Locating…', 'loading');
  _kfLat.reset();
  _kfLon.reset();

  // First quick fix — coarse accuracy OK, just to get on map fast
  navigator.geolocation.getCurrentPosition(onGPSFix, onGPSError, {
    enableHighAccuracy: false, timeout: 8000, maximumAge: 10000,
  });

  // High-accuracy continuous watch — maximumAge:0 forces fresh fixes every time
  _gpsWatchId = navigator.geolocation.watchPosition(onGPSFix, onGPSError, {
    enableHighAccuracy: true,
    timeout:            15000,
    maximumAge:         0,
  });
}

function onGPSFix(pos) {
  const rawLat    = pos.coords.latitude;
  const rawLon    = pos.coords.longitude;
  const now       = pos.timestamp || Date.now();

  // Sanitize accuracy
  let acc = pos.coords.accuracy;
  if (!isFinite(acc) || acc <= 0 || acc > 50000) acc = 9999;

  // Reject only wildly inaccurate fixes after first lock
  if (acc > 2000 && userLat !== null) {
    setGpsPill(`⌛ Weak (±${Math.round(acc)}m)`, 'loading');
    return;
  }

  /* ── Kalman smooth position — use higher Q so position tracks movement ── */
  _kfLat.setAccuracy(Math.min(acc, 300));
  _kfLon.setAccuracy(Math.min(acc, 300));
  const lat = _kfLat.update(rawLat);
  const lon = _kfLon.update(rawLon);

  /* ── Speed calculation ──────────────────────────────────────── */
  const gpsSpeed   = pos.coords.speed;
  const gpsHeading = pos.coords.heading;

  let speedKmh = 0;
  if (gpsSpeed !== null && gpsSpeed !== undefined && isFinite(gpsSpeed) && gpsSpeed >= 0) {
    speedKmh = gpsSpeed * 3.6;   // m/s → km/h
  } else if (_prevRawLat !== null && _lastGpsTs !== null) {
    const dt = (now - _lastGpsTs) / 1000;
    if (dt > 0 && dt < 60) {
      const dm = _haversineJS(_prevRawLat, _prevRawLon, rawLat, rawLon);
      speedKmh = (dm / dt) * 3.6;
    }
  }
  speedKmh = Math.min(speedKmh, 200);

  // Rolling average over last 5 samples
  _navSpeedHistory.push(speedKmh);
  if (_navSpeedHistory.length > 5) _navSpeedHistory.shift();
  userSpeedKmh = _navSpeedHistory.reduce((a, b) => a + b, 0) / _navSpeedHistory.length;

  /* ── Heading — accept GPS heading at any speed > 0.5 km/h ── */
  let rawBearing = null;
  if (gpsHeading !== null && gpsHeading !== undefined && isFinite(gpsHeading) && !isNaN(gpsHeading) && speedKmh > 0.5) {
    rawBearing = gpsHeading;
  } else if (_prevRawLat !== null &&
             (Math.abs(rawLat - _prevRawLat) > 1e-6 || Math.abs(rawLon - _prevRawLon) > 1e-6)) {
    rawBearing = _bearingDeg(_prevRawLat, _prevRawLon, rawLat, rawLon);
  }

  if (rawBearing !== null) {
    _rawHeading = rawBearing;
    const alpha = Math.min(0.55, Math.max(0.15, speedKmh / 80));
    userHeading = _smoothBearing(userHeading, rawBearing, alpha);
  }

  _prevRawLat = rawLat;
  _prevRawLon = rawLon;
  _lastGpsTs  = now;

  /* ── Store smoothed position ─────────────────────────────────── */
  userLat = lat;
  userLon = lon;

  // GPS pill display
  const accDisplay = acc >= 9999 ? '>999' : `±${Math.round(acc)}`;
  const pillClass  = acc < 30 ? 'ok' : acc < 100 ? 'medium' : 'error';
  const pillLabel  = acc < 9999 ? `📡 ${accDisplay}m` : '⌛ Locating…';
  setGpsPill(pillLabel, pillClass);

  gpsHUD.className = acc < 100 ? 'ok' : '';
  gpsHUD.innerHTML =
    `<span class="hud-lbl">LAT</span> ${lat.toFixed(6)}\n` +
    `<span class="hud-lbl">LON</span> ${lon.toFixed(6)}\n` +
    `<span class="hud-acc">${accDisplay}m · ${Math.round(userSpeedKmh)}km/h</span>`;

  if (!userMarker) {
    userMarker = L.marker([lat, lon], {
      icon: userIcon, zIndexOffset: 4000, title: 'Your Location',
    }).addTo(map).bindPopup(buildLocationPopup(lat, lon, acc), { maxWidth: 240 });

    if (_firstFix) {
      _firstFix = false;
      map.flyTo([lat, lon], 15, { duration: 1.6, easeLinearity: 0.4 });
    }
  } else {
    // Always update marker position on every fix
    userMarker.setLatLng([lat, lon]);
    userMarker.setPopupContent(buildLocationPopup(lat, lon, acc));
  }

  // Keep map centered on user when not navigating and not panned away
  if (!_navActive && _navCentering) {
    map.panTo([lat, lon], { animate: true, duration: 0.5, easeLinearity: 0.5 });
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
  setGpsPill('⚠ GPS off', 'error');
  showError(`${msgs[err.code] || 'GPS error.'} Using New Delhi as default.`, 8000);
  fallbackGPS();
}

function fallbackGPS() {
  if (userLat !== null) return;
  userLat = 28.6139; userLon = 77.2090;
  gpsHUD.innerHTML =
    `<span class="hud-lbl">LAT</span> 28.613900\n` +
    `<span class="hud-lbl">LON</span> 77.209000\n` +
    `<span class="hud-acc">DEFAULT · New Delhi</span>`;
}

if (myLocBtn) myLocBtn.addEventListener('click', () => {
  if (userLat !== null) {
    _navCentering = true;   // re-enable auto-follow
    map.flyTo([userLat, userLon], Math.max(map.getZoom(), 16), { duration: 1.0 });
    if (userMarker) userMarker.openPopup();
  } else {
    showError('Location not yet available. Please allow location access.', 4000);
    if (locPrompt) locPrompt.classList.remove('hidden');
  }
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

  _navActive     = true;
  _navRouteIdx   = routeIdx;
  _navLls        = grp.lls.slice();
  _navTravelledLls = [];
  _navOffRouteCount = 0;
  _navCentering   = true;
  _navDestLat     = _navLls[_navLls.length - 1][0];
  _navDestLon     = _navLls[_navLls.length - 1][1];
  _navSpeedHistory = [];

  // Dim other routes
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

  map.flyTo([startLat, startLon], 16, { duration: 1.2 });
  _updateNavHUD(startLat, startLon);

  showInfo(`Navigation started on ${PALETTE[routeIdx]?.name || 'Route'}. Follow the green line.`, 4000);
}

function stopNavigation(showMsg = true) {
  if (!_navActive && !_navArrow) return;
  _navActive = false;

  if (_navArrow)      { try { map.removeLayer(_navArrow); }      catch (_) {} _navArrow = null; }
  if (_navArrowTrail) { try { map.removeLayer(_navArrowTrail); } catch (_) {} _navArrowTrail = null; }
  if (_navRemainLine) { try { map.removeLayer(_navRemainLine); } catch (_) {} _navRemainLine = null; }

  _navLls = []; _navTravelledLls = []; _navOffRouteCount = 0;
  _navSpeedHistory = [];

  routeGrps.forEach((g, i) => {
    if (g._glowOnly) return;
    const pal = PALETTE[i] || PALETTE[PALETTE.length - 1];
    const isBest = g.isBest;
    g.fill.setStyle({ color: isBest ? '#00e676' : pal.fill, opacity: isBest ? 1.0 : pal.fo * 0.55, weight: pal.fw });
    g.border.setStyle({ opacity: isBest ? 0.75 : pal.bo * 0.4, weight: pal.bw });
  });

  if (navHUD) navHUD.classList.remove('show');
  if (showMsg) showInfo('Navigation stopped.', 3000);
}

/** Called on every GPS fix while navigating */
function _onNavGPSUpdate(lat, lon, acc) {
  if (!_navActive || !_navLls.length) return;

  /* Update nav arrow position + rotation */
  if (_navArrow) {
    _navArrow.setLatLng([lat, lon]);
    if (userHeading !== null) {
      _navArrow.setIcon(makeNavArrowIcon(userHeading, false));
    }
  }

  /* Update direction arrow in HUD */
  if (userHeading !== null) _updateDirectionArrow(userHeading);

  /* Update live speed in HUD */
  if (navSpeedVal) {
    navSpeedVal.textContent = Math.round(userSpeedKmh);
  }

  /* Travelled trail */
  _navTravelledLls.push([lat, lon]);
  if (_navArrowTrail && _navTravelledLls.length >= 2) {
    _navArrowTrail.setLatLngs(_navTravelledLls);
  }

  /* Auto-center map on user position during navigation */
  if (_navCentering) {
    if (_navTravelledLls.length <= 2) {
      // First update after nav start — fly to position at nav zoom
      map.flyTo([lat, lon], 17, { duration: 1.0, easeLinearity: 0.5 });
    } else {
      map.panTo([lat, lon], { animate: true, duration: 0.35, easeLinearity: 0.6 });
    }
  }

  /* Off-route detection — only trigger if GPS is reliable */
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

  /* Arrival check */
  const distToDest = _haversineJS(lat, lon, _navDestLat, _navDestLon);
  if (distToDest < 40) {
    _onNavArrived();
  }
}

function _updateNavHUD(lat, lon) {
  if (!navHUD || !_navLls.length) return;

  const distM = _remainingDistOnRoute(lat, lon, _navLls);

  /* ETA: use live speed if > 5 km/h, else fallback to 30 km/h (city average) */
  const speedForEta = userSpeedKmh > 5 ? userSpeedKmh : 30;
  const timeMin = Math.max(1, Math.round((distM / 1000) / speedForEta * 60));

  if (navHudDist) navHudDist.textContent = distM < 1000
    ? `${Math.round(distM)}m` : `${(distM / 1000).toFixed(1)}km`;
  if (navHudTime) navHudTime.textContent = timeMin < 1 ? '<1 min' : `${timeMin} min`;
  if (navSpeedVal) navSpeedVal.textContent = Math.round(userSpeedKmh);

  /* Direction instruction from route geometry */
  const nearest   = _nearestPointOnRoute(lat, lon, _navLls);
  const remaining = _navLls.slice(nearest.idx);
  if (remaining.length >= 2) {
    const lookAhead = Math.min(6, remaining.length - 1);
    const bearing   = _bearingDeg(
      remaining[0][0], remaining[0][1],
      remaining[lookAhead][0], remaining[lookAhead][1]
    );
    /* Smooth the heading used for the HUD arrow */
    const hudHeading = _smoothBearing(userHeading, bearing, 0.3);
    if (navHudStreet) navHudStreet.textContent = _bearingToDirection(hudHeading);
    _updateDirectionArrow(hudHeading);
  }
}

function _onNavArrived() {
  _navActive = false;
  if (navHUD) {
    navHUD.classList.add('arrived');
    if (navHudDist)  navHudDist.textContent  = 'Arrived!';
    if (navHudTime)  navHudTime.textContent  = '🎉';
    if (navHudStreet) navHudStreet.textContent = 'You have reached your destination';
    if (navSpeedVal)  navSpeedVal.textContent  = '0';
  }
  if (navDirArrow) navDirArrow.style.transform = 'rotate(0deg)';
  if (_navArrow) _navArrow.setIcon(L.divIcon({
    className: '',
    html: `<div class="m-arrived">🏁</div>`,
    iconSize: [40, 40], iconAnchor: [20, 20],
  }));
  setTimeout(() => stopNavigation(false), 5000);
}

function _promptReroute(lat, lon) {
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
    dist += _haversineJS(lls[i][0], lls[i][1], lls[i+1][0], lls[i+1][1]);
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

if (navStopBtn) navStopBtn.addEventListener('click', () => stopNavigation(true));
// Dragging pauses auto-follow; tapping "my location" FAB re-enables it
map.on('dragstart', () => { _navCentering = false; });
map.on('zoomstart', () => { if (!_navActive) _navCentering = false; });

/* ================================================================
   Autocomplete Suggestions
================================================================ */

destInput.addEventListener('input', () => {
  const q = destInput.value.trim();
  clearBtn.style.display = q ? 'flex' : 'none';
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
  const items  = suggestList.querySelectorAll('.suggest-item');
  const active = suggestList.querySelector('.suggest-item.active');
  let idx = active ? Array.from(items).indexOf(active) : -1;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = Math.min(idx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = Math.max(idx - 1, 0);
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    if (active) { e.preventDefault(); active.click(); }
  } else if (e.key === 'Escape') {
    hideSuggestions(); destInput.blur();
  }
});

clearBtn.addEventListener('click', () => {
  destInput.value = '';
  clearBtn.style.display = 'none';
  hideSuggestions();
  destInput.focus();
});

async function fetchSuggestions(q) {
  if (_suggestAbort) _suggestAbort.abort();
  _suggestAbort = new AbortController();
  try {
    const params = new URLSearchParams({ q });
    if (userLat !== null) { params.set('lat', userLat); params.set('lon', userLon); }
    const res  = await fetch(`/suggestions?${params}`, { signal: _suggestAbort.signal });
    const data = await res.json();
    renderSuggestions(data, q);
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Suggestions error:', err);
  }
}

function renderSuggestions(items, query) {
  suggestList.innerHTML = '';
  if (!items?.length) { hideSuggestions(); return; }
  items.forEach(item => {
    const li   = document.createElement('li');
    li.className = 'suggest-item';
    li.setAttribute('role', 'option');
    const isPOI = item.type === 'poi';
    li.innerHTML = `
      <span class="sug-icon">${isPOI ? '🔍' : '📍'}</span>
      <div class="sug-text">
        <span class="sug-main">${highlightMatch(item.label, query)}</span>
        ${item.sublabel ? `<span class="sug-sub">${item.sublabel}</span>` : ''}
      </div>
      ${isPOI ? '<span class="sug-badge">Near me</span>' : ''}
    `;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      destInput.value = item.query || item.label;
      clearBtn.style.display = 'flex';
      hideSuggestions();
      searchForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    suggestList.appendChild(li);
  });
  suggestList.classList.remove('hidden');
  destInput.setAttribute('aria-expanded', 'true');
}

function highlightMatch(text, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<strong>$1</strong>');
}

function hideSuggestions() {
  suggestList.classList.add('hidden');
  destInput.setAttribute('aria-expanded', 'false');
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
  const maxR  = Math.max(distM * 0.85, 400);

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
      const dur  = 1800 + i * 150;
      const t    = Math.min(elapsed / dur, 1);
      const ease = 1 - Math.pow(1 - t, 2.5);
      circle.setRadius(r0 + (maxR - r0) * ease);
      circle.setStyle({
        opacity: (1 - ease) * (i === 0 ? 0.90 : 0.65),
        fillOpacity: i === 0 ? (1 - ease) * 0.05 : 0,
      });
      if (t < 1) {
        requestAnimationFrame(animRing);
      } else {
        try { map.removeLayer(circle); } catch (_) {}
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
            const t2  = Math.min(el2 / dur2, 1);
            const e2  = 1 - Math.pow(1 - t2, 2.5);
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

  let dotPhase = 0;
  let dotMarker = null;
  try {
    dotMarker = L.circleMarker([sLat, sLon], {
      radius: 5, color: '#00d4ff', fillColor: '#00d4ff',
      fillOpacity: 0.9, weight: 2, opacity: 0.9, interactive: false,
    }).addTo(map);
  } catch (_) {}

  _scanDotTimer = setInterval(() => {
    if (!_scanCircle || !dotMarker?._map) {
      clearInterval(_scanDotTimer);
      if (dotMarker) try { map.removeLayer(dotMarker); } catch (_) {}
      return;
    }
    dotPhase = (dotPhase + 0.032) % 1;
    const t   = dotPhase < 0.5 ? dotPhase * 2 : (1 - dotPhase) * 2;
    dotMarker.setLatLng([sLat + (destLat - sLat) * t, sLon + (destLon - sLon) * t]);
    dotMarker.setRadius(4 + Math.sin(dotPhase * Math.PI * 4) * 2);
  }, 30);
}

function stopScanAnimation() {
  if (_scanFrame)     { cancelAnimationFrame(_scanFrame);   _scanFrame = null; }
  if (_scanTimer)     { clearTimeout(_scanTimer);           _scanTimer = null; }
  if (_scanStepTimer) { clearTimeout(_scanStepTimer);       _scanStepTimer = null; }
  if (_scanDotTimer)  { clearInterval(_scanDotTimer);       _scanDotTimer = null; }
  if (_scanCircle)    { try { map.removeLayer(_scanCircle); } catch (_) {} _scanCircle = null; }
  if (_scanTracer)    { try { map.removeLayer(_scanTracer); } catch (_) {} _scanTracer = null; }
  _scanRings.forEach(c => { try { map.removeLayer(c); } catch (_) {} });
  _scanRings = [];
}

/* Haversine distance (metres) */
function _haversineJS(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dp/2)**2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ================================================================
   Search / Navigate
================================================================ */

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideSuggestions();
  const query = destInput.value.trim();
  if (!query) { destInput.focus(); return; }

  const lat = userLat ?? 28.6139;
  const lon = userLon ?? 77.2090;

  const isNear = /near\s*me|nearby|near by|close to me|around me/i.test(query);
  if (isNear) {
    await handleNearbySearch(query, lat, lon);
    return;
  }
  await handleRouteSearch(query, lat, lon);
});

async function handleRouteSearch(dest, lat, lon) {
  stopNavigation(false);
  clearRoutes();
  clearPOI();
  hideError();
  navBtn.disabled = true;
  showLoader(true, 0);
  setLoaderStep('Finding routes…');
  setProgress(20);

  try {
    const res  = await fetch('/route', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_lat: lat, start_lon: lon, destination: dest }),
    });
    const data = await res.json();
    setProgress(75);

    if (!res.ok) { showError(data.error || 'Server error.'); showLoader(false); return; }
    if (!data.routes?.length) { showError('No routes found. Try a different destination.'); showLoader(false); return; }

    setProgress(95);
    showLoader(false);

    startScanAnimation(data.destination.lat, data.destination.lon);
    setScanStatus('scanning');

    const sLat = userLat ?? lat, sLon = userLon ?? lon;
    fitBoundsNow(L.latLngBounds([[sLat, sLon], [data.destination.lat, data.destination.lon]]), false, false);

    await sleep(1500);
    stopScanAnimation();
    await renderRoutes(data.routes, data.destination);

  } catch (err) {
    showError('Network error. Is the server running?');
    showLoader(false);
    stopScanAnimation();
  } finally {
    navBtn.disabled = false;
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
    const res    = await fetch(`/nearby?${params}`);
    const data   = await res.json();
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
  poiTitle.textContent = `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} Near You`;
  poiCount.textContent = `${results.length} found`;
  poiList.innerHTML    = '';

  const bounds = L.latLngBounds([[uLat, uLon]]);

  results.forEach((poi, i) => {
    bounds.extend([poi.lat, poi.lon]);

    const icon   = makePOIIcon(poi.type);
    const marker = L.marker([poi.lat, poi.lon], { icon, zIndexOffset: 2000 - i, title: poi.name }).addTo(map);

    marker.bindPopup(`<div class="pop-inner">
      <div class="pop-title" style="color:#00e676">${POI_ICONS[poi.type] || '📍'} ${poi.name}</div>
      <div class="pop-row"><span>Type</span><span>${poi.type}</span></div>
      <div class="pop-row"><span>Distance</span><span>${formatDist(poi.distance_m)}</span></div>
      ${poi.address ? `<div class="pop-row"><span>Address</span><span style="max-width:130px;text-align:right">${poi.address.substring(0,60)}</span></div>` : ''}
      ${poi.extra?.cuisine ? `<div class="pop-row"><span>Cuisine</span><span>${poi.extra.cuisine}</span></div>` : ''}
      ${poi.extra?.opening_hours ? `<div class="pop-row"><span>Hours</span><span style="max-width:130px;text-align:right">${poi.extra.opening_hours.substring(0,40)}</span></div>` : ''}
      ${poi.extra?.phone ? `<div class="pop-row"><span>Phone</span><span>${poi.extra.phone}</span></div>` : ''}
      <button class="pop-route-btn" data-poi-idx="${i}">🗺 Get Directions</button>
    </div>`, { maxWidth: 270 });

    marker.on('popupopen', () => {
      const btn = marker.getPopup().getElement()?.querySelector('.pop-route-btn');
      if (btn) btn.onclick = () => routeToPOI(poi.lat, poi.lon, poi.name);
    });

    poiMarkers.push(marker);

    const item = document.createElement('div');
    item.className = 'poi-item';
      item.innerHTML = `
        <div class="poi-item-icon">${POI_ICONS[poi.type] || '📍'}</div>
        <div class="poi-item-info">
          <div class="poi-item-name">${poi.name}</div>
          <div class="poi-item-meta">${poi.type} · ${formatDist(poi.distance_m)}</div>
          ${poi.extra?.cuisine ? `<div class="poi-item-addr">🍽 ${poi.extra.cuisine}</div>` :
            poi.address ? `<div class="poi-item-addr">${poi.address.substring(0,55)}</div>` : ''}
          ${poi.extra?.opening_hours ? `<div class="poi-item-addr">🕐 ${poi.extra.opening_hours.substring(0,40)}</div>` : ''}
        </div>
        <button class="poi-route-btn" title="Directions">▶</button>
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

  poiPanel.classList.remove('hidden');
  fitBoundsNow(bounds, false, true);
}

window.routeToPOI = async function(poiLat, poiLon, name) {
  poiPanel.classList.add('hidden');
  destInput.value = name;
  clearBtn.style.display = 'flex';
  await handleRouteToCoords(poiLat, poiLon, name);
};

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
  showLoader(false);

  try {
    setProgress(50);
    const res  = await fetch('/route-coords', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_lat: sLat, start_lon: sLon, dest_lat: destLat, dest_lon: destLon }),
    });
    const data = await res.json();
    setProgress(85);

    if (!res.ok) { stopScanAnimation(); showError(data.error || 'Could not find route.'); return; }
    if (!data.routes?.length) { stopScanAnimation(); showError('No drivable route found.'); return; }

    setProgress(98);
    await sleep(600);
    stopScanAnimation();
    await renderRoutes(data.routes, data.destination);

  } catch (err) {
    stopScanAnimation();
    showError('Network error. Is the server running?');
  } finally {
    showLoader(false);
    navBtn.disabled = false;
  }
}

poiClose.addEventListener('click', () => poiPanel.classList.add('hidden'));

function clearPOI() {
  poiMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
  poiMarkers = [];
  poiPanel.classList.add('hidden');
  poiList.innerHTML = '';
}

function formatDist(m) {
  return m < 1000 ? `${m}m` : `${(m/1000).toFixed(1)}km`;
}

/* ================================================================
   Render Routes — Fan-out animation, best route green last
================================================================ */

function _drawRouteTracer(lls, color, weight, opacity, dur, delay = 0) {
  return new Promise(resolve => {
    if (!lls || lls.length < 2) return resolve();

    const svgR = L.svg({ padding: 0.8 });
    const line = L.polyline(lls, {
      renderer: svgR, color, weight, opacity,
      lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0,
      interactive: false, pane: 'overlayPane',
    }).addTo(map);

    requestAnimationFrame(() => {
      const el = line.getElement?.();
      if (!el) { try { map.removeLayer(line); } catch (_) {} return resolve(); }

      const paths = el.tagName?.toLowerCase() === 'path'
        ? [el] : Array.from(el.querySelectorAll?.('path') || []);

      if (!paths.length) { try { map.removeLayer(line); } catch (_) {} return resolve(); }

      paths.forEach(path => {
        let len = 0;
        try { len = path.getTotalLength?.() || 0; } catch (_) {}
        if (len <= 0) len = 80000;
        path.style.transition       = 'none';
        path.style.strokeDasharray  = `${len}`;
        path.style.strokeDashoffset = `${len}`;
      });

      void el.getBoundingClientRect();

      paths.forEach(path => {
        let len = 0;
        try { len = path.getTotalLength?.() || 0; } catch (_) {}
        if (len <= 0) len = 80000;
        path.style.transition       = `stroke-dashoffset ${dur}ms cubic-bezier(0.25,0.05,0.15,1) ${delay}ms`;
        path.style.strokeDashoffset = '0';
      });

      setTimeout(() => { try { map.removeLayer(line); } catch (_) {} resolve(); }, dur + delay + 60);
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

  const bounds = L.latLngBounds([[sLat, sLon], [destination.lat, destination.lon]]);

  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    const pal   = PALETTE[i] || PALETTE[PALETTE.length - 1];
    const lls   = route.geometry.map(([ln, lt]) => [lt, ln]);
    lls.forEach(ll => bounds.extend(ll));

    const bLine = L.polyline(lls, {
      renderer: CANVAS, color: pal.border, weight: pal.bw, opacity: 0,
      lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0, interactive: false,
    }).addTo(map);

    const fLine = L.polyline(lls, {
      renderer: CANVAS, color: i === 0 ? '#00e676' : pal.fill,
      weight: pal.fw, opacity: 0,
      lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0,
    }).addTo(map);

    fLine.bindPopup(buildRoutePopup(route, i, pal), { maxWidth: 260 });

    fLine.on('mouseover', function() { this.setStyle({ weight: pal.fw + 4, opacity: 1.0 }); bLine.setStyle({ weight: pal.bw + 4 }); });
    fLine.on('mouseout', function() {
      const grp = routeGrps.find(g => g.fill === fLine);
      const rev = grp?._revealed, isBest = grp?.isBest;
      this.setStyle({ weight: pal.fw, opacity: rev ? (isBest ? 1.0 : pal.fo * 0.55) : 0 });
      bLine.setStyle({ weight: pal.bw, opacity: rev ? (isBest ? pal.bo : pal.bo * 0.4) : 0 });
    });

    routeGrps.unshift({ border: bLine, fill: fLine, pal, lls, _revealed: false, isBest: i === 0 });
  }

  _lastBounds = bounds;
  fitBoundsNow(bounds, false, false);
  setScanStatus('scanning');

  const altGrps  = routeGrps.slice(1);
  const bestGrp  = routeGrps[0];

  const altPromises = altGrps.map((g, i) => {
    const delay = i * 60, dur = 1100 + i * 80;
    setTimeout(() => {
      g.fill.setStyle({ opacity: g.pal.scanFo });
      g.border.setStyle({ opacity: g.pal.scanBo });
    }, delay + 80);
    return _drawRouteTracer(g.lls, g.pal.drawColor, g.pal.fw + 2, 0.80, dur, delay)
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

    await _drawRouteTracer(bestGrp.lls, '#00ff88', bestGrp.pal.fw + 5, 1.0, 1600, 0);

    bestGrp.fill.setStyle({ color: '#ffffff', weight: bestGrp.pal.fw + 8, opacity: 1 });
    bestGrp.border.setStyle({ color: '#ccffdd', weight: bestGrp.pal.bw + 8, opacity: 0.9 });
    await sleep(80);

    bestGrp.fill.setStyle({ color: '#00e676', weight: bestGrp.pal.fw, opacity: 1.0 });
    bestGrp.border.setStyle({ color: '#002d14', weight: bestGrp.pal.bw, opacity: 0.80 });
    bestGrp._revealed = true;
    bestGrp.isBest    = true;
    bestGrp.border.bringToFront();
    bestGrp.fill.bringToFront();

    _drawRouteTracer(bestGrp.lls, '#ffffff', bestGrp.pal.fw + 3, 0.55, 1200, 0);
    _addGlowLine(bestGrp.lls, '#00e676');
  }

  setScanStatus('found');
  stopScanAnimation();

  await sleep(200);
  routeBadge.textContent = `${routes.length} ROUTE${routes.length !== 1 ? 'S' : ''}`;
  buildCards(routes);
  updateLegend(routes);
  routePanel.classList.add('show');
  legendEl.classList.remove('hidden');

  await sleep(300);
  fitBoundsNow(bounds, true, false);
}

function _addGlowLine(lls, color) {
  const svgR = L.svg({ padding: 0.8 });
  const glow = L.polyline(lls, {
    renderer: svgR, color, weight: 18, opacity: 0.08,
    lineJoin: 'round', lineCap: 'round', smoothFactor: 1.0,
    interactive: false, pane: 'overlayPane',
  }).addTo(map);
  routeGrps.push({ border: glow, fill: glow, pal: PALETTE[0], lls, _revealed: true, _glowOnly: true });
}

/* ── fitBoundsNow ─────────────────────────────────────────────── */
function fitBoundsNow(bounds, panelVisible, isPOI) {
  if (!bounds?.isValid()) return;
  const topH    = ($('topbar')?.offsetHeight || 60) + 16;
  const panelH  = panelVisible
    ? Math.min(routePanel.offsetHeight || 220, window.innerHeight * 0.44) + 24 : 16;
  const rightPad = legendEl && !legendEl.classList.contains('hidden') ? 90 : 20;
  map.fitBounds(bounds, {
    paddingTopLeft: [20, topH], paddingBottomRight: [rightPad, panelH],
    maxZoom: isPOI ? 16 : 14, animate: true, duration: 0.9,
  });
}

/* ── Route popup ─────────────────────────────────────────────── */
function buildRoutePopup(route, index, pal) {
  const label = index === 0 ? '★ Best Route' : pal.name;
  const tags  = (route.tags || []).map(t => `<span class="ptag">${tagLabel(t)}</span>`).join('') || '—';
  return `<div class="pop-inner">
    <div class="pop-title" style="color:${pal.fill}">${label}</div>
    <div class="pop-row"><span>Distance</span><span>${route.distance_km} km</span></div>
    <div class="pop-row"><span>Duration</span><span>${route.duration_min} min</span></div>
    <div class="pop-row"><span>Score</span><span>${route.score}</span></div>
    <div class="pop-row"><span>Tags</span><span class="ptags">${tags}</span></div>
    <button class="pop-route-btn" onclick="startNavigation(${index})">▶ Start Navigation</button>
  </div>`;
}

/* ── Route cards ─────────────────────────────────────────────── */
function buildCards(routes) {
  cardsWrap.innerHTML = '';
  const maxScore = Math.max(...routes.map(r => r.score), 1);

  routes.forEach((route, i) => {
    const pal = PALETTE[i] || PALETTE[PALETTE.length - 1];
    const pct = Math.round((route.score / maxScore) * 100);
    const tagsHTML = (route.tags || []).map(t =>
      `<span class="tag ${tagClass(t)}">${tagLabel(t)}</span>`).join('');

    const card = document.createElement('div');
    card.className = 'route-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${pal.name}: ${route.distance_km}km, ${route.duration_min}min`);
    card.style.setProperty('--accent', pal.cardAccent);
    card.style.animationDelay = `${i * 0.07}s`;

    card.innerHTML = `
      <div class="card-top">
        <span class="badge ${pal.badgeCls}">${pal.name}</span>
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
      <button class="card-nav-btn" data-route-idx="${i}">▶ Navigate</button>
    `;

    card.querySelector('.card-nav-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      startNavigation(i);
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
  grp.fill.setStyle({ weight: grp.pal.fw + 5, opacity: 1 });
  grp.border.setStyle({ weight: grp.pal.bw + 5 });
  setTimeout(() => {
    grp.fill.setStyle({ weight: grp.pal.fw, opacity: grp.pal.fo });
    grp.border.setStyle({ weight: grp.pal.bw, opacity: grp.pal.bo });
  }, 1600);
  setTimeout(() => {
    const mid = grp.lls[Math.floor(grp.lls.length / 2)];
    grp.fill.openPopup(mid);
  }, 600);
}

window.startNavigation = startNavigation;

/* ── Legend ──────────────────────────────────────────────────── */
function updateLegend(routes) {
  legendItems.innerHTML = '';
  routes.forEach((_, i) => {
    const pal  = PALETTE[i] || PALETTE[PALETTE.length - 1];
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <div class="leg-line" style="background:${pal.fill};box-shadow:0 0 5px ${pal.fill}55"></div>
      <span class="leg-label">${pal.name}</span>
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
    scanEl.className   = 'found';
    setTimeout(() => { if (scanEl) scanEl.className = 'hidden'; }, 3200);
  } else {
    scanEl.className   = 'hidden';
    scanEl.textContent = '';
  }
}

/* ── Clear routes ────────────────────────────────────────────── */
function clearRoutes() {
  stopScanAnimation();
  stopNavigation(false);
  routeGrps.forEach(({ border, fill }) => {
    try { map.removeLayer(border); } catch (_) {}
    try { map.removeLayer(fill);   } catch (_) {}
  });
  routeGrps   = [];
  _lastBounds = null;
  if (destMarker) { try { map.removeLayer(destMarker); } catch (_) {} destMarker = null; }
  routePanel.classList.remove('show');
  legendEl.classList.add('hidden');
  cardsWrap.innerHTML = '';
  setScanStatus('hide');
}

/* ── Panel controls ──────────────────────────────────────────── */
closePanel.addEventListener('click', () => {
  routePanel.classList.remove('show', 'expanded');
  if (_lastBounds) fitBoundsNow(_lastBounds, false, false);
});
panelExpand.addEventListener('click', () => {
  routePanel.classList.toggle('expanded');
  panelExpand.innerHTML = routePanel.classList.contains('expanded')
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  setTimeout(() => { if (_lastBounds) fitBoundsNow(_lastBounds, true, false); }, 320);
});

/* ── Tag helpers ─────────────────────────────────────────────── */
const TAG_MAP = {
  best:     ['★ Best',      'tag-best'],
  fastest:  ['⚡ Fastest',  'tag-fast'],
  shortest: ['📏 Shortest', 'tag-short'],
  safest:   ['🛡 Safest',   'tag-safe'],
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
function hideError() { errorBox.classList.remove('show'); }
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

/* ── Boot ───────────────────────────────────────────────────── */

(function checkHttps() {
  const proto    = location.protocol;
  const host     = location.hostname;
  const isSecure = proto === 'https:' || host === 'localhost' || host === '127.0.0.1';
  if (!isSecure) {
    const banner = document.getElementById('https-banner');
    const urlEl  = document.getElementById('https-url');
    if (banner && urlEl) {
      urlEl.textContent = `https://${host}:${location.port || 5000}`;
      banner.classList.remove('hidden');
    }
  }
})();

initGPS();
