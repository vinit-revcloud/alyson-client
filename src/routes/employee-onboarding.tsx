import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { FetchingBar } from "@/components/Skeleton";
import { BoardingDataTable } from "@/components/BoardingDataTable";
import { OnboardingEmployeeFormDrawer } from "@/components/OnboardingEmployeeFormDrawer";
import { useAuth } from "@/lib/auth";
import { blankOnboardingRow, ONBOARDING_COLUMNS, type OnboardingRow } from "@/lib/onboarding-schema";
import {
  deleteOnboardingUser,
  getOnboardingRoster,
  saveOnboardingRoster,
} from "@/lib/onboarding-functions";

export const Route = createFileRoute("/employee-onboarding")({
  head: () => ({ meta: [{ title: "Employee Onboarding — Alyson HR" }] }),
  component: EmployeeOnboardingPage,
});

const QUERY_KEY = ["employee-onboarding"];

function asOnboardingRow(row: Record<string, unknown>): OnboardingRow {
  return row as OnboardingRow;
}

function EmployeeOnboardingPage() {
  const auth = useAuth();
  const canEdit = auth.hasRole("super_admin");
  const qc = useQueryClient();
  const actor = auth.user?.email ?? null;

  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getOnboardingRoster(),
  });

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const rowsRef = useRef(rows);
  const rowsDirty = useRef(false);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [formRow, setFormRow] = useState<OnboardingRow | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    if (q.data?.rows) {
      if (!rowsDirty.current) {
        setRows(q.data.rows as Record<string, unknown>[]);
      }
    }
  }, [q.data?.rows]);

  const saveM = useMutation({
    mutationFn: async (payload: {
      rows: Record<string, unknown>[];
      op?: "create" | "update" | "bulk_replace";
      employeeId?: string;
      details?: string;
    }) =>
      saveOnboardingRoster({
        data: {
          rows: payload.rows,
          op: payload.op,
          employeeId: payload.employeeId,
          details: payload.details,
          actor,
        },
      }),
    onSuccess: (_data, variables) => {
      rowsDirty.current = false;
      if (variables.op === "update" || variables.op === "create") {
        toast.success("Data persisted");
      }
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save to S3"),
  });

  const deleteM = useMutation({
    mutationFn: async (employeeId: string) =>
      deleteOnboardingUser({ data: { employeeId, actor } }),
    onSuccess: (r) => {
      rowsDirty.current = false;
      setRows(r.rows as Record<string, unknown>[]);
      toast.success("User removed from onboarding roster");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to delete user"),
  });

  const persistRows = useCallback(
    (
      next: Record<string, unknown>[],
      meta?: { op?: "create" | "update" | "bulk_replace"; employeeId?: string; details?: string },
    ) => {
      if (!canEdit) return;
      setRows(next);
      rowsDirty.current = true;
      saveM.mutate({ rows: next, ...meta });
    },
    [canEdit, saveM],
  );

  const openAddForm = useCallback(() => {
    if (!canEdit) {
      toast.error("Super Admin only");
      return;
    }
    setFormMode("add");
    setFormRow(blankOnboardingRow());
    setFormOpen(true);
  }, [canEdit]);

  const openEditForm = useCallback(
    (rowId: string) => {
      if (!canEdit) {
        toast.error("Super Admin only");
        return;
      }
      const row = rowsRef.current.find((r) => String(r._rowId ?? "") === rowId);
      if (!row) {
        toast.error("Row not found");
        return;
      }
      setFormMode("edit");
      setFormRow(asOnboardingRow({ ...row }));
      setFormOpen(true);
    },
    [canEdit],
  );

  const handleFormSave = useCallback(
    (row: OnboardingRow) => {
      const employeeId = String(row["Employee ID"] ?? row._rowId ?? "").trim();
      if (formMode === "add") {
        const next = [row, ...rowsRef.current];
        persistRows(next, {
          op: "create",
          employeeId,
          details: `Added onboarding row for ${row.Name || employeeId}`,
        });
        toast.success(`Added ${row.Name || "employee"}`);
      } else {
        const next = rowsRef.current.map((r) =>
          String(r._rowId ?? "") === String(row._rowId ?? "") ? row : r,
        );
        persistRows(next, {
          op: "update",
          employeeId,
          details: `Updated onboarding row for ${row.Name || employeeId}`,
        });
      }
      setFormOpen(false);
      setFormRow(null);
    },
    [formMode, persistRows],
  );

  const handleRowsChange = useCallback(
    (next: Record<string, unknown>[]) => {
      const prev = rowsRef.current;
      const prevIds = new Set(prev.map((r) => String(r._rowId ?? "")));
      const nextIds = new Set(next.map((r) => String(r._rowId ?? "")));
      const removed = [...prevIds].find((id) => id && !nextIds.has(id));

      if (removed) {
        if (!canEdit) {
          toast.error("Super Admin only");
          return;
        }
        const snapshot = prev;
        setRows(next);
        rowsDirty.current = true;
        deleteM.mutate(removed, {
          onError: () => {
            setRows(snapshot);
            rowsDirty.current = false;
          },
        });
        return;
      }
    },
    [canEdit, deleteM],
  );

  const columns = useMemo(() => [...ONBOARDING_COLUMNS], []);

  const storageHint = q.data
    ? `s3://${q.data.bucket}/${q.data.key}`
    : "s3://alyson-hr-orgchart/onboarding/data.json";

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="People"
        title="Employee onboarding"
        description="Org chart onboarding roster — editable by Super Admin, persisted to S3 with an append-only operations log."
        dense
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <FetchingBar active={(q.isFetching && !q.data) || saveM.isPending || deleteM.isPending} />

        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Cloud className="h-3.5 w-3.5" />
            {storageHint}
          </span>
          {q.data?.updatedAt ? (
            <span className="text-muted-foreground">
              · Last saved {new Date(q.data.updatedAt).toLocaleString()}
            </span>
          ) : null}
          {saveM.isPending ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canEdit || saveM.isPending}
            onClick={openAddForm}
            className="h-8 px-3 rounded-md bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
            title={canEdit ? "Add a new onboarding user" : "Super Admin only"}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add user
          </button>
          <Link
            to="/boarding"
            className="h-8 px-3 rounded-md border border-border text-[11.5px] font-medium inline-flex items-center hover:bg-muted/50"
          >
            Boarding module
          </Link>
        </div>

        {q.isError ? (
          <div className="surface-card p-4 text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : "Failed to load onboarding roster"}
          </div>
        ) : null}

        {!q.isLoading && (
          <BoardingDataTable
            title="Onboarding roster"
            description="Click Edit to update a row in the form drawer. Changes sync to S3 on save."
            columns={columns}
            rows={rows}
            editable
            canEdit={canEdit}
            readOnlyCells
            onEditRow={openEditForm}
            onRowsChange={handleRowsChange}
            rowIdKey="_rowId"
            hideAddButton
            deleteConfirmNameKey="Name"
            deleteConfirmIdKey="Employee ID"
            facetFilters={[{ column: "Location", label: "Location" }]}
          />
        )}
      </div>

      <OnboardingEmployeeFormDrawer
        open={formOpen}
        mode={formMode}
        initialRow={formRow}
        saving={saveM.isPending}
        onClose={() => {
          setFormOpen(false);
          setFormRow(null);
        }}
        onSave={handleFormSave}
      />
    </div>
  );
}
