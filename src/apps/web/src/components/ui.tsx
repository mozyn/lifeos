/**
 * Controls on the Liquid Glass layer, ported from Work OS components/ui.tsx: Sheet (thick glass,
 * rises from the bottom on phones, drag to dismiss), Segmented (sliding lens pill), Switch (iOS 26:
 * tinted-glass track, white knob), Slider (glass thumb), plus toasts and a media-query hook.
 */
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { Glass } from '../glass/Glass';
import { controllerFor } from '../glass/engine';
import { useLensPill } from '../glass/lens';
import { motionReduced, onFrame, Spring, SPRINGS, springEasing } from '../glass/spring';
import { dismissToast, useToasts } from '../lib/store';
import { onVisibleChange, type Visible, visible } from '../lib/viewport';
import { claimDrill, drillOut } from '../lib/transitions';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, initialFocus?: string) {
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = (initialFocus ? el?.querySelector<HTMLElement>(initialFocus) : null) ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus({ preventScroll: true });
    return () => {
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [active, ref, initialFocus]);
}

function trapTab(e: ReactKeyboardEvent, root: HTMLElement | null) {
  if (e.key !== 'Tab' || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Phones: a sheet follows the finger down from its grabber or title and is dismissed past a third of its height. */
function useSheetDrag(ref: RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const phone = () => window.matchMedia?.('(max-width: 699px)').matches ?? false;
    let start: number | null = null;
    let dy = 0;
    let lastY = 0;
    let lastT = 0;
    let v = 0;
    let pointer = -1;
    let frame = 0;
    const place = (y: number) => {
      el.style.transform = y ? `translate3d(0, ${y.toFixed(1)}px, 0)` : '';
    };
    const follow = () => {
      frame = 0;
      if (start !== null) place(dy);
    };
    const down = (e: PointerEvent) => {
      if (!phone() || e.button !== 0) return;
      const t = e.target as Element | null;
      if (!t?.closest('.sheet-grabber, .sheet-title') || t.closest('button, a, input, select, textarea, [role="button"]')) return;
      e.preventDefault();
      start = e.clientY;
      lastY = e.clientY;
      lastT = performance.now();
      dy = 0;
      v = 0;
      pointer = e.pointerId;
      el.dataset.dragged = '';
      el.style.transition = 'none';
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (start === null || e.pointerId !== pointer) return;
      const raw = e.clientY - start;
      dy = raw > 0 ? raw : raw * 0.18;
      const now = performance.now();
      v = 0.7 * v + 0.3 * ((e.clientY - lastY) / Math.max(1, now - lastT));
      lastY = e.clientY;
      lastT = now;
      if (!frame) frame = requestAnimationFrame(follow);
    };
    const up = (e: PointerEvent) => {
      if (start === null || e.pointerId !== pointer) return;
      start = null;
      cancelAnimationFrame(frame);
      frame = 0;
      const h = el.getBoundingClientRect().height;
      if (dy > Math.max(110, h / 3) || (v > 0.9 && dy > 24)) {
        el.style.transition = `transform ${motionReduced() ? 1 : 200}ms cubic-bezier(0.3, 0, 0.8, 0.15)`;
        place(h + 40);
        setTimeout(onDismiss, motionReduced() ? 0 : 190);
      } else {
        el.style.transition = `transform ${motionReduced() ? 1 : 340}ms var(--spring-bouncy, cubic-bezier(0.34, 1.4, 0.64, 1))`;
        place(0);
      }
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
  }, [ref, active, onDismiss]);
}

const EDITABLE = 'input:not([type=button],[type=checkbox],[type=radio],[type=range],[type=submit]),textarea,select,[contenteditable="true"]';

/** The focused field and what belongs with it (its label, the button on its row) inside the sheet's scroller. */
function revealFocused(sheet: HTMLElement | null): void {
  const a = document.activeElement as HTMLElement | null;
  if (!sheet || !a || !sheet.contains(a) || !a.matches(EDITABLE)) return;
  (a.closest<HTMLElement>('[data-reveal], .edit-row') ?? a.closest<HTMLElement>('label.field') ?? a).scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

let keyboardEase: string | null = null;

/**
 * Keep a sheet inside the visible part of the window (UI brief 2 §1): the overlay follows the
 * visual viewport (the keyboard's top edge), a bottom sheet slides with it instead of jumping, and
 * the focused field stays in view inside the sheet's scroller.
 */
function useFitToVisible(overlay: RefObject<HTMLElement | null>, sheet: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const o = overlay.current;
    if (!active || !o) return;
    let last = visible();
    const place = (v: Visible) => {
      if (!v.height) return;
      o.style.top = `${v.top}px`;
      o.style.height = `${v.height}px`;
      o.style.bottom = 'auto';
    };
    place(last);
    const off = onVisibleChange((v) => {
      const s = sheet.current;
      // a bottom sheet rides on the keyboard's edge: from where that edge was to where it is now
      const dy = last.top + last.height - (v.top + v.height);
      last = v;
      place(v);
      if (s && dy && !motionReduced() && !('dragged' in s.dataset) && getComputedStyle(o).alignItems === 'flex-end') {
        keyboardEase ??= springEasing(SPRINGS.smooth).easing;
        s.animate([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }], { duration: 260, easing: keyboardEase, composite: 'add' });
      }
      requestAnimationFrame(() => revealFocused(s));
    });
    const s = sheet.current;
    const onFocus = () => requestAnimationFrame(() => revealFocused(s));
    s?.addEventListener('focusin', onFocus);
    return () => {
      off();
      s?.removeEventListener('focusin', onFocus);
    };
  }, [overlay, sheet, active]);
}

/**
 * A sheet (dialog): thick Liquid Glass, more opaque when it grows past most of the screen. Head
 * (title, optional `tools`, close), a scrolling body and a pinned footer for the primary action.
 * When the space is short (a phone in landscape with the keyboard up) the footer moves up into the
 * head row and `tools` take the title's place, so field, picker and action fit in about 120 px.
 */
export function Sheet(props: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; tools?: ReactNode; className?: string; initialFocus?: string; testId?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const id = useId();
  useFocusTrap(ref, props.open, props.initialFocus);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const dismiss = useCallback(() => close.current(), []);
  useSheetDrag(ref, props.open, dismiss);
  useFitToVisible(overlayRef, ref, props.open);
  // a sheet that grew from a row (a drill-in) shrinks back into it when closed (UI brief 2 §3)
  useLayoutEffect(() => {
    if (props.open && ref.current) claimDrill(ref.current);
  }, [props.open]);
  const requestClose = () => void drillOut(ref.current, () => close.current());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!props.open || !el) return;
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > (overlayRef.current?.clientHeight ?? window.innerHeight) * 0.7) el.dataset.detent = 'full';
      else delete el.dataset.detent;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.open]);
  if (!props.open) return null;
  return createPortal(
    <div
      className="overlay"
      ref={overlayRef}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <Glass
        ref={ref}
        variant="thick"
        kind="panel"
        className={`sheet${props.tools ? ' has-tools' : ''}${props.footer ? ' has-foot' : ''}${props.className ? ` ${props.className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        data-testid={props.testId}
        tabIndex={-1}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            requestClose();
          }
          trapTab(e, ref.current);
        }}
      >
        <span className="sheet-grabber" aria-hidden />
        <h2 className="sheet-title" id={id}>
          {props.title}
        </h2>
        {props.tools && <div className="sheet-tools">{props.tools}</div>}
        <button className="icon-btn sheet-close" onClick={requestClose} aria-label="Close">
          <X />
        </button>
        <div className="sheet-body">{props.children}</div>
        {props.footer && <div className="sheet-foot">{props.footer}</div>}
      </Glass>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ segmented control (lens pill)

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  testId?: string;
}

/**
 * A glass segmented control (sliding lens pill). `value` null: nothing chosen yet, no pill.
 * `compact`: each option's icon over its label, in equal widths (a narrow phone's top bar).
 */
export function Segmented<T extends string>({ value, onChange, options, label, fill, onGlass, compact, testId, className }: { value: T | null; onChange: (v: T) => void; options: SegOption<T>[]; label: string; fill?: boolean; onGlass?: boolean; compact?: boolean; testId?: string; className?: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLElement | null>(null);
  const index = options.findIndex((o) => o.value === value);
  useLensPill({ track: trackRef, pill: pillRef, itemSelector: ':scope > .seg-item', index, onPick: (i) => !options[i].disabled && onChange(options[i].value), pressScale: 1.1 });
  return (
    <Glass className={`segmented${fill ? ' segmented-fill' : ''}${onGlass ? ' on-glass' : ''}${compact ? ' segmented-compact' : ''}${className ? ` ${className}` : ''}`} role="group" aria-label={label} data-testid={testId}>
      <div className="seg-track" ref={trackRef}>
        <Glass ref={pillRef} className="lens-pill seg-pill" variant="clear" profile="bezel" bezel={6} dormant scale={14} chroma={0.06} power={2.6} aria-hidden />
        {options.map((o) => (
          <button key={o.value} type="button" className="seg-item" aria-pressed={value === o.value} disabled={o.disabled} onClick={() => onChange(o.value)} data-testid={o.testId}>
            {o.icon}
            {compact ? <span className="seg-label">{o.label}</span> : o.label}
          </button>
        ))}
      </div>
    </Glass>
  );
}

// ------------------------------------------------------------------ switch

/**
 * The one on/off control (round-4 brief §1, iOS 26): a 51×31 track inside a row of at least 44 px,
 * a white knob with a soft shadow. Off, the track is a translucent neutral; on, it is the app's
 * green as tinted glass (lower saturation, a highlight and a rim) under the knob. The knob slides on
 * the toggle spring (180 ms, CSS `linear()` from lib spring) and stretches a little while pressed;
 * reduced motion: no stretch, no slide.
 */
function SwitchTrack() {
  const knobRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const label = trackRef.current?.closest('label');
    if (!label) return;
    const down = (e: PointerEvent) => {
      const knob = knobRef.current;
      if (e.button !== 0 || !knob || label.querySelector('input:disabled') || motionReduced()) return;
      knob.dataset.held = '';
      const up = () => {
        delete knob.dataset.held;
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
    label.addEventListener('pointerdown', down);
    return () => label.removeEventListener('pointerdown', down);
  }, []);
  return (
    <span className="switch-track" ref={trackRef} aria-hidden>
      <span className="switch-knob" ref={knobRef} />
    </span>
  );
}

export function Switch({ checked, onChange, label, hint, disabled, testId }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <SwitchTrack />
      <span className="switch-label">
        <span>{label}</span>
        {hint && <span className="caption">{hint}</span>}
      </span>
    </label>
  );
}

// ------------------------------------------------------------------ disclosure

/**
 * Something shown on request (round-4 brief §2: the outbound log, engine health, the frame meter,
 * the last jobs, recently deleted, archived): one button opens and closes it, named "Show …" or
 * "Hide …" with `aria-expanded`; a closed panel is not in the DOM. `onOpen` runs on every opening
 * (a log fetched fresh each time).
 */
export function Disclosure({ what, children, testId, panelTestId, onOpen, note }: { what: string; children: ReactNode; testId: string; panelTestId?: string; onOpen?: () => void; note?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="disclosure" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="disclosure-btn"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setOpen(!open);
          if (!open) onOpen?.();
        }}
        data-testid={testId}
      >
        <span className="disclosure-label">
          <span>
            {open ? 'Hide' : 'Show'} {what}
          </span>
          {note && <span className="caption">{note}</span>}
        </span>
        <ChevronDown aria-hidden />
      </button>
      {open && (
        <div className="disclosure-panel" id={id} data-testid={panelTestId}>
          {children}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ slider (glass thumb)

export function Slider({ id, value, min, max, step = 1, onChange, label, valueText }: { id: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label?: string; valueText?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLElement | null>(null);
  const st = useRef({ x: new Spring(0, SPRINGS.glued), held: false, stop: null as null | (() => void), lastX: 0, lastT: 0, v: 0 }).current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const frac = (v: number) => (max === min ? 0 : (Math.min(max, Math.max(min, v)) - min) / (max - min));
  const snapValue = (f: number) => {
    const raw = min + Math.min(1, Math.max(0, f)) * (max - min);
    return Math.min(max, Math.max(min, Math.round(raw / step) * step));
  };
  const width = () => rootRef.current?.querySelector<HTMLElement>('.sl-track')?.offsetWidth ?? 1;
  const paint = (stretch = 0) => {
    const root = rootRef.current;
    if (!root) return;
    const x = st.x.value.toFixed(2);
    const thumb = thumbRef.current;
    if (thumb) thumb.style.transform = `translateX(${x}px) scale(${(1 + stretch).toFixed(3)}, ${(1 - stretch * 0.45).toFixed(3)})`;
    const fill = root.querySelector<HTMLElement>('.sl-fill');
    if (fill) fill.style.transform = `translateX(calc(${x}px - 100%))`;
  };
  const run = () => {
    if (st.stop) return;
    if (motionReduced()) {
      st.x.snap();
      paint();
      return;
    }
    st.stop = onFrame((dt) => {
      st.x.step(dt);
      paint(Math.min(0.45, Math.abs(st.x.velocity) / 1800));
      if (!st.held && st.x.settled(0.2)) {
        st.x.snap();
        paint();
        st.stop = null;
        if (thumbRef.current) void controllerFor(thumbRef.current)?.materialize(0);
        return false;
      }
      return true;
    });
  };
  useLayoutEffect(() => {
    if (st.held) return;
    st.x.target = frac(value) * width();
    if (!st.stop) {
      st.x.snap();
      paint();
    } else run();
  }, [value, min, max]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      if (st.held || st.stop) return;
      st.x.snap(frac(value) * width());
      paint();
    });
    ro.observe(root);
    return () => ro.disconnect();
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const track = () => root.querySelector<HTMLElement>('.sl-track')!;
    const at = (clientX: number) => {
      const r = track().getBoundingClientRect();
      return Math.min(r.width, Math.max(0, clientX - r.left));
    };
    let current = value;
    const emit = (f: number) => {
      const v = snapValue(f);
      if (v !== current) {
        current = v;
        onChangeRef.current(v);
      }
    };
    const move = (e: PointerEvent) => {
      const x = at(e.clientX);
      const now = performance.now();
      st.v = st.v * 0.6 + ((x - st.lastX) / Math.max(1, now - st.lastT)) * 1000 * 0.4;
      st.lastX = x;
      st.lastT = now;
      st.x.target = x;
      emit(x / width());
      run();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      st.held = false;
      root.removeAttribute('data-held');
      const w = width();
      const f = snapValue((st.x.target + (motionReduced() ? 0 : st.v * 0.09)) / w);
      emit(frac(f));
      st.x.config = SPRINGS.jelly;
      st.x.velocity = motionReduced() ? 0 : st.v;
      st.x.target = frac(f) * w;
      run();
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      root.removeAttribute('data-kbd');
      root.querySelector('input')?.focus({ preventScroll: true });
      current = value;
      st.held = true;
      root.setAttribute('data-held', '');
      st.x.config = SPRINGS.glued;
      st.lastX = at(e.clientX);
      st.lastT = performance.now();
      st.v = 0;
      st.x.target = st.lastX;
      emit(st.lastX / width());
      if (thumbRef.current && !motionReduced()) void controllerFor(thumbRef.current)?.materialize(1);
      run();
      window.addEventListener('pointermove', move, { passive: true });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
    root.addEventListener('pointerdown', down);
    return () => root.removeEventListener('pointerdown', down);
  }, [value, min, max, step]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="slider" ref={rootRef}>
      <input id={id} className="sl-input" onKeyDown={() => rootRef.current?.setAttribute('data-kbd', '')} type="range" min={min} max={max} step={step} value={value} aria-label={label} aria-valuetext={valueText} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="sl-track" aria-hidden>
        <span className="sl-fill" />
      </span>
      <Glass ref={thumbRef} className="sl-thumb" variant="clear" profile="lens" dormant bezel={9} aria-hidden />
    </div>
  );
}

// ------------------------------------------------------------------ toasts, media

export function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <Glass key={t.id} className="toast" variant="thick" kind="panel" data-tone={t.tone} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="btn btn-quiet toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X />
          </button>
        </Glass>
      ))}
    </div>
  );
}

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(query);
      m?.addEventListener('change', cb);
      return () => m?.removeEventListener('change', cb);
    },
    () => window.matchMedia?.(query).matches ?? false,
  );
}
