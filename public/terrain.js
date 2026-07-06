/* MercuriL hero terrain layer — raw WebGL, no dependencies.
   Animated topographic contours (flood mapping, literal) with a breathing
   waterline and caustic shimmer. Sits UNDER the 2D sensor-node canvas.
   Falls back silently if WebGL is unavailable; disabled by reduced-motion. */
(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('hero-gl');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
  if (!gl) return;
  const hero = canvas.parentElement;
  /* fwidth() needs this extension in WebGL1; fall back to constant width */
  const hasDeriv = !!gl.getExtension('OES_standard_derivatives');

  const VERT = `
    attribute vec2 a;
    void main() { gl_Position = vec4(a, 0.0, 1.0); }
  `;

  const FRAG = `${hasDeriv ? '#extension GL_OES_standard_derivatives : enable\n' : ''}
    precision highp float;
    uniform vec2 uRes;
    uniform float uT;
    uniform vec2 uMouse;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = rot * p * 2.03;
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
      /* gentle mouse parallax */
      uv += uMouse * 0.035;

      float t = uT * 0.001;

      /* domain-warped terrain height — slow tectonic drift */
      vec2 q = vec2(fbm(uv * 1.6 + t * 0.06), fbm(uv * 1.6 - t * 0.045 + 4.7));
      float h = fbm(uv * 2.1 + 0.55 * q + vec2(0.0, t * 0.03));

      /* topographic contour lines */
      float bands = 16.0;
      float hb = h * bands;
      float dist = abs(fract(hb) - 0.5);
      float w = ${hasDeriv ? 'fwidth(hb) * 1.1' : '0.05'};
      float contour = 1.0 - smoothstep(0.0, w + 0.035, dist);
      /* every 4th line is an index contour — slightly stronger */
      float major = step(0.75, fract(floor(hb) / 4.0 + 0.01));
      float lineStrength = contour * (0.16 + 0.22 * major);

      /* breathing waterline — floods rise from the bottom of the frame */
      float level = -0.22 + 0.06 * sin(t * 0.5) + 0.03 * sin(t * 0.23 + 2.0);
      float depth = (level - uv.y - h * 0.16);
      float water = smoothstep(0.0, 0.28, depth);

      /* caustic shimmer inside the water */
      float caustic = pow(fbm(uv * 7.0 + vec2(t * 0.55, -t * 0.4)), 3.0) * water;

      /* palette */
      vec3 ground = vec3(0.020, 0.039, 0.071);            /* #050A12 */
      vec3 cyan   = vec3(0.220, 0.741, 0.973);            /* #38BDF8 */
      vec3 deep   = vec3(0.055, 0.647, 0.914);            /* #0EA5E9 */

      vec3 col = ground;
      /* dry-land contours: faint slate-cyan */
      col += cyan * lineStrength * (0.30 + 0.25 * h);
      /* submerged zone: tint + brighter contours + caustics */
      col = mix(col, ground + deep * 0.10, water * 0.65);
      col += cyan * lineStrength * water * 0.55;
      col += cyan * caustic * 0.38;
      /* waterline edge glow */
      float edge = 1.0 - smoothstep(0.0, 0.02, abs(depth - 0.01));
      col += cyan * edge * 0.16;

      /* vignette so hero text stays readable */
      float vig = smoothstep(1.25, 0.35, length(uv * vec2(0.85, 1.15)));
      col *= 0.55 + 0.45 * vig;
      /* extra darkening top-left where the headline sits */
      col *= 1.0 - 0.35 * smoothstep(0.55, -0.35, uv.x + uv.y * 0.4);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uT = gl.getUniformLocation(prog, 'uT');
  const uMouse = gl.getUniformLocation(prog, 'uMouse');

  let W = 0, H = 0;
  const resize = () => {
    /* shader is heavy per-pixel: render at capped DPR and let CSS scale.
       Phones get a lower internal resolution — the glow hides it entirely. */
    const cap = window.innerWidth < 700 ? 0.85 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    W = hero.clientWidth;
    H = hero.clientHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  window.addEventListener('resize', resize);

  let mx = 0, my = 0, tmx = 0, tmy = 0;
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    tmx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    tmy = ((e.clientY - r.top) / r.height - 0.5) * -2;
  });

  let running = true;
  new IntersectionObserver(([entry]) => {
    running = entry.isIntersecting;
    if (running) requestAnimationFrame(frame);
  }, { threshold: 0.02 }).observe(hero);
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) requestAnimationFrame(frame);
  });

  const frame = (t) => {
    if (!running) return;
    mx += (tmx - mx) * 0.04; /* eased parallax */
    my += (tmy - my) * 0.04;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, t);
    gl.uniform2f(uMouse, mx, my);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
