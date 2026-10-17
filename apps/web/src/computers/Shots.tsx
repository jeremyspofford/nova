// Before/after screenshots of a browser or screen action in the Activity trace (FR-098,
// docs/11 §9). Images load lazily and only from the Hub's own API paths; a screenshot past its
// retention (the Hub answers 404) shows "Screenshot no longer kept". A thumbnail opens the full
// image in a dialog, with a link to open it in a new tab.
import { useState } from 'react';
import { Button, Dialog, Icon } from '@nova/ui';
import './computers.css';

export interface ShotPaths {
  before: string | null;
  after: string | null;
}

/** Only same-origin Hub API paths are loaded as images (never a URL from elsewhere). */
export function isHubImagePath(src: string | null | undefined): src is string {
  return !!src && src.startsWith('/api/v1/') && !src.includes('..') && !src.includes('\\');
}

const WHICH = { before: 'Before', after: 'After' } as const;

export function Shots({ shots, title }: { shots: ShotPaths; title: string }) {
  const [open, setOpen] = useState<'before' | 'after' | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const src = open ? shots[open] : null;
  return (
    <div className="shots" role="group" aria-label={`Screenshots: ${title}`}>
      {(['before', 'after'] as const).map((which) => {
        const path = shots[which];
        const label = WHICH[which];
        let body;
        if (!isHubImagePath(path)) body = <span className="shot-none">Not captured</span>;
        else if (missing.has(which))
          body = <span className="shot-none">Screenshot no longer kept</span>;
        else
          body = (
            <button
              type="button"
              className="shot-button"
              aria-label={`Open the ${which} screenshot full size`}
              onClick={() => setOpen(which)}
            >
              <img
                className="shot-img"
                src={path}
                alt={`${label}: ${title}`}
                loading="lazy"
                decoding="async"
                onError={() => setMissing((s) => new Set(s).add(which))}
              />
            </button>
          );
        return (
          <figure key={which} className="shot">
            {body}
            <figcaption className="muted">{label}</figcaption>
          </figure>
        );
      })}
      <Dialog
        open={open !== null && isHubImagePath(src) && !missing.has(open)}
        title={open ? `${WHICH[open]}: ${title}` : 'Screenshot'}
        className="shot-dialog"
        onClose={() => setOpen(null)}
        footer={
          <>
            {isHubImagePath(src) ? (
              <a
                className="nv-btn"
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                data-variant="ghost"
              >
                <Icon name="external" /> Open in a new tab
              </a>
            ) : null}
            <Button onClick={() => setOpen(null)}>Close</Button>
          </>
        }
      >
        {open && isHubImagePath(src) ? (
          <img
            className="shot-full"
            src={src}
            alt={`${WHICH[open]}: ${title}`}
            onError={() => {
              setMissing((s) => new Set(s).add(open));
              setOpen(null);
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
