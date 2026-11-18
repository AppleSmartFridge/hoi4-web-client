// The view is a perspective camera looking down at the map, tilting north-up as it comes
// closer like the game's (flat from far away, TILT_MAX near the ground). zoom is CSS px per
// map texel at the screen centre; with no tilt, flat ground maps exactly as a top-down view.
// Heights (heightAt, set by the app) only move what is on the ground; the camera keeps the
// sea-level plane as its reference.
const FOV = (40 * Math.PI) / 180;     // vertical field of view
// The game's tilt curve is compiled into the engine (the defines only give heights 50-3000).
// As in the game, the map stays top-down for almost the whole zoom range and only tips
// over in the last stretch before the closest zoom.
const TILT_MAX = 0.6;                 // radians from straight down (~34 degrees)
const TILT_FAR = 170, TILT_NEAR = 80; // camera heights where tilting starts and is complete

// Camera with smoothing: input moves a target; the visible camera eases towards it
// (exponential, zoom in log space so zooming feels even). Drags follow the pointer
// directly and keep their momentum when released. The map wraps east-west.

export class Camera {
  constructor(mapW, mapH) {
    this.W = mapW;
    this.H = mapH;
    this.view = { w: 1, h: 1 };  // CSS pixels
    this.x = this.tx = mapW * 0.5;
    this.y = this.ty = mapH * 0.4;
    this.zoom = this.tz = 0.5;   // CSS pixels per map texel
    this.maxZoom = 14;
    this.vx = this.vy = 0;       // momentum, texels per second
    this.smoothing = 0.085;      // seconds to cover ~63% of the way
  }

  // Equivalent of the game's camera height (50 close ... 3000 far) for the fades the game
  // keys to it: border fades, gradient-border fill, when country names show.
  // Calibrated against the game: a view of Europe there is past the province-line fade.
  get height() { return (1.25 * this.view.h) / this.zoom; }

  // Tilt (radians from straight down) for a zoom level.
  tiltFor(zoom) {
    const h = (1.25 * this.view.h) / zoom;
    const t = Math.min(1, Math.max(0, (TILT_FAR - h) / (TILT_FAR - TILT_NEAR)));
    return TILT_MAX * t * t * (3 - 2 * t);
  }
  get tilt() { return this.tiltFor(this.zoom); }

  // Camera frame in map units for a target point and zoom: position C, forward and up
  // vectors (screen right is always +x), focal length f in CSS px.
  frame(x = this.x, y = this.y, zoom = this.zoom) {
    const f = this.view.h / 2 / Math.tan(FOV / 2);
    const D = f / zoom, t = this.tiltFor(zoom), s = Math.sin(t), c = Math.cos(t);
    return { f, C: [x, y + D * s, D * c], fwd: [0, -s, -c], up: [0, -c, s] };
  }

  // Where the ray through screen point (sx, sy) meets height z, for a frame.
  static ground(fr, view, sx, sy, z = 0) {
    const dx = sx - view.w / 2, dy = sy - view.h / 2;
    const d = [dx, fr.fwd[1] * fr.f - fr.up[1] * dy, fr.fwd[2] * fr.f - fr.up[2] * dy];
    if (d[2] >= -1e-6) return null;  // above the horizon
    const k = (z - fr.C[2]) / d[2];
    return { x: fr.C[0] + k * d[0], y: fr.C[1] + k * d[1] };
  }

  get minZoom() { return Math.max(this.view.h / this.H, 0.05); }

  resize(w, h) {
    this.view = { w, h };
    this.tz = this.clampZoom(this.tz);
    this.zoom = this.clampZoom(this.zoom);
    this.clampTarget();
  }

  clampZoom(z) { return Math.min(this.maxZoom, Math.max(this.minZoom, z)); }

  clampTarget() {
    const half = this.view.h / 2 / this.tz;
    this.ty = half * 2 >= this.H ? this.H / 2 : Math.min(this.H - half, Math.max(half, this.ty));
  }

  // Screen (CSS px, from the top-left of the view) -> map texels, using the visible camera.
  // On the terrain when heightAt is set (a few fixed-point steps), else at sea level.
  toMap(sx, sy) {
    const fr = this.frame();
    let p = Camera.ground(fr, this.view, sx, sy, 0);
    if (!p) return { x: NaN, y: NaN };
    if (this.heightAt) {
      for (let i = 0; i < 4; i++) {
        const q = Camera.ground(fr, this.view, sx, sy, this.heightAt(p.x, p.y));
        if (!q) break;
        p = q;
      }
    }
    return p;
  }
  toScreen(mx, my, z = 0) {
    const fr = this.frame();
    const v = [mx - fr.C[0], my - fr.C[1], z - fr.C[2]];
    const depth = v[1] * fr.fwd[1] + v[2] * fr.fwd[2];
    const up = v[1] * fr.up[1] + v[2] * fr.up[2];
    const k = fr.f / Math.max(depth, 1e-3);
    return { x: this.view.w / 2 + v[0] * k, y: this.view.h / 2 - up * k };
  }
  // Ground point under a screen point relative to the target, for a target-free frame.
  offsetAt(zoom, sx, sy) {
    const p = Camera.ground(this.frame(0, 0, zoom), this.view, sx, sy, 0);
    return p || { x: (sx - this.view.w / 2) / zoom, y: (sy - this.view.h / 2) / zoom };
  }

  // Zoom by a factor keeping the map point under (sx, sy) fixed (in the target camera).
  zoomAt(factor, sx, sy) {
    const a = this.offsetAt(this.tz, sx, sy);
    const mx = this.tx + a.x, my = this.ty + a.y;
    this.tz = this.clampZoom(this.tz * factor);
    const b = this.offsetAt(this.tz, sx, sy);
    this.tx = mx - b.x;
    this.ty = my - b.y;
    this.clampTarget();
  }

  // Pan the target by a screen distance (CSS px).
  panBy(dx, dy) {
    this.tx += dx / this.tz;
    this.ty += dy / this.tz;
    this.clampTarget();
  }

  // Direct manipulation while dragging: both cameras move together, no easing.
  dragBy(dx, dy) {
    // Ground distance under the screen centre, so a tilted view drags at the right speed.
    const cx = this.view.w / 2, cy = this.view.h / 2;
    const a = this.offsetAt(this.zoom, cx, cy), b = this.offsetAt(this.zoom, cx + dx, cy + dy);
    const mx = b.x - a.x, my = b.y - a.y;
    this.x -= mx; this.tx -= mx;
    this.y -= my; this.ty -= my;
    const before = this.ty;
    this.clampTarget();
    this.y += this.ty - before;  // stop at the top and bottom edges without lag
  }

  flyTo(x, y, zoom = this.tz) {
    this.tz = this.clampZoom(zoom);
    // Take the short way around the wrap.
    let dx = x - this.tx;
    dx -= Math.round(dx / this.W) * this.W;
    this.tx += dx;
    this.ty = y;
    this.vx = this.vy = 0;
    this.clampTarget();
  }

  // Advances the easing by dt seconds; true while still moving.
  update(dt) {
    if (this.vx || this.vy) {
      this.tx += this.vx * dt;
      this.ty += this.vy * dt;
      const decay = Math.exp(-dt * 4.5);
      this.vx *= decay; this.vy *= decay;
      if (Math.hypot(this.vx, this.vy) * this.tz < 8) this.vx = this.vy = 0;
      this.clampTarget();
    }
    const k = 1 - Math.exp(-dt / this.smoothing);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    this.zoom = Math.exp(Math.log(this.zoom) + (Math.log(this.tz) - Math.log(this.zoom)) * k);
    // Wrap both cameras together so easing never takes the long way.
    if (this.x < 0 || this.x >= this.W) {
      const shift = Math.floor(this.x / this.W) * this.W;
      this.x -= shift; this.tx -= shift;
    }
    const moving = Math.abs(this.tx - this.x) * this.zoom > 0.05 || Math.abs(this.ty - this.y) * this.zoom > 0.05 ||
      Math.abs(Math.log(this.tz / this.zoom)) > 1e-4 || this.vx !== 0 || this.vy !== 0;
    if (!moving) { this.x = this.tx; this.y = this.ty; this.zoom = this.tz; }
    return moving;
  }
}

// Mouse, wheel, touch and keyboard input, in the spirit of the game's map controls:
// drag to pan (any button), wheel to zoom at the cursor, WASD/arrows to pan, Q/E or
// -/+ to zoom, optional edge scrolling, pinch and one-finger pan on touch screens.
export class Controls {
  constructor(el, camera, { onHover, onClick, onChange }) {
    this.el = el;
    this.cam = camera;
    this.onHover = onHover;
    this.onClick = onClick;
    this.onChange = onChange;
    this.keys = new Set();
    this.edgeScroll = false;
    this.pointer = null;          // last pointer position (CSS px) when inside the map
    this.pointers = new Map();    // active touches/drags
    this.drag = null;
    this.bind();
  }

  bind() {
    const el = this.el;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const steps = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
      this.cam.zoomAt(Math.pow(1.2, -steps), e.clientX - r.left, e.clientY - r.top);
      this.onChange();
    }, { passive: false });
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      this.cam.vx = this.cam.vy = 0;
      if (this.pointers.size === 1) {
        this.drag = { start: p, last: p, moved: 0, button: e.button, samples: [{ ...p, t: performance.now() }] };
      } else {
        this.drag = null;
        this.pinch = this.pinchState();
      }
    });
    el.addEventListener("pointermove", (e) => {
      const p = this.local(e);
      this.pointer = p;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (this.pointers.size >= 2 && this.pinch) {
        const now = this.pinchState();
        this.cam.zoomAt(now.dist / this.pinch.dist, now.cx, now.cy);
        this.cam.dragBy(now.cx - this.pinch.cx, now.cy - this.pinch.cy);
        this.pinch = now;
        this.onChange();
      } else if (this.drag) {
        const dx = p.x - this.drag.last.x, dy = p.y - this.drag.last.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.drag.last = p;
        if (this.drag.moved > 4) {
          this.cam.dragBy(dx, dy);
          el.classList.add("dragging");
          const t = performance.now();
          this.drag.samples.push({ ...p, t });
          while (this.drag.samples.length > 2 && t - this.drag.samples[0].t > 90) this.drag.samples.shift();
          this.onChange();
        }
      }
      this.onHover(p);
    });
    const end = (e) => {
      const p = this.local(e);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const d = this.drag;
      this.drag = null;
      el.classList.remove("dragging");
      if (!d || e.type === "pointercancel") return;
      if (d.moved <= 4) {
        if (d.button === 0) this.onClick(p, e);
        return;
      }
      // Fling: keep the drag's velocity and let it decay.
      const s = d.samples, a = s[0], b = s[s.length - 1], dt = (b.t - a.t) / 1000;
      if (dt > 0.01 && performance.now() - b.t < 60) {
        this.cam.vx = -(b.x - a.x) / dt / this.cam.zoom;
        this.cam.vy = -(b.y - a.y) / dt / this.cam.zoom;
        this.onChange();
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", () => { if (!this.drag) this.pointer = null; this.onHover(null); });
    el.addEventListener("dblclick", (e) => {
      const p = this.local(e);
      this.cam.zoomAt(2, p.x, p.y);
      this.onChange();
    });
    window.addEventListener("keydown", (e) => {
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "q", "e", "+", "=", "-", "_", "shift"].includes(k)) {
        this.keys.add(k);
        if (k.startsWith("arrow")) e.preventDefault();
        this.onChange();
      }
    });
    window.addEventListener("keyup", (e) => { this.keys.delete(e.key.toLowerCase()); });
    window.addEventListener("blur", () => this.keys.clear());
  }

  local(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  // Held keys and edge scrolling; true if they moved the camera.
  tick(dt) {
    const k = this.keys;
    let dx = 0, dy = 0, dz = 0;
    if (k.has("a") || k.has("arrowleft")) dx -= 1;
    if (k.has("d") || k.has("arrowright")) dx += 1;
    if (k.has("w") || k.has("arrowup")) dy -= 1;
    if (k.has("s") || k.has("arrowdown")) dy += 1;
    if (k.has("q") || k.has("-") || k.has("_")) dz -= 1;
    if (k.has("e") || k.has("+") || k.has("=")) dz += 1;
    if (this.edgeScroll && this.pointer && !this.drag) {
      const m = 10, { w, h } = this.cam.view, p = this.pointer;
      if (p.x < m) dx -= 1; else if (p.x > w - m) dx += 1;
      if (p.y < m) dy -= 1; else if (p.y > h - m) dy += 1;
    }
    if (!dx && !dy && !dz) return false;
    const speed = (k.has("shift") ? 2200 : 1000) * dt;  // CSS px per second
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      this.cam.panBy((dx / len) * speed, (dy / len) * speed);
    }
    if (dz) this.cam.zoomAt(Math.pow(2.6, dz * dt), this.cam.view.w / 2, this.cam.view.h / 2);
    return true;
  }
}
