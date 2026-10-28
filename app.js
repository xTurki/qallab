'use strict';
const $ = (id) => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const TARGETS = [
  { key: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  { key: 'jpg', label: 'JPG', ext: 'jpg', mime: 'image/jpeg' },
  { key: 'png', label: 'PNG', ext: 'png', mime: 'image/png' },
  { key: 'webp', label: 'WEBP', ext: 'webp', mime: 'image/webp' },
  { key: 'avif', label: 'AVIF', ext: 'avif', mime: 'image/avif' },
  { key: 'bmp', label: 'BMP', ext: 'bmp', mime: 'image/bmp' },
  { key: 'tiff', label: 'TIFF', ext: 'tiff', mime: 'image/tiff' },
  { key: 'ico', label: 'ICO', ext: 'ico', mime: 'image/x-icon' },
  { key: 'gif', label: 'GIF', ext: 'gif', mime: 'image/gif' },
];

const state = { files: [], target: 'pdf', results: [], busy: false };
let uid = 0;

/* ---------- capability check: can this browser encode WEBP / AVIF from canvas? ---------- */
function canEncode(mime) {
  try { const c = document.createElement('canvas'); c.width = c.height = 2; return c.toDataURL(mime).startsWith('data:' + mime); }
  catch { return false; }
}
const ENCODABLE = { webp: canEncode('image/webp'), avif: canEncode('image/avif') };

/* ---------- target buttons ---------- */
function renderTargets() {
  const box = $('targets'); box.innerHTML = '';
  for (const t of TARGETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = t.label;
    if (t.key === 'pdf') b.className = 'pdf';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.target === t.key));
    if (t.key in ENCODABLE && !ENCODABLE[t.key]) { b.disabled = true; b.title = 'متصفحك لا يدعم الحفظ بهذه الصيغة'; }
    b.onclick = () => { state.target = t.key; renderTargets(); syncOptions(); };
    box.appendChild(b);
  }
}

function syncOptions() {
  const t = state.target;
  const hasPdfIn = state.files.some((f) => f.kind === 'pdf');
  const show = {
    quality: ['jpg', 'webp', 'avif', 'pdf'].includes(t),
    dpi: hasPdfIn && t !== 'pdf',
    page: t === 'pdf',
    merge: t === 'pdf' && state.files.length > 1,
    bg: ['jpg', 'bmp', 'pdf', 'gif'].includes(t),
    maxdim: t !== 'ico',
    pdfc: t === 'pdf' && hasPdfIn,
  };
  $('pdfcNote').hidden = $('pdfc').value === 'none';
  document.querySelectorAll('.opt').forEach((el) => { el.hidden = !show[el.dataset.for]; });
  const go = $('goBtn');
  go.disabled = !state.files.length || state.busy;
  const label = TARGETS.find((x) => x.key === t).label;
  go.textContent = state.busy ? 'جارٍ التحويل…' : state.files.length ? `حوّل ${state.files.length === 1 ? 'الملف' : state.files.length + ' ملفات'} إلى ${label}` : 'أضف ملفات أولاً';
}

/* ---------- file intake ---------- */
function kindOf(file) {
  const n = file.name.toLowerCase();
  if (file.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/\.(heic|heif)$/.test(n) || /heic|heif/.test(file.type)) return 'heic';
  if (/\.tiff?$/.test(n) || file.type === 'image/tiff') return 'tiff';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico|jfif)$/.test(n)) return 'image';
  return null;
}
const extOf = (name) => (name.split('.').pop() || '').toUpperCase().slice(0, 4);
const baseOf = (name) => name.replace(/\.[^.]+$/, '') || 'file';
function fmtSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }

function addFiles(list) {
  let skipped = 0;
  for (const file of list) {
    const kind = kindOf(file);
    if (!kind) { skipped++; continue; }
    const item = { id: ++uid, file, kind, thumb: null };
    if (kind === 'image') item.thumb = URL.createObjectURL(file);
    state.files.push(item);
    if (kind === 'pdf') probePdf(item);
  }
  renderQueue(); syncOptions();
  setStatus(skipped ? `تم تجاهل ${skipped} ملف بصيغة غير مدعومة.` : '', skipped ? 'err' : '');
}

function renderQueue() {
  $('queueSec').hidden = !state.files.length;
  $('count').textContent = state.files.length ? `(${state.files.length})` : '';
  const ul = $('queue'); ul.innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    const th = document.createElement('div'); th.className = 'thumb';
    const tsrc = f.editThumb || f.thumb;
    if (tsrc) th.style.backgroundImage = `url("${tsrc}")`; else th.textContent = extOf(f.file.name);
    const meta = document.createElement('div'); meta.className = 'meta';
    let extra = '';
    if (f.kind === 'pdf' && f.info) {
      const paper = paperName(f.info.w, f.info.h);
      extra = ` · ${f.info.pages} ${f.info.pages === 1 ? 'صفحة' : 'صفحات'}${paper ? ' · ' + paper : ''}`;
    }
    if (f.edit && f.editDims) extra += ` <span class="tag edited">معدّلة · <span class="num">${f.editDims.w}×${f.editDims.h}</span></span>`;
    meta.innerHTML = `<span class="name"></span><span class="small"><span class="tag">${extOf(f.file.name)}</span><span class="num">${fmtSize(f.file.size)}</span>${extra}</span>`;
    meta.querySelector('.name').textContent = f.file.name;
    li.append(th, meta);
    if (f.kind !== 'pdf') {
      const eb = document.createElement('button'); eb.className = 'editbtn'; eb.type = 'button'; eb.textContent = 'قص وتحجيم';
      eb.onclick = () => openEditor(f); li.appendChild(eb);
    }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'إزالة ' + f.file.name);
    x.onclick = () => { if (f.thumb) URL.revokeObjectURL(f.thumb); state.files = state.files.filter((g) => g !== f); renderQueue(); syncOptions(); updateDpiLabels(); };
    li.append(x); ul.appendChild(li);
  }
}

/* ---------- decoding: every input becomes one or more canvases ---------- */
function loadImg(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('تعذّر قراءة الصورة')); i.src = url; });
}
function toCanvas(src, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h); return c;
}
async function blobToCanvas(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImg(url);
    let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024; // SVG without size falls back to 1024
    return toCanvas(img, w, h);
  } finally { URL.revokeObjectURL(url); }
}
let heicLoading = null;
function loadHeic() {
  if (window.heic2any) return Promise.resolve();
  return heicLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'lib/heic2any.min.js'; s.onload = res; s.onerror = () => rej(new Error('تعذّر تحميل قارئ HEIC')); document.head.appendChild(s);
  });
}

async function* decode(item, dpi) {
  const { file, kind } = item;
  if (kind === 'pdf') {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      yield { canvas: c, page: p, pages: pdf.numPages };
    }
    return;
  }
  if (kind === 'tiff') {
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf).filter((d) => d.t256);
    for (let i = 0; i < ifds.length; i++) {
      UTIF.decodeImage(buf, ifds[i]);
      const rgba = UTIF.toRGBA8(ifds[i]); const w = ifds[i].width, h = ifds[i].height;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), w, h), 0, 0);
      yield { canvas: c, page: i + 1, pages: ifds.length };
    }
    return;
  }
  if (kind === 'heic') {
    await loadHeic();
    let out = await heic2any({ blob: file, toType: 'image/png' });
    out = Array.isArray(out) ? out : [out];
    for (let i = 0; i < out.length; i++) yield { canvas: await blobToCanvas(out[i]), page: i + 1, pages: out.length };
    return;
  }
  yield { canvas: await blobToCanvas(file), page: 1, pages: 1 };
}

/* ---------- encoders ---------- */
function flatten(canvas, bg) {
  const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(canvas, 0, 0); return c;
}
const canvasBlob = (c, mime, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('فشل الترميز'))), mime, q));

function encodeBMP(c) {
  const w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h, buf = new ArrayBuffer(size), v = new DataView(buf);
  v.setUint16(0, 0x4d42, true); v.setUint32(2, size, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true); v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);
  const out = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; out[o++] = d[i + 2]; out[o++] = d[i + 1]; out[o++] = d[i]; }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

async function encodeICO(c) {
  const s = Math.min(256, Math.max(c.width, c.height));
  const sq = document.createElement('canvas'); sq.width = sq.height = s;
  const r = Math.min(s / c.width, s / c.height), w = c.width * r, h = c.height * r;
  const ctx = sq.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(c, (s - w) / 2, (s - h) / 2, w, h);
  const png = new Uint8Array(await (await canvasBlob(sq, 'image/png')).arrayBuffer());
  const head = new DataView(new ArrayBuffer(22));
  head.setUint16(2, 1, true); head.setUint16(4, 1, true);
  head.setUint8(6, s === 256 ? 0 : s); head.setUint8(7, s === 256 ? 0 : s);
  head.setUint16(10, 1, true); head.setUint16(12, 32, true); head.setUint32(14, png.length, true); head.setUint32(18, 22, true);
  return new Blob([head.buffer, png], { type: 'image/x-icon' });
}

function encodeTIFF(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  return new Blob([UTIF.encodeImage(d.buffer, c.width, c.height)], { type: 'image/tiff' });
}

/* Minimal GIF89a encoder: 6x7x6 colour cube palette + LZW. Good for graphics; photos will band. */
function encodeGIF(c) {
  const w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const idx = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < idx.length; i += 4, p++) {
    idx[p] = Math.round(d[i] / 51) * 42 + Math.round(d[i + 1] / 42.5) * 6 + Math.round(d[i + 2] / 51);
  }
  const bytes = [];
  const push = (...a) => { for (const x of a) bytes.push(x); };
  const u16 = (n) => push(n & 255, (n >> 8) & 255);
  push(71, 73, 70, 56, 57, 97); u16(w); u16(h); push(0xf7, 0, 0);
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) push(r * 51, Math.round(g * 42.5), b * 51);
  for (let k = 252; k < 256; k++) push(0, 0, 0);
  push(0x2c); u16(0); u16(0); u16(w); u16(h); push(0);
  const minCode = 8; push(minCode);
  // LZW
  const clear = 256, eoi = 257; let size = minCode + 1, next = 258, dict = new Map();
  let cur = 0, nbits = 0; const out = [];
  const emit = (code) => { cur |= code << nbits; nbits += size; while (nbits >= 8) { out.push(cur & 255); cur >>>= 8; nbits -= 8; } };
  emit(clear);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = prefix * 256 + k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear); dict = new Map(); size = minCode + 1; next = 258; }
    prefix = k;
  }
  emit(prefix); emit(eoi); if (nbits > 0) out.push(cur & 255);
  for (let i = 0; i < out.length; i += 255) { const chunk = out.slice(i, i + 255); push(chunk.length, ...chunk); }
  push(0, 0x3b);
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

async function encodeImage(canvas, key, q, bg) {
  switch (key) {
    case 'jpg': return canvasBlob(flatten(canvas, bg), 'image/jpeg', q);
    case 'png': return canvasBlob(canvas, 'image/png');
    case 'webp': return canvasBlob(canvas, 'image/webp', q);
    case 'avif': return canvasBlob(canvas, 'image/avif', q);
    case 'bmp': return encodeBMP(flatten(canvas, bg));
    case 'tiff': return encodeTIFF(canvas);
    case 'ico': return encodeICO(canvas);
    case 'gif': return encodeGIF(flatten(canvas, bg));
  }
}

/* ---------- downscaling: cap the long side at `max` px, halving in steps so it stays sharp ---------- */
function shrink(canvas, max) {
  const long = Math.max(canvas.width, canvas.height);
  if (!max || long <= max) return canvas;
  const r = max / long, tw = Math.max(1, Math.round(canvas.width * r)), th = Math.max(1, Math.round(canvas.height * r));
  const step = (src, w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h); return c;
  };
  let src = canvas, w = canvas.width, h = canvas.height;
  while (w / 2 > tw) { w = Math.round(w / 2); h = Math.round(h / 2); src = step(src, w, h); }
  return step(src, tw, th);
}

/* ---------- PDF building ---------- */
const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
async function embedCanvasJpg(doc, canvas, q, bg) {
  return doc.embedJpg(new Uint8Array(await (await canvasBlob(flatten(canvas, bg), 'image/jpeg', q)).arrayBuffer()));
}
async function addImagePage(doc, canvas, q, bg, pageMode, maxdim) {
  // page size comes from the original pixels (at 96 dpi) so downscaling lowers file size, not paper size
  const iw = (canvas.width * 72) / 96, ih = (canvas.height * 72) / 96;
  const img = await embedCanvasJpg(doc, shrink(canvas, maxdim), q, bg);
  if (pageMode === 'fit') { doc.addPage([iw, ih]).drawImage(img, { x: 0, y: 0, width: iw, height: ih }); return; }
  let [pw, ph] = PAGE[pageMode]; if (iw > ih) [pw, ph] = [ph, pw];
  const m = 24, s = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih, 1);
  const w = iw * s, h = ih * s;
  doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

/* PDF compression: re-render each page as a JPEG at the chosen dpi, keeping the original paper size.
   Returns the smaller of (compressed, original) so a file never gets bigger. */
const PDFC_DPI = { medium: 150, strong: 100 };
async function compressPdf(file, level, q, maxdim, onPage) {
  const { PDFDocument } = PDFLib;
  const dpi = PDFC_DPI[level];
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = await PDFDocument.create();
  for (let p = 1; p <= pdf.numPages; p++) {
    onPage && onPage(p, pdf.numPages);
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const img = await embedCanvasJpg(out, shrink(c, maxdim), q, '#fff');
    out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    c.width = c.height = 0;
    page.cleanup();
  }
  await pdf.destroy();
  const bytes = await out.save();
  if (bytes.length < file.size) return { bytes, compressed: true };
  return { bytes: new Uint8Array(await file.arrayBuffer()), compressed: false };
}

/* ---------- run ---------- */
function setStatus(t, cls = '') { const s = $('status'); s.textContent = t; s.className = 'status ' + cls; }
function setProgress(f) { $('progress').hidden = f == null; $('bar').style.width = ((f || 0) * 100).toFixed(1) + '%'; }

async function run() {
  if (state.busy || !state.files.length) return;
  state.busy = true; syncOptions(); clearResults();
  const key = state.target, t = TARGETS.find((x) => x.key === key);
  const q = +$('quality').value / 100, dpi = +$('dpi').value, pageMode = $('page').value, bg = $('bg').value;
  const maxdim = key === 'ico' ? 0 : +$('maxdim').value, pdfc = $('pdfc').value;
  const merge = $('merge').checked || state.files.length === 1;
  const { PDFDocument } = PDFLib;
  const results = [], errors = [];
  let keptOriginal = 0;
  setProgress(0);
  try {
    let doc = key === 'pdf' && merge ? await PDFDocument.create() : null;
    for (let fi = 0; fi < state.files.length; fi++) {
      const item = state.files[fi];
      const tag = `(${fi + 1}/${state.files.length}) ${item.file.name}`;
      setStatus(tag);
      try {
        if (key === 'pdf') {
          const target = doc || (await PDFDocument.create());
          if (item.kind === 'pdf') {
            let bytes;
            if (pdfc !== 'none') {
              const r = await compressPdf(item.file, pdfc, q, maxdim, (p, n) => setStatus(`${tag} — ضغط صفحة ${p} من ${n}`));
              bytes = r.bytes; if (!r.compressed) keptOriginal++;
            } else bytes = await item.file.arrayBuffer();
            const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
            (await target.copyPages(src, src.getPageIndices())).forEach((p) => target.addPage(p));
          } else {
            for await (const fr of decode(item, dpi)) await addImagePage(target, applyEdit(fr.canvas, item.edit), q, bg, pageMode, maxdim);
          }
          if (!doc) results.push({ name: baseOf(item.file.name) + '.pdf', blob: new Blob([await target.save()], { type: t.mime }), pages: target.getPageCount(), src: item.file.size });
        } else {
          for await (const fr of decode(item, dpi)) {
            const cv = shrink(applyEdit(fr.canvas, item.edit), maxdim);
            const blob = await encodeImage(cv, key, q, bg);
            const suffix = fr.pages > 1 ? '-' + String(fr.page).padStart(String(fr.pages).length, '0') : '';
            const ico = key === 'ico' ? Math.min(256, Math.max(cv.width, cv.height)) : 0;
            results.push({ name: baseOf(item.file.name) + suffix + '.' + t.ext, blob, w: ico || cv.width, h: ico || cv.height, src: fr.pages === 1 ? item.file.size : 0 });
            cv.width = cv.height = 0; fr.canvas.width = fr.canvas.height = 0; // free memory early
            setStatus(`(${fi + 1}/${state.files.length}) ${item.file.name} — صفحة ${fr.page} من ${fr.pages}`);
          }
        }
      } catch (e) { console.error(e); errors.push(item.file.name); }
      setProgress((fi + 1) / state.files.length);
    }
    if (doc && doc.getPageCount()) {
      const name = state.files.length === 1 ? baseOf(state.files[0].file.name) + '.pdf' : 'merged.pdf';
      const srcTotal = state.files.reduce((s, f) => s + f.file.size, 0);
      results.push({ name, blob: new Blob([await doc.save()], { type: t.mime }), pages: doc.getPageCount(), src: srcTotal });
    }
  } catch (e) { console.error(e); errors.push('—'); }
  state.results = results; renderResults();
  state.busy = false; syncOptions(); setProgress(null);
  if (errors.length) { setStatus(`تعذّر تحويل: ${errors.join('، ')}. قد يكون الملف تالفاً أو محمياً بكلمة مرور.`, 'err'); return; }
  const inB = state.files.reduce((s, f) => s + f.file.size, 0), outB = results.reduce((s, r) => s + r.blob.size, 0);
  let msg = `تم. ${results.length} ${results.length === 1 ? 'ملف جاهز' : 'ملفات جاهزة'} للتنزيل. الحجم: ${iso(fmtSize(inB))} ← ${iso(fmtSize(outB))} (${iso(pct(inB, outB))}).`;
  if (keptOriginal) msg += ` ${keptOriginal === 1 ? 'ملف PDF واحد' : keptOriginal + ' ملفات PDF'} كان أصغر بدون ضغط، فأُبقي كما هو.`;
  setStatus(msg, 'ok');
}
const iso = (x) => '\u2066' + x + '\u2069';
function pct(a, b) { if (!a) return ''; const d = Math.round(((b - a) / a) * 100); return (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d) + '%'; }

function clearResults() {
  state.results.forEach((r) => r.url && URL.revokeObjectURL(r.url));
  state.results = []; renderResults();
}
function renderResults() {
  $('resultsSec').hidden = !state.results.length;
  $('rcount').textContent = `(${state.results.length})`;
  $('zipBtn').hidden = state.results.length < 2;
  const ul = $('results'); ul.innerHTML = '';
  state.results.forEach((r, idx) => {
    r.url = URL.createObjectURL(r.blob);
    const li = document.createElement('li'); li.className = 'res';
    const th = document.createElement('div'); th.className = 'thumb';
    if (r.blob.type.startsWith('image/') && !/tiff|x-icon|bmp/.test(r.blob.type)) th.style.backgroundImage = `url("${r.url}")`;
    else th.textContent = extOf(r.name);
    const meta = document.createElement('div'); meta.className = 'meta';
    const dims = r.w ? `<span class="num">${r.w}×${r.h}</span> · ` : r.pages ? `${r.pages} ${r.pages === 1 ? 'صفحة' : 'صفحات'} · ` : '';
    const d = r.src ? pct(r.src, r.blob.size) : '';
    const badge = d && r.blob.size < r.src ? ` <span class="delta down">${d}</span>` : '';
    meta.innerHTML = `<span class="name"></span><span class="small">${dims}<span class="num">${fmtSize(r.blob.size)}</span>${badge}</span>`;
    meta.querySelector('.name').textContent = r.name;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'res-open';
    open.setAttribute('aria-label', 'معاينة ' + r.name); open.onclick = () => openViewer(idx);
    open.append(th, meta);
    const acts = document.createElement('div'); acts.className = 'acts';
    resultActions(r, false).forEach((b) => acts.appendChild(b));
    li.append(open, acts); ul.appendChild(li);
  });
  renderBulk();
}

async function downloadZip() {
  const zip = new JSZip(), used = new Set();
  for (const r of state.results) {
    let n = r.name, k = 1; while (used.has(n)) n = baseOf(r.name) + `(${k++}).` + r.name.split('.').pop();
    used.add(n); zip.file(n, r.blob);
  }
  setStatus('جارٍ تجهيز ملف ZIP…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'converted.zip';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  setStatus('تم تنزيل ZIP.', 'ok');
}

/* ---------- wiring ---------- */
$('picker').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
document.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) addFiles(f); });
$('clearBtn').onclick = () => { state.files.forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb)); state.files = []; renderQueue(); syncOptions(); clearResults(); setStatus(''); updateDpiLabels(); };
$('pdfc').onchange = syncOptions;
$('quality').oninput = (e) => ($('qOut').textContent = e.target.value + '%');
$('goBtn').onclick = run;
$('zipBtn').onclick = downloadZip;

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('installBtn').hidden = true; };

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

renderTargets(); syncOptions();
