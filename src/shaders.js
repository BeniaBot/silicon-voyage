// ============================================================================
// shaders (WGSL). The build squeezes every template literal marked /*wgsl*/.
// ============================================================================
// The key light is a fibre lamp off to one side of the microscope; the ring light above is part of the sky.
const LDIR = [-.62, .66, .42];

// uniforms, box record, small helpers (every module)
const W_HEAD = /*wgsl*/`
diagnostic(off, derivative_uniformity);
struct U { vp: mat4x4f, sh: mat4x4f, cam: vec4f, fwd: vec4f, rgt: vec4f, upv: vec4f, res: vec4f, prm: vec4f,
  pl: array<vec4f, 5>, gp: array<vec4f, 6>, gc: array<vec4f, 6>, sh2: mat4x4f }
struct I { c: vec3f, m: u32, h: vec3f, yaw: f32, q: vec4f }
const PI = 3.14159265;
const LD = vec3f(${LDIR});
const LC = vec3f(2.6, 2.45, 2.2);
fn h12(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h11(x: f32) -> f32 { return fract(sin(x * 91.3458) * 47453.5453); }
fn vn(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let w = f * f * (3. - 2. * f);
  return mix(mix(h12(i), h12(i + vec2f(1., 0.)), w.x), mix(h12(i + vec2f(0., 1.)), h12(i + vec2f(1., 1.)), w.x), w.y);
}
fn med(h: vec3f) -> f32 { return max(min(h.x, h.y), min(max(h.x, h.y), h.z)); }
fn rot(p: vec3f, y: f32) -> vec3f { let c = cos(y); let s = sin(y); return vec3f(p.x * c - p.z * s, p.y, p.x * s + p.z * c); }
// on-screen size in pixels of a box's middle dimension, seen from its nearest point
fn pxs(b: I, cam: vec3f, proj: f32) -> f32 {
  let ex = select(b.h, vec3f(length(b.h)), b.yaw != 0.);
  let dd = length(max(abs(b.c - cam) - ex, vec3f(0.)));
  // lettering is made of thin rows that only read together, so it holds on four times longer
  return 2. * med(b.h) * proj / max(dd, .05) * select(1., 4., (b.m & 0x1000000u) != 0u);
}
// unit cube corner for index 0..23: four per face, faces +x -x +y -y +z -z
fn corner(vi: u32) -> vec3f {
  let f = vi >> 2u; let c = vi & 3u; let ax = f >> 1u;
  let s = select(1., -1., (f & 1u) == 1u);
  let a = select(-1., 1., c == 1u || c == 2u);
  let b = select(-1., 1., c >= 2u);
  if (ax == 0u) { return vec3f(s, a, b); }
  if (ax == 1u) { return vec3f(b, s, a); }
  return vec3f(a, b, s);
}
`;

// haze: two layers of exponential height fog, coloured light sources inside it, the sky
const W_FOG = /*wgsl*/`
fn tau1(o: vec3f, d: vec3f, t: f32, a0: f32, hh: f32) -> f32 {
  let k = 1. / hh; let a = a0 * exp(-o.y * k); let dy = d.y * k;
  if (abs(dy * t) < 1e-3) { return a * t; }
  return a * (1. - exp(min(-dy * t, 60.))) / dy;
}
fn tau(o: vec3f, d: vec3f, t: f32) -> f32 { return (tau1(o, d, t, .009, 14.) + tau1(o, d, t, .003, 110.)) * u.prm.z + t * .00009 * (1. - u.prm.z); }
fn fdens(y: f32) -> f32 { return .009 * exp(-y / 14.) + .003 * exp(-y / 110.); }
fn fcol(d: vec3f) -> vec3f {
  let c = mix(vec3f(.004, .007, .016), vec3f(.010, .017, .036), smoothstep(-.2, .9, d.y));
  return mix(c, room(d) * .8, 1. - u.prm.z) + LC * .01 * pow(max(dot(d, LD), 0.), 8.);
}
// the room beyond the microscope, far out of focus: a soft gradient and a few lamps blurred into discs
fn room(d: vec3f) -> vec3f {
  var c = mix(vec3f(.03, .034, .045), vec3f(.07, .09, .13), smoothstep(-.1, .7, d.y));
  c += vec3f(.11, .075, .045) * exp(-abs(d.y - .03) * 7.);
  for (var i = 0; i < 7; i++) {
    let a = f32(i) * .9 + .3; let e = .12 + .1 * f32(i % 3);
    let l = vec3f(cos(a) * cos(e), sin(e), sin(a) * cos(e));
    let r = .0014 + .0013 * f32(i % 4);
    c += mix(vec3f(1., .74, .46), vec3f(1., .88, .7), f32(i & 1)) * (1. - smoothstep(r * .15, r, 1. - dot(d, l))) * .17;
  }
  return c;
}
// light scattered toward the eye by a point source next to the ray (closed form of the integral)
fn glow(o: vec3f, d: vec3f, t: f32) -> vec3f {
  var s = vec3f(0.);
  for (var i = 0; i < 6; i++) {
    let g = u.gp[i]; let c = u.gc[i];
    let q = g.xyz - o; let b = dot(q, d);
    let h = sqrt(max(dot(q, q) - b * b, 0.) + c.w * c.w);
    s += c.rgb * g.w * (atan((t - b) / h) + atan(b / h)) / h;
  }
  return s;
}
fn fogit(c: vec3f, d: vec3f, t: f32) -> vec3f {
  let f = exp(-tau(u.cam.xyz, d, t));
  return c * f + fcol(d) * (1. - f) + glow(u.cam.xyz, d, t) * (.11 + 1.3 * (1. - u.prm.z));
}
// what a mirror sees: the glowing city below, a dark band of haze at the horizon, and above, the inside of the
// microscope: a bright dome, a ring of LEDs, the dark glass of the objective in the middle
fn env(d: vec3f, r: f32) -> vec3f {
  let y = clamp(d.y, -1., 1.);
  var c = mix(vec3f(.012, .016, .024), vec3f(.05, .06, .066), (1. - smoothstep(-.6, -.05, y)) * (1. - r * .4));
  c += vec3f(.15, .155, .165) * smoothstep(.02, .55, y) * (1. - smoothstep(.86, .95, y) * (1. - r) * u.prm.z);
  c += room(d) * (1. - u.prm.z) * smoothstep(-.2, .3, y) * .7;
  let w = .03 + r * .4;
  let led = mix(pow(.5 + .5 * cos(atan2(d.z, d.x) * 28.), 16.) * 3., 1., smoothstep(0., .3, r));
  let k = (acos(y) - .42) / w;
  return c + vec3f(1., .97, .92) * 3. * (.03 / w) * exp(-k * k) * led * mix(.2, 1., u.prm.z);   // out on the board the ring light is far away
}
`;

// scene: boxes, bond wires, sky, floating specks
const W_SCENE = /*wgsl*/`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> inst: array<I>;
@group(0) @binding(2) var<storage, read> vis: array<u32>;
@group(0) @binding(3) var shm: texture_depth_2d;
@group(0) @binding(4) var shs: sampler_comparison;
@group(0) @binding(5) var aot: texture_3d<f32>;
@group(0) @binding(6) var lin: sampler;
@group(0) @binding(7) var flm: texture_2d<f32>;
@group(0) @binding(8) var lif: texture_2d<f32>;
@group(0) @binding(9) var shm2: texture_depth_2d;
@group(0) @binding(10) var bao: texture_2d<f32>;
${W_FOG}
struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) lp: vec3f,
  @location(3) @interpolate(flat) m: u32, @location(4) @interpolate(flat) h: vec3f, @location(5) @interpolate(flat) q: vec4f,
  @location(6) @interpolate(flat) fa: u32, @location(7) @interpolate(flat) yw: f32 }

@vertex fn vbox(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let b = inst[vis[ii]];
  var h = b.h;
  // a box nearing the culling size thins out first, so nothing pops: long things lose thickness, the rest shrinks
  let s = smoothstep(u.prm.x, u.prm.x * 2.5, pxs(b, u.cam.xyz, u.prm.y));
  let mx = max(h.x, max(h.y, h.z));
  if (mx > med(h) * 3.) { h = select(h * s, h, h == vec3f(mx)); } else { h *= s; }
  // every box is a hair bigger than its neighbours, each by its own amount: where two overlap, the same one always wins
  // and their shared faces cannot flicker
  h += vec3f(fract(f32(vis[ii]) * .618034) * .006);
  let f = vi >> 2u;
  let lp = corner(vi) * h;
  let sg = select(1., -1., (f & 1u) == 1u);
  let ax = f >> 1u;
  var o: VO;
  o.wp = b.c + rot(lp, b.yaw);
  o.pos = u.vp * vec4f(o.wp, 1.);
  o.n = rot(vec3f(select(0., sg, ax == 0u), select(0., sg, ax == 1u), select(0., sg, ax == 2u)), b.yaw);
  o.lp = lp; o.m = b.m; o.h = h; o.q = b.q; o.fa = f; o.yw = b.yaw;
  return o;
}

@vertex fn vtube(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: f32) -> VO {
  var o: VO;
  o.wp = p; o.pos = u.vp * vec4f(p, 1.); o.n = n; o.lp = vec3f(0.);
  o.m = u32(m) | (140u << 8u); o.h = vec3f(1e4); o.q = vec4f(0.); o.fa = 0u; o.yw = 0.;
  return o;
}

fn shadow(p: vec3f, n: vec3f) -> f32 {
  let q = u.sh * vec4f(p + n * .1, 1.);
  let uv = vec2f(q.x * .5 + .5, .5 - q.y * .5);
  if (uv.x > 0. && uv.x < 1. && uv.y > 0. && uv.y < 1. && q.z < 1.) {
    let t = .65 / f32(textureDimensions(shm).x);
    return (textureSampleCompareLevel(shm, shs, uv + vec2f(-t, -t), q.z) + textureSampleCompareLevel(shm, shs, uv + vec2f(t, -t), q.z)
      + textureSampleCompareLevel(shm, shs, uv + vec2f(-t, t), q.z) + textureSampleCompareLevel(shm, shs, uv + vec2f(t, t), q.z)) * .25;
  }
  // beyond the package: the coarse shadow map that covers the whole board
  let q2 = u.sh2 * vec4f(p + n * 5., 1.);
  let u2 = vec2f(q2.x * .5 + .5, .5 - q2.y * .5);
  if (u2.x <= 0. || u2.x >= 1. || u2.y <= 0. || u2.y >= 1. || q2.z >= 1.) { return 1.; }
  return textureSampleCompareLevel(shm2, shs, u2, q2.z);
}
fn aov(p: vec3f, n: vec3f) -> vec2f {
  if (abs(p.x) > 206. || abs(p.z) > 206.) { return vec2f(1.); }
  return textureSampleLevel(aot, lin, (p + n * .4 - vec3f(-210., -8., -210.)) / vec3f(420., 48., 420.), 0.).rg;
}
// the hot spots light what is near them
fn plights(p: vec3f, n: vec3f) -> vec3f {
  var s = vec3f(0.);
  for (var i = 0; i < 6; i++) {
    let g = u.gp[i]; let l = g.xyz - p; let d2 = dot(l, l);
    s += u.gc[i].rgb * g.w * max(dot(n, l) * inverseSqrt(d2), 0.) * 26. / (d2 + 30.);
  }
  return s;
}
// anti-aliased lines at every integer of x: w is the half width and fw the pixel footprint, both in cycles
fn aline(x: f32, w: f32, fw: f32) -> f32 {
  let d = abs(fract(x + .5) - .5);
  return mix(1. - smoothstep(w, w + fw + 1e-4, d), 2. * w, smoothstep(.15, .5, fw));
}

var<private> CELLC = array<vec3f, 8>(vec3f(.10, .16, .16), vec3f(.085, .075, .15), vec3f(.17, .15, .07), vec3f(.19, .09, .06),
  vec3f(.07, .14, .09), vec3f(.14, .14, .15), vec3f(.21, .17, .11), vec3f(.055, .07, .11));
var<private> PCOL = array<vec3f, 4>(vec3f(.12, .75, 1.), vec3f(1., .45, .08), vec3f(.2, 1., .4), vec3f(.75, .85, 1.));

@fragment fn fsolid(v: VO) -> @location(0) vec4f {
  let mt = v.m & 255u; let tint = f32((v.m >> 8u) & 255u) / 255.; let fl = v.m >> 16u;
  let p = v.wp; var n = normalize(v.n);
  let V = u.cam.xyz - p; let dist = length(V); let vv = V / dist;
  let t = u.cam.w;
  let dp = fwidth(p); let fwl = fwidth(v.lp);
  let top = v.fa == 2u;
  let la = select(select(2u, 1u, v.h.y >= v.h.z), 0u, v.h.x >= v.h.y && v.h.x >= v.h.z);   // long axis
  let uu = v.lp[la];
  let ax = v.fa >> 1u;
  // lights run in a thin strip inlaid down the middle of the wire, with a soft spill on the metal beside it;
  // when the wire is only a few pixels wide the strip becomes an even glow of the same total brightness
  let wa = select((la + 1u) % 3u, 3u - ax - la, ax != la);
  let wn = abs(v.lp[wa]) / max(v.h[wa], 1e-4);
  let fwn = fwl[wa] / max(v.h[wa], 1e-4);
  let strip = select(0., mix(1. - smoothstep(.2, .34, wn) + exp(-wn * 2.6) * .2, .4, smoothstep(.2, .7, fwn)), ax != la);

  // bevel: the normal tips over near the face's edges, so every edge catches a thin line of light
  var mg = v.h - abs(v.lp);
  mg[ax] = 1e4;
  let ea = select(select(2u, 1u, mg.y <= mg.z), 0u, mg.x <= mg.y && mg.x <= mg.z);
  let bw = max(min(.07, .3 * min(v.h[(ax + 1u) % 3u], v.h[(ax + 2u) % 3u])), 1e-4);
  let pw = fwl[ea] + 1e-4;
  let bv = (1. - smoothstep(0., bw, mg[ea])) * (1. - smoothstep(.6, 1.6, pw / bw));
  var en = vec3f(0.); en[ea] = sign(v.lp[ea]);
  n = normalize(n + rot(en, v.yw) * bv * select(.8, 0., (fl & 256u) != 0u && mt != 19u));

  var al = vec3f(.5); var me = 0.; var ro = .5; var f0o = vec3f(-1.); var ec = vec3f(0.); var pm = 0.;
  switch mt {
    case 0u: {   // the die: oxide with thin-film colours, faint layout patterns, warm under the hot spots
      if (top) {
        let fm = textureSampleLevel(flm, lin, (p.xz + 200.) / 400., 0.);
        let th = fm.r * 1.7 + vn(p.xz * .045) * .5 + vn(p.xz * .37) * .08;
        let fc = .5 + .5 * cos(6.2832 * (th * (.55 + .45 * max(dot(n, vv), 0.)) + vec3f(0., .33, .67)));
        let film = mix(vec3f(dot(fc, vec3f(.333))), fc, .34) * vec3f(.8, 1., 1.1);   // mostly grey-teal, a hint of colour
        al = vec3f(.02) + film * .032; f0o = vec3f(.028) + film * .085; ro = .24;
        let pt = fm.g * 255.;
        var pat = 0.;
        if (pt > .5 && pt < 1.5) { pat = aline(p.z / 1.6 - .1, .05, dp.z / 1.6); }
        else if (pt > 1.5 && pt < 2.5) { pat = max(aline(p.x / .78, .07, dp.x / .78), aline(p.z / .78, .07, dp.z / .78)); }
        else if (pt > 2.5) {
          pat = max(aline(p.x / 1.5, .05, dp.x / 1.5), aline(p.z / 1.5, .05, dp.z / 1.5)) * .6;
          let az = abs(abs(p.x) - 55.) < 5.;
          let ac = select(abs(p.z) - 55., abs(p.x) - 55., az); let lg = select(p.x, p.z, az);
          let k = clamp(floor(ac / 1.5 + .5), -2., 2.);
          let run = pow(.5 + .5 * sin(lg * .26 - t * (4. + k) * select(-1., 1., k >= 0.) + k * 2.1), 8.);
          ec += vec3f(.1, .62, 1.) * exp(-pow((ac - k * 1.5) / .28, 2.)) * (.03 + run * .3) * (.3 + .7 * pow(1. - max(dot(n, vv), 0.), 2.));
        }
        al *= 1. - pat * .45;
        ec += vec3f(1., .36, .08) * fm.b * fm.b * .26;
      } else { al = vec3f(.05, .05, .055); ro = .35; }
    }
    case 1u, 14u: {   // standard cells
      al = CELLC[u32(v.q.x) & 7u] * (.75 + .5 * tint); ro = .55;
      if (top) { al *= 1. - aline(v.lp.x / .25 + .5, .12, fwl.x / .25) * .45; }
      if (mt == 14u) { ec += vec3f(1., .3, .06) * v.q.w * (.55 + .45 * sin(t * 1.3 + v.q.z * 6.2832)) * select(.5, 1.5, top); }
    }
    case 2u, 11u, 10u: {   // copper, brushed along its length
      let g = (vn(vec2f(v.lp[wa] * 13., uu * .5 + tint * 40.)) - .5) * (1. - smoothstep(.008, .04, fwl[wa]));
      al = select(vec3f(.97, .6, .42), vec3f(.98, .66, .5), mt == 10u) * (.9 + .2 * tint) * (1. + g * .13); me = 1.; ro = .22 + .14 * tint + g * .05;
    }
    case 3u: { al = vec3f(.6, .61, .63); me = 1.; ro = .45; }
    case 4u: {
      al = vec3f(.36, .37, .4); me = 1.; ro = .55;
      if (top) {
        let q = abs(v.lp.xz / v.h.xz); let fr = smoothstep(.8, .84, max(q.x, q.y));
        al = mix(al * (.9 + .2 * vn(vec2f(v.lp.x * 7., v.lp.z * .6))), vec3f(.05, .055, .07), fr); ro = mix(.5, .4, fr); me = mix(1., .2, fr);
        al *= 1. - .35 * (1. - smoothstep(.3, .5, length(v.lp.xz / v.h.xz - vec2f(.25, -.2))));
      }
    }
    case 5u: { al = vec3f(1., .766, .336); me = 1.; ro = .24; }
    case 6u: {   // ceramic, pressed in layers
      let fg = 1. - smoothstep(.12, .5, max(dp.x, max(dp.y, dp.z)));   // the fine grain fades with distance instead of turning into a screen-door pattern
      let g = mix(.5, vn(vec2f(p.x * .9 + p.y * .31, p.z * .9 - p.y * .43)), fg) * .4 + vn(vec2f(p.x + p.z, p.y) * .11) * .6;
      al = vec3f(.085, .052, .042) * (.62 + .76 * g) * (.65 + .35 * smoothstep(-10., 90., p.y)); ro = .7;
      if (ax != 1u) { al *= 1. - aline(p.y / 5.2, .03, dp.y / 5.2) * .3; }
      if (abs(p.x) < 300. && abs(p.z) < 300.) { ec += vec3f(.018, .05, .06) * (1. - smoothstep(-10., 100., p.y)); }
    }
    case 7u: {   // SRAM: one lamp per bit, driven by the Game of Life texture
      if (top) {
        let cs = 400. / 512.; let cc = (p.xz + 200.) / cs;
        let lf = textureLoad(lif, clamp(vec2i(floor(cc)), vec2i(0), vec2i(511)), 0);
        let fr = abs(fract(cc) - .5);
        let fw = dp.x / cs;
        let sq = 1. - smoothstep(.3 - fw, .3 + fw, max(fr.x, fr.y));
        let far = smoothstep(.25, .6, fw);
        al = mix(vec3f(.05, .06, .07), vec3f(.12, .14, .16), mix(sq, .4, far)); me = .6; ro = .35;
        ec += vec3f(.2, 1., .62) * mix(sq * lf.g, lf.g * .35, far) * 1.8;
      } else { al = vec3f(.08); me = .5; ro = .4; }
    }
    case 8u: {
      al = vec3f(.05, .06, .07); ro = .4; me = .3;
      if (top) { al *= 1. - .4 * max(aline(p.x / 1.2, .05, dp.x / 1.2), aline(p.z / 1.2, .05, dp.z / 1.2)); }
    }
    case 9u: {   // processing element: dark block, a 3 x 3 grid of multiply units on top
      al = vec3f(.05, .055, .06); me = .8; ro = .3;
      if (top) { let g = abs(fract(v.lp.xz / v.h.xz * 1.5 + 1.5) - .5); pm = 1. - smoothstep(.27, .33, max(g.x, g.y)); }
    }
    case 12u: { al = vec3f(.07, .09, .12) * (.8 + .4 * tint); ro = .45; }
    case 13u: { al = vec3f(1., .766, .336) * .34 * (.7 + .6 * vn(p.xz * .5)); me = 1.; ro = .62; }
    case 15u: {   // repeaters and clock buffers: a dark body with a small lens on top
      al = vec3f(.04); ro = .35; me = .5;
      if (top) { pm = 1. - smoothstep(.45, .55, max(abs(v.lp.x / v.h.x), abs(v.lp.z / v.h.z))); ec += vec3f(.2, .9, .85) * pm * .9; }
    }
    case 16u: { al = vec3f(.5, .52, .55); ro = .6; me = .4; }
    case 17u: { al = vec3f(.42, .36, .28) * (1. - aline(p.y / 26., .1, dp.y / 26.) * .14); ro = .5; }
    case 18u: {   // the probe needle: tungsten turned on a lathe, bright near the tip and dark where it leaves the package
      let s = dot(p, vec3f(-.5, .6, .62)) / 1.3;
      al = mix(vec3f(.5, .51, .55), vec3f(.1, .105, .12), smoothstep(60., 110., p.y) * u.prm.z); me = 1.;
      ro = .2 + .16 * aline(s, .22, fwidth(s));
    }
    case 20u: {   // the circuit board: glass fibre under green solder mask
      al = vec3f(.011, .062, .03) * (.86 + .16 * vn(p.xz * .004) + .14 * vn(p.xz * .05)); ro = .34; f0o = vec3f(.085);
      if (top) {
        let fw = max(dp.x, dp.z);
        al *= 1. + .1 * sin(p.x * .7) * sin(p.z * .7) * (1. - smoothstep(.3, 1.4, fw));
        // copper under the mask, away from the package: a hatched ground pour here, bundles of traces there, a via now and then
        let rg = vn(p.xz * .0009 + 3.7); let far = smoothstep(700., 1300., max(abs(p.x), abs(p.z)));
        let ht = max(aline((p.x + p.z) / 34., .3, fw / 34.), aline((p.x - p.z) / 34., .3, fw / 34.));
        let tr = aline(p.z / 30., .34, fw / 30.) * step(.5, vn(vec2f(p.x * .0005, floor(p.z / 30. + .5) * .37) + 9.));
        al = mix(al, vec3f(.03, .15, .075), mix(tr * smoothstep(.3, .34, rg) * (1. - smoothstep(.56, .6, rg)), ht, smoothstep(.6, .64, rg)) * .5 * far);
        let vc = floor(p.xz / 150.); let vd = length(p.xz - (vc + .5) * 150.);
        if (h12(vc) > .84) {
          let k = far * (1. - smoothstep(3., 10., fw));
          al = mix(al, vec3f(.5, .4, .17), (1. - smoothstep(9., 9. + fw, vd)) * k); al = mix(al, vec3f(.012), (1. - smoothstep(3.5, 3.5 + fw, vd)) * k);
        }
        al *= 1. - .7 * textureSampleLevel(bao, lin, p.xz / 8192. + .5, 0.).r;   // everything standing on the board shades its foot
      }
    }
    case 21u: { al = vec3f(.035, .19, .09); ro = .3; f0o = vec3f(.05); }
    case 22u: { al = vec3f(.03, .03, .035) * (.7 + .6 * vn(p.xz * .09 + p.y * .09)); ro = .38; f0o = vec3f(.05); }
    case 23u: { al = vec3f(.55, .55, .52); ro = .85; }
    case 24u: { al = mix(vec3f(.02, .04, .13), vec3f(.5, .54, .6), smoothstep(.9, .93, n.x)); ro = .36; f0o = vec3f(.07); }   // the sleeve, with its pale polarity stripe
    case 25u: { al = vec3f(.72, .73, .76); me = .8; ro = .3; }
    case 19u: { al = vec3f(1., .766, .336); me = 1.; ro = .26; ec += vec3f(1., .62, .2) * select(.04, .2, top); }   // gold lettering, faintly lit
    default: {}
  }

  if ((fl & 1u) != 0u) {   // data pulses: a bright head and a fading tail, running along the wire
    let sp = v.q.x; let gp = max(v.q.y, 1.);
    let x = fract((abs(sp) * t - sign(sp) * uu) / gp + v.q.z) * gp;
    ec += PCOL[(fl >> 6u) & 3u] * exp(-x / v.q.w) * (1. - smoothstep(gp - .3, gp, x)) * strip * select(5.5, select(1.5, 6., top), mt == 10u);
  }
  if ((fl & 2u) != 0u) {   // blinking cells, like lit windows
    ec += vec3f(.3, .85, 1.) * smoothstep(.55, 1., sin(t * v.q.y + v.q.z * 6.2832)) * select(.4, 1.6, top);
  }
  if ((fl & 4u) != 0u) {   // the clock flash, at distance u.upv.w from the root
    let x = u.upv.w - (v.q.x + v.q.y * uu);
    ec += vec3f(1., .74, .38) * select(0., exp(-x * v.q.z), x >= 0.) * select(8. * select(.2, 1., top), 16. * strip, mt == 11u);
  }
  if ((fl & 8u) != 0u) {   // the systolic wave: a front sweeps the array diagonal by diagonal
    let fr = fract(t / 4.) * 30. - 4.;
    let link = v.q.y > 0.;
    let ps = v.q.x + select(0., uu / max(v.h[la], .01) * .5, link);
    let k = exp(-(ps - fr) * (ps - fr) * 1.6);
    ec += vec3f(.3, 1., .72) * select((k * 2.3 + .1) * pm, k * 5.5 * strip, link);
  }
  if ((fl & 16u) != 0u) {   // ring oscillator
    let x = fract(t * .9 - v.q.z);
    ec += vec3f(1., .6, .25) * (exp(-x * 9.) * 4. + .25);
  }

  let f0 = select(mix(vec3f(.04), al, me), f0o, f0o.x >= 0.);
  let sh = shadow(p, n);
  let ao = aov(p, n);
  let nl = max(dot(n, LD), 0.);
  let H = normalize(LD + vv); let nh = clamp(dot(n, H), 0., 1.); let nv = clamp(dot(n, vv), 1e-3, 1.);
  let a = max(ro * ro, .003); let a2 = a * a;
  let dn = nh * nh * (a2 - 1.) + 1.;
  let kk = a * .5;
  let G = .5 / max(nl * (nv * (1. - kk) + kk) + nv * (nl * (1. - kk) + kk), 1e-4);
  let F = f0 + (1. - f0) * pow(1. - clamp(dot(vv, H), 0., 1.), 5.);
  let dif = al * (1. - me);
  var c = (dif / PI + a2 / (PI * dn * dn) * G * F) * nl * sh * LC;
  let amb = mix(vec3f(.045, .065, .075), vec3f(.13, .14, .16), n.y * .5 + .5) * (1. + .7 * (1. - u.prm.z));
  c += dif * (amb * ao.x * (.35 + .65 * ao.y) + plights(p, n));
  let Fa = f0 + (max(vec3f(1. - ro), f0) - f0) * pow(1. - nv, 5.);
  c += env(reflect(-vv, n), ro) * Fa * ao.x * (.3 + .7 * ao.y) + metal_glow(p, n, me, al);
  c += ec;
  return vec4f(fogit(c, -vv, dist), 1.);
}
// metals also mirror the coloured hot spots near them
fn metal_glow(p: vec3f, n: vec3f, me: f32, al: vec3f) -> vec3f { return plights(p, n) * al * me * .5; }

@vertex fn vfull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2. - 1., f32(i & 2u) * 2. - 1., 0., 1.);
}
@fragment fn fsky(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let s = vec2f(fp.x / u.res.z * 2. - 1., 1. - fp.y / u.res.w * 2.);
  let d = normalize(u.fwd.xyz + s.x * u.rgt.xyz + s.y * u.upv.xyz);
  let th = acos(clamp(d.y, -1., 1.));
  var c = mix(mix(vec3f(.005, .008, .016), vec3f(.012, .02, .042), smoothstep(-.1, .8, d.y)), room(d), 1. - u.prm.z);
  // the ring light: 28 LEDs, each with a little halo, and a soft glow around the whole ring
  let k = (th - .42) / .045;
  c += vec3f(1., .97, .92) * (exp(-k * k) * pow(.5 + .5 * cos(atan2(d.z, d.x) * 18.), 4.) * 5. + exp(-(th - .42) * (th - .42) * 60.) * .16);
  // the objective: a metal barrel around dark glass with faint rings of reflection
  let lens = 1. - smoothstep(.3, .315, th);
  c = mix(c, vec3f(.003, .005, .009) + vec3f(.02, .04, .07) * pow(.5 + .5 * cos(th * 110.), 6.), lens);
  c += vec3f(.07, .075, .085) * smoothstep(.315, .325, th) * (1. - smoothstep(.35, .36, th));
  let kl = dot(d, LD);
  c += LC * (smoothstep(.99955, .99975, kl) * 5. + pow(max(kl, 0.), 400.) * .28);   // the fibre lamp
  return vec4f(fogit(c, d, 1e4), 1.);
}

struct MO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32 }
@vertex fn vmote(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MO {
  let f = f32(ii); let t = u.cam.w; let B = 64.;
  let r = vec3f(h11(f * .1373 + .3), h11(f * .7311 + 3.1), h11(f * 1.3717 + 7.7));
  var p = r * B + vec3f(sin(t * .13 + f) * 1.5, t * (.1 + r.y * .2), cos(t * .11 + f * 1.3) * 1.5);
  p = u.cam.xyz + (fract((p - u.cam.xyz) / B + .5) - .5) * B;
  var cs = array<vec2f, 6>(vec2f(-1., -1.), vec2f(1., -1.), vec2f(1., 1.), vec2f(-1., -1.), vec2f(1., 1.), vec2f(-1., 1.));
  let c = cs[vi];
  let wp = p + (normalize(u.rgt.xyz) * c.x + normalize(u.upv.xyz) * c.y) * (.018 + r.x * .03);
  let d = distance(p, u.cam.xyz);
  var o: MO;
  o.pos = u.vp * vec4f(wp, 1.); o.uv = c;
  o.a = (1. - smoothstep(B * .3, B * .5, d)) * smoothstep(.2, 1.2, d) * (.35 + .65 * h11(f * 3.3 + floor(t * .7 + r.z * 9.))) * u.prm.z;
  return o;
}
@fragment fn fmote(v: MO) -> @location(0) vec4f {
  return vec4f(vec3f(.45, .78, 1.) * exp(-dot(v.uv, v.uv) * 5.) * v.a * .3, 0.);
}
`;

// shadow map: depth only, seen from the lamp
const W_SHADOW = /*wgsl*/`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> inst: array<I>;
@vertex fn vshb(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let b = inst[ii];
  return u.sh * vec4f(b.c + rot(corner(vi) * b.h, b.yaw), 1.);
}
@vertex fn vsht(@location(0) p: vec3f) -> @builtin(position) vec4f { return u.sh * vec4f(p, 1.); }
@vertex fn vshb2(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let b = inst[ii];
  return u.sh2 * vec4f(b.c + rot(corner(vi) * b.h, b.yaw), 1.);
}
@vertex fn vsht2(@location(0) p: vec3f) -> @builtin(position) vec4f { return u.sh2 * vec4f(p, 1.); }
`;

// culling: every box tests itself against the view and its own size; survivors are appended to the draw list
const W_CULL = /*wgsl*/`
struct A { ic: u32, cnt: atomic<u32>, fi: u32, bv: u32, fs: u32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> inst: array<I>;
@group(0) @binding(2) var<storage, read_write> vis: array<u32>;
@group(0) @binding(3) var<storage, read_write> ar: A;
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= arrayLength(&inst)) { return; }
  let b = inst[i]; let r = length(b.h);
  for (var k = 0; k < 5; k++) { let pl = u.pl[k]; if (dot(pl.xyz, b.c) + pl.w < -r) { return; } }
  if (distance(b.c, u.cam.xyz) - r > u.prm.w) { return; }
  if (pxs(b, u.cam.xyz, u.prm.y) < u.prm.x) { return; }
  vis[atomicAdd(&ar.cnt, 1u)] = i;
}
`;

// Game of Life on the cache bits: r alive, g a glow that fades after the bit dies; random flips keep it busy
const W_LIFE = /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> ls: vec4f;
@compute @workgroup_size(8, 8) fn life(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2i(g.xy);
  var n = 0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    if (x != 0 || y != 0) { n += i32(textureLoad(src, (p + vec2i(x, y)) & vec2i(511), 0).r > .5); }
  } }
  let c = textureLoad(src, p, 0);
  var a = n == 3 || (c.r > .5 && n == 2);
  if (h12(vec2f(p) + ls.x * 17.13) < .0012) { a = !a; }
  textureStore(dst, p, vec4f(select(0., 1., a), select(c.g * .6, 1., a), 0., 1.));
}
`;

// light shafts: march from the eye to the first surface, adding lamp light wherever the shadow map says it is lit
const W_RAYS = /*wgsl*/`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var dep: ${AA > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@group(0) @binding(2) var shm: texture_depth_2d;
@group(0) @binding(3) var shs: sampler_comparison;
${W_FOG}
@vertex fn vfull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2. - 1., f32(i & 2u) * 2. - 1., 0., 1.);
}
@fragment fn frays(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let fx = min(fp.xy * ${RAYDIV}., u.res.zw - 1.);
  let z = textureLoad(dep, vec2i(fx), 0);
  let s = vec2f(fx.x / u.res.z * 2. - 1., 1. - fx.y / u.res.w * 2.);
  let D = u.fwd.xyz + s.x * u.rgt.xyz + s.y * u.upv.xyz;
  let L = length(D); let d = D / L;
  let tm = select(380., min(u.fwd.w / z * L, 380.), z > 0.);
  let j = fract(52.9829189 * fract(dot(fp.xy, vec2f(.06711056, .00583715))));
  var acc = 0.; var pt = 0.;
  for (var i = 0; i < ${RAYN}; i++) {
    let f = (f32(i) + j) / ${RAYN}.; let ti = tm * f * f;
    let p = u.cam.xyz + d * ti;
    let q = u.sh * vec4f(p, 1.); let uv = vec2f(q.x * .5 + .5, .5 - q.y * .5);
    var lit = 1.;
    if (uv.x > 0. && uv.x < 1. && uv.y > 0. && uv.y < 1.) { lit = textureSampleCompareLevel(shm, shs, uv, q.z); }
    acc += lit * fdens(p.y) * exp(-tau(u.cam.xyz, d, ti)) * (ti - pt);
    pt = ti;
  }
  let g = .55; let cs = dot(d, LD);
  let ph = (1. - g * g) / (4. * PI * pow(1. + g * g - 2. * g * cs, 1.5));
  return vec4f(vec3f(1.45, 1.95, 2.75) * acc * (min(ph, .15) * .8 + .006) * u.prm.z, z);   // capped, so looking toward the lamp does not white out; the depth goes along for the enlargement
}
`;

// bloom: 13-tap downsample (with a Karis average on the first step against fireflies), tent upsample added on top
const W_BLOOM = /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@vertex fn vfull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2. - 1., f32(i & 2u) * 2. - 1., 0., 1.);
}
fn S(uv: vec2f) -> vec3f { return min(textureSampleLevel(src, smp, uv, 0.).rgb, vec3f(60.)); }
fn kw(c: vec3f) -> f32 { return 1. / (1. + dot(c, vec3f(.2126, .7152, .0722))); }
fn down(fp: vec2f, karis: bool) -> vec3f {
  let sd = vec2f(textureDimensions(src)); let uv = fp / max(floor(sd / 2.), vec2f(1.)); let t = 1. / sd;
  let a = S(uv + t * vec2f(-2., -2.)); let b = S(uv + t * vec2f(0., -2.)); let c = S(uv + t * vec2f(2., -2.));
  let d = S(uv + t * vec2f(-1., -1.)); let e = S(uv + t * vec2f(1., -1.));
  let f = S(uv + t * vec2f(-2., 0.)); let g = S(uv); let h = S(uv + t * vec2f(2., 0.));
  let i = S(uv + t * vec2f(-1., 1.)); let j = S(uv + t * vec2f(1., 1.));
  let k = S(uv + t * vec2f(-2., 2.)); let l = S(uv + t * vec2f(0., 2.)); let m = S(uv + t * vec2f(2., 2.));
  let g0 = (d + e + i + j) * .25; let g1 = (a + b + f + g) * .25; let g2 = (b + c + g + h) * .25;
  let g3 = (f + g + k + l) * .25; let g4 = (g + h + l + m) * .25;
  if (karis) {
    let w0 = kw(g0) * .5; let w1 = kw(g1) * .125; let w2 = kw(g2) * .125; let w3 = kw(g3) * .125; let w4 = kw(g4) * .125;
    return (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  }
  return g0 * .5 + (g1 + g2 + g3 + g4) * .125;
}
@fragment fn fdown0(@builtin(position) fp: vec4f) -> @location(0) vec4f { return vec4f(down(fp.xy, true), 1.); }
@fragment fn fdown(@builtin(position) fp: vec4f) -> @location(0) vec4f { return vec4f(down(fp.xy, false), 1.); }
@fragment fn fup(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let sd = vec2f(textureDimensions(src)); let uv = fp.xy / (sd * 2.); let t = 1. / sd;
  var c = S(uv) * 4.;
  c += (S(uv + vec2f(t.x, 0.)) + S(uv - vec2f(t.x, 0.)) + S(uv + vec2f(0., t.y)) + S(uv - vec2f(0., t.y))) * 2.;
  c += S(uv + t) + S(uv - t) + S(uv + vec2f(t.x, -t.y)) + S(uv + vec2f(-t.x, t.y));
  return vec4f(c / 16., 1.);
}
`;

// depth of field, at half resolution: a fixed spiral of taps around every pixel that is out of focus. Half resolution
// and bilinear sampling make the blur smooth without any per-pixel dither.
const W_DOF = /*wgsl*/`
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> pp: array<vec4f, 3>;
@group(0) @binding(3) var dep: ${AA > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@vertex fn vfull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2. - 1., f32(i & 2u) * 2. - 1., 0., 1.);
}
// blur radius in screen pixels: how far (in diopters) this pixel's depth is from the focus plane; things in front blur less
fn coc(uv: vec2f) -> f32 {
  let z = textureLoad(dep, vec2i(clamp(uv, vec2f(0.), vec2f(.9999)) * pp[1].zw), 0);
  let dq = z / pp[2].z - pp[2].x;
  return min(abs(dq) * pp[2].y * select(1., .3, dq > 0.), pp[2].w);
}
@fragment fn fdof(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let uv = fp.xy * 2. / pp[1].zw; let px = .5 / pp[1].zw;
  // four full-size pixels sit under this one. It takes the blur of the most out-of-focus of them and keeps the sharp ones
  // out of its colour: where sharp meets blurred is settled per pixel in the final pass, so that edge stays clean
  let a = coc(uv - px); let b = coc(uv + vec2f(px.x, -px.y)); let e = coc(uv + vec2f(-px.x, px.y)); let f = coc(uv + px);
  let r = max(max(a, b), max(e, f));
  var w = clamp(min(min(a, b), min(e, f)) / max(r, 1e-3), .06, 1.);
  var c = textureSampleLevel(hdr, smp, uv, 0.).rgb * w;
  if (r > .5) {
    for (var i = 0; i < 16; i++) {
      let t = f32(i) * 2.4;
      let q = uv + vec2f(cos(t), sin(t)) * r * sqrt((f32(i) + .5) / 16.) / pp[1].xy;
      let wt = clamp(coc(q) / r, .06, 1.);
      c += textureSampleLevel(hdr, smp, q, 0.).rgb * wt; w += wt;
    }
  }
  return vec4f(c / w, 1.);
}
`;

// final image: depth of field, bloom, shafts, exposure, tone map, a light grade, vignette, grain
const W_POST = /*wgsl*/`
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var blm: texture_2d<f32>;
@group(0) @binding(2) var ray: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var<uniform> pp: array<vec4f, 3>;
@group(0) @binding(5) var dof: texture_2d<f32>;
@group(0) @binding(6) var dep: ${AA > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@vertex fn vfull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2. - 1., f32(i & 2u) * 2. - 1., 0., 1.);
}
@fragment fn fpost(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let uv = fp.xy / pp[1].xy;
  let o = uv - .5;
  let ca = dot(o, o) * .004;   // a trace of colour fringing toward the corners, like a real objective
  var c = vec3f(textureSampleLevel(hdr, smp, uv - o * ca, 0.).r, textureSampleLevel(hdr, smp, uv, 0.).g, textureSampleLevel(hdr, smp, uv + o * ca, 0.).b);
  // when the graphics card is busy the picture is drawn smaller than the screen and enlarged: the smaller it was drawn,
  // the more its edges are sharpened here (never by more than a third of the local brightness, so nothing rings)
  let tx = 1. / pp[1].zw;
  let nb = (textureSampleLevel(hdr, smp, uv + vec2f(tx.x, 0.), 0.).rgb + textureSampleLevel(hdr, smp, uv - vec2f(tx.x, 0.), 0.).rgb
    + textureSampleLevel(hdr, smp, uv + vec2f(0., tx.y), 0.).rgb + textureSampleLevel(hdr, smp, uv - vec2f(0., tx.y), 0.).rgb) * .25;
  let lim = (c + .03) * .33;
  c += clamp((c - nb) * mix(.3, 1.3, clamp((1. - pp[1].z / pp[1].x) * 2.5, 0., 1.)), -lim, lim);
  let z = textureLoad(dep, vec2i(min(uv * pp[1].zw, pp[1].zw - 1.)), 0);
  let dq = z / pp[2].z - pp[2].x;   // this pixel's own blur decides how much of the blurred image it takes
  c = mix(c, textureSampleLevel(dof, smp, uv, 0.).rgb, smoothstep(.5, 1.7, min(abs(dq) * pp[2].y * select(1., .3, dq > 0.), pp[2].w)));
  c += textureSampleLevel(blm, smp, uv, 0.).rgb * pp[0].y;
  // the shafts are marched at low resolution with a jittered start. Enlarging them, each pixel averages the nine nearest
  // samples (which cancels the jitter) and listens mostly to those at its own depth, so a near beam in front of bright
  // haze keeps a clean edge instead of a staircase
  let rd = vec2f(textureDimensions(ray)); let rp = uv * rd - .5; let ri = floor(rp + .5);
  var rc = vec3f(0.); var rw = 0.;
  for (var k = 0; k < 9; k++) {
    let q = ri + vec2f(f32(k % 3), f32(k / 3)) - 1.;
    let t = textureLoad(ray, vec2i(clamp(q, vec2f(0.), rd - 1.)), 0);
    let w = exp(-dot(q - rp, q - rp) * .6) / (.03 + abs(t.a - z) / max(max(t.a, z), 1e-6));
    rc += t.rgb * w; rw += w;
  }
  c += rc / rw * pp[0].z;
  c *= pp[0].x;
  c = clamp((c * (2.51 * c + .03)) / (c * (2.43 * c + .59) + .14), vec3f(0.), vec3f(1.));
  // grade: a little more contrast, cool shadows, warm highlights
  let l = dot(c, vec3f(.2126, .7152, .0722));
  c = mix(c, c * c * (3. - 2. * c), .22) + vec3f(-.006, .001, .012) * (1. - l) * (1. - l) + vec3f(.012, .004, -.01) * l * l;
  c *= 1. - dot(o, o) * .6;
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  c += (h12(fp.xy + fract(pp[0].w) * 97.) - .5) / 150.;
  return vec4f(c, 1.);
}
`;
