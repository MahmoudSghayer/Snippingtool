import { cn } from '../lib/cn.js';

export interface DiffViewerProps {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  className?: string;
}

function stringify(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Field-level before/after diff for audit log entries. Falls back to a
 * whole-object added/removed row when one side is entirely null (a create or
 * a delete), otherwise renders one row per changed key — unchanged keys are
 * omitted so a large row doesn't drown the actual edit. */
export function DiffViewer({ before, after, className }: DiffViewerProps) {
  if (!before && !after) {
    return (
      <p className="text-sm text-(--sl-fg-muted)">No before/after data recorded for this entry.</p>
    );
  }
  if (!before) {
    return (
      <div
        className={cn(
          'rounded-(--sl-radius-md) border border-(--sl-positive)/30 bg-(--sl-positive)/5 p-3',
          className,
        )}
      >
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-(--sl-positive)">
          Created
        </p>
        <DiffTable
          rows={Object.entries(after ?? {}).map(([key, value]) => ({
            key,
            before: undefined,
            after: value,
          }))}
        />
      </div>
    );
  }
  if (!after) {
    return (
      <div
        className={cn(
          'rounded-(--sl-radius-md) border border-(--sl-negative)/30 bg-(--sl-negative)/5 p-3',
          className,
        )}
      >
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-(--sl-negative)">
          Deleted
        </p>
        <DiffTable
          rows={Object.entries(before ?? {}).map(([key, value]) => ({
            key,
            before: value,
            after: undefined,
          }))}
        />
      </div>
    );
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const rows = Array.from(keys)
    .filter((key) => stringify(before[key]) !== stringify(after[key]))
    .sort()
    .map((key) => ({ key, before: before[key], after: after[key] }));

  if (rows.length === 0) {
    return <p className="text-sm text-(--sl-fg-muted)">No field-level changes recorded.</p>;
  }

  return (
    <div className={className}>
      <DiffTable rows={rows} />
    </div>
  );
}

function DiffTable({ rows }: { rows: { key: string; before: unknown; after: unknown }[] }) {
  return (
    <table className="w-full border-collapse font-mono text-xs">
      <thead>
        <tr className="text-(--sl-fg-muted)">
          <th className="w-1/4 border-b border-(--sl-border) px-2 py-1.5 text-left font-medium">
            Field
          </th>
          <th className="border-b border-(--sl-border) px-2 py-1.5 text-left font-medium">
            Before
          </th>
          <th className="border-b border-(--sl-border) px-2 py-1.5 text-left font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-(--sl-border) last:border-0">
            <td className="px-2 py-1.5 align-top text-(--sl-fg-muted)">{row.key}</td>
            <td className="px-2 py-1.5 align-top text-(--sl-negative)/90 break-all">
              {row.before === undefined ? (
                <span className="text-(--sl-fg-muted)">—</span>
              ) : (
                stringify(row.before)
              )}
            </td>
            <td className="px-2 py-1.5 align-top text-(--sl-positive)/90 break-all">
              {row.after === undefined ? (
                <span className="text-(--sl-fg-muted)">—</span>
              ) : (
                stringify(row.after)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
