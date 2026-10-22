/**
 * The keyboard shortcuts' help sheet (round 8f, ADR-107), opened with `?`: a centred dialog that
 * lists every key (lib/keys.ts). Also the hint a control shows for its key (`title`).
 */
import { Sheet } from '../components/ui';
import { SHORTCUTS } from '../lib/keys';

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts" testId="shortcuts-sheet" className="sheet-keys" dock={false}>
      {SHORTCUTS.map((g) => (
        <section key={g.group} className="keys-group" aria-labelledby={`keys-${g.group}`}>
          <h3 id={`keys-${g.group}`}>{g.group}</h3>
          <dl className="keys-list">
            {g.keys.map((x) => (
              <div key={x.what} className="keys-row">
                <dt>
                  {x.k.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{x.what}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="caption">Keys work when no field has the cursor and no sheet covers the screen.</p>
    </Sheet>
  );
}
