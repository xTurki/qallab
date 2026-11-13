// End-to-end tests: serves the app, drives it in headless Chrome over the DevTools protocol, and checks real conversions.
// No dependencies. Usage:  node tests/run.mjs          (Node 22+, Chrome or Edge installed)
//   CHROME=/path/to/chrome   use a specific browser
//   HEIC=/path/to/photo.heic also test HEIC decoding (no sample is shipped with the repo)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, extname, resolve, dirname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- static server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p)); if (!file.startsWith(ROOT)) throw new Error('outside root');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

/* ---------- browser ---------- */
const chrome = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!chrome) { console.error('Chrome not found. Set CHROME=/path/to/chrome'); process.exit(2); }
const profile = mkdtempSync(join(tmpdir(), 'qallab-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let port = 0;
for (let i = 0; i < 80 && !port; i++) { try { port = +readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(250); } }
let ws;
for (let i = 0; i < 40 && !ws; i++) { try { const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); if (t) ws = new WebSocket(t.webSocketDebuggerUrl); } catch { await sleep(250); } }
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map(), pageErrors = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push('exception: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 300));
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push('console.error: ' + d.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'EVAL-ERROR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const key = async (k, code) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code }); };
let failed = 0;
const T = (name, v, info) => { if (v !== true) failed++; console.log((v === true ? 'PASS  ' : 'FAIL  ') + name + (v === true ? (info ? '   [' + info + ']' : '') : '   -> ' + JSON.stringify(v ?? null).slice(0, 400))); };

/* ---------- helpers injected into the page ---------- */
const HELPERS = `
window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => __csp.push(e.violatedDirective + ' ' + e.blockedURI));
window.wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.mk = (w, h, name, noise) => new Promise((r) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  if (noise) { const d = x.createImageData(w, h); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255; } x.putImageData(d, 0, 0); }
  else { const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#3a8'); g.addColorStop(1, '#124'); x.fillStyle = g; x.fillRect(0, 0, w, h); x.fillStyle = '#fc5'; x.beginPath(); x.arc(w * .7, h * .3, Math.min(w, h) * .15, 0, 7); x.fill(); }
  c.toBlob((b) => r(new File([b], name, { type: 'image/png' })), 'image/png');
});
window.pdfLib = async () => { if (!window.PDFLib) await loadScript('lib/pdf-lib.min.js'); return PDFLib; };
window.mkPdf = async (name, pages = 2, withPhoto = false) => {
  const { PDFDocument, StandardFonts } = await pdfLib(); const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
  let img = null;
  if (withPhoto) { const c = document.createElement('canvas'); c.width = 2400; c.height = 1800; const x = c.getContext('2d'); const id = x.createImageData(2400, 1800);
    for (let i = 0; i < id.data.length; i += 4) { const v = (i / 4 % 2400) / 10 + Math.random() * 60; id.data[i] = v; id.data[i + 1] = 255 - v; id.data[i + 2] = Math.random() * 255; id.data[i + 3] = 255; } x.putImageData(id, 0, 0);
    img = await d.embedJpg(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95))).arrayBuffer()); }
  for (let i = 1; i <= pages; i++) { const p = d.addPage([595.28, 841.89]); p.drawText('Hello page ' + i, { x: 60, y: 760, size: 26, font: f }); if (img) p.drawImage(img, { x: 60, y: 300, width: 400, height: 300 }); }
  return new File([await d.save()], name, { type: 'application/pdf' });
};
window.textOf = async (blob) => { const pdf = await openPdf(new Uint8Array(await blob.arrayBuffer())); let s = ''; for (let i = 1; i <= pdf.numPages; i++) s += (await (await pdf.getPage(i)).getTextContent()).items.map((t) => t.str).join(' '); const n = pdf.numPages; pdf.destroy(); return { text: s, pages: n }; };
window.dimsOf = async (blob) => { const b = await createImageBitmap(blob); const r = b.width + 'x' + b.height; b.close(); return r; };
window.set = (id, v) => { $(id).value = v; $(id).dispatchEvent(new Event('change')); };
window.conv = async (t) => { state.target = t; renderTargets(); syncOptions(); await run(); return { n: state.results.length, names: state.results.map((r) => r.name), dims: state.results.map((r) => (r.w || 0) + 'x' + (r.h || 0)), sizes: state.results.map((r) => r.blob.size), status: $('status').textContent, ok: $('status').className.includes('ok') }; };
window.reset = () => { state.files = []; renderQueue(); syncOptions(); clearResults(); for (const id of ['tsize', 'maxdim']) set(id, '0'); set('pdfc', 'none'); set('pngc', 'best'); $('merge').checked = true; };
`;
const open = async (path = 'index.html') => { await send('Page.navigate', { url: BASE + path }); await sleep(1500); await ev(HELPERS); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
let r;

try {
  /* ===== security and start-up ===== */
  await open();
  T('CSP is declared', await ev(`!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`));
  T('CSP blocks a connection to another site', await ev(`fetch('https://example.com/').then(() => 'NOT BLOCKED', () => true)`));
  T('CSP blocks loading an image from another site', await ev(`new Promise((r) => { const i = new Image(); i.onload = () => r('LOADED'); i.onerror = () => r(true); i.src = 'https://example.com/x.png?leak=1'; })`));
  T('no library is loaded until it is needed', await ev(`['pdfjsLib', 'PDFLib', 'UTIF', 'JSZip', 'heic2any', 'pako'].every((k) => typeof window[k] === 'undefined')`));
  r = await ev(`(() => { const q = $('quality'), bg = () => getComputedStyle(q).backgroundImage; const before = bg(); q.value = 55; q.dispatchEvent(new Event('input')); const after = bg(); const out = $('qOut').textContent; q.value = 90; q.dispatchEvent(new Event('input')); return { before, after, out, p: q.style.getPropertyValue('--p') }; })()`);
  T('quality slider: the blue fill follows the value', r.before !== r.after && r.out === '55%' && /gradient/.test(r.after) ? true : r);
  T('file names cannot inject markup', await ev(`extOf('x.<b>') === 'B' && extOf('a.p<i') === 'PI'`));
  await ev(`__csp.length = 0`); pageErrors.length = 0;

  /* ===== conversions ===== */
  await ev(`(async () => { addFiles([await mk(1200, 800, 'a.png'), await mk(800, 1200, 'b.png'), await mkPdf('doc.pdf')]); await wait(1200); })()`);
  T('drop zone collapses once files are added', await ev(`$('drop').classList.contains('compact')`));
  T('list thumbnails are small generated copies', await ev(`[...document.querySelectorAll('#queue .thumb')].slice(0, 2).every((t) => t.style.backgroundImage.startsWith('url("data:image/png'))`));
  r = await ev(`conv('jpg')`); T('images + PDF -> JPG', r.n === 4 && r.ok ? true : r);
  r = await ev(`conv('pdf')`); T('everything merged into one PDF', r.n === 1 && r.ok ? true : r);
  r = await ev(`textOf(state.results[0].blob)`); T('merged PDF has 4 pages and keeps the text of the PDF input', r.pages === 4 && /Hello page 2/.test(r.text) ? true : r);
  r = await ev(`conv('webp')`); T('-> WEBP', r.n === 4 && r.ok ? true : r);
  r = await ev(`conv('bmp')`); T('-> BMP', r.n === 4 && r.ok && r.sizes[0] === 54 + 1200 * 800 * 3 ? true : r);
  r = await ev(`conv('ico')`); T('-> ICO (256 px square)', r.n === 4 && r.ok && r.dims[0] === '256x256' ? true : r);

  r = await ev(`(async () => { const c = await conv('tiff'); await need('tiff'); const buf = await state.results[0].blob.arrayBuffer(); const ifd = UTIF.decode(buf)[0]; UTIF.decodeImage(buf, ifd); const px = UTIF.toRGBA8(ifd);
    const src = await createImageBitmap(state.files[0].file), cv = toCanvas(src, 1200, 800), ref = cv.getContext('2d').getImageData(0, 0, 1200, 800).data; let diff = 0; for (let i = 0; i < ref.length; i += 997) diff += Math.abs(ref[i] - px[i]);
    return { ...c, w: ifd.width, h: ifd.height, diff, raw: 1200 * 800 * 4 }; })()`);
  T('-> TIFF (Deflate) decodes back to the same pixels', r.n === 4 && r.w === 1200 && r.h === 800 && r.diff === 0 ? true : r, `${r.sizes?.[0]} bytes vs ${r.raw} uncompressed`);

  r = await ev(`(async () => { const c = await conv('gif'); return { ...c, real: await dimsOf(state.results[0].blob) }; })()`);
  T('-> GIF (adaptive palette) decodes', r.n === 4 && r.real === '1200x800' ? true : r);

  r = await ev(`(async () => { set('pngc', 'fast'); const fast = await conv('png'); set('pngc', 'best'); const best = await conv('png'); const bestDims = await dimsOf(state.results[0].blob); set('pngc', '256'); const q = await conv('png'); const qDims = await dimsOf(state.results[0].blob); set('pngc', 'best');
    return { fast: fast.sizes[0], best: best.sizes[0], q: q.sizes[0], bestDims, qDims }; })()`);
  T('PNG "smallest lossless" is never larger than the browser encoder', r.best <= r.fast && r.bestDims === '1200x800' ? true : r, `${r.fast} -> ${r.best} bytes`);
  T('PNG "256 colours" is smaller again and still decodes', r.q < r.best && r.qDims === '1200x800' ? true : r, `${r.best} -> ${r.q} bytes`);

  T('ZIP of all results builds', await ev(`(async () => { await need('zip'); const z = new JSZip(); for (const x of state.results) z.file(x.name, x.blob); return (await z.generateAsync({ type: 'blob' })).size > 1000; })()`));

  /* ===== size limit ===== */
  await ev(`reset()`);
  r = await ev(`(async () => { addFiles([await mk(3000, 2000, 'noise.png', true)]); const free = await conv('jpg'); set('tsize', '204800'); const lim = await conv('jpg'); set('tsize', '0'); return { free: free.sizes[0], lim: lim.sizes[0], dims: lim.dims[0], status: lim.status }; })()`);
  T('maximum file size is respected (200 KB)', r.lim <= 204800 && r.free > 204800 ? true : r, `${r.free} -> ${r.lim} bytes, ${r.dims}`);
  r = await ev(`(async () => { set('tsize', '512000'); const c = await conv('pdf'); set('tsize', '0'); return c; })()`);
  T('maximum file size also applies to a PDF built from images', r.n === 1 && r.sizes[0] <= 512000 ? true : r, `${r.sizes?.[0]} bytes`);

  /* ===== PDF compression ===== */
  await ev(`reset()`);
  r = await ev(`(async () => { const f = await mkPdf('scan.pdf', 3, true); addFiles([f]); await wait(600); set('pdfc', 'smart'); set('maxdim', '1280'); const c = await conv('pdf'); const t = await textOf(state.results[0].blob); return { ...c, src: f.size, text: t.text, pages: t.pages }; })()`);
  T('smart PDF compression shrinks the file', r.n === 1 && r.sizes[0] < r.src * 0.7 ? true : r, `${r.src} -> ${r.sizes?.[0]} bytes`);
  T('smart PDF compression keeps pages and selectable text', r.pages === 3 && /Hello page 3/.test(r.text) ? true : r);
  r = await ev(`(async () => { set('pdfc', 'strong'); set('maxdim', '0'); const c = await conv('pdf'); const t = await textOf(state.results[0].blob); set('pdfc', 'none'); return { ...c, src: state.files[0].file.size, text: t.text, pages: t.pages }; })()`);
  T('strong PDF compression rasterises pages and shrinks the file', r.n === 1 && r.pages === 3 && r.sizes[0] < r.src && !/Hello/.test(r.text) ? true : r, `${r.src} -> ${r.sizes?.[0]} bytes`);

  /* ===== cancel ===== */
  await ev(`reset()`);
  r = await ev(`(async () => { addFiles([await mk(3200, 3200, 'big.png', true), await mk(600, 400, 'small.png')]); state.target = 'gif'; renderTargets(); syncOptions(); const p = run(); await wait(250); const shown = !$('cancelBtn').hidden; $('cancelBtn').click(); await p;
    return { shown, status: $('status').textContent, busy: state.busy, cancelHidden: $('cancelBtn').hidden }; })()`);
  T('cancel stops a running conversion', r.shown && /أُلغي/.test(r.status) && !r.busy && r.cancelHidden ? true : r);
  r = await ev(`(async () => { state.files = state.files.slice(1); renderQueue(); return await conv('gif'); })()`);
  T('the app converts again after a cancel', r.n === 1 && r.ok ? true : r);

  /* ===== HEIC (optional) ===== */
  if (process.env.HEIC && existsSync(process.env.HEIC)) {
    await ev(`reset()`);
    r = await ev(`(async () => { const bin = atob(${JSON.stringify(readFileSync(process.env.HEIC).toString('base64'))}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); addFiles([new File([u], 'photo.heic', { type: 'image/heic' })]); return await conv('jpg'); })()`);
    T('HEIC -> JPG under the CSP', r.n >= 1 && r.ok ? true : r, r.dims?.[0]);
  } else console.log('SKIP  HEIC (set HEIC=/path/to/file.heic)');

  /* ===== interface ===== */
  await ev(`reset()`);
  await ev(`state.target = 'pdf'; renderTargets(); $('targets').querySelector('[aria-checked="true"]').focus();`);
  await key('ArrowLeft', 37);
  T('arrow keys move the format selection', await ev(`state.target === 'jpg' && document.activeElement.getAttribute('aria-checked') === 'true' && $('targets').querySelectorAll('[tabindex="0"]').length === 1`));
  await ev(`(async () => { addFiles([await mk(1200, 800, 'a.png')]); await wait(300); document.querySelector('.editbtn').focus(); document.querySelector('.editbtn').click(); await wait(900); })()`);
  T('editor: focus moves into the sheet and the page behind is inert', await ev(`document.activeElement.id === 'edCancel' && document.querySelector('.wrap').inert === true`));
  T('editor: canvas fits its stage', await ev(`$('edCanvas').getBoundingClientRect().width <= $('stage').clientWidth - 20`));
  await ev(`closeEditor()`);
  T('editor: closing gives focus back and re-enables the page', await ev(`document.activeElement.classList.contains('editbtn') && !document.querySelector('.wrap').inert`));
  await sleep(500);
  T('editor: hidden after the closing animation', await ev(`$('editor').hidden === true`));
  // drag the grabber down to dismiss
  await ev(`document.querySelector('.editbtn').click()`); await sleep(900);
  r = await ev(`(() => { const g = $('editor').querySelector('.grabber').getBoundingClientRect(); return { x: g.left + g.width / 2, y: g.top + g.height / 2 }; })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  for (let i = 1; i <= 8; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x, y: r.y + i * 30 }] }); await sleep(16); }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(600);
  T('sheet closes when the grabber is dragged down', await ev(`$('editor').hidden === true && !document.querySelector('.wrap').inert`));

  /* ===== viewer ===== */
  await ev(`reset()`);
  r = await ev(`(async () => { addFiles([await mkPdf('long.pdf', 40)]); await wait(600); await conv('pdf'); openViewer(0); await wait(2500); const cs = [...document.querySelectorAll('#vBody canvas')]; return { total: cs.length, drawn: cs.filter((c) => c.dataset.state === 'done').length, focus: document.activeElement.id }; })()`);
  T('viewer: focus lands on the close button', r.focus === 'vClose' ? true : r);
  T('viewer: a 40-page PDF only draws the pages near the screen', r.total === 40 && r.drawn >= 1 && r.drawn < 15 ? true : r, `${r.drawn} of ${r.total} drawn`);
  r = await ev(`(async () => { $('vBody').scrollTop = $('vBody').scrollHeight; await wait(2500); const cs = [...document.querySelectorAll('#vBody canvas')]; return { last: cs[39].dataset.state, first: cs[0].dataset.state, firstW: cs[0].width }; })()`);
  T('viewer: scrolling draws later pages and releases the first ones', r.last === 'done' && r.first === 'idle' && r.firstW === 1 ? true : r);
  await ev(`closeViewer()`); await sleep(400);

  /* ===== Android share target (service worker) ===== */
  await ev(`navigator.serviceWorker.ready`); await sleep(800); await open();
  r = await ev(`(async () => { if (!navigator.serviceWorker.controller) return 'no controller'; const fd = new FormData(); fd.append('files', await mk(640, 480, 'shared.png')); const res = await fetch('./share', { method: 'POST', body: fd }); return { url: res.url.split('/').pop(), ok: res.ok }; })()`);
  T('share target: the service worker accepts the shared file', r.ok && r.url === '?shared' ? true : r);
  await open('?shared'); await sleep(800);
  r = await ev(`(async () => ({ files: state.files.map((f) => f.file.name + ':' + f.file.type), url: location.search, left: (await caches.keys()).includes('qallab-share') }))()`);
  T('share target: the file is in the list and the temporary copy is deleted', r.files?.[0] === 'shared.png:image/png' && r.url === '' && r.left === false ? true : r);
  T('offline: the app shell and worker are cached', await ev(`(async () => { const c = await caches.open((await caches.keys()).find((k) => k.startsWith('qallab-v'))); const keys = (await c.keys()).map((q) => q.url.split('/').slice(3).join('/')); return ['worker.js', 'lib/UPNG.js', 'app.js', 'index.html', 'icons/icon-180.png'].every((f) => keys.includes(f)) || keys; })()`));

  const csp = await ev(`__csp`);
  T('no Content-Security-Policy violations during the run', Array.isArray(csp) && csp.length === 0 ? true : csp);

  /* ===== iPhone: canvas area limit ===== */
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone' });
  await open('index.html?ios');
  T('iPhone is detected and capped at 16.7 MP', await ev(`IS_IOS === true && MAX_AREA === 16777216`));
  r = await ev(`(async () => { addFiles([await mk(6000, 4000, 'big24mp.png')]); return await conv('jpg'); })()`);
  { const [w, h] = (r.dims?.[0] || '0x0').split('x').map(Number);
    T('a 24 MP photo is scaled under the cap with its ratio kept', w * h <= 16777216 && w * h > 16e6 && Math.abs(w / h - 1.5) < 0.01 && /صُغّرت/.test(r.status) ? true : r, r.dims?.[0]); }
  r = await ev(`(async () => { reset(); addFiles([await mkPdf('doc.pdf')]); await wait(600); set('dpi', '600'); return await conv('png'); })()`);
  T('a PDF page at 600 dpi is capped on iPhone', Array.isArray(r.dims) && r.dims.every((d) => { const [a, b] = d.split('x').map(Number); return a * b <= 16777216 && a > 3000; }) ? true : r, r.dims?.[0]);

  T('no page errors', pageErrors.length === 0 ? true : [...new Set(pageErrors)]);
} catch (e) { failed++; console.error('TEST RUN CRASHED:', e); }

ws.close(); proc.kill(); server.close();
await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold the folder */ }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
