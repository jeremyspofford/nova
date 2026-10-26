// The Stellar Map's renderer: WebGL2 and procedural shaders, so bodies read as
// photographed, not drawn. Every surface is noise seeded by the body's id, so
// a planet looks the same on every visit. One light: the Nova core.
//
// Colours with meaning (type, selection, starlight, nebula) arrive as tokens
// from the theme. The material constants in the shaders (ocean, rock, ice,
// cloud) describe physical surfaces, not interface colour.
//
// Layers, back to front: far field (stars, Milky Way, haze; rendered once
// into a texture and slid for parallax), twinkling bright stars, nebulae
// (one texture per constellation), threads and orbits, bodies.

const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

const NOISE = `
uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 h3(vec3 i) { return vec3(pcg3(uvec3(ivec3(i) + ivec3(65536)))) * (1.0 / 4294967295.0); }
vec3 grad(vec3 i) { return h3(i) * 2.0 - 1.0; }
float gnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f);
  float b = dot(grad(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float c = dot(grad(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float d = dot(grad(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float e = dot(grad(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float g = dot(grad(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float h = dot(grad(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float k = dot(grad(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm(vec3 p, int oct) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
float ridged(vec3 p, int oct) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * (1.0 - abs(gnoise(p) * 1.8));
    p = p * 2.07 + vec3(4.1, 1.3, 7.7);
    a *= 0.5;
  }
  return s;
}
`;

// ---- far field: stars, the Milky Way, faint haze -------------------------------
const FAR_FS = HEAD + NOISE + `
uniform vec2 uOrigin;   // sky position of this texture's pixel (0,0), css px
uniform float uDpr;
uniform vec3 uSpace, uWarm, uCool, uHazeA, uHazeB;
out vec4 o;
vec3 tempColor(float t) {
  vec3 hot = vec3(0.70, 0.80, 1.00), mid = vec3(1.0, 0.98, 0.95), cool = vec3(1.0, 0.78, 0.52);
  return t < 0.5 ? mix(hot, mid, t * 2.0) : mix(mid, cool, (t - 0.5) * 2.0);
}
void main() {
  vec2 sky = uOrigin + gl_FragCoord.xy / uDpr;
  // The Milky Way: a band across the far field, with dark dust lanes.
  vec2 dir = normalize(vec2(1.0, -0.16));
  float across = dot(sky - vec2(0.0, 40.0), vec2(-dir.y, dir.x));
  float along = dot(sky, dir);
  float wobble = fbm(vec3(along * 0.0016, 2.0, 0.0), 3) * 140.0;
  float band = exp(-pow((across + wobble) / 260.0, 2.0));
  float core = exp(-pow((across + wobble) / 70.0, 2.0));
  float n1 = fbm(vec3(sky * 0.0024, 1.0), 5);
  float n2 = fbm(vec3(sky * 0.0060, 7.0), 4);
  float lanes = smoothstep(0.02, 0.32, fbm(vec3(sky * vec2(0.0035, 0.0065) + n1 * 1.4, 3.0), 5));
  float glow = band * (0.55 + 0.6 * n1) * (1.0 - 0.8 * lanes * band) + core * 0.35 * (1.0 - lanes);
  vec3 col = uSpace;
  col += mix(uCool, uWarm, clamp(0.45 + n2 * 1.4 + core * 0.6, 0.0, 1.0)) * max(glow, 0.0) * 0.56;
  // Faint coloured haze far beyond the nebulae.
  float ha = fbm(vec3(sky * 0.0011, 11.0), 4);
  float hb = fbm(vec3(sky * 0.0015, 23.0), 4);
  col += uHazeA * smoothstep(-0.05, 0.45, ha) * 0.14 + uHazeB * smoothstep(0.0, 0.5, hb) * 0.10;
  // Stars, three magnitudes; denser inside the band.
  vec3 stars = vec3(0.0);
  for (int L = 0; L < 3; L++) {
    float cell = L == 0 ? 3.2 : (L == 1 ? 8.0 : 23.0);
    vec2 g = sky / cell;
    vec2 id = floor(g);
    vec2 f = fract(g);
    vec3 a = h3(vec3(id, float(L) * 97.0 + 13.0));
    vec3 b = h3(vec3(id + 311.0, float(L) * 53.0 + 5.0));
    float keep = L == 0 ? 0.22 + 0.7 * band : (L == 1 ? 0.30 + 0.4 * band : 0.34 + 0.2 * band);
    if (a.z < keep) {
      vec2 c = 0.15 + 0.7 * a.xy;
      float dpx = length((f - c) * cell) * uDpr;
      float mag = L == 0 ? 0.12 + 0.30 * b.x : (L == 1 ? 0.14 + 0.62 * pow(b.x, 4.0) : 0.3 + 1.5 * pow(b.x, 7.0));
      float size = (L == 2 ? 0.5 + 0.9 * pow(b.x, 5.0) : 0.45) * uDpr;
      stars += mag * exp(-dpx * dpx / (size * size)) * tempColor(b.y);
    }
  }
  col += stars;
  o = vec4(col, 1.0);
}`;

// ---- nebula: supernova-remnant filaments in a soft wash ------------------------
const NEB_FS = HEAD + NOISE + `
in vec2 vUv;
uniform float uSeed;
uniform vec3 uA, uB, uC;
out vec4 o;
void main() {
  vec2 p = vUv;
  vec3 s = vec3(uSeed * 0.37, uSeed * 0.11, uSeed * 0.23);
  vec3 q = vec3(p * 1.6, 0.0) + s;
  vec3 w = vec3(fbm(q, 4), fbm(q + vec3(5.2, 1.3, 2.8), 4), 0.0);
  float body = fbm(q + w * 1.6, 6);
  float fil = pow(ridged(q * 1.4 + w * 2.2 + 3.0, 6), 5.0);
  float r = length(p * vec2(1.0, 1.25)) * (1.0 + 0.35 * fbm(q * 0.8 + 9.0, 3));
  float mask = smoothstep(1.0, 0.15, r);
  vec3 col = mix(uA, uB, smoothstep(-0.25, 0.35, body)) * smoothstep(-0.2, 0.5, body) * 0.55;
  col += mix(uB, uC, smoothstep(0.0, 0.6, w.x + 0.3)) * fil * 0.9;
  col *= mask;
  o = vec4(col, 0.0);
}`;

const QUAD_VS = HEAD + `
in vec2 aPos;
uniform vec2 uRes;      // canvas size, device px
uniform vec2 uCenter;   // device px
uniform vec2 uHalf;     // device px
uniform float uAngle;
uniform vec2 uExt;      // the quad spans [-uExt, uExt] in body units
out vec2 vUv;
void main() {
  mat2 R = mat2(cos(uAngle), sin(uAngle), -sin(uAngle), cos(uAngle));
  vec2 px = uCenter + R * (aPos * uHalf);
  vUv = aPos * uExt * vec2(1.0, -1.0);   // body space: y up
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
}`;

const FULL_VS = HEAD + `
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const TEX_FS = HEAD + `
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 o;
void main() { vec2 t = vUv * 0.5 + 0.5; o = texture(uTex, vec2(t.x, 1.0 - t.y)) * uAlpha; }`;

// ---- bodies ---------------------------------------------------------------------
// uType: 1 terran world · 2 rocky world · 3 gas giant · 4 moon · 5 asteroid ·
// 10/11 planetary ring, back/front half · 20 the Nova · 21 a star (goal or
// bright field star) · 22 comet · 23 a new memory's flare
const BODY_FS = HEAD + NOISE + `
in vec2 vUv;
uniform int uType;
uniform vec3 uLight;
uniform vec3 uHue, uHue2, uAtmo;
uniform float uSeed, uSpin, uDim, uSel, uHover, uPx, uTime, uAlpha, uTail, uWarp;
uniform vec3 uSelA, uSelB, uSelC;
uniform vec2 uExt;
out vec4 o;

vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }

// Craters: a cell per crater, rim raised and floor sunk; returns a height.
float craters(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  float hgt = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(x, y, z);
    vec3 r = h3(i + g + 17.0);
    if (r.z > 0.55) continue;
    vec3 d = g + r - f;
    float size = 0.18 + 0.32 * fract(r.x * 7.3 + r.y);
    float t = length(d) / size;
    if (t < 1.4) hgt += (t < 1.0 ? (t * t - 0.8) * 0.55 : 0.0) + 0.25 * exp(-pow((t - 1.0) * 6.0, 2.0));
  }
  return hgt;
}

vec3 tone(vec3 c) { return 1.0 - exp(-c * 1.15); }

float softLight(float ndl) {
  // A soft terminator: light falls off over a band rather than a hard line.
  return smoothstep(-0.10, 0.45, ndl) * clamp(ndl * 0.85 + 0.25, 0.0, 1.0);
}

vec4 selection(vec2 uv, float d) {
  vec3 c = vec3(0.0);
  if (uSel > 0.0) {
    float ring = 1.0 + 7.0 / uPx;
    float line = exp(-pow((d - ring) * uPx / 1.4, 2.0));
    float ang = atan(uv.y, uv.x);
    vec3 edge = mix(uSelB, uSelC, 0.5 + 0.5 * sin(ang * 1.0 + 0.6));
    c += mix(uSelA, edge, 0.35 + 0.25 * sin(ang * 2.0)) * line * 1.1 * uSel;
    c += uSelA * exp(-max(d - ring, 0.0) * uPx / 16.0) * step(ring, d) * 0.22 * uSel;
  }
  if (uHover > 0.0) {
    float ring = 1.0 + 5.0 / uPx;
    c += vec3(0.9) * exp(-pow((d - ring) * uPx / 1.1, 2.0)) * 0.45 * uHover;
  }
  return vec4(c, 0.0);
}

vec4 sphere(vec2 uv) {
  float d = length(uv);
  float aa = 1.6 / uPx;
  float edge = 1.0;
  if (uType == 5) {
    float ang = atan(uv.y, uv.x);
    vec3 ring = vec3(cos(ang), sin(ang), uSeed * 0.01);
    edge = 1.0 - 0.20 * (0.5 + 0.5 * gnoise(ring * 1.2 + uSeed)) - 0.07 * (0.5 + 0.5 * gnoise(ring * 3.1 + uSeed + 4.0));
  }
  vec3 add = vec3(0.0);
  vec4 sel = selection(uv, d);
  if (d > edge + aa) {
    // Outside the disc: atmosphere halo on the lit limb, and a faint glow.
    if (uType == 1 || uType == 3 || uType == 2) {
      vec2 dir = uv / max(d, 1e-4);
      float facing = smoothstep(-0.05, 0.8, dot(dir, normalize(uLight.xy + 1e-4)) + uLight.z * 0.4);
      float halo = exp(-(d - 1.0) * (uType == 2 ? 26.0 : 15.0)) * facing;
      add += uAtmo * halo * (uType == 2 ? 0.3 : 0.75);
      add += uAtmo * exp(-(d - 1.0) * 4.0) * 0.035 * facing;
    }
    return vec4((add + sel.rgb) * (1.0 - uDim * 0.82), 0.0);
  }
  float r = min(d / edge, 1.0);
  vec3 n = normalize(vec3(uv / edge, sqrt(max(1.0 - r * r, 0.0))));
  vec3 p = rotY(rotX(n, 0.38), uSpin);
  vec3 s = vec3(uSeed * 0.13, uSeed * 0.07, uSeed * 0.19);
  vec3 albedo; float wet = 0.0; float rim = 0.0; float cloud = 0.0;
  vec3 bump = vec3(0.0);

  if (uType == 1) {
    // A living world: oceans, continents, deserts, ice caps and weather.
    vec3 q = p * 1.55 + s;
    vec3 w = vec3(fbm(q, 4), fbm(q + vec3(5.2, 1.3, 2.8), 4), fbm(q + vec3(1.7, 9.2, 4.1), 4));
    float h = fbm(q * 1.15 + w * 0.9, 6);
    float lat = abs(p.y);
    float land = smoothstep(0.0, 0.03, h - 0.015);
    vec3 deep = uHue * 0.10 + vec3(0.0, 0.015, 0.05);
    vec3 shallow = uHue * 0.32 + vec3(0.0, 0.05, 0.06);
    vec3 ocean = mix(deep, shallow, smoothstep(-0.28, 0.02, h));
    float dry = smoothstep(0.0, 0.45, fbm(q * 2.1 + 3.0, 3) + 0.3 - abs(lat - 0.32) * 1.4);
    vec3 green = vec3(0.09, 0.15, 0.05), brown = vec3(0.30, 0.24, 0.14), sand = vec3(0.56, 0.44, 0.27);
    vec3 ground = mix(green, sand, dry);
    ground = mix(ground, brown, smoothstep(0.12, 0.38, h));
    ground *= 0.8 + 0.4 * fbm(q * 9.0, 3);
    albedo = mix(ocean, ground, land);
    wet = 1.0 - land;
    float ice = smoothstep(0.80, 0.90, lat + 0.07 * gnoise(q * 4.0));
    albedo = mix(albedo, vec3(0.86, 0.89, 0.93), ice);
    float c = fbm(rotY(p, uTime * 0.004) * 2.4 + w * 1.5 + s + 11.0, 6);
    float bands = 0.10 * sin(p.y * 9.0 + c * 5.0);
    cloud = smoothstep(0.02, 0.32, c + bands);
    rim = 1.0;
  } else if (uType == 2) {
    // A rocky world: highlands and lowlands, dark maria, impact scars, relief.
    vec3 q = p * 1.7 + s;
    vec3 w = vec3(fbm(q, 4), fbm(q + 4.3, 4), fbm(q + 8.1, 4));
    float h = fbm(q * 1.1 + w * 1.1, 7);
    // relief: the height a step toward the light, compared
    vec3 toward = normalize(uLight - n * dot(uLight, n) + 1e-4) * 0.035;
    float h2 = fbm((q + toward * 1.7) * 1.1 + w * 1.1, 7);
    float maria = smoothstep(-0.02, 0.22, fbm(q * 0.65 + 5.0, 5));
    vec3 lightRock = mix(uHue, vec3(0.62, 0.60, 0.58), 0.35);
    vec3 darkRock = uHue2 * 0.45;
    albedo = mix(darkRock, lightRock, smoothstep(-0.35, 0.35, h));
    albedo = mix(albedo, darkRock * 0.8, maria * 0.5);
    albedo *= 0.8 + 0.35 * fbm(q * 11.0, 3);
    float ice = smoothstep(0.87, 0.95, abs(p.y) + 0.05 * gnoise(q * 5.0));
    albedo = mix(albedo, vec3(0.82, 0.83, 0.85), ice * 0.85);
    float cr = craters(p * 3.2 + s);
    bump = vec3(cr * 0.35 + (h2 - h) * 9.0);
    rim = 0.45;
  } else if (uType == 3) {
    // A gas giant: many soft bands, sheared into eddies, limb-darkened.
    vec3 q = p + s;
    vec3 w = vec3(fbm(vec3(q.x * 2.0, q.y * 5.0, q.z * 2.0), 5), fbm(vec3(q.x * 2.0, q.y * 5.0, q.z * 2.0) + 7.3, 5), 0.0);
    float turb = fbm(vec3(q.x * 2.4, q.y * 9.0, q.z * 2.4) + w * 1.6, 6);
    float lat = p.y + turb * 0.09 + w.x * 0.05;
    // band widths vary: the latitude is pushed through noise before it's banded
    float lb = lat * (5.0 + uWarp * 1.5) + fbm(vec3(lat * 3.0, uSeed * 0.07, 1.0), 3) * 1.6;
    float band = 0.5 + 0.5 * sin(lb * 3.1416 + w.y * 1.5);
    float fine = fbm(vec3(lat * 40.0, q.x * 0.6 + turb * 2.0, q.z * 0.6), 4);
    vec3 pale = mix(uHue2, vec3(0.92, 0.90, 0.95), 0.35);
    vec3 deep = mix(uHue, uHue2.bgr, 0.25) * 0.5;
    albedo = mix(deep, mix(uHue * 0.85, pale * 0.8, 0.5), smoothstep(0.1, 0.9, band) * 0.65 + 0.2);
    albedo = mix(albedo, pale * 0.9, smoothstep(0.1, 0.5, fine) * 0.22);
    albedo *= 0.88 + 0.26 * turb;
    float storm = exp(-pow(length(vec2((atan(q.z, q.x) - 1.2) * 0.8, (p.y + 0.3) * 5.0)), 2.0) * 2.0);
    albedo = mix(albedo, pale, storm * 0.45);
    albedo *= mix(0.55, 1.0, pow(n.z, 0.5));
    rim = 0.55;
  } else {
    // A moon or an asteroid: grey regolith, maria, craters.
    vec3 q = p * (uType == 5 ? 2.4 : 1.7) + s;
    float h = fbm(q, 5);
    float maria = smoothstep(0.0, 0.3, fbm(q * 0.6 + 2.0, 3));
    albedo = uHue * (0.78 + 0.6 * h) * mix(1.0, 0.6, maria * (uType == 4 ? 0.8 : 0.3));
    float cr = craters(p * (uType == 5 ? 3.0 : 3.6) + s);
    bump = vec3(cr) * 0.5;
    if (uType == 5) {
      // lumpy: bend the normal with the noise
      n = normalize(n + 0.45 * vec3(gnoise(q * 1.3), gnoise(q * 1.3 + 7.0), 0.0));
    }
  }

  float ndl = dot(n, uLight);
  float lit = softLight(ndl);
  // Crater relief, lit from the core's side.
  float relief = (bump.x) * clamp(dot(normalize(uLight.xy + 1e-4), normalize(uv + 1e-4)) * 0.6 + 0.4, 0.0, 1.0);
  vec3 col = albedo * (lit * (1.0 + relief * 0.9) + 0.012);
  if (uType == 1) {
    vec3 cloudCol = vec3(0.93, 0.94, 0.96);
    float shade = softLight(dot(n, uLight) - 0.04);
    col = mix(col, cloudCol * (shade + 0.01), cloud * 0.92);
    vec3 h = normalize(uLight + vec3(0.0, 0.0, 1.0));
    col += vec3(1.0, 0.92, 0.80) * pow(max(dot(n, h), 0.0), 60.0) * wet * (1.0 - cloud) * 0.6 * step(0.0, ndl);
  }
  // Atmosphere: a bright rim on the lit limb, Rayleigh-blue on a living world.
  float fres = pow(1.0 - n.z, 2.6);
  col += uAtmo * fres * smoothstep(0.0, 0.7, ndl) * rim * 0.75;
  col = tone(col);
  float cover = 1.0 - smoothstep(edge - aa, edge + aa * 0.5, d);
  col = col * (1.0 - uDim * 0.82);
  // a dimmed body also thins out, so it recedes into the sky instead of reading as a hole
  float a = cover * (1.0 - uDim * 0.55);
  return vec4(col * a + sel.rgb * (1.0 - uDim * 0.82), a);
}

vec4 ring(vec2 uv, bool front) {
  // A tilted ring seen from above: an ellipse, its near half below the planet.
  float tilt = 0.30;
  float a = -0.38;
  vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * uv;
  if (front ? q.y > 0.0 : q.y <= 0.0) return vec4(0.0);
  vec2 e = vec2(q.x, q.y / tilt);
  float rr = length(e);
  if (rr < 1.32 || rr > 1.98) return vec4(0.0);
  float bands = 0.35 + 0.65 * smoothstep(-0.3, 0.4, fbm(vec3(rr * 34.0, uSeed * 0.1, 0.0), 5)) * (0.85 + 0.15 * sin(rr * 90.0 + fbm(vec3(rr * 60.0, 3.0, uSeed), 2) * 4.0));
  float gap = smoothstep(0.0, 0.02, abs(rr - 1.78)) * (0.7 + 0.3 * smoothstep(0.0, 0.04, abs(rr - 1.5)));
  float edge = smoothstep(1.32, 1.42, rr) * smoothstep(1.98, 1.86, rr);
  float dens = bands * gap * edge;
  vec2 Lr = normalize(mat2(cos(a), sin(a), -sin(a), cos(a)) * uLight.xy + 1e-4);
  // The planet's shadow falls across the ring on the side away from the core.
  float shadow = (dot(e, Lr) < 0.0 && abs(e.x * Lr.y - e.y * Lr.x) < 1.0) ? 0.12 : 1.0;
  float lit = (0.55 + 0.45 * clamp(dot(normalize(e), Lr) * 0.5 + 0.5, 0.0, 1.0)) * shadow;
  vec3 col = mix(uHue2, vec3(0.86, 0.78, 0.64), 0.7) * lit * dens * 0.62;
  float al = dens * 0.38;
  return vec4(tone(col) * (1.0 - uDim * 0.82), al);
}

vec4 nova(vec2 uv) {
  float d = length(uv);
  float core = exp(-d * d * 5.0);
  float inner = exp(-d * 1.7);
  float outer = 1.0 / (1.0 + d * d * 0.35);
  float streak = exp(-abs(uv.y) * 6.0) * exp(-abs(uv.x) * 0.16);
  float hair = exp(-abs(uv.y) * 38.0) * exp(-abs(uv.x) * 0.09);
  // fade out before the quad's edge (±18 × ±9) so nothing ends in a line
  float fadeX = smoothstep(18.0, 11.0, abs(uv.x)) * smoothstep(9.0, 6.0, abs(uv.y));
  streak *= fadeX; hair *= fadeX;
  float ang = atan(uv.y, uv.x);
  vec3 ray = vec3(cos(ang) * 3.0, sin(ang) * 3.0, uTime * 0.015);
  float rays = pow(0.5 + 0.5 * gnoise(ray), 3.0) * exp(-d * 0.55);
  vec3 col = vec3(1.0) * core * 2.4
    + mix(uSelA, vec3(1.0, 0.95, 0.85), 0.35) * inner * 1.3
    + uSelA * outer * 0.42
    + mix(uSelA, uSelB, 0.2) * exp(-d * 0.36) * 0.38
    + mix(uSelA, uSelB, 0.25) * streak * 0.8
    + vec3(1.0, 0.86, 0.66) * hair * 0.45
    + uSelA * rays * 0.45;
  col += uSelB * exp(-pow((d - 1.3) * 2.6, 2.0)) * 0.12 + uSelC * exp(-pow((d - 2.1) * 1.8, 2.0)) * 0.10;
  return vec4(tone(col) * uAlpha, 0.0);
}

vec4 star(vec2 uv) {
  float d = length(uv);
  float core = exp(-d * d * 3.0) * 1.5;
  float halo = exp(-d * 1.15) * 0.55;
  float spikes = exp(-abs(uv.y) * 16.0) * exp(-abs(uv.x) * 0.42) + exp(-abs(uv.x) * 16.0) * exp(-abs(uv.y) * 0.42);
  vec2 r = mat2(0.7071, -0.7071, 0.7071, 0.7071) * uv;
  spikes += 0.22 * (exp(-abs(r.y) * 28.0) * exp(-abs(r.x) * 1.1) + exp(-abs(r.x) * 28.0) * exp(-abs(r.y) * 1.1));
  vec3 col = mix(vec3(1.0), uHue, 0.45) * (core + halo) + mix(vec3(0.86, 0.9, 1.0), uHue, 0.35) * spikes * 0.7 * uWarp;
  vec4 sel = selection(uv / 2.2, d / 2.2);
  return vec4(tone(col) * uAlpha * (1.0 - uDim * 0.8) + sel.rgb, 0.0);
}

vec4 comet(vec2 uv) {
  float x = uv.x; float y = uv.y;
  float head = exp(-(x * x + y * y) * 1.1) * 1.4 + exp(-length(uv) * 0.8) * 0.25;
  float s = max(x, 0.0) / uTail;
  float on = smoothstep(-0.5, 1.0, x);
  float w = 0.7 + s * uTail * 0.20;
  float dust = exp(-pow((y + s * s * uTail * 0.16) / w, 2.0)) * exp(-s * 2.6) * on;
  float ion = exp(-pow(y / (0.30 + s * 1.6), 2.0)) * exp(-s * 1.4) * on * (0.75 + 0.35 * gnoise(vec3(x * 0.35, y * 1.5, uTime * 0.08)));
  vec3 col = vec3(1.0, 0.98, 0.95) * head + uHue * dust * 0.55 + vec3(0.55, 0.74, 1.0) * ion * 0.45;
  vec4 sel = selection(uv / 2.0, length(uv) / 2.0);
  return vec4(tone(col) * uAlpha * (1.0 - uDim * 0.8) + sel.rgb, 0.0);
}

vec4 flare(vec2 uv) {
  float d = length(uv);
  float t = uAlpha;
  vec3 col = (vec3(1.0) * exp(-d * d * 6.0) * 2.0 + uSelA * exp(-d * 1.4) * 0.8
    + mix(uSelB, uSelC, 0.5) * exp(-pow((d - 2.0 * (1.0 - t) - 0.6) * 3.0, 2.0)) * 0.5) * t;
  return vec4(tone(col), 0.0);
}

void main() {
  vec4 c;
  if (uType == 20) c = nova(vUv);
  else if (uType == 21) c = star(vUv);
  else if (uType == 22) c = comet(vUv);
  else if (uType == 23) c = flare(vUv);
  else if (uType == 10) c = ring(vUv, false);
  else if (uType == 11) c = ring(vUv, true);
  else c = sphere(vUv);
  // Glow (anything added, not covering) reaches zero before the quad ends,
  // so no square edge ever shows around a body or the core.
  if (c.a == 0.0) c.rgb *= smoothstep(uExt.x, uExt.x * 0.82, abs(vUv.x)) * smoothstep(uExt.y, uExt.y * 0.82, abs(vUv.y));
  o = c;
}`;

// ---- threads and orbits: light, not lines ------------------------------------------
const LINE_VS = HEAD + `
in vec2 aPos;
in vec4 aInfo;   // across (-1..1), along (0..1), alpha, unused
in vec3 aColor;
uniform vec2 uRes;
out vec4 vInfo;
out vec3 vColor;
void main() {
  vInfo = aInfo; vColor = aColor;
  gl_Position = vec4(aPos / uRes * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
}`;
const LINE_FS = HEAD + `
in vec4 vInfo;
in vec3 vColor;
out vec4 o;
void main() {
  float a = vInfo.x;
  float core = exp(-a * a * 9.0);
  float glow = exp(-a * a * 2.0) * 0.35;
  float ends = smoothstep(0.0, 0.08, vInfo.y) * smoothstep(1.0, 0.92, vInfo.y);
  o = vec4(vColor * (core + glow) * vInfo.z * ends, 0.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Stellar Map shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.bindAttribLocation(p, 1, 'aInfo');
  gl.bindAttribLocation(p, 2, 'aColor');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Stellar Map program: ${gl.getProgramInfoLog(p)}`);
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  const u = {};
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

function target(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fb, w, h };
}

export const TYPE = { terran: 1, rocky: 2, gas: 3, moon: 4, asteroid: 5, ringBack: 10, ringFront: 11, nova: 20, star: 21, comet: 22, flare: 23 };

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (!gl) return null;
  const far = program(gl, FULL_VS, FAR_FS);
  const neb = program(gl, FULL_VS, NEB_FS);
  const tex = program(gl, QUAD_VS, TEX_FS);
  const body = program(gl, QUAD_VS, BODY_FS);
  const line = program(gl, LINE_VS, LINE_FS);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const lineBuf = gl.createBuffer();
  const lineVao = gl.createVertexArray();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  const STRIDE = 9 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 8);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE, 24);
  gl.bindVertexArray(null);

  let farT = null;        // the far field texture and the sky origin it was drawn at
  let farKey = '';
  const nebulae = new Map(); // seed → texture
  let W = 1; let H = 1; let dpr = 1;
  let colors = null;

  const setU = (prog, name, v) => {
    const loc = prog.u[name];
    if (loc == null) return;
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
  };

  function drawFar(origin) {
    // A sky tile larger than the screen, so parallax can slide it.
    const mw = Math.ceil(W * 1.5); const mh = Math.ceil(H * 1.5);
    if (!farT || farT.w !== mw || farT.h !== mh) farT = target(gl, mw, mh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, farT.fb);
    gl.viewport(0, 0, mw, mh);
    gl.disable(gl.BLEND);
    gl.useProgram(far.p);
    setU(far, 'uOrigin', origin);
    setU(far, 'uDpr', dpr);
    for (const k of ['uSpace', 'uWarm', 'uCool', 'uHazeA', 'uHazeB']) setU(far, k, colors[k]);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    farT.origin = origin;
  }

  function nebulaTexture(seed, palette) {
    const key = `${seed}:${palette.join()}`;
    if (nebulae.has(key)) return nebulae.get(key);
    const t = target(gl, 512, 512);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, 512, 512);
    gl.disable(gl.BLEND);
    gl.useProgram(neb.p);
    setU(neb, 'uSeed', (seed % 997) + 0.5);
    setU(neb, 'uA', palette[0]); setU(neb, 'uB', palette[1]); setU(neb, 'uC', palette[2]);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    nebulae.set(key, t);
    return t;
  }

  function quadAt(prog, x, y, hx, hy, ext, angle = 0) {
    setU(prog, 'uCenter', [x * dpr, y * dpr]);
    setU(prog, 'uHalf', [hx * dpr, hy * dpr]);
    setU(prog, 'uExt', ext);
    setU(prog, 'uAngle', angle);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    gl,
    resize(w, h, ratio) {
      dpr = ratio;
      W = Math.max(1, Math.round(w * ratio)); H = Math.max(1, Math.round(h * ratio));
      canvas.width = W; canvas.height = H;
      farKey = '';
    },
    setColors(c) { colors = c; farKey = ''; nebulae.clear(); },

    // frame: { sky: [x, y] sky offset in css px, farScale, nebulae: [{x,y,r,seed,palette,alpha}],
    //          stars: [{x,y,size,color,spikes,alpha}], lines: Float32Array, lineCount, bodies: [...] }
    draw(f) {
      if (!colors) return;
      // Far field: redraw the tile only when the view has slid past its margin.
      const mx = (W * 0.25) / dpr; const my = (H * 0.25) / dpr;
      const key = `${W}x${H}`;
      const want = [f.sky[0] - mx, f.sky[1] - my];
      if (key !== farKey || !farT?.origin || Math.abs(farT.origin[0] - want[0]) > mx * 0.9 || Math.abs(farT.origin[1] - want[1]) > my * 0.9) {
        drawFar([Math.round(want[0]), Math.round(want[1])]);
        farKey = key;
      }
      gl.viewport(0, 0, W, H);
      gl.clearColor(colors.uSpace[0], colors.uSpace[1], colors.uSpace[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(quadVao);

      // far field tile, slid by the sky offset (and breathing slightly with travel)
      gl.useProgram(tex.p);
      setU(tex, 'uRes', [W, H]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, farT.tex);
      gl.uniform1i(tex.u.uTex, 0);
      setU(tex, 'uAlpha', 1);
      const fx = farT.origin[0] - f.sky[0]; const fy = farT.origin[1] - f.sky[1];
      const fw = farT.w / dpr; const fh = farT.h / dpr;
      const s = f.farScale ?? 1;
      const cx = W / dpr / 2; const cy = H / dpr / 2;
      quadAt(tex, cx + (fx + fw / 2 - cx) * s, cy + (fy + fh / 2 - cy) * s, (fw / 2) * s, (fh / 2) * s, [1, 1]);

      // nebulae, washed in additively
      for (const n of f.nebulae) {
        const t = nebulaTexture(n.seed, n.palette);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        setU(tex, 'uAlpha', n.alpha);
        quadAt(tex, n.x, n.y, n.r, n.r, [1, 1], n.angle ?? 0);
      }

      // bright field stars
      gl.useProgram(body.p);
      setU(body, 'uRes', [W, H]);
      setU(body, 'uSelA', colors.uSelA); setU(body, 'uSelB', colors.uSelB); setU(body, 'uSelC', colors.uSelC);
      setU(body, 'uTime', f.time);
      gl.uniform1i(body.u.uType, TYPE.star);
      setU(body, 'uSel', 0); setU(body, 'uHover', 0); setU(body, 'uDim', 0);
      for (const st of f.stars) {
        setU(body, 'uHue', st.color);
        setU(body, 'uAlpha', st.alpha);
        setU(body, 'uWarp', st.spikes);
        setU(body, 'uPx', st.size * dpr);
        const ext = st.spikes > 0 ? 9 : 3;
        quadAt(body, st.x, st.y, st.size * ext, st.size * ext, [ext, ext]);
      }

      // threads and orbits
      if (f.lineCount) {
        gl.useProgram(line.p);
        setU(line, 'uRes', [W, H]);
        gl.bindVertexArray(lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, f.lines.subarray(0, f.lineCount * 9), gl.STREAM_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, f.lineCount);
        gl.bindVertexArray(quadVao);
      }

      // bodies, back to front
      gl.useProgram(body.p);
      for (const b of f.bodies) {
        gl.uniform1i(body.u.uType, b.type);
        setU(body, 'uLight', b.light ?? [0, 0, 1]);
        setU(body, 'uHue', b.hue ?? [1, 1, 1]);
        setU(body, 'uHue2', b.hue2 ?? b.hue ?? [1, 1, 1]);
        setU(body, 'uAtmo', b.atmo ?? [0, 0, 0]);
        setU(body, 'uSeed', b.seed ?? 0);
        setU(body, 'uSpin', b.spin ?? 0);
        setU(body, 'uDim', b.dim ?? 0);
        setU(body, 'uSel', b.sel ?? 0);
        setU(body, 'uHover', b.hover ?? 0);
        setU(body, 'uAlpha', b.alpha ?? 1);
        setU(body, 'uTail', b.tail ?? 10);
        setU(body, 'uWarp', b.warp ?? 0);
        const r = b.r;
        setU(body, 'uPx', Math.max(1, r * dpr));
        if (b.type === TYPE.nova) quadAt(body, b.x, b.y, r * 18, r * 9, [18, 9]);
        else if (b.type === TYPE.star) { const e = 9; quadAt(body, b.x, b.y, r * e, r * e, [e, e]); }
        else if (b.type === TYPE.comet) { const e = b.tail + 3; quadAt(body, b.x, b.y, r * e, r * 8, [e, 8], b.angle ?? 0); }
        else if (b.type === TYPE.flare) { const e = 6; quadAt(body, b.x, b.y, r * e, r * e, [e, e]); }
        else if (b.type === TYPE.ringBack || b.type === TYPE.ringFront) quadAt(body, b.x, b.y, r * 2.3, r * 2.3, [2.3, 2.3]);
        else { const e = 1 + Math.max(0.35, 26 / Math.max(r, 1)); quadAt(body, b.x, b.y, r * e, r * e, [e, e]); }
      }
    },

    lose() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}
