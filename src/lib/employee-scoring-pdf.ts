import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import type { EmployeeScoringResponse } from "@/lib/employee-scoring-functions";
import type { EmployeeScoreRow } from "@/lib/employee-scoring-rules";
import { SCORING_WEIGHTS } from "@/lib/employee-scoring-rules";

function topNBy(rows: EmployeeScoreRow[], pick: (row: EmployeeScoreRow) => number, n = 8) {
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
    const label = String(labels[i] || "").slice(0, 14);
    doc.text(label, bx, barAreaY + barAreaH + 8, { maxWidth: bw + 8 });
    doc.text(String(typeof v === "number" && v % 1 !== 0 ? v.toFixed(1) : v), bx, by - 2);
  }
  doc.setTextColor(20);
}

function fmtIst(iso: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export function downloadEmployeeScoringPdf(args: {
  rows: EmployeeScoreRow[];
  meta: Pick<
    EmployeeScoringResponse,
    "range" | "timeDoctorRange" | "windowDays" | "generatedAt" | "rules"
  >;
  filteredBy?: string;
}) {
  const { rows, meta, filteredBy } = args;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const margin = 28;
  const pageW = doc.internal.pageSize.getWidth();

  const avgScore =
    rows.length > 0 ? rows.reduce((n, r) => n + r.compositeScore, 0) / rows.length : 0;
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of rows) gradeCounts[r.grade] += 1;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Employee Scoring Report", margin, 28);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Workspace window (IST): ${fmtIst(meta.range.start)} -> ${fmtIst(meta.range.end)}`, margin, 44);
  doc.text(
    `Time Doctor dates: ${meta.timeDoctorRange.start} -> ${meta.timeDoctorRange.end} (${meta.windowDays} days)`,
    margin,
    56,
  );
  doc.text(`Generated: ${new Date(meta.generatedAt).toLocaleString()}`, margin, 68);
  if (filteredBy?.trim()) doc.text(`Filtered by: ${filteredBy.trim()}`, margin, 80);

  const weightsLine = `Weights: work ${SCORING_WEIGHTS.workHours * 100}% · meetings ${SCORING_WEIGHTS.meetings * 100}% · emails ${SCORING_WEIGHTS.emails * 100}% · chat ${SCORING_WEIGHTS.chat * 100}% · docs ${SCORING_WEIGHTS.docs * 100}%`;
  doc.text(weightsLine, margin, filteredBy?.trim() ? 92 : 80);

  const kpiY = filteredBy?.trim() ? 108 : 96;
  const kpiW = 125;
  const gap = 8;
  const kpis = [
    { label: "Users ranked", value: rows.length },
    { label: "Avg composite", value: avgScore.toFixed(1) },
    { label: "Grade A", value: gradeCounts.A },
    { label: "Grade B", value: gradeCounts.B },
    { label: "Grade C-F", value: gradeCounts.C + gradeCounts.D + gradeCounts.F },
  ];
  for (let i = 0; i < kpis.length; i++) {
    const x = margin + i * (kpiW + gap);
    doc.setDrawColor(220);
    doc.rect(x, kpiY, kpiW, 48);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text(kpis[i]!.label, x + 8, kpiY + 14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(20);
    doc.text(String(kpis[i]!.value), x + 8, kpiY + 36);
  }

  const topScore = topNBy(rows, (r) => r.compositeScore, 8);
  const topHours = topNBy(rows, (r) => r.workHours, 8);
  const chartY = kpiY + 68;
  const chartW = (pageW - margin * 2 - 20) / 2;

  drawBarChart({
    doc,
    title: "Top Users by Composite Score",
    x: margin,
    y: chartY,
    w: chartW,
    h: 165,
    labels: topScore.map((r) => r.displayName || r.userEmail),
    values: topScore.map((r) => r.compositeScore),
    color: [37, 99, 235],
  });
  drawBarChart({
    doc,
    title: "Top Users by Work Hours",
    x: margin + chartW + 20,
    y: chartY,
    w: chartW,
    h: 165,
    labels: topHours.map((r) => r.displayName || r.userEmail),
    values: topHours.map((r) => r.workHours),
    color: [5, 150, 105],
  });

  doc.addPage();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Employee rankings", margin, 28);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(90);
  let ruleY = 40;
  for (const rule of meta.rules.slice(0, 4)) {
    doc.text(`• ${rule}`, margin, ruleY, { maxWidth: pageW - margin * 2 });
    ruleY += 12;
  }
  doc.setTextColor(20);

  autoTable(doc, {
    startY: ruleY + 8,
    margin: { left: margin, right: margin },
    head: [[
      "Rank",
      "Employee",
      "Grade",
      "Score",
      "Work hrs",
      "Hrs/day",
      "Meetings",
      "Emails",
      "Chat",
      "Docs",
    ]],
    body: rows.map((r) => [
      String(r.rank),
      `${r.displayName}\n${r.userEmail}`,
      r.grade,
      r.compositeScore.toFixed(1),
      r.workHours.toFixed(1),
      r.hoursPerDay.toFixed(2),
      String(r.meetingsCreated),
      String(r.emailsSent),
      String(r.chatMessagesSent),
      String(r.docsCreated),
    ]),
    styles: { fontSize: 7, cellPadding: 2.5, overflow: "linebreak" },
    headStyles: { fillColor: [245, 245, 245], textColor: 20 },
    columnStyles: {
      0: { halign: "center", cellWidth: 28 },
      1: { cellWidth: 150 },
      2: { halign: "center", cellWidth: 32 },
      3: { halign: "right", cellWidth: 36 },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right" },
      8: { halign: "right" },
      9: { halign: "right" },
    },
  });

  const day = meta.range.start.slice(0, 10);
  doc.save(`employee-scoring-${day}.pdf`);
}
