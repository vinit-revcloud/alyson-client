import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import type { WorkspaceActivityRow } from "@/lib/workspace-activity-functions";

function topNBy<T>(rows: T[], pick: (row: T) => number, n = 10) {
  return [...rows].sort((a, b) => pick(b) - pick(a)).slice(0, n);
}

function drawBarChart(args: {
  doc: jsPDF;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  labels: string[];
  values: number[];
  color: [number, number, number];
}) {
  const { doc, title, x, y, w, h, labels, values, color } = args;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(title, x, y - 6);

  const max = Math.max(1, ...values);
  const barAreaH = h - 26;
  const barAreaY = y + 4;
  const gap = 4;
  const bw = Math.max(8, (w - gap * (values.length + 1)) / Math.max(1, values.length));

  doc.setDrawColor(220);
  doc.rect(x, barAreaY, w, barAreaH);

  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    const bh = (v / max) * (barAreaH - 8);
    const bx = x + gap + i * (bw + gap);
    const by = barAreaY + barAreaH - bh - 2;
    doc.setFillColor(color[0], color[1], color[2]);
    doc.rect(bx, by, bw, bh, "F");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(70);
    const label = String(labels[i] || "").slice(0, 12);
    doc.text(label, bx, barAreaY + barAreaH + 8, { maxWidth: bw + 8 });
    doc.text(String(v), bx, by - 2);
  }
}

export function downloadWorkspaceActivityPdf(args: {
  rows: WorkspaceActivityRow[];
  range: { start: string; end: string };
  generatedAt: string;
  filteredBy?: string;
}) {
  const { rows, range, generatedAt, filteredBy } = args;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const margin = 28;
  const pageW = doc.internal.pageSize.getWidth();

  const totalEmails = rows.reduce((n, r) => n + r.emailsSent, 0);
  const totalMeetings = rows.reduce((n, r) => n + r.meetingsCreated, 0);
  const totalDocs = rows.reduce((n, r) => n + r.docsCreated, 0);
  const totalChat = rows.reduce((n, r) => n + r.chatMessagesSent, 0);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Workspace Activity Report", margin, 28);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Window UTC: ${range.start} -> ${range.end}`, margin, 44);
  doc.text(`Generated: ${new Date(generatedAt).toLocaleString()}`, margin, 56);
  if (filteredBy?.trim()) doc.text(`Filtered by: ${filteredBy.trim()}`, margin, 68);
  doc.text(`Users shown: ${rows.length}`, pageW - 120, 44);

  const kpiY = 82;
  const kpiW = 170;
  const gap = 10;
  const kpis = [
    { label: "Total Emails Sent", value: totalEmails },
    { label: "Total Meetings", value: totalMeetings },
    { label: "Total Docs Created", value: totalDocs },
    { label: "Total Chat Messages", value: totalChat },
  ];
  for (let i = 0; i < kpis.length; i++) {
    const x = margin + i * (kpiW + gap);
    doc.setDrawColor(220);
    doc.rect(x, kpiY, kpiW, 54);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text(kpis[i]!.label, x + 8, kpiY + 14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(20);
    doc.text(String(kpis[i]!.value), x + 8, kpiY + 38);
  }

  const topEmails = topNBy(rows, (r) => r.emailsSent, 8);
  const topMeetings = topNBy(rows, (r) => r.meetingsCreated, 8);
  const topChat = topNBy(rows, (r) => r.chatMessagesSent, 8);
  const chartY = 166;
  const chartW = (pageW - margin * 2 - 20) / 2;
  drawBarChart({
    doc,
    title: "Top Users by Emails Sent",
    x: margin,
    y: chartY,
    w: chartW,
    h: 170,
    labels: topEmails.map((r) => r.userEmail),
    values: topEmails.map((r) => r.emailsSent),
    color: [37, 99, 235],
  });
  drawBarChart({
    doc,
    title: "Top Users by Meetings in Window",
    x: margin + chartW + 20,
    y: chartY,
    w: chartW,
    h: 170,
    labels: topMeetings.map((r) => r.userEmail),
    values: topMeetings.map((r) => r.meetingsCreated),
    color: [5, 150, 105],
  });

  // Third chart on next page for chat activity.
  doc.addPage();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Workspace Activity Charts (continued)", margin, 28);
  drawBarChart({
    doc,
    title: "Top Users by Chat Messages Sent",
    x: margin,
    y: 62,
    w: pageW - margin * 2,
    h: 210,
    labels: topChat.map((r) => r.userEmail),
    values: topChat.map((r) => r.chatMessagesSent),
    color: [220, 38, 38],
  });

  autoTable(doc, {
    startY: 292,
    margin: { left: margin, right: margin },
    head: [[
      "User Email",
      "Emails Sent",
      "Meetings",
      "Docs Created",
      "Chat Messages",
    ]],
    body: rows.map((r) => [
      r.userEmail,
      String(r.emailsSent),
      String(r.meetingsCreated),
      String(r.docsCreated),
      String(r.chatMessagesSent),
    ]),
    styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [245, 245, 245], textColor: 20 },
    columnStyles: {
      0: { cellWidth: 260 },
      1: { halign: "right" },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
    },
  });

  const day = range.start.slice(0, 10);
  doc.save(`workspace-activity-${day}.pdf`);
}

