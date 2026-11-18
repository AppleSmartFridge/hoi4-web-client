// Map labels on a 2D canvas over the WebGL map.
//
// Country names use the game's own map font (gfx/fonts/hoi_mapfont4: Tahoma bold drawn as
// dark letters with a faint light rim) and show only while the camera is high enough
// (DRAW_COUNTRY_NAMES_CUTOFF = 260). When connected, hoi4link sends the game's own layout
// (state key map_names: every glyph's texture rectangle and where the game put it), and the
// names are drawn exactly there. Offline they are spread along a curve fitted to each
// country's shape instead. State names (optional) appear when zoomed in.

const STATE_FONT = 'system-ui, "Segoe UI", sans-serif';
const NAME_CUTOFF = 260;  // camera height below which the game stops drawing country names

export class Labels {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.map = map;
    this.version = -1;
    this.showCountries = true;
    this.showStates = false;
    this.font = new MapFont(map.look.font, map.look.layers.mapfont);
    this.gameNames = null;  // the game's layout, from setGameNames
  }

  // map_names from hoi4link: {names: [{text, province, glyphs: [[u0,v0,u1,v1, ax,az, bx,bz, cx,cz]]}]}.
  // World z counts rows from the bottom; the client's y from the top. Returns true if changed.
  setGameNames(mn) {
    const list = mn && Array.isArray(mn.names) ? mn.names : null;
    if (!list || !list.length) {
      const had = this.gameNames !== null;
      this.gameNames = null;
      return had;
    }
    const H = this.map.height;
    this.gameNames = list.map((n) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const glyphs = n.glyphs.map((g) => {
        const q = [g[0], g[1], g[2], g[3], g[4], H - g[5], g[6], H - g[7], g[8], H - g[9]];
        const dx = q[6] - q[4], dy = q[7] - q[5];
        for (const [x, y] of [[q[4], q[5]], [q[6], q[7]], [q[8], q[9]], [q[8] + dx, q[9] + dy]]) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        return q;
      });
      // Letter height in map units: the glyph's extent along v.
      const g0 = glyphs[0];
      const size = g0 ? Math.hypot(g0[8] - g0[4], g0[9] - g0[5]) : 0;
      return { text: n.text, glyphs, x0, x1, y0, y1, size };
    });
    return true;
  }

  rebuild() {
    if (this.version === this.map.version) return;
    this.countries = this.map.countryLabels().map((l) => this.layoutCountry(l));
    this.states = this.map.stateLabels();
    this.version = this.map.version;
  }

  // Size and letter spacing in map units: as large as the country's thickness allows, then
  // letters spread out to fill most of its length.
  layoutCountry(l) {
    const text = l.country.name.toUpperCase();
    const glyphs = this.font.layout(text);
    const natural = glyphs.reduce((a, g) => a + g.adv, 0);  // in em
    const gaps = Math.max(1, glyphs.length - 1);
    let size = Math.min(l.thickness * 0.62, (l.length * 0.92) / natural);
    size = Math.max(1.5, size);
    const spare = l.length * 0.92 - natural * size;
    const spacing = glyphs.length > 1 ? Math.min(Math.max(0, spare / gaps), size * 1.1) : 0;
    return { ...l, text, glyphs, size, spacing, natural };
  }

  draw(cam, dpr) {
    this.rebuild();
    const ctx = this.ctx, cv = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const W = this.map.width, view = cam.view;
    const copies = (x, r) => {
      const out = [];
      for (const off of [-W, 0, W]) {
        const s = cam.toScreen(x + off, 0).x;
        if (s + r > -50 && s - r < view.w + 50) out.push(off);
      }
      return out;
    };

    const h = cam.height;
    const show = smooth(NAME_CUTOFF - 20, NAME_CUTOFF + 20, h);
    if (this.showCountries && show > 0.01 && this.font.ready && this.gameNames) {
      for (const n of this.gameNames) {
        const alpha = show * smooth(3, 6, n.size * cam.zoom);
        if (alpha <= 0.01) continue;
        const top = cam.toScreen(0, n.y0).y, bottom = cam.toScreen(0, n.y1).y;
        if (bottom < -50 || top > view.h + 50) continue;
        for (const off of [-W, 0, W]) {
          const l = cam.toScreen(n.x0 + off, 0).x, r = cam.toScreen(n.x1 + off, 0).x;
          if (r > -50 && l < view.w + 50) this.drawGameName(n, cam, off, dpr, alpha);
        }
      }
    } else if (this.showCountries && show > 0.01 && this.font.ready) {
      for (const l of this.countries) {
        const px = l.size * cam.zoom;
        const alpha = show * smooth(4, 7, px);
        if (alpha <= 0.01) continue;
        const half = (l.length / 2 + l.size) * cam.zoom;
        const cy = cam.toScreen(0, l.y).y;
        if (cy + half < -50 || cy - half > view.h + 50) continue;
        for (const off of copies(l.x, half)) this.drawCountry(l, cam, off, dpr, alpha);
      }
    }

    if (this.showStates) {
      const a = 1 - smooth(NAME_CUTOFF - 20, NAME_CUTOFF + 20, h);
      if (a > 0.01) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `600 11px ${STATE_FONT}`;
        ctx.lineJoin = "round";
        for (const s of this.states) {
          const span = Math.sqrt(s.area) * cam.zoom;
          const name = s.state.name;
          if (span < name.length * 6.5) continue;
          const y = cam.toScreen(0, s.y).y;
          if (y < -20 || y > view.h + 20) continue;
          for (const off of copies(s.x, span)) {
            const x = cam.toScreen(s.x + off, 0).x;
            ctx.globalAlpha = a * 0.85;
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(235,230,215,0.35)";
            ctx.strokeText(name, x, y);
            ctx.fillStyle = "rgba(20,20,22,0.85)";
            ctx.fillText(name, x, y);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Each glyph: the atlas rectangle (u0,v0)-(u1,v1) mapped onto the parallelogram whose
  // corners a, b, c the game computed; one affine transform per glyph.
  drawGameName(n, cam, off, dpr, alpha) {
    const ctx = this.ctx, font = this.font;
    const px = n.size * cam.zoom * dpr;  // device px per letter height
    const atlas = font.atlasFor(px / font.size);
    const W = font.width * atlas.scale, H = font.height * atlas.scale;
    ctx.globalAlpha = alpha;
    for (const q of n.glyphs) {
      const a = cam.toScreen(q[4] + off, q[5]);
      const b = cam.toScreen(q[6] + off, q[7]);
      const c = cam.toScreen(q[8] + off, q[9]);
      ctx.setTransform((b.x - a.x) * dpr, (b.y - a.y) * dpr, (c.x - a.x) * dpr, (c.y - a.y) * dpr, a.x * dpr, a.y * dpr);
      ctx.drawImage(atlas.image, q[0] * W, q[1] * H, (q[2] - q[0]) * W, (q[3] - q[1]) * H, 0, 0, 1, 1);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawCountry(l, cam, off, dpr, alpha) {
    const ctx = this.ctx, font = this.font;
    const em = l.size * cam.zoom * dpr;  // device px per em
    const atlas = font.atlasFor(em / font.size);
    ctx.globalAlpha = alpha;
    const total = (l.natural * l.size + l.spacing * (l.glyphs.length - 1)) * cam.zoom;  // css px
    let along = l.mid * cam.zoom - total / 2;
    const vx = -l.uy, vy = l.ux;
    for (const g of l.glyphs) {
      const cw = g.adv * l.size * cam.zoom;
      if (g.box) {
        const a = (along + cw / 2) / cam.zoom;          // map units along the axis
        const b = l.c2 * a * a + l.c1 * a + l.c0;       // offset across it
        const slope = 2 * l.c2 * a + l.c1;
        const s = cam.toScreen(l.x + off + l.ux * a + vx * b, l.y + l.uy * a + vy * b);
        const ang = Math.atan2(l.uy + vy * slope, l.ux + vx * slope);
        const cos = Math.cos(ang), sin = Math.sin(ang);
        ctx.setTransform(cos, sin, -sin, cos, s.x * dpr, s.y * dpr);
        const k = em / font.size;  // device px per font px
        const [x, y, w, h, xo, yo] = g.box;
        const r = atlas.scale;
        ctx.drawImage(atlas.image, x * r, y * r, w * r, h * r,
          (xo - g.adv * font.size / 2) * k, (yo - font.mid) * k, w * k, h * k);
      }
      along += cw + l.spacing * cam.zoom;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

// The game's BMFont map font: glyph boxes plus the atlas at a few sizes (smaller copies
// keep small names from shimmering when drawn far below the atlas size).
class MapFont {
  constructor(def, layer) {
    this.size = Number(def.info.size) || 84;
    this.base = Number(def.info.base) || 70;
    this.chars = new Map(Object.entries(def.chars).map(([k, v]) => [Number(k), v]));
    const H = this.chars.get(72);  // 'H': centre names on the capital letters
    this.mid = H ? H[5] + H[3] / 2 : this.base * 0.55;
    this.kern = new Map(def.kerning.map(([a, b, n]) => [a * 65536 + b, n]));
    this.atlases = [];
    this.ready = false;
    this.load(layer);
  }

  async load(layer) {
    const { w, h, data } = layer;
    this.width = w;
    this.height = h;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += 2) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = data[j];
      rgba[i * 4 + 3] = data[j + 1];
    }
    const full = await createImageBitmap(new ImageData(rgba, w, h), { premultiplyAlpha: "premultiply" });
    this.atlases = [{ image: full, scale: 1 }];
    for (const s of [0.5, 0.25]) {
      const img = await createImageBitmap(full, { resizeWidth: w * s, resizeHeight: h * s, resizeQuality: "high" });
      this.atlases.push({ image: img, scale: s });
    }
    this.ready = true;
    this.onready?.();
  }

  atlasFor(k) {
    // k = device px per font px; pick the smallest copy that is still at least that big.
    let pick = this.atlases[0];
    for (const a of this.atlases) if (a.scale >= k * 1.2) pick = a;
    return pick;
  }

  // Text -> [{box, adv (em)}], kerning applied to the advance.
  layout(text) {
    const out = [];
    const cps = [...text].map((c) => c.codePointAt(0));
    cps.forEach((cp, i) => {
      const c = this.chars.get(cp) || this.chars.get(63);  // '?' for missing glyphs
      if (!c) return;
      const kern = i + 1 < cps.length ? this.kern.get(cp * 65536 + cps[i + 1]) || 0 : 0;
      out.push({ box: cp === 32 ? null : c, adv: (c[6] + kern) / this.size });
    });
    return out;
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
