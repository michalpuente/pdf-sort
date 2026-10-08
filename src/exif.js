// Minimal EXIF reader: only the Orientation tag, so phone photos can be embedded without re-encoding
// and rotated via the PDF page /Rotate instead.
export function jpegOrientation(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 0;
  let off = 2;
  while (off + 4 < b.length) {
    if (b[off] !== 0xff) return 0;
    const marker = b[off + 1];
    const len = (b[off + 2] << 8) | b[off + 3];
    const isExif = marker === 0xe1 && b[off + 4] === 0x45 && b[off + 5] === 0x78 && b[off + 6] === 0x69 && b[off + 7] === 0x66;
    if (isExif) {
      const t = off + 10; // TIFF header follows "Exif\0\0"
      const le = b[t] === 0x49;
      const u16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
      const u32 = (p) =>
        (le
          ? b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)
          : (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const ifd = t + u32(t + 4);
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x0112) return { 3: 180, 6: 90, 8: 270 }[u16(e + 8)] || 0;
      }
      return 0;
    }
    if (marker === 0xda) return 0; // start of image data - no EXIF before it
    off += 2 + len;
  }
  return 0;
}
