import { Medal } from "lucide-react";
import type { ReactNode } from "react";
import { medalEmojiForRank, medalTierForRank, type MedalTier } from "@/lib/rank-medals-core";

export type { MedalTier } from "@/lib/rank-medals-core";
export { medalTierForRank, medalEmojiForRank, workspaceActivityRank, MEDAL_ROW_RGB } from "@/lib/rank-medals-core";

export function medalRowClass(rank: number): string {
  const tier = medalTierForRank(rank);
  if (tier === "gold") return "medal-row medal-row-gold";
  if (tier === "silver") return "medal-row medal-row-silver";
  if (tier === "bronze") return "medal-row medal-row-bronze";
  return "";
}

export function MedalBadge({ rank }: { rank: number }) {
  const tier = medalTierForRank(rank);
  const emoji = medalEmojiForRank(rank);
  if (!tier || !emoji) return null;
  const label = tier === "gold" ? "Gold" : tier === "silver" ? "Silver" : "Bronze";
  const iconClass =
    tier === "gold"
      ? "text-amber-600 dark:text-amber-400"
      : tier === "silver"
        ? "text-slate-500 dark:text-slate-300"
        : "text-orange-700 dark:text-orange-400";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${iconClass}`}
      title={`${label} — top performer`}
    >
      <span className="text-base leading-none" aria-hidden>
        {emoji}
      </span>
      <Medal className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

/** Top 3: cute medal emoji only; everyone else: #rank */
export function rankCellContent(rank: number): ReactNode {
  const emoji = medalEmojiForRank(rank);
  if (emoji) {
    const label = rank === 1 ? "Gold" : rank === 2 ? "Silver" : "Bronze";
    return (
      <span
        className="inline-flex items-center gap-1"
        title={`${label} medal`}
        role="img"
        aria-label={`${label} medal`}
      >
        <span className="text-[1.35rem] leading-none">{emoji}</span>
      </span>
    );
  }
  return <span className="font-mono text-muted-foreground">#{rank}</span>;
}
