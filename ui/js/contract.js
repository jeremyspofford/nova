// The theming contract (THEMING.md): every theme file defines all of these.
export const CONTRACT = {
  color: ['--bg', '--surface', '--raised', '--wash', '--text', '--text-2', '--text-3',
    '--hairline', '--accent', '--accent-wash', '--accent-text', '--success', '--warning',
    '--danger', '--code-bg'],
  type: ['--font', '--font-display', '--t-display', '--t-title', '--t-body', '--t-callout',
    '--t-caption', '--t-margin'],
  spacing: ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7'],
  shape: ['--r-card', '--r-bubble', '--r-input', '--r-pill', '--shadow-1', '--shadow-2'],
  motion: ['--ease', '--m-fast', '--m-med', '--m-slow'],
  // Additions this build needed; proposed for THEMING.md (see docs/LEDGER.md).
  extension: ['--font-mono', '--t-mono', '--t-wordmark', '--column', '--material-blur', '--shift'],
};
