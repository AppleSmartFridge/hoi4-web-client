// WebGL2 map renderer, modelled on the game's own map shaders (gfx/FX/pdxmap.shader,
// pdxwater.shader, border.shader, standardfuncsgfx.fxh) so it looks like vanilla:
//
//   land    terrain atlas tiles picked per pixel from terrain.bmp, blended between the four
//           nearest pixels, overlaid with the colour map (COLORMAP_OVERLAY_STRENGTH 0.75)
//           and lit through the relief normals plus the atlas' own normals
//   owners  "gradient borders": the owner's colour is strongest along its border and fades
//           towards the interior; how far it fills depends on camera height, exactly as
//           gradient_border_process_channel does it, including the darker inner edge
//   water   water colour map at half brightness, the sea bed showing through in shallows,
//           a flat reflection, the 20 % darkening, a soft shore taken from the height map
//   lines   country, state, province, sea and wasteland borders drawn with the game's own
//           border strip textures, fading by camera height like the defines say
//
// The province bitmap lives on the GPU as one uint16 id per texel, with small lookup
// textures for each province's state, owner and type and each owner's colour. Borders come
// from the 2x2 nearest texels compared at three levels (owner, state, province): the
// bilinear "same region" field gives a smooth boundary and its gradient the distance to it
// in screen pixels. Zoomed out, the test runs on a coarser lattice so lines don't break up.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2DArray;

uniform usampler2D uIds;      // province id per map pixel
uniform usampler2D uProv;     // per province: state, owner, type, flags (256 wide)
uniform usampler2D uTerrain;  // atlas tile per map pixel (255 = water)
uniform sampler2D uColors;    // per owner: rgb (sRGB) + band thickness in a (1024 x 1)
uniform sampler2D uField;     // distance to another owner, 1/8 px
uniform sampler2D uColormap;  // terrain colour map (sRGB)
uniform sampler2D uNormal;    // relief normals
uniform sampler2D uHeight;    // height map (half res)
uniform sampler2D uWater;     // water colour map (sRGB)
uniform sampler2D uUnder;     // sea-bed texture (sRGB, tiled)
uniform sampler2D uRiver;     // rivers: coverage, width class
uniform sampler2DArray uAtlas;   // 16 terrain tiles (sRGB)
uniform sampler2DArray uAtlasN;  // their normals
uniform sampler2DArray uBorder;  // border strips: country, state, province, sea, wasteland
uniform vec2 uMap;            // map size in texels
uniform vec2 uView;           // viewport in device pixels
uniform vec2 uCenter;         // camera centre in map texels
uniform float uZoom;          // device pixels per texel
uniform float uDpr;
uniform float uCamH;          // camera height in game units (50 near ... 3000 far)
uniform int uHoverState;
uniform int uSelState;
uniform int uHoverProv;

out vec4 outColor;

const float OVERLAY = 0.75;                       // COLORMAP_OVERLAY_STRENGTH
const float GB_CUTOFF = 0.973;                    // GRADIENT_BORDERS_OUTLINE_CUTOFF_COUNTRY
const float DESATURATE = 0.85;                    // terrain hue removed under country colours
const vec3 REFLECTION = vec3(0.03, 0.065, 0.13);   // stands in for the sky cube map
const vec3 SKY_EDGE = vec3(0.02, 0.025, 0.035);
const vec3 RIVER = vec3(0.035, 0.085, 0.16);

vec3 toGamma(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

// GetOverlay(): overlay blend in gamma space.
vec3 overlay(vec3 col, vec3 ov, float k) {
  vec3 a = toGamma(col), b = toGamma(ov);
  vec3 r = mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, b));
  return mix(col, toLinear(r), k);
}

// RotateVectorByVector(): puts a tangent-space normal onto the relief normal.
vec3 rotateBy(vec3 n, vec3 t) {
  vec3 x = normalize(cross(n, vec3(0, 0, 1)));
  vec3 y = normalize(cross(x, n));
  return x * t.x + n * t.y + y * t.z;
}

int idAt(ivec2 t) {
  t.x = int(mod(float(t.x), uMap.x));
  t.y = clamp(t.y, 0, int(uMap.y) - 1);
  return int(texelFetch(uIds, t, 0).r);
}
int tileAt(ivec2 t) {
  t.x = int(mod(float(t.x), uMap.x));
  t.y = clamp(t.y, 0, int(uMap.y) - 1);
  int v = int(texelFetch(uTerrain, t, 0).r);
  return v > 15 ? 9 : v;
}
uvec4 info(int id) { return texelFetch(uProv, ivec2(id & 255, id >> 8), 0); }

// One level of the 2x2 test: which corner wins, the runner-up corner, and the distance
// (device px) to their boundary.
void resolve(int k0, int k1, int k2, int k3, vec2 f, float scale, out int win, out int second, out float dpx) {
  int k[4] = int[4](k0, k1, k2, k3);
  float w[4] = float[4]((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  vec2 g[4] = vec2[4](vec2(-(1.0 - f.y), -(1.0 - f.x)), vec2(1.0 - f.y, -f.x), vec2(-f.y, 1.0 - f.x), vec2(f.y, f.x));
  float F[4];
  vec2 G[4];
  for (int c = 0; c < 4; c++) {
    F[c] = 0.0; G[c] = vec2(0);
    for (int d = 0; d < 4; d++) if (k[d] == k[c]) { F[c] += w[d]; G[c] += g[d]; }
  }
  win = 0;
  for (int c = 1; c < 4; c++) if (F[c] > F[win]) win = c;
  second = -1;
  for (int c = 0; c < 4; c++) if (k[c] != k[win] && (second < 0 || F[c] > F[second])) second = c;
  if (second < 0) { dpx = 1e6; return; }
  dpx = (F[win] - F[second]) / max(length(G[win] - G[second]), 1e-4) * scale;
}

// Distance (device px) from m to the nearest pixel edge where the state changes, at
// lattice step S. Unlike resolve() this keeps the map's square pixel corners: state lines
// follow province edges exactly instead of rounding them off.
int stateKey(ivec2 t) {
  uvec4 v = info(idAt(t));
  return v.z == 1u ? int(v.x) : 0;
}
float stateEdge(vec2 m, float S, float scale) {
  vec2 p = m / S;
  vec2 cell = floor(p), fr = p - cell;
  int k = stateKey(ivec2((cell + 0.5) * S));
  if (k == 0) return 1e6;
  float best = 1e6;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    if (dx == 0 && dy == 0) continue;
    int n = stateKey(ivec2((cell + vec2(dx, dy) + 0.5) * S));
    if (n == k || n == 0) continue;
    vec2 g = vec2(dx < 0 ? fr.x : dx > 0 ? 1.0 - fr.x : 0.0, dy < 0 ? fr.y : dy > 0 ? 1.0 - fr.y : 0.0);
    best = min(best, (dx != 0 && dy != 0) ? length(g) : max(g.x, g.y));
  }
  return best * scale;
}

// A border strip like the game's meshes: BORDER_WIDTH (1.5) map units wide, never thinner
// than minPx device pixels, sampled across from its texture.
vec4 strip(float layer, float dpx, float minPx, vec2 m) {
  float w = max(1.5 * uZoom, minPx);
  float across = 0.5 + dpx / w;
  if (across >= 1.0) return vec4(0);
  vec4 c = texture(uBorder, vec3((m.x + m.y) * 0.4 / 1.5, across, layer));
  c.rgb = toLinear(c.rgb);
  return c;
}

float camDistance(float lo, float hi) { return (clamp(uCamH, lo, hi) - lo) / (hi - lo); }

// The game's gradient-border texture value at distance d (map px) from the owner's edge:
// 255, 254, 253 over the first two pixels (GRADIENT_BORDERS_COUNTRY_CENTER_THICKNESS), then
// falling from below the outline cutoff to 0 across the band thickness T.
float gbAlpha(float d, float T) {
  if (d < 2.0) return (255.0 - d) / 255.0;
  return 247.0 / 255.0 * clamp(1.0 - (d - 2.0) / max(T - 2.0, 1.0), 0.0, 1.0);
}

// gradient_border_process_channel() for one owner. Returns the colour mix and writes the
// strength used.
vec3 gradientBorder(vec3 base, vec3 owner, float d, float T, float camDist, float cutoff, float outlineMult) {
  float a = gbAlpha(d, T);
  float fill, outline = 0.0, thick = 0.0;
  if (a >= cutoff) {
    outline = (1.0 - (a - cutoff) / (1.0 - cutoff)) * outlineMult;
    fill = 0.0;
  } else {
    float v = 1.0 - a / cutoff;
    fill = 1.0 - clamp(v * (camDist - 0.05) / 0.25, 0.0, 1.0);
    // The darker inner edge (vThick): a thin band just inside the cutoff. Its exact place
    // is under a pixel wide in the game's texture; keep it at least a device pixel.
    float dpx = (d - 2.0) * uZoom;
    float half_ = max(0.55, 0.45 * uZoom);
    thick = (1.0 - smoothstep(half_ - 0.5, half_ + 0.5, abs(dpx - half_))) * smoothstep(0.25, 0.9, uZoom);
  }
  float k = max(max(fill, outline), thick);
  vec3 c = mix(base, owner, k);
  c = mix(c, c * 0.5, thick);
  float opacity = 1.0 + (1.0 - camDist) * (0.85 - 1.0);  // GB_OPACITY_NEAR .. FAR
  return mix(base, c, opacity);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y);
  vec2 m = uCenter + (frag - 0.5 * uView) / uZoom;
  if (m.y < 0.0 || m.y >= uMap.y) {
    outColor = vec4(SKY_EDGE, 1.0);
    return;
  }
  vec2 uv = vec2(fract(m.x / uMap.x), m.y / uMap.y);

  // --- Province lookups (2x2, coarser lattice when zoomed out) ----------------------
  float S = exp2(max(0.0, ceil(log2(1.0 / max(uZoom, 1e-3)))));
  vec2 p = m / S - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  int c[4];
  c[0] = idAt(ivec2((i0 + vec2(0.5, 0.5)) * S));
  c[1] = idAt(ivec2((i0 + vec2(1.5, 0.5)) * S));
  c[2] = idAt(ivec2((i0 + vec2(0.5, 1.5)) * S));
  c[3] = idAt(ivec2((i0 + vec2(1.5, 1.5)) * S));
  uvec4 q[4];
  int ok[4], sk[4], wk[4];
  for (int i = 0; i < 4; i++) {
    q[i] = info(c[i]);
    bool land = q[i].z == 1u;
    bool waste = land && (q[i].w & 1u) != 0u;
    ok[i] = land ? int(q[i].y) + 1 : 0;                    // owner key (water 0)
    sk[i] = land ? int(q[i].x) : 0;                        // state key
    wk[i] = waste ? 1 : 0;                                 // wasteland or not
  }
  float scale = uZoom * S;
  int ow, os, sw, ss, pw, ps, ww, ws;
  float od, sd, pd, wd;
  resolve(ok[0], ok[1], ok[2], ok[3], f, scale, ow, os, od);
  resolve(sk[0], sk[1], sk[2], sk[3], f, scale, sw, ss, sd);
  resolve(c[0], c[1], c[2], c[3], f, scale, pw, ps, pd);
  resolve(wk[0], wk[1], wk[2], wk[3], f, scale, ww, ws, wd);
  uvec4 qi = q[ow];
  bool land = qi.z == 1u;
  bool waste = land && (qi.w & 1u) != 0u;
  int owner = land ? int(qi.y) : 0;  // wasteland shows its owner too, over darker ground

  // --- Terrain ----------------------------------------------------------------------
  vec2 tuv = m / 16.0;  // TERRAIN_TILE_FREQ: a tile repeats every 16 map pixels
  vec2 gx = dFdx(tuv), gy = dFdy(tuv);
  vec2 tp = m - 0.5;
  vec2 t0 = floor(tp), tf = tp - t0;
  ivec2 ti = ivec2(t0);
  int ta = tileAt(ti), tb = tileAt(ti + ivec2(1, 0)), tc = tileAt(ti + ivec2(0, 1)), td = tileAt(ti + ivec2(1, 1));
  vec3 diffuse, tn;
  if (ta == tb && ta == tc && ta == td) {
    diffuse = textureGrad(uAtlas, vec3(tuv, float(ta)), gx, gy).rgb;
    tn = textureGrad(uAtlasN, vec3(tuv, float(ta)), gx, gy).rbg;
  } else {
    diffuse = mix(mix(textureGrad(uAtlas, vec3(tuv, float(ta)), gx, gy).rgb, textureGrad(uAtlas, vec3(tuv, float(tb)), gx, gy).rgb, tf.x),
                  mix(textureGrad(uAtlas, vec3(tuv, float(tc)), gx, gy).rgb, textureGrad(uAtlas, vec3(tuv, float(td)), gx, gy).rgb, tf.x), tf.y);
    tn = mix(mix(textureGrad(uAtlasN, vec3(tuv, float(ta)), gx, gy).rbg, textureGrad(uAtlasN, vec3(tuv, float(tb)), gx, gy).rbg, tf.x),
             mix(textureGrad(uAtlasN, vec3(tuv, float(tc)), gx, gy).rbg, textureGrad(uAtlasN, vec3(tuv, float(td)), gx, gy).rbg, tf.x), tf.y);
  }
  vec3 normal = normalize(texture(uNormal, uv).rbg - 0.5);
  normal = normalize(rotateBy(normal, normalize(tn - 0.5)));
  diffuse = overlay(diffuse, texture(uColormap, uv).rgb, OVERLAY);
  if (waste) diffuse = mix(diffuse, vec3(dot(diffuse, vec3(0.3, 0.59, 0.11))), 0.5) * 0.62;

  // Light: a sun high in the south-east. Shading is relative to flat ground so brightness
  // doesn't drift as you pan, which the game's eye adaptation does for it.
  const vec3 SUN = normalize(vec3(0.35, 0.8, -0.48));
  const float AMBIENT = 0.22;
  float shade = (AMBIENT + max(dot(normal, SUN), 0.0)) / (AMBIENT + SUN.y);

  // --- Gradient borders over land ----------------------------------------------------
  float camDist = 1.0 - clamp(camDistance(100.0, 350.0), 0.0, 0.8);
  float d = texture(uField, uv).r * 255.0 / 8.0;
  vec3 ownerCol = vec3(0);
  float T = 25.0;
  if (owner > 0) {
    vec4 oc = texelFetch(uColors, ivec2(owner, 0), 0);
    ownerCol = toLinear(oc.rgb);
    T = oc.a * 255.0;
  }
  vec3 landCol = diffuse;
  float fillStrength = 0.0;
  if (owner > 0) {
    vec3 before = landCol;
    vec3 tinted = gradientBorder(landCol, ownerCol, d, T, camDist, GB_CUTOFF, 1.0);
    fillStrength = clamp(length(tinted - before) / max(length(ownerCol - before), 1e-3), 0.0, 1.0);
    // The atlas and colour map are warm; under a country colour that reads as a yellow cast.
    // Where the colour is applied, keep the terrain's light and dark but drop most of its hue.
    landCol = mix(landCol, vec3(dot(landCol, vec3(0.2126, 0.7152, 0.0722))), DESATURATE * fillStrength);
    landCol = gradientBorder(landCol, ownerCol, d, T, camDist, GB_CUTOFF, 1.0);
  }
  // The game lights less where the border colour is strong (BORDER_LIGHT_REMOVAL_FACTOR).
  landCol *= mix(shade, 1.0, 0.8 * fillStrength);

  // Hover and selection.
  int st = land ? int(q[sw].x) : -1;
  if (st >= 0 && st == uSelState) landCol = mix(landCol, vec3(1.0), 0.22);
  else if (st >= 0 && st == uHoverState) landCol = mix(landCol, vec3(1.0), 0.10);
  if (c[pw] == uHoverProv && uCamH < 300.0 && land) landCol = mix(landCol, vec3(1.0), 0.06);

  // Rivers: rivers.bmp lines, smoothed by linear filtering, wider for bigger rivers.
  vec2 rv = texture(uRiver, uv).rg;
  if (rv.r > 0.02 && land) {
    float halfW = (0.28 + 0.07 * rv.g * 9.0) * uZoom;            // device px
    float dpx = (1.0 - rv.r) * uZoom;                              // distance from the line
    float a = 1.0 - smoothstep(max(halfW, 0.5) - 0.5, max(halfW, 0.5) + 0.5, dpx);
    a *= clamp(halfW * 1.6, 0.25, 1.0);                            // thin out when far away
    landCol = mix(landCol, RIVER * (0.8 + 0.2 * shade), a * 0.9);
  }

  // --- Water --------------------------------------------------------------------------
  float hb = texture(uHeight, uv).r * 255.0;
  float shore = clamp((hb / 95.7 - 0.954) * 25.0, 0.0, 1.0);
  vec3 col = landCol;
  if (shore < 1.0 || !land) {
    vec3 tint = texture(uWater, uv).rgb * 0.5;                 // WATER_COLOR_LIGHTNESS
    vec3 bed = texture(uUnder, m / 32.0).rgb * shade * 0.7;          // sea bed, tiled every 32 px
    float seen = clamp((hb / 10.0 - 5.3) / (13.0 - 5.3), 0.0, 1.0);
    vec3 water = mix(tint, bed, seen);
    water = mix(water, REFLECTION, 0.5);                       // fresnel, looking down
    if (owner > 0) water = gradientBorder(water, ownerCol, d, T, camDist, GB_CUTOFF * 0.990, 0.0);
    water *= 0.8;                                              // the game's darkness offset
    float wa = land ? 1.0 - shore : 1.0;
    col = mix(landCol, water, wa);
  }

  // --- Border lines ---------------------------------------------------------------------
  float provFade = 1.0 - smoothstep(200.0, 300.0, uCamH);   // PROVINCE_BORDER_FADE_NEAR/FAR
  float stateFade = 1.0 - smoothstep(400.0, 500.0, uCamH);  // STATE_BORDER_FADE_NEAR/FAR
  bool otherLand = ps >= 0 && q[ps].z == 1u;
  bool otherSea = ps >= 0 && q[ps].z == 2u;
  vec4 b;
  if (ps >= 0 && provFade > 0.0) {
    if (land && otherLand) {
      b = strip(2.0, pd, 2.5 * uDpr, m);
      col = mix(col, b.rgb, b.a * provFade);
    } else if (!land && qi.z == 2u && otherSea) {
      b = strip(3.0, pd, 3.0 * uDpr, m);
      col = mix(col, b.rgb, b.a * provFade * 0.6);
    }
  }
  if (stateFade > 0.0) {
    float se = stateEdge(m, S, scale);
    if (se < 1e5) {
      b = strip(1.0, se, 2.0 * uDpr, m);
      col = mix(col, b.rgb, b.a * stateFade);
    }
  }
  if (ws >= 0 && ok[ww] != 0 && ok[ws] != 0) {
    b = strip(4.0, wd, 4.0 * uDpr, m);
    col = mix(col, b.rgb, b.a);
  }
  if (os >= 0 && ok[ow] != 0 && ok[os] != 0) {
    b = strip(0.0, od, 2.5 * uDpr, m);  // was 4 px: read too heavy next to the game
    col = mix(col, b.rgb, b.a);
  }
  // Selected state outline on top.
  if (ss >= 0 && (int(q[sw].x) == uSelState || int(q[ss].x) == uSelState) && sk[sw] != sk[ss]) {
    float w = 2.2 * uDpr;
    col = mix(col, toLinear(vec3(1.0, 0.93, 0.7)), 1.0 - smoothstep(w * 0.5 - 0.6, w * 0.5 + 0.6, sd));
  }
  outColor = vec4(toGamma(col), 1.0);
}`;

const UNIFORMS = ["uIds", "uProv", "uTerrain", "uColors", "uField", "uColormap", "uNormal", "uHeight", "uWater", "uUnder",
  "uRiver", "uAtlas", "uAtlasN", "uBorder", "uMap", "uView", "uCenter", "uZoom", "uDpr", "uCamH", "uHoverState", "uSelState", "uHoverProv"];
const SAMPLERS = ["uIds", "uProv", "uTerrain", "uColors", "uField", "uColormap", "uNormal", "uHeight", "uWater", "uUnder",
  "uRiver", "uAtlas", "uAtlasN", "uBorder"];
const BORDERS = ["border_country", "border_state", "border_province", "border_sea", "border_impassable"];

export class MapRenderer {
  constructor(canvas, map, borderField) {
    this.canvas = canvas;
    this.map = map;
    this.borderField = borderField;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("This browser doesn't support WebGL 2.");
    this.gl = gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (map.width > max || map.height > max) throw new Error(`The map needs ${map.width}px textures; this GPU allows ${max}px.`);
    if (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) < SAMPLERS.length) throw new Error("This GPU has too few texture units.");
    this.prog = program(gl, VERT, FRAG);
    this.loc = {};
    for (const u of UNIFORMS) this.loc[u] = gl.getUniformLocation(this.prog, u);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const aPos = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const L = map.look.layers;
    const T = {};
    T.uIds = tex2d(gl, gl.R16UI, map.width, map.height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, map.ids, gl.NEAREST);
    this.provRows = Math.ceil(map.provinceCount / 256);
    this.provData = new Uint16Array(256 * this.provRows * 4);
    T.uProv = tex2d(gl, gl.RGBA16UI, 256, this.provRows, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, this.provData, gl.NEAREST);
    T.uTerrain = tex2d(gl, gl.R8UI, L.terrain.w, L.terrain.h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, L.terrain.data, gl.NEAREST);
    this.colorData = new Uint8Array(1024 * 4);
    T.uColors = tex2d(gl, gl.RGBA8, 1024, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.colorData, gl.NEAREST);
    T.uField = tex2d(gl, gl.R8, map.width, map.height, gl.RED, gl.UNSIGNED_BYTE, null, gl.LINEAR, gl.REPEAT);
    T.uColormap = tex2d(gl, gl.SRGB8, L.colormap.w, L.colormap.h, gl.RGB, gl.UNSIGNED_BYTE, L.colormap.data, gl.LINEAR, gl.REPEAT);
    T.uNormal = tex2d(gl, gl.RGB8, L.normal.w, L.normal.h, gl.RGB, gl.UNSIGNED_BYTE, L.normal.data, gl.LINEAR, gl.REPEAT);
    T.uHeight = tex2d(gl, gl.R8, L.height.w, L.height.h, gl.RED, gl.UNSIGNED_BYTE, L.height.data, gl.LINEAR, gl.REPEAT);
    T.uWater = tex2d(gl, gl.SRGB8_ALPHA8, L.water.w, L.water.h, gl.RGBA, gl.UNSIGNED_BYTE, L.water.data, gl.LINEAR, gl.REPEAT);
    T.uUnder = tex2d(gl, gl.SRGB8_ALPHA8, L.underwater.w, L.underwater.h, gl.RGBA, gl.UNSIGNED_BYTE, rgba(L.underwater.data), gl.LINEAR, gl.REPEAT, true);
    T.uRiver = tex2d(gl, gl.RG8, L.rivers.w, L.rivers.h, gl.RG, gl.UNSIGNED_BYTE, L.rivers.data, gl.LINEAR, gl.REPEAT);
    T.uAtlas = texArray(gl, gl.SRGB8_ALPHA8, L.atlas.w, L.atlas.h, L.atlas.layers, rgba(L.atlas.data), true);
    T.uAtlasN = texArray(gl, gl.RGBA8, L.atlas_normal.w, L.atlas_normal.h, L.atlas_normal.layers, rgba(L.atlas_normal.data), true);
    T.uBorder = texArray(gl, gl.RGBA8, 128, 64, BORDERS.length, borderStrips(L), false);
    this.tex = T;
    this.uploaded = -1;
    this.hoverState = -1;
    this.selState = -1;
    this.hoverProv = -1;
  }

  // Re-uploads the lookup tables and the border field when ownership changed.
  sync() {
    const map = this.map;
    if (this.uploaded === map.version) return;
    const field = this.borderField(map);
    const d = this.provData;
    for (let p = 0; p < map.provinceCount; p++) {
      const s = map.stateOf[p];
      const st = s ? map.states.get(s) : null;
      d[p * 4] = s;
      d[p * 4 + 1] = map.provinceOwner[p];
      d[p * 4 + 2] = map.type[p];
      d[p * 4 + 3] = st && st.impassable ? 1 : 0;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.uProv);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, this.provRows, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, d);
    this.colorData.fill(0);
    for (const c of map.countryList) {
      if (!c || c.index >= 1024) continue;
      this.colorData.set([c.color[0], c.color[1], c.color[2], Math.round(field.thickness[c.index] || 25)], c.index * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex.uColors);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.colorData);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.uField);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, map.width, map.height, gl.RED, gl.UNSIGNED_BYTE, field.data);
    this.uploaded = map.version;
  }

  draw(camera, dpr) {
    this.sync();
    const gl = this.gl, c = this.canvas;
    gl.viewport(0, 0, c.width, c.height);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    SAMPLERS.forEach((name, i) => {
      const t = this.tex[name];
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(t.array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, t);
      gl.uniform1i(this.loc[name], i);
    });
    gl.uniform2f(this.loc.uMap, this.map.width, this.map.height);
    gl.uniform2f(this.loc.uView, c.width, c.height);
    gl.uniform2f(this.loc.uCenter, camera.x, camera.y);
    gl.uniform1f(this.loc.uZoom, camera.zoom * dpr);
    gl.uniform1f(this.loc.uDpr, dpr);
    gl.uniform1f(this.loc.uCamH, camera.height);
    gl.uniform1i(this.loc.uHoverState, this.hoverState);
    gl.uniform1i(this.loc.uSelState, this.selState);
    gl.uniform1i(this.loc.uHoverProv, this.hoverProv);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(p));
  return p;
}

function tex2d(gl, internal, w, h, format, type, data, filter, wrapS = gl.CLAMP_TO_EDGE, mips = false) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mips ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  return t;
}

function texArray(gl, internal, w, h, layers, data, mips) {
  const t = gl.createTexture();
  t.array = true;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, internal, w, h, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, mips ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  return t;
}

// RGB bytes -> RGBA bytes.
function rgba(rgb) {
  const n = rgb.length / 3, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// The border strip textures, resampled to one 128 x 64 size so they fit a texture array.
function borderStrips(L) {
  const W = 128, H = 64, out = new Uint8Array(W * H * 4 * BORDERS.length);
  BORDERS.forEach((name, k) => {
    const s = L[name];
    for (let y = 0; y < H; y++) {
      const sy = Math.min(s.h - 1, Math.floor(((y + 0.5) * s.h) / H));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(s.w - 1, Math.floor(((x + 0.5) * s.w) / W));
        const o = (k * W * H + y * W + x) * 4, i = (sy * s.w + sx) * 4;
        out[o] = s.data[i]; out[o + 1] = s.data[i + 1]; out[o + 2] = s.data[i + 2]; out[o + 3] = s.data[i + 3];
      }
    }
  });
  return out;
}
