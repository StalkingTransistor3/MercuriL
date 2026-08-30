/* global maplibregl, googleishStyle */
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------
  const state = {
    mode: 'today', // 'today' | 'mercuril'
    from: null, // { lon, lat, label }
    to: null,
    sensors: [], // last fetched sensor features
    sensorsFp: '',
    route: null, // last route response
    pulse: 0,
  };

  const NSW_CENTER = [151.5, -32.5];
  const PITCH = {
    from: { lon: 153.047, lat: -28.86, label: 'Casino NSW' },
    to: { lon: 153.43, lat: -29.112, label: 'Evans Head NSW' },
  };

  // Dungog Shire proposed pilot network. Bounds are deliberately the sensor
  // extent plus a small margin, not the LGA boundary — the argument the frame
  // has to make is six points across three catchments against one gauge north
  // of town, and a whole-shire frame shrinks the pins to nothing.
  const DUNGOG = {
    bounds: [
      [151.49, -32.57], // SW
      [151.82, -32.34], // NE
    ],
  };

  // ---------- map ----------
  let map;
  const EMPTY = { type: 'FeatureCollection', features: [] };

  async function initMap() {
    let style = 'https://tiles.openfreemap.org/styles/liberty'; // fallback: stock style
    try {
      style = await googleishStyle();
    } catch (e) {
      console.error('style recolor failed, using stock liberty', e);
    }
    map = new maplibregl.Map({
      container: 'map',
      style,
      center: NSW_CENTER,
      zoom: 6,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    map.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
      'bottom-right'
    );
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('load', addLayers);
  }

  // mercuril.com palette. Kept in sync with :root in ui.css — these are the
  // map-drawn equivalents of the same tokens (MapLibre's colour parser predates
  // the space-separated hsl() syntax the stylesheet uses, so hex here).
  const C = {
    ground: '#212c3b',
    cream: '#f3efe8',
    creamDim: '#a9a396',
    brass: '#e0b45c',
    brassDim: '#a3813a',
    jade: '#5dac8f',
    danger: '#d74242',
    slate: '#7d8899',
    slateDim: '#5b6675',
  };

  function addLayers() {
    // --- government closures (real data), clustered slate dots ---
    map.addSource('closures', { type: 'geojson', data: EMPTY, cluster: true, clusterRadius: 40, clusterMaxZoom: 10 });
    map.addLayer({
      id: 'closures-cluster',
      type: 'circle',
      source: 'closures',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': C.slateDim,
        'circle-opacity': 0.85,
        'circle-radius': ['step', ['get', 'point_count'], 10, 25, 14, 100, 18],
      },
    });
    map.addLayer({
      id: 'closures-cluster-count',
      type: 'symbol',
      source: 'closures',
      filter: ['has', 'point_count'],
      layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 10, 'text-font': ['Noto Sans Regular'] },
      paint: { 'text-color': C.cream },
    });
    // Colour carries the data-quality verdict, not the closure type. Amber =
    // the record contradicts itself; pale = open-ended, never closed out;
    // solid = has a real end date. Clicking any dot explains which and why.
    map.addLayer({
      id: 'closures-pt',
      type: 'circle',
      source: 'closures',
      filter: ['!', ['has', 'point_count']],
      paint: {
        // On the slate basemap the legibility ramp inverts: the trustworthy
        // record (has an end date) is now the brightest, and the abandoned one
        // recedes into the ground. Same verdict, same ordering, dark-side.
        'circle-color': [
          'match', ['get', 'provenance'],
          'dated', C.slate,
          'abandoned', '#46515f',
          /* open_ended */ '#67717f',
        ],
        'circle-radius': ['match', ['get', 'provenance'], 'dated', 5.5, 4],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': C.ground,
        'circle-opacity': ['match', ['get', 'provenance'], 'abandoned', 0.7, 0.95],
      },
    });

    // --- route lines ---
    map.addSource('baseline', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'baseline-line',
      type: 'line',
      source: 'baseline',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.slate, 'line-width': 4, 'line-dasharray': [1, 2], 'line-opacity': 0.75 },
    });
    map.addSource('route', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      // Cream core on a brass casing. The landing page's --primary is cream,
      // not a chromatic accent, so the route reads as the brand's own line.
      paint: { 'line-color': C.brassDim, 'line-width': 9, 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.cream, 'line-width': 5.5 },
    });

    // --- sensors ---
    map.addSource('sensors', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'sensor-halo',
      type: 'circle',
      source: 'sensors',
      filter: ['==', ['get', 'state'], 'flooded'],
      paint: { 'circle-color': C.danger, 'circle-opacity': 0.28, 'circle-radius': 14 },
    });
    map.addLayer({
      id: 'sensor-pt',
      type: 'circle',
      source: 'sensors',
      paint: {
        'circle-color': ['case', ['==', ['get', 'state'], 'flooded'], C.danger, C.jade],
        'circle-radius': ['case', ['==', ['get', 'state'], 'flooded'], 9, 6.5],
        'circle-stroke-width': 2,
        'circle-stroke-color': C.cream,
      },
    });

    map.on('moveend', refreshClosures);
    map.on('click', 'sensor-pt', onSensorClick);
    map.on('click', 'closures-pt', onClosureClick);
    for (const l of ['sensor-pt', 'closures-pt'])
      map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
    for (const l of ['sensor-pt', 'closures-pt'])
      map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));

    refreshClosures();
    pollSensors();
    setInterval(pollSensors, 5000);
    animatePulse();
    applyMode();
    runScenario();
  }

  // ---------- data ----------
  let closureTimer;
  function refreshClosures() {
    clearTimeout(closureTimer);
    closureTimer = setTimeout(async () => {
      if (map.getZoom() < 6.5) return;
      const b = map.getBounds();
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(4)).join(',');
      try {
        const data = await (await fetch(`/api/closures?bbox=${bbox}&active=1`)).json();
        if (data.features) map.getSource('closures').setData(data);
      } catch (_) {}
    }, 250);
  }

  async function pollSensors() {
    try {
      const data = await (await fetch('/api/sensors')).json();
      if (!data.features) return;
      state.sensors = data.features;
      map.getSource('sensors')?.setData(data);
      const fp = data.features
        .map((f) => `${f.properties.id}:${f.properties.state}:${f.geometry.coordinates.join(',')}`)
        .join('|');
      if (fp !== state.sensorsFp) {
        state.sensorsFp = fp;
        if (state.from && state.to) fetchRoute(); // live re-route when a sensor floods
      }
    } catch (_) {}
  }

  // ---------- official-feed integrity numbers ----------
  // Statewide, straight out of the government's own records. Rendered live so
  // the claim on stage and the claim on the site can never disagree.
  async function loadFeedStats() {
    try {
      const s = await (await fetch('/api/closures/stats')).json();
      if (typeof s?.listed !== 'number') return;
      $('fsListed').textContent = s.listed.toLocaleString();
      $('fsVerified').textContent = s.dated.toLocaleString();
      $('feedstat').classList.remove('hidden');

      $('abListed').textContent = s.listed.toLocaleString();
      $('abDated').textContent = s.dated.toLocaleString();
      $('abOpenEnded').textContent = s.open_ended.toLocaleString();
      $('abAbandoned').textContent = s.abandoned.toLocaleString();
      $('abRecent').textContent = s.started_last_7d.toLocaleString();
      if (s.oldest_start) $('abOldest').textContent = fmtDate(s.oldest_start);
      if (s.furthest_end) $('abFurthest').textContent = fmtDate(s.furthest_end);
      if (s.last_sync) $('abSync').textContent = new Date(s.last_sync).toLocaleString('en-AU');
    } catch (_) {}
  }

  function animatePulse() {
    state.pulse += 0.05;
    const r = 14 + Math.sin(state.pulse) * 6;
    const o = 0.28 + Math.sin(state.pulse) * 0.12;
    if (map.getLayer('sensor-halo')) {
      map.setPaintProperty('sensor-halo', 'circle-radius', Math.max(10, r));
      map.setPaintProperty('sensor-halo', 'circle-opacity', Math.max(0.12, o));
    }
    requestAnimationFrame(animatePulse);
  }

  // ---------- mode ----------
  function applyMode() {
    const merc = state.mode === 'mercuril';
    $('btnToday').classList.toggle('on', !merc);
    $('btnMerc').classList.toggle('on', merc);
    for (const l of ['sensor-pt', 'sensor-halo'])
      if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', merc ? 'visible' : 'none');
    if (state.from && state.to) fetchRoute();
    else renderAlerts(null);
  }
  $('btnToday').onclick = () => { state.mode = 'today'; applyMode(); };
  $('btnMerc').onclick = () => { state.mode = 'mercuril'; applyMode(); };

  // ---------- routing ----------
  let routeSeq = 0;
  async function fetchRoute() {
    const seq = ++routeSeq;
    const { from, to } = state;
    try {
      const url = `/api/route?from=${from.lon},${from.lat}&to=${to.lon},${to.lat}&mode=${state.mode}`;
      const data = await (await fetch(url)).json();
      if (seq !== routeSeq || !data.ok) return;
      state.route = data;
      drawRoute(data);
      renderRouteCard(data);
      renderAlerts(data);
    } catch (_) {}
  }

  function drawRoute(r) {
    const line = (coords) => ({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
    });
    map.getSource('route').setData(line(r.coords));
    map.getSource('baseline').setData(r.baseline ? line(r.baseline.coords) : EMPTY);
    fitTo(r.coords);
    setMarkers();
  }

  let fromMarker, toMarker;
  function setMarkers() {
    fromMarker?.remove();
    toMarker?.remove();
    if (state.from)
      fromMarker = new maplibregl.Marker({ color: C.slate, scale: 0.8 })
        .setLngLat([state.from.lon, state.from.lat])
        .addTo(map);
    if (state.to)
      toMarker = new maplibregl.Marker({ color: C.brass })
        .setLngLat([state.to.lon, state.to.lat])
        .addTo(map);
  }

  function fitTo(coords) {
    if (!coords?.length) return;
    let w = 180, s = 90, e = -180, n = -90;
    for (const [lon, lat] of coords) {
      w = Math.min(w, lon); e = Math.max(e, lon);
      s = Math.min(s, lat); n = Math.max(n, lat);
    }
    map.fitBounds([[w, s], [e, n]], { padding: { top: 90, bottom: 120, left: 60, right: 60 }, duration: 900 });
  }

  function fmtDur(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h ? `${h} hr ${m} min` : `${m} min`;
  }

  function renderRouteCard(r) {
    $('routecard').classList.remove('hidden');
    $('rcTime').textContent = fmtDur(r.durationMin);
    $('rcSub').textContent = `${r.distanceKm.toFixed(1)} km · ${state.from.label} → ${state.to.label}`;
    const note = $('rcNote');
    if (state.mode === 'mercuril' && r.avoided?.length) {
      note.textContent = `Rerouted around ${r.avoided.length} flooded crossing${r.avoided.length > 1 ? 's' : ''} (+${Math.round(r.extraMin)} min)`;
    } else if (state.mode === 'today' && r.hazards?.length) {
      note.textContent = '';
    } else {
      note.textContent = '';
    }
  }

  function renderAlerts(r) {
    const danger = $('alertDanger');
    const ghost = $('alertGhost');
    danger.classList.remove('show');
    ghost.classList.remove('show');
    if (!r) return;
    if (state.mode === 'mercuril' && r.avoided?.length) {
      const s = r.avoided[0];
      $('adTitle').textContent = '⚠ Flooded crossing ahead — rerouted';
      $('adBody').innerHTML = `<b>${s.name}</b> is under <b>${Number(s.depth_m).toFixed(2)} m</b> of water. MercuriL detected it and closed the road in your app.`;
      $('adSub').textContent = `New route adds ${Math.round(r.extraMin)} min. No one has to guess.`;
      danger.classList.add('show');
    } else if (state.mode === 'mercuril' && r.avoidanceUnavailable) {
      $('adTitle').textContent = '⚠ Flooded crossing on this route';
      $('adBody').textContent = 'Live rerouting is temporarily unavailable — the crossing is flagged on the map.';
      $('adSub').textContent = '';
      danger.classList.add('show');
    } else if (state.mode === 'today' && r.hazards?.length) {
      const s = r.hazards[0];
      $('agTitle').textContent = 'This is the route your map gives you today.';
      $('agBody').innerHTML = `It crosses <b>${s.name}</b> — right now under ${Number(s.depth_m).toFixed(2)} m of water. The official feed has no sensor there, so the map shows the road as open.`;
      ghost.classList.add('show');
    }
  }

  // ---------- popups ----------
  function sparkline(readings) {
    if (!readings?.length) return '';
    const w = 180, h = 36, max = Math.max(0.4, ...readings.map((r) => r.depth_m));
    const pts = readings
      .map((r, i) => `${((i / Math.max(1, readings.length - 1)) * w).toFixed(1)},${(h - (r.depth_m / max) * h).toFixed(1)}`)
      .join(' ');
    return `<svg class="pp-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${C.brass}" stroke-width="2"/></svg>`;
  }

  function onSensorClick(e) {
    const f = e.features[0];
    const p = f.properties;
    const readings = typeof p.readings === 'string' ? JSON.parse(p.readings) : p.readings || [];
    const flooded = p.state === 'flooded';
    new maplibregl.Popup({ offset: 12 })
      .setLngLat(f.geometry.coordinates)
      .setHTML(
        `<div class="pp-name">${p.name}</div>
         <div class="pp-state ${p.state}">${flooded ? `WATER OVER ROAD — ${Number(p.depth_m).toFixed(2)} m` : 'Road clear'}</div>
         <div class="pp-meta">Live reading · battery ${p.battery_pct}%</div>
         ${sparkline(readings)}`
      )
      .addTo(map);
  }

  const DAY_MS = 86400000;
  const fmtDate = (v) =>
    new Date(v).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

  // The record's own paperwork, read back to whoever clicks it. Every line is
  // the government's data or a date subtraction — no interpretation, nothing
  // that needs defending in a Q&A.
  function provenanceNote(p) {
    const started = p.from ? new Date(p.from) : null;
    const days = started ? Math.floor((Date.now() - started.getTime()) / DAY_MS) : null;
    const reported = started
      ? `First reported ${fmtDate(p.from)}${days > 0 ? ` · ${days.toLocaleString()} days ago` : ''}`
      : 'No start date recorded';

    if (p.provenance === 'abandoned') {
      return `<div class="cl-flag warn">⚠ No end date, and over a year old. Still listed as in force.</div>
              <div class="cl-age">${reported}</div>`;
    }
    if (p.provenance === 'open_ended') {
      return `<div class="cl-flag warn">⚠ No end date recorded.</div>
              <div class="cl-age">${reported}</div>`;
    }
    return `<div class="cl-flag ok">✓ Has an end date — ${fmtDate(p.to)}</div>
            <div class="cl-age">${reported}</div>`;
  }

  function onClosureClick(e) {
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset: 10, maxWidth: '290px' })
      .setLngLat(e.features[0].geometry.coordinates)
      .setHTML(
        `<div class="cl-cat">${p.category || 'Closure'} · official feed</div>
         <div class="cl-desc">${p.description || p.type || ''}</div>
         <div class="cl-street">${p.street || ''}</div>
         ${provenanceNote(p)}`
      )
      .addTo(map);
  }

  // ---------- search / autocomplete ----------
  function attachAutocomplete(input, onPick) {
    let timer, items = [], active = -1;
    const box = $('suggest');

    function close() { box.classList.add('hidden'); box.innerHTML = ''; items = []; active = -1; }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(async () => {
        try {
          const data = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}`)).json();
          items = data.results || [];
          if (!items.length) return close();
          box.innerHTML = items
            .map(
              (r, i) => `<div class="sg-item" data-i="${i}">
                <svg class="sg-pin" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>
                <div><div class="sg-name">${r.name || r.label}</div><div class="sg-label">${r.label}</div></div>
              </div>`
            )
            .join('');
          box.classList.remove('hidden');
          box.querySelectorAll('.sg-item').forEach((el) => {
            el.onmousedown = (ev) => { ev.preventDefault(); pick(Number(el.dataset.i)); };
          });
        } catch (_) { close(); }
      }, 300);
    });

    function pick(i) {
      const r = items[i];
      if (!r) return;
      input.value = r.label;
      close();
      onPick(r);
    }

    input.addEventListener('keydown', (ev) => {
      if (box.classList.contains('hidden')) return;
      const els = box.querySelectorAll('.sg-item');
      if (ev.key === 'ArrowDown') { active = Math.min(active + 1, els.length - 1); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { active = Math.max(active - 1, 0); ev.preventDefault(); }
      else if (ev.key === 'Enter') { pick(active >= 0 ? active : 0); ev.preventDefault(); return; }
      else if (ev.key === 'Escape') return close();
      els.forEach((el, i) => el.classList.toggle('active', i === active));
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  attachAutocomplete($('searchInput'), (r) => {
    map.flyTo({ center: [r.lon, r.lat], zoom: 12.5, duration: 1200 });
    state.to = { lon: r.lon, lat: r.lat, label: r.label };
    setMarkers();
  });
  attachAutocomplete($('fromInput'), (r) => {
    state.from = { lon: r.lon, lat: r.lat, label: r.label };
    if (state.to) fetchRoute();
  });
  attachAutocomplete($('toInput'), (r) => {
    state.to = { lon: r.lon, lat: r.lat, label: r.label };
    if (state.from) fetchRoute();
  });

  // ---------- directions UI ----------
  $('dirBtn').onclick = () => {
    $('dirbox').classList.remove('hidden');
    $('searchbox').classList.add('hidden');
    if (state.to) $('toInput').value = state.to.label;
    $('fromInput').focus();
  };
  $('swapBtn').onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    const a = $('fromInput').value;
    $('fromInput').value = $('toInput').value;
    $('toInput').value = a;
    if (state.from && state.to) fetchRoute();
  };

  // ---------- about ----------
  const openAbout = () => { $('about').classList.remove('hidden'); $('scrim').classList.remove('hidden'); };
  $('menuBtn').onclick = openAbout;
  $('feedstat').onclick = openAbout; // the counter is the door to the full breakdown
  $('aboutClose').onclick = $('scrim').onclick = () => {
    $('about').classList.add('hidden');
    $('scrim').classList.add('hidden');
  };

  $('inqForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const status = $('inqStatus');
    status.textContent = 'Sending…';
    try {
      const resp = await fetch('/api/inquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inquiryType: $('inqType').value,
          name: $('inqName').value,
          email: $('inqEmail').value,
          organisation: $('inqOrg').value,
          message: $('inqMsg').value,
          website: $('inqWebsite').value,
        }),
      });
      const data = await resp.json();
      status.textContent = data.ok ? 'Thanks — we’ll be in touch.' : 'Something went wrong. Try again?';
      status.style.color = data.ok ? C.jade : C.danger;
      if (data.ok) $('inqForm').reset();
    } catch (_) {
      status.textContent = 'Network error. Try again?';
      status.style.color = C.danger;
    }
  };

  // ---------- pitch scenario deep-link ----------
  function runScenario() {
    const scenario = new URLSearchParams(location.search).get('scenario');

    // ?scenario=dungog — frame the proposed pilot network, no route drawn.
    // This view exists to be screenshotted for the council one-pager, so it
    // stays deliberately bare: the route line competes with the density
    // argument the pins are there to make.
    if (scenario === 'dungog') {
      map.fitBounds(DUNGOG.bounds, {
        padding: { top: 80, bottom: 110, left: 50, right: 50 },
        duration: 0,
      });
      return;
    }

    if (scenario !== 'pitch') return;
    state.from = PITCH.from;
    state.to = PITCH.to;
    $('dirbox').classList.remove('hidden');
    $('searchbox').classList.add('hidden');
    $('fromInput').value = PITCH.from.label;
    $('toInput').value = PITCH.to.label;
    fetchRoute();
  }

  // On phones, dock the mode toggle and the feed counter into the panel under
  // the search box. Order matters — toggle first, counter beneath it.
  function dockToggle() {
    const phone = matchMedia('(max-width: 640px)').matches;
    for (const id of ['modetoggle', 'feedstat']) {
      const el = $(id);
      if (phone) $('panel').appendChild(el);
      else document.body.appendChild(el);
    }
  }
  dockToggle();
  addEventListener('resize', dockToggle);

  // Deliberately not inside the map's load handler: the feed evidence is the
  // argument, and it has to survive a judge on a laptop where WebGL doesn't.
  loadFeedStats();
  // ?about=1 opens straight to the feed numbers — a link you can hand someone.
  if (new URLSearchParams(location.search).get('about') === '1') openAbout();
  initMap();
})();
