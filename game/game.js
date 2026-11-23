"use strict";
// Starlight Ghost — a tiny original browser game, written in this session for
// make.fun's "Day one, day seven" bounty.
//
// One engine, two builds, chosen with window.GAME_VERSION ("day1" | "day7"):
//   day1 — the game on the day it was made: flat background, a plain ghost,
//          five stars, a bare counter. Nothing else.
//   day7 — the same game after a week of daily updates: same map, same start,
//          same star order, same ghost path — but a night sky, twinkling
//          background stars, particle bursts, floating scores, a combo meter,
//          drifting grump ghosts, a motion trail, a progress bar, sound blips
//          and a finish banner. The change is the whole story.
//
// The demo is deterministic: a fixed 60 Hz step, a seeded RNG, and a scripted
// autopilot that flies the ghost through the stars in the same order in both
// builds, so the same moment can be cut between the two versions.
// No network at runtime, no wall clock in the simulation (only the animation
// frame clock drives the fixed-step accumulator).

const W = 1080;
const H = 1920;
const DT = 1 / 60;
const GHOST_SPEED = 260; // px per second, identical in both builds
const COLLECT_RADIUS = 78;

// The map. Five stars, fixed positions, fixed order. Same in both builds.
const STARS = [
  { x: 300, y: 500 },
  { x: 780, y: 700 },
  { x: 540, y: 1050 },
  { x: 250, y: 1400 },
  { x: 820, y: 1500 },
];
const GHOST_START = { x: 540, y: 960 };

// Small seeded RNG so every run looks the same.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const version = window.GAME_VERSION || "day7";
const isDay7 = version === "day7";
const rng = mulberry32(20261123);

// Background stars for the day-seven night sky (seeded, fixed).
const bgStars = [];
for (let i = 0; i < 110; i++) {
  bgStars.push({
    x: rng() * W,
    y: rng() * H,
    r: 1 + rng() * 2.2,
    phase: rng() * Math.PI * 2,
    speed: 0.6 + rng() * 1.8,
  });
}

// Day-seven grump ghosts: they drift on fixed circular paths that never cross
// the ghost's route, so the autopilot's opening is identical in both builds.
const grumps = [
  { cx: 200, cy: 800, r: 120, speed: 0.45, phase: 0.0, size: 46 },
  { cx: 880, cy: 1100, r: 120, speed: -0.35, phase: 2.1, size: 52 },
  { cx: 540, cy: 1670, r: 60, speed: 0.55, phase: 4.2, size: 40 },
];

const state = {
  time: 0,
  ghost: { x: GHOST_START.x, y: GHOST_START.y },
  target: 0, // index into STARS
  collected: 0,
  score: 0,
  combo: 0,
  particles: [],
  floats: [],
  trail: [],
  done: false,
  doneAt: 0,
  keys: {},
};

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
canvas.width = W;
canvas.height = H;

window.__GAME_TIME__ = 0;
window.__GAME_DONE__ = false;

// ---- input: arrow keys / WASD for humans; autopilot for the demo ----
const params = new URLSearchParams(location.search);
const autopilot = params.get("demo") === "1";
window.addEventListener("keydown", (e) => {
  state.keys[e.key.toLowerCase()] = true;
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(e.key.toLowerCase())) {
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => {
  state.keys[e.key.toLowerCase()] = false;
});

let audioCtx = null;
function blip(step) {
  if (!isDay7) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 520 + step * 90;
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  } catch (_) {
    /* headless or no audio: the game plays on silently */
  }
}

function burst(x, y) {
  if (!isDay7) return;
  for (let i = 0; i < 16; i++) {
    const angle = rng() * Math.PI * 2;
    const speed = 120 + rng() * 260;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 60,
      life: 0.7 + rng() * 0.4,
      age: 0,
      size: 3 + rng() * 5,
      color: ["#ffd94a", "#ff7ad9", "#ffffff", "#c41c83"][i % 4],
    });
  }
  state.floats.push({
    x,
    y: y - 30,
    text: "+" + 100 * (state.combo + 1),
    age: 0,
    life: 1.0,
  });
}

function collectStar(i) {
  state.collected++;
  state.combo++;
  state.score += 100 * state.combo;
  burst(STARS[i].x, STARS[i].y);
  blip(state.combo);
  state.target++;
  if (state.target >= STARS.length) {
    state.done = true;
    state.doneAt = state.time;
  }
}

function step(dt) {
  state.time += dt;
  window.__GAME_TIME__ = state.time;
  const g = state.ghost;

  // Move: autopilot flies the fixed waypoint route; humans steer with keys.
  let mx = 0;
  let my = 0;
  if (autopilot && !state.done) {
    const t = STARS[state.target];
    const dx = t.x - g.x;
    const dy = t.y - g.y;
    const d = Math.hypot(dx, dy);
    if (d < 10) {
      collectStar(state.target);
    } else {
      mx = dx / d;
      my = dy / d;
    }
  } else if (!state.done) {
    if (state.keys["arrowleft"] || state.keys["a"]) mx -= 1;
    if (state.keys["arrowright"] || state.keys["d"]) mx += 1;
    if (state.keys["arrowup"] || state.keys["w"]) my -= 1;
    if (state.keys["arrowdown"] || state.keys["s"]) my += 1;
    const len = Math.hypot(mx, my);
    if (len > 0) {
      mx /= len;
      my /= len;
    }
    // Manual play can also collect.
    if (state.target < STARS.length) {
      const t = STARS[state.target];
      if (Math.hypot(t.x - g.x, t.y - g.y) < COLLECT_RADIUS) collectStar(state.target);
    }
  }
  g.x = Math.max(50, Math.min(W - 50, g.x + mx * GHOST_SPEED * dt));
  g.y = Math.max(90, Math.min(H - 90, g.y + my * GHOST_SPEED * dt));

  // Autopilot collect check after moving (catches the last approach step).
  if (autopilot && !state.done && state.target < STARS.length) {
    const t = STARS[state.target];
    if (Math.hypot(t.x - g.x, t.y - g.y) < COLLECT_RADIUS) collectStar(state.target);
  }

  if (isDay7) {
    // Motion trail.
    state.trail.push({ x: g.x, y: g.y, age: 0 });
    if (state.trail.length > 18) state.trail.shift();
    for (const p of state.trail) p.age += dt;
    // Particles.
    for (const p of state.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 320 * dt;
    }
    state.particles = state.particles.filter((p) => p.age < p.life);
    for (const f of state.floats) f.age += dt;
    state.floats = state.floats.filter((f) => f.age < f.life);
  }

  if (state.done && state.time - state.doneAt > 1.2) {
    window.__GAME_DONE__ = true;
  }
}

// ---- drawing ----
function drawGhost(x, y, size, color, outline) {
  ctx.save();
  ctx.translate(x, y);
  if (outline) {
    ctx.shadowColor = "rgba(255,122,217,0.9)";
    ctx.shadowBlur = 26;
  }
  ctx.fillStyle = color;
  // Outline, traced in one loop so the fill has no self-intersections:
  // dome over the top, straight down the right side, three scallops along
  // the bottom from right to left, straight up the left side.
  ctx.beginPath();
  ctx.moveTo(-size, -size * 0.1);
  ctx.arc(0, -size * 0.1, size, Math.PI, 0, false); // clockwise: through the top
  ctx.lineTo(size, size * 0.55);
  const w = (2 * size) / 3;
  for (let i = 2; i >= 0; i--) {
    const x0 = -size + i * w;
    ctx.quadraticCurveTo(x0 + w / 2, size * 1.15, x0, size * 0.55);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  // Eyes.
  ctx.fillStyle = "#191419";
  ctx.beginPath();
  ctx.ellipse(-size * 0.34, -size * 0.15, size * 0.13, size * 0.19, 0, 0, Math.PI * 2);
  ctx.ellipse(size * 0.34, -size * 0.15, size * 0.13, size * 0.19, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(-size * 0.3, -size * 0.22, size * 0.05, 0, Math.PI * 2);
  ctx.arc(size * 0.38, -size * 0.22, size * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // Smile.
  ctx.strokeStyle = "#191419";
  ctx.lineWidth = size * 0.06;
  ctx.beginPath();
  ctx.arc(0, size * 0.12, size * 0.22, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

function drawStar(x, y, r, color, glow) {
  ctx.save();
  ctx.translate(x, y);
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(r * 0.22, -r * 0.22, r, 0);
  ctx.quadraticCurveTo(r * 0.22, r * 0.22, 0, r);
  ctx.quadraticCurveTo(-r * 0.22, r * 0.22, -r, 0);
  ctx.quadraticCurveTo(-r * 0.22, -r * 0.22, 0, -r);
  ctx.fill();
  ctx.restore();
}

function drawGrump(grump) {
  const a = grump.phase + state.time * grump.speed;
  const x = grump.cx + Math.cos(a) * grump.r;
  const y = grump.cy + Math.sin(a) * grump.r * 0.6;
  const s = grump.size;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#ff5470";
  ctx.beginPath();
  ctx.moveTo(-s, -s * 0.1);
  ctx.arc(0, -s * 0.1, s, Math.PI, 0, false); // clockwise: through the top
  ctx.lineTo(s, s * 0.55);
  const w = (2 * s) / 3;
  for (let i = 2; i >= 0; i--) {
    const x0 = -s + i * w;
    ctx.quadraticCurveTo(x0 + w / 2, s * 1.15, x0, s * 0.55);
  }
  ctx.closePath();
  ctx.fill();
  // Angry eyes.
  ctx.strokeStyle = "#191419";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-s * 0.55, -s * 0.35);
  ctx.lineTo(-s * 0.15, -s * 0.15);
  ctx.moveTo(s * 0.55, -s * 0.35);
  ctx.lineTo(s * 0.15, -s * 0.15);
  ctx.stroke();
  ctx.fillStyle = "#191419";
  ctx.beginPath();
  ctx.arc(-s * 0.32, -s * 0.05, s * 0.09, 0, Math.PI * 2);
  ctx.arc(s * 0.32, -s * 0.05, s * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function render() {
  // Background.
  if (isDay7) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#12082b");
    grad.addColorStop(0.55, "#2b0f4d");
    grad.addColorStop(1, "#4d0f3d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    for (const s of bgStars) {
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(state.time * s.speed + s.phase));
      ctx.globalAlpha = tw;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = "#191426";
    ctx.fillRect(0, 0, W, H);
  }

  // Stars: all five on the map from the start; collected ones dim out.
  STARS.forEach((s, i) => {
    if (i < state.collected) {
      ctx.globalAlpha = 0.18;
      drawStar(s.x, s.y, 34, "#ffd94a", false);
      ctx.globalAlpha = 1;
    } else if (i === state.target) {
      const pulse = 1 + 0.12 * Math.sin(state.time * 4);
      drawStar(s.x, s.y, 40 * pulse, "#ffd94a", isDay7);
      ctx.strokeStyle = isDay7 ? "rgba(255,217,74,0.8)" : "rgba(255,217,74,0.4)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 62 + 6 * Math.sin(state.time * 4), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      drawStar(s.x, s.y, 34, "#ffd94a", false);
    }
  });

  if (isDay7) {
    for (const g of grumps) drawGrump(g);
    // Motion trail.
    state.trail.forEach((p, i) => {
      ctx.globalAlpha = (i / state.trail.length) * 0.25;
      ctx.fillStyle = "#ff7ad9";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 26 * (i / state.trail.length), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    // Particles.
    for (const p of state.particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Floating scores.
    ctx.textAlign = "center";
    for (const f of state.floats) {
      ctx.globalAlpha = Math.max(0, 1 - f.age / f.life);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 44px sans-serif";
      ctx.fillText(f.text, f.x, f.y - f.age * 90);
    }
    ctx.globalAlpha = 1;
  }

  // The ghost.
  const bob = Math.sin(state.time * 3) * 6;
  drawGhost(state.ghost.x, state.ghost.y + bob, 58, "#ffffff", isDay7);

  // HUD.
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText(isDay7 ? "DAY SEVEN" : "DAY ONE", 48, 120);
  if (isDay7) {
    ctx.textAlign = "right";
    ctx.fillText("SCORE " + state.score, W - 48, 120);
    ctx.font = "bold 36px sans-serif";
    ctx.fillStyle = state.combo > 1 ? "#ff7ad9" : "#ffffff";
    ctx.fillText(state.combo > 1 ? "COMBO x" + state.combo : "COMBO x1", W - 48, 172);
    // Progress bar.
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(48, H - 120, W - 96, 18);
    ctx.fillStyle = "#ffd94a";
    ctx.fillRect(48, H - 120, ((W - 96) * state.collected) / STARS.length, 18);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px sans-serif";
    ctx.fillText("STARS " + state.collected + " / " + STARS.length, W / 2, H - 150);
  } else {
    ctx.textAlign = "center";
    ctx.fillText("STARS " + state.collected + " / " + STARS.length, W / 2, 120);
  }

  if (state.done) {
    ctx.textAlign = "center";
    ctx.fillStyle = isDay7 ? "#ffd94a" : "#ffffff";
    ctx.font = "bold 64px sans-serif";
    ctx.fillText(
      isDay7 ? "ALL STARS! 7 DAYS OF UPDATES" : "ALL STARS!",
      W / 2,
      H / 2 - 320
    );
    if (isDay7) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 40px sans-serif";
      ctx.fillText("SCORE " + state.score + "  ·  COMBO x" + state.combo, W / 2, H / 2 - 250);
    }
  }

  if (!autopilot && !state.done) {
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "28px sans-serif";
    ctx.fillText("Arrow keys / WASD to fly — collect all five stars", W / 2, H - 60);
  }
}

// Fixed-step loop.
let last = performance.now();
let acc = 0;
function frame(now) {
  const elapsed = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += elapsed;
  while (acc >= DT) {
    step(DT);
    acc -= DT;
  }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
