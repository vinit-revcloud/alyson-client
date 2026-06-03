import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { format, parseISO } from "date-fns";
import type { MonthlyUnderHoursReport } from "@/lib/time-doctor-functions";

function fmtShortDate(iso: string): string {
  return format(parseISO(iso), "MMM d, yyyy");
}

function renderUnderHoursPdf(doc: jsPDF, report: MonthlyUnderHoursReport) {
  const margin = 28;
  const pageH = doc.internal.pageSize.getHeight();
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Time Doctor — Under-Hours Weekly Report", margin, 28);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`${report.company.name}`, margin, 44);
  doc.text(`Month: ${report.monthLabel}`, margin, 56);
  doc.text(
    `Employees with fewer than ${report.thresholdHours} tracked hours per week · ${report.timeZoneLabel}`,
    margin,
    68,
  );
  doc.text(`Generated: ${new Date(report.generatedAt).toLocaleString()}`, margin, 80);

  let y = 96;

  for (const week of report.weeks) {
    if (y > pageH - 100) {
      doc.addPage();
      y = margin;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(
      `${week.label} (${fmtShortDate(week.range.start)} – ${fmtShortDate(week.range.end)})`,
      margin,
      y,
    );
    y += 10;

    if (!week.underThreshold.length) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(`No employees under ${report.thresholdHours} hours this week.`, margin, y + 6);
      doc.setTextColor(20);
      y += 28;
      continue;
    }

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Email", "Name", "Hours"]],
      body: week.underThreshold.map((e) => [e.email, e.name, e.hours.toFixed(2)]),
      styles: { fontSize: 8.5, cellPadding: 3 },
      headStyles: { fillColor: [245, 245, 245], textColor: 20, fontSize: 9 },
      columnStyles: {
        0: { cellWidth: 220 },
        1: { cellWidth: pageW - margin * 2 - 220 - 56 },
        2: { halign: "right", cellWidth: 56 },
      },
    });

    y = ((doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 22;
  }

  if (report.warnings.length) {
    if (y > pageH - 60) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("Notes", margin, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    let noteY = y + 12;
    for (const w of report.warnings) {
      doc.text(`• ${w}`, margin, noteY, { maxWidth: pageW - margin * 2 });
      noteY += 12;
    }
    doc.setTextColor(20);
  }
}

export function downloadTimeDoctorUnderHoursPdf(report: MonthlyUnderHoursReport) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  renderUnderHoursPdf(doc, report);
  doc.save(`time-doctor-under-${report.thresholdHours}h-${report.month}.pdf`);
}

/** Server-safe PDF bytes (e.g. email attachments). */
export function buildTimeDoctorUnderHoursPdfBuffer(report: MonthlyUnderHoursReport): Buffer {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  renderUnderHoursPdf(doc, report);
  const bytes = doc.output("arraybuffer");
  return Buffer.from(bytes);
}
