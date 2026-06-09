import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { FileText, Users, GitBranch } from "lucide-react";
import { fetchOverview } from "@/lib/queries";
import { BOARDING_PDF_TABLES, type BoardingFlow } from "@/lib/boarding-pdf-schema";
import { BoardingDataTable } from "@/components/BoardingDataTable";
import { buildRowsForPdfTable, defaultTabForFlow } from "@/lib/boarding-mock-data";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/boarding")({
  head: () => ({ meta: [{ title: "Boarding — Alyson HR" }] }),
  component: BoardingPage,
});

const FLOWS = ["onboarding", "offboarding"] as const;

function BoardingPage() {
  const auth = useAuth();
  const canEdit = auth.hasRole("super_admin");

  const [flow, setFlow] = useState<BoardingFlow>("onboarding");
  const tables = useMemo(
    () =>
      BOARDING_PDF_TABLES.filter((t) => t.flow === "both" || t.flow === flow),
    [flow],
  );
  const [tabId, setTabId] = useState<string>(() => defaultTabForFlow("onboarding", BOARDING_PDF_TABLES));

  const { data: overview } = useQuery({ queryKey: ["overview"], queryFn: fetchOverview });
  const [employeeId, setEmployeeId] = useState<string>("");

  const employees = overview?.employees ?? [];
  const pickedEmployee = employees.find((e) => e.id === employeeId) ?? null;

  const activeTable = useMemo(() => {
    const fallback = tables[0] ?? null;
    return tables.find((t) => t.id === tabId) ?? fallback;
  }, [tabId, tables]);

  // Keep selected tab valid when switching flow
  useEffect(() => {
    if (!tables.some((t) => t.id === tabId)) {
      setTabId(defaultTabForFlow(flow, tables));
    }
  }, [flow, tabId, tables]);

  const rows = useMemo(() => {
    if (!activeTable) return [];
    // Prefer any explicit sample rows, otherwise generate dummy-filled rows.
    if (activeTable.sampleRows?.length) return activeTable.sampleRows;
    return buildRowsForPdfTable({ table: activeTable, flow, employees });
  }, [activeTable, employees, flow]);

  const withRowIds = useMemo(() => {
    return rows.map((r, i) => ({ _rowId: `${activeTable?.id ?? "t"}_${i}`, ...r }));
  }, [activeTable?.id, rows]);

  // Editable backing store (per-table, local to this module like Bonus).
  const [tableRows, setTableRows] = useState<Record<string, Record<string, unknown>[]>>({});

  useEffect(() => {
    if (!activeTable) return;
    setTableRows((prev) => {
      if (prev[activeTable.id]?.length) return prev;
      return { ...prev, [activeTable.id]: withRowIds };
    });
  }, [activeTable, withRowIds]);

  const displayRows = activeTable ? tableRows[activeTable.id] ?? withRowIds : withRowIds;
  const tabsRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="People"
        title="Onboarding & offboarding"
        description="CRM-first tables rendered from the schema in `boardingdetails.pdf` (tabs + fields)."
        dense
      />
      <div className="px-5 md:px-8 py-6 space-y-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="inline-flex rounded-md border border-border p-0.5 bg-paper shrink-0">
              {FLOWS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFlow(f)}
                  className={
                    "h-8 px-3 rounded text-[11.5px] font-medium capitalize " +
                    (flow === f
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {f === "onboarding" ? "Onboarding" : "Offboarding"}
                </button>
              ))}
            </div>
          </div>

          {/* Top visible tab strip (CRM style) */}
          <div className="surface-card p-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => tabsRef.current?.scrollBy({ left: -420, behavior: "smooth" })}
                className="h-8 w-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 shrink-0"
                aria-label="Scroll tabs left"
                title="Scroll left"
              >
                ‹
              </button>
              <div
                ref={tabsRef}
                className="flex gap-1 overflow-x-auto boarding-tabs-scroll flex-1 min-w-0"
              >
              {tables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTabId(t.id)}
                  className={
                    "h-8 px-3 rounded-md text-[12px] font-medium whitespace-nowrap " +
                    (activeTable?.id === t.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/40")
                  }
                >
                  {t.title}
                </button>
              ))}
              </div>
              <button
                type="button"
                onClick={() => tabsRef.current?.scrollBy({ left: 420, behavior: "smooth" })}
                className="h-8 w-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 shrink-0"
                aria-label="Scroll tabs right"
                title="Scroll right"
              >
                ›
              </button>
            </div>
          </div>
        </div>

        <div className="surface-card p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="font-medium text-[13px]">Employee onboarding roster</h3>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              Full org chart onboarding table with S3 persistence (Super Admin edits).
            </p>
          </div>
          <Link
            to="/employee-onboarding"
            className="h-8 px-3 rounded-md bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5 shrink-0"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Open onboarding module
          </Link>
        </div>

        <div className="flex flex-wrap gap-2 text-[12px]">
          <span className="text-muted-foreground mr-1 self-center">Shortcuts:</span>
          <Link
            to="/team"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-paper hover:bg-muted/50 text-foreground"
          >
            <Users className="h-3.5 w-3.5" />
            Team
          </Link>
          <Link
            to="/documents"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-paper hover:bg-muted/50 text-foreground"
          >
            <FileText className="h-3.5 w-3.5" />
            Documents
          </Link>
          <Link
            to="/workflows"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-paper hover:bg-muted/50 text-foreground"
          >
            <GitBranch className="h-3.5 w-3.5" />
            Workflows
          </Link>
        </div>

        <div className="space-y-4">
          {activeTable ? (
            <BoardingDataTable
              title={activeTable.title}
              description={activeTable.description}
              columns={activeTable.columns}
              rows={displayRows}
              initialFilter={""}
              editable
              canEdit={canEdit}
              onRowsChange={(next) => setTableRows((prev) => ({ ...prev, [activeTable.id]: next }))}
              rowIdKey="_rowId"
            />
          ) : (
            <div className="surface-card p-4 text-[13px] text-muted-foreground">
              No table found for this flow.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
