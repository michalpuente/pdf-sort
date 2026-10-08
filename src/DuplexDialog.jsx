import { useState } from 'react';
import { interleaveDuplex } from './model.js';

export default function DuplexDialog({ files, onApply, onClose }) {
  const [front, setFront] = useState(0);
  const [back, setBack] = useState(files.length > 1 ? 1 : 'half');
  const [reverse, setReverse] = useState(true);

  function apply() {
    const { result, fronts, backs } = interleaveDuplex(files, { front, back, reverse });
    if (fronts !== backs && !confirm(`Przodów jest ${fronts}, a tyłów ${backs}. Ułożyć mimo to?`)) return;
    onApply(result, files[front].name.replace(/\.pdf$/i, '') + '_dwustronny.pdf');
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Skan dwustronny</h2>
        <p className="hint">
          Najpierw skanujesz przody (1, 3, 5…), potem odwracasz plik kartek i skanujesz tyły, które idą od ostatniej
          (…6, 4, 2). Tutaj zostaną ułożone jako 1, 2, 3, 4…
        </p>
        <label>
          Przody (1, 3, 5…)
          <select value={front} onChange={(e) => setFront(+e.target.value)}>
            {files.map((f, i) => (
              <option key={i} value={i}>
                {f.name} ({f.thumbs.length} str.)
              </option>
            ))}
          </select>
        </label>
        <label>
          Tyły (…6, 4, 2)
          <select value={back} onChange={(e) => setBack(e.target.value === 'half' ? 'half' : +e.target.value)}>
            <option value="half">W tym samym pliku - druga połowa stron</option>
            {files.map((f, i) =>
              i === front ? null : (
                <option key={i} value={i}>
                  {f.name} ({f.thumbs.length} str.)
                </option>
              )
            )}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
          Tyły zeskanowane od ostatniej kartki (odwróć ich kolejność)
        </label>
        <div className="dialog-actions">
          <button onClick={onClose}>Anuluj</button>
          <button className="primary" onClick={apply}>
            Ułóż strony
          </button>
        </div>
      </div>
    </div>
  );
}
