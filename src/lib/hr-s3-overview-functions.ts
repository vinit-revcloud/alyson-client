import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import {
  getOrSeedHrOverviewFromS3,
  putHrOverviewSnapshotToS3,
  type HrOverviewSnapshot,
} from "@/lib/hr-s3-overview.server";
import { fetchOverviewPartsFromSupabase } from "@/lib/queries-hr-parts";
import { isGenericPlaceholderRoster, revcloudOverviewParts } from "@/lib/revcloud-overview";

export const getHrOverviewFromS3 = createServerFn({ method: "GET" }).handler(async () => {
  return await getOrSeedHrOverviewFromS3();
});

const SyncInput = z.object({
  source: z.enum(["supabase", "revcloud"]).default("revcloud"),
});

export const syncHrOverviewToS3 = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SyncInput.parse(data))
  .handler(async ({ data }) => {
    const generatedAt = new Date().toISOString();
    const parts =
      data.source === "supabase"
        ? await fetchOverviewPartsFromSupabase()
        : revcloudOverviewParts();

    if (data.source === "revcloud" && isGenericPlaceholderRoster(parts.employees)) {
      throw new Error("RevCloud roster failed validation — refusing to write to S3.");
    }

    const snapshot: HrOverviewSnapshot = {
      version: 1,
      generatedAt,
      source: data.source === "supabase" ? "supabase" : "revcloud",
      departments: parts.departments,
      employees: parts.employees,
      compensation: parts.compensation,
      history: parts.history,
    };

    return await putHrOverviewSnapshotToS3(snapshot);
  });

