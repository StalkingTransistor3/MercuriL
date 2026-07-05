/* MercuriL front-of-house FX: hero telemetry field, stat counters, scroll reveals.
   Everything respects prefers-reduced-motion and pauses off-screen. */
(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Scroll reveals ---------- */
  const revealEls = document.querySelectorAll('.reveal');
  if (reduced) {
    revealEls.forEach((el) => el.classList.add('is-in'));
  } else if (revealEls.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealEls.forEach((el) => io.observe(el));
  }

  /* ---------- Stat counters ---------- */
  const counters = document.querySelectorAll('[data-count]');
  const fmt = (n, style) =>
    style === 'comma' ? Math.round(n).toLocaleString('en-AU') : String(Math.round(n));
  if (reduced) {
    counters.forEach((el) => {
      el.textContent = fmt(+el.dataset.count, el.dataset.format);
    });
  } else if (counters.length) {
    const cio = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          cio.unobserve(entry.target);
          const el = entry.target;
          const target = +el.dataset.count;
          const dur = 1400;
          const t0 = performance.now();
          const tick = (t) => {
            const p = Math.min((t - t0) / dur, 1);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = fmt(target * eased, el.dataset.format);
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      { threshold: 0.4 }
    );
    counters.forEach((el) => cio.observe(el));
  }

  /* ---------- Hero telemetry field ---------- */
  const canvas = document.getElementById('hero-fx');
  if (!canvas || reduced) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  const hero = canvas.parentElement;

  let W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = hero.clientWidth;
    H = hero.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    placeNodes();
  };

  /* Flow field: layered sinusoids — cheap curl-ish water drift, no libs. */
  const angleAt = (x, y, t) => {
    const s = 0.0016;
    return (
      Math.sin(x * s + t * 0.00022) * 1.4 +
      Math.cos(y * s * 1.7 - t * 0.00018) * 1.2 +
      Math.sin((x + y) * s * 0.6 + t * 0.0001) * 0.8
    );
  };

  const P_COUNT = Math.min(700, Math.floor((window.innerWidth * 0.5)));
  const parts = [];
  const spawn = (p) => {
    p.x = Math.random() * W;
    p.y = Math.random() * H;
    p.life = 120 + Math.random() * 260;
    p.speed = 0.35 + Math.random() * 0.85;
    return p;
  };
  for (let i = 0; i < P_COUNT; i++) parts.push(spawn({}));

  /* Sensor nodes — the network. One runs hazard-amber. */
  const NODE_DEFS = [
    { fx: 0.16, fy: 0.30, id: 'XING-014', depth: '0.02M', state: 'ok' },
    { fx: 0.34, fy: 0.68, id: 'XING-027', depth: '0.00M', state: 'ok' },
    { fx: 0.55, fy: 0.24, id: 'XING-042', depth: '0.31M', state: 'warn' },
    { fx: 0.72, fy: 0.58, id: 'XING-051', depth: '0.04M', state: 'ok' },
    { fx: 0.87, fy: 0.33, id: 'XING-066', depth: '0.01M', state: 'ok' },
    { fx: 0.08, fy: 0.78, id: 'XING-009', depth: '0.00M', state: 'ok' },
  ];
  let nodes = [];
  const placeNodes = () => {
    nodes = NODE_DEFS.map((d) => ({
      ...d,
      x: d.fx * W,
      y: d.fy * H,
      next: performance.now() + Math.random() * 3000,
      rings: [],
    }));
  };

  const CYAN = '56,189,248';
  const AMBER = '251,191,36';

  let mouseX = -9999, mouseY = -9999;
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
  });
  hero.addEventListener('pointerleave', () => { mouseX = mouseY = -9999; });

  let running = true;
  const vio = new IntersectionObserver(
    ([entry]) => { running = entry.isIntersecting; if (running) requestAnimationFrame(frame); },
    { threshold: 0.02 }
  );
  vio.observe(hero);
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) requestAnimationFrame(frame);
  });

  const frame = (t) => {
    if (!running) return;

    /* trail fade — erase to transparent so the WebGL terrain shows through */
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    /* particles */
    for (const p of parts) {
      const a = angleAt(p.x, p.y, t);
      let vx = Math.cos(a) * p.speed;
      let vy = Math.sin(a) * p.speed * 0.75 + 0.12; /* slight downhill bias — water */

      const dx = p.x - mouseX, dy = p.y - mouseY;
      const d2 = dx * dx + dy * dy;
      if (d2 < 16000) { /* gentle wake around cursor */
        const f = (1 - d2 / 16000) * 1.6;
        vx += (dx / Math.sqrt(d2 + 1)) * f;
        vy += (dy / Math.sqrt(d2 + 1)) * f;
      }

      const nx = p.x + vx, ny = p.y + vy;
      const depthShade = 0.10 + 0.25 * (p.y / H); /* deeper = brighter, water pooling low */
      ctx.strokeStyle = `rgba(${CYAN},${depthShade.toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      p.x = nx; p.y = ny;

      if (--p.life < 0 || p.x < -4 || p.x > W + 4 || p.y < -4 || p.y > H + 4) spawn(p);
    }

    /* constellation between nodes */
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < W * 0.34) {
          ctx.strokeStyle = `rgba(${CYAN},${(0.075 * (1 - d / (W * 0.34))).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    /* nodes + ping rings + labels */
    ctx.font = '10px "DM Mono", monospace';
    for (const n of nodes) {
      const col = n.state === 'warn' ? AMBER : CYAN;

      if (t > n.next) {
        n.rings.push({ r: 0, born: t });
        n.next = t + (n.state === 'warn' ? 1400 : 2600 + Math.random() * 2600);
      }
      n.rings = n.rings.filter((ring) => {
        const age = (t - ring.born) / 1800;
        if (age >= 1) return false;
        ring.r = age * 64;
        ctx.strokeStyle = `rgba(${col},${(0.5 * (1 - age)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        return true;
      });

      /* node core */
      const pulse = 2.4 + Math.sin(t * 0.004 + n.x) * 0.7;
      ctx.fillStyle = `rgba(${col},0.95)`;
      ctx.shadowColor = `rgba(${col},0.8)`;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(n.x, n.y, pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      /* telemetry label */
      ctx.fillStyle = `rgba(${col},${n.state === 'warn' ? 0.8 : 0.4})`;
      ctx.fillText(`${n.id} · ${n.depth}${n.state === 'warn' ? ' ▲ CLOSED' : ''}`, n.x + 12, n.y + 3);
    }

    requestAnimationFrame(frame);
  };

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);
})();
