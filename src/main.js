// ============================================================================
// main: GPU setup, the frame loop, camera and controls, the menu
// ============================================================================
const $ = id => document.getElementById(id);
const cvs = $('c');
const SHOT = QS.has('shot'), BENCH = QS.has('bench');
const say = async (txt, f) => { $('ldt').textContent = txt; $('ldb').style.transform = `scaleX(${f})`; await new Promise(r => setTimeout(r, 16)); };
const CLKT = 1.6, CLKV = 300;   // clock period (s) and how fast its flash runs through the tree (units/s)
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };

// ---------------------------------------------------------------- device
if (!navigator.gpu) throw Error('nogpu');
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw Error('nogpu');
const TS = adapter.features.has('timestamp-query');
const dev = await adapter.requestDevice({ requiredFeatures: TS ? ['timestamp-query'] : [] });
dev.addEventListener('uncapturederror', e => console.error('[gpu] ' + e.error.message));
dev.lost.then(i => { if (i.reason !== 'destroyed') { console.error('[gpu lost] ' + i.message); $('lost').hidden = false; } });
const ctx = cvs.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device: dev, format: FMT, alphaMode: 'opaque' });
const BU = GPUBufferUsage, TU = GPUTextureUsage, SV = GPUShaderStage;

// ---------------------------------------------------------------- the world
await say(tr('משרטטים את תוכנית השבב…', 'Drawing up the floor plan…'), .08);
genWorld();
await say(tr('מחשבים אור וצל רכים…', 'Working out soft light and shadow…'), .25);
const AOD = bakeAO(), FLM = floorMap();
await say(tr('מכינים את השבב למגע…', 'Getting the chip ready to touch…'), .5);
const GRID = buildGrid();
await say(tr('מעלים לכרטיס הגרפי…', 'Uploading to the graphics card…'), .6);

const mkbuf = (data, usage) => { const b = dev.createBuffer({ size: ceil(data.byteLength / 4) * 4, usage: usage | BU.COPY_DST }); dev.queue.writeBuffer(b, 0, data); return b; };
const mktex = (size, format, usage, o) => dev.createTexture({ size, format, usage, ...o });
const instB = mkbuf(new Float32Array(IB, 0, NI * IST), BU.STORAGE);
const visB = dev.createBuffer({ size: NI * 4, usage: BU.STORAGE });
const argB = mkbuf(new Uint32Array([36, 0, 0, 0, 0]), BU.INDIRECT | BU.STORAGE);
const BI = new Uint16Array(36);   // two triangles per face, wound outward (the negative faces flip)
for (let f = 0; f < 6; f++) { const o = f * 4; BI.set(f & 1 ? [o, o + 2, o + 1, o, o + 3, o + 2] : [o, o + 1, o + 2, o, o + 2, o + 3], f * 6); }
const idxB = mkbuf(BI, BU.INDEX), tvB = mkbuf(TUBE_V, BU.VERTEX), tiB = mkbuf(TUBE_I, BU.INDEX);
const UF = new Float32Array(140), ubuf = dev.createBuffer({ size: 560, usage: BU.UNIFORM | BU.COPY_DST });
const PPF = new Float32Array(12), ppbuf = dev.createBuffer({ size: 48, usage: BU.UNIFORM | BU.COPY_DST });
const LSF = new Float32Array(4), lsbuf = dev.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
const ZERO = new Uint32Array(1);

const shTex = mktex([SHADOW, SHADOW], 'depth32float', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const shTex2 = mktex([2048, 2048], 'depth32float', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);   // the whole board, coarsely
const aoTex = mktex(AON, 'rg8unorm', TU.TEXTURE_BINDING | TU.COPY_DST, { dimension: '3d' });
dev.queue.writeTexture({ texture: aoTex }, AOD, { bytesPerRow: AON[0] * 2, rowsPerImage: AON[1] }, AON);
const flTex = mktex([512, 512], 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);
dev.queue.writeTexture({ texture: flTex }, FLM, { bytesPerRow: 2048 }, [512, 512]);
const lifeA = mktex([512, 512], 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);
const lifeB = mktex([512, 512], 'rgba8unorm', TU.STORAGE_BINDING | TU.COPY_SRC);
{
  const L = new Uint8Array(512 * 512 * 4);
  rseed(5);
  for (let i = 0; i < L.length; i += 4) { const a = rnd() < .33 ? 255 : 0; L[i] = L[i + 1] = a; L[i + 3] = 255; }
  dev.queue.writeTexture({ texture: lifeA }, L, { bytesPerRow: 2048 }, [512, 512]);
}
const baoTex = mktex([512, 512], 'r8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);
dev.queue.writeTexture({ texture: baoTex }, boardAO(), { bytesPerRow: 512 }, [512, 512]);
const lin = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const cmp = dev.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });

// ---------------------------------------------------------------- shaders and pipelines
await say(tr('מרכיבים את המעגלים…', 'Assembling the circuits…'), .7);
async function mod(code, name) {
  const m = dev.createShaderModule({ code, label: name });
  for (const e of (await m.getCompilationInfo()).messages) if (e.type === 'error') {
    const line = code.split('\n')[e.lineNum - 1] || '';
    console.error(`[wgsl ${name}] ${e.lineNum}:${e.linePos} ${e.message} :: ${line.slice(max(0, e.linePos - 70), e.linePos + 50)}`);
  }
  return m;
}
const mD = await mod(W_DOF, 'dof');
const [mS, mSh, mC, mL, mR, mB, mP] = await Promise.all([
  mod(W_HEAD + W_SCENE, 'scene'), mod(W_HEAD + W_SHADOW, 'shadow'), mod(W_HEAD + W_CULL, 'cull'), mod(W_HEAD + W_LIFE, 'life'),
  RAYS ? mod(W_HEAD + W_RAYS, 'rays') : null, mod(W_BLOOM, 'bloom'), mod(W_HEAD + W_POST, 'post')]);

const BGL = (...e) => dev.createBindGroupLayout({ entries: e.map(([visibility, x], binding) => ({ binding, visibility, ...x })) });
const VF = SV.VERTEX | SV.FRAGMENT, FR = SV.FRAGMENT, CO = SV.COMPUTE;
const RO = { buffer: { type: 'read-only-storage' } }, UB = { buffer: {} };
const lScene = BGL([VF, UB], [SV.VERTEX, RO], [SV.VERTEX, RO], [FR, { texture: { sampleType: 'depth' } }], [FR, { sampler: { type: 'comparison' } }],
  [FR, { texture: { viewDimension: '3d' } }], [FR, { sampler: {} }], [FR, { texture: {} }], [FR, { texture: {} }], [FR, { texture: { sampleType: 'depth' } }], [FR, { texture: {} }]);
const lShadow = BGL([SV.VERTEX, UB], [SV.VERTEX, RO]);
const lCull = BGL([CO, UB], [CO, RO], [CO, { buffer: { type: 'storage' } }], [CO, { buffer: { type: 'storage' } }]);
const lLife = BGL([CO, { texture: {} }], [CO, { storageTexture: { access: 'write-only', format: 'rgba8unorm' } }], [CO, UB]);
const lBlit = BGL([FR, { texture: {} }], [FR, { sampler: {} }]);
const PL = l => dev.createPipelineLayout({ bindGroupLayouts: [l] });
const BG = (layout, res) => dev.createBindGroup({ layout, entries: res.map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r })) });

const HDR = 'rgba16float', MS = { count: AA };
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const DEPTH = (depthCompare, depthWriteEnabled = true, o) => ({ format: 'depth32float', depthCompare, depthWriteEnabled, ...o });
const RP = (layout, m, vs, fs, o = {}) => dev.createRenderPipelineAsync({
  layout, vertex: { module: m, entryPoint: vs, buffers: o.buffers || [] },
  fragment: fs ? { module: m, entryPoint: fs, targets: [{ format: o.format || HDR, blend: o.blend }] } : undefined,
  primitive: { cullMode: o.cull || 'none' }, depthStencil: o.depth, multisample: o.ms,
});
const F3 = 'float32x3', SHB = { depthBias: 3, depthBiasSlopeScale: 2.5 };
const TUBEVL = [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: F3 }, { shaderLocation: 1, offset: 12, format: F3 }, { shaderLocation: 2, offset: 24, format: 'float32' }] }];
const [pBox, pTube, pSky, pMote, pShB, pShT, pD0, pD, pU, pPost, pRays, pCull, pLife] = await Promise.all([
  RP(PL(lScene), mS, 'vbox', 'fsolid', { cull: 'back', depth: DEPTH('greater'), ms: MS }),
  RP(PL(lScene), mS, 'vtube', 'fsolid', { cull: 'back', depth: DEPTH('greater'), ms: MS, buffers: TUBEVL }),
  RP(PL(lScene), mS, 'vfull', 'fsky', { depth: DEPTH('equal', false), ms: MS }),
  RP(PL(lScene), mS, 'vmote', 'fmote', { blend: ADD, depth: DEPTH('greater', false), ms: MS }),
  RP(PL(lShadow), mSh, 'vshb', null, { depth: DEPTH('less', true, SHB) }),
  RP(PL(lShadow), mSh, 'vsht', null, { depth: DEPTH('less', true, SHB), buffers: [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: F3 }] }] }),
  RP(PL(lBlit), mB, 'vfull', 'fdown0'), RP(PL(lBlit), mB, 'vfull', 'fdown'), RP(PL(lBlit), mB, 'vfull', 'fup', { blend: ADD }),
  RP('auto', mP, 'vfull', 'fpost', { format: FMT }),
  RAYS ? RP('auto', mR, 'vfull', 'frays') : null,
  dev.createComputePipelineAsync({ layout: PL(lCull), compute: { module: mC, entryPoint: 'cull' } }),
  dev.createComputePipelineAsync({ layout: PL(lLife), compute: { module: mL, entryPoint: 'life' } }),
]);

const pDof = await RP('auto', mD, 'vfull', 'fdof');
const TV0 = [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: F3 }] }];
const [pShB2, pShT2] = await Promise.all([RP(PL(lShadow), mSh, 'vshb2', null, { depth: DEPTH('less', true, SHB) }), RP(PL(lShadow), mSh, 'vsht2', null, { depth: DEPTH('less', true, SHB), buffers: TV0 })]);
// inside the transistor: atoms, bonds and electrons have their own small pipelines; disc edges use multisample coverage
const lNano = BGL([VF, UB], [SV.VERTEX, RO]), mN = await mod(W_HEAD + W_NANO, 'nano');
const A2C = { count: AA, alphaToCoverageEnabled: AA > 1 };
const [pAtom, pBond, pElec, pNSky] = await Promise.all([
  RP(PL(lNano), mN, 'vatom', 'fatom', { depth: DEPTH('greater'), ms: A2C }),
  RP(PL(lNano), mN, 'vbond', 'fbond', { depth: DEPTH('greater'), ms: A2C }),
  RP(PL(lNano), mN, 'velec', 'felec', { blend: ADD, depth: DEPTH('greater', false), ms: MS }),
  RP(PL(lNano), mN, 'vfull', 'fnsky', { depth: DEPTH('equal', false), ms: MS }),
]);
const bgNano = BG(lNano, [ubuf, mkbuf(nanoOrder(), BU.STORAGE)]);
const bgScene = BG(lScene, [ubuf, instB, visB, shTex.createView(), cmp, aoTex.createView(), lin, flTex.createView(), lifeA.createView(), shTex2.createView(), baoTex.createView()]);
const bgShadow = BG(lShadow, [ubuf, instB]);
const bgCull = BG(lCull, [ubuf, instB, visB, argB]);
const bgLife = BG(lLife, [lifeA.createView(), lifeB.createView(), lsbuf]);

// ---------------------------------------------------------------- constant uniforms: shadow matrix, glows
// two shadow matrices, both looking down the lamp's direction: a fine one over the package, a coarse one over the board
const shadowMat = (o, D, C, hw) => {
  const L = norm3(LDIR), f = [-L[0], -L[1], -L[2]], r = norm3([-f[2], 0, f[0]]), up = cross3(r, f), eye = C.map((c, i) => c + L[i] * D);
  for (let i = 0; i < 3; i++) { UF[o + i * 4] = r[i] / hw; UF[o + i * 4 + 1] = up[i] / hw; UF[o + i * 4 + 2] = f[i] / (2 * D); }
  UF[o + 12] = -dot3(r, C) / hw; UF[o + 13] = -dot3(up, C) / hw; UF[o + 14] = -dot3(f, eye) / (2 * D); UF[o + 15] = 1;
};
shadowMat(16, 700, [0, 30, 0], 370); shadowMat(124, 13000, [0, 0, 0], 8200);
GLOW.forEach((g, i) => { UF.set(g.slice(0, 4), 76 + i * 4); UF.set(g.slice(4), 100 + i * 4); });
dev.queue.writeBuffer(ubuf, 0, UF);

// bake the shadow map once and give the Game of Life a head start
{
  const enc = dev.createCommandEncoder();
  const sp = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
  sp.setBindGroup(0, bgShadow);
  sp.setPipeline(pShB); sp.setIndexBuffer(idxB, 'uint16'); sp.drawIndexed(36, NI);
  sp.setPipeline(pShT); sp.setVertexBuffer(0, tvB); sp.setIndexBuffer(tiB, 'uint32'); sp.drawIndexed(TUBE_I.length);
  sp.end();
  const s2 = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shTex2.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
  s2.setBindGroup(0, bgShadow);
  s2.setPipeline(pShB2); s2.setIndexBuffer(idxB, 'uint16'); s2.drawIndexed(36, NI);
  s2.setPipeline(pShT2); s2.setVertexBuffer(0, tvB); s2.setIndexBuffer(tiB, 'uint32'); s2.drawIndexed(TUBE_I.length);
  s2.end();
  for (let i = 0; i < 24; i++) {
    LSF[0] = i; dev.queue.writeBuffer(lsbuf, 0, LSF);
    const c = enc.beginComputePass(); c.setPipeline(pLife); c.setBindGroup(0, bgLife); c.dispatchWorkgroups(64, 64); c.end();
    enc.copyTextureToTexture({ texture: lifeB }, { texture: lifeA }, [512, 512]);
  }
  dev.queue.submit([enc.finish()]);
}

// ---------------------------------------------------------------- render targets (rebuilt when the size or render scale changes)
let CW = 0, CH = 0, RW = 0, RH = 0, SCALE = SMAX;
const FIXS = QS.has('scale') ? clamp(+QS.get('scale'), .25, 2) : SHOT ? 1 : 0;
let tCol, tHdr, tDep, tRay, tDof, tBl = [], blV = [], bgBl = [], bgRays, bgPost, bgDof, rayV, dofV;
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const scenePass = {
  colorAttachments: [{ view: null, resolveTarget: undefined, clearValue: BLACK, loadOp: 'clear', storeOp: AA > 1 ? 'discard' : 'store' }],
  depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
};
const blitPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: BLACK }] };
const postPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: BLACK }], timestampWrites: undefined };
function targets() {
  const s = FIXS || SCALE, w = max(32, round(CW * s)), h = max(32, round(CH * s));
  if (w === RW && h === RH) return;
  RW = w; RH = h;
  for (const t of [tCol, tHdr, tDep, tRay, tDof, ...tBl]) t?.destroy();
  const RA = TU.RENDER_ATTACHMENT, TB = TU.TEXTURE_BINDING;
  tHdr = mktex([w, h], HDR, RA | TB);
  tCol = AA > 1 ? mktex([w, h], HDR, RA, { sampleCount: AA }) : null;
  tDep = mktex([w, h], 'depth32float', RA | TB, { sampleCount: AA });
  tRay = mktex(RAYS ? [ceil(w / RAYDIV), ceil(h / RAYDIV)] : [1, 1], HDR, RA | TB);
  tBl = []; for (let l = 0; l < 6; l++) tBl.push(mktex([max(1, w >> l + 1), max(1, h >> l + 1)], HDR, RA | TB));
  blV = tBl.map(t => t.createView());
  rayV = tRay.createView();
  tDof = mktex([ceil(w / 2), ceil(h / 2)], HDR, RA | TB); dofV = tDof.createView();
  const hv = tHdr.createView(), dv = tDep.createView();
  bgBl = [BG(lBlit, [hv, lin]), ...blV.map(v => BG(lBlit, [v, lin]))];   // bgBl[0] reads the scene, bgBl[l + 1] reads bloom level l
  if (RAYS) bgRays = BG(pRays.getBindGroupLayout(0), [ubuf, dv, shTex.createView(), cmp]);
  bgDof = BG(pDof.getBindGroupLayout(0), [hv, lin, ppbuf, dv]);
  bgPost = BG(pPost.getBindGroupLayout(0), [hv, blV[0], rayV, lin, ppbuf, dofV, dv]);
  scenePass.colorAttachments[0].view = AA > 1 ? tCol.createView() : hv;
  scenePass.colorAttachments[0].resolveTarget = AA > 1 ? hv : undefined;
  scenePass.depthStencilAttachment.view = dv;
}
function fit() {
  const dpr = min(devicePixelRatio || 1, 2);
  CW = max(1, round(innerWidth * dpr)); CH = max(1, round(innerHeight * dpr));
  cvs.width = CW; cvs.height = CH;
  targets();
}
addEventListener('resize', fit);
fit();

// GPU time: a timestamp at the start of the frame's first pass and at the end of its last
let qs, qRes, qRead, tsBusy = false, gpuAcc = 0, gpuN = 0;
if (TS) {
  qs = dev.createQuerySet({ type: 'timestamp', count: 2 });
  qRes = dev.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
  qRead = dev.createBuffer({ size: 16, usage: BU.COPY_DST | BU.MAP_READ });
}

// ---------------------------------------------------------------- camera, stations, tour
const cam = [0, 0, 0], vel = [0, 0, 0];
let yaw = 0, pitch = 0, yawT = 0, pitchT = 0, snap = true;
// stations: x, y, z, yaw, pitch, name
const POSES = [
  [55, 3.2, 122, 0, .05, tr('רחוב הנתונים', 'Data street')],
  [22, 11.5, 20, -.785, -.6, tr('המטמון המשותף', 'The shared cache')],
  [66, 8, 44, .785, -.34, tr('מאיץ הבינה', 'The AI accelerator')],
  [1, 72, -50, 0, -.78, tr('הסלילים והכתובת', 'Coils & writing')],
  [158, 60, -104, 2.11, -.26, tr('חוטי הזהב', 'Gold wires')],
  [-170, 125, 230, .636, -.42, tr('מבט על', 'From above')],
  [118, 23.5, 108, -1.2, -.06, tr('בין הקומות', 'Between the layers')],
  [-160, 70, 150, -2.4, -.5, tr('מחט הבדיקה', 'The probe needle')],
];
// one more step down, inside a transistor (the 7th field marks the world)
const NCH = nanoChannel(-16, -8), NCT = nanoChannel(-4.2, -2.2);
POSES.push([2, NCH[0], NCH[1], PI / 2, 0, tr('בלב הגביש', 'Heart of the crystal'), 1], [2, NCT[0], NCT[1], PI / 2 - .25, .16, tr('מתחת לשער', 'Under the gate'), 1]);
POSES.push([0, 1250, 3400, 0, -.45, tr('הלוח מבחוץ', 'The board outside')]);
let WORLD = 0;   // 0: the chip, 1: inside a transistor
const SAVE = [null, [2, NCT[0], NCT[1], PI / 2, .1]];   // where the camera was left in each world
function pose(i) {
  const p = POSES[(i + POSES.length) % POSES.length];
  cam[0] = p[0]; cam[1] = p[1]; cam[2] = p[2]; yaw = yawT = p[3]; pitch = pitchT = p[4];
  vel.fill(0); tour = false; snap = true;
}
// change world (keeping the place in the one left behind) and/or land on a station, through a short fade
function dive(w, st, keep) {
  const sw = () => {
    if (w !== WORLD) {
      SAVE[WORLD] = [cam[0], cam[1], cam[2], yawT, pitchT]; WORLD = w;
      const s = SAVE[w]; cam[0] = s[0]; cam[1] = s[1]; cam[2] = s[2]; yaw = yawT = s[3]; pitch = pitchT = s[4];
      vel.fill(0); tour = !!keep; snap = true;
    }
    if (st !== undefined) pose(st);
    zone = ''; $('map').style.display = w ? 'none' : '';
  };
  if (SHOT || BENCH) return sw();
  $('fade').classList.add('on');
  setTimeout(() => { sw(); $('fade').classList.remove('on'); }, 260);
}
const go = i => dive(POSES[i][6] | 0, i);
// the tour: a closed Catmull-Rom curve through these points, walked at constant speed
// The tour starts far out over the board, comes in over the package wall, goes through the chip, and leaves again.
const TOURP = [[-2800, 1700, 3200], [-1500, 850, 1750], [-800, 440, 950], [-460, 250, 470], [-290, 160, 200], [-190, 110, 20], [-110, 80, -150], [-40, 62, -176], [0, 46, -130], [40, 42, -102], [60, 38, -84], [57, 22, -84], [55, 8.6, -56],
  [59.2, 4, -24], [59.2, 4, 26], [52, 8.4, 46], [30, 8.4, 55], [-15, 8.4, 55], [-40, 8.4, 42], [-25, 8.6, 20], [0, 8.8, 0], [25, 9, -18],
  [62, 8.6, -8], [95, 8, 10], [132, 8, 30], [165, 16, 55], [122, 22.5, 74], [100, 23, 110], [74, 31, 121], [66, 47, 146], [36, 57, 174],
  [-40, 66, 168], [-60, 84, 110], [-40, 125, 50], [-30, 180, 90], [-60, 250, 260], [-200, 330, 560], [-600, 480, 1050], [-1300, 800, 1800], [-2100, 1250, 2500]];
const TP = [], TL = [0];
{
  const n = TOURP.length, P = i => TOURP[(i + n) % n];
  for (let i = 0; i < n; i++) for (let k = 0; k < 40; k++) {
    const t = k / 40, a = P(i - 1), b = P(i), c = P(i + 1), d = P(i + 2), t2 = t * t, t3 = t2 * t;
    TP.push([0, 1, 2].map(j => .5 * (2 * b[j] + (c[j] - a[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t2 + (3 * b[j] - a[j] - 3 * c[j] + d[j]) * t3)));
  }
  TP.push(TP[0]);
  for (let i = 1; i < TP.length; i++) TL.push(TL[i - 1] + hypot(TP[i][0] - TP[i - 1][0], TP[i][1] - TP[i - 1][1], TP[i][2] - TP[i - 1][2]));
}
const TLEN = TL[TL.length - 1];
function tourAt(s, o) {
  s = ((s % TLEN) + TLEN) % TLEN;
  let lo = 0, hi = TL.length - 1;
  while (hi - lo > 1) { const m = lo + hi >> 1; if (TL[m] <= s) lo = m; else hi = m; }
  const f = (s - TL[lo]) / (TL[hi] - TL[lo] || 1);
  for (let j = 0; j < 3; j++) o[j] = mix(TP[lo][j], TP[hi][j], f);
  return o;
}
let tour = !SHOT, tourS = 0, diveLap = -1, nanoT = -1;
// half way down the data street the tour dives into a transistor for a while, then comes back to the same spot
const TDIVE = TL[TOURP.findIndex(p => p[0] === 59.2 && p[2] === 26) * 40];
// how far outside the package the camera is: out there everything is bigger, so speed, haze and draw distance stretch
const outf = () => max(max(abs(cam[0]), abs(cam[2])) - 320, cam[1] - 135, 0);
const TA = [0, 0, 0], TB = [0, 0, 0];
// where the tour looks from distance s along it: at the path ahead, tipped down when flying high
let TW = 0;
// aim the tour camera from distance s along the path: at the road ahead, or, far outside, at the package itself
// (so the flight in is an approach and the flight out is a slow pull back)
function aim(s) {
  tourAt(s + 14 * (1 + outf() / 50), TB);
  TW = max(sstep(5, 110, outf()), sstep(92, 128, cam[1]));   // also while climbing out past the wall
  TB[0] *= 1 - TW; TB[2] *= 1 - TW; TB[1] = mix(TB[1] - 2, 10, TW);
}
const tourPitch = () => atan2(TB[1] - cam[1], hypot(TB[0] - cam[0], TB[2] - cam[2])) - clamp((cam[1] - 20) / 50, 0, .62) * (1 - TW);   // climbing, it keeps looking down at the chip, not up into the haze

// ---------------------------------------------------------------- collisions: a sphere against boxes and tubes
const RAD = .35, STAMP = new Uint32Array(NI);
let stampN = 0;
// push the sphere at p out of box i
function pushBox(i, p) {
  const o = i * IST, yw = IF[o + 7], hx = IF[o + 4], hy = IF[o + 5], hz = IF[o + 6];
  let dx = p[0] - IF[o], dy = p[1] - IF[o + 1], dz = p[2] - IF[o + 2];
  if (abs(dy) > hy + RAD) return;
  let cs = 1, sn = 0;
  if (yw) { cs = cos(yw); sn = sin(yw); const lx = dx * cs + dz * sn; dz = -dx * sn + dz * cs; dx = lx; }
  let ex = dx - clamp(dx, -hx, hx), ey = dy - clamp(dy, -hy, hy), ez = dz - clamp(dz, -hz, hz);
  const d2 = ex * ex + ey * ey + ez * ez;
  if (d2 >= RAD * RAD) return;
  if (d2 > 1e-10) { const d = sqrt(d2), f = (RAD - d) / d; ex *= f; ey *= f; ez *= f; }
  else {   // inside: leave through the nearest face
    // (never down through the bottom of something that stands on the ground: there is no room under it)
    const px = hx - abs(dx), pz = hz - abs(dz), py = dy > 0 || IF[o + 1] - hy - 2 * RAD >= ground(p) ? hy - abs(dy) : 1e9;
    ex = ey = ez = 0;
    if (px < py && px < pz) ex = (px + RAD) * (sign(dx) || 1); else if (py < pz) ey = (py + RAD) * (sign(dy) || 1); else ez = (pz + RAD) * (sign(dz) || 1);
  }
  if (yw) { const wx = ex * cs - ez * sn; ez = ex * sn + ez * cs; ex = wx; }
  p[0] += ex; p[1] += ey; p[2] += ez;
}
// the height of the ground under p: the die, the pad it is glued to, the floor of the package, the board
const ground = p => { const m = max(abs(p[0]), abs(p[2])); return m < 200 ? 0 : m < 236 ? -8 : m < 332 ? -10 : -16; };
function collide(p) {
  p[0] = clamp(p[0], -9000, 9000); p[2] = clamp(p[2], -9000, 9000); p[1] = clamp(p[1], -15.6, 6000);
  stampN++;
  const x0 = clamp(floor((p[0] - RAD - G0) / GS), 0, GN - 1), x1 = clamp(floor((p[0] + RAD - G0) / GS), 0, GN - 1);
  const z0 = clamp(floor((p[2] - RAD - G0) / GS), 0, GN - 1), z1 = clamp(floor((p[2] + RAD - G0) / GS), 0, GN - 1);
  for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
    const c = gz * GN + gx;
    for (let k = GRID.st[c]; k < GRID.st[c + 1]; k++) { const i = GRID.it[k]; if (STAMP[i] !== stampN) { STAMP[i] = stampN; pushBox(i, p); } }
  }
  for (let i = NOUT0; i < NI; i++) if (STAMP[i] !== stampN) pushBox(i, p);
  for (const w of BOND) {   // tubes: push out of the nearest point on each capsule
    if (hypot(p[0] - w.c[0], p[1] - w.c[1], p[2] - w.c[2]) > w.R + RAD) continue;
    const P = w.p, R = w.r;
    if (w.f) {   // a can: a solid upright cylinder with flat ends
      const y1 = P[P.length - 2], rm = max(...R), dx = p[0] - P[0] || 1e-6, dz = p[2] - P[2], d = hypot(dx, dz), k = max(0, 1 - rm / d);
      const ex = dx * k, ez = dz * k, ey = p[1] - clamp(p[1], P[1], y1), e = hypot(ex, ey, ez);
      if (e >= RAD) continue;
      if (e > 1e-6) { const f = (RAD - e) / e; p[0] += ex * f; p[1] += ey * f; p[2] += ez * f; }
      else if (y1 - p[1] < rm - d) p[1] = y1 + RAD;   // inside: out through the top when that is nearer, otherwise through the side
      else { const f = (rm + RAD) / d; p[0] = P[0] + dx * f; p[2] = P[2] + dz * f; }
      continue;
    }
    for (let j = 0, i = 0; j + 5 < P.length; j += 3, i++) {
      const ax = P[j], ay = P[j + 1], az = P[j + 2], bx = P[j + 3] - ax, by = P[j + 4] - ay, bz = P[j + 5] - az;
      const t = clamp(((p[0] - ax) * bx + (p[1] - ay) * by + (p[2] - az) * bz) / (bx * bx + by * by + bz * bz), 0, 1);
      const ex = p[0] - ax - bx * t, ey = p[1] - ay - by * t, ez = p[2] - az - bz * t, d = hypot(ex, ey, ez), rr2 = mix(R[i], R[i + 1], t) + RAD;
      if (d < rr2 && d > 1e-6) { const f = (rr2 - d) / d; p[0] += ex * f; p[1] += ey * f; p[2] += ez * f; }
    }
  }
}
// is the point p inside a box or a can? Whatever the pushing above did, a step never ends inside something solid
const inBox = (i, p) => {
  const o = i * IST, yw = IF[o + 7];
  if (abs(p[1] - IF[o + 1]) >= IF[o + 5]) return false;
  let dx = p[0] - IF[o], dz = p[2] - IF[o + 2];
  if (yw) { const c = cos(yw), s = sin(yw), l = dx * c + dz * s; dz = -dx * s + dz * c; dx = l; }
  return abs(dx) < IF[o + 4] && abs(dz) < IF[o + 6];
};
function solid(p) {
  const gx = floor((p[0] - G0) / GS), gz = floor((p[2] - G0) / GS);
  if (gx >= 0 && gx < GN && gz >= 0 && gz < GN) { const c = gz * GN + gx; for (let k = GRID.st[c]; k < GRID.st[c + 1]; k++) if (inBox(GRID.it[k], p)) return true; }
  for (let i = NOUT0; i < NI; i++) if (inBox(i, p)) return true;
  for (const w of BOND) if (w.f && p[1] > w.p[1] && p[1] < w.p[w.p.length - 2] && hypot(p[0] - w.p[0], p[2] - w.p[2]) < max(...w.r)) return true;
  return false;
}

// distance along a ray to the first box (a walk through the collision grid, slab test per box)
function rayHit(ox, oy, oz, dx, dy, dz, far) {
  let gx = floor((ox - G0) / GS), gz = floor((oz - G0) / GS), best = far, t0 = 0;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1, ex = dx ? GS / abs(dx) : 1e30, ez = dz ? GS / abs(dz) : 1e30;
  let tx = dx ? ((gx + (dx > 0)) * GS + G0 - ox) / dx : 1e30, tz = dz ? ((gz + (dz > 0)) * GS + G0 - oz) / dz : 1e30;
  stampN++;
  while (t0 < best && gx >= 0 && gx < GN && gz >= 0 && gz < GN) {
    const c = gz * GN + gx;
    for (let k = GRID.st[c]; k < GRID.st[c + 1]; k++) {
      const i = GRID.it[k];
      if (STAMP[i] !== stampN) { STAMP[i] = stampN; best = min(best, slab(i, ox, oy, oz, dx, dy, dz)); }
    }
    if (tx < tz) { t0 = tx; tx += ex; gx += sx; } else { t0 = tz; tz += ez; gz += sz; }
  }
  for (let i = NOUT0; i < NI; i++) if (STAMP[i] !== stampN) best = min(best, slab(i, ox, oy, oz, dx, dy, dz));
  return best;
}
// where a ray enters box i (1e30 if it misses)
function slab(i, ox, oy, oz, dx, dy, dz) {
  const o = i * IST, yw = IF[o + 7], py = oy - IF[o + 1], hx = IF[o + 4], hy = IF[o + 5], hz = IF[o + 6];
  let px = ox - IF[o], pz = oz - IF[o + 2], qx = dx, qz = dz, a = -1e30, b = 1e30, u, v;
  if (yw) { const cs = cos(yw), sn = sin(yw); u = px * cs + pz * sn; pz = -px * sn + pz * cs; px = u; u = qx * cs + qz * sn; qz = -qx * sn + qz * cs; qx = u; }
  if (qx) { u = (-hx - px) / qx; v = (hx - px) / qx; a = max(a, min(u, v)); b = min(b, max(u, v)); } else if (abs(px) > hx) return 1e30;
  if (dy) { u = (-hy - py) / dy; v = (hy - py) / dy; a = max(a, min(u, v)); b = min(b, max(u, v)); } else if (abs(py) > hy) return 1e30;
  if (qz) { u = (-hz - pz) / qz; v = (hz - pz) / qz; a = max(a, min(u, v)); b = min(b, max(u, v)); } else if (abs(pz) > hz) return 1e30;
  return a <= b && a > .3 ? a : 1e30;
}

// ---------------------------------------------------------------- input
const keys = new Set();
let playing = false, SPD = 1, photo = false;
let DOF = store('sv-dof') !== null ? store('sv-dof') === '1' : LV < 2;
const stick = { id: -1, x: 0, y: 0, dx: 0, dy: 0 }, lookT = { id: -1, x: 0, y: 0 };
const FINE = matchMedia('(pointer:fine)');
addEventListener('keydown', e => {
  if (e.repeat && !e.code.startsWith('Key') && !e.code.startsWith('Arrow')) return;
  keys.add(e.code);
  if (!playing) return;
  sound();
  if (e.repeat) return;
  if (e.code >= 'Digit0' && e.code <= 'Digit9') go((+e.code[5] + 9) % 10);
  else if (e.code === 'KeyZ') dive(1 - WORLD);
  else if (e.code === 'KeyF') { tour = !tour; nanoT = -1; if (tour && !WORLD) tourS = nearestTour(); }
  else if (e.code === 'KeyM') { setMute(!MUTED); syncMenu(); }
  else if (e.code === 'KeyH') $('hud').classList.toggle('off');
  else if (e.code === 'KeyP') photo = true;
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('wheel', e => { if (playing) SPD = clamp(SPD * (e.deltaY < 0 ? 1.18 : .85), .25, 5); }, { passive: true });
cvs.addEventListener('click', () => { if (playing && !document.pointerLockElement && FINE.matches) cvs.requestPointerLock?.(); });
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== cvs) return;
  yawT += e.movementX * .0022; pitchT = clamp(pitchT - e.movementY * .0022, -1.5, 1.5);
  if (abs(e.movementX) + abs(e.movementY) > 2) tour = false;
});
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && playing && FINE.matches) menu(true); });
// touch: the left half is a joystick, the right half looks around
cvs.addEventListener('touchstart', e => {
  for (const t of e.changedTouches) {
    if (t.clientX < innerWidth / 2 && stick.id < 0) Object.assign(stick, { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0 });
    else if (lookT.id < 0) Object.assign(lookT, { id: t.identifier, x: t.clientX, y: t.clientY });
  }
  tour = false; e.preventDefault();
}, { passive: false });
cvs.addEventListener('touchmove', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === stick.id) { stick.dx = clamp((t.clientX - stick.x) / 60, -1, 1); stick.dy = clamp((t.clientY - stick.y) / 60, -1, 1); }
    if (t.identifier === lookT.id) { yawT += (t.clientX - lookT.x) * .005; pitchT = clamp(pitchT - (t.clientY - lookT.y) * .005, -1.5, 1.5); lookT.x = t.clientX; lookT.y = t.clientY; }
  }
  e.preventDefault();
}, { passive: false });
const endTouch = e => { for (const t of e.changedTouches) { if (t.identifier === stick.id) stick.id = -1, stick.dx = stick.dy = 0; if (t.identifier === lookT.id) lookT.id = -1; } };
cvs.addEventListener('touchend', endTouch); cvs.addEventListener('touchcancel', endTouch);

function nearestTour() {
  let best = 0, bd = 1e9;
  for (let i = 0; i < TP.length; i += 4) { const d = hypot(TP[i][0] - cam[0], TP[i][1] - cam[1], TP[i][2] - cam[2]); if (d < bd) { bd = d; best = TL[i]; } }
  return best;
}
const K = c => keys.has(c) ? 1 : 0;
// camera axes, refreshed after every move: forward, right, up
let FX = 0, FY = 0, FZ = -1, RX = 1, RZ = 0, UX = 0, UY = 1, UZ = 0, wasIn = false;
const PREV = [0, 0, 0];
function move(dt) {
  const mf = K('KeyW') + K('ArrowUp') - K('KeyS') - K('ArrowDown') - stick.dy;
  const mr = K('KeyD') + K('ArrowRight') - K('KeyA') - K('ArrowLeft') + stick.dx;
  const mu = K('KeyE') + K('Space') - K('KeyQ') - K('KeyC');
  if (playing && (mf || mr || mu)) tour = false;   // taking the controls ends the tour
  const big = 1 + outf() / 50;
  if (tour && WORLD) {   // inside the crystal the tour is a slow drift down a channel, sliding around the atoms
    if (nanoT >= 0 && T - nanoT > 24) { nanoT = -1; dive(0, undefined, true); }
    cam[0] += 2.6 * dt; cam[1] += sin(T * .21) * .3 * dt; cam[2] += sin(T * .13) * .45 * dt;
    ncollide(cam);
    const k = 1 - exp(-dt * 1.5);
    yawT += (PI / 2 + sin(T * .11) * .55 - yawT) * k; pitchT += (sin(T * .17) * .22 - pitchT) * k;
    vel.fill(0);
  } else if (tour) {
    tourS += dt * 9 * big;
    const lap = floor(tourS / TLEN);
    if (!BENCH && tourS - lap * TLEN > TDIVE && diveLap !== lap) { diveLap = lap; nanoT = T; dive(1, undefined, true); }
    tourAt(tourS, TA); aim(tourS);
    const k = 1 - exp(-dt * 3);
    for (let j = 0; j < 3; j++) cam[j] += (TA[j] - cam[j]) * (1 - exp(-dt * 8));
    let ty = atan2(TB[0] - cam[0], cam[2] - TB[2]);
    while (ty - yawT > PI) ty -= 2 * PI;
    while (ty - yawT < -PI) ty += 2 * PI;
    yawT += (ty - yawT) * k; pitchT += (tourPitch() - pitchT) * k;
    vel.fill(0);
  } else {
    const sp = (K('ShiftLeft') || K('ShiftRight') ? 30 : 7) * (WORLD ? .4 : big) * SPD / max(1, hypot(mf, mr, mu));
    const k = 1 - exp(-dt * 3.5);
    vel[0] += ((FX * mf + RX * mr) * sp - vel[0]) * k;
    vel[1] += ((FY * mf + mu) * sp - vel[1]) * k;
    vel[2] += ((FZ * mf + RZ * mr) * sp - vel[2]) * k;
    const n = max(1, ceil(hypot(vel[0], vel[1], vel[2]) * dt / (.2 * (WORLD ? 1 : big))));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 3; j++) { PREV[j] = cam[j]; cam[j] += vel[j] * dt / n; }
      if (WORLD) { ncollide(cam); continue; }
      collide(cam);
      const s = solid(cam);
      if (s && !wasIn) for (let j = 0; j < 3; j++) cam[j] = PREV[j];   // no way in: stay where the step began
      else wasIn = s;                                                 // (a station that starts inside something may still fly out)
    }
  }
  const k = snap ? 1 : 1 - exp(-dt * 16);
  yaw += (yawT - yaw) * k; pitch += (pitchT - pitch) * k;
  const cp = cos(pitch), sp = sin(pitch), cy = cos(yaw), sy = sin(yaw);
  FX = sy * cp; FY = sp; FZ = -cy * cp; RX = cy; RZ = sy; UX = -sy * sp; UY = cp; UZ = cy * sp;
}

// autofocus, like an eye at the eyepiece: five rays through the middle of the view, averaged in diopters (1 / distance),
// and the lens follows slowly
let focD = .05;
const FO = [0, 0, .09, .06, -.09, .06, .09, -.06, -.09, -.06];
function focus(dt) {
  let s = 0;
  for (let i = 0; i < 10; i += 2) {
    const u = FO[i], v = FO[i + 1], dx = FX + RX * u + UX * v, dy = FY + UY * v, dz = FZ + RZ * u + UZ * v, l = hypot(dx, dy, dz);
    s += 1 / (WORLD ? nhit(cam[0], cam[1], cam[2], dx / l, dy / l, dz / l) : rayHit(cam[0], cam[1], cam[2], dx / l, dy / l, dz / l, 20000));
  }
  focD = snap ? s / 5 : focD + (s / 5 - focD) * (1 - exp(-dt * 3.5));
}

// ---------------------------------------------------------------- per-frame uniforms
const PRJ = new Float32Array(16), VW = new Float32Array(16), VP = new Float32Array(16);
const FOVY = 1.08, NEAR = .04, TY = tan(FOVY / 2);
function uniforms() {
  const asp = CW / CH, tx = TY * asp;
  persp(PRJ, FOVY, asp, NEAR); view(VW, cam, yaw, pitch); mmul(VP, PRJ, VW);
  UF.set(VP, 0);
  UF[32] = cam[0]; UF[33] = cam[1]; UF[34] = cam[2]; UF[35] = T;
  UF[36] = FX; UF[37] = FY; UF[38] = FZ; UF[39] = NEAR;
  UF[40] = RX * tx; UF[41] = 0; UF[42] = RZ * tx; UF[43] = 0;
  UF[44] = UX * TY; UF[45] = UY * TY; UF[46] = UZ * TY; UF[47] = (T % CLKT) * CLKV - 100;
  UF[48] = CW; UF[49] = CH; UF[50] = RW; UF[51] = RH;
  const out = WORLD ? 0 : outf();
  UF[52] = CULLPX; UF[53] = RH / (2 * TY); UF[54] = 1 / (1 + out / 80); UF[55] = min(470 + out * 16, 60000);
  // frustum planes from the rows of the view-projection matrix: left, right, bottom, top, near
  for (let j = 0; j < 4; j++) {
    const a = VP[j * 4], b = VP[j * 4 + 1], c = VP[j * 4 + 2], d = VP[j * 4 + 3];
    UF[56 + j] = d + a; UF[60 + j] = d - a; UF[64 + j] = d + b; UF[68 + j] = d - b; UF[72 + j] = d - c;
  }
  for (let o = 56; o < 76; o += 4) { const l = hypot(UF[o], UF[o + 1], UF[o + 2]); UF[o] /= l; UF[o + 1] /= l; UF[o + 2] /= l; UF[o + 3] /= l; }
  for (let i = 0; i < 4; i++) UF[79 + i * 4] = GLOW[i][3] * (.8 + .2 * sin(T * .9 + i * 1.7));   // the cores' heat breathes
  dev.queue.writeBuffer(ubuf, 0, UF);
  PPF[0] = WORLD ? .95 : 1.15 - .25 * (1 - UF[54]); PPF[1] = WORLD ? .06 : .04; PPF[2] = RAYS && !WORLD ? 1 : 0; PPF[3] = T; PPF[4] = CW; PPF[5] = CH; PPF[6] = RW; PPF[7] = RH;
  PPF[8] = focD; PPF[9] = DOF ? 24 * max(1, .05 / focD) * CH / 1080 : 0; PPF[10] = NEAR; PPF[11] = 6 * CH / 1080;
  dev.queue.writeBuffer(ppbuf, 0, PPF);
}

// ---------------------------------------------------------------- the frame
let T = QS.has('t') ? +QS.get('t') : 0, FIXT = QS.has('t'), last = performance.now(), frameN = 0, lifeT = 0, dynT = 0, ftAcc = 0, ftN = 0;
const bench = BENCH ? { t0: 0, ft: [], gpu: [] } : null;
const mk = $('mk'), MAPK = 132 / 640;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = min(.1, max(0, (now - last) / 1000)); last = now; frameN++;
  if (!FIXT) T += dt;
  ftAcc += dt; ftN++;
  move(dt);
  focus(dt);
  snap = false;
  uniforms();
  const enc = dev.createCommandEncoder();
  if (!SHOT && T - lifeT > .17) {
    lifeT = T; LSF[0] += 1; dev.queue.writeBuffer(lsbuf, 0, LSF);
    const c = enc.beginComputePass(); c.setPipeline(pLife); c.setBindGroup(0, bgLife); c.dispatchWorkgroups(64, 64); c.end();
    enc.copyTextureToTexture({ texture: lifeB }, { texture: lifeA }, [512, 512]);
  }
  dev.queue.writeBuffer(argB, 4, ZERO);
  const tsw = TS && !tsBusy;
  const cp = enc.beginComputePass(tsw ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0 } } : undefined);
  cp.setPipeline(pCull); cp.setBindGroup(0, bgCull); cp.dispatchWorkgroups(WORLD ? 1 : ceil(NI / 64)); cp.end();
  const sp = enc.beginRenderPass(scenePass);
  if (WORLD) {
    sp.setBindGroup(0, bgNano);
    sp.setPipeline(pAtom); sp.draw(6, NN * NN * NN * 8);
    sp.setPipeline(pBond); sp.draw(6, NN * NN * NN * 16);
    sp.setPipeline(pNSky); sp.draw(3);
    sp.setPipeline(pElec); sp.draw(6, NELEC);
  } else {
    sp.setBindGroup(0, bgScene);
    sp.setPipeline(pBox); sp.setIndexBuffer(idxB, 'uint16'); sp.drawIndexedIndirect(argB, 0);
    sp.setPipeline(pTube); sp.setVertexBuffer(0, tvB); sp.setIndexBuffer(tiB, 'uint32'); sp.drawIndexed(TUBE_I.length);
    sp.setPipeline(pSky); sp.draw(3);
    sp.setPipeline(pMote); sp.draw(6, MOTES);
  }
  sp.end();
  const bc = blitPass.colorAttachments[0];
  if (RAYS && !WORLD) {
    bc.view = rayV; bc.loadOp = 'clear';
    const rp = enc.beginRenderPass(blitPass); rp.setPipeline(pRays); rp.setBindGroup(0, bgRays); rp.draw(3); rp.end();
  }
  if (DOF) { bc.view = dofV; bc.loadOp = 'clear'; const p = enc.beginRenderPass(blitPass); p.setPipeline(pDof); p.setBindGroup(0, bgDof); p.draw(3); p.end(); }
  for (let l = 0; l < 6; l++) {   // bloom: down the chain...
    bc.view = blV[l]; bc.loadOp = 'clear';
    const p = enc.beginRenderPass(blitPass); p.setPipeline(l ? pD : pD0); p.setBindGroup(0, bgBl[l]); p.draw(3); p.end();
  }
  for (let l = 4; l >= 0; l--) {   // ...and back up, each level adding the blurred one below it
    bc.view = blV[l]; bc.loadOp = 'load';
    const p = enc.beginRenderPass(blitPass); p.setPipeline(pU); p.setBindGroup(0, bgBl[l + 2]); p.draw(3); p.end();
  }
  postPass.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  postPass.timestampWrites = tsw ? { querySet: qs, endOfPassWriteIndex: 1 } : undefined;
  const pp = enc.beginRenderPass(postPass); pp.setPipeline(pPost); pp.setBindGroup(0, bgPost); pp.draw(3); pp.end();
  if (tsw) { enc.resolveQuerySet(qs, 0, 2, qRes, 0); enc.copyBufferToBuffer(qRes, 0, qRead, 0, 16); }
  dev.queue.submit([enc.finish()]);
  if (tsw) {
    tsBusy = true;
    qRead.mapAsync(GPUMapMode.READ).then(() => {
      const b = new BigUint64Array(qRead.getMappedRange()), ms = Number(b[1] - b[0]) / 1e6;
      qRead.unmap(); tsBusy = false;
      if (ms > 0 && ms < 1000) { gpuAcc += ms; gpuN++; if (bench?.t0) bench.gpu.push(ms); }
    }, () => { tsBusy = false; });
  }
  if (photo) {   // the canvas still holds this frame until the task ends
    photo = false;
    cvs.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'chip-voyage.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
  }
  if (bench?.t0) bench.ft.push(dt * 1000);
  dynres(now);
  if (frameN % 3 === 0) mk.style.transform = `translate(${(cam[0] + 320) * MAPK}px,${(cam[2] + 320) * MAPK}px) rotate(${yaw}rad)`;
  if (frameN % 15 === 0) hud();
  if (frameN === 20) window.__ready = true;
  if (BENCH) runBench(now);
}

// dynamic resolution: steer the render scale so the GPU stays inside a 60 Hz frame
function dynres(now) {
  if (now - dynT < 700) return;
  dynT = now;
  const g = gpuN ? gpuAcc / gpuN : ftAcc / ftN * 1000, hi = gpuN ? 15 : 21, lo = gpuN ? 10.5 : 0;
  gpuAcc = gpuN = 0; ftAcc = ftN = 0;
  if (FIXS) return;
  let s = SCALE;
  if (g > hi) s = max(.5, s * clamp(sqrt(13 / g), .8, .96)); else if (g < lo) s = min(SMAX, s * 1.05);
  s = round(s * 20) / 20;
  if (s !== SCALE) { SCALE = s; targets(); }
}

function runBench(now) {
  if (!bench.t0 && frameN > 60) { if (QS.has('world')) dive(1); bench.t0 = now; tour = true; tourS = 0; }
  if (bench.t0 && now - bench.t0 > 45000 && !window.__bench) {
    const st = a => { const s = [...a].sort((x, y) => x - y); return { avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p50: +s[s.length >> 1].toFixed(2), p99: +s[floor(s.length * .99)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
    window.__bench = { frames: bench.ft.length, frame: st(bench.ft), gpu: bench.gpu.length ? st(bench.gpu) : null, scale: SCALE, size: [RW, RH], level: LV, boxes: NI };
    console.log('BENCH ' + JSON.stringify(window.__bench));
  }
}

// ---------------------------------------------------------------- HUD: where am I
let zone = '', zoneT = 0;
function where(x, z) {
  const m = max(abs(x), abs(z));
  if (m > 334 || cam[1] > 118) return [tr('לוח המעגל', 'The circuit board'), tr('השבב מולחם ללוח, בין קבלים ונגדים שנראים מכאן כמו מגדלים. פסי הנחושת מביאים אליו חשמל ואותות.', 'The chip is soldered to a board, among capacitors and resistors that look like towers from here. Copper traces bring it power and signals.')];
  if (m > 240) return [tr('מדף החיבורים', 'The bond shelf'), tr('כאן נוחתים חוטי הזהב, ומכאן ממשיכים פסים אל הרגליים של המארז.', 'The gold wires land here, and traces carry on to the legs of the package.')];
  if (m > 200) return [tr('תעלת המארז', 'The package moat'), tr('הרווח בין השבב למדף. למטה: משטח הזהב שעליו מודבק השבב.', 'The gap between the chip and the shelf. Below: the gold pad the chip is glued to.')];
  if (x < -178 && z > 178) return [tr('מחט הבדיקה', 'The probe needle'), tr('מחט טונגסטן של תחנת הבדיקה נוגעת במגע ומודדת אם השבב עובד.', 'A tungsten needle from the test station touches a pad and checks that the chip works.')];
  if (m > 181) return [tr('טבעת המגעים', 'The pad ring'), tr('משטחי אלומיניום בשולי השבב. מכל אחד יוצא חוט זהב החוצה.', 'Aluminium pads around the edge of the chip. A gold wire leaves each one.')];
  for (const b of BLK) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) return [b[4], b[5]];
  return [tr('רחוב נתונים', 'A data street'), tr('ערוץ בין האזורים. כאן עוברת תנועה כבדה של נתונים, כמו בכביש מהיר.', 'A channel between the blocks. Heavy data traffic runs here, like a motorway.')];
}
const LAYERS = tr('רצפת הסיליקון,חיווט מקומי,אוטובוסים של נתונים,עץ השעון,חיווט רחוק,רשת החשמל,מעל השבב',
  'the silicon floor,local wiring,data buses,the clock tree,long-distance wiring,the power grid,above the chip').split(',');
const layerName = y => LAYERS[y < 1.2 ? 0 : y < 8 ? 1 : y < 14 ? 2 : y < 18.5 ? 3 : y < 27 ? 4 : y < 37.5 ? 5 : 6];
function hud() {
  const [n, d] = WORLD ? (cam[1] > -9
    ? [tr('ערוץ הטרנזיסטור', 'The transistor channel'), tr('מעל: הזכוכית של השער. בכל פעימת שעון השער נפתח, ואלקטרונים שוטפים את הערוץ.', 'Above: the glass of the gate. On every clock beat the gate opens and electrons flood the channel.')]
    : [tr('גביש הסיליקון', 'The silicon crystal'), tr('כל כדור הוא אטום, ולכל אטום ארבעה שכנים. הכתומים הם אטומי זרחן שנשתלו כדי לתרום אלקטרונים.', 'Every ball is an atom, and every atom has four neighbours. The orange ones are phosphorus atoms, planted to donate electrons.')])
    : where(cam[0], cam[2]);
  if (n !== zone) { zone = n; zoneT = performance.now(); $('rgn').textContent = n; $('rgd').textContent = d; $('rg').classList.add('on'); }
  else if (performance.now() - zoneT > 7000) $('rg').classList.remove('on');
  $('alt').textContent = (WORLD ? (-cam[1] * .136).toFixed(1) + tr(' ננומטר מתחת לשער', ' nanometres below the gate')
    : cam[1] > 250 ? tr('גובה ', 'Height ') + (cam[1] / 1000).toFixed(2) + tr(' מ"מ מעל הלוח', ' mm above the board')
    : tr('גובה ', 'Height ') + max(0, cam[1]).toFixed(1) + tr(' מיקרון · ', ' microns · ') + layerName(cam[1])) + (abs(SPD - 1) > .05 ? tr(' · מהירות ×', ' · speed ×') + SPD.toFixed(1) : '');
  BUSY = WORLD ? .5 : /ליבה|מטמון|רחוב|Core|cache|street/.test(n) ? 1.6 : .7;
  NEAR_AI = clamp(1 - hypot(cam[0] - 120, cam[2]) / 110, 0, 1);
  $('map').style.opacity = WORLD || outf() > 60 ? 0 : .9;
}
// the little map: package, die, blocks; the marker is moved every few frames
{
  const c = $('mapc'), g = c.getContext('2d'), k = c.width / 640, X = v => (v + 320) * k;
  const R = (r, col) => { g.fillStyle = col; g.fillRect(X(-r), X(-r), 2 * r * k, 2 * r * k); };
  R(320, '#070b13'); R(290, '#161d2b'); R(240, '#0a0f19'); R(200, '#1b2638');
  for (const b of BLK) {
    g.fillStyle = b[6] === 2 ? 'rgba(70,225,165,.42)' : b[6] ? 'rgba(105,165,255,.34)' : 'rgba(255,190,95,.4)';
    g.fillRect(X(b[0]) + 1, X(b[1]) + 1, (b[2] - b[0]) * k - 2, (b[3] - b[1]) * k - 2);
  }
}

// ---------------------------------------------------------------- menu
function menu(on) {
  $('menu').classList.toggle('hide', !on);
  $('hud').classList.toggle('dim', on);
  playing = !on;
}
function syncMenu() {
  for (const b of $('q').children) b.classList.toggle('on', +b.dataset.q === LV);
  for (const b of $('snd').children) b.classList.toggle('on', +b.dataset.s === (MUTED ? 0 : 1));
  for (const b of $('dof').children) b.classList.toggle('on', +b.dataset.d === (DOF ? 1 : 0));
  for (const b of $('lang').children) b.classList.toggle('on', (b.dataset.l === 'he') === HE);
}
function start() {
  menu(false); sound(); tour = false;
  if (FINE.matches) cvs.requestPointerLock?.();
}
$('go').onclick = start;
for (const b of $('q').children) b.onclick = () => { store('sv-q', b.dataset.q); location.reload(); };
for (const b of $('snd').children) b.onclick = () => { setMute(b.dataset.s === '0'); syncMenu(); };
for (const b of $('lang').children) b.onclick = () => { store('sv-lang', b.dataset.l); location.reload(); };
for (const b of $('dof').children) b.onclick = () => { DOF = b.dataset.d === '1'; store('sv-dof', b.dataset.d); syncMenu(); };
POSES.forEach((p, i) => {
  const b = document.createElement('button');
  b.innerHTML = (i < 10 ? `<kbd>${(i + 1) % 10}</kbd> ` : '') + p[5];
  b.onclick = () => { go(i); start(); };
  i < 10 ? $(p[6] ? 'st2' : 'st').append(b) : $('st').prepend(b);
});
$('tourb').onclick = () => { start(); tour = true; if (!WORLD) tourS = nearestTour(); };
syncMenu();

// ---------------------------------------------------------------- go
await say(tr('יוצאים לדרך…', 'Off we go…'), 1);
try { localStorage.removeItem('sv-loading'); } catch {}
if (SHOT) { go((+QS.get('pose') || 1) - 1); $('hud').hidden = true; if (QS.has('dof')) DOF = QS.get('dof') === '1'; }
else { tourAt(0, cam); aim(0); yaw = yawT = atan2(TB[0] - cam[0], cam[2] - TB[2]); pitch = pitchT = tourPitch(); }
window.__sv = {   // dev hooks for tools/shoot.mjs
  pose: go, frames: () => frameN, world: w => dive(w), state: () => ({ world: WORLD, tour, s: +tourS.toFixed(0), dive: +TDIVE.toFixed(0), len: +TLEN.toFixed(0), cam: cam.map(v => +v.toFixed(1)) }),
  jump: s => { tourS = s; },
  at: (x, y, z, a, b) => { cam[0] = x; cam[1] = y; cam[2] = z; yaw = yawT = a; pitch = pitchT = b; tour = false; snap = true; vel.fill(0); }, setT: t => { T = t; FIXT = true; }, sound, audio: () => AC && AC.state, audioStats,
  push: (x, y, z) => { const p = [x, y, z]; collide(p); return p.map(v => +v.toFixed(3)); },
  focus: () => +(1 / focD).toFixed(2), inside: () => solid(cam),
  tour: s => { tour = false; tourAt(s, cam); aim(s); yaw = yawT = atan2(TB[0] - cam[0], cam[2] - TB[2]); pitch = pitchT = tourPitch(); snap = true; return TLEN; },
  // the tour distance reached after t seconds (it speeds up outside), or the whole lap's duration when t is missing
  tourT: t => { let s = 0, i = 0; for (; t === undefined ? s < TLEN : i < t * 10; i++) { tourAt(s, TA); s += .9 * (1 + max(max(abs(TA[0]), abs(TA[2])) - 320, TA[1] - 135, 0) / 50); } return t === undefined ? i / 10 : s; },
};
$('ld').classList.add('hide');
if (!SHOT && !BENCH) menu(true);
requestAnimationFrame(t => { last = t; frame(t); });
