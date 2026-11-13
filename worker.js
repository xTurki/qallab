'use strict';
/* Heavy work off the main thread: PNG / GIF / TIFF / BMP encoding and all pdf-lib work.
   The page talks to it through W.call(op, args) in app.js; terminating the worker is how "cancel" stops a long job. */
self.window = self; // UPNG looks for window.UZIP
importScripts('lib/pako.min.js', 'lib/UPNG.js');
let pdfReady = false;
function needPdf() { if (!pdfReady) { importScripts('lib/pdf-lib.min.js'); pdfReady = true; } return PDFLib; }

/* ---------- byte sink that grows ---------- */
function sink(size) {
  let buf = new Uint8Array(size), n = 0;
  const room = (k) => { if (n + k > buf.length) { const b = new Uint8Array(Math.max(buf.length * 2, n + k)); b.set(buf); buf = b; } };
  return {
    u8(v) { room(1); buf[n++] = v; },
    u16(v) { room(2); buf[n++] = v & 255; buf[n++] = (v >> 8) & 255; },
    bytes(a) { room(a.length); buf.set(a, n); n += a.length; },
    done() { return buf.slice(0, n); },
  };
}
const isOpaque = (d) => { for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false; return true; };

/* ---------- PNG ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(a, start, end) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC[(c ^ a[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(out, type, data) {
  const len = data.length, b = new Uint8Array(len + 12), v = new DataView(b.buffer);
  v.setUint32(0, len); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(data, 8); v.setUint32(8 + len, crc32(b, 4, 8 + len)); out.bytes(b);
}
/* Truecolour PNG with a per-row adaptive filter (smallest sum of absolute differences) and strong deflate.
   Drops the alpha channel when every pixel is opaque, which the browser's own encoder does not do. */
function pngTruecolor(rgba, w, h) {
  const bpp = isOpaque(rgba) ? 3 : 4, row = w * bpp, raw = new Uint8Array((row + 1) * h);
  const cur = new Uint8Array(row), prev = new Uint8Array(row), cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(row));
  const [c0, c1, c2, c3, c4] = cand, cost = (f) => (f < 128 ? f : 256 - f);
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w * 4, o = 0; x < w; x++, i += 4) { cur[o++] = rgba[i]; cur[o++] = rgba[i + 1]; cur[o++] = rgba[i + 2]; if (bpp === 4) cur[o++] = rgba[i + 3]; }
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = cur[x];
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c), pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const f1 = (v - a) & 255, f2 = (v - b) & 255, f3 = (v - ((a + b) >> 1)) & 255, f4 = (v - pr) & 255;
      c0[x] = v; c1[x] = f1; c2[x] = f2; c3[x] = f3; c4[x] = f4;
      s0 += cost(v); s1 += cost(f1); s2 += cost(f2); s3 += cost(f3); s4 += cost(f4);
    }
    const sums = [s0, s1, s2, s3, s4];
    let best = 0; for (let k = 1; k < 5; k++) if (sums[k] < sums[best]) best = k;
    const o = y * (row + 1); raw[o] = best; raw.set(cand[best], o + 1);
    prev.set(cur);
  }
  const out = sink(raw.length / 2 + 1024);
  out.bytes([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = bpp === 3 ? 2 : 6;
  pngChunk(out, 'IHDR', ihdr);
  pngChunk(out, 'IDAT', pako.deflate(raw, { level: raw.length > 24e6 ? 6 : 9, memLevel: 9 }));
  pngChunk(out, 'IEND', new Uint8Array(0));
  return out.done();
}
function encodePNG(rgba, w, h, colors) {
  if (colors) return new Uint8Array(UPNG.encode([rgba.buffer], w, h, colors)); // lossy: adaptive palette
  let best = pngTruecolor(rgba, w, h);
  if (w * h <= 2e6) { // small enough to also try UPNG's palette / greyscale / all-filter search
    const alt = new Uint8Array(UPNG.encode([rgba.buffer], w, h, 0));
    if (alt.length < best.length) best = alt;
  }
  return best;
}

/* ---------- GIF89a: adaptive 256-colour palette (median cut + k-means from UPNG) and LZW ---------- */
function encodeGIF(rgba, w, h) {
  const q = UPNG.quantize(rgba.buffer, 256), idx = q.inds, pal = q.plte;
  const out = sink(idx.length / 2 + 1024);
  out.bytes([71, 73, 70, 56, 57, 97]); out.u16(w); out.u16(h); out.bytes([0xf7, 0, 0]);
  for (let i = 0; i < 256; i++) { const c = i < pal.length ? pal[i].est.rgba : 0; out.bytes([c & 255, (c >> 8) & 255, (c >> 16) & 255]); }
  out.u8(0x2c); out.u16(0); out.u16(0); out.u16(w); out.u16(h); out.u8(0);
  const minCode = 8; out.u8(minCode);
  const clear = 256, eoi = 257;
  let size = minCode + 1, next = 258, dict = new Map(), cur = 0, nbits = 0;
  const block = new Uint8Array(255); let bn = 0;
  const byte = (b) => { block[bn++] = b; if (bn === 255) { out.u8(255); out.bytes(block); bn = 0; } };
  const emit = (code) => { cur |= code << nbits; nbits += size; while (nbits >= 8) { byte(cur & 255); cur >>>= 8; nbits -= 8; } };
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
  emit(prefix); emit(eoi); if (nbits > 0) byte(cur & 255);
  if (bn) { out.u8(bn); out.bytes(block.subarray(0, bn)); }
  out.u8(0); out.u8(0x3b);
  return out.done();
}

/* ---------- TIFF: Deflate with the horizontal predictor; RGB when opaque, RGBA otherwise ---------- */
function encodeTIFF(rgba, w, h) {
  const spp = isOpaque(rgba) ? 3 : 4, row = w * spp, data = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    let o = y * row, i = y * w * 4; const p = [0, 0, 0, 0];
    for (let x = 0; x < w; x++, i += 4) for (let s = 0; s < spp; s++) { const v = rgba[i + s]; data[o++] = (v - p[s]) & 255; p[s] = v; }
  }
  const z = pako.deflate(data, { level: 6 });
  const tags = [[256, 4, 1, w], [257, 4, 1, h], [258, 3, spp, null], [259, 3, 1, 8], [262, 3, 1, 2], [273, 4, 1, 8], [277, 3, 1, spp],
    [278, 4, 1, h], [279, 4, 1, z.length], [284, 3, 1, 1], [317, 3, 1, 2]];
  if (spp === 4) tags.push([338, 3, 1, 2]);
  const bitsAt = 8 + z.length + (z.length & 1), ifdAt = bitsAt + spp * 2;
  const buf = new Uint8Array(ifdAt + 2 + tags.length * 12 + 4), v = new DataView(buf.buffer);
  buf[0] = buf[1] = 0x49; v.setUint16(2, 42, true); v.setUint32(4, ifdAt, true);
  buf.set(z, 8);
  for (let s = 0; s < spp; s++) v.setUint16(bitsAt + s * 2, 8, true);
  v.setUint16(ifdAt, tags.length, true);
  tags.forEach(([tag, type, count, val], k) => {
    const o = ifdAt + 2 + k * 12;
    v.setUint16(o, tag, true); v.setUint16(o + 2, type, true); v.setUint32(o + 4, count, true);
    if (val === null) v.setUint32(o + 8, bitsAt, true); else if (type === 3) v.setUint16(o + 8, val, true); else v.setUint32(o + 8, val, true);
  });
  return buf;
}

/* ---------- BMP, 24-bit ---------- */
function encodeBMP(d, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h, out = new Uint8Array(size), v = new DataView(out.buffer);
  v.setUint16(0, 0x4d42, true); v.setUint32(2, size, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true); v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; out[o++] = d[i + 2]; out[o++] = d[i + 1]; out[o++] = d[i]; }
  }
  return out;
}

/* ---------- PDF ---------- */
const docs = new Map(); let docSeq = 0;
const doc = (id) => { const d = docs.get(id); if (!d) throw new Error('unknown document'); return d; };
async function loadPdf(bytes) {
  try { return await needPdf().PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { if (/encrypt/i.test(e.message)) e.encrypted = true; throw e; }
}
/* An image we can safely re-encode: a plain JPEG stream in RGB or grey, with no decode array and not a mask. */
function isPlainJpeg(dict) {
  const { PDFName, PDFArray } = PDFLib, N = (s) => PDFName.of(s);
  if (dict.lookup(N('Subtype')) !== N('Image') || dict.has(N('Decode')) || dict.has(N('ImageMask'))) return false;
  let f = dict.lookup(N('Filter')); if (f instanceof PDFArray) f = f.size() === 1 ? f.lookup(0) : null;
  if (f !== N('DCTDecode')) return false;
  const cs = dict.lookup(N('ColorSpace'));
  if (cs === N('DeviceRGB') || cs === N('DeviceGray')) return true;
  if (cs instanceof PDFArray && cs.lookup(0) === N('ICCBased')) { const n = cs.lookup(1).dict.lookup(N('N')); return !!n && (n.asNumber() === 3 || n.asNumber() === 1); }
  return false;
}
const OPS = {
  png: ({ rgba, w, h, colors }) => encodePNG(new Uint8Array(rgba), w, h, colors),
  gif: ({ rgba, w, h }) => encodeGIF(new Uint8Array(rgba), w, h),
  tiff: ({ rgba, w, h }) => encodeTIFF(new Uint8Array(rgba), w, h),
  bmp: ({ rgba, w, h }) => encodeBMP(new Uint8Array(rgba), w, h),

  async pdfNew() { const id = ++docSeq; docs.set(id, await needPdf().PDFDocument.create()); return id; },
  async pdfAddJpg({ id, jpg, pw, ph, x, y, w, h }) {
    const d = doc(id), img = await d.embedJpg(new Uint8Array(jpg));
    d.addPage([pw, ph]).drawImage(img, { x, y, width: w, height: h });
  },
  async pdfAppend({ id, bytes }) {
    const d = doc(id), src = await loadPdf(bytes);
    (await d.copyPages(src, src.getPageIndices())).forEach((p) => d.addPage(p));
    return src.getPageCount();
  },
  async pdfSave({ id }) { const d = doc(id); docs.delete(id); return { pages: d.getPageCount(), bytes: await d.save() }; },
  pdfDrop({ id }) { docs.delete(id); },
  /* smart compression, step 1: open the file and hand the page its embedded JPEGs */
  async pdfImages({ bytes, minBytes }) {
    const d = await loadPdf(bytes), { PDFRawStream, PDFName } = PDFLib, images = [];
    for (const [ref, obj] of d.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream) || obj.contents.length < minBytes || !isPlainJpeg(obj.dict)) continue;
      const num = (k) => obj.dict.lookup(PDFName.of(k)).asNumber();
      images.push({ n: ref.objectNumber, g: ref.generationNumber, w: num('Width'), h: num('Height'), jpg: obj.contents.slice() });
    }
    const id = ++docSeq; docs.set(id, d);
    return { id, images };
  },
  /* step 2: swap in the smaller versions and save; text, fonts and vectors are untouched */
  async pdfReplace({ id, list }) {
    const d = doc(id), { PDFRawStream, PDFName, PDFNumber, PDFRef } = PDFLib, N = (s) => PDFName.of(s);
    for (const { n, g, w, h, jpg } of list) {
      const ref = PDFRef.of(n, g), dict = d.context.lookup(ref).dict, data = new Uint8Array(jpg);
      dict.set(N('Width'), PDFNumber.of(w)); dict.set(N('Height'), PDFNumber.of(h));
      dict.set(N('ColorSpace'), N('DeviceRGB')); dict.set(N('BitsPerComponent'), PDFNumber.of(8));
      dict.set(N('Filter'), N('DCTDecode')); dict.delete(N('DecodeParms')); dict.set(N('Length'), PDFNumber.of(data.length));
      d.context.assign(ref, PDFRawStream.of(dict, data));
    }
    docs.delete(id);
    return { pages: d.getPageCount(), bytes: await d.save() };
  },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const res = await OPS[op](args);
    const buf = res instanceof Uint8Array ? res.buffer : res && res.bytes instanceof Uint8Array ? res.bytes.buffer : null;
    self.postMessage({ id, ok: true, res }, buf ? [buf] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, err: { message: String(err && err.message || err), encrypted: !!(err && err.encrypted) } });
  }
};
