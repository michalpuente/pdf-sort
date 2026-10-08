import { useEffect, useMemo, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import { buildPdf, downloadBytes, formatSize, openPdf, renderPage } from './pdf.js';
import { splitParts } from './model.js';

const PRESETS = {
  none: { label: 'Bez zmian', hint: 'Strony kopiowane 1:1, w przeglądarce, natychmiast.' },
  lossless: {
    label: 'Bezstratny',
    hint: 'Porządki w strukturze i bezstratna kompresja obrazów. Piksele pozostają identyczne.',
    opts: { dpi: 0, gray: false, quality: 'high', ocr: false, deskew: false, rotate: false, pdfa: false },
  },
  archive: {
    label: 'Archiwum',
    hint: 'Maks. 300 DPI, wysoka jakość, OCR (przeszukiwalny tekst), format PDF/A.',
    opts: { dpi: 300, gray: false, quality: 'high', ocr: true, deskew: false, rotate: false, pdfa: true },
  },
  small: {
    label: 'Mały',
    hint: 'Maks. 200 DPI, odcienie szarości - do maila. Tekst dalej ostry.',
    opts: { dpi: 200, gray: true, quality: 'medium', ocr: false, deskew: false, rotate: false, pdfa: false },
  },
};

const SCOPES = [
  ['all', 'Wszystkie strony - jeden plik'],
  ['selected', 'Tylko zaznaczone strony'],
  ['everyN', 'Podziel co N stron'],
  ['blanks', 'Podziel na pustych stronach (puste są separatorami i znikają)'],
  ['ranges', 'Podziel według zakresów'],
];

export default function ExportDialog({ files, pages, selected, isBlank, outName, setOutName, backend, onClose }) {
  const [scope, setScope] = useState(selected.size > 0 ? 'selected' : 'all');
  const [everyN, setEveryN] = useState(2);
  const [ranges, setRanges] = useState('');
  const [preset, setPreset] = useState('none');
  const [opts, setOpts] = useState(PRESETS.lossless.opts);
  const [strip, setStrip] = useState(false);
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState('form'); // form | working | result
  const [status, setStatus] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [results, setResults] = useState([]);
  const [comparing, setComparing] = useState(null);
  const abortRef = useRef(null);

  const { parts, error: splitError } = useMemo(
    () => splitParts(scope, pages, { selected, everyN, ranges, isBlank }),
    [scope, pages, selected, everyN, ranges, isBlank]
  );
  const usable = parts?.filter((p) => p.length) ?? [];
  const optimize = preset !== 'none';
  const lossy = optimize && (opts.dpi > 0 || opts.gray || opts.deskew);

  useEffect(() => {
    if (stage !== 'working') return;
    const start = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [stage]);

  const base = outName.replace(/\.pdf$/i, '') || 'dokument';
  const partName = (i) => (usable.length === 1 ? `${base}.pdf` : `${base}_${String(i + 1).padStart(2, '0')}.pdf`);

  function pickPreset(key) {
    setPreset(key);
    if (PRESETS[key].opts) setOpts(PRESETS[key].opts);
  }

  function setOpt(key, value) {
    setOpts((o) => ({ ...o, [key]: value }));
    setPreset('custom');
  }

  async function run() {
    setStage('working');
    setError(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const out = [];
    try {
      for (let i = 0; i < usable.length; i++) {
        const prefix = usable.length > 1 ? `Plik ${i + 1}/${usable.length}: ` : '';
        setStatus(prefix + 'składanie stron…');
        const original = await buildPdf(files, usable[i]);
        let result = original;
        let note = null;
        if (optimize) {
          setStatus(prefix + (opts.ocr ? 'optymalizacja i rozpoznawanie tekstu…' : 'optymalizacja…'));
          const fd = new FormData();
          fd.append('file', new Blob([original], { type: 'application/pdf' }), partName(i));
          fd.append('options', JSON.stringify({ ...opts, strip, password }));
          const res = await fetch('/api/optimize', { method: 'POST', body: fd, signal: abort.signal });
          if (!res.ok) {
            const text = await res.text();
            let msg = text;
            try {
              msg = JSON.parse(text).detail;
            } catch {
              /* plain-text error body */
            }
            throw new Error(msg || res.statusText);
          }
          result = new Uint8Array(await res.arrayBuffer());
          note = res.headers.get('X-Note');
        }
        out.push({ name: partName(i), pages: usable[i].length, original, result, note: note && decodeURIComponent(note) });
      }
      setResults(out);
      setComparing(null);
      setStage('result');
    } catch (err) {
      setError(err.name === 'AbortError' ? 'Anulowano.' : err.message);
      setStage('form');
    }
  }

  function downloadAll() {
    if (results.length === 1) return downloadBytes(results[0].result, results[0].name);
    const zip = zipSync(Object.fromEntries(results.map((r) => [r.name, [r.result, { level: 0 }]])));
    downloadBytes(zip, `${base}.zip`, 'application/zip');
  }

  const totalBefore = results.reduce((s, r) => s + r.original.length, 0);
  const totalAfter = results.reduce((s, r) => s + r.result.length, 0);

  return (
    <div className="overlay" onClick={stage === 'working' ? undefined : onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        {stage === 'form' && (
          <>
            <h2>Zapisz PDF</h2>

            <label>
              Nazwa pliku
              <input value={outName} onChange={(e) => setOutName(e.target.value)} />
            </label>

            <fieldset>
              <legend>Co zapisać</legend>
              {SCOPES.map(([key, label]) => (
                <label key={key} className="check">
                  <input
                    type="radio"
                    name="scope"
                    checked={scope === key}
                    disabled={key === 'selected' && !selected.size}
                    onChange={() => setScope(key)}
                  />
                  {label}
                  {key === 'selected' && selected.size > 0 && ` (${selected.size})`}
                </label>
              ))}
              {scope === 'everyN' && (
                <label className="inline">
                  Stron na plik
                  <input type="number" min="1" value={everyN} onChange={(e) => setEveryN(e.target.value)} />
                </label>
              )}
              {scope === 'ranges' && (
                <label className="inline">
                  Zakresy (każdy to osobny plik)
                  <input placeholder="np. 1-3, 4-7, 8" value={ranges} onChange={(e) => setRanges(e.target.value)} />
                </label>
              )}
              <p className={'hint' + (splitError ? ' error' : '')}>
                {splitError ||
                  (usable.length
                    ? `Powstanie ${usable.length} ${plural(usable.length)}${usable.length > 1 ? ' (spakowane w ZIP)' : ''}.`
                    : 'Brak stron do zapisania.')}
              </p>
            </fieldset>

            <fieldset>
              <legend>Optymalizacja rozmiaru</legend>
              <div className="presets">
                {Object.entries(PRESETS).map(([key, p]) => (
                  <button
                    key={key}
                    className={preset === key ? 'active' : ''}
                    disabled={key !== 'none' && !backend}
                    onClick={() => pickPreset(key)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {!backend && <p className="hint error">Serwis optymalizacji jest niedostępny - uruchom pełny docker compose.</p>}
              <p className="hint">{preset === 'custom' ? 'Ustawienia własne.' : PRESETS[preset].hint}</p>

              {optimize && (
                <div className="opts">
                  <label className="inline">
                    Maks. rozdzielczość obrazów
                    <select value={opts.dpi} onChange={(e) => setOpt('dpi', +e.target.value)}>
                      <option value={0}>bez zmian</option>
                      <option value={300}>300 DPI</option>
                      <option value={200}>200 DPI</option>
                      <option value={150}>150 DPI</option>
                    </select>
                  </label>
                  <label className="inline">
                    Jakość zmienianych obrazów
                    <select
                      value={opts.quality}
                      disabled={!opts.dpi && !opts.gray}
                      onChange={(e) => setOpt('quality', e.target.value)}
                    >
                      <option value="high">wysoka</option>
                      <option value="medium">średnia</option>
                    </select>
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={opts.gray} onChange={(e) => setOpt('gray', e.target.checked)} />
                    Odcienie szarości (usuwa kolor)
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={opts.ocr} onChange={(e) => setOpt('ocr', e.target.checked)} />
                    OCR - rozpoznawanie tekstu (polski + angielski), plik będzie przeszukiwalny
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={opts.rotate} onChange={(e) => setOpt('rotate', e.target.checked)} />
                    Automatyczny obrót stron według kierunku tekstu
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={opts.deskew} onChange={(e) => setOpt('deskew', e.target.checked)} />
                    Prostowanie krzywo zeskanowanych stron (przelicza obraz strony)
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={opts.pdfa} onChange={(e) => setOpt('pdfa', e.target.checked)} />
                    PDF/A - format do długoterminowej archiwizacji
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={strip && !opts.pdfa}
                      disabled={opts.pdfa}
                      onChange={(e) => setStrip(e.target.checked)}
                    />
                    Usuń metadane (autor, program, daty){opts.pdfa && ' - niedostępne z PDF/A'}
                  </label>
                  <label className="inline">
                    Hasło do otwarcia pliku {opts.pdfa && '(niedostępne z PDF/A)'}
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="bez hasła"
                      disabled={opts.pdfa}
                      value={opts.pdfa ? '' : password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  {lossy && (
                    <p className="hint warn">
                      Zmniejszanie rozdzielczości, szarość i prostowanie zmieniają obrazy (przy czytaniu zwykle
                      niewidocznie). Po przetworzeniu możesz porównać strony przed i po.
                    </p>
                  )}
                </div>
              )}
            </fieldset>

            {error && <p className="hint error">Błąd: {error}</p>}

            <div className="dialog-actions">
              <button onClick={onClose}>Anuluj</button>
              <button className="primary" disabled={!usable.length || !!splitError} onClick={run}>
                {optimize ? 'Przetwórz' : usable.length > 1 ? 'Zapisz ZIP' : 'Zapisz'}
              </button>
            </div>
          </>
        )}

        {stage === 'working' && (
          <div className="working">
            <div className="spinner" />
            <p>{status}</p>
            <p className="hint">
              {elapsed}s{opts.ocr && optimize ? ' · OCR trwa ok. 1-3 s na stronę' : ''}
            </p>
            <button onClick={() => abortRef.current?.abort()}>Anuluj</button>
          </div>
        )}

        {stage === 'result' && (
          <>
            <h2>Gotowe</h2>
            {optimize && (
              <p className="summary">
                {formatSize(totalBefore)} → <strong>{formatSize(totalAfter)}</strong>{' '}
                <Delta before={totalBefore} after={totalAfter} />
              </p>
            )}
            <table className="results">
              <tbody>
                {results.map((r, i) => (
                  <tr key={r.name}>
                    <td className="rname" title={r.name}>
                      {r.name}
                      {r.note && <div className="hint">{r.note}</div>}
                    </td>
                    <td>{r.pages} str.</td>
                    {optimize && (
                      <td className="rsize">
                        {formatSize(r.original.length)} → {formatSize(r.result.length)}{' '}
                        <Delta before={r.original.length} after={r.result.length} />
                      </td>
                    )}
                    <td className="ractions">
                      {optimize && (
                        <button className={comparing === i ? 'active' : ''} onClick={() => setComparing(comparing === i ? null : i)}>
                          Porównaj
                        </button>
                      )}
                      <button onClick={() => downloadBytes(r.result, r.name)}>Pobierz</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {comparing != null && (
              <Compare
                key={comparing}
                original={results[comparing].original}
                result={results[comparing].result}
                password={password}
                pageCount={results[comparing].pages}
              />
            )}

            <div className="dialog-actions">
              <button onClick={() => setStage('form')}>← Zmień ustawienia</button>
              <button onClick={onClose}>Zamknij</button>
              <button className="primary" onClick={downloadAll}>
                {results.length > 1 ? 'Pobierz wszystko (ZIP)' : 'Pobierz'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function plural(n) {
  if (n === 1) return 'plik';
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'pliki' : 'plików';
}

function Delta({ before, after }) {
  const pct = Math.round((1 - after / before) * 100);
  if (pct > 0) return <span className="delta good">−{pct}%</span>;
  if (pct < 0) return <span className="delta bad">+{-pct}%</span>;
  return <span className="delta">bez zmian</span>;
}

// Side-by-side render of the same page before and after optimisation, with synced scrolling for zoomed inspection
function Compare({ original, result, password, pageCount }) {
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [err, setErr] = useState(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const docs = useMemo(() => [openPdf(original), openPdf(result, password || undefined)], [original, result]);

  useEffect(() => () => docs.forEach((d) => d.then((x) => x.destroy()).catch(() => {})), [docs]);

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const dpr = window.devicePixelRatio || 1;
        const width = leftRef.current.clientWidth * zoom * dpr;
        const canvases = await Promise.all(docs.map(async (d) => renderPage(await d, page, { width })));
        if (stale) return;
        [leftRef, rightRef].forEach((ref, i) => {
          canvases[i].style.width = `${canvases[i].width / dpr}px`;
          ref.current.replaceChildren(canvases[i]);
        });
        setErr(null);
      } catch (e) {
        if (!stale) setErr(e.message);
      }
    })();
    return () => {
      stale = true;
    };
  }, [docs, page, zoom]);

  const sync = (from, to) => () => {
    to.current.scrollTop = from.current.scrollTop;
    to.current.scrollLeft = from.current.scrollLeft;
  };

  return (
    <div className="compare">
      <div className="compare-bar">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ←
        </button>
        <span>
          Strona {page} / {pageCount}
        </span>
        <button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
          →
        </button>
        <span className="spacer" />
        {[1, 2, 4].map((z) => (
          <button key={z} className={zoom === z ? 'active' : ''} onClick={() => setZoom(z)}>
            {z * 100}%
          </button>
        ))}
      </div>
      {err && <p className="hint error">{err}</p>}
      <div className="compare-panes">
        <div>
          <div className="compare-label">Przed</div>
          <div className="compare-pane" ref={leftRef} onScroll={sync(leftRef, rightRef)} />
        </div>
        <div>
          <div className="compare-label">Po</div>
          <div className="compare-pane" ref={rightRef} onScroll={sync(rightRef, leftRef)} />
        </div>
      </div>
    </div>
  );
}
