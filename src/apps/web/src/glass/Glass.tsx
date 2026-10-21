/**
 * The glass primitive (ADR-19): `<Glass>` renders a surface whose first child is the refracting
 * backdrop layer (`.lg-bg`) and whose second is the touch glow; children sit on top. The backdrop
 * lives on a child, not on the host, so the host never becomes a backdrop root: a nested lens
 * (the selection pill) still sees the page and the labels beneath it.
 *
 * Variants: `regular` (bars, buttons), `thick` (menus, Spotlight, sheets), `clear` (lenses and
 * thumbs), `tinted` (primary actions, accent-coloured glass).
 *
 * `kind` sets what the glass quality allows the surface (engine.ts glassPlan): `bar` refracts at
 * rest, `control` (the default) when pressed, `panel` never at balanced, and a dormant surface is a
 * lens. A bar with `freeze` splits its backdrop from its paint (UI brief 4 §4): `.lg-bg` refracts,
 * `.lg-frost` is its frosted twin, and `.lg-face` carries the tint, shadow, rim and sheen above
 * both, so the two backdrops cross-fade while something moves under the bar.
 */
import { type CSSProperties, type ElementType, type HTMLAttributes, forwardRef, type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { GlassController, type GlassOptions } from './engine';

export type GlassVariant = 'regular' | 'thick' | 'clear' | 'tinted';

/** Bind a controller to a host element and its `.lg-bg` layer for the life of the component. */
export function useGlassSurface(hostRef: RefObject<HTMLElement | null>, bgRef: RefObject<HTMLElement | null>, opts: GlassOptions) {
  const ctrl = useRef<GlassController | null>(null);
  const { profile, bezel, scale, chroma, power, materialize, dormant, kind, freeze } = opts;
  useLayoutEffect(() => {
    if (!hostRef.current || !bgRef.current) return;
    const c = new GlassController(bgRef.current, hostRef.current, { profile, bezel, scale, chroma, power, materialize, dormant, kind, freeze });
    ctrl.current = c;
    return () => {
      c.destroy();
      ctrl.current = null;
    };
  }, [hostRef, bgRef, profile, bezel, scale, chroma, power, materialize, dormant, kind, freeze]);
  return ctrl;
}

export type GlassProps = Omit<HTMLAttributes<HTMLElement>, 'color'> &
  GlassOptions & {
    as?: ElementType;
    variant?: GlassVariant;
    /** press physics: true, or the magnification while held (e.g. 1.6) */
    press?: boolean | number;
    children?: ReactNode;
    style?: CSSProperties;
    [data: `data-${string}`]: string | number | boolean | undefined;
  };

export const Glass = forwardRef<HTMLElement, GlassProps>(function Glass(
  { as: Tag = 'div', variant = 'regular', press, profile, bezel, scale, chroma, power, materialize, dormant, kind, freeze, className, children, ...rest },
  ref,
) {
  const hostRef = useRef<HTMLElement | null>(null);
  const bgRef = useRef<HTMLSpanElement | null>(null);
  useGlassSurface(hostRef, bgRef, { profile, bezel, scale, chroma, power, materialize, dormant, kind, freeze });
  const setRef = (el: HTMLElement | null) => {
    hostRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  return (
    <Tag
      ref={setRef}
      className={`lg lg-${variant}${className ? ` ${className}` : ''}`}
      data-press={press === undefined || press === false ? undefined : press === true ? '' : String(press)}
      data-freeze={freeze ? '' : undefined}
      {...rest}
    >
      <span className="lg-bg" ref={bgRef} aria-hidden />
      {freeze && <span className="lg-frost" aria-hidden />}
      {freeze && <span className="lg-face" aria-hidden />}
      <span className="lg-glow" aria-hidden>
        <span className="lg-glow-dot" />
      </span>
      {children}
    </Tag>
  );
});
