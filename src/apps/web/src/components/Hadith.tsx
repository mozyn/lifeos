/**
 * A library entry, verbatim (spec §9 job 3, ADR-6): Arabic, English, book and reference, grading
 * and source exactly as imported. The model's encouragement is a separate block, labelled
 * "From LifeOS", never mixed into the entry.
 */
import { useState } from 'react';
import { PrivateText } from './Private';

export interface Entry {
  id: string;
  heading: string;
  book: string;
  reference: string;
  grade: string | null;
  source: string | null;
  arabic: string;
  english: string;
}

export function HadithEntry({ e, compact }: { e: Entry; compact?: boolean }) {
  const [arabic, setArabic] = useState(!compact);
  return (
    <figure className="hadith" data-testid="hadith-entry">
      {e.arabic && arabic && (
        <blockquote className="hadith-ar ar" lang="ar" dir="rtl">
          {e.arabic}
        </blockquote>
      )}
      <blockquote className="hadith-en" lang="en">
        {e.english}
      </blockquote>
      <figcaption className="hadith-ref">
        <span className="hadith-book" data-testid="hadith-reference">
          {e.heading}
        </span>
        <span className="hadith-grade">{e.grade ? `Grading: ${e.grade}` : 'Grading: not given in the source'}</span>
        <span className="hadith-links">
          {e.arabic && compact && (
            <button type="button" className="btn-link" onClick={() => setArabic(!arabic)} aria-expanded={arabic}>
              {arabic ? 'Hide Arabic' : 'Show Arabic'}
            </button>
          )}
          {e.source && (
            <a href={e.source} target="_blank" rel="noreferrer noopener" className="btn-link">
              Source
            </a>
          )}
        </span>
      </figcaption>
    </figure>
  );
}

/** `names`: a private habit's names, curtained in the text while Privacy mode is on (ADR-63). */
export function FromLifeOS({ text, fallback, model, names }: { text: string; fallback: boolean; model?: string | null; names?: string[] }) {
  return (
    <aside className="from-lifeos" aria-label="Encouragement from LifeOS" data-testid="encouragement">
      <span className="from-label">From LifeOS{fallback ? '' : model ? `, written by ${model}` : ''}</span>
      <p>
        <PrivateText text={text} names={names} />
      </p>
      {fallback && <span className="caption">A fixed sentence: the model&rsquo;s words are used only when they pass the scripture guard.</span>}
    </aside>
  );
}
