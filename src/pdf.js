import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, degrees } from 'pdf-lib';
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
  return canvas;
}

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
    out.addPage(copied);
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
