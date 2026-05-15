import { supabase } from "@/integrations/supabase/client";
import { getHrOverviewFromS3 } from "@/lib/hr-s3-overview-functions";
import { fetchOverviewPartsFromSupabase } from "@/lib/queries-hr-parts";
import { isGenericPlaceholderRoster, revcloudOverviewParts } from "@/lib/revcloud-overview";

export type Department = { id: string; name: string };
export type Employee = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  level: string;
  department_id: string;
  hire_date: string;
  performance_score: number;
  /** Optional org hierarchy support (used by `OrgChart`) */
  manager_id?: string | null;
  /** Optional raw manager name (S3 demo datasets) */
  manager_name?: string | null;
};
export type Compensation = {
  id: string;
  employee_id: string;
  base_salary: number;
  bonus_pct: number;
  equity_grant: number;
  benefits: number;
  effective_date: string;
};
export type MetricsRow = {
  id: string;
  period: string;
  total_compensation: number;
  total_bonus: number;
  headcount: number;
  avg_performance: number;
};
export type FormulaInput = {
  name: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  unit: string;
};
export type Formula = {
  id: string;
  name: string;
  description: string;
  expression: string;
  inputs: FormulaInput[];
  category: string;
};

export type EmployeeFull = Employee & {
  department_name: string;
  comp: Compensation | null;
  total_comp: number;
  effective_bonus: number;
};

function normalizeName(s: unknown) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pickManagerName(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Handle cases like "Bill & Omer/Kumail" → "Bill"
  const first = s.split("&")[0]!.split("/")[0]!.split(",")[0]!.trim();
  return first || null;
}

/** Short manager labels in the roster → canonical full names in the employee list. */
const MANAGER_NAME_ALIASES: Record<string, string> = {
  bill: "bill",
  omer: "muhammad omer affan",
  zaman: "muhammad zaman",
  kumail: "syed m kumail",
  mohita: "mohita yadav",
  arman: "arman verma",
  sabtain: "sabtain ashiq",
  "atif ali": "atif ali",
  yash: "yash patel",
  om: "om podey",
};

function resolveManagerId(managerName: string | null, employees: Employee[], byName: Map<string, string>): string | null {
  if (!managerName) return null;
  let managerNorm = normalizeName(managerName);
  if (MANAGER_NAME_ALIASES[managerNorm]) managerNorm = MANAGER_NAME_ALIASES[managerNorm]!;

  const exact = byName.get(managerNorm);
  if (exact) return exact;

  const matches = employees.filter((x) => {
    const n = normalizeName(x.full_name);
    return n === managerNorm || n.startsWith(managerNorm + " ") || n.endsWith(" " + managerNorm);
  });
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    const best = matches.find((x) => normalizeName(x.full_name) === managerNorm);
    if (best) return best.id;
  }
  return null;
}

function withManagerIds(employees: Employee[]) {
  const byName = new Map<string, string>();
  for (const e of employees) {
    const n = normalizeName(e.full_name);
    if (n) byName.set(n, e.id);
  }

  return employees.map((e) => {
    const anyE = e as Employee & {
      manager?: string;
      Manager?: string;
      reports_to?: string;
      reportsTo?: string;
    };
    const managerNameRaw =
      anyE.manager_name ?? anyE.manager ?? anyE.Manager ?? anyE.reports_to ?? anyE.reportsTo;
    const managerName = pickManagerName(managerNameRaw);
    const self = normalizeName(e.full_name);
    const managerNorm = normalizeName(managerName);

    // self-managed or missing manager => root
    if (!managerName || (managerNorm && managerNorm === self)) {
      return { ...e, manager_id: anyE.manager_id ?? null, manager_name: managerName ?? null };
    }

    const managerId = resolveManagerId(managerName, employees, byName);
    return { ...e, manager_id: anyE.manager_id ?? managerId, manager_name: managerName };
  });
}

function overviewFromRevcloud() {
  const parts = revcloudOverviewParts();
  return toOverviewFull({
    departments: parts.departments,
    employees: withManagerIds(parts.employees),
    compensation: parts.compensation,
    history: parts.history,
  });
}

function overviewFromS3Snap(snap: Awaited<ReturnType<typeof getHrOverviewFromS3>>) {
  const employees = snap.employees as Employee[];
  if (isGenericPlaceholderRoster(employees)) return overviewFromRevcloud();
  return toOverviewFull({
    departments: snap.departments,
    employees: withManagerIds(employees),
    compensation: snap.compensation,
    history: snap.history,
  });
}

function toOverviewFull(parts: {
  departments: Department[];
  employees: Employee[];
  compensation: Compensation[];
  history: MetricsRow[];
}) {
  const { departments, employees, compensation, history } = parts;
  const compByEmp = new Map(compensation.map((c) => [c.employee_id, c]));
  const deptById = new Map(departments.map((d) => [d.id, d.name]));

  const employeesFull: EmployeeFull[] = employees.map((e) => {
    const c = compByEmp.get(e.id) ?? null;
    const base = Number(c?.base_salary ?? 0);
    const bonus = Number(c?.bonus_pct ?? 0);
    const perf = Number(e.performance_score);
    const equity = Number(c?.equity_grant ?? 0);
    const benefits = Number(c?.benefits ?? 0);
    const effective_bonus = (base * bonus) / 100 * (perf / 3);
    const total_comp = base + effective_bonus + equity + benefits;
    return {
      ...e,
      department_name: deptById.get(e.department_id) ?? "—",
      comp: c,
      total_comp,
      effective_bonus,
    };
  });

  return { departments, employees: employeesFull, history };
}

export async function fetchOverview() {
  const overviewSource = String(import.meta.env.VITE_HR_OVERVIEW_SOURCE ?? "")
    .trim()
    .toLowerCase();

  // Optional: read live rows from Supabase (writes still go through server functions).
  if (overviewSource === "supabase") {
    try {
      const parts = await fetchOverviewPartsFromSupabase();
      if ((parts.employees?.length ?? 0) > 0) {
        return toOverviewFull({
          departments: parts.departments,
          employees: withManagerIds(parts.employees),
          compensation: parts.compensation,
          history: parts.history,
        });
      }
    } catch {
      // fall through to S3
    }
  }

  // Default: S3 is the canonical store (auto-seeds RevCloud roster if missing).
  try {
    const snap = await getHrOverviewFromS3();
    return overviewFromS3Snap(snap);
  } catch {
    return overviewFromRevcloud();
  }
}

export async function fetchFormulas(): Promise<Formula[]> {
  const { data, error } = await supabase.from("formulas").select("*").order("name");
  if (error) throw error;
  return (data ?? []).map((f) => ({
    ...f,
    inputs: typeof f.inputs === "string" ? JSON.parse(f.inputs) : (f.inputs as FormulaInput[]),
  })) as Formula[];
}
