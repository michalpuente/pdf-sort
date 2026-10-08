let nextId = 1;

export const makePage = (fileIdx, pageIndex) => ({ id: nextId++, fileIdx, pageIndex, rotation: 0 });

// Single-sided feeder scanning of double-sided sheets: first pass yields fronts 1,3,5..., the flipped stack
// yields backs starting from the last sheet (..., 6, 4, 2), so the back list is reversed before interleaving.
export function interleaveDuplex(files, { front, back, reverse }) {
  let fronts, backs;
  if (back === 'half') {
    const n = files[front].thumbs.length;
    const half = Math.ceil(n / 2);
    fronts = [...Array(half).keys()].map((i) => [front, i]);
    backs = [...Array(n - half).keys()].map((i) => [front, half + i]);
  } else {
    fronts = files[front].thumbs.map((_, i) => [front, i]);
    backs = files[back].thumbs.map((_, i) => [back, i]);
  }
  if (reverse) backs.reverse();
  const result = [];
  for (let i = 0; i < Math.max(fronts.length, backs.length); i++) {
    if (fronts[i]) result.push(makePage(...fronts[i]));
    if (backs[i]) result.push(makePage(...backs[i]));
  }
  return { result, fronts: fronts.length, backs: backs.length };
}

// Splits the output page list into the files that will be exported. Returns { parts } or { error }.
export function splitParts(scope, pages, { selected, everyN, ranges, isBlank }) {
  switch (scope) {
    case 'all':
      return { parts: [pages] };
    case 'selected':
      return { parts: [pages.filter((p) => selected.has(p.id))] };
    case 'everyN': {
      const n = Math.max(1, Math.floor(everyN) || 1);
      const parts = [];
      for (let i = 0; i < pages.length; i += n) parts.push(pages.slice(i, i + n));
      return { parts };
    }
    case 'blanks': {
      // Blank pages act as separators between documents and are dropped
      const parts = [[]];
      for (const p of pages) {
        if (isBlank(p)) parts.push([]);
        else parts[parts.length - 1].push(p);
      }
      return { parts: parts.filter((g) => g.length) };
    }
    case 'ranges': {
      const parts = [];
      for (const seg of ranges.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
        const m = seg.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
        if (!m) return { error: `Nie rozumiem zakresu „${seg}”` };
        const a = +m[1];
        const b = m[2] ? +m[2] : a;
        if (a < 1 || b > pages.length || a > b) return { error: `Zakres „${seg}” wykracza poza 1–${pages.length}` };
        parts.push(pages.slice(a - 1, b));
      }
      return { parts };
    }
    default:
      return { parts: [] };
  }
}
