import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  appendBonusCashEvent,
  appendShareLedgerEvent,
  ensureBonusOnS3,
  getBonusOperationsLog,
  voidBonusCashEvent,
  voidShareLedgerEvent,
} from "@/lib/bonus-s3.server";
import { buildBonusAnalyticsReport } from "@/lib/bonus-analytics";
import type { EmployeeCompensationLedger } from "@/lib/bonus-schema";

const actorSchema = z.object({
  actor: z.string().email().optional().nullable(),
});

const appendBonusSchema = actorSchema.extend({
  employeeId: z.string().min(1),
  amountUsd: z.number().positive(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodLabel: z.string().optional(),
  note: z.string().optional(),
});

const appendShareSchema = actorSchema.extend({
  employeeId: z.string().min(1),
  eventType: z.enum(["grant", "vest", "adjustment", "note"]),
  shares: z.number(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strikePriceUsd: z.number().optional().nullable(),
  note: z.string().optional(),
});

function ledgersToArray(employees: Record<string, EmployeeCompensationLedger>) {
  return Object.values(employees).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.employeeName.localeCompare(b.employeeName, undefined, { sensitivity: "base" });
  });
}

export const getBonusLedger = createServerFn({ method: "GET" }).handler(async () => {
  const data = await ensureBonusOnS3();
  return {
    ledgers: ledgersToArray(data.employees),
    updatedAt: data.updatedAt,
    syncedFromOnboardingAt: data.syncedFromOnboardingAt,
    onboardingUpdatedAt: data.onboardingUpdatedAt,
    bucket: data.bucket,
    key: data.key,
    logKey: data.logKey,
  };
});

export const syncBonusWithOnboarding = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => actorSchema.parse(data))
  .handler(async ({ data }) => {
    const result = await ensureBonusOnS3(data.actor ?? null);
    return {
      ledgers: ledgersToArray(result.employees),
      updatedAt: result.updatedAt,
      syncedFromOnboardingAt: result.syncedFromOnboardingAt,
      bucket: result.bucket,
      key: result.key,
    };
  });

export const recordBonusPayment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => appendBonusSchema.parse(data))
  .handler(async ({ data }) => {
    const result = await appendBonusCashEvent({
      employeeId: data.employeeId,
      amountUsd: data.amountUsd,
      paidOn: data.paidOn,
      periodLabel: data.periodLabel,
      note: data.note,
      actor: data.actor ?? null,
    });
    return { event: result.event, ledger: result.ledger };
  });

export const recordShareEvent = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => appendShareSchema.parse(data))
  .handler(async ({ data }) => {
    const result = await appendShareLedgerEvent({
      employeeId: data.employeeId,
      eventType: data.eventType,
      shares: data.shares,
      effectiveDate: data.effectiveDate,
      strikePriceUsd: data.strikePriceUsd,
      note: data.note,
      actor: data.actor ?? null,
    });
    return { event: result.event, ledger: result.ledger };
  });

const voidEventSchema = actorSchema.extend({
  employeeId: z.string().min(1),
  eventId: z.string().min(1),
});

export const voidBonusPayment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => voidEventSchema.parse(data))
  .handler(async ({ data }) => {
    const result = await voidBonusCashEvent({
      employeeId: data.employeeId,
      eventId: data.eventId,
      actor: data.actor ?? null,
    });
    return { removed: result.removed, ledger: result.ledger };
  });

export const voidShareEvent = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => voidEventSchema.parse(data))
  .handler(async ({ data }) => {
    const result = await voidShareLedgerEvent({
      employeeId: data.employeeId,
      eventId: data.eventId,
      actor: data.actor ?? null,
    });
    return { removed: result.removed, ledger: result.ledger };
  });

export const getBonusAnalytics = createServerFn({ method: "GET" }).handler(async () => {
  const data = await ensureBonusOnS3();
  const ledgers = ledgersToArray(data.employees);
  return buildBonusAnalyticsReport(ledgers, data.updatedAt);
});

export const getBonusAuditLog = createServerFn({ method: "GET" }).handler(async () => {
  const log = await getBonusOperationsLog(300);
  return {
    entries: log.entries,
    bucket: log.bucket,
    key: log.key,
  };
});
