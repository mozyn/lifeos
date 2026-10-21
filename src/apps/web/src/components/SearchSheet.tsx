/**
 * Find and file (spec §11, round-2 brief §8): one search sheet for the whole app, opened from
 * Lists (every segment) and Quick Add. The query is exactly what was typed; categories are Web,
 * Videos, Shopping and Islamic (the preferred sites first). Each result is a card with its title,
 * site, snippet and the engine that found it, and files in one tap into Links, Wishlist, Shopping
 * or Notes (the §5 formats, the title taken from the result). Drop (or a swipe to the left) hides
 * the result for this query for 30 days, with an undo.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check as CheckIcon, Search, X } from 'lucide-react';
import type { SearchCategory } from '@lifeos/shared';
import { Sheet } from './ui';
import { api, ApiError } from '../lib/api';
import { emit, on, toast, useResource, write } from '../lib/store';
import { motionReduced } from '../glass/spring';
import { useGo } from '../shell/context';

interface Result {
  title: string;
  url: string;
  domain: string;
  content: string;
  engine: string | null;
  engines: string[];
  preferred?: boolean;
}

interface Answer {
  query: string;
  category: SearchCategory;
  cached: boolean;
  results: Result[];
  filtered: number;
}

type Where = 'links' | 'wishlist' | 'shopping' | 'notes';

const CATS: { value: SearchCategory; label: string }[] = [
  { value: 'web', label: 'Web' },
  { value: 'videos', label: 'Videos' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'islamic', label: 'Islamic' },
];

const WHERE: { value: Where; label: string; done: string }[] = [
  { value: 'links', label: 'Links', done: 'Saved to Links' },
  { value: 'wishlist', label: 'Wishlist', done: 'Added to the wishlist' },
  { value: 'shopping', label: 'Shopping', done: 'Added to shopping' },
  { value: 'notes', label: 'Notes', done: 'Saved as a note in Inbox' },
];

const ENGINE_LABELS: Record<string, string> = { brave: 'Brave', yahoo: 'Yahoo', yep: 'Yep', wikipedia: 'Wikipedia', youtube: 'YouTube', dailymotion: 'Dailymotion', 'brave.videos': 'Brave Videos' };
export const engineLabel = (e: string | null) => (e ? (ENGINE_LABELS[e] ?? e.replace(/(^|[.\s])\w/g, (m) => m.toUpperCase())) : 'Search');

// ------------------------------------------------------------------ opening it from anywhere

let request: { open: boolean; q: string; cat: SearchCategory; n: number } = { open: false, q: '', cat: 'web', n: 0 };

export function openSearch(o: { q?: string; cat?: SearchCategory } = {}): void {
  request = { open: true, q: o.q ?? '', cat: o.cat ?? 'web', n: request.n + 1 };
  emit('search-sheet');
}

function closeSearch(): void {
  request = { ...request, open: false };
  emit('search-sheet');
}

/** Is web search on (Settings → Privacy)? */
export function useSearchEnabled(): boolean {
  const { data } = useResource<{ settings: { search: boolean } }>('api/settings');
  return data?.settings.search ?? false;
}

export function SearchSheetHost() {
  const r = useSyncExternalStore((cb) => on('search-sheet', cb), () => request);
  return <SearchSheet open={r.open} initialQuery={r.q} initialCat={r.cat} openId={r.n} onClose={closeSearch} />;
}

// ------------------------------------------------------------------ filing

async function file(r: Result, where: Where): Promise<void> {
  const title = r.title.replace(/\s+/g, ' ').trim();
  if (where === 'links') await write({ path: 'api/links', body: { title, url: r.url, tags: [] }, kind: 'link', label: 'Save link' });
  else if (where === 'wishlist') await write({ path: 'api/lists/wishlist/items', body: { text: title, url: r.url }, kind: 'wish', label: 'Add to wishlist' });
  else if (where === 'shopping') await write({ path: 'api/lists/shopping/items', body: { text: title, url: r.url }, kind: 'shop', label: 'Add to shopping' });
  else {
    const body = `[${r.domain || r.url}](${r.url})${r.content ? `\n\n${r.content}` : ''}`;
    await write({ path: 'api/quick', body: { type: 'note', text: title.slice(0, 120), body }, kind: 'quick', label: 'Save as note' });
  }
}

// ------------------------------------------------------------------ one result

/** A card that follows a finger to the left; past a third of its width it is dropped. */
function useSwipe(ref: React.RefObject<HTMLElement | null>, onDrop: () => void) {
  const drop = useRef(onDrop);
  drop.current = onDrop;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let id = -1;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let t0 = 0;
    let swiping = false;
    let frame = 0;
    const place = () => {
      frame = 0;
      el.style.transform = `translate3d(${Math.min(0, dx).toFixed(1)}px, 0, 0)`;
      el.style.opacity = String(1 - Math.min(1, -Math.min(0, dx) / el.offsetWidth) * 0.6);
    };
    const reset = () => {
      el.style.transition = motionReduced() ? '' : 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease-out';
      el.style.transform = '';
      el.style.opacity = '';
      setTimeout(() => (el.style.transition = ''), 280);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      dx = 0;
      t0 = performance.now();
      swiping = false;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (!swiping) {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) {
          id = -1; // a scroll: not ours
          return;
        }
        if (mx < -10 && Math.abs(mx) > Math.abs(my) * 1.3) {
          swiping = true;
          el.dataset.swiping = '';
          el.setPointerCapture?.(id);
        } else return;
      }
      dx = mx;
      if (!frame) frame = requestAnimationFrame(place);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      cancelAnimationFrame(frame);
      frame = 0;
      if (!swiping) return;
      const w = el.offsetWidth;
      const fast = -dx / Math.max(1, performance.now() - t0) > 0.6;
      if (-dx > w / 3 || (fast && -dx > 40)) {
        if (motionReduced()) drop.current();
        else {
          el.style.transition = 'transform 180ms ease-in, opacity 180ms ease-in';
          el.style.transform = `translate3d(${-w - 24}px, 0, 0)`;
          el.style.opacity = '0';
          setTimeout(() => drop.current(), 170);
        }
      } else reset();
      // the click that ends a swipe opens nothing
      const swallow = (c: Event) => {
        c.stopPropagation();
        c.preventDefault();
      };
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
      swiping = false;
      delete el.dataset.swiping;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [ref]);
}

function ResultCard({ r, onDrop, filed, onFile }: { r: Result; onDrop: () => void; filed: Set<Where>; onFile: (w: Where) => void }) {
  const ref = useRef<HTMLElement>(null);
  useSwipe(ref, onDrop);
  return (
    <article ref={ref} className="result" data-testid="search-result">
      <div className="result-head">
        <a href={r.url} target="_blank" rel="noreferrer noopener" className="result-title">
          {r.title}
        </a>
        <button type="button" className="icon-btn result-drop" aria-label={`Drop: ${r.title}`} onClick={onDrop} data-testid="result-drop">
          <X />
        </button>
      </div>
      <div className="row-meta">
        <span className="tag">{r.domain}</span>
        <span className="tag engine" data-testid="result-engine">
          {engineLabel(r.engine)}
        </span>
        {r.preferred && <span className="tag goal">Preferred site</span>}
      </div>
      {r.content && <p className="result-snippet">{r.content}</p>}
      <div className="result-file" role="group" aria-label={`Add "${r.title}" to`}>
        <span className="caption">Add to</span>
        <div className="picks">
          {WHERE.map((w) => (
            <button key={w.value} type="button" className="pick" aria-pressed={filed.has(w.value)} disabled={filed.has(w.value)} onClick={() => onFile(w.value)} data-testid={`file-${w.value}`}>
              {filed.has(w.value) && <CheckIcon size={16} aria-hidden />}
              {w.label}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ the sheet

/** What the sheet showed last: reopening it brings back the same results. */
let last: { q: string; cat: SearchCategory; answer: Answer | null } = { q: '', cat: 'web', answer: null };

export function SearchSheet({ open, initialQuery, initialCat, openId, onClose }: { open: boolean; initialQuery: string; initialCat: SearchCategory; openId: number; onClose: () => void }) {
  const go = useGo();
  const [q, setQ] = useState(last.q);
  const [cat, setCat] = useState<SearchCategory>(last.cat);
  const [answer, setAnswer] = useState<Answer | null>(last.answer);
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<Map<string, Set<Where>>>(new Map());
  const { data: engines } = useResource<{ domains: string[]; shopping?: { sites: string[] } }>(open ? 'api/search/engines' : null);
  const shops = engines?.shopping?.sites ?? ['amazon.com', 'walmart.com', 'target.com'];
  const run = async (text: string, c: SearchCategory) => {
    const query = text.replace(/\s+/g, ' ').trim();
    if (!query) return;
    setBusy(true);
    try {
      const a = await api<Answer>(`api/search?q=${encodeURIComponent(query)}&cat=${c}`);
      setAnswer(a);
      last = { q: query, cat: c, answer: a };
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Search is not reachable (offline?).', 'error');
    } finally {
      setBusy(false);
    }
  };
  // opened with words (Quick Add, a segment): search them at once
  useEffect(() => {
    if (!open) return;
    if (initialQuery && (initialQuery !== last.q || initialCat !== last.cat)) {
      setQ(initialQuery);
      setCat(initialCat);
      setAnswer(null);
      void run(initialQuery, initialCat);
    } else if (!initialQuery && !last.answer) setCat(initialCat);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickCat = (c: SearchCategory) => {
    setCat(c);
    if (q.trim()) void run(q, c);
  };
  const dropOne = (r: Result) => {
    const query = answer?.query ?? q;
    const without = (a: Answer | null) => (a ? { ...a, results: a.results.filter((x) => x.url !== r.url) } : a);
    setAnswer(without);
    if (last.answer) last = { ...last, answer: without(last.answer) };
    void write({ path: 'api/search/drop', body: { q: query, url: r.url }, kind: 'search-drop', label: 'Drop' }).catch(() => undefined);
    toast(`Dropped ${r.domain || 'the result'} for this search`, 'info', {
      label: 'Undo',
      run: () => {
        void write({ path: 'api/search/drop', body: { q: query, url: r.url, undo: true }, kind: 'search-drop', label: 'Undo drop' })
          .then(() => run(query, answer?.category ?? cat))
          .catch(() => undefined);
      },
    });
  };
  const fileOne = async (r: Result, w: Where) => {
    setFiled((m) => new Map(m).set(r.url, new Set([...(m.get(r.url) ?? []), w])));
    try {
      await file(r, w);
      toast(WHERE.find((x) => x.value === w)!.done);
    } catch (e) {
      setFiled((m) => {
        const s = new Set(m.get(r.url));
        s.delete(w);
        return new Map(m).set(r.url, s);
      });
      toast(e instanceof ApiError ? e.message : 'Not saved.', 'error');
    }
  };
  const results = answer?.results ?? [];
  return (
    <Sheet open={open} onClose={onClose} title="Search the web" testId="search-sheet" initialFocus="input" className="sheet-search">
      <div className="edit-row">
        <input
          className="input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run(q, cat)}
          placeholder="What to look for"
          aria-label="Search the web"
          enterKeyHint="search"
          data-testid="search-input"
        />
        <button type="button" className="btn btn-primary" disabled={busy || !q.trim()} onClick={() => void run(q, cat)} data-testid="search-go">
          Search
        </button>
      </div>
      <div className="picks search-cats" role="radiogroup" aria-label="Category" data-testid="search-cats">
        {CATS.map((c) => (
          <button key={c.value} type="button" role="radio" className="pick" aria-checked={cat === c.value} onClick={() => pickCat(c.value)} data-testid={`search-cat-${c.value}`}>
            {c.label}
          </button>
        ))}
      </div>
      {cat === 'islamic' && (
        <p className="caption">
          Preferred sites come first: {(engines?.domains ?? []).join(', ') || 'none yet'}.{' '}
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              onClose();
              go('/settings?s=search');
            }}
          >
            Edit the list
          </button>
        </p>
      )}
      <p className="caption" data-testid="search-note">
        {cat === 'shopping'
          ? `Only these words, limited to ${listText(shops)}, go to your own search service (SearXNG, on this server); nothing else is added. Results are kept for 7 days.`
          : 'Only these words go to your own search service (SearXNG, on this server); nothing else is added. Results are kept for 7 days.'}
      </p>
      {busy && <p className="secondary" aria-live="polite">Searching…</p>}
      {answer && !busy && results.length === 0 && (
        <p className="empty" data-testid="search-empty">
          {answer.category === 'shopping' ? `Nothing at ${listText(shops, 'or')} for these words` : 'No results'}
          {answer.filtered ? ` (${answer.filtered} off-topic ${answer.filtered === 1 ? 'result was' : 'results were'} left out)` : ''}.
          {answer.category === 'shopping' && (
            <>
              {' '}
              <button type="button" className="btn-link" onClick={() => pickCat('web')} data-testid="search-try-web">
                Search the whole web
              </button>
            </>
          )}
        </p>
      )}
      {results.length > 0 && (
        <div className="results" data-testid="search-results">
          <span className="caption">
            {answer?.cached ? 'From the last 7 days’ results. ' : ''}
            {answer?.filtered ? `${answer.filtered} off-topic ${answer.filtered === 1 ? 'result' : 'results'} left out. ` : ''}Swipe left to drop one.
          </span>
          {results.map((r) => (
            <ResultCard key={r.url} r={r} onDrop={() => dropOne(r)} filed={filed.get(r.url) ?? new Set()} onFile={(w) => void fileOne(r, w)} />
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** "amazon.com, walmart.com and target.com" as words: "Amazon, Walmart and Target". */
function listText(sites: string[], last = 'and'): string {
  const names = sites.map((d) => d.replace(/\.(com|org|net|us)$/, '').replace(/^./, (c) => c.toUpperCase()));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${last} ${names.at(-1)}` : (names[0] ?? '');
}

/** The Lists header's button (every segment): opens the sheet in the segment's category. */
export function SearchButton({ cat = 'web' }: { cat?: SearchCategory }) {
  const on = useSearchEnabled();
  if (!on) return null;
  return (
    <button type="button" className="btn" onClick={() => openSearch({ cat })} data-testid="search-web">
      <Search aria-hidden /> Search the web
    </button>
  );
}
