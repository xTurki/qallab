'use strict';
const $ = (id) => document.getElementById(id);

/* ---------- libraries load on first use, so the page opens without parsing a megabyte of code ---------- */
const LIBS = { pdf: ['lib/pdf.min.js'], tiff: ['lib/pako.min.js', 'lib/UTIF.js'], zip: ['lib/jszip.min.js'], heic: ['lib/heic2any.min.js'] };
const libReady = {};
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('تعذّر تحميل ' + src)); document.head.appendChild(s); });
}
function need(k) {
  return libReady[k] ||= LIBS[k].reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve())
    .then(() => { if (k === 'pdf') pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; })
    .catch((e) => { libReady[k] = null; throw e; });
}
/* isEvalSupported:false closes CVE-2024-4367 (script execution from a crafted PDF) in this PDF.js version */
const openPdf = async (data) => { await need('pdf'); return pdfjsLib.getDocument({ data, isEvalSupported: false }).promise; };

/* ---------- worker.js does the encoding and all pdf-lib work; killing it is how cancel stops a long job ---------- */
const abortErr = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const W = (() => {
  let w = null, seq = 0; const pend = new Map();
  const failAll = (err) => { for (const p of pend.values()) p.rej(err); pend.clear(); };
  const boot = () => {
    w = new Worker('worker.js');
    w.onmessage = ({ data }) => {
      const p = pend.get(data.id); if (!p) return; pend.delete(data.id);
      data.ok ? p.res(data.res) : p.rej(Object.assign(new Error(data.err.message), data.err));
    };
    w.onerror = () => { w.terminate(); w = null; failAll(new Error('تعذّر تشغيل المعالج')); };
  };
  return {
    call(op, args = {}, transfer = []) {
      if (!w) boot();
      return new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); w.postMessage({ id, op, args }, transfer); });
    },
    kill() { if (w) w.terminate(); w = null; failAll(abortErr()); },
  };
})();
const bufOf = (b) => b.buffer || b; // ArrayBuffer of an ArrayBuffer or a typed array, for transfer lists

/* Safari on iOS draws nothing on a canvas above ~16.7 megapixels, and recent iPhone photos are 24-48 MP.
   Anything larger is scaled down to fit; other browsers get a far higher ceiling. */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_AREA = IS_IOS ? 16777216 : 120000000;
let clamped = 0; // inputs scaled down by fitArea during the current run
function fitArea(w, h) {
  const s = Math.min(1, Math.sqrt(MAX_AREA / (w * h)));
  if (s < 1) clamped++;
  return [Math.max(1, Math.floor(w * s)), Math.max(1, Math.floor(h * s))];
}
function pdfViewport(page, dpi) {
  const base = page.getViewport({ scale: 1 });
  const want = (base.width * dpi) / 72, [w] = fitArea(want, (base.height * dpi) / 72);
  return page.getViewport({ scale: w < Math.floor(want) ? w / base.width : dpi / 72 }); // exact dpi unless capped
}

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

const state = { files: [], target: 'pdf', results: [], busy: false, cancel: false };
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
    b.tabIndex = state.target === t.key ? 0 : -1; // roving tabindex: the radio group is one tab stop
    if (t.key in ENCODABLE && !ENCODABLE[t.key]) { b.disabled = true; b.title = 'متصفحك لا يدعم الحفظ بهذه الصيغة'; }
    b.onclick = () => { state.target = t.key; renderTargets(); syncOptions(); };
    box.appendChild(b);
  }
}

const PDFC_NOTE = {
  smart: 'يصغّر الصور داخل الملف ويحافظ على النص قابلاً للتحديد والبحث. إذا لم يصغر الملف يُبقى الأصل.',
  medium: 'يحوّل كل صفحة إلى صورة، فلن تقدر تحدد النص أو تبحث فيه. إذا طلع الناتج أكبر من الأصل يُبقى الملف الأصلي.',
  strong: 'يحوّل كل صفحة إلى صورة بدقة أقل، فلن تقدر تحدد النص أو تبحث فيه. إذا طلع الناتج أكبر من الأصل يُبقى الملف الأصلي.',
};
function syncOptions() {
  const t = state.target;
  const hasPdfIn = state.files.some((f) => f.kind === 'pdf');
  const show = {
    quality: ['jpg', 'webp', 'avif', 'pdf'].includes(t),
    tsize: ['jpg', 'webp', 'avif', 'pdf'].includes(t),
    pngc: t === 'png',
    dpi: hasPdfIn && t !== 'pdf',
    page: t === 'pdf',
    merge: t === 'pdf' && state.files.length > 1,
    bg: ['jpg', 'bmp', 'pdf', 'gif'].includes(t),
    maxdim: t !== 'ico',
    pdfc: t === 'pdf' && hasPdfIn,
  };
  const pdfc = $('pdfc').value;
  $('pdfcNote').hidden = pdfc === 'none'; $('pdfcNote').textContent = PDFC_NOTE[pdfc] || '';
  $('tsizeNote').hidden = $('tsize').value === '0';
  $('tsizeNote').textContent = t === 'pdf'
    ? 'تُخفَّض جودة الصور ثم مقاسها حتى يصير الملف تحت الحد. صفحات PDF المنسوخة بدون ضغط لا تتغير.'
    : 'تُخفَّض الجودة ثم المقاس تلقائياً حتى يصير كل ملف تحت الحد.';
  document.querySelectorAll('.opt').forEach((el) => { el.hidden = !show[el.dataset.for]; });
  const go = $('goBtn');
  go.disabled = !state.files.length || state.busy;
  $('cancelBtn').hidden = !state.busy;
  const label = TARGETS.find((x) => x.key === t).label;
  go.textContent = state.busy ? 'جارٍ التحويل…' : state.files.length ? `حوّل ${state.files.length === 1 ? 'الملف' : state.files.length + ' ملفات'} إلى ${label}` : 'أضف ملفات أولاً';
}

/* ---------- thumbnails: a small copy is decoded once, instead of the list holding full-size images ---------- */
let thumbChain = Promise.resolve();
function makeThumb(blob, size = 96) {
  const job = async () => {
    let src = null, url = null;
    try {
      try { src = await createImageBitmap(blob, { resizeWidth: size, resizeQuality: 'low' }); }
      catch { url = URL.createObjectURL(blob); src = await loadImg(url); }
      const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight, s = Math.min(1, (size * 1.5) / Math.max(sw, sh));
      const c = toCanvas(src, Math.max(1, Math.round(sw * s)), Math.max(1, Math.round(sh * s)));
      const data = c.toDataURL('image/png'); c.width = c.height = 0;
      return data;
    } catch { return null; }
    finally { if (src && src.close) src.close(); if (url) URL.revokeObjectURL(url); }
  };
  return (thumbChain = thumbChain.then(job, job)); // one at a time: decoding twenty photos at once stalls a phone
}
function showThumb(el, data) { if (data) { el.style.backgroundImage = `url("${data}")`; el.textContent = ''; } }

/* ---------- file intake ---------- */
function kindOf(file) {
  const n = file.name.toLowerCase();
  if (file.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/\.(heic|heif)$/.test(n) || /heic|heif/.test(file.type)) return 'heic';
  if (/\.tiff?$/.test(n) || file.type === 'image/tiff') return 'tiff';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico|jfif)$/.test(n)) return 'image';
  return null;
}
const extOf = (name) => (name.split('.').pop() || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); // goes into innerHTML
const baseOf = (name) => name.replace(/\.[^.]+$/, '') || 'file';
function fmtSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }

function addFiles(list) {
  let skipped = 0;
  for (const file of list) {
    const kind = kindOf(file);
    if (!kind) { skipped++; continue; }
    const item = { id: ++uid, file, kind, thumb: null, thumbEl: null };
    state.files.push(item);
    if (kind === 'image') makeThumb(file).then((d) => { item.thumb = d; if (item.thumbEl && !item.editThumb) showThumb(item.thumbEl, d); });
    if (kind === 'pdf') probePdf(item);
  }
  renderQueue(); syncOptions();
  setStatus(skipped ? `تم تجاهل ${skipped} ملف بصيغة غير مدعومة.` : '', skipped ? 'err' : '');
}

function renderQueue() {
  $('queueSec').hidden = !state.files.length;
  $('drop').classList.toggle('compact', !!state.files.length);
  $('count').textContent = state.files.length ? `(${state.files.length})` : '';
  const ul = $('queue'); ul.innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    const th = document.createElement('div'); th.className = 'thumb'; f.thumbEl = th;
    th.textContent = extOf(f.file.name); showThumb(th, f.editThumb || f.thumb);
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
      const eb = document.createElement('button'); eb.className = 'editbtn'; eb.type = 'button';
      eb.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>قص وتحجيم</span>';
      eb.setAttribute('aria-label', 'قص وتحجيم ' + f.file.name);
      eb.onclick = () => openEditor(f); li.appendChild(eb);
    }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'إزالة ' + f.file.name);
    x.onclick = () => { state.files = state.files.filter((g) => g !== f); renderQueue(); syncOptions(); updateDpiLabels(); };
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
const free = (c) => { c.width = c.height = 0; }; // hand canvas memory back now; iOS caps the total
async function blobToCanvas(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImg(url);
    let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024; // SVG without size falls back to 1024
    return toCanvas(img, ...fitArea(w, h));
  } finally { URL.revokeObjectURL(url); }
}

async function* decode(item, dpi) {
  const { file, kind } = item;
  if (kind === 'pdf') {
    const pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
    try {
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const vp = pdfViewport(page, dpi);
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        page.cleanup();
        yield { canvas: c, page: p, pages: pdf.numPages };
      }
    } finally { pdf.destroy(); }
    return;
  }
  if (kind === 'tiff') {
    await need('tiff');
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
    // Safari reads HEIC itself; the 1.3 MB decoder is only fetched where the browser cannot
    let native = null;
    try { native = await blobToCanvas(file); } catch { /* not supported here */ }
    if (native) { yield { canvas: native, page: 1, pages: 1 }; return; }
    await need('heic');
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
const rgbaOf = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.buffer;

/* Encode under a byte budget: search the quality first (pixels are worth more than quality),
   and only if the lowest quality is still too big, shrink the pixels step by step. */
async function toBudget(canvas, mime, q, budget) {
  let blob = await canvasBlob(canvas, mime, q);
  if (!budget || blob.size <= budget) return { blob, w: canvas.width, h: canvas.height };
  let lo = 0.2, hi = q, best = null;
  for (let i = 0; i < 6 && hi - lo > 0.02; i++) {
    const mid = (lo + hi) / 2, b = await canvasBlob(canvas, mime, mid);
    if (b.size <= budget) { best = b; lo = mid; } else { hi = mid; blob = b; }
  }
  if (best) return { blob: best, w: canvas.width, h: canvas.height };
  let c = canvas;
  for (let i = 0; i < 10 && Math.max(c.width, c.height) > 64 && blob.size > budget; i++) {
    const scale = Math.max(0.5, Math.min(0.9, Math.sqrt(budget / blob.size)));
    const next = shrink(c, Math.round(Math.max(c.width, c.height) * scale)); if (c !== canvas) free(c); c = next;
    blob = await canvasBlob(c, mime, 0.5);
  }
  const out = { blob, w: c.width, h: c.height }; if (c !== canvas) free(c);
  return out;
}

/* o = { q, bg, budget, png } → { blob, w, h } */
async function encodeImage(canvas, key, o) {
  const w = canvas.width, h = canvas.height, done = (blob) => ({ blob, w, h });
  const viaWorker = async (op, src, type, extra = {}) => {
    const rgba = rgbaOf(src);
    return new Blob([await W.call(op, { rgba, w: src.width, h: src.height, ...extra }, [rgba])], { type });
  };
  switch (key) {
    case 'jpg': { const f = flatten(canvas, o.bg), r = await toBudget(f, 'image/jpeg', o.q, o.budget); free(f); return r; }
    case 'webp': return toBudget(canvas, 'image/webp', o.q, o.budget);
    case 'avif': return toBudget(canvas, 'image/avif', o.q, o.budget);
    case 'png': {
      const fast = await canvasBlob(canvas, 'image/png');
      if (o.png === 'fast') return done(fast);
      const small = await viaWorker('png', canvas, 'image/png', { colors: o.png === '256' ? 256 : 0 });
      return done(small.size < fast.size ? small : fast);
    }
    case 'bmp': { const f = flatten(canvas, o.bg), b = await viaWorker('bmp', f, 'image/bmp'); free(f); return done(b); }
    case 'tiff': return done(await viaWorker('tiff', canvas, 'image/tiff'));
    case 'gif': { const f = flatten(canvas, o.bg), b = await viaWorker('gif', f, 'image/gif'); free(f); return done(b); }
    case 'ico': {
      const s = Math.min(256, Math.max(w, h)), sq = document.createElement('canvas'); sq.width = sq.height = s;
      const r = Math.min(s / w, s / h), dw = w * r, dh = h * r;
      const ctx = sq.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(canvas, (s - dw) / 2, (s - dh) / 2, dw, dh);
      const png = new Uint8Array(await (await viaWorker('png', sq, 'image/png', { colors: 0 })).arrayBuffer()); free(sq);
      const head = new DataView(new ArrayBuffer(22));
      head.setUint16(2, 1, true); head.setUint16(4, 1, true);
      head.setUint8(6, s === 256 ? 0 : s); head.setUint8(7, s === 256 ? 0 : s);
      head.setUint16(10, 1, true); head.setUint16(12, 32, true); head.setUint32(14, png.length, true); head.setUint32(18, 22, true);
      return { blob: new Blob([head.buffer, png], { type: 'image/x-icon' }), w: s, h: s };
    }
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
  while (w / 2 > tw) { w = Math.round(w / 2); h = Math.round(h / 2); const next = step(src, w, h); if (src !== canvas) free(src); src = next; }
  const out = step(src, tw, th); if (src !== canvas) free(src);
  return out;
}

/* ---------- PDF building (the document itself lives in the worker, addressed by id) ---------- */
const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
/* o = { q, bg, pageMode, maxdim, pageBudget } */
async function addImagePage(id, canvas, o) {
  // page size comes from the original pixels (at 96 dpi) so downscaling lowers file size, not paper size
  const iw = (canvas.width * 72) / 96, ih = (canvas.height * 72) / 96;
  const small = shrink(canvas, o.maxdim), flat = flatten(small, o.bg);
  const jpg = await (await toBudget(flat, 'image/jpeg', o.q, o.pageBudget)).blob.arrayBuffer();
  free(flat); if (small !== canvas) free(small);
  let pw = iw, ph = ih, x = 0, y = 0, w = iw, h = ih;
  if (o.pageMode !== 'fit') {
    [pw, ph] = PAGE[o.pageMode]; if (iw > ih) [pw, ph] = [ph, pw];
    const m = 24, s = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih, 1);
    w = iw * s; h = ih * s; x = (pw - w) / 2; y = (ph - h) / 2;
  }
  await W.call('pdfAddJpg', { id, jpg, pw, ph, x, y, w, h }, [jpg]);
}

/* Raster compression: redraw each page as a JPEG at `dpi`, keeping the paper size. Text becomes pixels.
   Returns the smaller of (compressed, original) unless `force`, so a file never grows. */
const PDFC_DPI = { medium: 150, strong: 100 };
async function rasterPdf(file, dpi, o, onPage, force) {
  const pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
  const id = await W.call('pdfNew');
  try {
    const budget = o.tsize ? Math.floor((o.tsize * 0.96) / pdf.numPages) - 1500 : 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      checkCancel(); onPage && onPage(p, pdf.numPages);
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 }), vp = pdfViewport(page, dpi);
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const small = shrink(c, o.maxdim);
      const jpg = await (await toBudget(small, 'image/jpeg', o.q, budget)).blob.arrayBuffer();
      if (small !== c) free(small); free(c); page.cleanup();
      await W.call('pdfAddJpg', { id, jpg, pw: base.width, ph: base.height, x: 0, y: 0, w: base.width, h: base.height }, [jpg]);
    }
  } catch (e) { W.call('pdfDrop', { id }).catch(() => {}); throw e; }
  finally { pdf.destroy(); }
  const r = await W.call('pdfSave', { id });
  if (force || r.bytes.byteLength < file.size) return { bytes: r.bytes, compressed: true };
  return { bytes: await file.arrayBuffer(), compressed: false };
}

/* Smart compression: only the JPEG photos inside the PDF are re-encoded (smaller pixels, lower quality).
   Text, fonts and vector drawings are untouched, so the file stays selectable and searchable. */
async function smartPdf(file, o, onImage) {
  const src = await file.arrayBuffer();
  const { id, images } = await W.call('pdfImages', { bytes: src, minBytes: 20000 }, [src]);
  const list = [];
  try {
    for (let k = 0; k < images.length; k++) {
      checkCancel(); onImage && onImage(k + 1, images.length);
      const im = images[k];
      let bmp = null;
      // imageOrientation:'none' — PDF viewers ignore EXIF rotation, so the browser must not apply it either
      try { bmp = await createImageBitmap(new Blob([im.jpg], { type: 'image/jpeg' }), { imageOrientation: 'none' }); } catch { continue; }
      if (bmp.width !== im.w || bmp.height !== im.h) { bmp.close(); continue; } // not what the PDF says it is: leave it alone
      const full = toCanvas(bmp, ...fitArea(bmp.width, bmp.height)); bmp.close();
      const small = shrink(full, o.maxdim || 2000);
      const blob = await canvasBlob(small, 'image/jpeg', o.q);
      if (blob.size < im.jpg.length * 0.9) list.push({ n: im.n, g: im.g, w: small.width, h: small.height, jpg: await blob.arrayBuffer() });
      if (small !== full) free(small); free(full);
    }
  } catch (e) { W.call('pdfDrop', { id }).catch(() => {}); throw e; }
  const r = await W.call('pdfReplace', { id, list }, list.map((x) => x.jpg));
  if (r.bytes.byteLength < file.size) return { bytes: r.bytes, compressed: true };
  return { bytes: await file.arrayBuffer(), compressed: false };
}

/* ---------- run ---------- */
function setStatus(t, cls = '') { const s = $('status'); s.textContent = t; s.className = 'status ' + cls; }
function setProgress(f) {
  const p = $('progress'); p.hidden = f == null; p.setAttribute('aria-valuenow', Math.round((f || 0) * 100));
  $('bar').style.width = ((f || 0) * 100).toFixed(1) + '%';
}
function checkCancel() { if (state.cancel) throw abortErr(); }
const tick = () => new Promise((r) => setTimeout(r)); // let the page paint and take taps between steps

async function run() {
  if (state.busy || !state.files.length) return;
  state.busy = true; state.cancel = false; syncOptions(); clearResults();
  const key = state.target, t = TARGETS.find((x) => x.key === key);
  const q = +$('quality').value / 100, dpi = +$('dpi').value, bg = $('bg').value, pdfc = $('pdfc').value;
  const maxdim = key === 'ico' ? 0 : +$('maxdim').value, tsize = +$('tsize').value;
  const merge = $('merge').checked || state.files.length === 1;
  const imageItems = state.files.filter((f) => f.kind !== 'pdf').length || 1;
  const o = { q, bg, maxdim, tsize, png: $('pngc').value, budget: tsize, pageMode: $('page').value,
    pageBudget: tsize ? Math.floor((tsize * 0.96) / (merge ? imageItems : 1)) - 1500 : 0 };
  const results = [], errors = [], locked = [];
  let keptOriginal = 0, redrawn = 0, cancelled = false, shared = null;
  clamped = 0;
  setProgress(0);
  try {
    if (key === 'pdf' && merge) shared = await W.call('pdfNew');
    for (let fi = 0; fi < state.files.length; fi++) {
      const item = state.files[fi];
      const tag = `(${fi + 1}/${state.files.length}) ${item.file.name}`;
      setStatus(tag); await tick(); checkCancel();
      try {
        if (key === 'pdf') {
          const id = shared ?? (await W.call('pdfNew'));
          try {
            if (item.kind === 'pdf') {
              try {
                let bytes;
                if (pdfc === 'smart') {
                  const r = await smartPdf(item.file, o, (k, n) => setStatus(`${tag} — صورة ${k} من ${n}`));
                  bytes = r.bytes; if (!r.compressed) keptOriginal++;
                } else if (pdfc in PDFC_DPI) {
                  const r = await rasterPdf(item.file, PDFC_DPI[pdfc], o, (p, n) => setStatus(`${tag} — ضغط صفحة ${p} من ${n}`));
                  bytes = r.bytes; if (!r.compressed) keptOriginal++;
                } else bytes = await item.file.arrayBuffer();
                await W.call('pdfAppend', { id, bytes }, [bufOf(bytes)]);
              } catch (e) {
                // pdf-lib cannot copy pages out of an encrypted file (they come out blank), so redraw them as images.
                // PDF.js opens owner-locked files; one that needs a password to open throws PasswordException.
                if (!e.encrypted) throw e;
                const r = await rasterPdf(item.file, 150, o, (p, n) => setStatus(`${tag} — صفحة ${p} من ${n}`), true);
                await W.call('pdfAppend', { id, bytes: r.bytes }, [bufOf(r.bytes)]); redrawn++;
              }
            } else {
              for await (const fr of decode(item, dpi)) {
                checkCancel();
                const cv = applyEdit(fr.canvas, item.edit);
                await addImagePage(id, cv, o);
                if (cv !== fr.canvas) free(cv); free(fr.canvas);
              }
            }
            if (!shared) {
              const r = await W.call('pdfSave', { id });
              results.push({ name: baseOf(item.file.name) + '.pdf', blob: new Blob([r.bytes], { type: t.mime }), pages: r.pages, src: item.file.size });
            }
          } catch (e) { if (!shared) W.call('pdfDrop', { id }).catch(() => {}); throw e; }
        } else {
          for await (const fr of decode(item, dpi)) {
            checkCancel();
            setStatus(fr.pages > 1 ? `${tag} — صفحة ${fr.page} من ${fr.pages}` : tag);
            const edited = applyEdit(fr.canvas, item.edit), cv = shrink(edited, maxdim);
            const r = await encodeImage(cv, key, o);
            const suffix = fr.pages > 1 ? '-' + String(fr.page).padStart(String(fr.pages).length, '0') : '';
            results.push({ name: baseOf(item.file.name) + suffix + '.' + t.ext, blob: r.blob, w: r.w, h: r.h, src: fr.pages === 1 ? item.file.size : 0 });
            for (const c of new Set([cv, edited, fr.canvas])) free(c); // free memory early
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.error(e); (e.name === 'PasswordException' ? locked : errors).push(item.file.name);
      }
      setProgress((fi + 1) / state.files.length);
    }
    if (shared) {
      setStatus('جارٍ حفظ الملف…');
      const r = await W.call('pdfSave', { id: shared });
      if (r.pages) {
        const name = state.files.length === 1 ? baseOf(state.files[0].file.name) + '.pdf' : 'merged.pdf';
        results.push({ name, blob: new Blob([r.bytes], { type: t.mime }), pages: r.pages, src: state.files.reduce((s, f) => s + f.file.size, 0) });
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') cancelled = true; else { console.error(e); errors.push('—'); }
  }
  state.results = results; renderResults();
  state.busy = false; state.cancel = false; syncOptions(); setProgress(null);
  if (cancelled) { setStatus(results.length ? `أُلغي التحويل. ${results.length} ${results.length === 1 ? 'ملف اكتمل' : 'ملفات اكتملت'} قبل الإلغاء.` : 'أُلغي التحويل.'); return; }
  if (errors.length || locked.length) {
    const parts = [];
    if (locked.length) parts.push(`محمي بكلمة مرور ولا يمكن فتحه: ${locked.join('، ')}.`);
    if (errors.length) parts.push(`تعذّر تحويل: ${errors.join('، ')}. قد يكون الملف تالفاً أو بصيغة غير مدعومة.`);
    setStatus(parts.join(' '), 'err'); return;
  }
  const inB = state.files.reduce((s, f) => s + f.file.size, 0), outB = results.reduce((s, r) => s + r.blob.size, 0);
  let msg = `تم. ${results.length} ${results.length === 1 ? 'ملف جاهز' : 'ملفات جاهزة'} للتنزيل. الحجم: ${iso(fmtSize(inB))} ← ${iso(fmtSize(outB))} (${iso(pct(inB, outB))}).`;
  const over = tsize ? results.filter((r) => r.blob.size > tsize).length : 0;
  if (over) msg += ` ${over === 1 ? 'ملف واحد بقي' : over + ' ملفات بقيت'} فوق الحد المطلوب.`;
  if (keptOriginal) msg += ` ${keptOriginal === 1 ? 'ملف PDF واحد' : keptOriginal + ' ملفات PDF'} لم يصغر بالضغط، فأُبقي كما هو.`;
  if (redrawn) msg += ` ${redrawn === 1 ? 'ملف PDF مقفل' : redrawn + ' ملفات PDF مقفلة'} أُعيد رسم صفحاته كصور.`;
  if (clamped) msg += ' بعض الصور أكبر من حد هذا الجهاز فصُغّرت قليلاً.';
  setStatus(msg, 'ok');
}
const iso = (x) => '⁦' + x + '⁩';
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
    r.url ||= URL.createObjectURL(r.blob);
    const li = document.createElement('li'); li.className = 'res';
    const th = document.createElement('div'); th.className = 'thumb'; th.textContent = extOf(r.name);
    if (/^image\/(jpeg|png|webp|avif|gif)$/.test(r.blob.type)) {
      if (r.thumb) showThumb(th, r.thumb); else makeThumb(r.blob).then((d) => { r.thumb = d; showThumb(th, d); });
    }
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
  setStatus('جارٍ تجهيز ملف ZIP…');
  await need('zip');
  const zip = new JSZip(), used = new Set();
  for (const r of state.results) {
    let n = r.name, k = 1; while (used.has(n)) n = baseOf(r.name) + `(${k++}).` + r.name.split('.').pop();
    used.add(n); zip.file(n, r.blob);
  }
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
$('clearBtn').onclick = () => {
  if ((state.files.length > 1 || state.results.length) && !confirm('مسح كل الملفات والناتج؟')) return;
  state.files = []; renderQueue(); syncOptions(); clearResults(); setStatus(''); updateDpiLabels();
};
$('pdfc').onchange = syncOptions;
$('tsize').onchange = syncOptions;
$('quality').oninput = (e) => {
  const r = e.target; $('qOut').textContent = r.value + '%';
  r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min)) * 100 + '%'); // slider track fill
};
$('quality').oninput({ target: $('quality') });
$('goBtn').onclick = run;
$('cancelBtn').onclick = () => { if (!state.busy) return; state.cancel = true; W.kill(); setStatus('جارٍ الإلغاء…'); };
$('zipBtn').onclick = downloadZip;

/* arrow keys move the selection inside the format radio group (RTL: right = previous) */
$('targets').addEventListener('keydown', (e) => {
  const d = { ArrowRight: -1, ArrowUp: -1, ArrowLeft: 1, ArrowDown: 1 }[e.key]; if (!d) return;
  e.preventDefault();
  const ok = TARGETS.filter((t) => !(t.key in ENCODABLE && !ENCODABLE[t.key]));
  const i = ok.findIndex((t) => t.key === state.target);
  state.target = ok[(i + d + ok.length) % ok.length].key; renderTargets(); syncOptions();
  $('targets').querySelector('[aria-checked="true"]').focus();
});

/* ---------- modal sheets ----------
   Opening moves focus in and makes the page behind inert; closing animates out and gives focus back.
   The grabber and header can be dragged down to dismiss, like a native sheet. */
let sheetReturn = null;
const sheetTimers = new WeakMap();
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function sheetOpen(el, focusEl) {
  clearTimeout(sheetTimers.get(el)); el.classList.remove('closing');
  const card = el.querySelector('.sheet-card'); card.getAnimations().forEach((a) => a.cancel()); card.style.transform = '';
  sheetReturn = document.activeElement; el.hidden = false;
  document.body.classList.add('locked'); document.querySelector('.wrap').inert = true; focusEl.focus();
}
function sheetClose(el, fromY = 0) {
  if (el.hidden || el.classList.contains('closing')) return;
  document.body.classList.remove('locked'); document.querySelector('.wrap').inert = false;
  if (sheetReturn && sheetReturn.isConnected) sheetReturn.focus();
  sheetReturn = null;
  const card = el.querySelector('.sheet-card'), finish = () => { el.hidden = true; el.classList.remove('closing'); card.style.transform = ''; };
  if (calm()) return finish();
  el.classList.add('closing');
  const wide = matchMedia('(min-width:700px)').matches, ms = 220;
  card.animate(wide ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: `translateY(${fromY}px)` }, { transform: 'translateY(100%)' }], { duration: ms, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
  el.animate([{ backgroundColor: getComputedStyle(el).backgroundColor }, { backgroundColor: 'rgba(0,0,0,0)' }], { duration: ms, fill: 'forwards' });
  sheetTimers.set(el, setTimeout(() => { el.getAnimations().forEach((a) => a.cancel()); card.getAnimations().forEach((a) => a.cancel()); finish(); }, ms));
}
function sheetDrag(el, close) {
  const card = el.querySelector('.sheet-card');
  let y0 = null, dy = 0, t0 = 0;
  for (const h of el.querySelectorAll('[data-drag]')) {
    h.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || matchMedia('(min-width:700px)').matches) return;
      y0 = e.clientY; dy = 0; t0 = e.timeStamp; h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); card.style.transform = `translateY(${dy}px)`; });
    const end = (e) => {
      if (y0 == null) return; y0 = null;
      const fast = dy / Math.max(1, e.timeStamp - t0) > 0.6; // px per ms: a flick closes even when short
      if (dy > 120 || (fast && dy > 30)) close(dy);
      else { card.style.transform = ''; if (dy && !calm()) card.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(.4,0,.2,1)' }); }
    };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  }
}

/* ---------- files handed to the installed app ---------- */
/* "Open with" on desktop (manifest file_handlers) */
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (params) => {
    if (params.files && params.files.length) addFiles(await Promise.all(params.files.map((h) => h.getFile())));
  });
}
/* Android share sheet (manifest share_target): sw.js parks the shared files in a cache on this device,
   and they are taken out and deleted here as soon as the page opens. */
async function takeShared() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('qallab-share'), files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      files.push(new File([await res.blob()], decodeURIComponent(res.headers.get('x-name') || 'file'), { type: res.headers.get('content-type') || '' }));
    }
    await caches.delete('qallab-share');
    if (files.length) addFiles(files);
  } catch (e) { console.error(e); }
}

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('installBtn').hidden = true; };

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
  // a new version took over: reload once so the open page shows it (skip on first install, when there was no controller)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded || state.busy || state.files.length) return;
    reloaded = true; location.reload();
  });
}

renderTargets(); syncOptions();
window.addEventListener('load', takeShared); // after editor.js and viewer.js are in
