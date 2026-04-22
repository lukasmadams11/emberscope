/* ============================================================
   EmberScope — Wildfire Risk on Real Satellite Imagery
   Single-file JS. Requires Leaflet 1.9+ loaded before this runs.
   ============================================================ */

/* ---------- Leaflet map + basemaps ---------- */
const map = L.map('leaflet-map', {
  zoomControl: true,
  attributionControl: true,
  preferCanvas: true
}).setView([34.12, -118.29], 5);

const tileLayers = {
  satellite: L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri — USGS, NOAA, Maxar', maxZoom: 19 }
  ),
  hybridLabels: L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { attribution: '', maxZoom: 19, opacity: 0.9 }
  ),
  topo: L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri', maxZoom: 17 }
  )
};
tileLayers.satellite.addTo(map);

function switchBasemap(b) {
  [tileLayers.satellite, tileLayers.hybridLabels, tileLayers.topo].forEach(l => map.removeLayer(l));
  if (b === 'satellite') tileLayers.satellite.addTo(map);
  else if (b === 'hybrid') { tileLayers.satellite.addTo(map); tileLayers.hybridLabels.addTo(map); }
  else if (b === 'topo') tileLayers.topo.addTo(map);
  document.querySelectorAll('.basemap-switch button').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.b === b)
  );
}
document.querySelectorAll('.basemap-switch button').forEach(btn =>
  btn.addEventListener('click', () => switchBasemap(btn.dataset.b))
);

/* ---------- Status banner (shown over the map) ---------- */
function setStatus(html) {
  const el = document.getElementById('map-status');
  if (el) el.innerHTML = html;
}

/* ---------- Address search (Nominatim) ---------- */
const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
let searchTimer = null;
let searchSeq = 0;

function showResults(items) {
  searchResults.innerHTML = '';
  if (!items.length) {
    searchResults.innerHTML =
      '<div class="search-result"><span style="color:var(--muted)">No matches — try adding a city or state.</span></div>';
  } else {
    items.forEach(it => {
      const el = document.createElement('div');
      el.className = 'search-result';
      el.innerHTML = '<div>' + it.title + '</div><small>' + it.subtitle + '</small>';
      el.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus
      el.addEventListener('click', () => {
        map.setView([it.lat, it.lon], 18);
        searchResults.style.display = 'none';
        searchInput.value = it.title;
        placeDefaultParcel(it.lat, it.lon);
        setStatus('<b>Step 2.</b> Drag handles to reshape your parcel (acreage, loss estimate and fuel mix update live). Then click inside it to mark an ignition point.');
      });
      searchResults.appendChild(el);
    });
  }
  searchResults.style.display = 'block';
}

function showError(msg) {
  searchResults.innerHTML =
    '<div class="search-result"><span style="color:var(--danger)">' + msg + '</span></div>';
  searchResults.style.display = 'block';
}

function showLoading() {
  searchResults.innerHTML =
    '<div class="search-result"><span style="color:var(--muted)">Searching…</span></div>';
  searchResults.style.display = 'block';
}

// Photon (Komoot) — primary geocoder; CORS-friendly, no API key, works from file://
async function photonSearch(q) {
  const url = 'https://photon.komoot.io/api/?limit=6&q=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Photon HTTP ' + res.status);
  const data = await res.json();
  return (data.features || []).map(f => {
    const p = f.properties || {};
    const coords = f.geometry && f.geometry.coordinates;
    const title = [p.housenumber, p.street].filter(Boolean).join(' ') ||
                  p.name || p.city || p.state || 'Unknown';
    const parts = [p.city, p.state, p.country].filter(Boolean);
    const subtitle = (p.postcode ? p.postcode + ' · ' : '') + parts.join(', ');
    return { title: title, subtitle: subtitle || p.name || '', lat: coords[1], lon: coords[0] };
  });
}

// Nominatim fallback
async function nominatimSearch(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Nominatim HTTP ' + res.status);
  const data = await res.json();
  return data.map(r => ({
    title: r.display_name.split(',').slice(0, 2).join(','),
    subtitle: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon)
  }));
}

// Geocode.maps.co — free, no key, tolerant CORS; final fallback.
async function mapsCoSearch(q) {
  const url = 'https://geocode.maps.co/search?q=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Maps.co HTTP ' + res.status);
  const data = await res.json();
  return (data || []).slice(0, 6).map(r => ({
    title: (r.display_name || '').split(',').slice(0, 2).join(',') || 'Unknown',
    subtitle: r.display_name || '',
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon)
  })).filter(x => isFinite(x.lat) && isFinite(x.lon));
}

async function doSearch(q, seq) {
  showLoading();
  console.log('[search] querying:', q);
  let items = null, lastErr = null;
  try { items = await photonSearch(q); if (items && !items.length) items = null; }
  catch (e) { lastErr = e; console.warn('[search] Photon failed:', e.message); }
  if (!items) {
    try { items = await nominatimSearch(q); if (items && !items.length) items = null; }
    catch (e) { lastErr = e; console.warn('[search] Nominatim failed:', e.message); }
  }
  if (!items) {
    try { items = await mapsCoSearch(q); if (items && !items.length) items = null; }
    catch (e) { lastErr = e; console.warn('[search] Maps.co failed:', e.message); }
  }
  if (seq !== searchSeq) return; // stale
  if (!items) {
    showError('No results. ' + (lastErr ? '(' + lastErr.message + ')' : 'Try adding city + state, or a ZIP.'));
    return;
  }
  console.log('[search] got', items.length, 'results');
  showResults(items);
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) { searchResults.style.display = 'none'; return; }
  const seq = ++searchSeq;
  searchTimer = setTimeout(() => doSearch(q, seq), 300);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length >= 2) doSearch(q, ++searchSeq);
  } else if (e.key === 'Escape') {
    searchResults.style.display = 'none';
  }
});

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim().length >= 3 && searchResults.children.length) {
    searchResults.style.display = 'block';
  }
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) searchResults.style.display = 'none';
});


/* ---------- Location-aware data (Open-Meteo + regional priors) ---------- */
const LOC_CONTEXT = {
  lat: 34.12, lon: -118.29,
  state: null, stateName: null, country: 'US',
  biome: 'chaparral',
  homeValueMedian: 650000,
  regionalFireRisk: 1.0,
  elevation: null,
  tempC: null, humidity: null, windSpeedMph: null, windDirDeg: null,
  fuelBias: { grass: 0, shrub: 0, tree: 0 },
  displayName: ''
};

// US state median single-family home values (approx. 2024 Zillow / ACS)
const STATE_HOME_VALUE = {
  CA: 760000, HI: 840000, WA: 580000, OR: 490000, NV: 440000, AZ: 430000,
  CO: 570000, UT: 520000, ID: 450000, MT: 470000, NM: 310000, WY: 360000,
  TX: 300000, FL: 400000, NY: 470000, NJ: 520000, MA: 620000, CT: 410000,
  VA: 390000, NC: 340000, SC: 300000, GA: 330000, TN: 320000, KY: 220000,
  OH: 230000, MI: 250000, IL: 270000, PA: 270000, IN: 240000, WI: 280000,
  MN: 330000, IA: 220000, MO: 240000, KS: 230000, NE: 260000, OK: 210000,
  AR: 200000, LA: 210000, MS: 180000, AL: 230000, WV: 160000, ND: 260000,
  SD: 290000, ME: 380000, NH: 470000, VT: 390000, DE: 370000, MD: 420000,
  RI: 460000, AK: 380000, DC: 640000
};

// State-level wildfire risk multipliers (USDA WUI + NIFC burn probability)
const STATE_FIRE_RISK = {
  CA:1.55, NV:1.40, AZ:1.35, OR:1.30, WA:1.15, ID:1.25, MT:1.30, WY:1.15,
  UT:1.25, CO:1.30, NM:1.35, TX:1.10, OK:1.00, FL:0.95, GA:0.80, SC:0.80,
  NC:0.80, TN:0.75, AR:0.90, LA:0.75, MS:0.75, AL:0.80, KY:0.65, MO:0.80,
  KS:1.00, NE:1.00, SD:1.05, ND:0.95, MN:0.70, IA:0.60, IL:0.55, IN:0.55,
  OH:0.50, PA:0.55, NY:0.55, VT:0.55, NH:0.60, ME:0.65, MA:0.55, CT:0.55,
  RI:0.50, NJ:0.55, DE:0.55, MD:0.55, VA:0.70, WV:0.70, MI:0.55, WI:0.55,
  HI:1.20, AK:0.80, DC:0.40
};

// Biome inference from latitude, longitude and climate hints.
function inferBiome(lat, lon, humidity, tempC, elevation) {
  const absLat = Math.abs(lat);
  // Desert & chaparral (SW US)
  if (lon > -125 && lon < -103 && lat > 30 && lat < 42 && (humidity == null || humidity < 45)) {
    if (elevation != null && elevation > 1600) return 'montane_conifer';
    return 'chaparral';
  }
  // Pacific NW
  if (lon > -125 && lon < -118 && lat > 42 && lat < 50) return 'temperate_conifer';
  // Rockies / Intermountain
  if (lon > -115 && lon < -104 && lat > 36 && lat < 49) return 'montane_conifer';
  // Great Plains
  if (lon > -104 && lon < -94 && lat > 30 && lat < 49) return 'grassland';
  // Southeast pine
  if (lon > -94 && lon < -76 && lat > 25 && lat < 37) return 'southern_pine';
  // Northeast / Midwest mixed
  if (lon > -94 && lon < -65 && lat > 37 && lat < 48) return 'mixed_hardwood';
  // Tropical / sub-tropical
  if (absLat < 23) return 'tropical';
  // Boreal fallback
  if (absLat > 50) return 'boreal';
  return 'mixed_hardwood';
}

// Biome → fuel mix bias (+/- thresholds in generateScan)
const BIOME_PROFILES = {
  chaparral:          { g:0.05, s:0.20, t:-0.15, label:'Chaparral / scrub' },
  montane_conifer:    { g:-0.05, s:0.00, t:0.15, label:'Montane conifer' },
  temperate_conifer:  { g:-0.05, s:0.05, t:0.12, label:'Temperate conifer' },
  grassland:          { g:0.25, s:-0.05, t:-0.20, label:'Grassland' },
  southern_pine:      { g:0.02, s:0.08, t:0.10, label:'Southern pine' },
  mixed_hardwood:     { g:0.00, s:0.00, t:0.05, label:'Mixed hardwood' },
  tropical:           { g:0.05, s:0.15, t:0.05, label:'Tropical forest' },
  boreal:             { g:-0.05, s:-0.05, t:0.20, label:'Boreal conifer' }
};

async function fetchOpenMeteo(lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + lat + '&longitude=' + lon
    + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m'
    + '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Open-Meteo HTTP ' + res.status);
    const data = await res.json();
    const cur = data.current || {};
    return {
      tempF: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      windSpeedMph: cur.wind_speed_10m,
      windDirDeg: cur.wind_direction_10m,
      elevation: data.elevation
    };
  } catch (e) { console.warn('Open-Meteo failed:', e); return null; }
}

async function reverseGeocode(lat, lon) {
  try {
    const url = 'https://photon.komoot.io/reverse?lat=' + lat + '&lon=' + lon;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Photon reverse HTTP ' + res.status);
    const data = await res.json();
    const f = (data.features && data.features[0]) || null;
    if (!f) return null;
    const p = f.properties || {};
    return {
      state: p.state, country: p.country, countrycode: p.countrycode,
      city: p.city || p.county, name: p.name,
      postcode: p.postcode
    };
  } catch (e) { console.warn('Reverse geocode failed:', e); return null; }
}

// US state full-name -> USPS 2-letter code (Photon returns full names)
const STATE_ABBR = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
  'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
  'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS',
  'Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA',
  'Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT',
  'Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM',
  'New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK',
  'Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC',
  'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT',
  'Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY',
  'District of Columbia':'DC'
};

async function fetchLocationContext(lat, lon) {
  LOC_CONTEXT.lat = lat; LOC_CONTEXT.lon = lon;
  const [wx, geo] = await Promise.all([fetchOpenMeteo(lat, lon), reverseGeocode(lat, lon)]);

  if (geo) {
    LOC_CONTEXT.stateName = geo.state || null;
    LOC_CONTEXT.state = STATE_ABBR[geo.state] || null;
    LOC_CONTEXT.country = geo.countrycode ? geo.countrycode.toUpperCase() : (geo.country || 'US');
    LOC_CONTEXT.displayName = [geo.name, geo.city, geo.state].filter(Boolean).join(', ');
  }

  if (LOC_CONTEXT.state && STATE_HOME_VALUE[LOC_CONTEXT.state]) {
    LOC_CONTEXT.homeValueMedian = STATE_HOME_VALUE[LOC_CONTEXT.state];
  } else {
    LOC_CONTEXT.homeValueMedian = 380000; // US overall median fallback
  }

  if (LOC_CONTEXT.state && STATE_FIRE_RISK[LOC_CONTEXT.state]) {
    LOC_CONTEXT.regionalFireRisk = STATE_FIRE_RISK[LOC_CONTEXT.state];
  } else {
    LOC_CONTEXT.regionalFireRisk = 0.75;
  }

  if (wx) {
    LOC_CONTEXT.tempF = wx.tempF;
    LOC_CONTEXT.humidity = wx.humidity;
    LOC_CONTEXT.windSpeedMph = wx.windSpeedMph;
    LOC_CONTEXT.windDirDeg = wx.windDirDeg;
    LOC_CONTEXT.elevation = wx.elevation;

    // Auto-fill fire weather sliders from live conditions
    if (wx.windDirDeg != null) {
      const wd = document.getElementById('wind-dir');
      if (wd) { wd.value = Math.round(wx.windDirDeg); wd.dispatchEvent(new Event('input')); }
    }
    if (wx.windSpeedMph != null) {
      const ws = document.getElementById('wind-speed');
      if (ws) { ws.value = Math.round(Math.min(55, Math.max(3, wx.windSpeedMph))); ws.dispatchEvent(new Event('input')); }
    }
    if (wx.humidity != null) {
      // dead fuel moisture approximation from RH (simplified Nelson)
      const rh = wx.humidity;
      const fm = Math.max(2, Math.min(30, Math.round(rh * 0.28 + 1.5)));
      const mo = document.getElementById('moisture');
      if (mo) { mo.value = fm; mo.dispatchEvent(new Event('input')); }
    }
  }

  LOC_CONTEXT.biome = inferBiome(lat, lon,
    wx ? wx.humidity : null, wx ? ((wx.tempF - 32) * 5/9) : null,
    wx ? wx.elevation : null);

  const prof = BIOME_PROFILES[LOC_CONTEXT.biome] || BIOME_PROFILES.mixed_hardwood;
  LOC_CONTEXT.fuelBias = { grass: prof.g, shrub: prof.s, tree: prof.t };

  // Rebuild the parcel scan to reflect the new biome
  if (grid && parcelBounds) {
    generateScan();
    drawOverlay();
    updatePanels();
  }

  updateLocationPanel();
  return LOC_CONTEXT;
}

function updateLocationPanel() {
  const el = document.getElementById('loc-context');
  if (!el) return;
  const c = LOC_CONTEXT;
  const biomeLabel = (BIOME_PROFILES[c.biome] || {}).label || c.biome;
  const riskPct = Math.round((c.regionalFireRisk - 1) * 100);
  const riskStr = riskPct >= 0 ? '+' + riskPct + '%' : riskPct + '%';
  el.innerHTML =
    '<div><b>Region:</b> ' + (c.stateName || c.country || '—') + '</div>' +
    '<div><b>Biome:</b> ' + biomeLabel + '</div>' +
    '<div><b>Regional fire-risk index:</b> ' + c.regionalFireRisk.toFixed(2) + ' (' + riskStr + ' vs US avg)</div>' +
    '<div><b>Local median home value:</b> $' + Math.round(c.homeValueMedian/1000) + 'K</div>' +
    (c.tempF != null ? '<div><b>Live weather:</b> ' + Math.round(c.tempF) + '°F, ' + Math.round(c.humidity) + '% RH, ' + Math.round(c.windSpeedMph) + ' mph wind</div>' : '') +
    (c.elevation != null ? '<div><b>Elevation:</b> ' + Math.round(c.elevation) + ' m</div>' : '');
}

/* ---------- Property parcel rectangle ---------- */
let parcelRect = null;
let parcelHandles = [];
let parcelBounds = null;

function placeDefaultParcel(lat, lon) {
  const dLat = 0.00045;
  const dLon = 0.00055 / Math.cos(lat * Math.PI / 180);
  const b = L.latLngBounds([lat - dLat, lon - dLon], [lat + dLat, lon + dLon]);
  setParcel(b);
  ['fab-pause','fab-reset'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
  fetchLocationContext(lat, lon).then(() => {
    document.getElementById('parcel-meta').textContent =
      '~' + estimateAcres(parcelBounds).toFixed(2) + ' ac · ' +
      (LOC_CONTEXT.stateName || 'location') + ' · ' +
      ((BIOME_PROFILES[LOC_CONTEXT.biome]||{}).label || LOC_CONTEXT.biome);
  });
  document.getElementById('parcel-meta').textContent = '~' + estimateAcres(b).toFixed(2) + ' ac parcel · loading location data…';
}

function estimateAcres(bounds) {
  const latMid = (bounds.getNorth() + bounds.getSouth()) / 2;
  const mPerLat = 111000;
  const mPerLon = 111000 * Math.cos(latMid * Math.PI / 180);
  const h = Math.abs(bounds.getNorth() - bounds.getSouth()) * mPerLat;
  const w = Math.abs(bounds.getEast() - bounds.getWest()) * mPerLon;
  return (h * w) / 4047;
}

function setParcel(bounds) {
  parcelBounds = bounds;
  if (parcelRect) parcelRect.remove();
  parcelRect = L.rectangle(bounds, { className: 'property-box' }).addTo(map);

  parcelHandles.forEach(h => h.remove());
  parcelHandles = [];
  const corners = [
    { pos: bounds.getNorthWest(), type: 'nw' },
    { pos: bounds.getNorthEast(), type: 'ne' },
    { pos: bounds.getSouthWest(), type: 'sw' },
    { pos: bounds.getSouthEast(), type: 'se' }
  ];
  corners.forEach(c => {
    const handle = L.marker(c.pos, {
      draggable: true,
      icon: L.divIcon({
        className: 'corner-handle',
        html: '<div style="width:12px;height:12px;background:#ffd37a;border:2px solid #1a0e04;border-radius:3px;cursor:nwse-resize;"></div>',
        iconSize: [12,12], iconAnchor: [6,6]
      })
    }).addTo(map);
    handle.cornerType = c.type;
    handle.on('drag', (ev) => {
      const ll = ev.target.getLatLng();
      let n = parcelBounds.getNorth(), s = parcelBounds.getSouth();
      let e = parcelBounds.getEast(),  w = parcelBounds.getWest();
      if (c.type === 'nw') { n = ll.lat; w = ll.lng; }
      if (c.type === 'ne') { n = ll.lat; e = ll.lng; }
      if (c.type === 'sw') { s = ll.lat; w = ll.lng; }
      if (c.type === 'se') { s = ll.lat; e = ll.lng; }
      parcelBounds = L.latLngBounds([s, w], [n, e]);
      parcelRect.setBounds(parcelBounds);
      updateHandles();
      drawOverlay();
    });
    handle.on('dragend', () => {
      generateScan();
      drawOverlay();
      updatePanels();
      const biomeLbl = (BIOME_PROFILES[LOC_CONTEXT.biome] || {}).label || 'satellite';
      const region = LOC_CONTEXT.stateName || 'location';
      document.getElementById('parcel-meta').textContent =
        '~' + estimateAcres(parcelBounds).toFixed(2) + ' ac · ' + region + ' · ' + biomeLbl;
    });
    parcelHandles.push(handle);
  });

  // center drag handle
  const center = L.marker(bounds.getCenter(), {
    draggable: true,
    icon: L.divIcon({
      className: 'drag-handle',
      html: '<div style="width:26px;height:26px;background:rgba(255,122,26,0.9);border:2px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:14px;cursor:grab">✥</div>',
      iconSize: [26,26], iconAnchor: [13,13]
    })
  }).addTo(map);
  let dragOrigin = null, dragOriginBounds = null;
  center.on('dragstart', (ev) => {
    dragOrigin = ev.target.getLatLng();
    dragOriginBounds = parcelBounds;
  });
  center.on('drag', (ev) => {
    const ll = ev.target.getLatLng();
    const dLat = ll.lat - dragOrigin.lat;
    const dLng = ll.lng - dragOrigin.lng;
    const nb = L.latLngBounds(
      [dragOriginBounds.getSouth() + dLat, dragOriginBounds.getWest() + dLng],
      [dragOriginBounds.getNorth() + dLat, dragOriginBounds.getEast() + dLng]
    );
    parcelBounds = nb;
    parcelRect.setBounds(nb);
    updateHandles();
    drawOverlay();
  });
  center.on('dragend', () => {
    generateScan(); drawOverlay(); updatePanels();
    const c = parcelBounds.getCenter();
    // Re-fetch regional context if the parcel moved more than ~1 km
    const moved = Math.hypot(c.lat - LOC_CONTEXT.lat, c.lng - LOC_CONTEXT.lon);
    if (moved > 0.01) fetchLocationContext(c.lat, c.lng);
    else {
      const biomeLbl = (BIOME_PROFILES[LOC_CONTEXT.biome] || {}).label || 'satellite';
      const region = LOC_CONTEXT.stateName || 'location';
      document.getElementById('parcel-meta').textContent =
        '~' + estimateAcres(parcelBounds).toFixed(2) + ' ac · ' + region + ' · ' + biomeLbl;
    }
  });
  parcelHandles.push(center);

  generateScan();
  drawOverlay();
  updatePanels();
}

function updateHandles() {
  if (parcelHandles.length < 5) return;
  parcelHandles[0].setLatLng(parcelBounds.getNorthWest());
  parcelHandles[1].setLatLng(parcelBounds.getNorthEast());
  parcelHandles[2].setLatLng(parcelBounds.getSouthWest());
  parcelHandles[3].setLatLng(parcelBounds.getSouthEast());
  parcelHandles[4].setLatLng(parcelBounds.getCenter());
}

/* ---------- Canvas overlay (fuel + fire) ---------- */
const overlay = document.getElementById('overlay-canvas');
const octx = overlay.getContext('2d');
const COLS = 120, ROWS = 80;

const FUEL = {
  // Each fuel also carries a burn-color family so flames look different on
  // grass vs. canopy vs. a structure.
  // burn = [start RGB, peak RGB, ember RGB] — used by burningColor().
  NONE:   { id: 0, base: '#d9cfa4', fuel: 0.00,
            burn: [[255,235,140],[255,180,60],[180,120,50]] },       // tan cleared
  GRASS:  { id: 1, base: '#b4c56a', fuel: 0.35,
            burn: [[255,240,130],[255,170,40],[200, 80, 20]] },      // bright grass → yellow flame
  SHRUB:  { id: 2, base: '#6b8a3a', fuel: 0.65,
            burn: [[255,205, 90],[240,110, 30],[170, 40, 20]] },     // chaparral → orange flame
  TREE:   { id: 3, base: '#214d2a', fuel: 0.85,
            burn: [[255,180, 60],[220, 70, 20],[130, 20, 15]] },     // canopy → deep orange/crimson
  ROAD:   { id: 4, base: '#8b6a52', fuel: 0.00,
            burn: [[120,120,120],[90,90,90],[50,50,50]] },           // asphalt doesn't really burn
  STRUCT: { id: 5, base: '#6f94c6', fuel: 0.55,
            burn: [[255,120,200],[210, 40, 80],[120, 20, 40]] }      // homes → pink/magenta signal
};
const STATE = { UNBURNED:0, IGNITING:1, BURNING:2, BURNED:4 };

let grid = null;
let structX = 60, structY = 40;
let ignitionX = null, ignitionY = null;
let running = false, tickCount = 0, lastStructIgnitionTick = -1;
let slopeVal = 1;

function hashNoise(x,y,s=1){const n=Math.sin(x*12.9898+y*78.233+s*37.719)*43758.5453;return n-Math.floor(n);}
function smooth(x,y,scale,seed){
  const xs=x/scale,ys=y/scale,x0=Math.floor(xs),y0=Math.floor(ys),fx=xs-x0,fy=ys-y0;
  const v00=hashNoise(x0,y0,seed),v10=hashNoise(x0+1,y0,seed),v01=hashNoise(x0,y0+1,seed),v11=hashNoise(x0+1,y0+1,seed);
  const sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
  return (v00*(1-sx)+v10*sx)*(1-sy)+(v01*(1-sx)+v11*sx)*sy;
}

function generateScan(seed = Math.random()*1000) {
  grid = [];
  const bias = LOC_CONTEXT.fuelBias || {grass:0, shrub:0, tree:0};
  // Thresholds shift with biome: grasslands get more grass, conifer more tree, etc.
  const tNone  = 0.30 - Math.max(0, bias.grass) * 0.3 - Math.max(0, bias.shrub) * 0.15 - Math.max(0, bias.tree) * 0.1;
  const tGrass = 0.47 + bias.grass - Math.max(0, bias.shrub) * 0.2;
  const tShrub = 0.72 + bias.shrub - Math.max(0, bias.tree) * 0.2;
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) {
      const v = 0.55 * smooth(x, y, 10, seed + 1) + 0.35 * smooth(x, y, 3, seed + 2) + 0.10 * hashNoise(x, y, seed + 3);
      let ft;
      if (v < tNone) ft = FUEL.NONE;
      else if (v < tGrass) ft = FUEL.GRASS;
      else if (v < tShrub) ft = FUEL.SHRUB;
      else ft = FUEL.TREE;
      row.push({ fuel: ft, state: STATE.UNBURNED, burnClock: 0 });
    }
    grid.push(row);
  }
  // driveway
  const roadY = Math.floor(ROWS * 0.55);
  for (let x = 0; x < Math.floor(COLS * 0.5); x++) {
    for (let dy = -1; dy <= 1; dy++) {
      const yy = roadY + dy;
      if (yy >= 0 && yy < ROWS) grid[yy][x].fuel = FUEL.ROAD;
    }
  }
  // structure
  structX = Math.floor(COLS * 0.55);
  structY = roadY;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const xx = structX + dx, yy = structY + dy;
      if (xx>=0&&xx<COLS&&yy>=0&&yy<ROWS) grid[yy][xx].fuel = FUEL.STRUCT;
    }
  }
  // cleared halo
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const xx = structX + dx, yy = structY + dy;
      if (xx>=0&&xx<COLS&&yy>=0&&yy<ROWS) {
        const d = Math.sqrt(dx*dx+dy*dy);
        if (d > 3 && d <= 6 && grid[yy][xx].fuel !== FUEL.STRUCT) {
          if (grid[yy][xx].fuel === FUEL.TREE) grid[yy][xx].fuel = FUEL.SHRUB;
          else if (grid[yy][xx].fuel === FUEL.SHRUB && Math.random() < 0.4) grid[yy][xx].fuel = FUEL.GRASS;
        }
      }
    }
  }
  ignitionX = null; ignitionY = null;
  tickCount = 0; lastStructIgnitionTick = -1;
}

function cellColor(c) {
  if (c.state === STATE.BURNING) return burningColor(c);
  if (c.state === STATE.BURNED) {
    // Ember afterglow decays briefly
    const cool = Math.max(0, 1 - (c.burnClock - 6) * 0.05);
    const v = Math.round(22 + cool * 20);
    return 'rgb(' + v + ',' + v + ',' + (v - 4) + ')';
  }
  if (c.state === STATE.IGNITING) return '#ffe680';
  return c.fuel.base;
}


/* ---------- Smooth render state ---------- */
let renderProgress = 0; // 0..1 sub-tick interpolation between sim steps

// Draw a soft directional "likely spread" arrow on the canvas prior to ignition.
// Origin: ignition point if set, else parcel center on the grid.
function drawWindPreview(ctx) {
  const p = params();
  const dirRad = (p.windDir + 180) * Math.PI / 180;  // where the wind is blowing TO
  const ox = (ignitionX != null) ? ignitionX + 0.5 : Math.floor(COLS * 0.5);
  const oy = (ignitionY != null) ? ignitionY + 0.5 : Math.floor(ROWS * 0.5);
  const reach = 18 + p.windSpeed * 0.9; // cells
  const tipX = ox + Math.sin(dirRad) * reach;
  const tipY = oy - Math.cos(dirRad) * reach;

  // Shaded cone: radial gradient along wind axis
  const spread = 0.55; // radians half-angle
  const steps = 36;
  for (let i = steps; i > 0; i--) {
    const frac = i / steps;
    const r = reach * frac;
    const alpha = 0.035 * frac;
    ctx.fillStyle = 'rgba(232,93,0,' + (alpha * 1.4).toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    const a1 = dirRad - spread;
    const a2 = dirRad + spread;
    ctx.arc(ox, oy, r, -Math.PI/2 + a1, -Math.PI/2 + a2);
    ctx.closePath();
    ctx.fill();
  }

  // Centerline arrow
  ctx.strokeStyle = 'rgba(180,63,0,0.85)';
  ctx.lineWidth = 0.55;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  // Arrowhead
  const headLen = 2.2;
  const headAng = 0.45;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - Math.sin(dirRad - headAng) * headLen, tipY + Math.cos(dirRad - headAng) * headLen);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - Math.sin(dirRad + headAng) * headLen, tipY + Math.cos(dirRad + headAng) * headLen);
  ctx.stroke();
}

// Interpolated color for burning cells using sub-tick progress.
// Each fuel type has its own burn palette so the viewer can instantly tell
// a grass fire from a canopy crown fire from a home on fire.
function burningColor(c) {
  const t = Math.min(1, (c.burnClock + renderProgress) / 6);
  const palette = (c.fuel && c.fuel.burn) || [[255,220,90],[245,100,30],[180,45,25]];
  // 3-stop gradient: [young flame] -> [peak] -> [ember/char]
  let a, b, f;
  if (t < 0.5) { a = palette[0]; b = palette[1]; f = t / 0.5; }
  else         { a = palette[1]; b = palette[2]; f = (t - 0.5) / 0.5; }
  const r  = Math.round(a[0] + (b[0] - a[0]) * f);
  const g  = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

// Soft glow pass around burning cells on a second overlay context.
// Glow color & intensity depends on what's burning: homes get a hot pink/red
// halo, tree canopy gets a deep orange halo, grass gets a bright yellow halo.
function drawBurningGlow(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y][x];
      if (c.state !== STATE.BURNING) continue;
      const t = Math.min(1, (c.burnClock + renderProgress) / 6);
      const intensity = (1 - t * 0.55);

      // Per-fuel glow: big bright halos for canopy & structures, tighter for grass.
      let inner, outer, radiusMult;
      if (c.fuel === FUEL.STRUCT) {
        inner = 'rgba(255,120,200,'; outer = 'rgba(210,40,80,0)'; radiusMult = 1.35;
      } else if (c.fuel === FUEL.TREE) {
        inner = 'rgba(255,150,60,';  outer = 'rgba(220,70,20,0)'; radiusMult = 1.20;
      } else if (c.fuel === FUEL.SHRUB) {
        inner = 'rgba(255,190,90,';  outer = 'rgba(240,110,30,0)'; radiusMult = 1.00;
      } else {
        inner = 'rgba(255,225,110,'; outer = 'rgba(255,170,40,0)'; radiusMult = 0.85;
      }

      const radius = (2.5 + intensity * 1.8 +
        Math.sin((tickCount + renderProgress + x*0.21 + y*0.17) * 2.3) * 0.35) * radiusMult;
      const grd = ctx.createRadialGradient(x + 0.5, y + 0.5, 0, x + 0.5, y + 0.5, radius);
      grd.addColorStop(0, inner + (0.42 * intensity).toFixed(3) + ')');
      grd.addColorStop(1, outer);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(x + 0.5, y + 0.5, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawOverlay() {
  if (!grid || !parcelBounds) return;
  const nw = map.latLngToContainerPoint(parcelBounds.getNorthWest());
  const se = map.latLngToContainerPoint(parcelBounds.getSouthEast());
  const w = Math.max(10, Math.round(se.x - nw.x));
  const h = Math.max(10, Math.round(se.y - nw.y));
  overlay.style.left = nw.x + 'px';
  overlay.style.top  = nw.y + 'px';
  overlay.style.width = w + 'px';
  overlay.style.height = h + 'px';
  overlay.width = COLS;
  overlay.height = ROWS;

  octx.clearRect(0, 0, COLS, ROWS);

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y][x];
      if (c.state === STATE.UNBURNED) {
        // Distinct per-fuel paint so users can tell grass / shrub / canopy / home apart
        // even before the fire starts.
        if (c.fuel === FUEL.STRUCT) {
          // Solid home: blue-gray roof with a subtle ridge highlight
          octx.fillStyle = 'rgba(111,148,198,0.95)';
          octx.fillRect(x, y, 1, 1);
          continue;
        }
        if (c.fuel === FUEL.ROAD)   { octx.fillStyle = 'rgba(139,106,82,0.75)'; octx.fillRect(x, y, 1, 1); continue; }
        if (c.fuel === FUEL.NONE)   { octx.fillStyle = 'rgba(217,207,164,0.40)'; octx.fillRect(x, y, 1, 1); continue; }
        // Vegetation: alpha scales with fuel load so canopy reads darker/greener
        // than grass even through satellite tiles.
        const alpha = 0.45 + c.fuel.fuel * 0.40;     // 0.59 grass … 0.79 tree
        const hex = c.fuel.base;
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        octx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha.toFixed(2) + ')';
        octx.fillRect(x, y, 1, 1);
      } else {
        octx.fillStyle = cellColor(c);
        octx.fillRect(x, y, 1, 1);
      }
    }
  }

  // Home outline: warm coral so it stands out from the blue structure fill
  octx.strokeStyle = '#ff9a3d';
  octx.lineWidth = 0.9;
  octx.strokeRect(structX - 4.5, structY - 3.5, 9, 7);

  // Fire glow pass (only when cells are burning)
  if (running) drawBurningGlow(octx);

  // Pre-ignition wind preview: shows likely spread direction as a soft cone + arrow.
  // Hidden once any cell is on fire / burned, so it doesn't clutter the simulation.
  let anyActive = false;
  if (grid) {
    outer: for (let y=0; y<ROWS; y++) for (let x=0; x<COLS; x++) {
      const s = grid[y][x].state;
      if (s === STATE.BURNING || s === STATE.BURNED) { anyActive = true; break outer; }
    }
  }
  if (!anyActive) drawWindPreview(octx);

  if (ignitionX != null) {
    // Pulsing ignition marker
    const pulse = 1 + Math.sin((performance.now() / 280)) * 0.18;
    octx.fillStyle = 'rgba(255,40,40,0.9)';
    octx.beginPath();
    octx.arc(ignitionX + 0.5, ignitionY + 0.5, 1.25 * pulse, 0, Math.PI*2);
    octx.fill();
    octx.strokeStyle = 'rgba(255,200,120,0.55)';
    octx.lineWidth = 0.35;
    octx.beginPath();
    octx.arc(ignitionX + 0.5, ignitionY + 0.5, 2.4 * pulse, 0, Math.PI*2);
    octx.stroke();
  }
}
map.on('move zoom resize', drawOverlay);

overlay.classList.add('interact');
overlay.addEventListener('click', (e) => {
  if (!grid) return;
  const r = overlay.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width * COLS;
  const py = (e.clientY - r.top) / r.height * ROWS;
  const cx = Math.floor(px), cy = Math.floor(py);
  if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return;
  ignitionX = cx; ignitionY = cy;
  drawOverlay();
  setStatus('<b>Step 3.</b> Ignition point marked. Press <b>🔥 Ignite Fire</b> to simulate.');
});

/* ---------- Simulation ---------- */
function params() {
  return {
    windDir: parseInt(document.getElementById('wind-dir').value, 10),
    windSpeed: parseInt(document.getElementById('wind-speed').value, 10),
    moisture: parseInt(document.getElementById('moisture').value, 10),
    slope: slopeVal
  };
}

function spreadProb(dx, dy, fuelVal, p) {
  if (fuelVal <= 0) return 0;
  // Wind "from" direction -> "to" direction (where flames push).
  const dirRad = (p.windDir + 180) * Math.PI / 180;
  const wx = Math.sin(dirRad), wy = -Math.cos(dirRad);
  const len = Math.sqrt(dx*dx + dy*dy) || 1;
  const nx = dx / len, ny = dy / len;
  const align = nx*wx + ny*wy;                              // -1..+1, +1 = downwind
  // Wind factor: downwind strongly boosted, upwind gets a floor so cross-wind
  // backing fire still creeps. Units: wind_mph / 12 (was /20).
  const wf = 1 + Math.max(0, align) * (p.windSpeed / 12) + Math.max(0, -align) * 0.15;
  const mf = Math.max(0.20, 1 - (p.moisture - 3) / 25);
  const sf = 1 + p.slope * 0.45 * Math.max(0, align);
  // Base rate bumped 0.18 -> 0.26 so light-fuel ignitions reliably catch.
  return Math.min(0.98, 0.26 * fuelVal * wf * mf * sf);
}

function step() {
  tickCount++;
  const p = params();
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y][x];
      if (c.state === STATE.BURNING) {
        c.burnClock++;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx<0||nx>=COLS||ny<0||ny>=ROWS) continue;
            const n = grid[ny][nx];
            if (n.state !== STATE.UNBURNED) continue;
            if (Math.random() < spreadProb(dx, dy, n.fuel.fuel, p)) {
              n.state = STATE.IGNITING;
              if (n.fuel === FUEL.STRUCT && lastStructIgnitionTick < 0) lastStructIgnitionTick = tickCount;
            }
          }
        }
        const dur = (c.fuel === FUEL.TREE) ? 10 : (c.fuel === FUEL.SHRUB) ? 7 : (c.fuel === FUEL.STRUCT) ? 14 : 4;
        if (c.burnClock > dur) c.state = STATE.BURNED;
      }
    }
  }
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (grid[y][x].state === STATE.IGNITING) grid[y][x].state = STATE.BURNING;
    }
  }
}

/* ---------- Stats & risk ---------- */
function computeStats() {
  let burned = 0, total = 0, nearHomeFuel = 0, nearHomeCount = 0, structBurned = false;
  const R = 17;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y][x];
      if (c.fuel === FUEL.STRUCT && c.state === STATE.BURNED) structBurned = true;
      if (c.fuel.fuel > 0) total++;
      if (c.state === STATE.BURNED || c.state === STATE.BURNING) burned++;
      const d = Math.hypot(x - structX, y - structY);
      if (d < R) { nearHomeFuel += c.fuel.fuel; nearHomeCount++; }
    }
  }
  const dsScore = Math.round(100 * (1 - nearHomeFuel / Math.max(1, nearHomeCount)));
  const burnedPct = total ? burned / total : 0;
  const p = params();
  const pIgn = Math.max(0.02, Math.min(0.98,
    0.12 + (1 - dsScore/100) * 0.55 + (p.windSpeed/60) * 0.25 +
    ((30 - p.moisture)/30) * 0.20 + p.slope * 0.1));
  const flameLen = 1.5 + (1 - p.moisture/30) * 4 + p.windSpeed/15 + (nearHomeFuel/Math.max(1,nearHomeCount))*6;
  const ros = 2 + (p.windSpeed * 0.8) * (1 - p.moisture/40) + p.slope * 3;
  const ember = Math.round(200 + p.windSpeed * 15 * (1 - p.moisture/30));
  const tbo = lastStructIgnitionTick > 0 ? lastStructIgnitionTick : null;
  let riskLevel, riskClass;
  if (pIgn < 0.2) { riskLevel = 'Low'; riskClass = 'risk-low'; }
  else if (pIgn < 0.45) { riskLevel = 'Moderate'; riskClass = 'risk-med'; }
  else if (pIgn < 0.75) { riskLevel = 'High'; riskClass = 'risk-high'; }
  else { riskLevel = 'Extreme'; riskClass = 'risk-extreme'; }
  return { burnedPct, dsScore, pIgn, flameLen, ros, ember, tbo, structBurned, riskLevel, riskClass, nearHomeFuelAvg: nearHomeFuel/Math.max(1,nearHomeCount) };
}

function estLoss(s) {
  const acres = parcelBounds ? estimateAcres(parcelBounds) : 1.0;
  const lotFactor = 1 + Math.min(0.6, (acres - 0.25) * 0.08);
  const home = Math.round(LOC_CONTEXT.homeValueMedian * Math.max(0.75, lotFactor));
  const contents = Math.round(home * 0.25);
  const outbldg = Math.round(home * 0.06 + 5000 * Math.max(0, acres - 0.5));
  const regMult = LOC_CONTEXT.regionalFireRisk || 1.0;
  // Full structural loss
  if (s.structBurned) return home + contents + outbldg;
  // Partial damage: outbuildings, landscaping, smoke/heat damage.
  // Scales with proportion burned, flame length, and regional severity.
  // Uses sqrt of burnedPct so even a 10% burn produces a visible loss number.
  const intensity = Math.min(1, s.flameLen / 15);
  const extent = Math.sqrt(Math.max(0, s.burnedPct));
  const damage = intensity * extent * regMult;
  const landscape = Math.round(5000 * acres * damage);       // trees, irrigation, fences
  const outbldgLoss = Math.round(outbldg * damage * 0.7);    // sheds, outbuildings
  const smokeContents = Math.round(contents * 0.08 * damage);// smoke infiltration
  const homeExterior = Math.round(home * 0.05 * damage);     // siding, paint, screens
  return landscape + outbldgLoss + smokeContents + homeExterior;
}

function fmt$(n) {
  if (n >= 1000000) return '$' + (n/1000000).toFixed(2) + 'M';
  if (n >= 1000) return '$' + Math.round(n/1000) + 'K';
  return '$' + Math.round(n);
}

function updatePanels() {
  if (!grid) return;
  const s = computeStats();
  const badge = document.getElementById('risk-badge');
  badge.className = 'risk-badge ' + s.riskClass;
  badge.textContent = s.riskLevel;
  const lossVal = document.getElementById('loss-val');
  const lossSub = document.getElementById('loss-sub');
  const loss = estLoss(s);
  lossVal.textContent = loss > 0 ? fmt$(loss) : '$0';
  lossSub.textContent = s.structBurned ? 'Total loss (home + contents)' :
                        (loss > 0 ? 'Partial damage est.' : 'No damage projected');

  const txt = document.getElementById('homeowner-text');
  if (tickCount === 0 && !running) {
    txt.innerHTML = 'Under current conditions, your property is rated <strong>' + s.riskLevel + '</strong> risk. Press <strong>🔥 Ignite Fire</strong> to simulate what would happen.';
  } else if (s.structBurned) {
    txt.innerHTML = '⚠️ Your home was <strong>lost</strong> after ~<strong>' + (s.tbo*2) + ' minutes</strong> of burn-over. Flame lengths at the structure reached <strong>' + s.flameLen.toFixed(1) + ' ft</strong>. The mitigation items below could change this outcome significantly.';
  } else if (s.burnedPct > 0.05) {
    txt.innerHTML = 'Fire burned <strong>' + Math.round(s.burnedPct*100) + '%</strong> of your parcel; your home survived. Ember cast reached ~<strong>' + s.ember + ' ft</strong> — vents, gutters, and Zone 0 still matter.';
  } else {
    txt.innerHTML = 'Minimal fire progression. Defensible-space score: <strong>' + s.dsScore + '/100</strong>. Consider the goat program for the shrub zones crews skip.';
  }

  document.getElementById('m-pign').textContent = Math.round(s.pIgn * 100) + '%';
  document.getElementById('m-flame').textContent = s.flameLen.toFixed(1) + ' ft';
  document.getElementById('m-ros').textContent = s.ros.toFixed(1) + ' ch/hr';
  document.getElementById('m-ds').textContent = s.dsScore;
  document.getElementById('m-ember').textContent = s.ember + ' ft';
  document.getElementById('m-tbo').textContent = s.tbo ? (s.tbo*2) + ' min' : '—';

  const ul = document.getElementById('mitigation-list');
  ul.innerHTML = '';
  const recs = [];
  if (s.dsScore < 60) recs.push({ t:'Expand Zone 2 defensible space', d:'Thin trees and remove ladder fuels within 30–100 ft of the home. Current score is '+s.dsScore+'/100.', i:'HIGH IMPACT · −25% ignition risk' });
  if (s.nearHomeFuelAvg > 0.5) recs.push({ t:'Harden the home envelope', d:'Upgrade to ember-resistant vents (1/8" mesh), enclosed eaves, Class A roof covering.', i:'HIGH IMPACT · biggest SFR loss driver' });
  recs.push({ t:'Noncombustible Zone 0 (first 5 ft)', d:'Gravel, pavers, or concrete immediately around the home. No wood mulch, no wood fencing attached to siding.', i:'MEDIUM IMPACT · proven ember defense' });
  recs.push({ t:'Clean gutters & roof valleys', d:'Remove needles and leaf litter each spring and mid-summer.', i:'LOW COST · year-round' });
  if (s.ros > 10) recs.push({ t:'Pre-position water & evacuation plan', d:'ROS modeled at '+s.ros.toFixed(1)+' ch/hr — short evac window. Know two routes out.', i:'SAFETY · non-negotiable' });
  recs.forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = '<div class="title">'+r.t+'</div><div class="body">'+r.d+'</div><div class="impact">'+r.i+'</div>';
    ul.appendChild(li);
  });

  let grazeCells = 0;
  const grazeR = 34;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const d = Math.hypot(x - structX, y - structY);
      if (d < grazeR) {
        const ft = grid[y][x].fuel;
        if (ft === FUEL.SHRUB || ft === FUEL.GRASS) grazeCells++;
      }
    }
  }
  const acres = (grazeCells * 1.44) / 4047;
  const reductionPct = 60 + Math.min(20, Math.round(acres * 6));
  const cost = Math.round(acres * 900 / 50) * 50;
  const pignAfter = Math.max(0.03, s.pIgn * (1 - reductionPct/100 * 0.45));
  const delta = Math.round((s.pIgn - pignAfter) * 100);
  document.getElementById('goat-acres').textContent = acres.toFixed(1);
  document.getElementById('goat-reduce').textContent = reductionPct + '%';
  document.getElementById('goat-cost').textContent = fmt$(Math.max(400, cost));
  document.getElementById('goat-risk-delta').textContent = '−' + delta + ' pp ignition risk';
}

/* ---------- Controls ---------- */
document.getElementById('wind-dir').addEventListener('input', e => {
  const d = parseInt(e.target.value, 10);
  const labels = ['N','NE','E','SE','S','SW','W','NW'];
  const fromCard = labels[Math.round(d/45) % 8];
  const toCard   = labels[Math.round(((d + 180) % 360)/45) % 8];
  // Wind direction is the direction it's coming FROM (meteorological convention).
  // Label shows both the origin and where the fire will push.
  document.getElementById('wind-dir-lbl').textContent =
    'From ' + fromCard + ' \u2192 blowing ' + toCard + ' (' + d + '\u00B0)';
  // Needle points in the direction the wind is BLOWING TO, which is also where
  // the fire will spread. That's what a homeowner actually cares about.
  const blowTo = (d + 180) % 360;
  document.getElementById('compass-needle').style.transform =
    'translate(-50%, -100%) rotate(' + blowTo + 'deg)';
  updatePanels();
});
document.getElementById('wind-speed').addEventListener('input', e => {
  document.getElementById('wind-speed-lbl').textContent = e.target.value + ' mph';
  updatePanels();
});
document.getElementById('moisture').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  const label = v < 7 ? 'Very dry' : v < 12 ? 'Dry' : v < 20 ? 'Moderate' : 'Damp';
  document.getElementById('moisture-lbl').textContent = v + '% (' + label + ')';
  updatePanels();
});
document.querySelectorAll('#slope-pick button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#slope-pick button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    slopeVal = parseInt(b.dataset.v, 10);
    document.getElementById('slope-lbl').textContent = b.textContent;
    updatePanels();
  });
});
document.getElementById('adv-toggle').addEventListener('click', () => {
  document.getElementById('adv-panel').classList.toggle('open');
  const t = document.getElementById('adv-toggle');
  t.textContent = t.textContent.indexOf('▸') === 0 ? '▾ Advanced (data sources)' : '▸ Advanced (data sources)';
});

document.getElementById('view-home').addEventListener('click', () => {
  document.body.classList.remove('view-pro'); document.body.classList.add('view-homeowner');
  document.getElementById('view-home').classList.add('active');
  document.getElementById('view-pro').classList.remove('active');
});
document.getElementById('view-pro').addEventListener('click', () => {
  document.body.classList.remove('view-homeowner'); document.body.classList.add('view-pro');
  document.getElementById('view-pro').classList.add('active');
  document.getElementById('view-home').classList.remove('active');
});

// Pick the closest cell with flammable fuel to (sx,sy). Used so clicks on roads
// or the structure still produce a sensible ignition point instead of a dead click.
function nearestFlammable(sx, sy) {
  let best = null, bestD = Infinity;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = grid[y][x];
      if (!c || !c.fuel || c.fuel.fuel <= 0) continue;
      const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best;
}

// Default ignition: on the upwind edge of the parcel so the fire runs across
// the property and the user actually sees spread (not a dead-end at the corner).
function defaultIgnition() {
  const p = params();
  // Wind direction is "from" — upwind origin is on that side.
  const rad = p.windDir * Math.PI / 180;
  const offX = Math.sin(rad), offY = -Math.cos(rad);
  const cx = Math.floor(COLS * 0.5 + offX * COLS * 0.38);
  const cy = Math.floor(ROWS * 0.5 + offY * ROWS * 0.38);
  const snap = nearestFlammable(cx, cy);
  return snap || [Math.floor(COLS * 0.2), Math.floor(ROWS * 0.5)];
}

// Light a small cluster around (ox, oy) so fires reliably catch. Anchor
// cell is always ignited; neighbors within radius ignite only if flammable.
function igniteCluster(ox, oy, radius) {
  if (!grid) return;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = ox + dx, y = oy + dy;
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
      if (dx*dx + dy*dy > radius*radius) continue;
      const cell = grid[y][x];
      if (!cell || !cell.fuel) continue;
      // Always light the anchor; for neighbors require flammable fuel.
      if ((dx === 0 && dy === 0) || cell.fuel.fuel > 0) {
        cell.state = STATE.BURNING;
        cell.burnClock = 0;
      }
    }
  }
}

// One-click Ignite: works from any state. No prior map-click required.
// If no parcel exists yet, drops one on the current map center so the demo
// never dead-ends on "search first."
document.getElementById('fab-ignite').addEventListener('click', () => {
  const igniteBtn = document.getElementById('fab-ignite');

  // Already burning or finished? Treat the click as "restart" — clear + relight.
  if (running || (grid && gridHasBurning())) {
    resetSim(/*silent=*/true);
  }

  // No parcel yet? Drop one on whatever the user is looking at.
  if (!grid) {
    const center = (typeof map !== 'undefined' && map && map.getCenter) ? map.getCenter() : null;
    if (center) {
      placeDefaultParcel(center.lat, center.lng);
    } else {
      setStatus('Map not ready yet — give it a moment and try again.');
      return;
    }
  }
  if (!grid) {
    setStatus('Could not place a parcel. Try searching an address above.');
    return;
  }

  // Always auto-pick ignition on the upwind edge; snap off roads/homes.
  if (ignitionX == null) {
    const ig = defaultIgnition();
    ignitionX = ig[0]; ignitionY = ig[1];
  } else {
    const c0 = grid[ignitionY][ignitionX];
    if (!c0 || !c0.fuel || c0.fuel.fuel <= 0) {
      const snap = nearestFlammable(ignitionX, ignitionY);
      if (snap) { ignitionX = snap[0]; ignitionY = snap[1]; }
    }
  }
  const c = grid[ignitionY][ignitionX];
  if (!c || !c.fuel || c.fuel.fuel <= 0) {
    setStatus('This parcel has no flammable fuel (all road/cleared). Move the parcel onto brush or trees and try again.');
    return;
  }

  // Ignite a small cluster (radius 2 = ~13 cells) so a bad RNG roll on
  // one seed doesn't let the fire die instantly. Skip roads/homes/cleared.
  igniteCluster(ignitionX, ignitionY, 2);
  running = true;
  document.body.classList.add('simulating');
  lastFrame = 0; accum = 0;
  const pauseBtn = document.getElementById('fab-pause');
  const resetBtn = document.getElementById('fab-reset');
  if (pauseBtn) { pauseBtn.disabled = false; pauseBtn.innerHTML = '⏸ Pause'; }
  if (resetBtn) resetBtn.disabled = false;
  igniteBtn.innerHTML = '🔄 Restart';
  setStatus('<b>🔥 Fire is spreading.</b> Flames propagate across your parcel — watch Risk Level + Est. Loss update live.');
  drawOverlay();
  loop();
});

function gridHasBurning() {
  if (!grid) return false;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (grid[y][x].state === STATE.BURNING) return true;
  }
  return false;
}

function resetSim(silent) {
  running = false;
  if (grid) for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    grid[y][x].state = STATE.UNBURNED; grid[y][x].burnClock = 0;
  }
  ignitionX = null; ignitionY = null;
  tickCount = 0; lastStructIgnitionTick = -1;
  document.body.classList.remove('simulating');
  const pauseBtn = document.getElementById('fab-pause');
  if (pauseBtn) pauseBtn.innerHTML = '⏸ Pause';
  const igniteBtn = document.getElementById('fab-ignite');
  if (igniteBtn) igniteBtn.innerHTML = '🔥 Ignite Fire';
  if (!silent) setStatus('Simulation reset. Press <b>🔥 Ignite Fire</b> to run again.');
  drawOverlay();
  updatePanels();
  requestAnimationFrame(idleLoop);
}

document.getElementById('fab-pause').addEventListener('click', () => {
  running = !running;
  document.getElementById('fab-pause').innerHTML = running ? '⏸ Pause' : '▶ Resume';
  if (running) loop();
});

document.getElementById('fab-reset').addEventListener('click', () => { resetSim(false); });

/* ---------- Loop ---------- */
let lastFrame = 0, accum = 0;
const TICK_MS = 120;
function loop(ts) {
  if (!running) {
    drawOverlay();
    requestAnimationFrame(idleLoop);
    return;
  }
  if (!ts) ts = performance.now();
  if (!lastFrame) lastFrame = ts;
  const dt = ts - lastFrame; lastFrame = ts; accum += dt;
  while (accum >= TICK_MS) { step(); accum -= TICK_MS; }
  renderProgress = Math.min(1, accum / TICK_MS);
  drawOverlay();
  if ((tickCount & 1) === 0) updatePanels();
  let any = false;
  for (let y = 0; y < ROWS && !any; y++) {
    for (let x = 0; x < COLS; x++) {
      if (grid[y][x].state === STATE.BURNING) { any = true; break; }
    }
  }
  if (!any && tickCount > 25) {
    running = false;
    document.body.classList.remove('simulating');
    const pb = document.getElementById('fab-pause');
    if (pb) pb.innerHTML = '\u25B6 Resume';
    const ib = document.getElementById('fab-ignite');
    if (ib) ib.innerHTML = '\uD83D\uDD04 Run Again';
    setStatus('<b>Simulation complete.</b> Review your risk level, estimated loss, and mitigation options \u2192');
    updatePanels();
    requestAnimationFrame(idleLoop);
    return;
  }
  requestAnimationFrame(loop);
}

// Idle animation driver: keeps the wind preview + ignition pulse alive
// while the simulation isn't running.
function idleLoop() {
  if (running) return;
  drawOverlay();
  requestAnimationFrame(idleLoop);
}

/* ---------- Init ---------- */
document.getElementById('wind-dir').dispatchEvent(new Event('input'));
document.getElementById('wind-speed').dispatchEvent(new Event('input'));
document.getElementById('moisture').dispatchEvent(new Event('input'));
setStatus('<b>Step 1.</b> Type an address above, or click Center and place parcel to use the map center.');
requestAnimationFrame(idleLoop);
