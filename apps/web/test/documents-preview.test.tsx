// Document previews in the Artifacts tab (FR-219, FR-038): DOCX, PPTX and XLSX artifacts show
// the text and tables the Hub extracted, PDFs keep the browser viewer and offer their text, a
// failed preview can be retried, and cards name the document kind.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { artifactKindText, documentFormatOf } from '../src/chat/Artifacts.tsx';
import type { DocumentPreviewView } from '../src/chat/Artifacts.tsx';
import { message } from './fakes.ts';
import { artifactView, inspector, openWith, stubFetch } from './chat-m3-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.unstubAllGlobals();
});

const preview = (id: string) => `/api/v1/artifacts/${id}/preview`;
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function doc(over: Partial<DocumentPreviewView>): string {
  return JSON.stringify({
    format: 'docx',
    title: null,
    readable: true,
    note: null,
    truncated: false,
    ...over,
  });
}

describe('document kinds (FR-219)', () => {
  it('tells documents apart by media type or file name', () => {
    expect(documentFormatOf({ kind: 'file', mime: MIME.docx, title: 'x' })).toBe('docx');
    expect(documentFormatOf({ kind: 'file', mime: `${MIME.xlsx}; q=1`, title: null })).toBe('xlsx');
    expect(documentFormatOf({ kind: 'file', title: 'Deck.PPTX' })).toBe('pptx');
    expect(documentFormatOf({ kind: 'pdf', title: 'r' })).toBe('pdf');
    expect(documentFormatOf({ kind: 'file', mime: 'application/zip', title: 'a.zip' })).toBeNull();
    expect(documentFormatOf({ kind: 'markdown', title: 'a.docx' })).toBeNull();
    expect(artifactKindText({ kind: 'file', title: 'Deck.pptx' })).toBe('Presentation (PPTX)');
    expect(artifactKindText({ kind: 'file', title: 'a.zip' })).toBe('File');
  });
});

describe('document previews (FR-219)', () => {
  it('shows a DOCX preview with headings, lists and tables, from a reply card', async () => {
    const fetchFn = stubFetch({
      [preview('art1')]: doc({
        blocks: [
          { type: 'heading', level: 1, text: 'Summary' },
          { type: 'paragraph', text: 'Revenue grew 12% in Q3' },
          { type: 'list', ordered: true, items: ['First', 'Second'] },
          { type: 'table', rows: [['Region', 'Sales'], ['North', '120'], ['South']] },
        ],
      }),
    });
    await openWith({
      messages: (tid) => [
        message(tid, {
          role: 'assistant',
          parts: [{ type: 'artifact', artifactId: 'art1', kind: 'file', title: 'Report.docx' }],
        }),
      ],
      m3: (tid) => ({
        artifacts: [
          artifactView(tid, { kind: 'file', mime: MIME.docx, title: 'Report.docx', size: 4096 }),
        ],
      }),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open artifact: Report.docx (Document (DOCX))' }),
    );
    const viewer = await within(inspector()).findByRole('article', { name: 'Report.docx' });
    expect(viewer.textContent).toContain('Document (DOCX), version 1, 4 KB');
    expect(await within(viewer).findByRole('heading', { name: 'Summary', level: 4 })).toBeTruthy();
    expect(within(viewer).getByText('Revenue grew 12% in Q3')).toBeTruthy();
    const items = within(viewer)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual(['First', 'Second']);
    const table = within(viewer).getByRole('region', { name: 'Table 4 of Report.docx' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Region', 'Sales']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(
      within(viewer)
        .getByRole('link', { name: /Download/ })
        .getAttribute('href'),
    ).toBe('/api/v1/artifacts/art1/content');
    expect(fetchFn).toHaveBeenCalledWith(`${preview('art1')}?v=1.0`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });

  it('shows spreadsheets sheet by sheet and slides with their notes', async () => {
    stubFetch({
      [preview('art1')]: doc({
        format: 'xlsx',
        sheets: [
          {
            name: 'Sales',
            rows: [
              ['Region', 'Amount'],
              ['North', '120.5'],
            ],
            truncated: true,
          },
          { name: 'Empty', rows: [], truncated: false },
        ],
        truncated: true,
      }),
      [preview('art2')]: doc({
        format: 'pptx',
        slides: [
          {
            index: 1,
            title: 'Goals',
            paragraphs: [{ text: 'Ship it', level: 0 }],
            notes: 'Say why.',
          },
          { index: 2, title: null, paragraphs: [], notes: null },
        ],
      }),
    });
    await openWith({
      m3: (tid) => ({
        artifacts: [
          artifactView(tid, { kind: 'file', mime: MIME.xlsx, title: 'Book.xlsx' }),
          artifactView(tid, { id: 'art2', kind: 'file', mime: MIME.pptx, title: 'Deck.pptx' }),
        ],
      }),
    });
    const list = await within(inspector()).findByRole('list', { name: 'Artifacts in this chat' });
    expect(within(list).getByRole('button', { name: /Book\.xlsx/ }).textContent).toContain(
      'Spreadsheet (XLSX)',
    );
    await userEvent.click(within(list).getByRole('button', { name: /Book\.xlsx/ }));
    const sheet = await within(inspector()).findByRole('region', { name: 'Sheet Sales' });
    const cells = within(sheet).getByRole('region', { name: 'Cells of Sales' });
    expect(within(cells).getByRole('cell', { name: '120.5' })).toBeTruthy();
    expect(within(sheet).getByText('Only the first rows and columns are shown.')).toBeTruthy();
    expect(within(inspector()).getByRole('region', { name: 'Sheet Empty' }).textContent).toContain(
      'Empty.',
    );
    expect(within(inspector()).getByText(/This preview shows the start only/)).toBeTruthy();

    await userEvent.click(within(inspector()).getByRole('button', { name: /All artifacts/ }));
    await userEvent.click(within(inspector()).getByRole('button', { name: /Deck\.pptx/ }));
    const slides = await within(inspector()).findByRole('list', { name: 'Slides' });
    expect(within(slides).getByText('Goals')).toBeTruthy();
    expect(within(slides).getByText('Ship it')).toBeTruthy();
    expect(within(slides).getByText('Notes: Say why.')).toBeTruthy();
    expect(within(slides).getByText('Slide 2')).toBeTruthy();
  });

  it('keeps the PDF viewer and shows its text on request, with the reader note', async () => {
    const fetchFn = stubFetch({
      [preview('art1')]: doc({
        format: 'pdf',
        pages: [
          { index: 1, text: 'First page\nsecond line' },
          { index: 2, text: '' },
        ],
        readable: true,
        note: 'Some characters in this PDF could not be read.',
      }),
    });
    await openWith({
      m3: (tid) => ({
        artifacts: [artifactView(tid, { kind: 'pdf', mime: 'application/pdf', title: 'Scan.pdf' })],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Scan\.pdf/ }));
    const viewer = await within(inspector()).findByRole('article', { name: 'Scan.pdf' });
    expect(viewer.querySelector('object')).not.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    const toggle = within(viewer).getByRole('button', { name: 'Show the text' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    const page = await within(viewer).findByRole('region', { name: 'Page 1' });
    expect(page.textContent).toContain('First page\nsecond line');
    expect(within(viewer).getByRole('region', { name: 'Page 2' }).textContent).toContain(
      '(no text)',
    );
    expect(within(viewer).getByText('Some characters in this PDF could not be read.')).toBeTruthy();
    await userEvent.click(within(viewer).getByRole('button', { name: 'Hide the text' }));
    expect(within(viewer).queryByRole('region', { name: 'Page 1' })).toBeNull();
  });

  it('reports a preview that failed to load and retries it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: () =>
            Promise.resolve(
              JSON.stringify({ error: { message: 'the file is not a valid zip package' } }),
            ),
        }),
      ),
    );
    await openWith({
      m3: (tid) => ({
        artifacts: [artifactView(tid, { kind: 'file', mime: MIME.docx, title: 'Bad.docx' })],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Bad\.docx/ }));
    const viewer = await within(inspector()).findByRole('article', { name: 'Bad.docx' });
    expect((await within(viewer).findByRole('alert')).textContent).toContain(
      'The preview could not be loaded: the file is not a valid zip package',
    );
    stubFetch({ [preview('art1')]: doc({ blocks: [{ type: 'paragraph', text: 'Fixed now' }] }) });
    await userEvent.click(within(viewer).getByRole('button', { name: 'Retry' }));
    expect(await within(viewer).findByText('Fixed now')).toBeTruthy();
  });

  it('says a gone document is gone', async () => {
    stubFetch({ [preview('art1')]: { status: 404 } });
    await openWith({
      m3: (tid) => ({
        artifacts: [artifactView(tid, { kind: 'file', mime: MIME.pptx, title: 'Old.pptx' })],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Old\.pptx/ }));
    const viewer = await within(inspector()).findByRole('article', { name: 'Old.pptx' });
    expect((await within(viewer).findByRole('alert')).textContent).toContain(
      'The artifact is gone.',
    );
  });
});
