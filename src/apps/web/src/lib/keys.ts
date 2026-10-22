/**
 * Keyboard shortcuts (round 8f, ADR-107): single keys, no modifier, on a hardware keyboard. A key
 * is a shortcut only when nothing else wants it: no Ctrl, Alt or Meta, no field being typed in, no
 * dialog open (a sheet in a side panel is not a dialog), and not repeated by holding it down.
 */

const EDITABLE = 'input:not([type=button],[type=checkbox],[type=radio],[type=range],[type=submit],[type=reset]),textarea,select,[contenteditable="true"],[contenteditable=""]';

type KeyLike = Pick<KeyboardEvent, 'defaultPrevented' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>;

/** The rule, apart from the page: `typing` (a field has the key), `dialog` (one covers the screen). */
export function shortcutAllowed(e: KeyLike, at: { typing: boolean; dialog: boolean }): boolean {
  if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  return !at.typing && !at.dialog;
}

export function isShortcut(e: KeyboardEvent): boolean {
  const t = e.target instanceof Element ? e.target : null;
  const a = document.activeElement;
  const typing = !!t?.closest(EDITABLE) || (a instanceof Element && a.matches(EDITABLE));
  // a dialog (a sheet over the screen, the hold menu) keeps the keyboard to itself
  return shortcutAllowed(e, { typing, dialog: !!document.querySelector('.overlay') });
}

/** The list the help sheet shows (`?`): what each key does, grouped. */
export const SHORTCUTS: { group: string; keys: { k: string[]; what: string }[] }[] = [
  {
    group: 'Go to',
    keys: [
      { k: ['1'], what: 'Today' },
      { k: ['2'], what: 'Calendar' },
      { k: ['3'], what: 'Goals' },
      { k: ['4'], what: 'Habits' },
      { k: ['5'], what: 'Lists' },
      { k: [','], what: 'Settings' },
    ],
  },
  {
    group: 'Add',
    keys: [{ k: ['N'], what: 'Quick Add' }],
  },
  {
    group: 'Calendar',
    keys: [
      { k: ['D', 'W', 'M'], what: 'Day, Week, Month' },
      { k: ['←', '→'], what: 'Previous and next' },
      { k: ['T'], what: 'Back to today' },
    ],
  },
  {
    group: 'Anywhere',
    keys: [
      { k: ['?'], what: 'These shortcuts' },
      { k: ['Esc'], what: 'Close a sheet or panel' },
    ],
  },
];
