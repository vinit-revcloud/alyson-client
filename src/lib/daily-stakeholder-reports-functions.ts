import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isDailyHourlyIncluded } from "@/lib/daily-employee-report-bundle.server";
import { buildAndSendDailyStakeholderReports } from "@/lib/daily-stakeholder-reports.server";
import { parseEmailList } from "@/lib/resend-mail.server";

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const show = local.length <= 2 ? local : `${local.slice(0, 2)}…`;
  return `${show}@${domain}`;
}

function expectedUiSendCode() {
  return (
    process.env.DAILY_REPORT_UI_SEND_CODE?.trim() ||
    process.env.DAILY_REPORT_CRON_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    ""
  );
}

export const getDailyReportUiInfo = createServerFn({ method: "GET" }).handler(async () => {
  const recipients = parseEmailList(process.env.DAILY_REPORT_RECIPIENTS);
  const enabled = process.env.DAILY_REPORT_ENABLED?.trim().toLowerCase();
  const disabled = enabled === "0" || enabled === "false" || enabled === "off";

  return {
    enabled: !disabled,
    recipients: recipients.map(maskEmail),
    recipientCount: recipients.length,
    hoursBack: Number(process.env.DAILY_REPORT_HOURS_BACK || "24") || 24,
    includeHourly: isDailyHourlyIncluded(),
    includeScoring: process.env.DAILY_REPORT_INCLUDE_SCORING?.trim().toLowerCase() !== "false",
    includeWorkspace: process.env.DAILY_REPORT_INCLUDE_WORKSPACE?.trim().toLowerCase() !== "false",
    includeTimeDoctor: process.env.DAILY_REPORT_INCLUDE_TIME_DOCTOR?.trim().toLowerCase() !== "false",
    cronScheduleLabel: "Every day at 6:00 AM IST (Vercel cron)",
    productionUrl: "https://alyson-client.vercel.app",
    requiresSendCode: Boolean(expectedUiSendCode()),
  };
});

const TriggerInput = z.object({
  sendCode: z.string().min(1, "Enter the daily report send code"),
});

export const triggerDailyStakeholderReports = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => TriggerInput.parse(data))
  .handler(async ({ data }) => {
    const expected = expectedUiSendCode();
    if (!expected) {
      throw new Error(
        "Set DAILY_REPORT_CRON_SECRET or DAILY_REPORT_UI_SEND_CODE on the server before using Send now.",
      );
    }
    if (data.sendCode.trim() !== expected) {
      throw new Error("Invalid send code");
    }
    return buildAndSendDailyStakeholderReports();
  });
