import type { jsPDF } from "jspdf";
import {
  MEDAL_FILL_RGB,
  MEDAL_RIBBON_RGB,
  MEDAL_ROW_RGB,
  medalTierForRank,
  type MedalTier,
} from "@/lib/rank-medals-core";

type TableCellHook = {
  section: string;
  column: { index: number };
  row: { index: number };
  cell: { x: number; y: number; width: number; height: number; styles: { fillColor?: number | number[] } };
};

/** Draw a small medal (circle + ribbon) centered in an autotable cell. */
export function drawCuteMedalInCell(doc: jsPDF, data: TableCellHook, tier: MedalTier) {
  if (!tier || data.section !== "body") return;

  const { x, y, width, height } = data.cell;
  const cx = x + width / 2;
  const cy = y + height / 2 - 1;
  const radius = Math.min(7, height * 0.22);

  const [fr, fg, fb] = MEDAL_FILL_RGB[tier];
  const [rr, rg, rb] = MEDAL_RIBBON_RGB[tier];

  doc.setFillColor(fr, fg, fb);
  doc.setDrawColor(Math.max(0, fr - 35), Math.max(0, fg - 35), Math.max(0, fb - 35));
  doc.setLineWidth(0.4);
  doc.circle(cx, cy - 1, radius, "FD");

  doc.setFillColor(rr, rg, rb);
  const rw = radius * 1.35;
  const rh = radius * 0.85;
  doc.triangle(cx - rw, cy + radius * 0.55, cx + rw, cy + radius * 0.55, cx, cy + radius * 0.55 + rh, "F");

  doc.setFillColor(255, 255, 255);
  doc.circle(cx - radius * 0.35, cy - 1 - radius * 0.35, radius * 0.22, "F");
}

export function applyMedalRowStyle(data: TableCellHook, rank: number) {
  const tier = medalTierForRank(rank);
  if (!tier || data.section !== "body") return;
  const [r, g, b] = MEDAL_ROW_RGB[tier];
  data.cell.styles.fillColor = [r, g, b];
}

export function rankColumnHeadLabel() {
  return "Medal";
}

/** Empty rank cell — medal is drawn in didDrawCell. */
export function rankColumnBodyPlaceholder() {
  return "";
}
