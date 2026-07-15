    /* global maplibregl, googleishStyle */
    (async () => {
      const $ = (id) => document.getElementById(id);

      // --- admin key ---
      let KEY = new URLSearchParams(location.search).get('key') || localStorage.getItem('mercuril_admin_key') || '';
      if (new URLSearchParams(location.search).get('key')) {
        localStorage.setItem('mercuril_admin_key', KEY);
        history.replaceState(null, '', '/admin');
      }
      function askKey() {
        $('keybar').style.display = 'grid';
        $('keyGo').onclick = () => {
          KEY = $('keyInput').value.trim();
          localStorage.setItem('mercuril_admin_key', KEY);
          $('keybar').style.display = 'none';
          refresh();
        };
      }
      const H = () => ({ 'Content-Type': 'application/json', 'x-admin-key': KEY });

      function toast(msg) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2200);
      }

      // --- map ---
      let style;
      try { style = await googleishStyle(); } catch { style = 'https://tiles.openfreemap.org/styles/liberty'; }
      const map = new maplibregl.Map({ container: 'map', style, center: [153.1, -28.9], zoom: 9 });
      map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

      const markers = new Map(); // id -> maplibregl.Marker

      function markerEl(state) {
        const el = document.createElement('div');
        el.style.cssText = `width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:grab;background:${state === 'flooded' ? '#ea4335' : '#34a853'}`;
        return el;
      }

      let sensors = [];
      async function refresh() {
        const data = await (await fetch('/api/sensors')).json();
        if (!data.features) return;
        sensors = data.features.map((f) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
        renderList();
        renderMarkers();
        const st = await (await fetch('/api/etl/status')).json();
        const last = st.lastRun ? new Date(st.lastRun.finished_at || st.lastRun.started_at).toLocaleString() : 'never';
        $('etlStatus').textContent = `${(st.closures || 0).toLocaleString()} gov records · last sync ${last}`;
      }

      function renderMarkers() {
        for (const s of sensors) {
          let m = markers.get(s.id);
          if (!m) {
            m = new maplibregl.Marker({ element: markerEl(s.state), draggable: true })
              .setLngLat([s.lon, s.lat])
              .addTo(map);
            m.on('dragend', async () => {
              const p = m.getLngLat();
              await fetch(`/api/sensors/${s.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ lon: p.lng, lat: p.lat }) })
                .then(r => r.ok ? toast(`Moved: ${s.name}`) : askKey());
              refresh();
            });
            markers.set(s.id, m);
          } else {
            m.setLngLat([s.lon, s.lat]);
            m.getElement().style.background = s.state === 'flooded' ? '#ea4335' : '#34a853';
          }
        }
        for (const [id, m] of markers) if (!sensors.find((s) => s.id === id)) { m.remove(); markers.delete(id); }
      }

      function renderList() {
        $('list').innerHTML = sensors
          .map(
            (s) => `<div class="sensor">
          <div class="s-head">
            <span class="s-dot" style="background:${s.state === 'flooded' ? '#ea4335' : '#34a853'}"></span>
            <span class="s-name">${s.name}</span>
            <button class="s-del" data-del="${s.id}" title="Delete">✕</button>
          </div>
          <div class="s-controls">
            <button class="s-toggle ${s.state}" data-toggle="${s.id}">${s.state === 'flooded' ? 'Set CLEAR' : 'FLOOD it'}</button>
            <input class="s-depth" type="range" min="0" max="2" step="0.01" value="${s.depth_m}" data-depth="${s.id}">
            <span class="s-depthval">${Number(s.depth_m).toFixed(2)} m</span>
          </div>
          <div class="s-meta">battery ${s.battery_pct}% · last seen ${new Date(s.last_seen).toLocaleTimeString()}</div>
        </div>`
          )
          .join('');

        $('list').querySelectorAll('[data-toggle]').forEach((b) => {
          b.onclick = async () => {
            const s = sensors.find((x) => x.id === Number(b.dataset.toggle));
            const flooding = s.state !== 'flooded';
            const body = flooding ? { state: 'flooded', depth_m: s.depth_m > 0.05 ? s.depth_m : 0.62 } : { state: 'clear', depth_m: 0 };
            const r = await fetch(`/api/sensors/${s.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify(body) });
            if (!r.ok) return askKey();
            toast(flooding ? `🌊 ${s.name} FLOODED` : `✓ ${s.name} clear`);
            refresh();
          };
        });
        $('list').querySelectorAll('[data-depth]').forEach((r) => {
          r.onchange = async () => {
            const id = Number(r.dataset.depth);
            const resp = await fetch(`/api/sensors/${id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ depth_m: Number(r.value) }) });
            if (!resp.ok) return askKey();
            refresh();
          };
        });
        $('list').querySelectorAll('[data-del]').forEach((b) => {
          b.onclick = async () => {
            const s = sensors.find((x) => x.id === Number(b.dataset.del));
            if (!confirm(`Delete sensor "${s.name}"?`)) return;
            const r = await fetch(`/api/sensors/${s.id}`, { method: 'DELETE', headers: H() });
            if (!r.ok) return askKey();
            toast(`Deleted ${s.name}`);
            refresh();
          };
        });
      }

      map.on('click', async (e) => {
        const name = prompt('New sensor name (e.g. "Old Bar Rd causeway"):');
        if (!name) return;
        const r = await fetch('/api/sensors', {
          method: 'POST',
          headers: H(),
          body: JSON.stringify({ name, lon: e.lngLat.lng, lat: e.lngLat.lat }),
        });
        if (!r.ok) return askKey();
        toast(`Added ${name}`);
        refresh();
      });

      $('etlBtn').onclick = async () => {
        $('etlStatus').textContent = 'Syncing… (~40 s)';
        const r = await fetch('/api/etl/refresh', { method: 'POST', headers: H() });
        if (!r.ok) { askKey(); return; }
        const d = await r.json();
        toast(d.ok ? `Synced ${d.records.toLocaleString()} records` : `ETL: ${d.error}`);
        refresh();
      };

      if (!KEY) askKey();
      refresh();
      setInterval(refresh, 10000);
    })();
