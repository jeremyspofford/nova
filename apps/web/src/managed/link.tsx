// An in-app link that keeps the browser's own behaviour for modified clicks (open in a new tab),
// for the managed and data-controls views and the small pieces they add to other pages.
import type { MouseEvent, ReactNode } from 'react';
import { navigate } from '../router.ts';

export function followInApp(e: MouseEvent, to: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  navigate(to);
}

export function InAppLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={to} className={className} onClick={(e) => followInApp(e, to)}>
      {children}
    </a>
  );
}
