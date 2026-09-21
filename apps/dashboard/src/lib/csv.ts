import { API_BASE_URL } from '@/api/client.js';

/** Client-side CSV export for admin tables with no server-side export route
 * of their own — exports exactly what's currently loaded/filtered in the
 * table. Prefer `downloadServerCsv` below wherever the API has a real
 * server-side export (e.g. `GET /admin/audit/export.csv`, docs/03-api.md),
 * which streams the *full* filtered range, not just the page on screen. */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Downloads a server-generated CSV export (e.g. `GET
 * /admin/audit/export.csv`) via `fetch` with cookie credentials — a plain
 * `<a href>` navigation can't carry the httpOnly session cookie's
 * `credentials: 'include'` the way `fetch` can, and this stays consistent
 * with `api/client.ts`'s "every request goes through fetch with credentials"
 * convention rather than opening the URL directly. `path` is the full
 * `/api/v1/...` route plus its query string (matches `API_BASE_URL`'s own
 * "callers write the full path" convention, api/client.ts's header comment).
 * Throws (caller shows a toast) on a non-2xx response instead of downloading
 * an error body as if it were the CSV. */
export async function downloadServerCsv(filename: string, path: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
