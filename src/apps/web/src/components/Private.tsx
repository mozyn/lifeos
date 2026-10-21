/**
 * Privacy mode on screen (round-2 brief §6, lib/privacy.ts): the top bar's eye, and what a private
 * habit looks like while the mode is on: a blurred row under a generic label ("Private habit"),
 * revealed for 3 s by a touch-and-hold (the hold delay of Settings → Gestures). A curtain on this device, not a security boundary.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { splitNames } from '@lifeos/shared';
import { gestures } from '../lib/gestures';
import { PRIVATE_LABEL, setPrivacy, usePrivacy } from '../lib/privacy';

export const REVEAL_MS = 3000;

/** The top bar's eye: Privacy mode on (eye crossed out) or off. */
export function PrivacyToggle() {
  const on = usePrivacy();
  return (
    <button
      type="button"
      className="icon-btn"
      data-press="1.5"
      aria-pressed={on}
      aria-label={on ? 'Privacy mode is on: show private habits' : 'Privacy mode: hide private habits'}
      onClick={() => setPrivacy(!on)}
      data-testid="privacy-toggle"
    >
      {on ? <EyeOff /> : <Eye />}
    </button>
  );
}

/**
 * Hidden while Privacy mode is on and the item is private, until a tap-and-hold (or a long key
 * press on Enter/Space) reveals it for 3 s.
 */
export function useCurtain(isPrivate: boolean): { hidden: boolean; holdProps: Record<string, unknown> } {
  const on = usePrivacy();
  const [revealed, setRevealed] = useState(false);
  const timers = useRef<{ hold?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.hold);
      clearTimeout(t.hide);
    };
  }, []);
  useEffect(() => {
    if (!on) setRevealed(false);
  }, [on]);
  const reveal = () => {
    setRevealed(true);
    clearTimeout(timers.current.hide);
    timers.current.hide = setTimeout(() => setRevealed(false), REVEAL_MS);
  };
  const start = () => {
    clearTimeout(timers.current.hold);
    // the hold delay of the gesture settings (round-3 brief §7), as a row's menu
    timers.current.hold = setTimeout(reveal, gestures().holdMs);
  };
  const cancel = () => clearTimeout(timers.current.hold);
  const hidden = on && isPrivate && !revealed;
  return {
    hidden,
    holdProps: hidden
      ? {
          onPointerDown: start,
          onPointerUp: cancel,
          onPointerLeave: cancel,
          onPointerCancel: cancel,
          onContextMenu: (e: Event) => e.preventDefault(),
          onKeyDown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && !e.repeat && start(),
          onKeyUp: cancel,
        }
      : {},
  };
}

/**
 * A row (or card) that belongs to a private habit: while Privacy mode is on its content is blurred
 * and taken out of the accessibility tree, and a generic label sits over it; hold to see it.
 */
export function Curtained({ isPrivate, children, className, as: Tag = 'div', testId, ...rest }: { isPrivate: boolean; children: ReactNode; className?: string; as?: 'div' | 'section' | 'li'; testId?: string } & Record<string, unknown>) {
  const { hidden, holdProps } = useCurtain(isPrivate);
  return (
    <Tag className={`curtain${hidden ? ' is-hidden' : ''}${className ? ` ${className}` : ''}`} data-testid={testId} data-private={isPrivate ? '' : undefined} {...rest}>
      <div className="curtain-body" aria-hidden={hidden || undefined} inert={hidden || undefined}>
        {children}
      </div>
      {hidden && (
        <div className="curtain-label" role="button" tabIndex={0} aria-label={`${PRIVATE_LABEL}. Touch and hold to show it for 3 seconds.`} data-testid="private-curtain" {...holdProps}>
          <EyeOff aria-hidden />
          <span>{PRIVATE_LABEL}</span>
          <span className="caption">Hold to show</span>
        </div>
      )}
    </Tag>
  );
}

/** A habit's name as Privacy mode allows it to be shown. */
export function habitName(h: { title: string; private?: boolean }, privacy: boolean): string {
  return privacy && h.private ? PRIVATE_LABEL : h.title;
}

/**
 * Text that may name a private habit (a plan or review the model drafted with the habit's id, put
 * back to its name by the API, ADR-63): while Privacy mode is on, each mention reads "private habit".
 */
export function PrivateText({ text, names }: { text: string; names: string[] | undefined }) {
  const on = usePrivacy();
  if (!on || !names?.length) return <>{text}</>;
  return (
    <>
      {splitNames(text, names).map((p, i) =>
        p.name ? (
          <span key={i} className="private-name" data-testid="private-name">
            {PRIVATE_LABEL.toLowerCase()}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}
