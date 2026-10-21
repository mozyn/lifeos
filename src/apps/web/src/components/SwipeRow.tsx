/**
 * A row that is edited where it is (round-2 brief §12): swipe right for its primary action
 * (complete, open), swipe left to delete (archive, for a note), touch and hold for the menu (Edit,
 * Move, Delete or Archive, Make private, Select). The row's words slide over a solid action colour;
 * past the commit point the colour deepens with a haptic tick. A vertical scroll is never taken
 * (touch-action: pan-y; a finger that moves up or down first is the page's). While its list is
 * selecting, a tap adds or removes the row instead. Every gesture also has a plain path: the row's
 * sheet (a tap) has the same actions, and a right click or the context-menu key opens the menu.
 * The commit distance, the hold delay and the haptic strength are the device's gesture settings
 * (lib/gestures.ts, Settings → Gestures; round-3 brief §7), read when a touch starts.
 */
import { type HTMLAttributes, type ReactNode, useEffect, useRef } from 'react';
import { Check as CheckIcon, CheckSquare } from 'lucide-react';
import { motionReduced } from '../glass/spring';
import { gestures, haptic } from '../lib/gestures';
import { type Selectable, startSelect, toggleSelect, useSelectScope, useSelection } from '../lib/selection';
import { type MenuItem, openRowMenu } from './RowMenu';

export interface RowAction {
  label: string;
  icon: ReactNode;
  run: () => void;
  /** ok: complete; accent: open; danger: delete; warn: archive */
  tone: 'ok' | 'accent' | 'danger' | 'warn';
  /** slide the row away before running (a delete or an archive) */
  away?: boolean;
}

/** a fast flick commits from this share of the commit distance */
const FLICK = 0.6;

export function SwipeRow({
  as: Tag = 'div',
  plain,
  rowKey,
  className,
  testId,
  right,
  left,
  menu,
  menuTitle,
  select,
  children,
  ...rest
}: {
  /** the element (an event in a timeline is a list item) */
  as?: 'div' | 'li';
  /** not a list row: no row padding or hairline (a timeline entry, a week chip) */
  plain?: boolean;
  rowKey: string;
  className?: string;
  testId?: string;
  right?: RowAction | null;
  left?: RowAction | null;
  menu?: () => MenuItem[];
  menuTitle: string;
  select?: Selectable | null;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'children' | 'className'> & Record<`data-${string}`, string | undefined>) {
  const rowRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scope = useSelectScope();
  const sel = useSelection();
  const selecting = !!scope && sel.scope === scope && !!select;
  const picked = selecting && sel.items.has(select!.key);
  // the latest props for the listeners installed once
  const live = useRef({ right, left, menu, menuTitle, select, scope, selecting });
  live.current = { right, left, menu, menuTitle, select, scope, selecting };

  useEffect(() => {
    const row = rowRef.current;
    const body = bodyRef.current;
    if (!row || !body) return;
    let id = -1;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let lock: 'x' | 'y' | null = null;
    let dx = 0;
    let armed = false;
    let hold: ReturnType<typeof setTimeout> | null = null;
    let menuAt = 0;
    // a touch-and-hold also fires contextmenu (Chrome on Android) at the browser's own delay; the
    // hold delay of the gesture settings decides, so that one is left to the hold timer
    let browserHold = false;
    let commitPx = gestures().swipePx;
    const width = () => row.getBoundingClientRect().width || 360;
    const threshold = () => commitPx;
    const clearHold = () => {
      if (hold) clearTimeout(hold);
      hold = null;
    };
    /** the click that ends a swipe or a hold is not a tap on what the finger started on */
    const eatClick = () => {
      const stop = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      row.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => row.removeEventListener('click', stop, { capture: true }), 400);
    };
    const place = (x: number, animate: boolean) => {
      body.style.transition = animate && !motionReduced() ? 'transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1)' : 'none';
      body.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
    };
    const reset = () => {
      delete row.dataset.dir;
      delete row.dataset.tone;
      delete row.dataset.armed;
      armed = false;
    };
    const openMenu = () => {
      const l = live.current;
      if (!l.menu || l.selecting) return;
      menuAt = performance.now();
      haptic();
      const items = l.menu();
      if (l.scope && l.select) {
        const s = l.select;
        const sc = l.scope;
        items.push({ label: 'Select', icon: <CheckSquare aria-hidden />, run: () => startSelect(sc, s), testId: 'menu-select' });
      }
      openRowMenu({ title: l.menuTitle, items });
    };
    const down = (e: PointerEvent) => {
      if (live.current.selecting) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if ((e.target as Element).closest('input, textarea, select, [data-noswipe]')) return;
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      t0 = performance.now();
      lock = null;
      dx = 0;
      browserHold = false;
      clearHold();
      const g = gestures();
      commitPx = g.swipePx;
      if (live.current.menu)
        hold = setTimeout(() => {
          hold = null;
          browserHold = false;
          if (lock) return;
          lock = 'y';
          eatClick();
          openMenu();
        }, g.holdMs);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (Math.hypot(mx, my) > 8) clearHold();
      if (!lock) {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) lock = 'y';
        else if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.3) {
          const act = mx > 0 ? live.current.right : live.current.left;
          if (!act) {
            lock = 'y';
            return;
          }
          lock = 'x';
          row.setPointerCapture?.(e.pointerId);
          eatClick();
        }
      }
      if (lock !== 'x') return;
      const act = mx > 0 ? live.current.right : live.current.left;
      const th = threshold();
      // past the commit point the row follows the finger more slowly; with no action this way, barely
      dx = !act ? mx * 0.12 : Math.abs(mx) <= th ? mx : Math.sign(mx) * (th + (Math.abs(mx) - th) * 0.35);
      row.dataset.dir = mx > 0 ? 'right' : 'left';
      if (act) row.dataset.tone = act.tone;
      else delete row.dataset.tone;
      const nowArmed = !!act && Math.abs(mx) >= th;
      if (nowArmed !== armed) {
        armed = nowArmed;
        if (armed) {
          row.dataset.armed = '';
          haptic();
        } else delete row.dataset.armed;
      }
      place(dx, false);
    };
    const finish = (commit: boolean, dir: 'right' | 'left') => {
      const act = dir === 'right' ? live.current.right : live.current.left;
      if (!commit || !act) {
        place(0, true);
        setTimeout(reset, 230);
        return;
      }
      if (!act.away || motionReduced()) {
        place(0, true);
        setTimeout(reset, 230);
        act.run();
        return;
      }
      // away: off the side, the gap closes, then the row is removed
      body.style.transition = 'transform 170ms cubic-bezier(0.3, 0, 0.8, 0.4)';
      body.style.transform = `translate3d(${dir === 'left' ? -width() : width()}px, 0, 0)`;
      setTimeout(() => {
        const h = row.offsetHeight;
        row.style.height = `${h}px`;
        row.style.transition = 'height 160ms ease, padding 160ms ease, opacity 160ms ease';
        void row.offsetHeight;
        row.style.height = '0px';
        row.style.paddingTop = '0px';
        row.style.paddingBottom = '0px';
        row.style.opacity = '0';
        setTimeout(() => {
          act.run();
          // a row that stays (the write failed) comes back as it was
          setTimeout(() => {
            row.style.cssText = '';
            body.style.cssText = '';
            reset();
          }, 50);
        }, 165);
      }, 175);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      clearHold();
      if (lock !== 'x') return;
      const mx = e.clientX - x0;
      const v = Math.abs(mx) / Math.max(1, performance.now() - t0);
      finish(armed || (v > 0.6 && Math.abs(mx) > commitPx * FLICK), mx > 0 ? 'right' : 'left');
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      // the browser took the touch for its own long-press: the hold still opens the menu on time
      if (!browserHold) clearHold();
      browserHold = false;
      if (lock === 'x') finish(false, 'right');
    };
    const context = (e: MouseEvent) => {
      if (!live.current.menu || live.current.selecting) return;
      e.preventDefault();
      if (hold) {
        browserHold = true;
        return;
      }
      // a touch-and-hold whose menu is open already fires this too: one menu
      if (performance.now() - menuAt > 800) openMenu();
    };
    row.addEventListener('pointerdown', down);
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
    row.addEventListener('pointercancel', cancel);
    row.addEventListener('contextmenu', context);
    // a link or an image in the row is not dragged out by the browser (that would cancel the swipe)
    const noDrag = (e: DragEvent) => e.preventDefault();
    row.addEventListener('dragstart', noDrag);
    return () => {
      row.removeEventListener('dragstart', noDrag);
      clearHold();
      row.removeEventListener('pointerdown', down);
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      row.removeEventListener('pointercancel', cancel);
      row.removeEventListener('contextmenu', context);
    };
  }, []);

  return (
    <Tag ref={rowRef as React.RefObject<never>} className={`${plain ? '' : 'row '}swipe${className ? ` ${className}` : ''}`} data-swipe="" data-row-key={rowKey} data-testid={testId} data-selecting={selecting ? '' : undefined} data-picked={picked ? '' : undefined} {...rest}>
      {(right || left) && (
        <div className="swipe-under" aria-hidden>
          {right && (
            <span className="swipe-act" data-side="right" data-tone={right.tone}>
              {right.icon}
              {right.label}
            </span>
          )}
          {left && (
            <span className="swipe-act" data-side="left" data-tone={left.tone}>
              {left.label}
              {left.icon}
            </span>
          )}
        </div>
      )}
      <div className="swipe-body" ref={bodyRef}>
        {children}
      </div>
      {selecting && (
        <button type="button" role="checkbox" aria-checked={picked} className="select-hit" aria-label={`Select: ${select!.label}`} onClick={() => toggleSelect(select!)} data-testid="select-row">
          <span className="select-ring">
            <CheckIcon aria-hidden />
          </span>
        </button>
      )}
    </Tag>
  );
}
