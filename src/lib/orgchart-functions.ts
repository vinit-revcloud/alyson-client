import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import {
  readOrgChartFromS3,
  writeOrgChartToS3,
  writeOrgChartRosterToS3,
  resetOrgChartOnS3 as resetOrgChartImpl,
  type OrgChartAuditEvent,
} from "@/lib/orgchart-s3.server";
import type { EmployeeFull } from "@/lib/queries";

const PositionsMap = z.record(z.string(), z.object({ x: z.number(), y: z.number() }));
const ManagerOverridesMap = z.record(z.string(), z.string().nullable());

const TerminationRecordSchema = z.object({
  employeeId: z.string().min(1),
  fullName: z.string().min(1),
  role: z.string().nullable(),
  departmentName: z.string().nullable(),
  isDummy: z.boolean(),
  terminatedAt: z.string().min(1),
  previousManagerId: z.string().nullable(),
  reparentedToManagerId: z.string().nullable(),
  reason: z.string().nullable(),
});

const AddedEmployeeSchema = z
  .object({
    id: z.string().min(1),
    full_name: z.string().min(1),
    email: z.string(),
    role: z.string(),
    level: z.string(),
    department_id: z.string(),
    department_name: z.string(),
    hire_date: z.string(),
    performance_score: z.number(),
    manager_id: z.string().nullable().optional(),
    manager_name: z.string().nullable().optional(),
    comp: z.any().nullable().optional(),
    total_comp: z.number(),
    effective_bonus: z.number(),
  })
  .passthrough();

const EventSchema = z.object({
  type: z.enum([
    "manager_change",
    "terminate",
    "add_person",
    "positions_saved",
    "reset",
    "publish",
  ]),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

const ApplyOrgChartEventInput = z.object({
  positions: PositionsMap.optional(),
  managerOverrides: ManagerOverridesMap.optional(),
  terminated: z.array(TerminationRecordSchema).optional(),
  added: z.array(AddedEmployeeSchema).optional(),
  event: EventSchema,
});

const PutOrgChartInput = z.object({
  positions: PositionsMap,
  managerOverrides: ManagerOverridesMap,
  terminated: z.array(TerminationRecordSchema),
  added: z.array(AddedEmployeeSchema),
  event: EventSchema.optional(),
});

export const getOrgChartFromS3 = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await readOrgChartFromS3();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load org chart snapshot";
    throw new Response(msg, { status: 500 });
  }
});

export const putOrgChartToS3 = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => PutOrgChartInput.parse(data))
  .handler(async ({ data }) => {
    try {
      const r = await writeOrgChartToS3({
        positions: data.positions,
        managerOverrides: data.managerOverrides,
        terminated: data.terminated,
        added: data.added as EmployeeFull[],
        event: data.event,
      });
      return {
        ok: true as const,
        bucket: r.bucket,
        updatedAt: r.updatedAt,
        written: r.written,
        event: r.event as OrgChartAuditEvent | null,
        snapshot: r.snapshot,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to persist org chart snapshot";
      throw new Response(msg, { status: 500 });
    }
  });

export const applyOrgChartEvent = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ApplyOrgChartEventInput.parse(data))
  .handler(async ({ data }) => {
    try {
      const r = await writeOrgChartToS3({
        positions: data.positions,
        managerOverrides: data.managerOverrides,
        terminated: data.terminated,
        added: data.added as EmployeeFull[] | undefined,
        event: data.event,
      });
      return {
        ok: true as const,
        bucket: r.bucket,
        updatedAt: r.updatedAt,
        written: r.written,
        event: r.event as OrgChartAuditEvent | null,
        snapshot: r.snapshot,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to persist org chart event";
      throw new Response(msg, { status: 500 });
    }
  });

const RosterEmployeeSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  email: z.string(),
  role: z.string(),
  level: z.string(),
  department_id: z.string(),
  department_name: z.string(),
  manager_id: z.string().nullable().optional(),
  manager_name: z.string().nullable().optional(),
});

export const persistOrgChartRosterToS3 = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ employees: z.array(RosterEmployeeSchema), source: z.string().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    return await writeOrgChartRosterToS3(data.employees, data.source ?? "revcloud");
  });

export const resetOrgChartOnS3 = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const r = await resetOrgChartImpl();
    return {
      ok: true as const,
      bucket: r.bucket,
      updatedAt: r.updatedAt,
      written: r.written,
      event: r.event as OrgChartAuditEvent | null,
      snapshot: r.snapshot,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to reset org chart snapshot";
    throw new Response(msg, { status: 500 });
  }
});
