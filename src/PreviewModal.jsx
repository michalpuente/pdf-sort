import { useEffect, useRef, useState } from 'react';
import { maskedThumbnail, renderPage, sampleBackground } from './pdf.js';

export default function PreviewModal({ files, pages, index, getDoc, onClose, onNavigate, onRotate, onMasks, onSkew, startErasing = false }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const [erasing, setErasing] = useState(startErasing);
  const [draft, setDraft] = useState(null); // rectangle being drawn, CSS pixels: { x0, y0, x1, y1 }
  const [rendered, setRendered] = useState(0); // bumps when a new canvas is in place, so the mask layer re-lays out
  const p = pages[index];
  const masks = p?.masks ?? [];

  useEffect(() => {
    if (!p) return;
    let stale = false;
    (async () => {
      const doc = await getDoc(p.fileIdx);
      const dpr = window.devicePixelRatio || 1;
      const canvas = await renderPage(doc, p.pageIndex + 1, {
        width: window.innerWidth * 0.92 * dpr,
        height: (window.innerHeight - 160) * dpr,
        rotation: p.rotation,
      });
      if (stale) return;
      canvas.style.width = `${canvas.width / dpr}px`;
      canvasRef.current = canvas;
      hostRef.current?.querySelector('canvas')?.remove();
      hostRef.current?.prepend(canvas);
      setRendered((n) => n + 1);
    })();
    return () => {
      stale = true;
    };
  }, [p?.id, p?.rotation]);

  async function saveMasks(next) {
    const doc = await getDoc(p.fileIdx);
    const thumb = next.length ? await maskedThumbnail(doc, p.pageIndex + 1, next) : undefined;
    onMasks(p.id, next, thumb);
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') erasing ? setErasing(false) : onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && index < pages.length - 1) onNavigate(index + 1);
      else if (e.key.toLowerCase() === 'r') onRotate(p.id);
      else if (e.key.toLowerCase() === 'e') setErasing((v) => !v);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && masks.length) {
        e.preventDefault();
        saveMasks(masks.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // pointer position inside the canvas, CSS pixels
  const at = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [Math.max(0, Math.min(r.width, e.clientX - r.left)), Math.max(0, Math.min(r.height, e.clientY - r.top))];
  };
  const onDown = (e) => {
    if (!erasing || !canvasRef.current || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer (e.g. synthetic event) - dragging still works inside the page */
    }
    const [x, y] = at(e);
    setDraft({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMove = (e) => {
    if (!draft) return;
    const [x, y] = at(e);
    setDraft((d) => ({ ...d, x1: x, y1: y }));
  };
  const onUp = () => {
    const d = draft;
    setDraft(null);
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const x = Math.min(d.x0, d.x1) * dpr, y = Math.min(d.y0, d.y1) * dpr;
    const w = Math.abs(d.x1 - d.x0) * dpr, h = Math.abs(d.y1 - d.y0) * dpr;
    if (w < 3 || h < 3) return;
    const [ax, ay] = canvas.viewport.convertToPdfPoint(x, y);
    const [bx, by] = canvas.viewport.convertToPdfPoint(x + w, y + h);
    const mask = { pdf: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], color: sampleBackground(canvas, [x, y, w, h]) };
    saveMasks([...masks, mask]);
  };

  // erased areas laid over the canvas (CSS pixels), so the canvas keeps the original pixels for colour sampling
  const boxes = (() => {
    const canvas = canvasRef.current;
    if (!canvas || !rendered) return [];
    const dpr = canvas.width / parseFloat(canvas.style.width);
    return masks.map((m) => {
      const [x1, y1, x2, y2] = canvas.viewport.convertToViewportRectangle(m.pdf);
      return { left: Math.min(x1, x2) / dpr, top: Math.min(y1, y2) / dpr, width: Math.abs(x2 - x1) / dpr, height: Math.abs(y2 - y1) / dpr, background: m.color };
    });
  })();

  if (!p) return null;
  return (
    <div className="overlay preview" onClick={onClose}>
      <div className="preview-bar" onClick={(e) => e.stopPropagation()}>
        <button disabled={index === 0} onClick={() => onNavigate(index - 1)}>
          ←
        </button>
        <span>
          Strona {index + 1} / {pages.length} · {files[p.fileIdx].name}, s. {p.pageIndex + 1}
        </span>
        <button disabled={index === pages.length - 1} onClick={() => onNavigate(index + 1)}>
          →
        </button>
        <button onClick={() => onRotate(p.id)}>⟳ Obróć</button>
        <span className="skew-ctl" title="Prostowanie: kąt w stopniach">
          📐
          <button onClick={() => onSkew(p.id, Math.round(((p.skew ?? 0) - 0.1) * 100) / 100)}>↺</button>
          <span>{(p.skew ?? 0).toFixed(1)}°</span>
          <button onClick={() => onSkew(p.id, Math.round(((p.skew ?? 0) + 0.1) * 100) / 100)}>↻</button>
          {!!p.skew && <button onClick={() => onSkew(p.id, 0)}>bez</button>}
        </span>
        <button className={erasing ? 'primary' : ''} onClick={() => setErasing((v) => !v)} title="Zaznacz prostokątem, co zamalować kolorem papieru (E)">
          🩹 Gumka{erasing ? ' – włączona' : ''}
        </button>
        <button onClick={onClose}>✕ Zamknij</button>
      </div>
      {(erasing || masks.length > 0) && (
        <div className="preview-bar erase-bar" onClick={(e) => e.stopPropagation()}>
          {erasing ? (
            <span>
              Przeciągnij prostokąt wokół numeru strony – zamaluje się kolorem papieru z otoczenia.
              {!!p.skew && ' (Gumka pokazuje stronę przed wyprostowaniem.)'}
            </span>
          ) : (
            <span>Wymazane fragmenty: {masks.length}</span>
          )}
          {masks.length > 0 && <button onClick={() => saveMasks(masks.slice(0, -1))}>↶ Cofnij ostatni (Ctrl+Z)</button>}
          {masks.length > 1 && <button onClick={() => saveMasks([])}>Przywróć wszystko</button>}
          {masks.length > 0 && (
            <label className="mask-color" title="Kolor ostatniego wymazania – zmień, jeśli odstaje od tła">
              kolor <input type="color" value={masks.at(-1).color} onChange={(e) => saveMasks([...masks.slice(0, -1), { ...masks.at(-1), color: e.target.value }])} />
            </label>
          )}
        </div>
      )}
      <div
        className={'preview-page' + (erasing ? ' erasing' : '')}
        ref={hostRef}
        style={!erasing && p.skew ? { transform: `rotate(${p.skew}deg)` } : undefined}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDraft(null)}
      >
        {boxes.map((b, i) => (
          <div key={i} className="mask" style={b} />
        ))}
        {draft && (
          <div
            className="mask-draft"
            style={{ left: Math.min(draft.x0, draft.x1), top: Math.min(draft.y0, draft.y1), width: Math.abs(draft.x1 - draft.x0), height: Math.abs(draft.y1 - draft.y0) }}
          />
        )}
      </div>
    </div>
  );
}
