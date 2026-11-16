// ============================================================================
// world: the chip, its package and everything on them, built from rules and a fixed seed
// ============================================================================
// One unit is one micron. The die is 400 x 400 with its surface at y = 0; the metal stack rises above it to y = 37.4.
// Every solid is a box (center, half size, yaw, material, flags, four shader parameters) and one instanced call draws
// them all. The gold bond wires and the probe needle are the only real meshes.

// materials (the shader's switch uses the same numbers)
const SI = 0, CELL = 1, CU = 2, VIA = 3, AL = 4, AU = 5, CER = 6, SRAM = 7, PEB = 8, PEC = 9, IND = 10, CLK = 11,
  DCAP = 12, PADL = 13, HOT = 14, BUF = 15, EPX = 16, CAPB = 17, NEEDLE = 18, GOLDL = 19,
  PCB = 20, TRACE = 21, EPOXY = 22, SILK = 23, SLEEVE = 24, SOLDER = 25;
// flags: data pulses, blinking, clock, systolic wave, ring oscillator, floor (kept out of the occlusion bake)
const F_PULSE = 1 << 16, F_BLINK = 1 << 17, F_CLOCK = 1 << 18, F_WAVE = 1 << 19, F_RING = 1 << 20, F_FLOOR = 1 << 21, F_TEXT = 1 << 24;
const PC_AMBER = 1 << 22, PC_GREEN = 2 << 22, PC_WHITE = 3 << 22;   // pulse colour (cyan when none)

// ---------------------------------------------------------------- the box list
const IMAX = 200000, IST = 12;   // 12 floats = 48 bytes per box: c.xyz, m | h.xyz, yaw | q.xyzw
const IB = new ArrayBuffer(IMAX * IST * 4), IF = new Float32Array(IB), IU = new Uint32Array(IB);
let NI = 0;
function box(cx, cy, cz, hx, hy, hz, m, q0 = 0, q1 = 0, q2 = 0, q3 = 0, yaw = 0) {
  if (NI >= IMAX) return;
  const o = NI++ * IST;
  IF[o] = cx; IF[o + 1] = cy; IF[o + 2] = cz; IU[o + 3] = m | (rnd() * 256) << 8;   // bits 8-15: a random tint
  IF[o + 4] = hx; IF[o + 5] = hy; IF[o + 6] = hz; IF[o + 7] = yaw;
  IF[o + 8] = q0; IF[o + 9] = q1; IF[o + 10] = q2; IF[o + 11] = q3;
}
// box from its two corners
const bb = (x0, y0, z0, x1, y1, z1, m, q0, q1, q2, q3) =>
  box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, m, q0, q1, q2, q3);
// a square frame around the origin: inner half size r0, outer r1
function sqring(r0, r1, y0, y1, m) {
  bb(-r1, y0, -r1, r1, y1, -r0, m); bb(-r1, y0, r0, r1, y1, r1, m);
  bb(-r1, y0, -r0, -r0, y1, r0, m); bb(r0, y0, -r0, r1, y1, r0, m);
}

// pulse parameters come from their own random stream, so identical cores still pulse differently
let PS = 99;
const prnd = () => (PS = Math.imul(PS, 1664525) + 1013904223 >>> 0) / 4294967296;
// [signed speed, spacing, phase, tail length]
const pulse = (sp, gap) => [sp * (prnd() < .5 ? -1 : 1) * (.7 + prnd() * .6), gap * (.6 + prnd() * .8), prnd(), 1 + prnd() * 2.2];

// ---------------------------------------------------------------- the metal stack
// [bottom, thickness, width, direction: 0 runs along x, 1 along z]
const MY = [[1.25, .16, .16, 0], [1.7, .16, .16, 1], [2.55, .3, .3, 0], [3.6, .3, .3, 1], [5.1, .45, .45, 0],
  [6.9, .45, .45, 1], [11, .8, 1, 0], [20, .8, 1, 1], [28, 2.4, 4, 0], [34, 2.4, 4, 1]];
const CKY = [15, 16.6], CKT = .7, CKW = 1.1;   // the clock tree's two layers
const Z4 = [0, 0, 0, 0];

// a wire on layer L from a to b along its direction, centred at c across it
function wire(L, a, b, c, m = CU, q = Z4) {
  const [y, t, w, d] = MY[L];
  if (d) bb(c - w / 2, y, a, c + w / 2, y + t, b, m, ...q); else bb(a, y, c - w / 2, b, y + t, c + w / 2, m, ...q);
}
// a via from the layer under L (or from the cells) up to L
function via(L, x, z, w) {
  const y1 = MY[L][0], y0 = L ? MY[L - 1][0] + MY[L - 1][1] : .9;
  w = w || min(MY[L][2], L ? MY[L - 1][2] : 1) * .85;
  bb(x - w / 2, y0, z - w / 2, x + w / 2, y1, z + w / 2, VIA);
}
// fill rect r = [x0, z0, x1, z1] with wires on layer L: tracks `pitch` apart, segments l0..l1 long,
// a share `occ` of them present, `pp` of those carrying pulses, `nv` vias per wire
function route(r, L, pitch, l0, l1, occ, pp, nv) {
  const d = MY[L][3], [x0, z0, x1, z1] = r;
  const c0 = d ? x0 : z0, c1 = d ? x1 : z1, a0 = d ? z0 : x0, a1 = d ? z1 : x1;
  for (let c = c0 + pitch * .5; c < c1; c += pitch) {
    let a = a0 + rr(0, l0);
    for (;;) {
      const len = rr(l0, l1);
      if (a + len > a1) break;
      if (rnd() < occ) {
        const pu = rnd() < pp;
        wire(L, a, a + len, c, pu ? CU | F_PULSE | (rnd() < .2 ? PC_WHITE : 0) : CU, pu ? pulse(12, 20) : Z4);
        for (let k = 0; k < nv; k++) {
          const e = k ? a + len - .3 : a + .3;
          d ? via(L, c, e) : via(L, e, c);
        }
      }
      a += len + rr(.4, 1.6) * l0;
    }
  }
}
// wiring over a logic area: dense local layers, then sparser and longer ones
function stack(r, k, low = 1) {
  if (low) { route(r, 0, .62, 1, 6, .3 * k, .015, 1); route(r, 1, .62, 1, 6, .3 * k, .015, 1); }
  route(r, 2, 1.25, 3, 14, .36 * k, .05, 2); route(r, 3, 1.25, 3, 14, .36 * k, .05, 2);
  route(r, 4, 2.1, 6, 30, .4 * k, .08, 2); route(r, 5, 2.1, 6, 30, .4 * k, .08, 2);
}

// ---------------------------------------------------------------- building blocks
const CWS = [.6, .8, .8, 1, 1.2, 1.2, 1.6, 2, 2.4, 3.2];
// standard cell rows: small boxes on the silicon. hot = [x, z, radius] marks a hot spot that glows.
function cells(r, pal, hot) {
  const [x0, z0, x1, z1] = r;
  for (let z = z0 + .15; z + 1.3 <= z1; z += 1.6) {
    let x = x0 + rr(0, .8);
    while (x + .6 < x1) {
      const w = min(pick(CWS), x1 - x);
      if (rnd() < .88) {
        let m = CELL, q3 = 0;
        if (hot) { const dd = hypot(x - hot[0], z - hot[1]) / hot[2]; if (dd < 1) { m = HOT; q3 = (1 - dd) * (1 - dd); } }
        if (rnd() < .025) m |= F_BLINK;
        bb(x + .04, 0, z, x + w - .04, rr(.22, .85), z + 1.3, m, (pal + (rnd() < .25 ? ri(1, 2) : 0)) & 7, rr(.3, 1.2), rnd(), q3);
      }
      x += w;
    }
  }
}
// an SRAM bank: a plate whose top shows the bits (the shader reads them from the Game of Life texture),
// row decoders along its west edge, sense amplifiers along its south edge, bit lines over it
function sram(r) {
  const [x0, z0, x1, z1] = r;
  bb(x0, 0, z0, x1, .5, z1, SRAM);
  for (let z = z0; z < z1 - .5; z += .8) bb(x0 - 1.6, 0, z, x0 - .25, rr(.3, .7), z + .6, CELL, 7);
  for (let x = x0; x < x1 - .5; x += .9) bb(x, 0, z1 + .25, x + .7, rr(.3, .8), z1 + 1.5, CELL, 1);
  for (let x = x0 + 1.1; x < x1; x += 2.2) wire(3, z0, z1, x);
}
// octagonal spiral inductor on the thick top metal
function spiral(cx, cz, R, turns, w) {
  const n = turns * 8 | 0, pitch = w * 1.7;
  const gap = 26, ph = prnd();
  for (let i = 0, s = 0; i < n; i++) {   // current runs around the coil as a train of amber pulses
    const a = i * PI / 4, r = R - pitch * i / 8, hl = r * tan(PI / 8);
    box(cx + cos(a) * r, 32.75, cz + sin(a) * r, w / 2, 1.25, hl + w / 2, IND | F_PULSE | PC_AMBER, 9, gap, ph - (s + hl) / gap, 1.6, a);
    s += 2 * hl;
  }
  // the inner end dives under the coil and comes out the side
  bb(cx - .9, 28.4, cz - .9, cx + .9, 31.5, cz + .9, VIA);
  bb(cx - .9, 27.4, cz, cx + .9, 28.4, cz + R + 6, CU);
  for (let k = 0; k < 8; k++) {   // guard ring on the floor
    const a = k * PI / 4, g = R + 4;
    box(cx + cos(a) * g, .25, cz + sin(a) * g, .6, .25, g * tan(PI / 8) + .6, DCAP, 0, 0, 0, 0, a);
  }
}

// ---------------------------------------------------------------- floorplan
// [x0, z0, x1, z1, name, line, floor pattern (0 plain, 1 rows, 2 grid, 3 lanes), oxide thickness]
const BLK = [];
const GLOW = [];   // light sources inside the haze: [x, y, z, power, r, g, b, radius]
const HOTS = [];   // hot spots on the floor: [x, z]
const BOND = [];   // every tube again as a chain of capsules, for collisions: { p: points, r: radii, c: centre, R: reach, f: fat }
const TV = [], TX = [];
let TUBE_V, TUBE_I;

// a tube along the points P (flat x y z) with one radius per point: rings of RS vertices on a frame carried along the
// curve without twisting. Vertex = position, normal, material.
function tube(P, R, RS, mat) {
  const n = R.length, base = TV.length / 7;
  let N = null, cx = 0, cy = 0, cz = 0, rad = 0;
  for (let i = 0; i < n; i++) {
    const a = max(0, i - 1) * 3, b = min(n - 1, i + 1) * 3, o = i * 3;
    const T = norm3([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]]);
    if (!N) N = norm3(cross3(T, abs(T[1]) > .9 ? [1, 0, 0] : [0, 1, 0]));
    else { const d = dot3(N, T); N = norm3([N[0] - T[0] * d, N[1] - T[1] * d, N[2] - T[2] * d]); }
    const B = cross3(T, N);
    for (let j = 0; j < RS; j++) {
      const g = j / RS * PI * 2, c = cos(g), s = sin(g), nx = N[0] * c + B[0] * s, ny = N[1] * c + B[1] * s, nz = N[2] * c + B[2] * s;
      TV.push(P[o] + nx * R[i], P[o + 1] + ny * R[i], P[o + 2] + nz * R[i], nx, ny, nz, mat);
    }
    cx += P[o] / n; cy += P[o + 1] / n; cz += P[o + 2] / n;
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < RS; j++) {
    const p = base + i * RS + j, q = base + i * RS + (j + 1) % RS;
    TX.push(p, q, p + RS, q, q + RS, p + RS);
  }
  for (let i = 0; i < n; i++) rad = max(rad, hypot(P[i * 3] - cx, P[i * 3 + 1] - cy, P[i * 3 + 2] - cz) + R[i]);
  BOND.push({ p: P, r: R, c: [cx, cy, cz], R: rad, f: max(...R) > 20 });   // the fat ones are the upright cans on the board
}
const AN = [-50, -180, 50, -60];   // analog block: the power grid stays away from the coils

function core(sx, sz, id) {
  const R = (a0, b0, a1, b1) => {
    const x0 = sx * (60 + a0), x1 = sx * (60 + a1), z0 = sz * (60 + b0), z1 = sz * (60 + b1);
    return [min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1)];
  };
  rseed(777);   // the four cores are one design, mirrored
  BLK.push([...R(0, 0, 120, 120), tr('ליבה ', 'Core ') + (id + 1), tr('כאן רצות הפקודות. כל קובייה קטנה על הרצפה היא תא לוגי.', 'Instructions run here. Every little box on the floor is a logic cell.'), 1, .55 + id * .04]);
  for (let k = 0; k < 4; k++) sram(R(4, 4 + k * 29, 31, 30 + k * 29));   // L2 cache
  sram(R(38, 5, 58, 25)); sram(R(38, 31, 58, 51));                      // L1 instruction and data caches
  sram(R(64, 5, 82, 31));                                                // register file
  const hx = sx * 161, hz = sz * 84;
  cells(R(86, 3, 117, 45), 3, [hx, hz, 24]);                             // execution units: the hot spot
  cells(R(36, 56, 117, 117), 0);
  stack(R(86, 3, 117, 45), 1.1);
  stack(R(36, 56, 117, 117), 1);
  stack(R(34, 3, 84, 54), .35, 0);
  GLOW.push([hx, 4, hz, .55, 1, .36, .1, 7]);
  HOTS.push([hx, hz]);
}

function cache() {
  rseed(31);
  BLK.push([-50, -50, 50, 50, tr('המטמון המשותף', 'The shared cache'), tr('כל נקודת אור היא ביט. הם מתחלפים כל הזמן, כמו זיכרון שעובד.', 'Every point of light is a bit. They keep flipping, like memory at work.'), 2, .2]);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) sram([-46 + 24 * i, -46 + 24 * j, -26 + 24 * i, -28 + 24 * j]);
  route([-48, -48, 48, 48], 4, 2.4, 10, 40, .25, .2, 2);
  route([-48, -48, 48, 48], 5, 2.4, 10, 40, .25, .2, 2);
  GLOW.push([0, 3, 0, .25, .2, 1, .7, 30]);
}

function ai() {
  rseed(41);
  BLK.push([60, -50, 180, 50, tr('מאיץ הבינה המלאכותית', 'The AI accelerator'), tr('מערך של מעבדים זעירים. גלי האור הם נתונים שזורמים מאחד לשני.', 'An array of tiny processors. The waves of light are data flowing from one to the next.'), 2, .82]);
  const x0 = 62, z0 = -48, nx = 12, nz = 10, px = 116 / nx, pz = 96 / nz;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const cx = x0 + (i + .5) * px, cz = z0 + (j + .5) * pz, d = i + j;
    bb(cx - px * .43, 0, cz - pz * .43, cx + px * .43, .35, cz + pz * .43, PEB);
    box(cx, 1.1, cz, 1.9, .75, 1.9, PEC | F_WAVE, d);
    for (let k = 0; k < 6; k++) { const a = k * PI / 3 + .5; box(cx + cos(a) * 3.1, .6, cz + sin(a) * 3.1, .55, .25, .55, CELL, 5); }
    if (i < nx - 1) { wire(2, cx + 1.9, cx + px - 1.9, cz, CU | F_WAVE, [d + .5, 1, 0, 0]); via(2, cx + 2.2, cz, .3); }
    if (j < nz - 1) { wire(3, cz + 1.9, cz + pz - 1.9, cx, CU | F_WAVE, [d + .5, 1, 0, 0]); via(3, cx, cz + 2.2, .3); }
  }
  route([60, -50, 180, 50], 6, 4.8, 20, 60, .3, .35, 2);
  GLOW.push([120, 4, 0, .25, .25, 1, .72, 22]);
}

function memctl() {
  rseed(51);
  BLK.push([-180, -50, -60, 50, tr('בקר הזיכרון', 'The memory controller'), tr('מכאן יוצאים נתונים לזיכרון שמחוץ לשבב, בפרצים מהירים.', 'From here data leaves for the memory outside the chip, in fast bursts.'), 1, .95]);
  const x0 = -180, x1 = -60, z0 = -50;
  for (let k = 0; k < 8; k++) {
    const za = z0 + k * 12.5 + 1, zb = za + 10.5;
    bb(x0 + 2, 0, za, x1 - 24, .15, zb, DCAP);
    for (let x = x0 + 3; x < x1 - 27; x += 4) {
      bb(x, .15, za + .6, x + 2.6, rr(.7, 1.3), za + 3.4, CELL, 2);
      bb(x + .3, .15, zb - 3.2, x + 2.3, rr(.4, .7), zb - .6, DCAP);
    }
    const dir = k & 1 ? 1 : -1;
    for (let w = 0; w < 4; w++) {
      wire(4, x0 + 2, x1 - 22, za + 4.4 + w * 1.05, CU | F_PULSE | PC_AMBER, [dir * (30 + prnd() * 10), 7 + prnd() * 5, prnd(), 1.4]);
      via(4, x0 + 2.5, za + 4.4 + w * 1.05); via(4, x1 - 22.5, za + 4.4 + w * 1.05);
    }
  }
  cells([x1 - 22, -49, x1 - 2, 49], 3);
  stack([x1 - 22, -50, x1 - 2, 50], 1);
  route([x0 + 2, -50, x1 - 24, 50], 5, 3, 10, 40, .3, .1, 2);
}

function analog() {
  rseed(61);
  BLK.push([...AN, tr('הבלוק האנלוגי', 'The analog block'), tr('סלילי נחושת ומתנד יוצרים כאן את קצב השעון של כל השבב.', 'Copper coils and an oscillator make the clock beat for the whole chip here.'), 0, .4]);
  spiral(-24, -130, 19, 3.5, 2.4); spiral(24, -130, 19, 3.5, 2.4); spiral(0, -166, 10, 2.5, 1.8);
  for (let i = 0; i < 9; i++) {   // ring oscillator: a light runs around it
    const a = i / 9 * PI * 2;
    box(-36 + cos(a) * 4.4, .7, -98 + sin(a) * 4.4, .8, .7, .8, CELL | F_RING, 6, 0, i / 9, 0, -a);
  }
  for (let z = -103; z < -90; z += 3.4) for (const s of [-1, 1]) bb(s * 5 - 4, 0, z, s * 5 + 4, .45, z + 1.5, DCAP);   // resistor ladders
  for (const [ax, bx] of [[-48, -12], [12, 48]])
    for (let x = ax; x < bx - 2; x += 3.2) for (let z = -100; z < -64; z += 3.2) bb(x, 0, z, x + 2.6, .6, z + 2.6, DCAP);
}

function uncore() {
  rseed(71);
  BLK.push([-50, 60, 50, 180, tr('בקרי הקלט־פלט', 'The I/O controllers'), tr('בקרים שמדברים עם העולם שמחוץ לשבב: מסך, דיסק ורשת.', 'Controllers that talk to the world outside the chip: screen, disk and network.'), 1, .7]);
  for (let k = 0; k < 4; k++) sram([-46 + k * 24, 146, -28 + k * 24, 174]);
  cells([-48, 62, 48, 138], 4);
  stack([-48, 62, 48, 138], 1);
}

// the channels between the blocks: a low data highway, with repeaters on the floor like street lights
function streets() {
  rseed(81);
  for (const c of [-55, 55]) {
    for (let k = -2; k <= 2; k++) {
      const q = () => [(k < 0 ? -1 : 1) * (26 + prnd() * 8), 16 + prnd() * 10, prnd(), 2 + prnd() * 2];
      wire(5, -180, 180, c + k * 1.5, CU | F_PULSE | (k & 1 ? PC_WHITE : 0), q());
      wire(4, -180, 180, c + k * 1.5, CU | F_PULSE | (k & 1 ? PC_WHITE : 0), q());
    }
    for (let a = -176; a < 177; a += 8) for (const s of [-3.8, 3.8]) {
      if (abs(a - 55) < 6 || abs(a + 55) < 6) continue;
      bb(c + s - .7, 0, a - .7, c + s + .7, .8, a + .7, BUF);
      bb(a - .7, 0, c + s - .7, a + .7, .8, c + s + .7, BUF);
    }
  }
}

// the clock tree: an H inside an H inside an H. A flash leaves the root at the centre and reaches every leaf together.
function htree(cx, cz, hl, lev, d0) {
  const q = (d, s) => [d, s, .03, 0];
  for (const s of [-1, 1]) {
    // half of the H's bar, from the centre outward along x; distance from the root grows outward
    box(cx + s * hl / 2, CKY[0] + CKT / 2, cz, hl / 2 + CKW / 2, CKT / 2, CKW / 2, CLK | F_CLOCK, ...q(d0 + hl / 2, s));
    const ex = cx + s * hl, d1 = d0 + hl;
    bb(ex - .5, CKY[0] + CKT, cz - .5, ex + .5, CKY[1], cz + .5, VIA);
    for (const t of [-1, 1]) {
      box(ex, CKY[1] + CKT / 2, cz + t * hl / 2, CKW / 2, CKT / 2, hl / 2 + CKW / 2, CLK | F_CLOCK, ...q(d1 + hl / 2, t));
      const tz = cz + t * hl, d2 = d1 + hl;
      if (lev) htree(ex, tz, hl / 2, lev - 1, d2);
      else {   // a leaf: the flash drops down a column to a clock buffer on the floor
        bb(ex - .55, CKY[1], tz - .55, ex + .55, CKY[1] + CKT, tz + .55, CLK | F_CLOCK, d2, 0, .03, 0);
        const h = CKY[1] / 2;
        box(ex, h, tz, .3, h, .3, CLK | F_CLOCK, d2 + h, -1, .03, 0);
        box(ex, .5, tz, 1.1, .5, 1.1, BUF | F_CLOCK, d2 + CKY[1], 0, .012, 0);
      }
    }
  }
}

// power: thick straps every 48 units on the two top layers, via arrays where they cross, pillars down to the global wires
function power() {
  rseed(91);
  const inA = (x, z, m) => x > AN[0] - m && x < AN[2] + m && z > AN[1] - m && z < AN[3] + m;
  const strap = (L, a, b, c) => { const [y, t, , d] = MY[L]; d ? bb(c - 2.6, y, a, c + 2.6, y + t, b, CU) : bb(a, y, c - 2.6, b, y + t, c + 2.6, CU); };
  for (let k = -3; k <= 3; k++) {
    const c = k * 48;
    if (c > AN[1] - 3 && c < AN[3] + 3) { strap(8, -178, AN[0] - 5, c); strap(8, AN[2] + 5, 178, c); } else strap(8, -178, 178, c);
    if (c > AN[0] - 3 && c < AN[2] + 3) strap(9, AN[3] + 14, 178, c); else strap(9, -178, 178, c);
  }
  for (let i = -3; i <= 3; i++) for (let k = -3; k <= 3; k++) {
    const x = i * 48, z = k * 48;
    if (inA(x, z, 3)) continue;
    for (const a of [-1.3, 0, 1.3]) for (const b of [-1.3, 0, 1.3]) bb(x + a - .45, 30.4, z + b - .45, x + a + .45, 34, z + b + .45, VIA);
    if (inA(x, z, 8)) continue;
    bb(x - .9, 11.8, z - .9, x + .9, 28, z + .9, VIA);
    bb(x - 1.8, 11, z - 1.8, x + 1.8, 11.8, z + 1.8, CU);
  }
}

// a bus: n parallel wires along a path of axis-aligned points, x runs on M7 and z runs on M8
function bus(pts, n, col, sp, gap) {
  for (let k = 0; k < n; k++) {
    const o = (k - (n - 1) / 2) * 1.8, ph = prnd();
    let s = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], len = abs(bx - ax) + abs(bz - az), sg = sign(bx - ax + bz - az);
      const q = [sg * sp, gap, ph - (s + len / 2) / gap, 2.5];
      if (az === bz) wire(6, min(ax, bx) + o, max(ax, bx) + o, az + o, CU | F_PULSE | col, q);
      else wire(7, min(az, bz) + o, max(az, bz) + o, ax + o, CU | F_PULSE | col, q);
      if (i) bb(ax + o - .45, 11.8, az + o - .45, ax + o + .45, 20, az + o + .45, VIA);
      s += len;
    }
  }
}
function buses() {
  rseed(101);
  // the ring bus around the cache: eight wires, nested squares, everything flowing clockwise
  for (let k = 0; k < 8; k++) {
    const r = 51.2 + k * 1.6, per = 8 * r, gap = per / round(per / 22), ph = prnd(), sp = 30;
    const segs = [[-r, -r, r, -r], [r, -r, r, r], [r, r, -r, r], [-r, r, -r, -r]];
    let s = 0;
    for (const [ax, az, bx, bz] of segs) {
      const len = 2 * r, sg = sign(bx - ax + bz - az), q = [sg * sp, gap, ph - (s + r) / gap, 3];
      if (az === bz) wire(6, -r - .5, r + .5, az, CU | F_PULSE | PC_GREEN, q);
      else wire(7, -r - .5, r + .5, ax, CU | F_PULSE | PC_GREEN, q);
      bb(ax - .45, 11.8, az - .45, ax + .45, 20, az + .45, VIA);
      s += len;
    }
  }
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]])
    bus([[sx * 100, sz * 96], [sx * 24, sz * 96], [sx * 24, sz * 46]], 6, 0, 24, 30);
  bus([[-44, 10], [-150, 10]], 8, PC_AMBER, 30, 18);
  bus([[44, -10], [160, -10]], 8, 0, 28, 24);
  bus([[10, 44], [10, 150]], 6, PC_WHITE, 26, 26);
  bus([[-30, 150], [-30, 184]], 6, PC_WHITE, 26, 26);
}

// pads along the edge, the seal ring around the die, bond fingers and gold wires out to the package
function rim() {
  rseed(111);
  const S = 28;
  for (let side = 0; side < 4; side++) for (let k = 0; k < 22; k++) {
    const a = -168 + k * 16, ox = [1, -1, 0, 0][side], oz = [0, 0, 1, -1][side], tx = oz ? 1 : 0, tz = ox ? 1 : 0;
    const W = (r, y, s) => [ox * r + tx * s, y, oz * r + tz * s];
    // the pad and the metal stacked under it
    let [px, , pz] = W(190, 0, a);
    box(px, 35.7, pz, 6, 1.7, 6, AL);
    box(px, 20.4, pz, 5.2, .4, 5.2, CU); box(px, 11.4, pz, 5.2, .4, 5.2, CU);
    for (const [u, v] of [[-3.6, -3.6], [3.6, -3.6], [-3.6, 3.6], [3.6, 3.6]]) {
      bb(px + u - .6, 20.8, pz + v - .6, px + u + .6, 34, pz + v + .6, VIA);
      bb(px + u - .5, 11.8, pz + v - .5, px + u + .5, 20, pz + v + .5, VIA);
    }
    for (let e = -2; e <= 2; e++) { const [ex, , ez] = W(190 + e * 2, 0, a); box(ex, .45, ez, ...(ox ? [.7, .45, 4.5] : [4.5, .45, .7]), DCAP); }
    const [wx, , wz] = W(178, 0, a);   // a wire from the pad into the chip
    box(wx, 11.4, wz, ...(ox ? [6, .4, .6] : [.6, .4, 6]), CU | F_PULSE | PC_AMBER, prnd() < .5 ? -24 : 24, 9, prnd(), 1.5);
    // the bond finger on the shelf and its lead out to the wall
    const a2 = a * 1.3, hi = k & 1 ? 9 : 0;
    const [fx, , fz] = W(250, 0, a2), [lx, , lz] = W(273, 0, a2 * 1.06);
    box(fx, 18.18, fz, ...(ox ? [8, .18, 1.3] : [1.3, .18, 8]), AU | F_FLOOR);
    box(lx, 18.07, lz, ...(ox ? [15, .07, .45] : [.45, .07, 15]), AU | F_FLOOR);
    // the wire: a cubic curve that leaves the ball almost straight up and lands flat on the finger
    const P0 = W(190, 37.3, a), P1 = W(192.5, 66 + hi, a * 1.02), P2 = W(226, 60 + hi, a2 * .96), P3 = W(250.5, 18.2, a2);
    const P = [], R = [];
    for (let i = 0; i <= S; i++) {
      const t = i / S, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      for (let j = 0; j < 3; j++) P.push(P0[j] * b0 + P1[j] * b1 + P2[j] * b2 + P3[j] * b3);
      R.push(.45 + .8 * clamp(1 - t / .05, 0, 1) ** 2);   // the ball where the wire was welded to the pad
    }
    tube(P, R, 8, AU);
  }
  // seal ring: a fence of posts and rails around the whole die
  for (const s of [-1, 1]) {
    for (let a = -198; a <= 198; a += 9) {
      bb(s * 198.8 - .7, 0, a - .7, s * 198.8 + .7, 37.4, a + .7, VIA);
      bb(a - .7, 0, s * 198.8 - .7, a + .7, 37.4, s * 198.8 + .7, VIA);
    }
    for (const [y0, y1] of [[2.55, 3.1], [6.9, 7.5], [28, 30.4], [36.4, 37.4]]) {
      bb(s * 198.8 - .7, y0, -199.5, s * 198.8 + .7, y1, 199.5, CU);
      bb(-198.1, y0, s * 198.8 - .7, 198.1, y1, s * 198.8 + .7, CU);
    }
  }
}

// a probe needle from the test station above, resting on a spare pad in the corner of the die
function probe() {
  const tx = -190, tz = 190, d = norm3([-.2, .95, .22]), P = [], R = [];
  box(tx, 35.7, tz, 6, 1.7, 6, AL);
  for (const [u, v] of [[-3.6, -3.6], [3.6, -3.6], [-3.6, 3.6], [3.6, 3.6]]) bb(tx + u - .6, 11.8, tz + v - .6, tx + u + .6, 34, tz + v + .6, VIA);
  box(tx, 37.5, tz, 1.5, .12, 1.5, CELL | F_RING, 6, 0, .3, 0, PI / 4);   // the contact glows with every measurement
  // the tip stands almost upright on the pad; at the knee the shaft leans away and climbs out over the package wall
  const e = norm3([-.5, .6, .62]), kx = tx + d[0] * 9, ky = 37.5 + d[1] * 9, kz = tz + d[2] * 9;
  for (const [s, r] of [[0, .08], [.5, .22], [2, .5], [5, .8], [9, 1.05]]) { P.push(tx + d[0] * s, 37.5 + d[1] * s, tz + d[2] * s); R.push(r); }
  for (const [s, r] of [[2.5, 1.15], [8, 1.4], [30, 2], [80, 2.8], [150, 3.4]]) { P.push(kx + e[0] * s, ky + e[1] * s, kz + e[2] * s); R.push(r); }
  PEND = [kx + e[0] * 150, ky + e[1] * 150, kz + e[2] * 150];
  tube(P, R, 16, NEEDLE);
}

// words etched in the top metal: the browser draws them with its own font and every run of pixels becomes a box
function inscribe(txt, x0, z0, s, y, m, th = .9, k = 1) {
  if (typeof document === 'undefined') return;
  const W = 260 * k, H = 34 * k, c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
  s /= k;
  c.width = W; c.height = H;
  g.font = `700 ${26 * k}px "Segoe UI","Arial Hebrew","Noto Sans Hebrew",Arial,sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.direction = 'rtl'; g.wordSpacing = 9 * k + 'px';
  g.fillText(txt, W / 2, H / 2 + k);
  const d = g.getImageData(0, 0, W, H).data;
  const open = new Map();   // runs still growing downward: "start,end" -> the row they began on
  for (let v = 0; v <= H; v++) {
    const now = new Set();
    if (v < H) for (let u = 0, a = -1; u <= W; u++) {
      const on = u < W && d[(v * W + u) * 4 + 3] > 100;
      if (on && a < 0) a = u;
      if (!on && a >= 0) { now.add(a + ',' + u); a = -1; }
    }
    for (const [k, v0] of open) if (!now.has(k)) {
      const [a, u] = k.split(',').map(Number);
      bb(x0 + a * s, y, z0 + v0 * s, x0 + u * s, y + th, z0 + v * s, m | F_TEXT); open.delete(k);
    }
    for (const k of now) if (!open.has(k)) open.set(k, v);
  }
}
// chip art, the way designers sign their work in a spare corner of the metal: a small submarine
const ART = ['.......XX........', '.......X.........', '....XXXXXXX......', '..XXXXXXXXXXX..X.', '.XXX.XX.XX.XXXXX.', '.XXXXXXXXXXXXXXX.', '..XXXXXXXXXXX..X.', '....XXXXXXX......'];
function art(x0, z0, s, y, m) {
  ART.forEach((row, v) => {
    for (let u = 0, a = -1; u <= row.length; u++) {
      const on = row[u] === 'X';
      if (on && a < 0) a = u;
      if (!on && a >= 0) { bb(x0 + a * s, y, z0 + v * s, x0 + u * s, y + .9, z0 + (v + 1) * s, m); a = -1; }
    }
  });
}

// ---------------------------------------------------------------- outside: the circuit board the package is soldered to
// The same world in the same units. From out here the package is a small box among parts the size of hills:
// capacitors, resistors, a crystal, another chip, pin headers, and traces running out from under the package.
let NOUT0 = 0;   // boxes from here on lie outside the package; collisions and focus test them one by one
let PEND;        // where the probe needle ends and its holder takes over
function board() {
  rseed(151);
  NOUT0 = NI;
  const Y = -16, F = F_FLOOR;
  bb(-40000, -90, -40000, 40000, Y, 40000, PCB | F);
  const hole = (x, z) => { box(x, Y + .5, z, 17, .5, 17, AU | F, 0, 0, 0, 0, PI / 4); box(x, Y + .7, z, 6, .7, 6, EPOXY | F, 0, 0, 0, 0, PI / 4); };
  // white ink around a part's footprint
  const ink = (x0, z0, x1, z1) => {
    bb(x0, Y, z0, x1, Y + .5, z0 + 8, SILK | F); bb(x0, Y, z1 - 8, x1, Y + .5, z1, SILK | F);
    bb(x0, Y, z0, x0 + 8, Y + .5, z1, SILK | F); bb(x1 - 8, Y, z0, x1, Y + .5, z1, SILK | F);
  };
  // the package's feet: gold castellations down its sides, each soldered to a pad. From every pad a trace runs out,
  // jogs at 45 degrees away from the middle (so the bundle fans out without crossing), runs on and ends in a via.
  for (let side = 0; side < 4; side++) for (let k = -4; k <= 4; k++) {
    const a = k * 66, ox = [1, -1, 0, 0][side], oz = [0, 0, 1, -1][side], tx = oz ? 1 : 0, tz = ox ? 1 : 0;
    const B = (r0, r1, wd, y0, y1, m, c = a) => {
      const x0 = ox * r0 + tx * (c - wd / 2), x1 = ox * r1 + tx * (c + wd / 2), z0 = oz * r0 + tz * (c - wd / 2), z1 = oz * r1 + tz * (c + wd / 2);
      bb(min(x0, x1), y0, min(z0, z1), max(x0, x1), y1, max(z0, z1), m);
    };
    B(331, 337, 30, Y, 44, AU | F); B(332, 394, 38, Y, Y + 1.2, SOLDER | F); B(337, 352, 30, Y + 1.2, Y + 10, SOLDER | F);
    const sg = k > 0 ? 1 : k < 0 ? -1 : rnd() < .5 ? 1 : -1, jog = 50 + abs(k) * rr(45, 95);
    const r1 = 394 + rr(120, 230) + (4 - abs(k)) * 34, r2 = r1 + jog, c2 = a + sg * jog, l2 = rr(240, 900);
    B(394, r1 + 5, 13, Y, Y + .7, TRACE | F);
    const dx = (ox + tx * sg) * .70711, dz = (oz + tz * sg) * .70711;
    box(ox * (r1 + jog / 2) + tx * (a + sg * jog / 2), Y + .35, oz * (r1 + jog / 2) + tz * (a + sg * jog / 2), 6.5, .35, jog * .70711 + 5, TRACE | F, 0, 0, 0, 0, atan2(-dx, dz));
    B(r2 - 5, r2 + l2, 13, Y, Y + .7, TRACE | F, c2);
    hole(ox * (r2 + l2 + 14) + tx * c2, oz * (r2 + l2 + 14) + tz * c2);
  }
  // the probe's holder: a collar on the needle, an arm reaching out over the wall, a post and its foot on the board
  {
    const [ex, ey, ez] = PEND, px = -570, pz = ez + ex - px, e = norm3([-.5, .6, .62]), at = s => [ex + e[0] * s, ey + e[1] * s, ez + e[2] * s];
    tube([...at(-13), ...at(-12), ...at(7), ...at(8)], [3.4, 6.5, 6.5, .01], 16, EPOXY);        // the clamp around the needle
    tube([ex, ey, ez, px, ey, pz], [3.6, 3.6], 14, NEEDLE);                                        // a steel rod out over the wall
    box(px, ey, pz, 10, 10, 10, EPOXY | F, 0, 0, 0, 0, PI / 4);                                     // the joint
    tube([px, Y, pz, px, ey + 18, pz, px, ey + 18, pz], [7.5, 7.5, .01], 16, NEEDLE);               // the post
    tube([px, Y, pz, px, Y + 9, pz, px, Y + 13, pz, px, Y + 13, pz], [62, 62, 56, .01], 28, EPOXY);  // its round foot
  }
  // a part with two soldered ends, lying along x (ax = 1) or z: ceramic capacitors and chip resistors
  const two = (x, z, l, wd, h, ax, body, mark) => {
    const e = l * .2, S = (c, hl, hw, y0, y1, m) => ax ? bb(x + c - hl, y0, z - hw, x + c + hl, y1, z + hw, m) : bb(x - hw, y0, z + c - hl, x + hw, y1, z + c + hl, m);
    S(0, l / 2 - e, wd / 2, Y, Y + h, body | F);
    for (const s of [-1, 1]) { S(s * (l / 2 - e / 2), e / 2, wd / 2 + 3, Y, Y + h + 2, SOLDER | F); S(s * (l / 2 + e * .1), e * .75, wd / 2 + 16, Y, Y + 1.6, SOLDER | F); }
    if (mark) inscribe(mark, x - 130 * 2.6, z - 17 * 2.6, 2.6, Y + h, SILK | F, .5);
    const m = 75; ax ? ink(x - l / 2 - m, z - wd / 2 - m, x + l / 2 + m, z + wd / 2 + m) : ink(x - wd / 2 - m, z - l / 2 - m, x + wd / 2 + m, z + l / 2 + m);
  };
  // a black chip: legs down two sides, a lid with a chamfer, its name lasered on top, a dot at pin 1
  const ic = (x, z, wd, d, h, n, name) => {
    bb(x - wd / 2, Y + 34, z - d / 2, x + wd / 2, Y + 34 + h * .8, z + d / 2, EPOXY | F);
    bb(x - wd / 2 + 26, Y + 34 + h * .8, z - d / 2 + 26, x + wd / 2 - 26, Y + 34 + h, z + d / 2 - 26, EPOXY | F);
    for (let k = 0; k < n; k++) for (const s of [-1, 1]) {
      const lx = x - wd / 2 + (k + .5) * wd / n, z0 = z + s * d / 2, z1 = z0 + s * 95;
      bb(lx - wd / n * .22, Y + 40, min(z0, z0 + s * 50), lx + wd / n * .22, Y + 62, max(z0, z0 + s * 50), SOLDER | F);
      bb(lx - wd / n * .22, Y, min(z0 + s * 40, z1), lx + wd / n * .22, Y + 62, max(z0 + s * 40, z1), SOLDER | F);
      bb(lx - wd / n * .3, Y, min(z0 + s * 30, z1 + s * 40), lx + wd / n * .3, Y + 1.5, max(z0 + s * 30, z1 + s * 40), SOLDER | F);
    }
    inscribe(name, x - 130 * 5.2, z - 17 * 5.2, 5.2, Y + 34 + h, SILK | F, .4);
    box(x - wd / 2 + 110, Y + 34 + h, z + d / 2 - 110, 30, .4, 30, SILK | F, 0, 0, 0, 0, PI / 4);
    ink(x - wd / 2 - 60, z - d / 2 - 190, x + wd / 2 + 60, z + d / 2 + 190);
  };
  // an electrolytic capacitor: a can in a dark sleeve, crimped near the foot, with a bare aluminium top
  const can = (x, z, r, h) => {
    tube([x, Y, z, x, Y + h * .96, z], [r, r], 26, SLEEVE);
    tube([x, Y + h * .96, z, x, Y + h, z, x, Y + h, z], [r, r * .9, .01], 26, SOLDER);
    tube([x, Y + h * .09, z, x, Y + h * .115, z], [r * 1.012, r * 1.012], 26, EPOXY);
    bb(x - r * 1.05, Y, z - r * 1.05, x + r * 1.05, Y + 16, z + r * 1.05, EPOXY | F);
  };
  const label = (t, x, z, s = 9) => inscribe(t, x - 130 * s, z - 17 * s, s, Y, SILK | F, .8);
  // north: decoupling capacitors in a row, two cans behind them
  [-900, 0, 900].forEach((x, k) => { two(x, -1250, 620, 330, 300, 1, CAPB); label('C' + (k + 1), x, -1640); });
  can(-1750, -2350, 430, 1500); can(-650, -2650, 300, 1050); label('C7', -1750, -1790); label('C8', -650, -2250);
  // west: a row of resistors with their values printed on them, and a pin header
  [-630, -210, 210, 630].forEach((z, k) => { two(-1450, z, 520, 260, 130, 1, EPOXY, ['103', '472', '103', '220'][k]); label('R' + (k + 1), -2030, z, 6); });
  bb(-3050, Y, -900, -2790, Y + 260, 900, EPOXY | F); ink(-3110, -960, -2730, 960);
  for (let k = 0; k < 6; k++) bb(-2955, Y + 260, -750 + k * 300 - 34, -2887, Y + 1150, -750 + k * 300 + 34, AU | F);
  label('J1', -2920, 1150);
  // east: a neighbouring chip and the crystal that sets the board's time
  ic(2150, -500, 1500, 950, 250, 9, 'SV 2026'); label('U2', 2150, 420);
  bb(1250, Y + 20, 950, 2250, Y + 360, 1310, SOLDER | F); bb(1230, Y, 930, 2270, Y + 20, 1330, EPOXY | F);
  inscribe('16.000', 1750 - 130 * 6.5, 1130 - 17 * 6.5, 6.5, Y + 360, EPOXY | F, .4); label('Y1', 1750, 1560);
  two(1150, -1500, 620, 330, 300, 0, CAPB); label('C4', 1150, -2060);
  // south: the board's name in white ink, a capacitor, a few stray vias
  inscribe('מסע בתוך שבב', -130 * 14, 2000, 14, Y, SILK | F, .8, 4);
  two(2900, 2300, 620, 330, 300, 1, CAPB); label('C5', 2900, 2690);
  for (let k = 0; k < 18; k++) { const x = rr(-3400, 3400), z = rr(-3600, 3600); if (max(abs(x), abs(z)) > 1900) hole(x, z); }
}

// contact shadows on the board: the footprint of everything standing on it, blurred. 512 x 512 over 8192 units.
function boardAO() {
  const N = 512, S = 8192 / N, A = new Float32Array(N * N), T = new Float32Array(N * N);
  const stamp = (x0, z0, x1, z1) => {
    const i0 = max(0, floor(x0 / S + N / 2)), i1 = min(N - 1, floor(x1 / S + N / 2)), j0 = max(0, floor(z0 / S + N / 2)), j1 = min(N - 1, floor(z1 / S + N / 2));
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) A[jj * N + ii] = 1;
  };
  for (let i = 0; i < NI; i++) {
    const o = i * IST, hy = IF[o + 5];
    let hx = IF[o + 4], hz = IF[o + 6];
    if (hy < 5 || hx > 5000 || IF[o + 1] - hy > 40) continue;                     // flat things and things in the air cast nothing
    if (i < NOUT0 && ((IU[o + 3] & 255) !== CER || IF[o + 1] - hy > -15)) continue;   // of the package, only its outer wall
    const yaw = IF[o + 7];
    if (yaw) { const c = abs(cos(yaw)), s = abs(sin(yaw)); [hx, hz] = [hx * c + hz * s, hx * s + hz * c]; }
    stamp(IF[o] - hx, IF[o + 2] - hz, IF[o] + hx, IF[o + 2] + hz);
  }
  for (const b of BOND) if (b.p[1] < -15) stamp(b.p[0] - b.r[0] * .8, b.p[2] - b.r[0] * .8, b.p[0] + b.r[0] * .8, b.p[2] + b.r[0] * .8);
  for (let pass = 0; pass < 6; pass++) {   // box blurs, sideways then lengthwise
    const src = pass & 1 ? T : A, dst = pass & 1 ? A : T, st = pass & 1 ? N : 1;
    for (let k = 0; k < N * N; k++) { const c = pass & 1 ? k / N | 0 : k % N; dst[k] = (src[k] + (c > 0 ? src[k - st] : src[k]) + (c < N - 1 ? src[k + st] : src[k]) + (c > 1 ? src[k - 2 * st] : src[k]) + (c < N - 2 ? src[k + 2 * st] : src[k])) / 5; }
  }
  return Uint8Array.from(A, v => v * 255);
}

function pkg() {
  rseed(121);
  bb(-332, -16, -332, 332, -10, 332, CER | F_FLOOR);   // cavity floor
  bb(-236, -10, -236, 236, -8, 236, PADL | F_FLOOR);   // gold die paddle
  bb(-200, -8, -200, 200, 0, 200, SI | F_FLOOR);       // the die
  sqring(200, 201.4, -8, -6.6, EPX | F_FLOOR);          // silver epoxy fillet
  sqring(240, 290, -10, 18, CER | F_FLOOR);             // bond shelf
  sqring(290, 332, -16, 112, CER | F_FLOOR);            // package wall
  sqring(298, 324, 112, 112.5, AU | F_FLOOR);           // seal ring on the wall
  for (const y of [34, 58, 84]) sqring(289.4, 290.2, y, y + .6, AU | F_FLOOR);   // gold traces in the ceramic layers
  sqring(286.5, 290.2, 100, 104, CER | F_FLOOR);                                    // a ledge under the rim
  for (let a = -276; a <= 276; a += 23) for (const s of [-1, 1]) {                   // ribs up the wall
    bb(s * 288.6 - 1.4, 18, a - 2.2, s * 288.6 + 1.4, 100, a + 2.2, CER | F_FLOOR);
    bb(a - 2.2, 18, s * 288.6 - 1.4, a + 2.2, 100, s * 288.6 + 1.4, CER | F_FLOOR);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 3; k++) {   // capacitors in the shelf corners
    const cx = sx * (252 + k * 13), cz = sz * 268, along = k & 1;
    const hx = along ? 2.6 : 4.6, hz = along ? 4.6 : 2.6;
    box(cx, 20.6, cz, hx, 2.6, hz, CAPB | F_FLOOR);
    for (const e of [-1, 1]) box(cx + (along ? 0 : e * (hx + .6)), 20.6, cz + (along ? e * (hz + .6) : 0), along ? 2.7 : .7, 2.7, along ? .7 : 2.7, AL | F_FLOOR);
  }
}

function genWorld() {
  pkg();
  [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sz], i) => core(sx, sz, i));
  cache(); ai(); memctl(); analog(); uncore(); streets();
  rseed(131);
  htree(0, 0, 96, 3, 0);
  // the spine: the clock climbs out of the oscillator and runs to the root at the centre
  bb(-.6, 1.4, -84.6, .6, CKY[1], -83.4, CLK | F_CLOCK, -91.6, 1, .03, 0);
  box(0, CKY[1] + CKT / 2, -42, CKW / 2, CKT / 2, 42, CLK | F_CLOCK, -42, 1, .03, 0);
  bb(-.5, CKY[0] + CKT, -.5, .5, CKY[1], .5, VIA);
  power(); buses(); rim(); probe(); board();
  rseed(141);
  inscribe('מסע בתוך שבב', -28, -79, .3, 33.4, GOLDL, .9, 3);
  art(-38, -77.6, .8, 33.4, GOLDL);
  TUBE_V = new Float32Array(TV); TUBE_I = new Uint32Array(TX);
}

// ---------------------------------------------------------------- floor map: oxide colour, pattern, heat
function floorMap() {
  const N = 512, D = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -200 + (i + .5) * 400 / N, z = -200 + (j + .5) * 400 / N;
    let kind = 3, film = .3;
    if (max(abs(x), abs(z)) > 181) { kind = 0; film = .62; }
    else for (const b of BLK) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) { kind = b[6]; film = b[7]; break; }
    let heat = 0;
    for (const [hx, hz] of HOTS) heat = max(heat, 1 - hypot(x - hx, z - hz) / 32);
    const o = (j * N + i) * 4;
    D[o] = clamp(film + (fbm2(x * .02, z * .02, 3) - .5) * .5, 0, 1) * 255;
    D[o + 1] = kind; D[o + 2] = heat * 255; D[o + 3] = 255;
  }
  return D;
}

// ---------------------------------------------------------------- occlusion bake
// A coarse 3D grid over the die. r: how open the space around a point is (soft ambient occlusion);
// g: how much of the sky above reaches it (light absorbed layer by layer on its way down).
const AON = [256, 64, 256], AO0 = [-210, -8, -210], AOS = [420 / 256, .75, 420 / 256];
function bakeAO() {
  const [NX, NY, NZ] = AON, n = NX * NY * NZ, occ = new Float32Array(n);
  const ov = [new Float32Array(NX), new Float32Array(NY), new Float32Array(NZ)];
  const span = (c, h, ax) => {   // fraction of each cell along one axis covered by [c - h, c + h]
    const s = AOS[ax], lo = c - h - AO0[ax], hi = c + h - AO0[ax], o = ov[ax];
    const i0 = max(0, floor(lo / s)), i1 = min(AON[ax] - 1, floor(hi / s));
    for (let k = i0; k <= i1; k++) o[k] = (min(hi, (k + 1) * s) - max(lo, k * s)) / s;
    return [i0, i1];
  };
  for (let i = 0; i < NI; i++) {
    const o = i * IST;
    if (IU[o + 3] & F_FLOOR) continue;
    let hx = IF[o + 4], hz = IF[o + 6], fill = 1;
    const yaw = IF[o + 7];
    if (yaw) { const c = abs(cos(yaw)), s = abs(sin(yaw)), ax = hx * c + hz * s, az = hx * s + hz * c; fill = hx * hz / (ax * az); hx = ax; hz = az; }
    const [x0, x1] = span(IF[o], hx, 0), [y0, y1] = span(IF[o + 1], IF[o + 5], 1), [z0, z1] = span(IF[o + 2], hz, 2);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const f = ov[2][z] * ov[1][y] * fill, r = NX * (y + NY * z);
      for (let x = x0; x <= x1; x++) occ[r + x] += f * ov[0][x];
    }
  }
  for (let i = 0; i < n; i++) occ[i] = min(occ[i], 1);
  const sky = new Float32Array(n);
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    let s = 1;
    for (let y = NY - 1; y >= 0; y--) { const i = x + NX * (y + NY * z); sky[i] = s; s *= 1 - min(.9, occ[i] * 1.1); }
  }
  const blur = (a, ax, rad) => {
    const N = AON[ax], st = [1, NX, NX * NY][ax], A = ax ? NX : NY, B = ax === 2 ? NY : NZ, ps = new Float32Array(N + 1);
    for (let j = 0; j < B; j++) for (let i = 0; i < A; i++) {
      const s0 = ax === 0 ? NX * (i + NY * j) : ax === 1 ? i + NX * NY * j : i + NX * j;
      for (let k = 0; k < N; k++) ps[k + 1] = ps[k] + a[s0 + k * st];
      for (let k = 0; k < N; k++) { const lo = max(0, k - rad), hi = min(N, k + rad + 1); a[s0 + k * st] = (ps[hi] - ps[lo]) / (hi - lo); }
    }
  };
  for (let p = 0; p < 2; p++) { blur(occ, 0, 2); blur(occ, 2, 2); blur(occ, 1, 1); blur(sky, 0, 2); blur(sky, 2, 2); }
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { out[i * 2] = clamp(1 - occ[i] * 2.4, 0, 1) * 255; out[i * 2 + 1] = sky[i] * 255; }
  return out;
}

// ---------------------------------------------------------------- collision grid: which boxes touch each 4 x 4 column
const GS = 4, GN = 168, G0 = -336;
function buildGrid() {
  const st = new Uint32Array(GN * GN + 1), rect = new Int16Array(NI * 4);
  for (let i = 0; i < NI; i++) {
    const o = i * IST, yaw = IF[o + 7];
    let hx = IF[o + 4], hz = IF[o + 6];
    if (yaw) { const c = abs(cos(yaw)), s = abs(sin(yaw)); [hx, hz] = [hx * c + hz * s, hx * s + hz * c]; }
    const r = i * 4, E = -G0;
    if (IF[o] - hx > E || IF[o] + hx < -E || IF[o + 2] - hz > E || IF[o + 2] + hz < -E) { rect[r] = 1; rect[r + 2] = 0; continue; }
    rect[r] = clamp(floor((IF[o] - hx - G0) / GS), 0, GN - 1); rect[r + 1] = clamp(floor((IF[o + 2] - hz - G0) / GS), 0, GN - 1);
    rect[r + 2] = clamp(floor((IF[o] + hx - G0) / GS), 0, GN - 1); rect[r + 3] = clamp(floor((IF[o + 2] + hz - G0) / GS), 0, GN - 1);
    for (let z = rect[r + 1]; z <= rect[r + 3]; z++) for (let x = rect[r]; x <= rect[r + 2]; x++) st[z * GN + x + 1]++;
  }
  for (let i = 0; i < GN * GN; i++) st[i + 1] += st[i];
  const it = new Uint32Array(st[GN * GN]), cur = st.slice(0, GN * GN);
  for (let i = 0; i < NI; i++) {
    const r = i * 4;
    for (let z = rect[r + 1]; z <= rect[r + 3]; z++) for (let x = rect[r]; x <= rect[r + 2]; x++) it[cur[z * GN + x]++] = i;
  }
  return { st, it };
}
