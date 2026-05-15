import { supabase } from "@/integrations/supabase/client";
import type { Compensation, Department, Employee, MetricsRow } from "@/lib/queries";
import { revcloudOverviewParts } from "@/lib/revcloud-overview";

/** RevCloud roster (replaces generic Employee 1…N placeholders). */
export function demoOverviewParts() {
  return revcloudOverviewParts();
}

export async function fetchOverviewPartsFromSupabase() {
  const [deps, emps, comps, metrics] = await Promise.all([
    supabase.from("departments").select("*").order("name"),
    supabase.from("employees").select("*"),
    supabase.from("compensation").select("*"),
    supabase.from("metrics_history").select("*").order("period"),
  ]);

  if (deps.error) throw deps.error;
  if (emps.error) throw emps.error;
  if (comps.error) throw comps.error;
  if (metrics.error) throw metrics.error;

  return {
    departments: (deps.data ?? []) as Department[],
    employees: (emps.data ?? []) as Employee[],
    compensation: (comps.data ?? []) as Compensation[],
    history: (metrics.data ?? []) as MetricsRow[],
  };
}
