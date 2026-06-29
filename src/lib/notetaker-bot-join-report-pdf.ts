import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import type { BotJoinReport } from "@/lib/notetaker-bot-join-report.types";

function periodLabel(report: BotJoinReport) {
  if (report.range.windowHours) {
    const start = report.range.windowStart
      ? new Date(report.range.windowStart).toLocaleString()
      : report.range.start;
    const end = report.range.windowEnd
      ? new Date(report.range.windowEnd).toLocaleString()
      : report.range.end;
    return `Last ${report.range.windowHours}h (${start} → ${end})`;
  }
  return `${report.range.start} → ${report.range.end}`;
}

export function botJoinReportFilename(report: BotJoinReport) {
  return `alyson-bot-join-report_${report.calendarEmail.split("@")[0]}_${report.range.start}_${report.range.end}.pdf`;
}

export function downloadBotJoinReportPdf(report: BotJoinReport) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const margin = 40;
  const pageW = doc.internal.pageSize.getWidth();
  let y = margin;

  const addPageIfNeeded = (needed: number) => {
    if (y + needed > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Alyson Bot Join Report", margin, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const meta = [
    `Account: ${report.calendarEmail}`,
    `Period: ${periodLabel(report)}`,
    `Generated: ${new Date(report.generatedAt).toLocaleString()}`,
  ];
  for (const line of meta) {
    doc.text(line, margin, y);
    y += 14;
  }
  y += 8;

  const c = report.critical;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Critical metrics", margin, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const summary = [
    `Eligible meetings: ${c.totalEligibleMeetings}`,
    `Meetings joined: ${c.meetingsJoined}`,
    `Join rate: ${c.joinRatePercent != null ? `${c.joinRatePercent}%` : "—"}`,
    `Missed: ${c.meetingsMissed}`,
    `Avg minutes late (when late): ${c.avgLateMinutes != null ? `${c.avgLateMinutes}m` : "—"}`,
    `Max minutes late: ${c.maxLateMinutes != null ? `${c.maxLateMinutes}m` : "—"}`,
    `Joined late (>2m after start): ${c.meetingsJoinedLate}`,
    `Stuck in waiting room: ${c.stuckInWaitingRoom}`,
    `Failed joins: ${c.failedJoins}`,
  ];
  for (const line of summary) {
    addPageIfNeeded(14);
    doc.text(line, margin, y);
    y += 14;
  }
  y += 10;

  if (report.daily.some((d) => d.eligibleMeetings > 0 || d.meetingsJoined > 0)) {
    addPageIfNeeded(80);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Daily trends", margin, y);
    y += 8;

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Day", "Eligible", "Joined", "Missed", "Join %", "Avg late", "Max late"]],
      body: report.daily
        .filter((d) => d.eligibleMeetings > 0 || d.meetingsJoined > 0)
        .map((d) => [
          d.day,
          String(d.eligibleMeetings),
          String(d.meetingsJoined),
          String(d.meetingsMissed),
          d.joinRatePercent != null ? `${d.joinRatePercent}%` : "—",
          d.avgLateMinutes != null ? `${d.avgLateMinutes}m` : "—",
          d.maxLateMinutes != null ? `${d.maxLateMinutes}m` : "—",
        ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [40, 40, 40] },
      theme: "grid",
    });
    y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 40;
    y += 16;
  }

  if (report.joinedMeetings.length > 0) {
    addPageIfNeeded(80);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Meetings joined", margin, y);
    y += 8;

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Meeting", "Start", "Admitted", "Late", "Wait"]],
      body: report.joinedMeetings.map((row) => [
        row.title.slice(0, 42),
        formatShortTs(row.meetingStartAt || row.scheduledStart),
        formatShortTs(row.admittedAt),
        row.lateToStartLabel,
        row.waitingRoomLabel,
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [40, 40, 40] },
      theme: "grid",
      columnStyles: { 0: { cellWidth: 140 } },
    });
    y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 40;
    y += 16;
  }

  if (report.missedMeetings.length > 0) {
    addPageIfNeeded(60);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Eligible meetings not joined", margin, y);
    y += 8;

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Meeting", "Scheduled start"]],
      body: report.missedMeetings.map((m) => [m.title.slice(0, 50), formatShortTs(m.startTime)]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [40, 40, 40] },
      theme: "grid",
    });
  }

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(
    "Lateness = admitted time vs calendar start. On time includes up to 20m early (planned bot join).",
    margin,
    doc.internal.pageSize.getHeight() - 24,
    { maxWidth: pageW - margin * 2 },
  );

  doc.save(botJoinReportFilename(report));
}

function formatShortTs(iso: string | null | undefined) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
