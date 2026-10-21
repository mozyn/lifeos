import { useRef } from 'react';
import { Moon, Sun } from 'lucide-react';
import { applyAppearance, usePrefs } from '../lib/prefs';
import { revealTheme } from '../lib/transitions';

/**
 * One-tap light/dark switch (UI refresh §3): the sun turns into the moon, and the new appearance
 * grows in a circle from this button (UI brief 2 §3).
 */
export function ThemeToggle({ testId = 'theme-toggle' }: { testId?: string }) {
  const { theme, prefs, setPrefs } = usePrefs();
  const dark = theme === 'dark';
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={btn}
      type="button"
      className="icon-btn theme-toggle"
      data-press="1.5"
      aria-label="Dark appearance"
      aria-pressed={dark}
      title={dark ? 'Switch to light appearance' : 'Switch to dark appearance'}
      onClick={() => {
        const next = dark ? 'light' : 'dark';
        // the whole new appearance is in place before the reveal starts: no unstyled frame
        void revealTheme(btn.current, () => {
          applyAppearance({ ...prefs, theme: next });
          setPrefs({ theme: next });
        });
      }}
      data-testid={testId}
    >
      <span className="tt" aria-hidden>
        <Sun className="tt-sun" />
        <Moon className="tt-moon" />
      </span>
    </button>
  );
}
