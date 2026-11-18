// Map data built by tools/mapgen/build_map.py from the player's own game files
// (web/app/data, never committed; or sent by hoi4link, see mapsource.js), plus the live
// ownership the client learns from hoi4link.

export const WATER = 0, LAND = 1, SEA = 2, LAKE = 3;

// source: {get(name) -> Promise<ArrayBuffer>} (mapsource.js).
export async function loadMap(source, onProgress = () => {}) {
  onProgress("Loading map data…");
  const [meta, look] = await Promise.all([json(source, "map.json"), json(source, "look.json")]);
  if (look.format !== 1) throw new MissingData("look.json is from another version; rebuild the map data");
  onProgress("Loading provinces and terrain…");
  const names = Object.keys(look.layers);
  const [ids, ...layers] = await Promise.all([
    inflate(source, "provinces.bin.z"),
    ...names.map((n) => inflate(source, look.layers[n].file)),
  ]);
  const idArr = new Uint16Array(ids);
  if (idArr.length !== meta.width * meta.height) throw new Error("provinces.bin.z doesn't match map.json; rebuild the map data");
  names.forEach((n, i) => {
    const L = look.layers[n];
    L.data = new Uint8Array(layers[i]);
    if (L.data.length !== L.w * L.h * L.channels * (L.layers || 1)) throw new Error(`${L.file} has the wrong size; rebuild the map data`);
  });
  onProgress("Preparing map…");
  const map = new MapModel(meta, idArr);
  map.look = look;
  return map;
}

async function json(source, name) {
  return JSON.parse(new TextDecoder().decode(await source.get(name)));
}

async function inflate(source, name) {
  const buf = await source.get(name);
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
}

export class MissingData extends Error {}

export class MapModel {
  constructor(meta, ids) {
    this.width = meta.width;
    this.height = meta.height;
    this.ids = ids;
    const p = meta.provinces;
    const n = p.type.length;
    this.provinceCount = n;
    this.type = Uint8Array.from(p.type);
    this.stateOf = Uint16Array.from(p.state);
    this.cx = Float32Array.from(p.cx);
    this.cy = Float32Array.from(p.cy);
    this.size = Uint32Array.from(p.size);
    this.bounds = Int32Array.from(p.bounds);

    // Adjacency as CSR arrays.
    const adj = meta.adjacency;
    const deg = new Uint32Array(n + 1);
    for (let i = 0; i < adj.length; i += 2) { deg[adj[i]]++; deg[adj[i + 1]]++; }
    this.adjStart = new Uint32Array(n + 1);
    for (let i = 0, s = 0; i < n; i++) { this.adjStart[i] = s; s += deg[i]; this.adjStart[i + 1] = s; }
    this.adj = new Uint32Array(adj.length);
    const fill = this.adjStart.slice(0, n);
    for (let i = 0; i < adj.length; i += 2) {
      const a = adj[i], b = adj[i + 1];
      this.adj[fill[a]++] = b;
      this.adj[fill[b]++] = a;
    }

    this.states = new Map();
    for (const s of meta.states) this.states.set(s.id, { ...s, startOwner: s.owner });
    this.maxStateId = Math.max(0, ...this.states.keys());

    // Countries get a dense index (0 = nobody) for the GPU colour table.
    this.cosmetics = meta.cosmetics || {};
    this.countries = new Map();
    this.countryList = [null];
    for (const [tag, c] of Object.entries(meta.countries)) this.addCountry(tag, c);

    this.provinceOwner = new Uint16Array(n);  // country index per province
    this.applyOwners();
  }

  addCountry(tag, c = null) {
    if (this.countries.has(tag)) return this.countries.get(tag);
    const entry = {
      tag,
      index: this.countryList.length,
      info: c,
      baseColor: c?.color ?? hashColor(tag),
      cosmetic: c?.cosmetic ?? null,  // the 1936 one until the game says otherwise
      ideology: c?.ideology ?? null,
    };
    this.restyle(entry);
    this.countries.set(tag, entry);
    this.countryList.push(entry);
    return entry;
  }

  // Name and colour as the game picks them: a cosmetic tag's COSMETIC_<ideology> name (else
  // its plain name) and its cosmetic.txt colour win; otherwise TAG_<ideology>, else TAG.
  restyle(e) {
    const c = e.info, cos = e.cosmetic ? this.cosmetics[e.cosmetic] : null;
    const own = c ? c.names?.[e.ideology] ?? c.default_name ?? c.name : e.tag;
    e.name = (cos && (cos.names?.[e.ideology] ?? cos.name)) || own;
    e.color = cos?.color ?? e.baseColor;
  }

  // looks: {TAG: {cosmetic, ideology}} from the game (protocol state key `countries`).
  // Returns true when any name or colour changed.
  setLooks(looks) {
    let changed = false;
    for (const [tag, l] of Object.entries(looks || {})) {
      const e = this.countries.get(tag);
      if (!e || !l) continue;
      const cosmetic = l.cosmetic ?? null, ideology = l.ideology ?? e.ideology;
      if (e.cosmetic === cosmetic && e.ideology === ideology) continue;
      const before = e.name + e.color;
      e.cosmetic = cosmetic;
      e.ideology = ideology;
      this.restyle(e);
      if (e.name + e.color !== before) changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  // owners: Map(stateId -> tag or null). Returns true when anything changed.
  setOwners(owners) {
    let changed = false;
    for (const [id, tag] of owners) {
      const s = this.states.get(id);
      if (!s) continue;
      const t = tag == null ? null : String(tag);
      if (s.owner !== t) { s.owner = t; changed = true; }
    }
    if (changed) this.applyOwners();
    return changed;
  }

  applyOwners() {
    this.provinceOwner.fill(0);
    for (const s of this.states.values()) {
      const c = s.owner ? this.addCountry(s.owner) : null;
      for (const p of s.provinces) if (p < this.provinceCount) this.provinceOwner[p] = c ? c.index : 0;
    }
    this.version = (this.version || 0) + 1;
  }

  provinceAt(x, y) {
    if (y < 0 || y >= this.height) return 0;
    x = ((Math.floor(x) % this.width) + this.width) % this.width;
    return this.ids[Math.floor(y) * this.width + x];
  }

  ownerOfProvince(p) { return this.countryList[this.provinceOwner[p]] || null; }

  // Label geometry for every contiguous land area of each country (big enough to name).
  countryLabels() {
    const n = this.provinceCount, W = this.width;
    const seen = new Uint8Array(n);
    const labels = [];
    const stack = [];
    for (let start = 1; start < n; start++) {
      if (seen[start] || this.type[start] !== LAND) continue;
      const owner = this.provinceOwner[start];
      const comp = [];
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop();
        comp.push(p);
        for (let k = this.adjStart[p]; k < this.adjStart[p + 1]; k++) {
          const q = this.adj[k];
          if (!seen[q] && this.type[q] === LAND && this.provinceOwner[q] === owner) { seen[q] = 1; stack.push(q); }
        }
      }
      if (!owner) continue;
      let area = 0;
      for (const p of comp) area += this.size[p];
      if (area < 900) continue;
      const geo = fitLabel(this, comp, area, W);
      if (geo) labels.push({ country: this.countryList[owner], area, ...geo });
    }
    // Keep only the largest areas of a country plus big secondary ones (colonies, islands).
    const best = new Map();
    for (const l of labels) best.set(l.country.index, Math.max(best.get(l.country.index) || 0, l.area));
    return labels.filter((l) => l.area === best.get(l.country.index) || l.area > 0.15 * best.get(l.country.index) && l.area > 4000);
  }

  stateLabels() {
    const out = [];
    for (const s of this.states.values()) {
      let a = 0, x = 0, y = 0, ref = null;
      for (const p of s.provinces) {
        const w = this.size[p];
        if (!w) continue;
        let px = this.cx[p];
        if (ref === null) ref = px;
        if (px - ref > this.width / 2) px -= this.width; else if (ref - px > this.width / 2) px += this.width;
        a += w; x += px * w; y += this.cy[p] * w;
      }
      if (a) out.push({ state: s, x: x / a, y: y / a, area: a });
    }
    return out;
  }
}

// Weighted PCA of the area's province centroids, then a gentle parabola through them:
// the curved, stretched names the political map uses.
function fitLabel(map, comp, area, W) {
  let ref = map.cx[comp[0]];
  const pts = [];
  for (const p of comp) {
    let x = map.cx[p];
    if (x - ref > W / 2) x -= W; else if (ref - x > W / 2) x += W;
    pts.push([x, map.cy[p], map.size[p]]);
  }
  let mx = 0, my = 0;
  for (const [x, y, w] of pts) { mx += x * w; my += y * w; }
  mx /= area; my /= area;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y, w] of pts) { const dx = x - mx, dy = y - my; sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy; }
  sxx /= area; syy /= area; sxy /= area;
  let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // Prefer reading horizontally: tall, narrow countries still get mostly horizontal names.
  const maxTilt = 1.2;
  if (ang > Math.PI / 2) ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  ang = Math.max(-maxTilt, Math.min(maxTilt, ang));
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  let amin = Infinity, amax = -Infinity, bvar = 0;
  const proj = [];
  for (const [x, y, w] of pts) {
    const dx = x - mx, dy = y - my;
    const a = dx * ux + dy * uy, b = dx * vx + dy * vy;
    const r = Math.sqrt(w) * 0.5;
    amin = Math.min(amin, a - r); amax = Math.max(amax, a + r);
    bvar += w * b * b;
    proj.push([a, b, w]);
  }
  bvar /= area;
  // Weighted least squares b = c2 a^2 + c1 a + c0.
  const s = new Float64Array(5), t = new Float64Array(3);
  for (const [a, b, w] of proj) {
    let ap = 1;
    for (let k = 0; k < 5; k++) { s[k] += w * ap; if (k < 3) t[k] += w * ap * b; ap *= a; }
  }
  const coef = solve3([[s[0], s[1], s[2]], [s[1], s[2], s[3]], [s[2], s[3], s[4]]], [t[0], t[1], t[2]]) || [0, 0, 0];
  const length = (amax - amin) * 0.78;
  const mid = (amin + amax) / 2;
  // Limit the bend: sagitta at most 12% of the length.
  let c2 = coef[2];
  const maxC2 = (0.12 * length) / Math.max(1, (length / 2) ** 2);
  c2 = Math.max(-maxC2, Math.min(maxC2, c2));
  const thickness = Math.max(Math.sqrt(area / Math.max(1, amax - amin)), 2.5 * Math.sqrt(bvar));
  return { x: mx, y: my, ux, uy, mid, length, thickness, c0: coef[0], c1: Math.max(-0.4, Math.min(0.4, coef[1])), c2 };
}

function solve3(m, v) {
  const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return null;
  return [0, 1, 2].map((i) => det(m.map((row, r) => row.map((x, c) => (c === i ? v[r] : x)))) / d);
}

function hashColor(tag) {
  let h = 2166136261;
  for (const ch of tag) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  const f = (n) => { const k = (n + hue * 12) % 12; return 0.55 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

// Gradient-border field, like the game's: for every map pixel, the distance to the nearest
// pixel of another owner (water and unowned land count as "other"), in 1/8 px,
// capped at 255 (~32 px). Two-pass chamfer (1, sqrt 2), about 0.1 s for the whole map.
// Also each owner's band thickness, 5 to 25 px by country area (defines
// GRADIENT_BORDERS_THICKNESS_COUNTRY_LOW/HIGH over FIELD_COUNTRY_LOW/HIGH).
export function borderField(map) {
  const W = map.width, H = map.height, ids = map.ids, n = W * H;
  const keyOf = new Uint16Array(map.provinceCount);
  const area = new Float64Array(map.countryList.length);
  for (let p = 0; p < map.provinceCount; p++) {
    const o = map.type[p] === LAND ? map.provinceOwner[p] : 0;  // wasteland included: it has an owner too
    keyOf[p] = o;
    if (o) area[o] += map.size[p];
  }
  const d = new Uint16Array(n);  // 16 per pixel
  const INF = 65535;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x, k = keyOf[ids[i]];
      const edge = (x > 0 && keyOf[ids[i - 1]] !== k) || (x < W - 1 && keyOf[ids[i + 1]] !== k) ||
        (y > 0 && keyOf[ids[i - W]] !== k) || (y < H - 1 && keyOf[ids[i + W]] !== k);
      d[i] = edge ? 8 : INF;  // edge pixels are half a pixel from the boundary
    }
  }
  for (let y = 1; y < H; y++) {
    const row = y * W;
    for (let x = 1; x < W - 1; x++) {
      const i = row + x;
      let v = d[i];
      const a = d[i - 1] + 16, b = d[i - W] + 16, c = d[i - W - 1] + 23, e = d[i - W + 1] + 23;
      if (a < v) v = a; if (b < v) v = b; if (c < v) v = c; if (e < v) v = e;
      d[i] = v;
    }
  }
  for (let y = H - 2; y >= 0; y--) {
    const row = y * W;
    for (let x = W - 2; x >= 1; x--) {
      const i = row + x;
      let v = d[i];
      const a = d[i + 1] + 16, b = d[i + W] + 16, c = d[i + W + 1] + 23, e = d[i + W - 1] + 23;
      if (a < v) v = a; if (b < v) v = b; if (c < v) v = c; if (e < v) v = e;
      d[i] = v;
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const v = d[i] >> 1; out[i] = v > 255 ? 255 : v; }
  const thickness = new Float32Array(map.countryList.length);
  for (let o = 1; o < thickness.length; o++) {
    const t = Math.min(1, Math.max(0, (area[o] - 300) / (9000 - 300)));
    thickness[o] = 5 + 20 * t;
  }
  return { data: out, thickness, version: map.version };
}
