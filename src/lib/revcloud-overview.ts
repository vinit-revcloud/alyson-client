import type { Compensation, Department, Employee, MetricsRow } from "@/lib/queries";
import rosterTsv from "../data/revcloud-roster.tsv?raw";

function norm(s: unknown) {
  return String(s ?? "").trim();
}

function slug(s: string) {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Parse the RevCloud roster TSV (Name, Location, Email ID, Official Email, Team, Manager). */
export function buildRevcloudOverviewFromTsv(tsv: string) {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  const header = lines.shift()!.split("\t").map((x) => x.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = lines.map((l) => l.split("\t"));

  const teams = new Map<string, string>();
  for (const r of rows) {
    const team = norm(r[idx["Team"]] ?? "General") || "General";
    teams.set(team, `dept_${slug(team)}`);
  }

  const departments: Department[] = Array.from(teams.entries())
    .map(([name, id]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!teams.has("Leadership")) {
    departments.unshift({ id: "dept_leadership", name: "Leadership" });
  }

  const employees: Employee[] = rows.map((r, i) => {
    const name = norm(r[idx["Name"]] ?? `Employee ${i + 1}`) || `Employee ${i + 1}`;
    const officialEmail = norm(r[idx["Official Email"]]);
    const email =
      officialEmail && officialEmail !== "No email found" ? officialEmail : `user${i + 1}@revcloud.com`;
    const team = norm(r[idx["Team"]] ?? "General") || "General";
    const manager = norm(r[idx["Manager"]]);

    return {
      id: `rev_${slug(officialEmail || name)}_${String(i + 1).padStart(3, "0")}`,
      full_name: name,
      email,
      role: team,
      level: "1",
      department_id: teams.get(team) ?? "dept_general",
      hire_date: "2026-01-01",
      performance_score: 3.6,
      manager_name: manager || null,
    };
  });

  // Bill is referenced as manager but not in the roster — add as org root.
  const hasBill = employees.some((e) => norm(e.full_name).toLowerCase() === "bill");
  if (!hasBill) {
    employees.unshift({
      id: "rev_exec_bill",
      full_name: "Bill",
      email: "bill@revcloud.com",
      role: "Leadership",
      level: "1",
      department_id: "dept_leadership",
      hire_date: "2026-01-01",
      performance_score: 4.5,
      manager_name: null,
    });
  }

  const compensation: Compensation[] = employees.map((e, i) => ({
    id: `comp_${e.id}`,
    employee_id: e.id,
    base_salary: 65000 + (i % 8) * 4500,
    bonus_pct: 10 + (i % 5) * 2,
    equity_grant: i % 4 === 0 ? 3000 : 0,
    benefits: 2500,
    effective_date: "2026-01-01",
  }));

  const history: MetricsRow[] = ["2026-01", "2026-02", "2026-03", "2026-04"].map((period, i) => ({
    id: `hist_${period}`,
    period,
    total_compensation: 5_000_000 + i * 250_000,
    total_bonus: 300_000 + i * 25_000,
    headcount: employees.length,
    avg_performance: 3.6,
  }));

  return { departments, employees, compensation, history };
}

export function revcloudOverviewParts() {
  return buildRevcloudOverviewFromTsv(rosterTsv);
}

export function isGenericPlaceholderRoster(employees: Pick<Employee, "full_name">[]) {
  if (employees.length === 0) return true;
  const generic = employees.filter((e) => /^Employee \d+$/i.test(e.full_name.trim())).length;
  return generic / employees.length >= 0.5;
}
