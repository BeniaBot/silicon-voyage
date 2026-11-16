// Renders the world in a separate Chrome with its own empty profile (nothing of the user's is touched)
// and saves screenshots of the stations, or runs the 45 s benchmark flight.
//   node tools/shoot.mjs [--out shots] [--poses 1,2,3] [--q 1] [--t 12] [--w 1600] [--h 900] [--extra "&scale=.75"] [--bench] [--tour 18] [--clip 6,11,12,4] [--headful]
//   --phone makes the page believe it is on a touch screen (with --w 390 --h 844 for a phone held upright); --touch then drives it with fingers
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const has = k => argv.includes('--' + k);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, arg('out', 'shots'));
const W = +arg('w', 1600), H = +arg('h', 900), Q = arg('q', '1'), T = arg('t', '13.7');
const POSES = arg('poses', '1,2,3,4,5,6,7,8').split(',').map(Number);
const BENCH = has('bench');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms)), abs = Math.abs;

// static file server for the project folder
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const SPORT = server.address().port;

const port = 9400 + (Math.random() * 400 | 0);
const prof = join(tmpdir(), 'sv-harness-profile');
const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--enable-unsafe-webgpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', `--window-size=${W},${H}`, '--sv-harness', 'about:blank'];
if (!has('headful')) args.unshift('--headless=new');
if (has('check')) args.unshift('--autoplay-policy=no-user-gesture-required');
const chrome = spawn(CHROME, args, { stdio: 'ignore' });
const done = code => { try { chrome.kill(); } catch {} server.close(); process.exit(code); };

let ver;
for (let i = 0; i < 100 && !ver; i++) { await sleep(150); try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {} }
if (!ver) { console.error('chrome did not start'); done(1); }
const tgt = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();

// a minimal CDP client
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nid = 0;
const pend = new Map(), logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded') logs.push(`[log ${m.params.entry.level}] ${m.params.entry.text}`);
};
const send = (method, params = {}) => new Promise((r, j) => { const id = ++nid; pend.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const flush = () => { for (const l of logs.splice(0)) console.log(l); };

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
const PHONE = has('phone') || has('touch');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: PHONE ? 2 : 1, mobile: PHONE });
if (PHONE) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const LIVE = has('dive') || has('fly') || has('hud') || has('touch');
const url = `http://127.0.0.1:${SPORT}/index.html?${BENCH ? 'bench' : has('ui') || LIVE ? 'ui' : 'shot'}${has('q') || !PHONE ? '&q=' + Q : ''}${BENCH || LIVE ? '' : '&t=' + T}${arg('extra', '')}`;
await send('Page.navigate', { url });
const t0 = Date.now(), want = BENCH ? '!!window.__bench' : 'window.__ready === true', limit = BENCH ? 120000 : 90000;
while (!(await ev(want).catch(() => false))) {
  if (Date.now() - t0 > limit) { flush(); console.error('timed out; loader says: ' + await ev("document.getElementById('ldt')?.textContent")); done(1); }
  await sleep(300);
}
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (BENCH) { console.log(JSON.stringify(await ev('window.__bench'), null, 1)); flush(); done(0); }
await mkdir(OUT, { recursive: true });
const shoot = async name => {
  const f0 = await ev('__sv.frames()');
  while ((await ev('__sv.frames()')) < f0 + 8) await sleep(50);
  const { data } = await send('Page.captureScreenshot', name.endsWith('png') ? { format: 'png' } : { format: 'jpeg', quality: 88 });
  await writeFile(join(OUT, name), Buffer.from(data, 'base64'));
  console.log('saved ' + name);
};
if (has('check')) {   // collisions: points inside solids must come out, free points must stay put
  const cases = [['inside the die', [10, -3, 10]], ['inside a power strap', [20, 29.2, 1]], ['just above the floor', [55, .1, 120]],
    ['free air in a street', [55, 4, 120]], ['beyond the edge of the board', [20000, 50, 0]],
    ['inside the neighbouring chip', [2150, 100, -500]], ['inside a board capacitor', [-900, 100, -1250]], ['inside a capacitor can', [-1750, 500, -2350]],
    ['inside the pin header', [-2920, 100, 0]], ['inside the crystal', [1750, 150, 1130]], ['inside the package wall', [0, 20, 350]], ['free air over the board', [900, 400, 1500]]];
  for (const [name, p] of cases) {
    const r = await ev(`__sv.push(${p.join(',')})`);
    console.log(name.padEnd(22), JSON.stringify(p), '->', JSON.stringify(r));
  }
  await ev('__sv.sound()');
  await sleep(1500);
  console.log('audio state:', await ev('__sv.audio()'));
  console.log('audio level (dBFS, 8 s rendered offline):', JSON.stringify(await ev('__sv.audioStats()')));
  console.log('focus distance at station 1:', await ev('__sv.pose(0), new Promise(r => setTimeout(() => r(__sv.focus()), 300))'));
  flush(); done(0);
}
if (has('fly')) {   // real flight with the keys held down, at the highest speed: the camera must stop at every solid thing on the board
  await ev("document.querySelector('#spd button:last-child').click(); document.getElementById('go').click(); for (let i = 0; i < 14; i++) dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))");
  const D = -1.5707, B = -15.6;   // straight down; hugging the board
  const cases = [['the neighbouring chip, from the south', [2150, 120, 900, 0, 0], 'z', -24.65],
    ['the neighbouring chip, from above', [2150, 1500, -500, 0, D], 'y', 268.35],
    ['the crystal, from far away', [2150, 120, 7000, 0, 0], 'z', 1310.35],
    ['the crystal, hugging the board', [1750, B, 2600, 0, 0], 'z', 1330.35],
    ['a board capacitor, from the south', [-900, 150, -300, 0, 0], 'z', -1084.65],
    ['a board capacitor, from above', [-900, 1500, -1250, 0, D], 'y', 286.35],
    ['a board capacitor, hugging the board', [-900, B, -300, 0, 0], 'z', -1084.65],
    ['a resistor, from the east', [-600, 60, 210, -1.5708, 0], 'x', -1189.65],
    ['a resistor, hugging the board', [-600, B, 210, -1.5708, 0], 'x', -1189.65],
    ['a capacitor can (the camera may slide around it)', [-1750, 500, -1200, 0, 0], 'z', null],
    ['a capacitor can, hugging the board', [-1750, B, -1200, 0, 0], 'z', -1898.15],
    ['a capacitor can, from above', [-1750, 3000, -2350, 0, D], 'y', 1484.35],
    ['the pin header, from the east', [-2000, 120, 0, -1.5708, 0], 'x', -2789.65],
    ['the pin header, hugging the board', [-2000, B, 0, -1.5708, 0], 'x', -2789.65],
    ['the crystal, along the seam of its base', [1750, 4.2, 2600, 0, 0], 'z', 1320.35],
    ['the neighbouring chip, along the seam of its lid', [2150, 218.1, 900, 0, 0], 'z', -50.65],
    ['the package wall, from outside', [0, 50, 900, 0, 0], 'z', 332.35],
    ['the package wall, from far away', [0, 50, 6000, 0, 0], 'z', 332.35],
    ['the board, from above', [1000, 2500, 2800, 0, D], 'y', -15.65]];
  let bad = 0;
  for (const [name, at, ax, want] of cases) {
    if (has('only') && !name.includes(arg('only'))) continue;
    await ev(`__sv.at(${at.join(',')})`); await sleep(200);
    for (const k of ['KeyW', 'ShiftLeft']) await ev(`dispatchEvent(new KeyboardEvent('keydown', { code: '${k}' }))`);
    let c, prev = 1e9, t = 0, inside = 0;
    do { await sleep(500); t += .5; const g = (c = (await ev('__sv.state()')).cam)['xyz'.indexOf(ax)]; inside += await ev('__sv.inside()'); if (has('trace')) console.log('   ', t, JSON.stringify(c)); if (abs(g - prev) < .05) break; prev = g; } while (t < 40);
    for (let k = 0; k < 3; k++) { await sleep(500); inside += await ev('__sv.inside()'); }   // keep pushing against it for a while
    c = (await ev('__sv.state()')).cam;
    for (const k of ['KeyW', 'ShiftLeft']) await ev(`dispatchEvent(new KeyboardEvent('keyup', { code: '${k}' }))`);
    await sleep(400);
    const ok = !inside && (want === null || abs(c['xyz'.indexOf(ax)] - want) < 14);
    bad += !ok;
    console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(38), 'stopped at', JSON.stringify(c), 'after ' + t + ' s; ' + (inside ? 'it was INSIDE something solid' : want === null ? 'never inside' : 'expected ' + ax + ' near ' + want));
  }
  console.log(bad ? bad + ' FAILED' : 'all stopped where they should');
  flush(); done(bad ? 1 : 0);
}
if (has('dive')) {   // the attract-mode tour must dive into the transistor at its dive point and come back by itself
  const st = await ev('__sv.state()');
  console.log('start', JSON.stringify(st));
  await ev(`__sv.jump(${st.dive - 40})`);
  for (const w of [3, 6, 14, 12]) { await sleep(w * 1000); console.log(JSON.stringify(await ev('__sv.state()'))); }
  flush(); done(0);
}
if (has('hud')) {   // the screen as a visitor sees it in flight: labels, height, the little map. --hud "station,station,..."
  await ev("document.getElementById('go').click()");
  for (const p of arg('hud', '1').split(',')) { await ev(`__sv.pose(${p - 1})`); await sleep(1800); await shoot(`hud${p}.jpg`); }
  flush(); done(0);
}
if (has('touch')) {   // a phone: the menu fits and scrolls, a tap starts the flight, one finger flies, another looks around, the corner button brings the menu back
  const touch = (type, pts) => send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  const tap = async sel => {
    const [x, y] = await ev(`(() => { const e = document.querySelector('${sel}'); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await touch('touchStart', [[x, y, 9]]); await sleep(60); await touch('touchEnd', []); await sleep(500);
  };
  let bad = 0;
  const say = (ok, what, extra = '') => { bad += !ok; console.log((ok ? 'ok   ' : 'FAIL ') + what, extra); };
  await sleep(1200);
  const m = await ev(`(() => {
    const c = document.querySelector('.card'), r = c.getBoundingClientRect();
    const o = [...c.querySelectorAll('button,a,.row,.seg,.ttl,.sub')].filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > r.right + 1 || e.getBoundingClientRect().left < r.left - 1).map(e => e.id || e.className || e.textContent.slice(0, 20));
    return { coarse: matchMedia('(pointer:coarse)').matches, lv: document.querySelector('#q .on')?.dataset.q, vw: innerWidth, vh: innerHeight, card: [r.x, r.y, r.width, r.height].map(Math.round),
      scroll: [c.scrollHeight, c.clientHeight, c.scrollWidth, c.clientWidth], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], spill: o };
  })()`);
  console.log(JSON.stringify(m));
  say(m.coarse, 'the page sees a touch screen'); say(m.lv === '2' || has('q'), 'low detail is picked by itself', 'level ' + m.lv);
  say(m.card[0] >= 0 && m.card[0] + m.card[2] <= m.vw && m.card[1] >= 0 && m.card[1] + m.card[3] <= m.vh, 'the menu card is inside the screen');
  say(m.scroll[2] <= m.scroll[3] + 1 && m.page[0] <= m.vw, 'nothing scrolls sideways'); say(!m.spill.length, 'nothing spills out of the card', m.spill.join(' | '));
  await shoot('phone-menu.jpg');
  await ev("document.querySelector('.card').scrollTo(0, 1e5)"); await sleep(300); await shoot('phone-menu2.jpg');
  say(await ev("(() => { const c = document.querySelector('.card').getBoundingClientRect(), a = document.querySelector('.src').getBoundingClientRect(); return a.bottom <= c.bottom + 1; })()"), 'the last line of the menu can be scrolled into view');
  await tap('#go');
  let s = await ev('__sv.state()');
  say(!s.menu, 'a tap on the start button starts the flight'); say(await ev('__sv.audio()') === 'running', 'sound runs after the tap', await ev('__sv.audio()'));
  await ev('__sv.pose(1)'); await sleep(1800); await shoot('phone-hud.jpg');
  const a = await ev('__sv.state()');
  await touch('touchStart', [[W * .25, H * .6, 1]]); await sleep(50); await touch('touchMove', [[W * .25, H * .6 - 80, 1]]); await sleep(1500);
  const b = await ev('__sv.state()');
  say(Math.hypot(b.cam[0] - a.cam[0], b.cam[1] - a.cam[1], b.cam[2] - a.cam[2]) > 1, 'a finger on the left half flies forward', JSON.stringify(a.cam) + ' -> ' + JSON.stringify(b.cam));
  await touch('touchStart', [[W * .25, H * .6 - 80, 1], [W * .75, H * .5, 2]]); await sleep(50); await touch('touchMove', [[W * .25, H * .6 - 80, 1], [W * .75 + 90, H * .5, 2]]); await sleep(400);
  const c = await ev('__sv.state()');
  say(abs(c.yaw - b.yaw) > .3, 'a second finger on the right half turns the view', b.yaw + ' -> ' + c.yaw);
  await touch('touchEnd', []); await sleep(900);
  const d = await ev('__sv.state()'); await sleep(700); const e = await ev('__sv.state()');
  say(Math.hypot(e.cam[0] - d.cam[0], e.cam[2] - d.cam[2]) < 1, 'lifting the fingers stops the flight', JSON.stringify(d.cam) + ' -> ' + JSON.stringify(e.cam));
  await tap('#mb');
  say((await ev('__sv.state()')).menu, 'the corner button opens the menu');
  await tap('#st2 button');
  s = await ev('__sv.state()'); await sleep(2500);
  say(!s.menu && (await ev('__sv.state()')).world === 1, 'a transistor station in the menu dives in'); await shoot('phone-nano.jpg');
  await tap('#mb'); await tap('#tourb'); await sleep(1500);
  s = await ev('__sv.state()'); say(!s.menu && s.tour, 'the guided tour starts from the menu');
  console.log(bad ? bad + ' FAILED' : 'the phone checks pass');
  flush(); done(bad ? 1 : 0);
}
if (has('ui')) { await sleep(+arg('wait', 1500)); console.log('menu card: content ' + await ev("(c => c.scrollHeight + ' px in a box of ' + c.clientHeight)(document.querySelector('.card'))")); if (has('scroll')) await ev("document.querySelector('.card').scrollTo(0, 1e5)"); await shoot('ui.jpg'); flush(); done(0); }
if (has('at')) {   // free camera positions to try: "x,y,z,yaw,pitch;..."
  let k = 0;
  for (const p of arg('at', '').split(';')) { await ev(`__sv.at(${p})`); await shoot(`at${k++}.jpg`); }
  flush(); done(0);
}
if (has('flicker')) {   // pairs of frames a hair apart (0.02 units, well under a pixel for most of the view) along the tour: tools/flicker.py turns them into a shimmer map
  const n = +arg('flicker', 6), len = await ev('__sv.tour(0)');
  for (let k = 0; k < n; k++) for (const j of [0, 1]) { await ev(`__sv.tour(${(k + .37) * len / n + j * .02})`); await shoot(`fl${k}${'ab'[j]}.png`); }
  flush(); done(0);
}
if (has('clip')) {   // consecutive frames along the tour for a short moving preview: --clip "start second,length,frames per second,speed"
  const [t0, secs, fps, sp] = arg('clip', '6,11,12,4').split(',').map(Number);
  for (let k = 0; k < secs * fps; k++) {
    await ev(`__sv.setT(${+T + k / fps}); __sv.tour(__sv.tourT(${t0 + k * sp / fps}))`);
    await shoot(`clip${String(k).padStart(3, '0')}.jpg`);
  }
  flush(); done(0);
}
if (has('tour')) {   // frames spread evenly along the guided tour
  const n = +arg('tour', 12), dur = await ev('__sv.tourT()');   // evenly spaced in time, as a viewer meets them
  console.log('a lap of the tour takes ' + dur + ' s (plus the dive into the transistor)');
  const dive = (await ev('__sv.state()')).dive;
  let prev = 0;
  for (let k = 0; k < n; k++) {
    const s = await ev(`__sv.tourT(${(k + .5) * dur / n})`), id = String(k).padStart(2, '0');
    if (prev < dive && s >= dive) {   // the tour dives into the transistor here: two frames from inside, then back
      await ev('__sv.pose(9)'); await shoot(`tour${id}a.jpg`); await ev('__sv.pose(8)'); await shoot(`tour${id}b.jpg`); await ev('__sv.world(0)');
    }
    prev = s;
    await ev(`__sv.tour(${s})`); await shoot(`tour${id}c.jpg`);
  }
  flush(); done(0);
}
for (const p of POSES) {
  const f0 = await ev(`__sv.pose(${p - 1}); __sv.frames()`);
  while ((await ev('__sv.frames()')) < f0 + 10) await sleep(50);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `pose${p}${arg('tag', '')}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log('saved ' + file);
}
flush();
done(0);
