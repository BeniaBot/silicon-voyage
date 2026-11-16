// ============================================================================
// audio: the chip's sound, synthesized live from oscillators and noise (no sample files)
// ============================================================================
// Built on the first click or key; a 10 Hz timer drives it, not the frame loop. Layers: a low hum, a slow pad,
// the clock tick (in step with the flash of the clock tree), data chirps, a buzz near the power grid,
// a whoosh when the AI array's wave passes, and rushing air when moving fast.
let AC = null, OUT = null, MUTED = false, BUSY = 1, NEAR_AI = 0;
const VOL = 1.5;
function mkAudio(ac, live = true) {
  const sr = ac.sampleRate;
  if (live) AC = ac;
  const N = (C, o, ...to) => { const n = new C(ac, o); for (const d of to) n.connect(d); if (n.start) n.start(); return n; };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const O = (type, frequency, ...to) => N(OscillatorNode, { type, frequency }, ...to);
  const buf = (secs, ch, f) => {
    const b = new AudioBuffer({ length: sr * secs | 0, numberOfChannels: ch, sampleRate: sr });
    for (let c = 0; c < ch; c++) f(b.getChannelData(c));
    return b;
  };
  rseed(4242);
  // reverb: four seconds of noise that fades and darkens
  const ir = buf(4, 2, d => { let b = 0; for (let i = 0; i < d.length; i++) { const t = i / sr; b += (rnd() * 2 - 1 - b) * (.06 + .6 * exp(-t * 3)); d[i] = b * exp(-t * 1.5) * (1 - exp(-t * 50)); } });
  const nb = buf(5, 1, d => { for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; });
  const lim = N(DynamicsCompressorNode, { threshold: -8, knee: 6, ratio: 16, attack: .003, release: .25 }, ac.destination);
  const out = G(0, lim), wet = N(ConvolverNode, { buffer: ir }, G(.7, out));
  if (live) OUT = out;
  // hum: two saws a hair apart (a slow beat) and a fifth, through a lowpass that breathes
  const hum = G(.045, out, G(.5, wet)), hf = BQ('lowpass', 170, 3, hum);
  O('sawtooth', 55, hf); O('sawtooth', 55.31, hf); O('sine', 82.41, G(.5, hum));
  O('sine', .043, G(70, hf.frequency));
  // pad: A minor add 9, each note two detuned triangles, each swelling at its own slow rate
  const pad = G(0, wet, G(.25, out));
  [110, 164.81, 246.94, 261.63, 329.63].forEach((f, i) => {
    const g = G(.016, pad); O('triangle', f, g); O('triangle', f * 1.003, g); O('sine', .03 + i * .011, G(.012, g.gain));
  });
  pad.gain.setTargetAtTime(1, ac.currentTime, 6);
  const buzz = G(0, out); O('sawtooth', 120, BQ('bandpass', 360, 4, buzz));
  const rush = G(0, out), rf = BQ('bandpass', 300, .9, rush);
  N(AudioBufferSourceNode, { buffer: nb, loop: true }, rf);
  // pooled voices: oscillator -> envelope -> pan -> dry and reverb
  const pool = (n, send, type) => Array.from({ length: n }, () => {
    const p = N(StereoPannerNode, {}, out, G(send, wet)), g = G(0, p);
    return { p, g, o: O(type, 440, g) };
  });
  const chirp = pool(6, .45, 'sine'), tick = pool(3, .25, 'sine'), thump = pool(2, .2, 'sine'), wave = pool(2, .8, 'triangle');
  // one note: pitch glides f0 -> f1 over dur, level rises to vol in att and dies away
  const play = (vs, t, f0, f1, dur, vol, att = .004, pan = rr(-.6, .6)) => {
    const v = vs.shift(); vs.push(v);
    v.p.pan.setValueAtTime(pan, t);
    v.o.frequency.setValueAtTime(f0, t); v.o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(0, t);
    v.g.gain.linearRampToValueAtTime(vol, t + att); v.g.gain.setTargetAtTime(0, t + att, dur / 4);
  };
  const PENT = [0, 3, 5, 7, 10];
  let lt = ac.currentTime, lx = cam[0], ly = cam[1], lz = cam[2], nextChirp = lt + 1, lastClk = 0, lastWave = -1;
  out.gain.setTargetAtTime(MUTED && live ? 0 : VOL, lt, 1.2);
  return () => {
    const now = ac.currentTime, t = now + .05, dt = now - lt;
    if (dt <= 0) return;
    let v = hypot(cam[0] - lx, cam[1] - ly, cam[2] - lz) / dt; if (v > 80) v = 0;   // ignore jumps to a station
    lt = now; lx = cam[0]; ly = cam[1]; lz = cam[2];
    rush.gain.setTargetAtTime(.3 * min(v / 30, 1) ** 1.3, t, .25); rf.frequency.setTargetAtTime(200 + v * 22, t, .25);
    const nano = live && WORLD, inDie = !nano && max(abs(cam[0]), abs(cam[2])) < 200;
    hum.gain.setTargetAtTime(nano ? .018 : .045, t, .8);
    buzz.gain.setTargetAtTime(inDie ? .028 * exp(-(((cam[1] - 32) / 6) ** 2)) : 0, t, .3);
    // the clock: a soft tick and a low thump at the moment the flash leaves the root
    const wt = live ? T : now, tn = now + (CLKT - wt % CLKT);
    if (tn - now < .16 && tn - lastClk > CLKT * .5) {
      lastClk = tn;
      play(tick, tn, 2300, 1500, .05, nano ? .02 : .045, .002, 0); play(thump, tn, 92, 46, .14, nano ? .05 : .11, .003, 0);
      if (nano) play(wave, tn, 330, 495, 1.1, .05, .25, 0);   // the gate opens: a rising breath as the electrons pour in
    }
    if (t > nextChirp) {   // data chirps: short pentatonic bleeps, busier where the chip is busy
      let tt = t;
      for (let n = 1 + (rnd() * 3 | 0); n--;) {
        const f = (nano ? 1760 : 880) * 2 ** ((PENT[rnd() * 5 | 0] + 12 * (rnd() * 2 | 0)) / 12);
        play(chirp, tt, f, f * rr(.98, 1.06), nano ? .5 : .07, nano ? .012 : .02); tt += rr(.06, .12);
      }
      nextChirp = tt + rr(.4, 2.6) / BUSY;
    }
    const w = floor((wt + 1.2) / 4);   // the AI array's wave crosses the middle of the array
    if (!nano && NEAR_AI > .05 && w !== lastWave) { lastWave = w; play(wave, t + .1, 196, 294, 1.6, .06 * NEAR_AI, .3, 0); }
  };
}
// called on every click or key: builds the graph once, resumes it when the browser allows
function sound() {
  if (!AC) { try { setInterval(mkAudio(new AudioContext({ latencyHint: 'playback' })), 100); } catch (e) { console.warn(e); return; } }
  if (AC.state === 'suspended' && !document.hidden) AC.resume();
}
const setMute = m => { MUTED = m; if (OUT) OUT.gain.setTargetAtTime(m ? 0 : VOL, AC.currentTime, .1); };
document.addEventListener('visibilitychange', () => { if (AC) document.hidden ? AC.suspend() : AC.resume(); });

// dev hook: renders the first seconds offline and measures them, so the mix is balanced by numbers and not by guessing
async function audioStats(secs = 14) {
  const sr = 44100, oc = new OfflineAudioContext(2, sr * secs, sr), tick = mkAudio(oc, false);
  for (let t = .1; t < secs; t += .1) oc.suspend(t).then(() => { tick(); oc.resume(); });
  const b = await oc.startRendering(), d = b.getChannelData(0), e = b.getChannelData(1);
  let pk = 0, sq = 0, n = 0;
  for (let i = sr * 6; i < d.length; i++) { pk = max(pk, abs(d[i]), abs(e[i])); sq += d[i] * d[i] + e[i] * e[i]; n += 2; }
  const db = x => +(20 * Math.log10(x)).toFixed(1);
  return { rms: db(sqrt(sq / n)), peak: db(pk) };
}
