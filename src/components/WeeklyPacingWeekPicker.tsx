import { Loader2 } from "lucide-react";
import {
  WEEKLY_PACING_WEEK_PRESETS,
  type WeeklyPacingWeekPresetId,
  resolvePacingWeekPreset,
} from "@/lib/weekly-pacing";

type Props = {
  day: string;
  onDayChange: (v: string) => void;
  onApply: () => void;
  isBusy?: boolean;
  draftMatchesApplied?: boolean;
};

export function WeeklyPacingWeekPicker({
  day,
  onDayChange,
  onApply,
  isBusy = false,
  draftMatchesApplied = true,
}: Props) {
  const applyPreset = (id: WeeklyPacingWeekPresetId) => {
    onDayChange(resolvePacingWeekPreset(id));
  };

  const pendingDraft = !draftMatchesApplied && !isBusy;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="h-8 px-2 rounded-md border border-border bg-background text-[12px] max-w-[10rem] disabled:opacity-60"
        defaultValue=""
        disabled={isBusy}
        onChange={(e) => {
          const v = e.target.value as WeeklyPacingWeekPresetId | "";
          if (!v) return;
          applyPreset(v);
          e.target.value = "";
        }}
        aria-label="Quick week"
      >
        <option value="">Quick week…</option>
        {WEEKLY_PACING_WEEK_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <div
        className={
          "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors " +
          (pendingDraft
            ? "border-foreground/25 bg-foreground/[0.03] ring-1 ring-foreground/10"
            : "border-border bg-paper")
        }
      >
        <label className="text-[11px] text-muted-foreground whitespace-nowrap">Week of</label>
        <input
          type="date"
          value={day}
          onChange={(e) => onDayChange(e.target.value)}
          disabled={isBusy}
          className="h-7 rounded bg-transparent text-[12.5px] text-foreground px-1.5 disabled:opacity-60"
          aria-label="Select a day in the week to view"
        />
        <button
          type="button"
          onClick={onApply}
          disabled={isBusy}
          className="h-7 px-2.5 rounded bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5 disabled:opacity-70 min-w-[4.75rem] justify-center"
        >
          {isBusy ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </>
          ) : draftMatchesApplied ? (
            "Refresh"
          ) : (
            "Apply"
          )}
        </button>
      </div>
      {pendingDraft ? (
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">Unapplied changes</span>
      ) : null}
    </div>
  );
}
