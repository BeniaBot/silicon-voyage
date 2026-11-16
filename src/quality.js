// ============================================================================
// quality: three detail levels (0 high, 1 medium, 2 low)
// ============================================================================
// The menu choice is remembered. If the last load never finished (a crash or a hang), the next one starts a level lower.
// Dev hooks in the address: ?q=0..2  ?shot (no UI, for screenshots)  ?pose=1..7  ?t=seconds (frozen time)  ?scale=0.5..1  ?bench
const QS = new URLSearchParams(location.search);
// language: Hebrew or English. ?lang= wins, then the choice saved from the menu, then the browser's own language.
let HE = true;
try { HE = (QS.get('lang') || localStorage.getItem('sv-lang') || navigator.language || 'he').startsWith('he'); } catch {}
const tr = (he, en) => HE ? he : en;
if (!HE) {   // the page is written in Hebrew; English text waits in data-en attributes
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; document.title = 'Silicon Voyage';
  for (const e of document.querySelectorAll('[data-en]')) e.innerHTML = e.dataset.en;
}
let LV = 1;
try {
  const s = localStorage.getItem('sv-q');
  LV = s !== null ? +s : matchMedia('(pointer:coarse)').matches ? 2 : 1;
  if (localStorage.getItem('sv-loading')) LV++;
  localStorage.setItem('sv-loading', '1');
} catch {}
if (QS.has('q')) LV = +QS.get('q');
LV = Math.max(0, Math.min(2, LV | 0));
const AA = LV > 1 ? 1 : 4;               // MSAA samples
const SHADOW = LV ? 2048 : 4096;         // shadow map size (baked once)
const MOTES = [12000, 8000, 4000][LV];  // floating specks
const RAYS = LV < 2, RAYDIV = LV ? 4 : 2, RAYN = LV ? 14 : 22;   // light shafts: on/off, resolution divisor, steps
const CULLPX = [1.6, 2.2, 3][LV];      // boxes whose middle size is under this many pixels are not drawn
const SMAX = [1, .9, .75][LV];           // top render scale for the dynamic resolution
