// ============================================================================
// nano: one more step down, inside a transistor. The silicon crystal, its bonds, the electrons.
// ============================================================================
// The crystal is endless: only the cells around the camera are drawn, so it can be flown through forever.
// Silicon is a diamond-cubic lattice: eight atoms in every cubic cell, each bonded to four neighbours. The cell is
// 4 units wide, so sites sit on whole numbers; the lattice is turned 45 degrees so its open channels run along x,
// the way the current flows in a real transistor. Above y = 0 lies the gate oxide (glass: atoms in no order) and
// above that the metal gate. Every 1.6 s, with the chip's clock, the gate opens and electrons flood the channel.
// A site's fate (vacancy, dopant) comes from an integer hash that gives the same bits on the GPU and here.
const NN = LV > 1 ? 10 : 12, NELEC = [4400, 3400, 1800][LV];
const NBAS = [[0, 0, 0], [0, 2, 2], [2, 0, 2], [2, 2, 0], [1, 1, 1], [1, 3, 3], [3, 1, 3], [3, 3, 1]];
const nih = (x, y, z) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683) | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return (h ^ h >>> 16) >>> 0;
};
// cell offsets around the camera, nearest first, so the GPU draws front to back
function nanoOrder() {
  const o = [];
  for (let i = -NN / 2; i < NN / 2; i++) for (let j = -NN / 2; j < NN / 2; j++) for (let k = -NN / 2; k < NN / 2; k++) o.push([i, j, k]);
  o.sort((a, b) => hypot(a[0], a[1], a[2]) - hypot(b[0], b[1], b[2]));
  return new Float32Array(o.flatMap(c => [...c, 0]));
}
// clearance from a world point to the nearest crystal atom (distance minus radius), and that atom in NP
const NP = [0, 0, 0, 0];
function nnear(x, y, z) {
  const lx = (x + z) * .70711, lz = (z - x) * .70711, cx = floor(lx / 4 - .5), cy = floor(y / 4 - .5), cz = floor(lz / 4 - .5);
  let best = 9;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) for (const b of NBAS) {
    const qx = (cx + i) * 4 + b[0], qy = (cy + j) * 4 + b[1], qz = (cz + k) * 4 + b[2];
    if (qy >= 0) continue;
    const h = nih(qx, qy, qz);
    if ((h & 65535) / 65535 < .004) continue;   // a vacancy
    const r = (h >>> 16) / 65535 > .993 ? .58 : .5, d = hypot(lx - qx, y - qy, lz - qz) - r;
    if (d < best) { best = d; NP[0] = qx; NP[1] = qy; NP[2] = qz; NP[3] = r; }
  }
  return best;
}
// keep the camera out of the atoms and under the oxide
const NCAM = .26;
function ncollide(p) {
  p[1] = clamp(p[1], -400, -1.15);
  for (let n = 0; n < 2; n++) {
    if (nnear(p[0], p[1], p[2]) >= NCAM) return;
    const lx = (p[0] + p[2]) * .70711, lz = (p[2] - p[0]) * .70711;
    let ex = lx - NP[0], ey = p[1] - NP[1], ez = lz - NP[2];
    const d = hypot(ex, ey, ez) || 1, f = (NP[3] + NCAM) / d;
    ex = NP[0] + ex * f; ez = NP[2] + ez * f; p[1] = min(NP[1] + ey * f, -1.15);
    p[0] = (ex - ez) * .70711; p[2] = (ex + ez) * .70711;
  }
}
// distance along a ray to the first atom (for the autofocus): a plain march, the lattice is cheap to ask
function nhit(ox, oy, oz, dx, dy, dz) {
  for (let t = .6; t < 26;) {
    const c = nnear(ox + dx * t, oy + dy * t, oz + dz * t);
    if (c < .05) return t;
    t += max(c * .9, .12);
  }
  return 26;
}
// the widest straight channel along x near the origin: where the stations and the drift fly
function nanoChannel(y0, y1) {
  let best = -1, by = 0, bz = 0;
  for (let y = y0; y < y1; y += .25) for (let z = 0; z < 6; z += .25) {
    let m = 9;
    for (let x = 0; x < 12 && m > best; x += .4) m = min(m, nnear(x, y, z));
    if (m > best) { best = m; by = y; bz = z; }
  }
  return [by, bz];
}

const W_NANO = /*wgsl*/`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> ord: array<vec4f>;
var<private> BAS = array<vec3i, 8>(vec3i(0, 0, 0), vec3i(0, 2, 2), vec3i(2, 0, 2), vec3i(2, 2, 0), vec3i(1, 1, 1), vec3i(1, 3, 3), vec3i(3, 1, 3), vec3i(3, 3, 1));
var<private> BND = array<vec3i, 4>(vec3i(-1, -1, -1), vec3i(-1, 1, 1), vec3i(1, -1, 1), vec3i(1, 1, -1));
const KD = vec3f(.549, .768, -.329);
fn l2w(p: vec3f) -> vec3f { return vec3f((p.x - p.z) * .70711, p.y, (p.x + p.z) * .70711); }
fn w2l(p: vec3f) -> vec3f { return vec3f((p.x + p.z) * .70711, p.y, (p.z - p.x) * .70711); }
fn ih(q: vec3i) -> u32 {
  var h = u32(q.x) * 374761393u + u32(q.y) * 668265263u + u32(q.z) * 1440662683u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
fn quad(vi: u32) -> vec2f {
  var cs = array<vec2f, 6>(vec2f(-1., -1.), vec2f(1., -1.), vec2f(1., 1.), vec2f(-1., -1.), vec2f(1., 1.), vec2f(-1., 1.));
  return cs[vi];
}
// the dark between the atoms: warm toward the drain, where the current goes, cold behind
fn nbg(d: vec3f) -> vec3f {
  return mix(vec3f(.002, .005, .022), vec3f(.022, .012, .014), smoothstep(-.1, 1., d.x)) + vec3f(.004, .003, .02) * smoothstep(0., 1., d.y);
}
// the gate: opens with the chip's clock, stays open a while, closes
fn gate(t: f32) -> f32 { let ph = fract(t / 1.6) * 1.6; return smoothstep(0., .2, ph) * (1. - smoothstep(.75, 1.2, ph)); }
fn base() -> vec3i { return vec3i(floor(w2l(u.cam.xyz) / 4.)) * 4; }

struct At { p: vec3f, r: f32, c: vec3f, e: f32 }
// what sits on a lattice site: world position, radius, colour, glow
fn atom(q: vec3i) -> At {
  let h = ih(q); let f = f32(h & 0xffffu) / 65535.; let g = f32(h >> 16u) / 65535.; let t = u.cam.w;
  var p = vec3f(q);
  var a: At;
  a.e = 0.;
  if (q.y < 0) {   // crystal: every atom trembles with heat; a few sites are empty, a few hold a dopant
    p += vec3f(sin(t * 6. + f * 40.), sin(t * 7.3 + g * 40.), sin(t * 5.1 + (f + g) * 20.)) * .045;
    a.r = select(.5, 0., f < .004); a.c = vec3f(.06, .13, .42) * (.8 + .4 * fract(g * 9.7));
    if (g > .993) { a.c = vec3f(1., .48, .16); a.r = .58; a.e = 1.; }
  } else if (q.y < 12) {   // the gate oxide: glass, silicon and oxygen in no order
    p += (vec3f(f, g, fract(f * 7.3 + g * 3.1)) - .5) * 1.5;
    let ox = fract(f * 13.7) < .64;
    a.r = select(.46, .36, ox); a.c = select(vec3f(.2, .3, .52), vec3f(.55, .2, .2), ox);
  } else {   // the metal gate: big atoms packed tight, on the face-centred sites only
    a.r = select(0., 1.38, ((q.x | q.y | q.z) & 1) == 0); a.c = vec3f(.92, .62, .24);
  }
  a.p = l2w(p);
  return a;
}
fn shade(c0: vec3f, n: vec3f, wp: vec3f, glow: f32) -> vec3f {
  let V = u.cam.xyz - wp; let dist = length(V); let vv = V / dist;
  let hl = clamp(dot(n, vv), 0., 1.);
  let BL = vec3f(-.6, -.3, .742);   // a cool light from behind, opposite the key
  var c = c0 * (.04 + max(dot(n, KD), 0.) * .4) + c0 * vec3f(.4, .6, 1.) * max(dot(n, BL), 0.) * .3;
  c += c0 * 3.4 * pow(max(dot(n, -KD), 0.), 2.4) * (.3 + .7 * hl);
  c += nbg(reflect(-vv, n)) * 3. * pow(1. - hl, 3.);
  c += vec3f(1.) * pow(max(dot(n, normalize(KD + vv)), 0.), 200.) * 1.2 + vec3f(.6, .8, 1.) * pow(max(dot(n, normalize(BL + vv)), 0.), 60.) * .2;
  c += mix(vec3f(.1, .42, 1.), vec3f(.9, .5, .2), smoothstep(-.2, .7, n.x)) * pow(1. - hl, 4.) * .85;
  // under the open gate the flood of electrons lights the top layers of the crystal
  c += vec3f(1., .6, .2) * gate(u.cam.w) * exp(min(wp.y, 0.) * .17) * (1. - smoothstep(-.5, 2.5, wp.y)) * (.03 + .14 * max(n.y, 0.));
  c += c0 * glow * (1.3 + .5 * sin(u.cam.w * 3. + wp.x));
  let f = exp(-dist * .135);
  return c * f + nbg(-vv) * (1. - f);
}

struct AV { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) c: vec3f, @location(2) wp: vec3f, @location(3) @interpolate(flat) re: vec3f }
struct FO { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }
@vertex fn vatom(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> AV {
  let a = atom(base() + vec3i(ord[ii >> 3u].xyz) * 4 + BAS[ii & 7u]);
  let k = quad(vi);
  var o: AV;
  let vz = dot(a.p - u.cam.xyz, u.fwd.xyz); let rr = a.r * smoothstep(.6, 3.6, vz);
  o.wp = a.p + (normalize(u.rgt.xyz) * k.x + normalize(u.upv.xyz) * k.y) * rr;
  o.pos = u.vp * vec4f(o.wp, 1.); o.uv = k; o.c = a.c; o.re = vec3f(rr, a.e, vz);
  return o;
}
// a flat disc shaded as a ball. It writes the depth of a real ball, so bonds and electrons meet its surface properly;
// its edge is smoothed through the multisample coverage.
@fragment fn fatom(v: AV) -> FO {
  let d2 = dot(v.uv, v.uv); let nz = sqrt(max(1. - d2, 0.));
  let n = normalize(u.rgt.xyz) * v.uv.x + normalize(u.upv.xyz) * v.uv.y - u.fwd.xyz * nz;
  let a = clamp((1. - sqrt(d2)) * v.re.x * u.prm.y / distance(u.cam.xyz, v.wp), 0., 1.) * ${AA > 1 ? '.75' : '1.'};
  if (a < ${AA > 1 ? '.02' : '.5'}) { discard; }
  var o: FO;
  o.c = vec4f(shade(v.c, n, v.wp - u.fwd.xyz * nz * v.re.x, v.re.y), a);
  o.d = u.fwd.w / max(v.re.z - nz * v.re.x, u.fwd.w);
  return o;
}

struct BV { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) wp: vec3f, @location(2) sd: vec3f }
// a bond: a ribbon between two atoms that always faces the camera, shaded as a rod
@vertex fn vbond(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BV {
  let q0 = base() + vec3i(ord[ii >> 4u].xyz) * 4 + BAS[4u + ((ii >> 2u) & 3u)];
  let q1 = q0 + BND[ii & 3u];
  let a = atom(q0); let b = atom(q1);
  let k = quad(vi);
  let md = (a.p + b.p) * .5;
  let sd = normalize(cross(b.p - a.p, u.cam.xyz - md)) * select(0., .06, q0.y < 0 && q1.y < 0 && a.r > 0. && b.r > 0.) * smoothstep(.9, 2.6, distance(u.cam.xyz, md));
  var o: BV;
  let ax = normalize(b.p - a.p);
  o.wp = mix(a.p + ax * a.r * .9, b.p - ax * b.r * .9, k.y * .5 + .5) + sd * k.x;
  o.pos = u.vp * vec4f(o.wp, 1.); o.uv = k; o.sd = sd;
  return o;
}
@fragment fn fbond(v: BV) -> @location(0) vec4f {
  let x = v.uv.x;
  let n = normalize(v.sd) * x + normalize(u.cam.xyz - v.wp) * sqrt(max(1. - x * x, 0.));
  let a = clamp((1. - abs(x)) * length(v.sd) * u.prm.y / distance(u.cam.xyz, v.wp), 0., 1.);
  if (a < ${AA > 1 ? '.02' : '.5'}) { discard; }
  return vec4f(shade(vec3f(.1, .15, .3), n, v.wp, 0.), a);
}

struct EV { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32 }
// electrons: streaks drifting toward the drain. Most ride the channel just under the oxide and only when the gate is open.
@vertex fn velec(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> EV {
  let f = f32(ii); let t = u.cam.w; let B = 44.;
  let r = vec3f(h11(f * .1373 + .3), h11(f * .7311 + 3.1), h11(f * 1.3717 + 7.7));
  let top = r.z < .55;
  var p = vec3f(r.x * B + t * (8. + r.y * 10.), 0., r.z * 31. * B + sin(t * (1.2 + r.x) + f) * .45);
  p = vec3f(u.cam.x + (fract((p.x - u.cam.x) / B + .5) - .5) * B, 0., u.cam.z + (fract((p.z - u.cam.z) / B + .5) - .5) * B);
  let yb = u.cam.y + (fract((-r.y * B - u.cam.y) / B + .5) - .5) * B;
  p.y = select(yb, -.7 - r.y * r.y * 7., top) + sin(t * 4. + f * 1.7) * .18;
  let k = quad(vi);
  let sd = normalize(cross(vec3f(1., 0., 0.), u.cam.xyz - p)) * .042;
  let wp = p + vec3f(k.y * .7, 0., 0.) + sd * k.x;
  var o: EV;
  o.pos = u.vp * vec4f(wp, 1.); o.uv = k;
  o.a = select(.9 * step(p.y, -1.), gate(t - p.y * .03), top) * exp(-distance(p, u.cam.xyz) * .1);
  return o;
}
@fragment fn felec(v: EV) -> @location(0) vec4f {
  let hd = exp(-(v.uv.x * v.uv.x * 4. + (v.uv.y - .78) * (v.uv.y - .78) * 50.)) * 1.5;
  return vec4f((vec3f(1., .62, .2) * exp(-v.uv.x * v.uv.x * 5.) * exp((v.uv.y - 1.) * 2.6) * (1. - smoothstep(.82, 1., v.uv.y)) * 4. + vec3f(1., .9, .7) * hd * 9.) * v.a, 0.);
}

@vertex fn vfull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2. - 1., f32(i & 2u) * 2. - 1., 0., 1.);
}
@fragment fn fnsky(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let s = vec2f(fp.x / u.res.z * 2. - 1., 1. - fp.y / u.res.w * 2.);
  return vec4f(nbg(normalize(u.fwd.xyz + s.x * u.rgt.xyz + s.y * u.upv.xyz)), 1.);
}
`;
