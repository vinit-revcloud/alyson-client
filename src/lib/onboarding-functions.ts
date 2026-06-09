import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { blankOnboardingRow, type OnboardingRow } from "@/lib/onboarding-schema";
import {
  deleteOnboardingRowFromS3,
  ensureOnboardingOnS3,
  putOnboardingToS3,
} from "@/lib/onboarding-s3.server";

const actorSchema = z.object({
  actor: z.string().email().optional().nullable(),
});

const saveRowsInput = actorSchema.extend({
  rows: z.array(z.record(z.string(), z.unknown())),
  op: z.enum(["create", "update", "bulk_replace"]).optional(),
  employeeId: z.string().optional().nullable(),
  details: z.string().optional(),
});

const deleteInput = actorSchema.extend({
  employeeId: z.string().min(1),
});

const addUserInput = actorSchema.extend({
  name: z.string().optional(),
});

function asOnboardingRows(rows: Record<string, unknown>[]): OnboardingRow[] {
  return rows.map((r) => {
    const employeeId = String(r["Employee ID"] ?? r._rowId ?? "").trim();
    const rowId = employeeId || String(r._rowId ?? "");
    return { ...r, _rowId: rowId, "Employee ID": employeeId || rowId } as OnboardingRow;
  });
}

export const getOnboardingRoster = createServerFn({ method: "GET" }).handler(async () => {
  const data = await ensureOnboardingOnS3();
  return {
    rows: data.rows,
    updatedAt: data.updatedAt,
    bucket: data.bucket,
    key: data.key,
    logKey: process.env.ALYSON_HR_ONBOARDING_LOG_S3_KEY || "onboarding/operations.log.jsonl",
  };
});

export const saveOnboardingRoster = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => saveRowsInput.parse(data))
  .handler(async ({ data }) => {
    const rows = asOnboardingRows(data.rows);
    const saved = await putOnboardingToS3(rows, {
      op: data.op ?? "bulk_replace",
      actor: data.actor ?? null,
      employeeId: data.employeeId ?? null,
      details: data.details,
    });
    return {
      rows: saved.rows,
      updatedAt: saved.updatedAt,
      bucket: saved.bucket,
      key: saved.key,
    };
  });

export const addOnboardingUser = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => addUserInput.parse(data))
  .handler(async ({ data }) => {
    const existing = await ensureOnboardingOnS3(data.actor ?? null);
    const row = blankOnboardingRow(data.name?.trim() ?? "");
    const rows = [row, ...existing.rows];
    const saved = await putOnboardingToS3(rows, {
      op: "create",
      actor: data.actor ?? null,
      employeeId: row["Employee ID"],
      details: `Added onboarding row for ${row.Name || row["Employee ID"]}`,
    });
    return {
      rows: saved.rows,
      updatedAt: saved.updatedAt,
      created: row,
    };
  });

export const deleteOnboardingUser = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => deleteInput.parse(data))
  .handler(async ({ data }) => {
    const saved = await deleteOnboardingRowFromS3(data.employeeId, data.actor ?? null);
    return {
      rows: saved.rows,
      updatedAt: saved.updatedAt,
    };
  });
