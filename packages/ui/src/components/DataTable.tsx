import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Inbox } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../lib/cn.js';

import { Button } from './Button.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu.js';
import { EmptyState } from './EmptyState.js';
import { Skeleton } from './Skeleton.js';

import type { ColumnDef, SortingState, VisibilityState } from '@tanstack/react-table';
import type { ReactNode } from 'react';

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  data: TData[];
  /** Cursor pagination — pass what the API's `{ items, nextCursor }` gave you. */
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  onNextPage?: () => void;
  onPreviousPage?: () => void;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: TData) => void;
  getRowId?: (row: TData, index: number) => string;
  rowActions?: (row: TData) => ReactNode;
  enableColumnVisibility?: boolean;
  toolbar?: ReactNode;
  /** Skeleton row count while `isLoading` and `data` is still empty. */
  skeletonRows?: number;
}

export function DataTable<TData>({
  columns,
  data,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPreviousPage,
  isLoading,
  isError,
  errorMessage = 'Something went wrong loading this data.',
  onRetry,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  onRowClick,
  getRowId,
  rowActions,
  enableColumnVisibility,
  toolbar,
  skeletonRows = 6,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const allColumns: ColumnDef<TData, any>[] = rowActions // eslint-disable-line @typescript-eslint/no-explicit-any
    ? [
        ...columns,
        {
          id: '__actions',
          header: '',
          enableSorting: false,
          enableHiding: false,
          cell: ({ row }) => <div className="flex justify-end">{rowActions(row.original)}</div>,
        },
      ]
    : columns;

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId,
  });

  const showEmpty = !isLoading && !isError && data.length === 0;
  const showSkeleton = isLoading && data.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {(toolbar || enableColumnVisibility) && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1">{toolbar}</div>
          {enableColumnVisibility && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" rightIcon={<ChevronDown className="size-4" />}>
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {table
                  .getAllLeafColumns()
                  .filter((col) => col.getCanHide())
                  .map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={col.getIsVisible()}
                      onCheckedChange={(v) => col.toggleVisibility(!!v)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-[--sl-radius-lg] border border-[--sl-border]">
        <table className="w-full border-collapse text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-[--sl-border] bg-[--sl-surface-2]">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  return (
                    <th key={header.id} className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-[--sl-fg-muted]">
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 hover:text-[--sl-fg]"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortDir === 'asc' ? (
                            <ArrowUp className="size-3.5" aria-hidden="true" />
                          ) : sortDir === 'desc' ? (
                            <ArrowDown className="size-3.5" aria-hidden="true" />
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-40" aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {isError ? (
              <tr>
                <td colSpan={allColumns.length} className="p-0">
                  <EmptyState
                    icon={<AlertTriangle className="size-6" />}
                    title="Couldn't load this data"
                    description={errorMessage}
                    action={onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
                  />
                </td>
              </tr>
            ) : showSkeleton ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className="border-b border-[--sl-border]">
                  {allColumns.map((_col, j) => (
                    <td key={j} className="px-4 py-3">
                      <Skeleton className="h-4 w-full max-w-40" />
                    </td>
                  ))}
                </tr>
              ))
            ) : showEmpty ? (
              <tr>
                <td colSpan={allColumns.length} className="p-0">
                  <EmptyState icon={<Inbox className="size-6" />} title={emptyTitle} description={emptyDescription} />
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(
                    'border-b border-[--sl-border] last:border-0',
                    onRowClick && 'cursor-pointer hover:bg-[--sl-surface-2]',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 text-[--sl-fg]">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {(onNextPage || onPreviousPage) && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={!hasPreviousPage} onClick={onPreviousPage}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!hasNextPage} onClick={onNextPage}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

export type { ColumnDef } from '@tanstack/react-table';
