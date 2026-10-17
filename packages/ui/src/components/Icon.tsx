// Original line icons drawn for Nova (docs/04 §4.1: never copy another app's icons). They inherit
// the current text color and are hidden from assistive tech; the control around them is labelled.
import type { ReactNode } from 'react';

const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h3M11 12h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
      <circle cx="9" cy="12" r="2" />
    </>
  ),
  chat: <path d="M4 5h16v11H10l-6 4z" />,
  work: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V4h6v3M3 13h18" />
    </>
  ),
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />,
  agents: (
    <>
      <circle cx="12" cy="9" r="4" />
      <path d="M5 20c1-4 4-6 7-6s6 2 7 6" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
  pin: <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />,
  check: <path d="M5 12l5 5 9-10" />,
  hand: (
    <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V11V4.5a1.5 1.5 0 0 1 3 0V11V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-.5A5.5 5.5 0 0 1 5 14.5V12a1.5 1.5 0 0 1 3 0" />
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  attach: (
    <path d="M15 7l-6.5 6.5a2 2 0 0 0 3 3L18 10a4 4 0 0 0-6-6l-6.5 6.5a6 6 0 0 0 8.5 8.5L19 14" />
  ),
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  inspector: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11h14V8M10 12h4" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16.5v.5" />
    </>
  ),
  file: <path d="M6 3h8l4 4v14H6zM14 3v4h4" />,
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  back: <path d="M15 6l-6 6 6 6" />,
  forward: <path d="M9 6l6 6-6 6" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9v1a4 4 0 0 1-4 4H9a3 3 0 0 0-3 3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4" />
    </>
  ),
  quote: <path d="M5 8h5v5c0 3-2 4.5-4 5M14 8h5v5c0 3-2 4.5-4 5" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  compare: (
    <>
      <rect x="3" y="4" width="8" height="16" rx="1" />
      <rect x="13" y="4" width="8" height="16" rx="1" />
    </>
  ),
  tool: <path d="M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 1-2-2z" />,
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />,
  at: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.5 6.9" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  artifact: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </>
  ),
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />,
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="1.5" />
      <rect x="4" y="13" width="16" height="7" rx="1.5" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </>
  ),
  down: <path d="M6 9l6 6 6-6" />,
  // M6.5 Network surface: three connected nodes.
  network: (
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M11 6.8L6 16.2M13 6.8l5 9.4M7 18h10" />
    </>
  ),
  // M4 workspace (FR-005, FR-006, FR-039, FR-041, FR-046).
  'split-right': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16M15 12h4M17 10v4" />
    </>
  ),
  'split-down': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18M12 14.5v3.5M10 16.25h4" />
    </>
  ),
  maximize: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  restore: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 14h18" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M4 18l5-5 4 4 3-3 4 4" />
    </>
  ),
  slash: <path d="M16 4L8 20" />,
  save: <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" />,
  undo: <path d="M9 7L5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2" />,
  redo: <path d="M15 7l4 4-4 4M19 11h-9a5 5 0 0 0 0 10h2" />,
  library: <path d="M5 4v16M10 4v16M14.5 4.5l4.5 15" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  grip: <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth="3" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps {
  name: IconName;
  /** CSS size; defaults to 1em so the icon follows the surrounding text size. */
  size?: string;
  className?: string;
}

export function Icon({ name, size = '1em', className }: IconProps) {
  return (
    <svg
      className={className ? `nv-icon ${className}` : 'nv-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}
