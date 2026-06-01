import {
  TIME_DASHBOARD_PRESETS,
  type TimeDashboardPresetId,
  resolvePresetRange,
} from "@/lib/time-dashboard-range";

type Props = {
  start: string;
  end: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onApply: () => void;
  compact?: boolean;
};

export function TimeDashboardRangePicker({ start, end, onStartChange, onEndChange, onApply, compact }: Props) {
  const applyPreset = (id: TimeDashboardPresetId) => {
    const r = resolvePresetRange(id);
    onStartChange(r.start);
    onEndChange(r.end);
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : ""}`}>
      <select
        className="h-7 px-2 rounded-md border border-border bg-background text-[11.5px] max-w-[9.5rem]"
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value as TimeDashboardPresetId | "";
          if (!v) return;
          applyPreset(v);
          e.target.value = "";
        }}
        aria-label="Quick range"
      >
        <option value="">Quick range…</option>
        {TIME_DASHBOARD_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2 rounded-md border border-border bg-paper px-2 py-1.5">
        <input
          type="date"
          value={start}
          onChange={(e) => onStartChange(e.target.value)}
          className="h-7 rounded bg-transparent text-[12.5px] text-foreground px-1.5"
          aria-label="Range start"
        />
        <span className="text-muted-foreground text-xs">→</span>
        <input
          type="date"
          value={end}
          onChange={(e) => onEndChange(e.target.value)}
          className="h-7 rounded bg-transparent text-[12.5px] text-foreground px-1.5"
          aria-label="Range end"
        />
        <button
          type="button"
          onClick={onApply}
          className="h-7 px-2.5 rounded bg-foreground text-background text-[11.5px] font-medium"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
