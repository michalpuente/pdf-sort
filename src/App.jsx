import { useEffect, useRef, useState } from 'react';
import { imageToPdf, openPdf, renderThumbnails } from './pdf.js';
import { makePage } from './model.js';
import DuplexDialog from './DuplexDialog.jsx';
import ExportDialog from './ExportDialog.jsx';
import PreviewModal from './PreviewModal.jsx';

const HISTORY_LIMIT = 100;

const isPdf = (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
const isImage = (f) => f.type.startsWith('image/');

export default function App() {
  const [files, setFiles] = useState([]); // [{ name, bytes, thumbs, blank }]
  // Output page list with undo/redo history: [{ id, fileIdx, pageIndex, rotation }]
  const [hist, setHist] = useState({ past: [], present: [], future: [] });
  const pages = hist.present;
  const [selected, setSelected] = useState(new Set());
  const [anchor, setAnchor] = useState(null);
  const [loading, setLoading] = useState(null);
  const [outName, setOutName] = useState('posortowany.pdf');
  // What is being dragged: { kind: 'out', ids } for reordering, { kind: 'lib', fileIdx, pageIndex } from the file panel
  const [drag, setDrag] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { id, after }
  const [fileHover, setFileHover] = useState(false);
  const [dialog, setDialog] = useState(null); // 'duplex' | 'export'
  const [preview, setPreview] = useState(null); // index into pages
  const [backend, setBackend] = useState(false);
  const inputRef = useRef(null);
  const docCache = useRef(new Map());

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setBackend(r.ok))
      .catch(() => setBackend(false));
  }, []);

  function updatePages(fn) {
    setHist((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      return { past: [...h.past.slice(-HISTORY_LIMIT), h.present], present: next, future: [] };
    });
  }
  const undo = () =>
    setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1), future: [h.present, ...h.future] } : h));
  const redo = () =>
    setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));

  const getDoc = (fileIdx) => {
    if (!docCache.current.has(fileIdx)) docCache.current.set(fileIdx, openPdf(files[fileIdx].bytes));
    return docCache.current.get(fileIdx);
  };
  const isBlank = (p) => files[p.fileIdx]?.blank[p.pageIndex];

  async function addFiles(fileList) {
    const accepted = [...fileList].filter((f) => isPdf(f) || isImage(f));
    if (!accepted.length) return;
    const loaded = [];
    const errors = [];
    for (const f of accepted) {
      try {
        setLoading(`Wczytywanie ${f.name}…`);
        const bytes = isPdf(f) ? new Uint8Array(await f.arrayBuffer()) : await imageToPdf(f);
        const { thumbs, blank } = await renderThumbnails(bytes, (i, n) =>
          setLoading(`Wczytywanie ${f.name} (${i}/${n})`)
        );
        loaded.push({ name: f.name, bytes, thumbs, blank, image: !isPdf(f) });
      } catch (err) {
        errors.push(`${f.name}: ${err.message}`);
      }
    }
    setLoading(null);
    if (errors.length) alert('Nie udało się wczytać:\n' + errors.join('\n'));
    if (!loaded.length) return;

    const firstIdx = files.length;
    setFiles((prev) => [...prev, ...loaded]);
    // Sorting a single PDF (or a batch of photos) is the common case - put the pages straight into the output
    if (!pages.length && (loaded.length === 1 || loaded.every((f) => f.image))) {
      updatePages(() => loaded.flatMap((f, k) => f.thumbs.map((_, i) => makePage(firstIdx + k, i))));
      setOutName(loaded[0].name.replace(/\.[^.]+$/, '') + '_posortowany.pdf');
    }
  }

  const addFromLib = (fileIdx, pageIndex) => updatePages((prev) => [...prev, makePage(fileIdx, pageIndex)]);
  const addWholeFile = (fileIdx) =>
    updatePages((prev) => [...prev, ...files[fileIdx].thumbs.map((_, i) => makePage(fileIdx, i))]);
  const addEverything = () =>
    updatePages((prev) => [...prev, ...files.flatMap((f, fi) => f.thumbs.map((_, i) => makePage(fi, i)))]);

  const rotateIds = (ids) =>
    updatePages((prev) => prev.map((p) => (ids.has(p.id) ? { ...p, rotation: (p.rotation + 90) % 360 } : p)));
  const removeIds = (ids) => {
    updatePages((prev) => prev.filter((p) => !ids.has(p.id)));
    setSelected((prev) => new Set([...prev].filter((id) => !ids.has(id))));
  };
  const blankCount = pages.filter(isBlank).length;
  const removeBlanks = () => removeIds(new Set(pages.filter(isBlank).map((p) => p.id)));

  function clearAll() {
    docCache.current.forEach((d) => d.then((x) => x.destroy()).catch(() => {}));
    docCache.current.clear();
    setHist({ past: [], present: [], future: [] });
    setFiles([]);
    setSelected(new Set());
  }

  function onCardClick(e, p) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.shiftKey && anchor != null) {
      const a = pages.findIndex((x) => x.id === anchor);
      const b = pages.findIndex((x) => x.id === p.id);
      if (a >= 0) {
        const ids = pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
        setSelected((prev) => new Set(mod ? [...prev, ...ids] : ids));
        return;
      }
    }
    setAnchor(p.id);
    if (mod) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(p.id) ? next.delete(p.id) : next.add(p.id);
        return next;
      });
    } else {
      setSelected((prev) => (prev.size === 1 && prev.has(p.id) ? new Set() : new Set([p.id])));
    }
  }

  function dropOnto(targetId, after) {
    const d = drag;
    endDrag();
    if (!d) return;
    updatePages((prev) => {
      let moving, rest;
      if (d.kind === 'out') {
        if (d.ids.includes(targetId)) return prev;
        const ids = new Set(d.ids);
        moving = prev.filter((p) => ids.has(p.id));
        rest = prev.filter((p) => !ids.has(p.id));
      } else {
        moving = [makePage(d.fileIdx, d.pageIndex)];
        rest = [...prev];
      }
      const idx = targetId == null ? rest.length : rest.findIndex((p) => p.id === targetId) + (after ? 1 : 0);
      rest.splice(idx, 0, ...moving);
      return rest;
    });
  }

  function endDrag() {
    setDrag(null);
    setDropTarget(null);
  }

  useEffect(() => {
    const onKey = (e) => {
      if (dialog || preview != null || e.target.closest?.('input, textarea, select')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && key === 'a') {
        e.preventDefault();
        setSelected(new Set(pages.map((p) => p.id)));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        removeIds(selected);
      } else if (key === 'r' && !mod && selected.size) {
        rotateIds(selected);
      } else if (e.key === 'Escape') {
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const isFileDrag = (e) => e.dataTransfer.types.includes('Files');
  const usage = (fileIdx, pageIndex) => pages.filter((p) => p.fileIdx === fileIdx && p.pageIndex === pageIndex).length;
  const draggedIds = drag?.kind === 'out' ? new Set(drag.ids) : null;

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (isFileDrag(e)) {
          e.preventDefault();
          setFileHover(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setFileHover(false);
      }}
      onDrop={(e) => {
        if (isFileDrag(e)) {
          e.preventDefault();
          setFileHover(false);
          addFiles(e.dataTransfer.files);
        }
      }}
    >
      <header className="toolbar">
        <h1>PDF Sorter</h1>
        <button onClick={() => inputRef.current.click()}>+ Dodaj pliki</button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button disabled={!files.length || !!loading} onClick={() => setDialog('duplex')}>
          ⇅ Skan dwustronny
        </button>
        <button disabled={!blankCount} onClick={removeBlanks} title="Usuwa strony rozpoznane jako puste">
          Usuń puste ({blankCount})
        </button>
        <button disabled={!hist.past.length} onClick={undo} title="Cofnij (Ctrl+Z)">
          ↶
        </button>
        <button disabled={!hist.future.length} onClick={redo} title="Ponów (Ctrl+Y)">
          ↷
        </button>
        <span className="spacer" />
        <span className="count">{pages.length} stron w nowym pliku</span>
        <button className="primary" disabled={!pages.length || !!loading} onClick={() => setDialog('export')}>
          Zapisz…
        </button>
        <button disabled={!files.length || !!loading} onClick={clearAll}>
          Wyczyść
        </button>
      </header>

      {selected.size > 0 && (
        <div className="selbar">
          Zaznaczono: {selected.size}
          <button onClick={() => rotateIds(selected)}>⟳ Obróć (R)</button>
          <button onClick={() => removeIds(selected)}>✕ Usuń (Del)</button>
          <button onClick={() => setSelected(new Set())}>Odznacz (Esc)</button>
          <span className="hint">Ctrl+klik dodaje, Shift+klik zaznacza zakres, przeciągnięcie przenosi całą grupę</span>
        </div>
      )}

      {loading && <div className="loading">{loading}</div>}

      {dialog === 'duplex' && (
        <DuplexDialog
          files={files}
          onClose={() => setDialog(null)}
          onApply={(result, name) => {
            updatePages(() => result);
            setOutName(name);
            setSelected(new Set());
            setDialog(null);
          }}
        />
      )}

      {dialog === 'export' && (
        <ExportDialog
          files={files}
          pages={pages}
          selected={selected}
          isBlank={isBlank}
          outName={outName}
          setOutName={setOutName}
          backend={backend}
          onClose={() => setDialog(null)}
        />
      )}

      {preview != null && (
        <PreviewModal
          files={files}
          pages={pages}
          index={Math.min(preview, pages.length - 1)}
          getDoc={getDoc}
          onClose={() => setPreview(null)}
          onNavigate={setPreview}
          onRotate={(id) => rotateIds(new Set([id]))}
        />
      )}

      {!files.length ? (
        <div className={'empty' + (fileHover ? ' hover' : '')} onClick={() => inputRef.current.click()}>
          Upuść tutaj pliki PDF lub zdjęcia (JPG, PNG) albo kliknij, żeby wybrać
        </div>
      ) : (
        <div className="layout">
          <aside className="library">
            <div className="lib-head">
              <strong>Wczytane pliki</strong>
              {files.length > 1 && <button onClick={addEverything}>+ wszystko</button>}
            </div>
            <p className="hint">Kliknij stronę, żeby dodać ją na koniec, albo przeciągnij w wybrane miejsce.</p>
            {files.map((f, fi) => (
              <section key={fi} className="lib-file">
                <div className="lib-file-head">
                  <span className="lib-name" title={f.name}>
                    {f.name}
                  </span>
                  <button onClick={() => addWholeFile(fi)}>+ wszystkie</button>
                </div>
                <div className="lib-pages">
                  {f.thumbs.map((thumb, pi) => {
                    const used = usage(fi, pi);
                    return (
                      <div
                        key={pi}
                        className={'lib-page' + (used ? ' used' : '') + (f.blank[pi] ? ' blank' : '')}
                        title={`Strona ${pi + 1}${f.blank[pi] ? ' (pusta)' : ''} - kliknij, żeby dodać`}
                        draggable
                        onClick={() => addFromLib(fi, pi)}
                        onDragStart={(e) => {
                          setDrag({ kind: 'lib', fileIdx: fi, pageIndex: pi });
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onDragEnd={endDrag}
                      >
                        <img src={thumb} alt="" draggable={false} />
                        <span className="lib-num">{pi + 1}</span>
                        {used > 0 && <span className="lib-used">✓{used > 1 ? used : ''}</span>}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </aside>

          <main
            className={'grid' + (fileHover ? ' hover' : '')}
            onClick={(e) => {
              if (e.target === e.currentTarget) setSelected(new Set());
            }}
            onDragOver={(e) => {
              if (drag) e.preventDefault();
            }}
            onDrop={(e) => {
              // Dropping on empty space (not on a card) appends at the end
              if (!drag) return;
              e.preventDefault();
              dropOnto(null, true);
            }}
          >
            {!pages.length && <div className="grid-empty">Kliknij lub przeciągnij strony z lewej</div>}
            {pages.map((p, i) => (
              <div
                key={p.id}
                className={
                  'card' +
                  (selected.has(p.id) ? ' selected' : '') +
                  (draggedIds?.has(p.id) ? ' dragging' : '') +
                  (dropTarget?.id === p.id ? (dropTarget.after ? ' drop-after' : ' drop-before') : '')
                }
                draggable
                onClick={(e) => onCardClick(e, p)}
                onDoubleClick={() => setPreview(i)}
                onDragStart={(e) => {
                  const ids = selected.has(p.id) ? pages.filter((x) => selected.has(x.id)).map((x) => x.id) : [p.id];
                  setDrag({ kind: 'out', ids });
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientX > rect.left + rect.width / 2;
                  if (dropTarget?.id !== p.id || dropTarget.after !== after) setDropTarget({ id: p.id, after });
                }}
                onDrop={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dropOnto(p.id, dropTarget?.after);
                }}
              >
                <div className="thumb">
                  <img
                    src={files[p.fileIdx].thumbs[p.pageIndex]}
                    className={p.rotation % 180 ? 'sideways' : ''}
                    style={{ transform: `rotate(${p.rotation}deg)` }}
                    draggable={false}
                    alt=""
                  />
                </div>
                <div className="meta">
                  <span className="num">{i + 1}</span>
                  <span className="src" title={files[p.fileIdx].name}>
                    {files.length > 1 ? `${files[p.fileIdx].name} · ` : ''}s. {p.pageIndex + 1}
                  </span>
                  {isBlank(p) && <span className="badge-blank">pusta</span>}
                </div>
                <div className="actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  <button title="Podgląd (dwuklik)" onClick={() => setPreview(i)}>
                    🔍
                  </button>
                  <button title="Obróć o 90°" onClick={() => rotateIds(new Set([p.id]))}>
                    ⟳
                  </button>
                  <button title="Usuń stronę" onClick={() => removeIds(new Set([p.id]))}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </main>
        </div>
      )}
    </div>
  );
}
