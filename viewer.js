'use strict';
/* Output preview + download / save-to-photos / share. Loaded after app.js and editor.js. */

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PHOTO_TYPES = /^image\/(jpeg|png|gif|webp|avif)$/;
const isPhoto = (r) => PHOTO_TYPES.test(r.blob.type);
const fileOf = (r) => (r.file ||= new File([r.blob], r.name, { type: r.blob.type }));
function canShareFiles(files) {
  try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files })); } catch { return false; }
}

const ICONS = {
  download: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  photo: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4.5 17.5l5-5 3.5 3.5 2.5-2.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M7 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

/* ---------- actions ---------- */
function download(r) {
  const a = document.createElement('a'); a.href = r.url; a.download = r.name;
  document.body.appendChild(a); a.click(); a.remove();
}
async function shareFiles(list, hint) {
  const files = list.map(fileOf);
  if (!canShareFiles(files)) { toast('المشاركة غير مدعومة في هذا المتصفح. استخدم التنزيل بدلاً منها.'); return; }
  if (hint) toast(hint);
  try { await navigator.share({ files }); }
  catch (e) { if (e.name !== 'AbortError') toast('تعذّرت المشاركة. جرّب التنزيل.'); }
}
function saveToPhotos(list) {
  list = list.filter(isPhoto);
  if (!list.length) return;
  if (IS_IOS && canShareFiles(list.map(fileOf))) {
    shareFiles(list, list.length === 1 ? 'اختر «حفظ الصورة» من القائمة.' : `اختر «حفظ ${list.length} صور» من القائمة.`);
    return;
  }
  list.forEach((r, i) => setTimeout(() => download(r), i * 350));
  toast(list.length === 1 ? 'حُفظت في التنزيلات، وتظهر في معرض الصور.' : `حُفظت ${list.length} صور في التنزيلات، وتظهر في معرض الصور.`);
}

function actionButton(kind, label, onClick, withText) {
  const b = document.createElement('button'); b.type = 'button';
  b.className = withText ? 'act wide-act act-' + kind : 'act act-' + kind;
  b.innerHTML = ICONS[kind] + (withText ? `<span>${label}</span>` : '');
  b.setAttribute('aria-label', label); if (!withText) b.title = label;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}
/* buttons for one result; withText = labelled (viewer bar), otherwise icon-only (list row) */
function resultActions(r, withText) {
  const out = [actionButton('download', 'تنزيل', () => download(r), withText)];
  if (isPhoto(r)) out.push(actionButton('photo', 'حفظ في الصور', () => saveToPhotos([r]), withText));
  if (canShareFiles([fileOf(r)])) out.push(actionButton('share', 'مشاركة', () => shareFiles([r]), withText));
  return out;
}

/* bulk row above the results list */
function renderBulk() {
  const box = $('bulk'); box.innerHTML = '';
  const rs = state.results;
  if (rs.length < 2) { box.hidden = true; return; }
  const photos = rs.filter(isPhoto);
  if (photos.length) box.appendChild(actionButton('photo', photos.length === rs.length ? 'حفظ الكل في الصور' : `حفظ ${photos.length} صور في الصور`, () => saveToPhotos(photos), true));
  if (canShareFiles(rs.map(fileOf))) box.appendChild(actionButton('share', 'مشاركة الكل', () => shareFiles(rs), true));
  box.hidden = !box.children.length;
}

/* ---------- viewer ---------- */
const view = { i: 0, token: 0 };
function openViewer(i) {
  view.i = i; $('viewer').hidden = false; document.body.classList.add('locked');
  showCurrent();
}
function closeViewer() { view.token++; $('viewer').hidden = true; document.body.classList.remove('locked'); $('vBody').innerHTML = ''; }

async function showCurrent() {
  const rs = state.results, r = rs[view.i]; if (!r) return closeViewer();
  const token = ++view.token;
  $('vName').textContent = r.name;
  const dims = r.w ? `<span class="num">${r.w}×${r.h}</span> · ` : r.pages ? `${r.pages} ${r.pages === 1 ? 'صفحة' : 'صفحات'} · ` : '';
  $('vMeta').innerHTML = dims + `<span class="num">${fmtSize(r.blob.size)}</span>`;
  $('vCount').textContent = rs.length > 1 ? `${view.i + 1} من ${rs.length}` : '';
  $('vPrev').hidden = $('vNext').hidden = rs.length < 2;
  $('vPrev').disabled = view.i === 0; $('vNext').disabled = view.i === rs.length - 1;
  const bar = $('vActions'); bar.innerHTML = ''; resultActions(r, true).forEach((b) => bar.appendChild(b));

  const body = $('vBody'); body.innerHTML = '<p class="small vwait">جارٍ تجهيز المعاينة…</p>';
  try {
    if (r.blob.type === 'application/pdf') await previewPdf(r, body, token);
    else if (r.blob.type === 'image/tiff') previewTiff(r, body);
    else {
      const img = new Image(); img.alt = r.name; img.className = 'vimg'; img.src = r.url;
      await img.decode().catch(() => {});
      if (token !== view.token) return;
      body.innerHTML = ''; body.appendChild(img);
    }
  } catch (e) {
    console.error(e);
    if (token === view.token) body.innerHTML = '<p class="small vwait">لا يمكن معاينة هذا الملف هنا، لكن تقدر تنزّله أو تشاركه.</p>';
  }
}

async function previewTiff(r, body) {
  const buf = await r.blob.arrayBuffer();
  const ifd = UTIF.decode(buf)[0]; UTIF.decodeImage(buf, ifd);
  const rgba = UTIF.toRGBA8(ifd), c = document.createElement('canvas');
  c.width = ifd.width; c.height = ifd.height; c.className = 'vimg';
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), c.width, c.height), 0, 0);
  body.innerHTML = ''; body.appendChild(c);
}

const PDF_PREVIEW_MAX = 30;
async function previewPdf(r, body, token) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await r.blob.arrayBuffer()) }).promise;
  if (token !== view.token) { pdf.destroy(); return; }
  body.innerHTML = '';
  const width = Math.min(body.clientWidth || 360, 900), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const n = Math.min(pdf.numPages, PDF_PREVIEW_MAX);
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const vp1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (width / vp1.width) * dpr });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); c.className = 'vpage';
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    body.appendChild(c);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (token !== view.token) { pdf.destroy(); return; }
  }
  if (pdf.numPages > n) {
    const more = document.createElement('p'); more.className = 'small vwait';
    more.textContent = `تعرض المعاينة أول ${n} صفحة من ${pdf.numPages}. الملف المحفوظ يحتوي كل الصفحات.`;
    body.appendChild(more);
  }
  pdf.destroy();
}

$('vClose').onclick = closeViewer;
$('vPrev').onclick = () => { if (view.i > 0) { view.i--; showCurrent(); } };
$('vNext').onclick = () => { if (view.i < state.results.length - 1) { view.i++; showCurrent(); } };
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) closeViewer(); });
document.addEventListener('keydown', (e) => {
  if ($('viewer').hidden) return;
  if (e.key === 'Escape') closeViewer();
  // RTL: the right arrow goes back, the left arrow goes forward
  if (e.key === 'ArrowRight') $('vPrev').click();
  if (e.key === 'ArrowLeft') $('vNext').click();
});
/* swipe between results on touch screens */
let sx = null;
$('vBody').addEventListener('touchstart', (e) => { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
$('vBody').addEventListener('touchend', (e) => {
  if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null;
  if (Math.abs(dx) < 60) return;
  dx > 0 ? $('vNext').click() : $('vPrev').click(); // RTL: swipe right = next
});
