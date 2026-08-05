/** The right-hand pane: what a double-clicked file turns into.
 *
 *  A `<textarea>` and not an editor library. Adding CodeMirror or Monaco
 *  would mean `docker compose build frontend` AND `build web` before the
 *  change could be seen anywhere (package.json is baked into both images;
 *  only src/ and public/ are mounted), in exchange for syntax colours on a
 *  corpus that is 241 markdown notes. SkillsTab already edits markdown in a
 *  mono textarea — this is the same trade, made the same way.
 */

import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { fmtBytes } from '../components/ui';
import { FileRead, openRaw } from './api';

/** Frontmatter is data, not prose. Left in, react-markdown renders the whole
 *  YAML block as one run-on paragraph ("type: topic title: … timestamp: …")
 *  above the note, which is both ugly and a lie about what the file says. It
 *  is stripped for the PREVIEW only — the editor still shows every byte,
 *  because the editor is where you go to change it. */
function splitFrontmatter(text: string): [string, string] {
  if (!text.startsWith('---\n')) return ['', text];
  const end = text.indexOf('\n---', 3);
  if (end === -1) return ['', text];
  return [text.slice(4, end), text.slice(text.indexOf('\n', end + 1) + 1)];
}

export function Viewer({
  root, path, doc, draft, dirty, saving, mode, onBack, onDraft, onMode, onSave,
  title, onWikilink, resolveWikilink,
}: {
  root: string; path: string;
  doc: FileRead;
  draft: string; dirty: boolean; saving: boolean;
  mode: 'edit' | 'preview';
  /** Set only when the tree is hidden — the single-pane layout needs a way out. */
  onBack?: () => void;
  onDraft: (s: string) => void;
  onMode: (m: 'edit' | 'preview') => void;
  onSave: () => void;
  /** Vault only: the note's frontmatter title, which is what a `[[link]]`
   *  resolves by — so it leads and the filename drops to the path line. The
   *  Files tab passes nothing and keeps showing the filename it always did. */
  title?: string;
  /** Vault only. Absent ⇒ `[[Foo]]` stays literal text in the preview, which
   *  is what it has always been here. */
  onWikilink?: (title: string) => void;
  resolveWikilink?: (title: string) => boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [rawError, setRawError] = useState('');
  const isMd = doc.name.toLowerCase().endsWith('.md');

  // Ctrl/Cmd-S saves from inside the textarea, where the hands already are.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && doc.editable) onSave();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [dirty, doc.editable, onSave]);

  const header = (
    <div className="flex items-center justify-between gap-2 pb-2 border-b border-stone-800">
      <div className="min-w-0 flex items-center gap-2">
        {onBack && (
          <button onClick={onBack} aria-label="Back to the tree"
            className="shrink-0 text-stone-400 hover:text-stone-200 px-1 -ml-1">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
      <div className="min-w-0">
        <div className="text-sm text-stone-100 truncate">{title || doc.name}</div>
        <div className="text-[11px] font-mono text-stone-500 truncate">
          {path || doc.name} · {fmtBytes(doc.bytes)}
          {/* The blast radius of a title change, before the title is
              changed. A warning that only arrives at the save dialog is a
              warning that arrives after the typing. */}
          {!!doc.inbound_links && ` · ${doc.inbound_links} inbound link${doc.inbound_links === 1 ? '' : 's'}`}
          {doc.indexed === false && ' · not indexed'}
          {dirty && ' · unsaved'}
        </div>
      </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {isMd && doc.kind === 'text' && (
          <div className="flex rounded overflow-hidden border border-stone-700 text-[11px]">
            {(['edit', 'preview'] as const).map(m => (
              <button key={m} onClick={() => onMode(m)}
                className={`px-2 py-1 ${mode === m
                  ? 'bg-teal-700/50 text-teal-200' : 'text-stone-400 hover:text-stone-200'}`}>
                {m}
              </button>
            ))}
          </div>
        )}
        {doc.editable && (
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="px-2.5 py-1 text-xs rounded bg-teal-700 hover:bg-teal-600
                       disabled:bg-stone-800 disabled:text-stone-500 text-white"
          >
            {saving ? 'saving…' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );

  let body;
  if (doc.kind === 'binary') {
    body = (
      <div className="text-sm text-stone-400 space-y-2 pt-3">
        <p>{doc.reason}</p>
        <button
          onClick={() => { setRawError(''); openRaw(root, path).catch(e => setRawError(String(e.message ?? e))); }}
          className="text-teal-400 hover:text-teal-300 underline text-xs">
          Download it
        </button>
        {rawError && <div className="text-xs text-red-400">{rawError}</div>}
      </div>
    );
  } else if (mode === 'preview' && isMd) {
    const [fm, md] = splitFrontmatter(draft);
    body = (
      <div className="flex-1 overflow-auto nice-scroll pt-3 text-sm text-stone-300">
        {fm && (
          <pre className="mb-3 rounded border border-stone-800 bg-stone-950/60 p-2
                          text-[11px] font-mono text-stone-500 whitespace-pre-wrap">
            {fm}
          </pre>
        )}
        <Markdown onWikilink={onWikilink} resolveWikilink={resolveWikilink}>{md}</Markdown>
      </div>
    );
  } else {
    body = (
      <>
        {!!doc.dangling?.length && (
          <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1.5
                          text-[11px] text-amber-300/90">
            {doc.dangling.length === 1 ? 'This link points at no note: ' : 'These links point at no note: '}
            {doc.dangling.map(d => `[[${d}]]`).join(', ')}
          </div>
        )}
        {!doc.editable && doc.reason && (
          <div className="mt-2 rounded border border-stone-700 bg-stone-800/50 px-2 py-1.5
                          text-[11px] text-stone-400">
            {doc.reason}
          </div>
        )}
        <textarea
          ref={ta}
          value={draft}
          readOnly={!doc.editable}
          spellCheck={false}
          onChange={e => onDraft(e.target.value)}
          aria-label={`${doc.name} contents`}
          className="flex-1 mt-2 w-full resize-none bg-stone-950/60 border border-stone-800
                     rounded p-2 text-xs font-mono leading-relaxed text-stone-200
                     nice-scroll focus:outline-none focus:border-stone-600
                     read-only:text-stone-400"
        />
      </>
    );
  }

  return <div className="h-full flex flex-col min-h-0">{header}{body}</div>;
}
