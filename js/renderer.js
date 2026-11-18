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
//           a flat reflection, the 20 % darkening; the coast is a blurred land mask's contour
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
uniform usampler2D uProv;     // per province: state, owner, type, flags | controller << 1 (256 wide)
uniform usampler2D uTerrain;  // atlas tile per map pixel (255 = water)
uniform sampler2D uColors;    // per owner: rgb (sRGB) + band thickness in a (1024 x 1)
uniform sampler2D uField;     // distance to another owner, 1/8 px
uniform sampler2D uColormap;  // terrain colour map (sRGB)
uniform sampler2D uNormal;    // relief normals
uniform sampler2D uHeight;    // height map (half res)
uniform sampler2D uLand;      // land mask blurred (landMask below): the coastline is its 0.5 contour
uniform sampler2D uWater;     // water colour map (sRGB)
uniform sampler2D uUnder;     // sea-bed texture (sRGB, tiled)
uniform sampler2D uRiver;     // rivers: coverage, width class, river-on-border width (riverTexture)
uniform sampler2DArray uAtlas;   // 16 terrain tiles (sRGB)
uniform sampler2DArray uAtlasN;  // their normals
uniform sampler2DArray uBorder;  // border strips: country, state, province, sea, wasteland
uniform vec2 uMap;            // map size in texels
uniform vec2 uView;           // viewport in device pixels
uniform vec3 uCam;            // camera position (map texels; z up)
uniform vec3 uFwd;            // view direction; screen right is +x
uniform vec3 uUp;             // screen up
uniform float uFocal;         // focal length in device pixels
uniform float uRelief;        // height-map scale (game units: value / 10 above the 9.5 sea level)
float uZoom;                  // device pixels per texel where this pixel lands (set in main)
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
const vec3 SEA_HAZE = vec3(0.10, 0.13, 0.21);      // the game's sea reads as a hazy grey-blue
const vec3 SHALLOW = vec3(0.22, 0.42, 0.52);       // light rim of shallow water along coasts
const float LAND_DARKEN = 0.92;                    // the game's land is darker than the raw atlas
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
float riverEdgeAt(ivec2 t) {
  t.x = int(mod(float(t.x), uMap.x));
  t.y = clamp(t.y, 0, int(uMap.y) - 1);
  return texelFetch(uRiver, t, 0).b;
}

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

// Province lines with rounder corners than resolve(): a cubic B-spline "same province"
// field over 4x4 lattice points instead of a bilinear one over 2x2. Gives the two
// provinces either side of the nearest boundary and the distance to it (device px).
// mode 0 keys texels by province id, mode 1 by owner (owner index + 1 on land, 0 for water),
// which rounds coastlines and country shapes the same way. winId/secondId: a province of each.
int roundKey(int id, int mode) {
  if (mode == 0) return id;
  uvec4 v = info(id);
  return v.z == 1u ? int(v.y) + 1 : 0;
}
void resolveRound(vec2 m, float S, float scale, int mode, out int win, out int second, out int winId, out int secondId, out float dpx) {
  vec2 p = m / S - 0.5;
  vec2 i0 = floor(p), t = p - i0;
  vec4 wx, wy, dx, dy;
  for (int a = 0; a < 2; a++) {
    float u = a == 0 ? t.x : t.y, v = 1.0 - u;
    vec4 w = vec4(v * v * v, 3.0 * u * u * u - 6.0 * u * u + 4.0, -3.0 * u * u * u + 3.0 * u * u + 3.0 * u + 1.0, u * u * u) / 6.0;
    vec4 d = vec4(-v * v, 3.0 * u * u - 4.0 * u, -3.0 * u * u + 2.0 * u + 1.0, u * u) / 2.0;
    if (a == 0) { wx = w; dx = d; } else { wy = w; dy = d; }
  }
  int k[16], ids[16];
  float w[16];
  vec2 g[16];
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    int n = j * 4 + i;
    ids[n] = idAt(ivec2((i0 + vec2(i - 1, j - 1) + 0.5) * S));
    k[n] = roundKey(ids[n], mode);
    w[n] = wx[i] * wy[j];
    g[n] = vec2(dx[i] * wy[j], wx[i] * dy[j]);
  }
  float bestF = -1.0, secondF = -1.0;
  vec2 bestG = vec2(0), secondG = vec2(0);
  win = -1; second = -1; winId = 0; secondId = 0;
  for (int a = 0; a < 16; a++) {
    bool seen = false;
    for (int b = 0; b < a; b++) if (k[b] == k[a]) seen = true;
    if (seen) continue;
    float F = 0.0;
    vec2 G = vec2(0);
    for (int b = a; b < 16; b++) if (k[b] == k[a]) { F += w[b]; G += g[b]; }
    if (F > bestF) {
      second = win; secondF = bestF; secondG = bestG; secondId = winId;
      win = k[a]; bestF = F; bestG = G; winId = ids[a];
    } else if (F > secondF) {
      second = k[a]; secondF = F; secondG = G; secondId = ids[a];
    }
  }
  if (second < 0) { dpx = 1e6; return; }
  dpx = (bestF - secondF) / max(length(bestG - secondG), 1e-4) * scale;
}

// Cubic B-spline sample of a single-channel texture from 4 bilinear taps: the gradient
// band's edges come out round instead of following the pixel grid.
vec4 bspline(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s3 = n * n * n;
  float x = s3.x, y = s3.y - 4.0 * s3.x, z = s3.z - 4.0 * s3.y + 6.0 * s3.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}
float textureBicubic(sampler2D tex, vec2 uv, vec2 size) {
  vec2 tc = uv * size - 0.5;
  vec2 fr = fract(tc);
  tc -= fr;
  vec4 xc = bspline(fr.x), yc = bspline(fr.y);
  vec4 c = tc.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s4 = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = (c + vec4(xc.yw, yc.yw) / s4) / size.xxyy;
  float a = texture(tex, o.xz).r, b = texture(tex, o.yz).r, cc = texture(tex, o.xw).r, d = texture(tex, o.yw).r;
  float sx = s4.x / (s4.x + s4.y), sy = s4.z / (s4.z + s4.w);
  return mix(mix(d, cc, sx), mix(b, a, sx), sy);
}

// A border strip like the game's meshes: BORDER_WIDTH (1.5) map units wide, kept between
// minPx and maxPx device pixels, sampled across from its texture.
vec4 stripW(float layer, float dpx, float minPx, float maxPx, vec2 m) {
  float w = clamp(1.5 * uZoom, minPx, maxPx);
  float across = 0.5 + dpx / w;
  if (across >= 1.0) return vec4(0);
  vec4 c = texture(uBorder, vec3((m.x + m.y) * 0.4 / 1.5, across, layer));
  c.rgb = toLinear(c.rgb);
  return c;
}
vec4 strip(float layer, float dpx, float minPx, vec2 m) { return stripW(layer, dpx, minPx, 1e4, m); }

float camDistance(float lo, float hi) { return (clamp(uCamH, lo, hi) - lo) / (hi - lo); }

// The game's gradient-border texture value at distance d (map px) from the owner's edge:
// 255, 254, 253 over the first two pixels (GRADIENT_BORDERS_COUNTRY_CENTER_THICKNESS), then
// falling from below the outline cutoff to 0 across the band thickness T.
// Everything is in map px, so the band scales with the map as in the game.
float gbAlpha(float d, float T) {
  const float c = 2.0;
  if (d < c) return (255.0 - 2.0 * d / c) / 255.0;
  return 247.0 / 255.0 * clamp(1.0 - (d - c) / max(T - c, 1.0), 0.0, 1.0);
}

// gradient_border_process_channel() for one owner. Returns the colour mix and writes the
// strength used.
vec3 gradientBorder(vec3 base, vec3 owner, float d, float T, float camDist, float cutoff, float outlineMult) {
  float a = gbAlpha(d, T);
  float fill, outline = 0.0, thick = 0.0;
  if (a >= cutoff) {
    // The edge strip (first 2 map px): full colour, its outer part darkened, which is how
    // the game's borders read (its 9-tap sampling pulls the edge texels under the cutoff).
    outline = outlineMult;
    fill = 0.0;
    float w = max(0.75, 3.0 / max(uZoom, 1e-3));                   // map px, at least ~3 device px
    thick = outlineMult * (1.0 - clamp((d - w) * uZoom + 0.5, 0.0, 1.0));  // antialiased over a device px
  } else {
    float v = 1.0 - a / cutoff;
    fill = 1.0 - clamp(v * (camDist - 0.05) / 0.25, 0.0, 1.0);
    // (The game's vThick just inside the cutoff would draw a second dark line 2 map px in;
    // its dark edge reads as being on the border, which the strip above does.)
  }
  float k = max(max(fill, outline), thick);
  vec3 c = mix(base, owner, k);
  c = mix(c, c * 0.5, thick);
  float opacity = 1.0 + (1.0 - camDist) * (0.85 - 1.0);  // GB_OPACITY_NEAR .. FAR
  return mix(base, c, opacity);
}

// Ground height above sea level at a map point (the land is a mesh over the height map in
// the game; sea and anything below it sit at the water's level).
float relief(vec2 xy) {
  float h = texture(uHeight, vec2(fract(xy.x / uMap.x), xy.y / uMap.y)).r * 25.5;
  return max(h - 9.5, 0.0) * uRelief;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y);
  vec2 dd = frag - 0.5 * uView;
  vec3 dir = uFwd * uFocal + vec3(dd.x, 0.0, 0.0) - uUp * dd.y;
  if (dir.z > -1e-4) { outColor = vec4(SKY_EDGE, 1.0); return; }
  // Sea level first: gives the local scale for line widths. Then march down the ray from
  // the highest possible ground to sea level and refine the first hit.
  float k0 = -uCam.z / dir.z;
  vec3 g0 = uCam + k0 * dir;
  uZoom = uFocal / max(dot(g0 - uCam, uFwd), 1e-3);
  vec2 m = g0.xy;
  if (uRelief > 0.0) {
    float top = 16.0 * uRelief;
    float kTop = (top - uCam.z) / dir.z;
    float span = length((kTop - k0) * dir.xy);                  // texels crossed
    int n = int(clamp(span * 0.75, 1.0, 64.0));
    float kPrev = kTop, kHit = k0;
    for (int i = 1; i <= 64; i++) {
      if (i > n) break;
      float k = mix(kTop, k0, float(i) / float(n));
      vec3 P = uCam + k * dir;
      if (P.z <= relief(P.xy)) {
        float a = kPrev, b = k;
        for (int j = 0; j < 6; j++) {
          float mid = 0.5 * (a + b);
          vec3 Q = uCam + mid * dir;
          if (Q.z <= relief(Q.xy)) b = mid; else a = mid;
        }
        kHit = b;
        break;
      }
      kPrev = k;
    }
    m = (uCam + kHit * dir).xy;
  }
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
  int sw, ss, pw, ps, ww, ws;
  float od, sd, pd, wd;
  int okw, oks, owi, osi;
  resolveRound(m, S, scale, 1, okw, oks, owi, osi, od);  // coastline and owners, rounded like the game's
  resolve(sk[0], sk[1], sk[2], sk[3], f, scale, sw, ss, sd);
  resolve(c[0], c[1], c[2], c[3], f, scale, pw, ps, pd);
  resolve(wk[0], wk[1], wk[2], wk[3], f, scale, ww, ws, wd);
  uvec4 qi = info(owi);
  bool land = okw != 0;
  // The coastline is drawn from a blurred land mask (below), which is rounder than the
  // province bitmap: sea it takes in is drawn as the land next to it.
  bool rim = !land && oks > 0 && qi.z != 3u && qi.z != 1u;
  if (rim) qi = info(osi);
  bool waste = land && (qi.w & 1u) != 0u;
  // Colours follow control: occupied land shows its occupier, as in the game.
  // Country lines (ok[]) stay on the owners' borders. Wasteland shows its holder too.
  int owner = land || rim ? int(qi.w >> 1u) : 0;

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
  float d = textureBicubic(uField, uv, uMap) * 255.0 / 8.0;
  vec3 ownerCol = vec3(0);
  float T = 25.0;
  if (owner > 0) {
    vec4 oc = texelFetch(uColors, ivec2(owner, 0), 0);
    ownerCol = toLinear(oc.rgb);
    // The game's political colours read muted and darker than the raw country colours
    // (its post-processing and haze); take some saturation and light out.
    ownerCol = mix(vec3(dot(ownerCol, vec3(0.2126, 0.7152, 0.0722))), ownerCol, 0.85) * 0.88;
    T = oc.a * 255.0;  // 5-25 map px by country size, as in the game
  }
  vec3 landCol = diffuse;
  float fillStrength = 0.0;
  if (owner > 0) {
    vec3 before = landCol;
    vec3 tinted = gradientBorder(landCol, ownerCol, d, T, camDist, GB_CUTOFF, 1.0);
    fillStrength = clamp(length(tinted - before) / max(length(ownerCol - before), 1e-3), 0.0, 1.0);
    // The atlas and colour map are warm; under a country colour that reads as a yellow cast.
    // Where the colour is applied, keep the terrain's light and dark but drop most of its hue.
    // Bright terrain (snow, sand) would show through as white blotches: flatten its
    // brightness too, so the relief comes from the lighting below, as in the game.
    float lum = dot(landCol, vec3(0.2126, 0.7152, 0.0722));
    landCol = mix(landCol, vec3(mix(lum, 0.16, 0.6)), DESATURATE * fillStrength);
    landCol = gradientBorder(landCol, ownerCol, d, T, camDist, GB_CUTOFF, 1.0);
  }
  // The game lights less where the border colour is strong (BORDER_LIGHT_REMOVAL_FACTOR).
  landCol *= mix(shade, 1.0, 0.45 * fillStrength) * LAND_DARKEN;

  // Hover and selection.
  int st = land ? int(q[sw].x) : -1;
  if (st >= 0 && st == uSelState) landCol = mix(landCol, vec3(1.0), 0.22);
  else if (st >= 0 && st == uHoverState) landCol = mix(landCol, vec3(1.0), 0.10);
  if (c[pw] == uHoverProv && uCamH < 300.0 && land) landCol = mix(landCol, vec3(1.0), 0.06);

  // Rivers: rivers.bmp lines, smoothed by linear filtering, wider for bigger rivers.
  // Coverage sampled with a B-spline so wide rivers up close are smooth, not blocky.
  vec2 rv = vec2(textureBicubic(uRiver, uv, uMap), texture(uRiver, uv).g);
  if (rv.r > 0.02 && land) {
    float halfW = (0.28 + 0.07 * rv.g * 9.0) * uZoom;            // device px
    float dpx = (1.0 - rv.r) * uZoom;                              // distance from the line
    float a = 1.0 - smoothstep(max(halfW, 0.5) - 0.5, max(halfW, 0.5) + 0.5, dpx);
    a *= clamp(halfW * 1.6, 0.25, 1.0);                            // thin out when far away
    landCol = mix(landCol, RIVER * (0.8 + 0.2 * shade), a * 0.9);
  }

  // --- Water --------------------------------------------------------------------------
  float hb = texture(uHeight, uv).r * 255.0;
  float lm = textureBicubic(uLand, uv, uMap);
  float shore = clamp((lm - 0.42) / max(fwidth(lm), 1e-4) + 0.5, 0.0, 1.0);  // antialiased; < half keeps islets their size
  vec3 col = landCol;
  if (shore < 1.0 || !(land || rim)) {
    vec3 tint = texture(uWater, uv).rgb * 0.5;                 // WATER_COLOR_LIGHTNESS
    vec3 bed = texture(uUnder, m / 32.0).rgb * shade * 0.7;          // sea bed, tiled every 32 px
    float seen = clamp((hb / 10.0 - 5.3) / (13.0 - 5.3), 0.0, 1.0);
    vec3 water = mix(tint, bed, seen);
    water = mix(water, REFLECTION, 0.5);                       // fresnel, looking down
    if (owner > 0 && land) water = gradientBorder(water, ownerCol, d, T, camDist, GB_CUTOFF * 0.990, 0.0);
    water *= 0.8;                                              // the game's darkness offset
    water = mix(water, SEA_HAZE, 0.35);
    // Shallows by the coast: the height map's shelf (open sea floor is 89) and the last
    // pixels before the coastline.
    float shelf = max(smoothstep(0.0, 0.42, lm), 0.8 * smoothstep(89.5, 94.5, hb) * smoothstep(250.0, 500.0, uCamH));  // shelf only from afar: patchy up close
    water = mix(water, SHALLOW, 0.6 * shelf);
    float wa = land || rim ? 1.0 - shore : 1.0;
    col = mix(landCol, water, wa);
  }

  // --- Border lines ---------------------------------------------------------------------
  float provFade = 1.0 - smoothstep(200.0, 300.0, uCamH);   // PROVINCE_BORDER_FADE_NEAR/FAR
  float stateFade = 1.0 - smoothstep(400.0, 500.0, uCamH);  // STATE_BORDER_FADE_NEAR/FAR
  vec4 b;
  {
    // Province, state and sea-zone lines all follow the same rounded province boundary,
    // so state lines don't step along the pixel grid next to smooth province lines.
    int rw, rs, rwi, rsi;
    float rd;
    resolveRound(m, S, scale, 0, rw, rs, rwi, rsi, rd);
    if (rs >= 0) {
      uvec4 iw = info(rw), is_ = info(rs);
      if (iw.z == 1u && is_.z == 1u) {
        if (iw.x != is_.x) {
          b = strip(1.0, rd, 2.0 * uDpr, m);
          col = mix(col, b.rgb, b.a * max(stateFade, provFade));
        } else {
          b = strip(2.0, rd, 2.5 * uDpr, m);
          col = mix(col, b.rgb, b.a * provFade);
        }
        // A river along this province border: drawn on the border itself, as in the game.
        // Both provinces must carry the mark near here, so a river doesn't spill onto the
        // other borders at a junction.
        ivec2 bp = ivec2(floor(m));
        float ew = 0.0, es = 0.0;
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
          ivec2 t = bp + ivec2(dx, dy);
          int id = idAt(t);
          float e = riverEdgeAt(t);
          if (id == rw) ew = max(ew, e); else if (id == rs) es = max(es, e);
        }
        float re = min(ew, es) > 0.0 ? max(ew, es) : 0.0;
        if (re > 0.0) {
          float cls = (re * 255.0 - 1.0) / 28.0;                       // width class 0-9
          float halfW = (0.28 + 0.07 * cls) * uZoom;
          float a = 1.0 - smoothstep(max(halfW, 0.5) - 0.5, max(halfW, 0.5) + 0.5, rd);
          a *= clamp(halfW * 1.6, 0.25, 1.0);
          col = mix(col, RIVER * (0.8 + 0.2 * shade), a * 0.9);
        }
      } else if (iw.z == 2u && is_.z == 2u) {
        // Sea-zone borders stay when zoomed out, as in the game.
        b = strip(3.0, rd, 1.5 * uDpr, m);
        col = mix(col, b.rgb, b.a * 0.55);
      }
    }
  }
  if (ws >= 0 && ok[ww] != 0 && ok[ws] != 0) {
    b = strip(4.0, wd, 4.0 * uDpr, m);
    col = mix(col, b.rgb, b.a);
  }
  if (oks >= 0 && okw != 0 && oks != 0) {
    b = stripW(0.0, od, 1.5 * uDpr, 2.5 * uDpr, m);  // thinner than the game's 1.5 map units when zoomed in
    col = mix(col, b.rgb, b.a);
  }
  // Selected state outline on top.
  if (ss >= 0 && (int(q[sw].x) == uSelState || int(q[ss].x) == uSelState) && sk[sw] != sk[ss]) {
    float w = 2.2 * uDpr;
    col = mix(col, toLinear(vec3(1.0, 0.93, 0.7)), 1.0 - smoothstep(w * 0.5 - 0.6, w * 0.5 + 0.6, sd));
  }
  outColor = vec4(toGamma(col), 1.0);
}`;

const UNIFORMS = ["uIds", "uProv", "uTerrain", "uColors", "uField", "uColormap", "uNormal", "uHeight", "uLand", "uWater", "uUnder",
  "uRiver", "uAtlas", "uAtlasN", "uBorder", "uMap", "uView", "uCam", "uFwd", "uUp", "uFocal", "uRelief", "uDpr", "uCamH", "uHoverState", "uSelState", "uHoverProv"];
const SAMPLERS = ["uIds", "uProv", "uTerrain", "uColors", "uField", "uColormap", "uNormal", "uHeight", "uLand", "uWater", "uUnder",
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
    T.uLand = tex2d(gl, gl.R8, map.width, map.height, gl.RED, gl.UNSIGNED_BYTE, landMask(map), gl.LINEAR, gl.REPEAT);
    T.uWater = tex2d(gl, gl.SRGB8_ALPHA8, L.water.w, L.water.h, gl.RGBA, gl.UNSIGNED_BYTE, L.water.data, gl.LINEAR, gl.REPEAT);
    T.uUnder = tex2d(gl, gl.SRGB8_ALPHA8, L.underwater.w, L.underwater.h, gl.RGBA, gl.UNSIGNED_BYTE, rgba(L.underwater.data), gl.LINEAR, gl.REPEAT, true);
    T.uRiver = tex2d(gl, gl.RGBA8, L.rivers.w, L.rivers.h, gl.RGBA, gl.UNSIGNED_BYTE, riverTexture(map, L.rivers), gl.LINEAR, gl.REPEAT);
    T.uAtlas = texArray(gl, gl.SRGB8_ALPHA8, L.atlas.w, L.atlas.h, L.atlas.layers, rgba(L.atlas.data), true);
    T.uAtlasN = texArray(gl, gl.RGBA8, L.atlas_normal.w, L.atlas_normal.h, L.atlas_normal.layers, rgba(L.atlas_normal.data), true);
    T.uBorder = texArray(gl, gl.RGBA8, 128, 64, BORDERS.length, borderStrips(L), false);
    this.tex = T;
    this.uploaded = -1;
    this.hoverState = -1;
    this.selState = -1;
    this.hoverProv = -1;
    this.relief = 1.0;  // height-map scale; 0 draws the map flat
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
      d[p * 4 + 3] = (st && st.impassable ? 1 : 0) | (map.provinceController[p] << 1);
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
    const fr = camera.frame();
    gl.uniform3f(this.loc.uCam, fr.C[0], fr.C[1], fr.C[2]);
    gl.uniform3f(this.loc.uFwd, fr.fwd[0], fr.fwd[1], fr.fwd[2]);
    gl.uniform3f(this.loc.uUp, fr.up[0], fr.up[1], fr.up[2]);
    gl.uniform1f(this.loc.uFocal, fr.f * dpr);
    gl.uniform1f(this.loc.uRelief, this.relief);
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

// Land as 0/255 per map pixel, Gaussian-blurred (sigma 1.5 px): the shader draws the coast
// where this crosses half, so corners of the province bitmap come out round, as the game's
// height-map coastline does, and small islands become ovals instead of rounded squares.
// Lakes count as land (their shores keep the province shape). About 0.7 s for the map.
function landMask(map) {
  const W = map.width, H = map.height, ids = map.ids, n = W * H;
  const isLand = new Uint8Array(map.provinceCount);
  for (let p = 0; p < map.provinceCount; p++) isLand[p] = map.type[p] === 1 || map.type[p] === 3 ? 1 : 0;
  const K = [64, 51, 26, 9, 2];  // exp(-k^2 / 4.5) * 64; sum 240
  const h = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = -4; k <= 4; k++) {
        let xx = x + k;
        if (xx < 0) xx += W; else if (xx >= W) xx -= W;  // the map wraps east-west
        if (isLand[ids[row + xx]]) v += K[k < 0 ? -k : k];
      }
      h[row + x] = v;
    }
  }
  const out = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = -4; k <= 4; k++) {
        const yy = Math.min(H - 1, Math.max(0, y + k));
        v += h[yy * W + x] * K[k < 0 ? -k : k];
      }
      const i = y * W + x, o = Math.round(v * 255 / 57600);
      // Sea stays sea: the blur may round land off (islands, capes) but never close a
      // narrow strait or fjord (the Limfjord is 1-3 px wide). Kept under the 0.42 contour.
      out[i] = isLand[ids[i]] ? o : Math.min(o, 77);
    }
  }
  // Tiny islands blur below the contour and would vanish: lift each piece of land whose
  // peak is low so it stays as a small rounded blob.
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = isLand[ids[i]];
  const comp = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  const peaks = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || !land[s]) continue;
    const c = peaks.length;
    let top = 0, peak = 0;
    stack[top++] = s;
    comp[s] = c;
    while (top) {
      const i = stack[--top];
      if (out[i] > peak) peak = out[i];
      const x = i % W;
      let j = x > 0 ? i - 1 : i + W - 1;
      if (land[j] && comp[j] < 0) { comp[j] = c; stack[top++] = j; }
      j = x < W - 1 ? i + 1 : i - W + 1;
      if (land[j] && comp[j] < 0) { comp[j] = c; stack[top++] = j; }
      j = i - W;
      if (j >= 0 && land[j] && comp[j] < 0) { comp[j] = c; stack[top++] = j; }
      j = i + W;
      if (j < n && land[j] && comp[j] < 0) { comp[j] = c; stack[top++] = j; }
    }
    peaks.push(peak);
  }
  for (let i = 0; i < n; i++) {
    const c = comp[i];
    if (c >= 0 && peaks[c] < 160) out[i] = Math.min(255, Math.round(out[i] * 160 / Math.max(peaks[c], 1)));
  }
  return out;
}

// Rivers in the game run along province borders; rivers.bmp has them a pixel or two to
// one side. Finds each stretch of land province border that a river follows and marks
// it (b: 1 + width) so the shader draws the river on the border line itself; those river
// pixels are dropped from the coverage (r). Rivers away from borders stay as drawn.
// A border counts when at least 40 % of it (4 px or more) is within 2 px of a river.
function riverTexture(map, rivers) {
  const W = map.width, H = map.height, n = W * H, ids = map.ids, src = rivers.data;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { out[i * 4] = src[i * 2]; out[i * 4 + 1] = src[i * 2 + 1]; out[i * 4 + 3] = 255; }
  // River presence (1 + width) spread 2 px in each direction.
  const tmp = new Uint8Array(n), near = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = -2; k <= 2; k++) {
        const xx = (x + k + W) % W, j = row + xx;
        if (src[j * 2]) v = Math.max(v, 1 + src[j * 2 + 1]);
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let k = -2; k <= 2; k++) { const yy = y + k; if (yy >= 0 && yy < H) v = Math.max(v, tmp[yy * W + x]); }
    near[y * W + x] = v;
  }
  const land = (id) => map.type[id] === 1;
  const total = new Map(), wet = new Map();
  const pairKey = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
  const visit = (fn) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, a = ids[i];
      if (!land(a)) continue;
      if (x < W - 1) { const j = i + 1, b = ids[j]; if (b !== a && land(b)) fn(i, j, pairKey(a, b)); }
      if (y < H - 1) { const j = i + W, b = ids[j]; if (b !== a && land(b)) fn(i, j, pairKey(a, b)); }
    }
  };
  visit((i, j, k) => {
    total.set(k, (total.get(k) || 0) + 1);
    if (near[i] || near[j]) wet.set(k, (wet.get(k) || 0) + 1);
  });
  const edge = new Uint8Array(n);
  visit((i, j, k) => {
    const w = wet.get(k) || 0;
    if (w < 4 || w < 0.4 * total.get(k)) return;
    const v = Math.max(near[i], near[j]);
    if (!v) return;
    edge[i] = Math.max(edge[i], v);
    edge[j] = Math.max(edge[j], v);
  });
  // Drop river pixels within 2 px of a marked border; mark the border in b.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (edge[i]) out[i * 4 + 2] = Math.min(255, edge[i]);
    if (!src[i * 2]) continue;
    let snapped = false;
    for (let dy = -2; dy <= 2 && !snapped; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -2; dx <= 2; dx++) if (edge[yy * W + (x + dx + W) % W]) { snapped = true; break; }
    }
    if (snapped) out[i * 4] = 0;
  }
  return out;
}
