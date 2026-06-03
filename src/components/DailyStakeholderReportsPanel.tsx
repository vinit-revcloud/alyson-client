import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Mail, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  getDailyReportUiInfo,
  triggerDailyStakeholderReports,
} from "@/lib/daily-stakeholder-reports-functions";

export function DailyStakeholderReportsPanel() {
  const auth = useAuth();
  const canSend = auth.hasAnyRole(["super_admin", "ceo", "hr"]);
  const [sendCode, setSendCode] = useState("");

  const info = useQuery({
    queryKey: ["daily-report-ui-info"],
    queryFn: () => getDailyReportUiInfo(),
    enabled: canSend,
  });

  const send = useMutation({
    mutationFn: () => triggerDailyStakeholderReports({ data: { sendCode } }),
    onSuccess: (result) => {
      toast.success("Daily reports sent", {
        description: `ZIP (${result.zipSizeMb} MB) → ${result.recipients.join(", ")}`,
        duration: 8000,
      });
      setSendCode("");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to send daily reports");
    },
  });

  if (!canSend) {
    return (
      <div className="surface-card p-5 text-sm text-muted-foreground">
        Daily stakeholder emails are managed by HR leadership. Switch to an HR, CEO, or Super Admin role to
        send test reports.
      </div>
    );
  }

  const d = info.data;

  return (
    <div className="space-y-4">
      <div className="surface-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-md bg-muted grid place-items-center shrink-0">
            <Mail className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="font-medium text-[15px]">Daily stakeholder email</h2>
            <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
              Automated ZIP with company-wide CSV + Excel: Time Dashboard, Employee Scoring, and Workspace
              Activity. Hourly per-employee exports are off unless enabled on the server.
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
          <div className="rounded-md border border-border px-3 py-2">
            <dt className="text-muted-foreground">When (automatic)</dt>
            <dd className="font-medium mt-0.5">{d?.cronScheduleLabel ?? "…"}</dd>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <dt className="text-muted-foreground">Window</dt>
            <dd className="font-medium mt-0.5">Last {d?.hoursBack ?? 24} hours</dd>
          </div>
          <div className="rounded-md border border-border px-3 py-2 sm:col-span-2">
            <dt className="text-muted-foreground">Recipients</dt>
            <dd className="font-medium mt-0.5 break-words">
              {d?.recipientCount
                ? d.recipients.join(", ")
                : "Not configured (set DAILY_REPORT_RECIPIENTS on Vercel)"}
            </dd>
          </div>
          <div className="rounded-md border border-border px-3 py-2 sm:col-span-2">
            <dt className="text-muted-foreground">Included in ZIP</dt>
            <dd className="mt-0.5">
              {[
                d?.includeTimeDoctor && "Time Dashboard",
                d?.includeScoring && "Employee Scoring",
                d?.includeWorkspace && "Workspace Activity",
                d?.includeHourly && "Hourly (per employee)",
              ]
                .filter(Boolean)
                .join(" · ") || "…"}
            </dd>
          </div>
        </dl>

        {d && !d.enabled ? (
          <p className="text-[12px] text-amber-800 dark:text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
            Daily reports are disabled on the server (`DAILY_REPORT_ENABLED=false`).
          </p>
        ) : null}

        <div className="border-t border-border pt-4 space-y-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Send now (test)
          </p>
          <p className="text-[12px] text-muted-foreground">
            Builds the same ZIP as the nightly cron and emails stakeholders immediately. Can take 1–3 minutes.
          </p>
          {d?.requiresSendCode ? (
            <label className="block space-y-1 max-w-sm">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Send code</span>
              <input
                type="password"
                value={sendCode}
                onChange={(e) => setSendCode(e.target.value)}
                placeholder="Same as DAILY_REPORT_CRON_SECRET on server"
                className="w-full h-8 px-3 rounded-md border border-border bg-background text-sm"
                disabled={send.isPending}
                autoComplete="off"
              />
            </label>
          ) : null}
          <button
            type="button"
            disabled={!d?.enabled || !d?.recipientCount || send.isPending || (d?.requiresSendCode && !sendCode.trim())}
            onClick={() => send.mutate()}
            className="h-9 px-4 rounded-md bg-foreground text-background text-xs font-medium inline-flex items-center gap-2 hover:opacity-90 disabled:opacity-50"
          >
            {send.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Building ZIP & sending…
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                Send daily reports now
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
