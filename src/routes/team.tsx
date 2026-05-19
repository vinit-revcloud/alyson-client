import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchOverview, type EmployeeFull } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/AppShell";
import { PageSkeleton } from "@/components/Skeleton";
import { fmtCurrency } from "@/lib/format";
import { lazy, Suspense, useEffect, useState } from "react";
import { Search, Users, LayoutGrid, Network, Plus } from "lucide-react";
const OrgChart = lazy(() => import("@/components/OrgChart").then((m) => ({ default: m.OrgChart })));

function employeeInitials(name: string | undefined | null) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}

function formatPerformanceScore(score: unknown) {
  const n = Number(score);
  return Number.isFinite(n) ? n.toFixed(1) : "—";
}
import { EmployeeDrawer } from "@/components/drawers/EmployeeDrawer";
import { CreateUserDrawer } from "@/components/drawers/CreateUserDrawer";
import { useAuth } from "@/lib/auth";
import { syncHrOverviewToS3 } from "@/lib/hr-s3-overview-functions";
import { persistOrgChartRosterToS3 } from "@/lib/orgchart-functions";
import { toast } from "sonner";

export const Route = createFileRoute("/team")({
  head: () => ({ meta: [{ title: "Team — Alyson HR" }] }),
  component: TeamPage,
});

function TeamPage() {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({ queryKey: ["overview"], queryFn: fetchOverview });
  const [q, setQ] = useState("");
  const [dept, setDept] = useState<string>("all");
  const [view, setView] = useState<"directory" | "chart">("directory");
  const [picked, setPicked] = useState<EmployeeFull | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const auth = useAuth();
  const isSuperAdmin = auth.hasRole("super_admin");

  useEffect(() => {
    if (!data?.employees?.length) return;
    void persistOrgChartRosterToS3({
      data: {
        source: "revcloud",
        employees: data.employees.map((e) => ({
          id: e.id,
          full_name: e.full_name,
          email: e.email,
          role: e.role,
          level: e.level,
          department_id: e.department_id,
          department_name: e.department_name,
          manager_id: (e as EmployeeFull & { manager_id?: string | null }).manager_id ?? null,
          manager_name: (e as EmployeeFull & { manager_name?: string | null }).manager_name ?? null,
        })),
      },
    });
  }, [data?.employees]);

  const syncToS3 = useMutation({
    mutationFn: async (source: "revcloud" | "supabase") => {
      return await syncHrOverviewToS3({ data: { source } });
    },
    onSuccess: (r) => {
      toast.success(`Synced team snapshot to S3 (${r.bucket})`);
      refetch();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to sync to S3");
    },
  });

  if (isLoading) return <PageSkeleton />;

  if (isError) {
    const msg =
      (error instanceof Error ? error.message : String(error ?? "")) ||
      "Unknown error";

    const missingEnv =
      msg.toLowerCase().includes("missing supabase environment variables") ||
      msg.toLowerCase().includes("vite_supabase_url") ||
      msg.toLowerCase().includes("vite_supabase_publishable_key");

    return (
      <div className="ops-dense">
        <PageHeader eyebrow="People" title="Team directory" description="Browse, filter, and drill into every active employee across the organization." />
        <div className="px-5 md:px-8 py-10">
          <EmptyState
            icon={Users}
            title="Unable to load team members"
            description={
              missingEnv
                ? "Your deployment is missing Supabase client env vars. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to your hosting provider and redeploy."
                : msg
            }
            actions={
              <button
                onClick={() => refetch()}
                className="h-8 px-3 rounded-md bg-foreground text-background text-[12px] font-medium"
              >
                Retry
              </button>
            }
          />
        </div>
      </div>
    );
  }

  if (!data) return <PageSkeleton />;

  const filtered = data.employees.filter((e) => {
    if (dept !== "all" && e.department_id !== dept) return false;
    if (
      q &&
      !e.full_name.toLowerCase().includes(q.toLowerCase()) &&
      !e.role.toLowerCase().includes(q.toLowerCase()) &&
      !e.email.toLowerCase().includes(q.toLowerCase())
    )
      return false;
    return true;
  });

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="People"
        title="Team directory"
        description="Browse, filter, and drill into every active employee across the organization."
        actions={
          <div className="flex items-center gap-2">
            {auth.hasRole("super_admin") && (
              <button
                onClick={() => syncToS3.mutate("revcloud")}
                disabled={syncToS3.isPending}
                className="h-7 px-2.5 rounded-md border border-border bg-paper text-[11.5px] font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
                title="Write RevCloud team roster to S3 (creates bucket if missing)"
              >
                {syncToS3.isPending ? "Syncing…" : "Sync roster → S3"}
              </button>
            )}
            {auth.hasRole("super_admin") && (
              <button
                onClick={() => setCreateOpen(true)}
                className="h-7 px-2.5 rounded-md bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                Create user
              </button>
            )}
            <div className="inline-flex rounded-md border border-border p-0.5 bg-paper">
              <button
                onClick={() => setView("directory")}
                className={"h-7 px-2.5 rounded text-[11.5px] font-medium flex items-center gap-1.5 " + (view === "directory" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              >
                <LayoutGrid className="h-3 w-3" />Directory
              </button>
              <button
                onClick={() => setView("chart")}
                className={"h-7 px-2.5 rounded text-[11.5px] font-medium flex items-center gap-1.5 " + (view === "chart" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              >
                <Network className="h-3 w-3" />Org chart
              </button>
            </div>
          </div>
        }
      />
      <div className="px-5 md:px-8 py-6 space-y-5">
        {view === "directory" && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or role…" className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]" />
              </div>
              <select value={dept} onChange={(e) => setDept(e.target.value)} className="h-8 px-2 rounded-md border border-border bg-background text-[13px]">
                <option value="all">All departments</option>
                {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <div className="sm:ml-auto text-xs text-muted-foreground">{filtered.length} of {data.employees.length}</div>
            </div>

            {filtered.length === 0 ? (
              <EmptyState icon={Users} title="No employees match your filters" description="Try clearing the search or selecting all departments." />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {filtered.map((e) => (
                  isSuperAdmin ? (
                    <button
                      key={e.id}
                      onClick={() => setPicked(e)}
                      className="surface-card p-4 hover:shadow-lg transition-shadow group text-left"
                    >
                      <div className="flex items-start gap-3">
                        <div className="h-10 w-10 rounded-full bg-accent text-accent-foreground grid place-items-center font-medium text-sm shrink-0">
                          {employeeInitials(e.full_name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-[14px] truncate">{e.full_name}</div>
                          <div className="text-[12px] text-muted-foreground truncate">{e.role}</div>
                          <div className="text-[11px] text-muted-foreground/80 truncate">{e.email}</div>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-[11px] flex-wrap">
                        <span className="pill pill-neutral">{e.department_name}</span>
                        <span className="pill pill-neutral">L{e.level}</span>
                        <span
                          className={`pill ${e.performance_score >= 4 ? "pill-success" : e.performance_score >= 3 ? "pill-info" : "pill-warning"}`}
                        >
                          {formatPerformanceScore(e.performance_score)}★
                        </span>
                      </div>
                      <div className="mt-3 pt-3 border-t border-border text-[11px] text-muted-foreground flex justify-between">
                        <span>Total comp</span>
                        <span className="font-mono text-foreground">{fmtCurrency(e.total_comp, { compact: true })}</span>
                      </div>
                    </button>
                  ) : (
                    <div key={e.id} className="surface-card p-4 text-left">
                      <div className="flex items-start gap-3">
                        <div className="h-10 w-10 rounded-full bg-accent text-accent-foreground grid place-items-center font-medium text-sm shrink-0">
                          {employeeInitials(e.full_name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-[14px] truncate">{e.full_name}</div>
                          <div className="text-[12px] text-muted-foreground truncate">{e.role}</div>
                          <div className="text-[11px] text-muted-foreground/80 truncate">{e.email}</div>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-[11px] flex-wrap">
                        <span className="pill pill-neutral">{e.department_name}</span>
                        <span className="pill pill-neutral">L{e.level}</span>
                        <span
                          className={`pill ${e.performance_score >= 4 ? "pill-success" : e.performance_score >= 3 ? "pill-info" : "pill-warning"}`}
                        >
                          {formatPerformanceScore(e.performance_score)}★
                        </span>
                      </div>
                      <div className="mt-3 pt-3 border-t border-border text-[11px] text-muted-foreground flex justify-between">
                        <span>Total comp</span>
                        <span className="font-mono text-foreground">{fmtCurrency(e.total_comp, { compact: true })}</span>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
          </>
        )}

        {view === "chart" && (
          <Suspense
            fallback={
              <div className="surface-card p-10 text-center text-[13px] text-muted-foreground">Loading org chart…</div>
            }
          >
            <OrgChart employees={data.employees} canEdit={auth.hasRole("super_admin")} />
          </Suspense>
        )}
      </div>

      {isSuperAdmin && <EmployeeDrawer employee={picked} onClose={() => setPicked(null)} />}
      <CreateUserDrawer open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
