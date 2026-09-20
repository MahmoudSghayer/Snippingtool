/** Client-side CSV export for admin tables whose server-side export route
 * isn't in the current API contract yet (e.g. GET /admin/audit/export.csv —
 * documented in docs/03-api.md but not present in the committed
 * apps/api/openapi/openapi.json as of this pass, see docs/07-dashboard.md
 * "Known API gaps"). Exports exactly what's currently loaded/filtered in the
 * table, which is honest about its scope (it is not a full unpaginated
 * server export) and needs nothing beyond data already on the page. */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
