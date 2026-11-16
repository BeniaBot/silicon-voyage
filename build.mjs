// Builds the single-file index.html: the sources share one async scope, the WGSL is squeezed, esbuild minifies the rest.
//   node build.mjs          minified
//   node build.mjs --dev    readable (shader line numbers in errors stay meaningful)
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { transformSync } from 'esbuild';

const FILES = ['quality.js', 'math.js', 'world.js', 'shaders.js', 'nano.js', 'audio.js', 'main.js'];
const dev = process.argv.includes('--dev');
const read = f => readFileSync(new URL('src/' + f, import.meta.url), 'utf8');

// WGSL inside /*wgsl*/`...`: drop comments, collapse whitespace, remove spaces around punctuation (not inside ${...})
const squeeze = s => s.split(/(\$\{[^}]*\})/).map((p, i) => i & 1 ? p : p
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\s+/g, ' ')
  .replace(/ ?([{}()[\],;:=<>+\-*/&|!?.@%^]) ?/g, '$1')).join('').trim();

let src = FILES.map(read).join('\n');
if (!dev) src = src.replace(/\/\*wgsl\*\/`([^`]*)`/g, (_, s) => '`' + squeeze(s) + '`');
const wrapped = `(async()=>{\n${src}\n})().catch(e=>{console.error(e);const t=document.getElementById('ldt');` +
  `const en=document.documentElement.dir==='ltr';if(t)t.textContent=e&&e.message==='nogpu'?(en?'This browser has no WebGPU. Try a recent Chrome or Edge.':'הדפדפן הזה לא תומך ב־WebGPU. נסו את Chrome או Edge בגרסה עדכנית.'):(en?'Something failed while loading. Reload the page.':'משהו נכשל בטעינה. רעננו את הדף.')})`;
const js = transformSync(wrapped, { minify: !dev, target: 'es2022', legalComments: 'none', charset: 'utf8' }).code;
const html = read('template.html').replace('/*SCRIPT*/', () => js.replace(/<\/script/gi, '<\\/script'));
writeFileSync(new URL('index.html', import.meta.url), html);
const b = Buffer.byteLength(html);
console.log(`index.html: ${(b / 1024).toFixed(1)} KB (${b} bytes), gzip ${(gzipSync(html).length / 1024).toFixed(1)} KB${dev ? ' [dev]' : ''}`);
