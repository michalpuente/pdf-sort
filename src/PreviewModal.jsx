import { useEffect, useRef } from 'react';
import { renderPage } from './pdf.js';

export default function PreviewModal({ files, pages, index, getDoc, onClose, onNavigate, onRotate }) {
  const hostRef = useRef(null);
  const p = pages[index];

  useEffect(() => {
    if (!p) return;
    let stale = false;
    (async () => {
      const doc = await getDoc(p.fileIdx);
      const dpr = window.devicePixelRatio || 1;
      const canvas = await renderPage(doc, p.pageIndex + 1, {
        width: window.innerWidth * 0.92 * dpr,
        height: (window.innerHeight - 120) * dpr,
        rotation: p.rotation,
      });
      if (stale) return;
      canvas.style.width = `${canvas.width / dpr}px`;
      hostRef.current?.replaceChildren(canvas);
    })();
    return () => {
      stale = true;
    };
  }, [p?.id, p?.rotation]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && index < pages.length - 1) onNavigate(index + 1);
      else if (e.key.toLowerCase() === 'r') onRotate(p.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
        <button onClick={onClose}>✕ Zamknij</button>
      </div>
      <div className="preview-page" ref={hostRef} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
