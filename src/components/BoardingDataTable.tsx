import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as AlertDialog from "@radix-ui/react-alert-dialog";

function toText(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

function isDateColumn(col: string): boolean {
  const c = col.toLowerCase();
  if (c.includes("timestamp")) return false;
  return c.includes("date") || c.includes("doj") || c.includes("joining") || c.includes("last day");
}

function toDateInputValue(v: string): string {
  // Accept already-ISO yyyy-mm-dd, otherwise best-effort parse.
  const trimmed = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function EditableTextCell({
  value,
  disabled,
  isLong,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  isLong: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Only reset draft when switching to a different cell value from outside.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const common =
    "w-full bg-background border border-border rounded-md text-[12px] text-foreground disabled:opacity-60";

  const commit = () => {
    if (draft === value) return;
    onCommit(draft);
  };

  if (isLong) {
    return (
      <textarea
        value={draft}
        disabled={disabled}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            (e.currentTarget as HTMLTextAreaElement).blur();
          }
        }}
        className={common + " px-2 py-1.5 min-w-[260px]"}
      />
    );
  }

  return (
    <input
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className={common + " h-7 px-2 min-w-[180px]"}
    />
  );
}

export function BoardingDataTable({
  title,
  description,
  columns,
  rows,
  initialFilter = "",
  editable = false,
  canEdit = false,
  onRowsChange,
  rowIdKey = "_rowId",
  hideAddButton = false,
  deleteConfirmNameKey,
  deleteConfirmIdKey,
  readOnlyCells = false,
  onEditRow,
}: {
  title: string;
  description?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  initialFilter?: string;
  /** Shows CRUD controls in the table header */
  editable?: boolean;
  /** Enables inline edits (typically gated by super_admin) */
  canEdit?: boolean;
  onRowsChange?: (next: Record<string, unknown>[]) => void;
  /** Property name that holds a stable row id */
  rowIdKey?: string;
  /** Hide the built-in Add row button (use an external add action instead). */
  hideAddButton?: boolean;
  /** Show this column's value in the delete confirmation dialog. */
  deleteConfirmNameKey?: string;
  /** Optional secondary id shown in delete confirmation (e.g. Employee ID). */
  deleteConfirmIdKey?: string;
  /** Read-only table cells; use with onEditRow for form-based editing. */
  readOnlyCells?: boolean;
  onEditRow?: (rowId: string) => void;
}) {
  const [globalFilter, setGlobalFilter] = useState(initialFilter);
  const [sorting, setSorting] = useState<SortingState>([]);

  const isEditable = editable && !!onRowsChange;

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteRowId, setDeleteRowId] = useState<string>("");
  const [deleteTyped, setDeleteTyped] = useState<string>("");

  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const updateCell = useCallback(
    (rowId: string, col: string, value: string) => {
      if (!onRowsChange) return;
      const current = rowsRef.current;
      const next = current.map((r) => (String(r[rowIdKey] ?? "") === rowId ? { ...r, [col]: value } : r));
      rowsRef.current = next;
      onRowsChange(next);
    },
    [onRowsChange, rowIdKey],
  );

  const deleteRow = useCallback(
    (rowId: string) => {
      if (!onRowsChange) return;
      const current = rowsRef.current;
      const next = current.filter((r) => String(r[rowIdKey] ?? "") !== rowId);
      rowsRef.current = next;
      onRowsChange(next);
      if (!deleteConfirmNameKey) toast.success("Row deleted");
    },
    [deleteConfirmNameKey, onRowsChange, rowIdKey],
  );

  const addRow = useCallback(() => {
    if (!onRowsChange) return;
    const blank: Record<string, unknown> = { [rowIdKey]: `row_${Date.now()}_${Math.random().toString(16).slice(2)}` };
    columns.forEach((c) => (blank[c] = ""));
    const next = [blank, ...rowsRef.current];
    rowsRef.current = next;
    onRowsChange(next);
    toast.success("Row added");
  }, [columns, onRowsChange, rowIdKey]);

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      [
        ...(isEditable
          ? ([
              {
                id: "__actions__",
                header: "",
                accessorFn: () => "",
                enableSorting: false,
                cell: (info) => {
                  const rowId = info.row.id;
                  return (
                    <div className="flex items-center gap-1">
                      {onEditRow ? (
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => onEditRow(rowId)}
                          className="h-7 px-2 rounded-md border border-border text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-60 cursor-pointer"
                          title={canEdit ? "Edit row" : "Super Admin only"}
                        >
                          Edit
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => {
                          setDeleteRowId(rowId);
                          setDeleteTyped("");
                          setDeleteOpen(true);
                        }}
                        className="h-7 px-2 rounded-md border border-border text-[11.5px] text-muted-foreground hover:text-destructive disabled:opacity-60 cursor-pointer"
                        title={canEdit ? "Delete row" : "Super Admin only"}
                      >
                        Delete
                      </button>
                    </div>
                  );
                },
              } satisfies ColumnDef<Record<string, unknown>>,
            ] as ColumnDef<Record<string, unknown>>[])
          : []),
        ...columns.map(
          (c) =>
            ({
              id: c,
              header: c,
              accessorFn: (row) => row[c],
              cell: (info) => {
                const rowId = info.row.id;
                const v = info.getValue();
                const t = toText(v);

                if (!isEditable || readOnlyCells) return t.trim() ? t : "—";

                const value = t;
                const isLong = value.length > 42 || c.toLowerCase().includes("notes") || c.toLowerCase().includes("details") || c.toLowerCase().includes("comments");

                if (isDateColumn(c)) {
                  return (
                    <input
                      type="date"
                      value={toDateInputValue(value)}
                      // Don't disable: disabled inputs can't open the native calendar picker.
                      // Instead, allow opening the picker and block writes if user can't edit.
                      onChange={(e) => {
                        if (!canEdit) {
                          toast.error("Super Admin only");
                          return;
                        }
                        updateCell(rowId, c, e.target.value);
                      }}
                      className={
                        "w-full bg-background border border-border rounded-md text-[12px] text-foreground h-7 px-2 min-w-[180px] cursor-pointer " +
                        (!canEdit ? "opacity-60" : "")
                      }
                    />
                  );
                }
                return (
                  <EditableTextCell
                    value={value}
                    disabled={!canEdit}
                    isLong={isLong}
                    onCommit={(next) => updateCell(rowId, c, next)}
                  />
                );
              },
              sortingFn: (a, b, id) => {
                const av = toText(a.getValue(id)).toLowerCase();
                const bv = toText(b.getValue(id)).toLowerCase();
                return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
              },
            }) satisfies ColumnDef<Record<string, unknown>>,
        ),
      ],
    [canEdit, columns, isEditable, onEditRow, readOnlyCells, updateCell],
  );

  const deleteTarget = useMemo(() => {
    if (!deleteRowId) return null;
    return rows.find((r) => String(r[rowIdKey] ?? "") === deleteRowId) ?? null;
  }, [deleteRowId, rowIdKey, rows]);

  const deleteTargetName = deleteConfirmNameKey
    ? toText(deleteTarget?.[deleteConfirmNameKey]).trim()
    : "";
  const deleteTargetId = deleteConfirmIdKey ? toText(deleteTarget?.[deleteConfirmIdKey]).trim() : "";

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { globalFilter, sorting },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue ?? "").trim().toLowerCase();
      if (!q) return true;
      return columns.some((c) => toText(row.original[c]).toLowerCase().includes(q));
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => String(row[rowIdKey] ?? ""),
  });

  return (
    <section className="surface-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex flex-col gap-2">
        <div>
          <h2 className="font-medium text-[14px]">{title}</h2>
          {description ? <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p> : null}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Search this table…"
              className="w-full h-8 px-3 rounded-md border border-border bg-background text-[13px]"
            />
          </div>
          {isEditable && !hideAddButton && (
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => {
                addRow();
              }}
              className="h-8 px-3 rounded-md bg-foreground text-background text-[11.5px] font-medium disabled:opacity-60 cursor-pointer"
              title={canEdit ? "Add a new row" : "Super Admin only"}
            >
              Add row
            </button>
          )}
          <div className="text-[12px] text-muted-foreground tabular-nums sm:ml-auto">
            {table.getRowModel().rows.length} rows
          </div>
        </div>
        {isEditable && !canEdit && (
          <div className="text-[12px] text-muted-foreground">
            Editing is restricted to Super Admin.
          </div>
        )}
      </div>

      <div className="overflow-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-paper sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="text-left font-medium px-4 py-2.5 whitespace-nowrap select-none"
                  >
                    {h.isPlaceholder ? null : (
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 hover:underline underline-offset-4 cursor-pointer"
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {h.column.getIsSorted() === "asc"
                          ? "↑"
                          : h.column.getIsSorted() === "desc"
                            ? "↓"
                            : ""}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="[&>tr:hover]:bg-muted/20">
            {table.getRowModel().rows.map((r) => (
              <tr key={r.id} className="border-b border-border align-top">
                {r.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-6 text-[13px] text-muted-foreground">
                  No rows match your search.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {isEditable && (
        <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
            <AlertDialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[92vw] max-w-md surface-card p-4">
              <AlertDialog.Title className="font-medium text-[14px]">Confirm deletion</AlertDialog.Title>
              <AlertDialog.Description asChild>
                <div className="mt-1 space-y-2">
                  {deleteTargetName ? (
                    <p className="text-[13px] text-foreground">
                      You are about to remove{" "}
                      <span className="font-semibold">{deleteTargetName}</span>
                      {deleteTargetId ? (
                        <span className="text-muted-foreground"> ({deleteTargetId})</span>
                      ) : null}{" "}
                      from the onboarding roster.
                    </p>
                  ) : (
                    <p className="text-[12px] text-muted-foreground">You are about to delete this row.</p>
                  )}
                  <p className="text-[12px] text-muted-foreground">
                    Type <span className="font-mono text-[11px] px-1 rounded bg-muted">CONFIRM</span> to
                    continue.
                  </p>
                </div>
              </AlertDialog.Description>

              <div className="mt-3">
                <input
                  value={deleteTyped}
                  onChange={(e) => setDeleteTyped(e.target.value)}
                  placeholder='Type "CONFIRM"'
                  className="w-full h-9 px-3 rounded-md border border-border bg-background text-[13px]"
                  autoFocus
                />
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    className="h-8 px-3 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button
                    type="button"
                    disabled={!canEdit || deleteTyped !== "CONFIRM" || !deleteRowId}
                    onClick={() => {
                      if (!deleteRowId) return;
                      deleteRow(deleteRowId);
                      setDeleteOpen(false);
                      setDeleteRowId("");
                      setDeleteTyped("");
                    }}
                    className="h-8 px-3 rounded-md bg-foreground text-background text-[12px] font-medium disabled:opacity-60 cursor-pointer"
                  >
                    Delete row
                  </button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
    </section>
  );
}

