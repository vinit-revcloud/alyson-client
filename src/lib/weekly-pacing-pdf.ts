import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { formatRangeLabel } from "@/lib/time-dashboard-range";
import {
  PACING_STATUS_LABEL,
  type WeeklyPacingReport,
  type WeeklyPacingRow,
  type WeeklyPacingStatus,
} from "@/lib/weekly-pacing";

type Rgb = [number, number, number];

const STATUS_ROW_STYLE: Record<
  WeeklyPacingStatus,
  { fill: Rgb; text: Rgb }
> = {
  target_met: { fill: [236, 253, 245], text: [4, 120, 87] },
  on_track: { fill: [240, 253, 244], text: [21, 128, 61] },
  behind: { fill: [254, 252, 232], text: [146, 64, 14] },
  at_risk: { fill: [255, 247, 237], text: [194, 65, 12] },
  critical: { fill: [254, 242, 242], text: [185, 28, 28] },
};

function renderWeeklyPacingPdf(
  doc: jsPDF,
  args: { report: WeeklyPacingReport; rows: WeeklyPacingRow[] },
) {
  const { report, rows } = args;
  const margin = 28;
  const pageW = doc.internal.pageSize.getWidth();
  const weekLabel = formatRangeLabel(report.week.start, report.today);

  const metTarget = rows.filter((r) => r.metTarget).length;
  const underTarget = rows.length - metTarget;
  const needsAttention = rows.filter((r) => r.status === "critical" || r.status === "at_risk").length;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Weekly Pacing Report", margin, 28);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`${report.company.name}`, margin, 44);
  doc.text(`Week: ${weekLabel} (${report.timeZoneLabel})`, margin, 56);
  doc.text(
    `Target: ${report.targetHours}h/week · Pace = Mon–Thu total + Mon–Thu avg · ${report.pacingSampleDays.length} sample day(s)`,
    margin,
    68,
  );
  doc.text(`Generated: ${new Date(report.generatedAt).toLocaleString()}`, margin, 80);

  const kpiY = 96;
  const kpiW = 118;
  const gap = 8;
  const kpis: Array<{ label: string; value: string; fill: Rgb; text: Rgb }> = [
    { label: "Target met", value: String(metTarget), fill: [236, 253, 245], text: [4, 120, 87] },
    { label: "Under target", value: String(underTarget), fill: [245, 245, 245], text: [30, 30, 30] },
    { label: "Needs attention", value: String(needsAttention), fill: [254, 242, 242], text: [185, 28, 28] },
    { label: "Workdays left", value: String(report.remainingWorkDays), fill: [245, 245, 245], text: [30, 30, 30] },
  ];

  for (let i = 0; i < kpis.length; i++) {
    const x = margin + i * (kpiW + gap);
    const k = kpis[i]!;
    doc.setFillColor(k.fill[0], k.fill[1], k.fill[2]);
    doc.roundedRect(x, kpiY, kpiW, 42, 4, 4, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text(k.label, x + 8, kpiY + 14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(k.text[0], k.text[1], k.text[2]);
    doc.text(k.value, x + 8, kpiY + 32);
  }
  doc.setTextColor(20);

  const tableStartY = kpiY + 58;

  autoTable(doc, {
    startY: tableStartY,
    margin: { left: margin, right: margin },
    head: [[
      "Employee",
      "Worked",
      "Avg/day",
      "Remaining",
      "Over",
      "Pace",
      "Days left",
      "Req/day",
      "Status",
    ]],
    body: rows.map((r) => [
      `${r.name}\n${r.email}`,
      `${r.hoursWorked.toFixed(2)}h`,
      `${r.avgDailyPace.toFixed(2)}h`,
      r.metTarget ? "—" : `${r.hoursRemaining.toFixed(2)}h`,
      r.hoursOver > 0 ? `+${r.hoursOver.toFixed(2)}h` : "—",
      `${r.projectedPace.toFixed(2)}h`,
      r.metTarget ? "—" : String(r.remainingWorkDays),
      r.metTarget ? "—" : `${r.requiredHoursPerDay.toFixed(2)}h`,
      PACING_STATUS_LABEL[r.status],
    ]),
    styles: { fontSize: 7, cellPadding: 3, overflow: "linebreak", valign: "middle" },
    headStyles: { fillColor: [245, 245, 245], textColor: 20, fontSize: 7.5, fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 128 },
      1: { halign: "right", cellWidth: 44 },
      2: { halign: "right", cellWidth: 44 },
      3: { halign: "right", cellWidth: 48 },
      4: { halign: "right", cellWidth: 40 },
      5: { halign: "right", cellWidth: 46 },
      6: { halign: "right", cellWidth: 38 },
      7: { halign: "right", cellWidth: 44 },
      8: { halign: "center", cellWidth: 54 },
    },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const row = rows[data.row.index];
      if (!row) return;

      const style = STATUS_ROW_STYLE[row.status];
      data.cell.styles.fillColor = style.fill;
      data.cell.styles.textColor = style.text;

      if (data.column.index === 5) {
        data.cell.styles.textColor =
          row.projectedPace >= report.targetHours ? [4, 120, 87] : [194, 65, 12];
        data.cell.styles.fontStyle = "bold";
      }
      if (data.column.index === 4 && row.hoursOver > 0) {
        data.cell.styles.textColor = [4, 120, 87];
        data.cell.styles.fontStyle = "bold";
      }
      if (data.column.index === 8) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  let legendY =
    ((doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? tableStartY) + 18;
  const pageH = doc.internal.pageSize.getHeight();

  if (legendY > pageH - 70) {
    doc.addPage();
    legendY = margin;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(20);
  doc.text("Color legend", margin, legendY);

  const legendItems: Array<{ label: string; status: WeeklyPacingStatus }> = [
    { label: "Target met (≥35h)", status: "target_met" },
    { label: "On track", status: "on_track" },
    { label: "Behind", status: "behind" },
    { label: "At risk", status: "at_risk" },
    { label: "Critical", status: "critical" },
  ];

  let lx = margin;
  let ly = legendY + 12;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);

  for (const item of legendItems) {
    const style = STATUS_ROW_STYLE[item.status];
    doc.setFillColor(style.fill[0], style.fill[1], style.fill[2]);
    doc.roundedRect(lx, ly - 8, 10, 10, 2, 2, "F");
    doc.setTextColor(style.text[0], style.text[1], style.text[2]);
    doc.text(item.label, lx + 14, ly);
    lx += 118;
    if (lx > pageW - margin - 100) {
      lx = margin;
      ly += 14;
    }
  }

  doc.setTextColor(20);

  if (report.warnings.length) {
    ly += 18;
    if (ly > pageH - 40) {
      doc.addPage();
      ly = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text("Notes", margin, ly);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(90);
    let noteY = ly + 10;
    for (const w of report.warnings) {
      doc.text(`• ${w}`, margin, noteY, { maxWidth: pageW - margin * 2 });
      noteY += 10;
    }
    doc.setTextColor(20);
  }
}

export function downloadWeeklyPacingPdf(args: {
  report: WeeklyPacingReport;
  rows: WeeklyPacingRow[];
}) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  renderWeeklyPacingPdf(doc, args);
  doc.save(`weekly-pacing-${args.report.today}.pdf`);
}

export function buildWeeklyPacingPdfBuffer(args: {
  report: WeeklyPacingReport;
  rows: WeeklyPacingRow[];
}): Buffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  renderWeeklyPacingPdf(doc, args);
  return Buffer.from(doc.output("arraybuffer"));
}
