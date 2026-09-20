// Streaming CSV: turns an (async) iterable of flat row objects into a Node
// `Readable` of CSV text, written to the response as it's produced — so
// admin report exports (routes/reports/*) never buffer the whole export in
// memory before sending it. `reply.send(readable)` in the route handler
// streams this directly to the client (chunked transfer encoding).

import { Readable } from 'node:stream';

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsvRow(values: unknown[]): string {
  return `${values.map(escapeCsvField).join(',')}\r\n`;
}

export interface CsvColumn<T> {
  key: keyof T & string;
  header: string;
}

/**
 * Builds a Readable stream of CSV text: a header line from `columns`, then
 * one line per row from `rows` (a plain array is fine — it's the iterable
 * contract, not eagerness, that matters here; every row query in this
 * module is already a single bounded per-day-aggregate array, so the
 * "don't buffer" guarantee this gives is about the *HTTP response*, not
 * about re-querying the DB lazily).
 */
export function csvStream<T extends Record<string, unknown>>(columns: Array<CsvColumn<T>>, rows: Iterable<T> | AsyncIterable<T>): Readable {
  async function* generate(): AsyncGenerator<string> {
    yield toCsvRow(columns.map((c) => c.header));
    for await (const row of rows) {
      yield toCsvRow(columns.map((c) => row[c.key]));
    }
  }
  return Readable.from(generate());
}
