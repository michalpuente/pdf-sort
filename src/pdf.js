import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { jpegOrientation } from './exif.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const THUMB_WIDTH = 300;
// Share of "ink" pixels below which a page counts as blank; a single short line of text is ~0.4%
const BLANK_INK_RATIO = 0.002;

export function openPdf(bytes, password) {
  // pdf.js transfers (detaches) the buffer it gets, so hand it a copy and keep the original for pdf-lib
  return pdfjs.getDocument({ data: bytes.slice(), password }).promise;
}

// Renders a page to a canvas that fits within width/height (either may be omitted)
export async function renderPage(doc, pageNumber, { width, height, rotation = 0 }) {
  const page = await doc.getPage(pageNumber);
  const rot = (page.rotate + rotation) % 360;
  const base = page.getViewport({ scale: 1, rotation: rot });
  const scale = Math.min(width ? width / base.width : Infinity, height ? height / base.height : Infinity);
  const viewport = page.getViewport({ scale, rotation: rot });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 'print' intent skips requestAnimationFrame, which never fires in a background tab and would stall loading
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  // kept for mapping clicks on the canvas back to PDF coordinates (eraser)
  canvas.viewport = viewport;
  return canvas;
}

// Paints erased areas ([{ pdf: [x1, y1, x2, y2], color: '#rrggbb' }], PDF user space) onto a rendered canvas
export function paintMasks(canvas, masks) {
  const ctx = canvas.getContext('2d');
  for (const m of masks ?? []) {
    const [x1, y1, x2, y2] = canvas.viewport.convertToViewportRectangle(m.pdf);
    ctx.fillStyle = m.color;
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  }
  return canvas;
}

// Paper colour around a rectangle (canvas pixels): per-channel median of a ring just outside it.
// Scans are rarely pure white, so a white patch would show as a visible box.
export function sampleBackground(canvas, [x, y, w, h], ring = 8) {
  const x0 = Math.max(0, Math.floor(x - ring)), y0 = Math.max(0, Math.floor(y - ring));
  const x1 = Math.min(canvas.width, Math.ceil(x + w + ring)), y1 = Math.min(canvas.height, Math.ceil(y + h + ring));
  if (x1 <= x0 || y1 <= y0) return '#ffffff';
  const data = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const ch = [[], [], []];
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      if (xx >= x && xx < x + w && yy >= y && yy < y + h) continue;
      const j = ((yy - y0) * (x1 - x0) + (xx - x0)) * 4;
      ch[0].push(data[j]); ch[1].push(data[j + 1]); ch[2].push(data[j + 2]);
    }
  }
  if (!ch[0].length) return '#ffffff';
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return '#' + ch.map((a) => med(a).toString(16).padStart(2, '0')).join('');
}

// Fresh thumbnail of a page with its erased areas painted in
export async function maskedThumbnail(doc, pageNumber, masks) {
  const canvas = await renderPage(doc, pageNumber, { width: THUMB_WIDTH });
  return paintMasks(canvas, masks).toDataURL('image/jpeg', 0.75);
}

// Tilt of a scanned page in degrees, counter-clockwise as seen on screen (0 when it can't tell).
// Projection profile: text lines give the sharpest row histogram when the projection angle matches their tilt.
export async function detectSkew(doc, pageNumber, maxAngle = 5) {
  const canvas = await renderPage(doc, pageNumber, { width: 1000 });
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const hist = new Uint32Array(256);
  const lum = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
    lum[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    hist[lum[i]]++;
  }
  // paper = the bright tone covering most of the page; it also fills the corners uncovered by straightening
  let acc = 0, bg = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= lum.length * 0.4) { bg = v; break; }
  }
  const paperPx = [0, 0, 0];
  let paperN = 0;
  for (let i = 0, j = 0; i < lum.length; i += 7, j += 28) {
    if (Math.abs(lum[i] - bg) <= 6) { paperPx[0] += data[j]; paperPx[1] += data[j + 1]; paperPx[2] += data[j + 2]; paperN++; }
  }
  const paper = paperN ? '#' + paperPx.map((v) => Math.round(v / paperN).toString(16).padStart(2, '0')).join('') : '#ffffff';
  // ink points, skipping the margins (scanner edges, punch holes)
  const mx = Math.round(w * 0.04), my = Math.round(h * 0.04);
  const xs = [], ys = [];
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) if (lum[y * w + x] < bg - 60) { xs.push(x); ys.push(y); }
  if (xs.length < 300 || bg < 120) return { angle: 0, paper };
  const step = Math.max(1, Math.floor(xs.length / 60000));
  const bins = new Float64Array(h * 2 + w);
  const score = (deg) => {
    const t = (deg * Math.PI) / 180, sn = Math.sin(t), cs = Math.cos(t);
    bins.fill(0);
    for (let i = 0; i < xs.length; i += step) bins[Math.round(ys[i] * cs + xs[i] * sn) + w]++;
    let sq = 0;
    for (let i = 0; i < bins.length; i++) sq += bins[i] * bins[i];
    return sq;
  };
  let best = 0, bestS = score(0);
  for (let a = -maxAngle; a <= maxAngle + 1e-9; a += 0.2) { const sc = score(a); if (sc > bestS) { bestS = sc; best = a; } }
  for (let a = best - 0.2; a <= best + 0.2 + 1e-9; a += 0.02) { const sc = score(a); if (sc > bestS) { bestS = sc; best = a; } }
  // no clear gain over "as is" - flat page, photo or too little text
  if (bestS < score(0) * 1.03) return { angle: 0, paper };
  return { angle: Math.round(best * 100) / 100, paper };
}

const hexRgb = (hex) => rgb(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));

function isBlankCanvas(canvas) {
  const { width: w, height: h } = canvas;
  // Ignore margins - scanners leave dark edges and punch-hole shadows there
  const mx = Math.round(w * 0.06);
  const my = Math.round(h * 0.06);
  const data = canvas.getContext('2d').getImageData(mx, my, w - 2 * mx, h - 2 * my).data;
  const n = data.length / 4;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const l = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    lum[i] = l;
    hist[lum[i]]++;
  }
  // Paper is the dominant bright tone; relative threshold tolerates grey scans and faint bleed-through
  let acc = 0;
  let bg = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * 0.75) {
      bg = v;
      break;
    }
  }
  if (bg < 150) return false; // dark or photographic page - never "blank"
  const cutoff = bg - 40;
  let ink = 0;
  for (let i = 0; i < n; i++) if (lum[i] < cutoff) ink++;
  return ink / n < BLANK_INK_RATIO;
}

export async function renderThumbnails(bytes, onProgress) {
  const doc = await openPdf(bytes);
  const thumbs = [];
  const blank = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.(i, doc.numPages);
      const canvas = await renderPage(doc, i, { width: THUMB_WIDTH });
      blank.push(isBlankCanvas(canvas));
      thumbs.push(canvas.toDataURL('image/jpeg', 0.75));
    }
  } finally {
    await doc.destroy();
  }
  return { thumbs, blank };
}

// Wraps a single image as a one-page PDF so it can be sorted like any other page
export async function imageToPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await PDFDocument.create();
  let img;
  let rotation = 0;
  if (file.type === 'image/jpeg') {
    img = await doc.embedJpg(bytes); // embedded as-is, no quality loss
    rotation = jpegOrientation(bytes);
  } else if (file.type === 'image/png') {
    img = await doc.embedPng(bytes);
  } else {
    // webp/gif/bmp etc. are not embeddable directly - convert losslessly to PNG
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()));
  }
  // Size the page so the long edge matches A4 - keeps photographed documents at a sensible print size
  const s = 842 / Math.max(img.width, img.height);
  const page = doc.addPage([img.width * s, img.height * s]);
  page.drawImage(img, { x: 0, y: 0, width: img.width * s, height: img.height * s });
  if (rotation) page.setRotation(degrees(rotation));
  return doc.save();
}

export async function buildPdf(files, pages) {
  const out = await PDFDocument.create();
  const sources = new Map();
  for (const p of pages) {
    if (!sources.has(p.fileIdx)) {
      sources.set(p.fileIdx, await PDFDocument.load(files[p.fileIdx].bytes, { ignoreEncryption: true }));
    }
    const [copied] = await out.copyPages(sources.get(p.fileIdx), [p.pageIndex]);
    if (p.rotation) copied.setRotation(degrees((copied.getRotation().angle + p.rotation) % 360));
    // Erased areas: filled rectangles drawn over the page (the scan itself stays untouched underneath)
    for (const m of p.masks ?? []) {
      const [x1, y1, x2, y2] = m.pdf;
      copied.drawRectangle({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), color: hexRgb(m.color), borderWidth: 0 });
    }
    if (!p.skew) {
      out.addPage(copied);
      continue;
    }
    // Straightening: the page (with its erased areas) becomes a form drawn rotated about the centre of a page of
    // the same size; the corners it uncovers are filled with the paper colour
    const box = copied.getMediaBox();
    const embedded = await out.embedPage(copied);
    const page = out.addPage([box.width, box.height]);
    const t = (-p.skew * Math.PI) / 180;
    const cx = box.width / 2, cy = box.height / 2;
    page.drawRectangle({ x: 0, y: 0, width: box.width, height: box.height, color: hexRgb(p.paper ?? '#ffffff'), borderWidth: 0 });
    page.drawPage(embedded, {
      x: cx - (cx * Math.cos(t) - cy * Math.sin(t)),
      y: cy - (cx * Math.sin(t) + cy * Math.cos(t)),
      width: box.width,
      height: box.height,
      rotate: degrees(-p.skew),
    });
    page.setRotation(copied.getRotation());
  }
  return out.save();
}

export function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatSize(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}
