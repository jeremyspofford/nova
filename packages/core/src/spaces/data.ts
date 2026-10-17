// Connected data for sites (FR-037): a project source holding JSON or CSV becomes rows of plain
// values, written into the site as `data/<name>.json` and usable by tables and charts in its
// pages. Parsing is bounded (size, rows, columns) and never evaluates anything.
import { NovaError } from '@nova/shared';

export const DATA_LIMITS = { bytes: 2 * 1024 * 1024, rows: 5_000, columns: 50 } as const;

export type DataValue = string | number | boolean | null;
export type DataRow = Record<string, DataValue>;

/** Whether a source's name or type says it is JSON or CSV. */
export function dataFormatOf(name: string, mime: string): 'json' | 'csv' | null {
  const m = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (m === 'application/json' || /\.json$/i.test(name)) return 'json';
  if (m === 'text/csv' || m === 'application/csv' || /\.csv$/i.test(name)) return 'csv';
  return null;
}

export function parseData(bytes: Buffer, format: 'json' | 'csv'): DataRow[] {
  if (bytes.length > DATA_LIMITS.bytes)
    throw new NovaError('validation', 'connected data must be 2 MB or smaller', {
      details: { reason: 'size' },
    });
  const raw = bytes.toString('utf8');
  // A byte order mark is not data.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return format === 'json' ? parseJsonRows(text) : parseCsv(text);
}

function cell(v: unknown): DataValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Nested values are kept as their JSON text.
  return JSON.stringify(v) ?? null;
}

function parseJsonRows(text: string): DataRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new NovaError('validation', 'the data is not valid JSON', {
      details: { reason: 'parse' },
    });
  }
  // An array of objects, or an object holding one (e.g. {"rows": [...]}).
  if (!Array.isArray(raw) && raw && typeof raw === 'object') {
    const inner = Object.values(raw).find(Array.isArray);
    if (inner) raw = inner;
  }
  if (!Array.isArray(raw))
    throw new NovaError('validation', 'JSON data must be a list of rows', {
      details: { reason: 'shape' },
    });
  return raw.slice(0, DATA_LIMITS.rows).map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { value: cell(r) };
    const row: DataRow = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>).slice(0, DATA_LIMITS.columns))
      row[k.slice(0, 80)] = cell(v);
    return row;
  });
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF; the first row names the columns. */
export function parseCsv(text: string): DataRow[] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.some((f) => f !== '')) records.push(record);
      record = [];
      if (records.length > DATA_LIMITS.rows) break;
    } else field += c;
  }
  record.push(field);
  if (record.some((f) => f !== '')) records.push(record);
  const [head, ...rows] = records;
  if (!head) return [];
  const cols = head
    .slice(0, DATA_LIMITS.columns)
    .map((h, i) => h.trim().slice(0, 80) || `column${i + 1}`);
  return rows.slice(0, DATA_LIMITS.rows).map((r) => {
    const row: DataRow = {};
    cols.forEach((col, i) => {
      const v = (r[i] ?? '').trim();
      row[col] =
        v !== '' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) && Number.isFinite(Number(v))
          ? Number(v)
          : v;
    });
    return row;
  });
}
