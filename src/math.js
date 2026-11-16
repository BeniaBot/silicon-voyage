// ============================================================================
// math: random numbers, noise, matrices
// ============================================================================
const { sin, cos, tan, abs, min, max, floor, ceil, sqrt, exp, pow, hypot, atan2, asin, PI, round, sign } = Math;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x, mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// seeded random (mulberry32): the same world on every load
let SEED = 1;
const rseed = s => { SEED = s >>> 0; };
const rnd = () => {
  let t = SEED = (SEED + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const rr = (a, b) => a + (b - a) * rnd(), ri = (a, b) => a + (rnd() * (b - a + 1) | 0), pick = a => a[rnd() * a.length | 0];

// 2D value noise and fbm for the layout
const h2 = (x, z) => { let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };
const vn2 = (x, z) => {
  const ix = floor(x), iz = floor(z), fx = x - ix, fz = z - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return mix(mix(h2(ix, iz), h2(ix + 1, iz), u), mix(h2(ix, iz + 1), h2(ix + 1, iz + 1), u), v);
};
const fbm2 = (x, z, o = 4) => { let s = 0, a = .5; for (let i = 0; i < o; i++, a *= .5, x *= 2.03, z *= 2.03) s += a * vn2(x, z); return s; };

// vectors as plain arrays (load time only)
const norm3 = v => { const l = hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 4x4 matrices, column-major, WebGPU clip space (depth 0..1)
function mmul(o, a, b) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
// infinite perspective with reversed depth: the near plane is 1, infinity is 0
function persp(o, fy, asp, n) { o.fill(0); const f = 1 / tan(fy / 2); o[0] = f / asp; o[5] = f; o[11] = -1; o[14] = n; return o; }
// view matrix of a camera at p turned by yaw (0 looks toward -z, positive turns right) and pitch (positive looks up)
function view(o, p, yaw, pit) {
  const cy = cos(yaw), sy = sin(yaw), cp = cos(pit), sp = sin(pit);
  const fx = sy * cp, fy = sp, fz = -cy * cp, rx = cy, rz = sy, ux = -sy * sp, uy = cp, uz = cy * sp;
  o[0] = rx; o[4] = 0; o[8] = rz; o[12] = -(rx * p[0] + rz * p[2]);
  o[1] = ux; o[5] = uy; o[9] = uz; o[13] = -(ux * p[0] + uy * p[1] + uz * p[2]);
  o[2] = -fx; o[6] = -fy; o[10] = -fz; o[14] = fx * p[0] + fy * p[1] + fz * p[2];
  o[3] = 0; o[7] = 0; o[11] = 0; o[15] = 1;
  return o;
}
