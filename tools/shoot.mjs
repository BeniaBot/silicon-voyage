// Renders the world in a separate Chrome with its own empty profile (nothing of the user's is touched)
// and saves screenshots of the stations, or runs the 45 s benchmark flight.
//   node tools/shoot.mjs [--out shots] [--poses 1,2,3] [--q 1] [--t 12] [--w 1600] [--h 900] [--extra "&scale=.75"] [--bench] [--tour 18] [--clip 6,11,12,4] [--headful]
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${SPORT}/index.html?${BENCH ? 'bench' : has('ui') || has('dive') ? 'ui' : 'shot'}&q=${Q}${BENCH || has('dive') ? '' : '&t=' + T}${arg('extra', '')}`;
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
    ['free air in a street', [55, 4, 120]], ['beyond the edge of the board', [20000, 50, 0]]];
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
if (has('dive')) {   // the attract-mode tour must dive into the transistor at its dive point and come back by itself
  const st = await ev('__sv.state()');
  console.log('start', JSON.stringify(st));
  await ev(`__sv.jump(${st.dive - 40})`);
  for (const w of [3, 6, 14, 12]) { await sleep(w * 1000); console.log(JSON.stringify(await ev('__sv.state()'))); }
  flush(); done(0);
}
if (has('ui')) { await sleep(+arg('wait', 1500)); await shoot('ui.jpg'); flush(); done(0); }
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
