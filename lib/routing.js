// Routing proxy: FOSSGIS Valhalla (exclude_polygons verified working) with
// OSRM public demo as plain-route fallback. Both are community services:
// real User-Agent, ~1 req/s, OSM attribution shown in the app.
const turf = require('@turf/turf');

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const UA = 'MercuriL-prototype/0.1 (UNSW student project; flood road-safety demo)';

const BUFFER_M = 300; // exclusion square half-side around a flooded sensor
const HAZARD_M = 120; // "route passes through flood" detection distance

// --- polyline6 decode (Valhalla shape) ---
function decodePolyline6(str) {
  let index = 0, lat = 0, lon = 0;
  const coords = [];
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

function squareAround(lon, lat, halfSideM) {
  const dLat = halfSideM / 111_320;
  const dLon = halfSideM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ];
}

// Serialize + gap external routing calls (1 req/s community policy).
let chain = Promise.resolve();
function throttled(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(
    () => new Promise((r) => setTimeout(r, 1000)),
    () => new Promise((r) => setTimeout(r, 1000))
  );
  return p;
}

async function valhallaRoute(from, to, excludePolygons) {
  const body = {
    locations: [
      { lon: from[0], lat: from[1] },
      { lon: to[0], lat: to[1] },
    ],
    costing: 'auto',
    units: 'kilometers',
  };
  if (excludePolygons && excludePolygons.length) body.exclude_polygons = excludePolygons;
  const resp = await throttled(() =>
    fetch(VALHALLA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
    })
  );
  if (!resp.ok) throw new Error(`Valhalla HTTP ${resp.status}`);
  const data = await resp.json();
  const leg = data.trip?.legs?.[0];
  if (!leg) throw new Error('Valhalla: no route');
  return {
    engine: 'valhalla',
    coords: decodePolyline6(leg.shape),
    distanceKm: data.trip.summary.length,
    durationMin: data.trip.summary.time / 60,
  };
}

async function osrmRoute(from, to) {
  const url = `${OSRM}/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`;
  const resp = await throttled(() => fetch(url, { headers: { 'User-Agent': UA } }));
  if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
  const data = await resp.json();
  const r = data.routes?.[0];
  if (!r) throw new Error('OSRM: no route');
  return {
    engine: 'osrm',
    coords: r.geometry.coordinates,
    distanceKm: r.distance / 1000,
    durationMin: r.duration / 60,
  };
}

async function plainRoute(from, to) {
  try {
    return await valhallaRoute(from, to, null);
  } catch (e) {
    console.error('valhalla failed, falling back to OSRM:', e.message);
    return await osrmRoute(from, to);
  }
}

// Flooded sensors the given line passes through (within HAZARD_M).
function hazardsOnRoute(coords, floodedSensors) {
  if (coords.length < 2) return [];
  const line = turf.lineString(coords);
  return floodedSensors.filter((s) => {
    const d = turf.pointToLineDistance(turf.point([s.lon, s.lat]), line, { units: 'meters' });
    return d <= HAZARD_M;
  });
}

// Cache keyed on od-pair + mode + flooded fingerprint (state changes bust it).
const cache = new Map();
const CACHE_MAX = 200;

async function route(from, to, mode, floodedSensors) {
  const fp = floodedSensors
    .map((s) => `${s.id}@${s.lon.toFixed(5)},${s.lat.toFixed(5)}`)
    .sort()
    .join(',');
  const key = `${from}|${to}|${mode}|${fp}`;
  if (cache.has(key)) return cache.get(key);

  const baseline = await plainRoute(from, to);
  const hazards = hazardsOnRoute(baseline.coords, floodedSensors);

  let result;
  if (mode === 'mercuril' && hazards.length) {
    let detour = null;
    try {
      const polys = floodedSensors.map((s) => squareAround(s.lon, s.lat, BUFFER_M));
      detour = await valhallaRoute(from, to, polys);
    } catch (e) {
      console.error('avoidance routing failed:', e.message);
    }
    result = detour
      ? {
          mode,
          engine: detour.engine,
          coords: detour.coords,
          distanceKm: detour.distanceKm,
          durationMin: detour.durationMin,
          avoided: hazards,
          extraMin: Math.max(0, detour.durationMin - baseline.durationMin),
          baseline: { coords: baseline.coords, durationMin: baseline.durationMin },
        }
      : { mode, ...baseline, avoided: [], hazards, avoidanceUnavailable: true };
  } else if (mode === 'mercuril') {
    result = { mode, ...baseline, avoided: [] };
  } else {
    result = { mode, ...baseline, hazards };
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

module.exports = { route };
