'use strict';
/* Pixel-size labels for DPI options, and the per-image crop / rotate / resize editor.
   Loaded after app.js; uses its globals ($, state, decode, renderQueue, fmtSize, iso). */

/* ---------- paper sizes & DPI labels ---------- */
const PAPER = [['A3', 841.89, 1190.55], ['A4', 595.28, 841.89], ['A5', 419.53, 595.28], ['Letter', 612, 792], ['Legal', 612, 1008]];
function paperName(w, h) {
  const a = Math.min(w, h), b = Math.max(w, h);
  const p = PAPER.find(([, x, y]) => Math.abs(x - a) < 3 && Math.abs(y - b) < 3);
  return p ? p[0] : null;
}
const ltr = (x) => '\u200E' + String(x).replace(/×/g, '\u200E×\u200E') + '\u200E'; // LRM marks: <option> text ignores bidi isolates
const pxAt = (ref, dpi) => ltr(`${Math.ceil((ref.w * dpi) / 72 - 1e-6)}×${Math.ceil((ref.h * dpi) / 72 - 1e-6)}`) + ' بكسل';

async function probePdf(item) {
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await item.file.arrayBuffer()) }).promise;
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
    item.info = { w: vp.width, h: vp.height, pages: pdf.numPages };
    await pdf.destroy();
  } catch { item.info = null; }
  renderQueue(); updateDpiLabels();
}

function updateDpiLabels() {
  const first = state.files.find((f) => f.kind === 'pdf' && f.info);
  const ref = first ? first.info : { w: 595.28, h: 841.89 };
  for (const o of $('dpi').options) o.textContent = `${o.dataset.label} · ${pxAt(ref, +o.value)}`;
  for (const o of $('pdfc').options) if (o.dataset.dpi) o.textContent = `${o.dataset.label} · ${pxAt(ref, +o.dataset.dpi)}`;
  const mm = (pt) => Math.round((pt / 72) * 25.4);
  const paper = paperName(ref.w, ref.h);
  const sizeTxt = paper ? `ورقة ${paper}` : `صفحة ${ltr(mm(ref.w) + '×' + mm(ref.h))} مم`;
  const note = first
    ? `المقاسات بالبكسل لأول صفحة في «${first.file.name}» (${sizeTxt}).`
    : 'المقاسات بالبكسل لصفحة A4 كمثال. أضف ملف PDF لتظهر مقاساته الفعلية.';
  $('dpiNote').textContent = note;
}

/* ---------- canvas helpers ---------- */
function rotateCanvas(src, rot) {
  rot = ((rot % 360) + 360) % 360;
  if (!rot) return src;
  const c = document.createElement('canvas');
  const swap = rot === 90 || rot === 270;
  c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
function resizeTo(src, tw, th) {
  if (src.width === tw && src.height === th) return src;
  const step = (s, w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s, 0, 0, w, h); return c;
  };
  let s = src, w = src.width, h = src.height;
  while (w / 2 > tw && h / 2 > th) { w = Math.round(w / 2); h = Math.round(h / 2); s = step(s, w, h); }
  return step(s, tw, th);
}
/* edit = { rot, crop:{x,y,w,h} as fractions of the rotated image, scaleX, scaleY } */
function cropPx(edit, rw, rh) {
  const x = Math.round(edit.crop.x * rw), y = Math.round(edit.crop.y * rh);
  const w = Math.max(1, Math.min(rw - x, Math.round(edit.crop.w * rw))), h = Math.max(1, Math.min(rh - y, Math.round(edit.crop.h * rh)));
  return { x, y, w, h };
}
const MAXSIDE = 16384;
function outSize(edit, cw, ch) {
  return {
    w: Math.max(1, Math.min(MAXSIDE, Math.round(cw * edit.scaleX))),
    h: Math.max(1, Math.min(MAXSIDE, Math.round(ch * edit.scaleY))),
  };
}
function applyEdit(canvas, edit) {
  if (!edit) return canvas;
  const r = rotateCanvas(canvas, edit.rot);
  const p = cropPx(edit, r.width, r.height);
  const cut = document.createElement('canvas'); cut.width = p.w; cut.height = p.h;
  cut.getContext('2d').drawImage(r, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
  const o = outSize(edit, p.w, p.h);
  return resizeTo(cut, o.w, o.h);
}

/* ---------- editor ---------- */
const RATIOS = [['حر', null], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['A4', 210 / 297]];
const PCTS = [25, 50, 75, 100, 150, 200, 300];
const ed = { item: null, src: null, rot: 0, rotated: null, crop: null, ratio: null, sx: 1, sy: 1, lock: true, disp: { w: 0, h: 0 } };

function chips(boxId, list, onPick, isOn) {
  const box = $(boxId); box.innerHTML = '';
  for (const [label, val] of list) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = label;
    b.setAttribute('aria-pressed', String(isOn(val)));
    b.onclick = () => onPick(val);
    box.appendChild(b);
  }
}
const drawRatios = () => chips('ratios', RATIOS, setRatio, (v) => v === ed.ratio);
const drawPcts = () => chips('pcts', PCTS.map((p) => [p + '%', p]), (p) => { ed.sx = ed.sy = p / 100; syncSize(); }, (p) => ed.lock && ed.sx === ed.sy && Math.round(ed.sx * 100) === p);

async function openEditor(item) {
  ed.item = item;
  $('edName').textContent = item.file.name;
  $('editor').hidden = false; document.body.classList.add('locked');
  $('cropInfo').textContent = 'جارٍ تحميل الصورة…';
  try {
    const it = decode(item, 150); const fr = (await it.next()).value; it.return && it.return();
    ed.src = fr.canvas;
  } catch (e) { console.error(e); $('cropInfo').textContent = 'تعذّر فتح الصورة.'; return; }
  const e = item.edit;
  ed.rot = e ? e.rot : 0; ed.crop = e ? { ...e.crop } : { x: 0, y: 0, w: 1, h: 1 };
  ed.sx = e ? e.scaleX : 1; ed.sy = e ? e.scaleY : 1; ed.lock = e ? e.scaleX === e.scaleY : true; ed.ratio = e ? e.ratio ?? null : null;
  refreshRotation(false);
}
function closeEditor() {
  $('editor').hidden = true; document.body.classList.remove('locked');
  ed.item = null; ed.src = ed.rotated = null;
}

function refreshRotation(resetCrop) {
  ed.rotated = rotateCanvas(ed.src, ed.rot);
  if (resetCrop) { ed.crop = { x: 0, y: 0, w: 1, h: 1 }; if (ed.ratio) fitRatio(); }
  layoutStage(); drawRatios(); syncSize();
}

function layoutStage() {
  const stage = $('stage'), r = ed.rotated;
  const maxW = stage.clientWidth || 300, maxH = Math.max(200, Math.min(window.innerHeight * 0.48, 520));
  const s = Math.min(maxW / r.width, maxH / r.height, 1);
  ed.disp = { w: Math.max(1, Math.round(r.width * s)), h: Math.max(1, Math.round(r.height * s)) };
  const c = $('edCanvas'), dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.round(ed.disp.w * dpr); c.height = Math.round(ed.disp.h * dpr);
  c.style.width = ed.disp.w + 'px'; c.style.height = ed.disp.h + 'px';
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(r, 0, 0, c.width, c.height);
  $('stageInner').style.width = ed.disp.w + 'px'; $('stageInner').style.height = ed.disp.h + 'px';
  placeCrop();
}
function placeCrop() {
  const b = $('cropBox'), c = ed.crop, d = ed.disp;
  b.style.left = c.x * d.w + 'px'; b.style.top = c.y * d.h + 'px';
  b.style.width = c.w * d.w + 'px'; b.style.height = c.h * d.h + 'px';
}

/* fraction-space ratio: w_frac / h_frac that gives the pixel ratio R */
const fracRatio = (R) => (R * ed.rotated.height) / ed.rotated.width;
function fitRatio() {
  const rf = fracRatio(ed.ratio);
  let w = 1, h = w / rf; if (h > 1) { h = 1; w = rf; }
  ed.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}
function setRatio(R) { ed.ratio = R; if (R) fitRatio(); placeCrop(); drawRatios(); syncSize(); }

/* crop dragging */
let drag = null;
$('stage').addEventListener('pointerdown', (e) => {
  if (!ed.rotated) return;
  const h = e.target.dataset && e.target.dataset.h;
  if (!h && e.target !== $('cropBox')) return;
  e.preventDefault();
  drag = { h: h || 'move', x0: e.clientX, y0: e.clientY, c0: { ...ed.crop } };
  $('stage').setPointerCapture(e.pointerId);
});
$('stage').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.x0) / ed.disp.w, dy = (e.clientY - drag.y0) / ed.disp.h, c0 = drag.c0, MIN = 0.03;
  if (drag.h === 'move') {
    ed.crop = { ...c0, x: Math.min(1 - c0.w, Math.max(0, c0.x + dx)), y: Math.min(1 - c0.h, Math.max(0, c0.y + dy)) };
  } else {
    const west = drag.h.includes('w'), north = drag.h.includes('n');
    const ax = west ? c0.x + c0.w : c0.x, ay = north ? c0.y + c0.h : c0.y; // anchor = opposite corner
    let w = Math.max(MIN, west ? c0.w - dx : c0.w + dx), h = Math.max(MIN, north ? c0.h - dy : c0.h + dy);
    const maxW = west ? ax : 1 - ax, maxH = north ? ay : 1 - ay;
    w = Math.min(w, maxW); h = Math.min(h, maxH);
    if (ed.ratio) {
      const rf = fracRatio(ed.ratio);
      h = w / rf; if (h > maxH) { h = maxH; w = h * rf; }
    }
    ed.crop = { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
  }
  placeCrop(); syncSize();
});
['pointerup', 'pointercancel'].forEach((ev) => $('stage').addEventListener(ev, () => { drag = null; }));

/* sizes */
function cropDims() { const p = cropPx({ crop: ed.crop }, ed.rotated.width, ed.rotated.height); return p; }
function syncSize(from) {
  if (!ed.rotated) return;
  const p = cropDims(), o = outSize({ scaleX: ed.sx, scaleY: ed.sy }, p.w, p.h);
  if (from !== 'w') $('outW').value = o.w;
  if (from !== 'h') $('outH').value = o.h;
  $('cropInfo').innerHTML = `منطقة القص <span class="num">${p.w}×${p.h}</span>`;
  const up = ed.sx > 1.001 || ed.sy > 1.001, stretched = Math.abs(ed.sx - ed.sy) > 0.005;
  let note = `الأصل <span class="num">${ed.src.width}×${ed.src.height}</span> ← الناتج <span class="num">${o.w}×${o.h}</span>`;
  if (up) note += '. التكبير يجعل الصورة أكبر لكنه لا يضيف تفاصيل جديدة.';
  if (stretched) note += ' النسبة غير مقفولة، فستتمدد الصورة.';
  $('sizeNote').innerHTML = note;
  $('lockBtn').setAttribute('aria-pressed', String(ed.lock));
  drawPcts();
}
$('outW').addEventListener('input', () => {
  const v = +$('outW').value; if (!v || !ed.rotated) return;
  const p = cropDims(); ed.sx = Math.min(v, MAXSIDE) / p.w; if (ed.lock) ed.sy = ed.sx; syncSize('w');
});
$('outH').addEventListener('input', () => {
  const v = +$('outH').value; if (!v || !ed.rotated) return;
  const p = cropDims(); ed.sy = Math.min(v, MAXSIDE) / p.h; if (ed.lock) ed.sx = ed.sy; syncSize('h');
});
$('lockBtn').onclick = () => { ed.lock = !ed.lock; if (ed.lock) ed.sy = ed.sx; syncSize(); };
$('rotL').onclick = () => { ed.rot -= 90; refreshRotation(true); };
$('rotR').onclick = () => { ed.rot += 90; refreshRotation(true); };
$('edReset').onclick = () => { ed.rot = 0; ed.ratio = null; ed.sx = ed.sy = 1; ed.lock = true; refreshRotation(true); };
$('edCancel').onclick = closeEditor;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('editor').hidden) closeEditor(); });
$('editor').addEventListener('click', (e) => { if (e.target === $('editor')) closeEditor(); });
window.addEventListener('resize', () => { if (ed.rotated && !$('editor').hidden) layoutStage(); });

$('edSave').onclick = () => {
  const item = ed.item; if (!item) return;
  const c = ed.crop, full = c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999;
  const identity = full && (((ed.rot % 360) + 360) % 360) === 0 && Math.abs(ed.sx - 1) < 0.001 && Math.abs(ed.sy - 1) < 0.001;
  if (identity) { item.edit = null; item.editThumb = null; }
  else {
    item.edit = { rot: ed.rot, crop: { ...c }, scaleX: ed.sx, scaleY: ed.sy, ratio: ed.ratio };
    const out = applyEdit(ed.src, item.edit);
    item.editDims = { w: out.width, h: out.height };
    const t = resizeTo(out, Math.max(1, Math.round((out.width * 120) / Math.max(out.width, out.height))), Math.max(1, Math.round((out.height * 120) / Math.max(out.width, out.height))));
    item.editThumb = t.toDataURL('image/png');
  }
  closeEditor(); renderQueue();
};

updateDpiLabels();
