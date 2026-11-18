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
  toMap(sx, sy) {
    return { x: this.x + (sx - this.view.w / 2) / this.zoom, y: this.y + (sy - this.view.h / 2) / this.zoom };
  }
  toScreen(mx, my) {
    return { x: (mx - this.x) * this.zoom + this.view.w / 2, y: (my - this.y) * this.zoom + this.view.h / 2 };
  }

  // Zoom by a factor keeping the map point under (sx, sy) fixed (in the target camera).
  zoomAt(factor, sx, sy) {
    const mx = this.tx + (sx - this.view.w / 2) / this.tz;
    const my = this.ty + (sy - this.view.h / 2) / this.tz;
    this.tz = this.clampZoom(this.tz * factor);
    this.tx = mx - (sx - this.view.w / 2) / this.tz;
    this.ty = my - (sy - this.view.h / 2) / this.tz;
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
    this.x -= dx / this.zoom; this.tx -= dx / this.zoom;
    this.y -= dy / this.zoom; this.ty -= dy / this.zoom;
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
