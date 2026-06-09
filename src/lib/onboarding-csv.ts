import {
  ONBOARDING_COLUMNS,
  type OnboardingColumn,
  type OnboardingRow,
} from "@/lib/onboarding-schema";

function norm(s: unknown): string {
  return String(s ?? "").trim();
}

function rowIdFor(raw: Record<string, string>): string {
  const id = norm(raw["Employee ID"]);
  if (id) return id;
  const email = norm(raw["Official Email"]) || norm(raw["Personal Email"]);
  if (email) return `onb_${email.toLowerCase()}`;
  const name = norm(raw.Name);
  return `onb_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "row"}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse onboarding roster CSV (header row + data rows). */
export function parseOnboardingCsv(csv: string): OnboardingRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const header = lines[0]!.split(",").map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out: OnboardingRow[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const raw: Record<string, string> = {};
    let hasContent = false;

    for (const col of ONBOARDING_COLUMNS) {
      const v = norm(cols[idx[col] ?? -1] ?? "");
      raw[col] = v;
      if (v) hasContent = true;
    }

    if (!hasContent) continue;

    const id = rowIdFor(raw);
    if (!raw["Employee ID"]) raw["Employee ID"] = id;

    const row = { _rowId: id } as OnboardingRow;
    for (const col of ONBOARDING_COLUMNS) {
      row[col as OnboardingColumn] = raw[col] ?? "";
    }
    out.push(row);
  }

  return out;
}
