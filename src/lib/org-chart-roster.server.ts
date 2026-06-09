import {
  buildOrgChartRosterLookup,
  parseOrgChartRosterCsv,
  type OrgChartRosterLookup,
} from "@/lib/org-chart-roster";
import { BUNDLED_ORG_CHART_ROSTER_CSV } from "@/lib/bundled-data";

let cachedLookup: OrgChartRosterLookup | null = null;

export function getOrgChartRosterLookup(): OrgChartRosterLookup {
  if (cachedLookup) return cachedLookup;
  cachedLookup = buildOrgChartRosterLookup(parseOrgChartRosterCsv(BUNDLED_ORG_CHART_ROSTER_CSV));
  return cachedLookup;
}
