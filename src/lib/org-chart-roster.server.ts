import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOrgChartRosterLookup,
  parseOrgChartRosterCsv,
  type OrgChartRosterLookup,
} from "@/lib/org-chart-roster";

let cachedLookup: OrgChartRosterLookup | null = null;

export function getOrgChartRosterLookup(): OrgChartRosterLookup {
  if (cachedLookup) return cachedLookup;
  const rosterCsv = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../data/org-chart-roster.csv"),
    "utf8",
  );
  cachedLookup = buildOrgChartRosterLookup(parseOrgChartRosterCsv(rosterCsv));
  return cachedLookup;
}
