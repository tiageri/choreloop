// Celebration animations played when a chore is checked off.
//
// One full-screen canvas, created on first use and torn down when the last
// particle dies, so nothing runs (or intercepts taps) while the app is idle.

const THEMES = {
  // Little vacuums that trundle across the screen, hoovering up dust.
  vacuum: { vacuums: 3, dust: 30, glyphs: ['✨', '💨'], duration: 2800 },
  bubbles: { motion: 'rise', glyphs: ['🫧', '🫧', '🫧', '✨', '🧼'], count: 36, duration: 2800 },
  sweep: { motion: 'sweep', glyphs: ['🧹', '💨', '✨'], count: 16, duration: 2400 },
  frost: { motion: 'fall', glyphs: ['❄️', '🧊', '✨'], count: 30, duration: 2800 },
  shine: { motion: 'pop', glyphs: ['✨', '🧽', '🧼', '💫'], count: 28, duration: 2200 },
  confetti: { motion: 'burst', glyphs: ['🎉', '✨', '🧽'], count: 28, duration: 2200 },
};

// Matched against the task's own `animation` field first, then its name, so a
// task renamed or added later still gets something fitting.
const BY_KEYWORD = [
  [/vacuum|couch|carpet|rug/i, 'vacuum'],
  [/swiffer|mop|sweep|broom|floor/i, 'sweep'],
  [/bath|tub|shower|toilet|sink|bathroom/i, 'bubbles'],
  [/fridge|freezer|ice/i, 'frost'],
  [/stove|counter|kitchen|wipe|oven|microwave/i, 'shine'],
];

export function themeFor(task) {
  if (task?.animation && THEMES[task.animation]) return task.animation;
  for (const [pattern, theme] of BY_KEYWORD) {
    if (pattern.test(task?.name || '')) return theme;
  }
  return 'confetti';
}

/* ---------- canvas plumbing ---------- */

let canvas = null;
let ctx = null;
let raf = 0;
let particles = [];
let vacuums = [];
let last = 0;
let W = 0;
let H = 0;

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[(Math.random() * list.length) | 0];

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'celebrate';
  document.body.append(canvas);
  ctx = canvas.getContext('2d');
  resize();
  addEventListener('resize', resize);
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth;
  H = innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function teardown() {
  cancelAnimationFrame(raf);
  raf = 0;
  particles = [];
  vacuums = [];
  removeEventListener('resize', resize);
  canvas?.remove();
  canvas = null;
  ctx = null;
}

/* ---------- the vacuum ---------- */

function drawVacuum(x, y, size, tilt, spin) {
  const s = size / 34;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(s, s);

  // handle
  ctx.strokeStyle = '#3a3f45';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(2, 2);
  ctx.lineTo(12, -30);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(12, -30);
  ctx.lineTo(22, -34);
  ctx.stroke();

  // body
  ctx.fillStyle = '#1f6f5c';
  ctx.beginPath();
  ctx.roundRect(-18, -8, 36, 18, 6);
  ctx.fill();

  // head
  ctx.fillStyle = '#2b3138';
  ctx.beginPath();
  ctx.roundRect(-22, 8, 44, 10, 4);
  ctx.fill();

  // spinning brush
  ctx.strokeStyle = '#f2c14e';
  ctx.lineWidth = 2.5;
  for (let i = 0; i < 4; i++) {
    const a = spin + (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 2, 13 + Math.sin(a) * 2);
    ctx.lineTo(Math.cos(a) * 7, 13 + Math.sin(a) * 7);
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- spawning ---------- */

function spawnVacuumScene(theme) {
  const now = performance.now();
  for (let i = 0; i < theme.vacuums; i++) {
    const leftToRight = i % 2 === 0;
    vacuums.push({
      dir: leftToRight ? 1 : -1,
      x: leftToRight ? rand(-160, -40) : W + rand(40, 160),
      baseY: H * rand(0.25, 0.8),
      y: 0,
      speed: rand(150, 240),
      size: rand(30, 44),
      bob: rand(6, 16),
      phase: rand(0, Math.PI * 2),
      spin: 0,
      born: now,
    });
  }
  for (let i = 0; i < theme.dust; i++) {
    particles.push({
      kind: 'dust',
      glyph: pick(theme.glyphs),
      x: rand(0, W),
      y: rand(H * 0.15, H * 0.9),
      vx: rand(-20, 20),
      vy: rand(-20, 20),
      size: rand(11, 19),
      rot: rand(0, Math.PI * 2),
      vrot: rand(-3, 3),
      target: (Math.random() * vacuums.length) | 0,
      born: now + rand(0, 500),
      life: theme.duration,
      alpha: 1,
    });
  }
}

function spawnParticles(theme) {
  const now = performance.now();
  for (let i = 0; i < theme.count; i++) {
    const p = {
      kind: theme.motion,
      glyph: pick(theme.glyphs),
      size: rand(14, 30),
      rot: rand(0, Math.PI * 2),
      vrot: rand(-2.5, 2.5),
      born: now + rand(0, 550),
      life: theme.duration * rand(0.7, 1),
      alpha: 1,
      phase: rand(0, Math.PI * 2),
      seed: rand(0.6, 1.5),
    };

    if (theme.motion === 'rise') {
      Object.assign(p, { x: rand(0, W), y: H + rand(10, 90), vx: 0, vy: rand(-150, -70) });
    } else if (theme.motion === 'fall') {
      Object.assign(p, { x: rand(0, W), y: -rand(10, 120), vx: rand(-15, 15), vy: rand(70, 150) });
    } else if (theme.motion === 'sweep') {
      const dir = Math.random() < 0.5 ? 1 : -1;
      Object.assign(p, {
        x: dir > 0 ? -rand(20, 200) : W + rand(20, 200),
        y: rand(H * 0.2, H * 0.85),
        vx: dir * rand(320, 520), vy: rand(-25, 25),
      });
    } else if (theme.motion === 'pop') {
      Object.assign(p, { x: rand(W * 0.08, W * 0.92), y: rand(H * 0.15, H * 0.85), vx: 0, vy: rand(-30, -8) });
    } else {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(120, 320);
      Object.assign(p, {
        x: W / 2, y: H * 0.45,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 80,
      });
    }
    particles.push(p);
  }
}

/* ---------- the loop ---------- */

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ctx.clearRect(0, 0, W, H);

  for (const v of vacuums) {
    const age = now - v.born;
    v.x += v.dir * v.speed * dt;
    v.spin += dt * 14;
    v.y = v.baseY + Math.sin(age / 220 + v.phase) * v.bob;
    drawVacuum(v.x, v.y, v.size, Math.sin(age / 300 + v.phase) * 0.12, v.spin);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const p of particles) {
    const age = now - p.born;
    if (age < 0) continue;
    const t = age / p.life;

    if (p.kind === 'dust') {
      // Accelerate toward the vacuum that claimed this speck, then vanish.
      const v = vacuums[p.target];
      if (v) {
        const dx = v.x - p.x;
        const dy = v.y + 10 - p.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < 22) { p.alpha = 0; continue; }
        const pull = 900 / Math.max(dist, 60);
        p.vx += (dx / dist) * pull * dt * 60;
        p.vy += (dy / dist) * pull * dt * 60;
        p.vx *= 0.94;
        p.vy *= 0.94;
      }
      p.alpha = t > 0.85 ? Math.max(0, 1 - (t - 0.85) / 0.15) : 1;
    } else if (p.kind === 'rise') {
      p.x += Math.sin(age / 400 * p.seed + p.phase) * 34 * dt;
      p.alpha = t > 0.6 ? Math.max(0, 1 - (t - 0.6) / 0.4) : 1;
    } else if (p.kind === 'fall') {
      p.x += Math.sin(age / 500 * p.seed + p.phase) * 26 * dt;
      p.alpha = t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
    } else if (p.kind === 'pop') {
      p.alpha = t < 0.25 ? t / 0.25 : Math.max(0, 1 - (t - 0.25) / 0.75);
    } else if (p.kind === 'burst') {
      p.vy += 420 * dt;
      p.alpha = t > 0.55 ? Math.max(0, 1 - (t - 0.55) / 0.45) : 1;
    } else {
      p.alpha = t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vrot * dt;

    if (p.alpha <= 0) continue;
    const scale = p.kind === 'pop' ? 0.6 + Math.min(t / 0.25, 1) * 0.6 : 1;
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.font = `${p.size * scale}px system-ui, "Apple Color Emoji", sans-serif`;
    ctx.fillText(p.glyph, 0, 0);
    ctx.restore();
  }

  particles = particles.filter((p) => p.alpha > 0 && now - p.born < p.life);
  vacuums = vacuums.filter((v) => v.x > -260 && v.x < W + 260);

  if (particles.length || vacuums.length) raf = requestAnimationFrame(frame);
  else teardown();
}

/* ---------- entry point ---------- */

/** Play the celebration that suits `task`. Safe to call rapidly. */
export function celebrate(task) {
  if (reducedMotion()) return;
  const theme = THEMES[themeFor(task)] ?? THEMES.confetti;

  ensureCanvas();
  // Keep a burst of quick check-offs from piling up without bound.
  if (particles.length > 160) particles.length = 120;

  if (theme.vacuums) spawnVacuumScene(theme);
  else spawnParticles(theme);

  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}
