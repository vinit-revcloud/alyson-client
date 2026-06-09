import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Cloud, Loader2 } from "lucide-react";
import { FetchingBar } from "@/components/Skeleton";
import { useAuth } from "@/lib/auth";
import { getBonusAuditLog } from "@/lib/bonus-functions";
import type { BonusOperation } from "@/lib/bonus-schema";
import { fmtDate } from "@/lib/format";

export const Route = createFileRoute("/bonus/audit")({
  component: BonusAuditPage,
});

const QUERY_KEY = ["bonus-audit-log"];

function BonusAuditPage() {
  const { hasRole } = useAuth();
  const isSuperAdmin = hasRole("super_admin");

  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getBonusAuditLog(),
  });

  const entries = q.data?.entries ?? [];

  return (
    <div className="px-5 md:px-8 py-6 space-y-6">
      <FetchingBar active={q.isFetching} />

      <div className="surface-card p-4">
        <div className="font-display text-lg">Operations log</div>
        <div className="text-[12px] text-muted-foreground mt-1">
          Append-only audit trail for bonus and share events. Every bootstrap, sync, and payment is persisted to S3 forever.
        </div>
        {q.data?.bucket && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
            <Cloud className="h-3.5 w-3.5 shrink-0" />
            s3://{q.data.bucket}/{q.data.key}
          </div>
        )}
        {!isSuperAdmin && (
          <div className="mt-2 text-[12px] text-muted-foreground">
            Event payloads are visible to Super Admin only.
          </div>
        )}
      </div>

      <div className="surface-ops overflow-x-auto">
        <div className="min-w-[900px]">
          <table className="ops-table w-full">
            <thead>
              <tr>
                <th align="left">Timestamp</th>
                <th align="left">Operation</th>
                <th align="left">Employee</th>
                <th align="left">Actor</th>
                <th align="left">Details</th>
                {isSuperAdmin && <th align="left">Event</th>}
              </tr>
            </thead>
            <tbody>
              {q.isLoading ? (
                <tr>
                  <td colSpan={isSuperAdmin ? 6 : 5} className="text-center py-10 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin inline-block" />
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={isSuperAdmin ? 6 : 5} className="text-center py-10 text-muted-foreground text-[13px]">
                    No operations logged yet.
                  </td>
                </tr>
              ) : (
                entries.map((r, i) => (
                  <tr key={`${r.ts}-${i}`}>
                    <td className="text-muted-foreground text-[12px] whitespace-nowrap">
                      {fmtDate(r.ts.slice(0, 10))} {r.ts.slice(11, 19)}
                    </td>
                    <td>
                      <span className={"pill " + pillFor(r.op)}>{r.op.replace("_", " ")}</span>
                    </td>
                    <td className="text-muted-foreground text-[12px]">
                      {r.employeeName || r.employeeId || "—"}
                    </td>
                    <td className="text-muted-foreground text-[12px]">{r.actor || "—"}</td>
                    <td className="text-[12px] max-w-[280px]">{r.details || "—"}</td>
                    {isSuperAdmin && (
                      <td className="font-mono text-[11px] text-muted-foreground max-w-[320px] overflow-x-auto whitespace-nowrap">
                        {r.event ? JSON.stringify(r.event) : "—"}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function pillFor(op: BonusOperation) {
  if (op === "bootstrap" || op === "sync") return "pill-info";
  if (op === "append_bonus") return "pill-success";
  if (op === "void_bonus" || op === "void_share") return "pill-danger";
  return "pill-neutral";
}
