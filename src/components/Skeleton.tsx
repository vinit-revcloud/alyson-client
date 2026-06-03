/** Reusable loading shimmers — keep visual continuity instead of "Loading…". */
export function Shimmer({ className = "" }: { className?: string }) {
  return (
    <div
      className={
        "animate-pulse rounded-md bg-gradient-to-r from-muted/60 via-muted to-muted/60 " +
        className
      }
    />
  );
}

export function PageSkeleton() {
  return (
    <div className="px-5 md:px-8 py-7 space-y-6 animate-in fade-in">
      <div className="space-y-2">
        <Shimmer className="h-3 w-24" />
        <Shimmer className="h-8 w-72" />
        <Shimmer className="h-4 w-96" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Shimmer key={i} className="h-24" />
        ))}
      </div>
      <Shimmer className="h-72" />
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="surface-card p-4 space-y-2">
      <Shimmer className="h-6 w-40" />
      {Array.from({ length: rows }).map((_, i) => (
        <Shimmer key={i} className="h-9" />
      ))}
    </div>
  );
}

/** Thin bar shown while Time Doctor / filter queries are in flight. */
export function FetchingBar({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      className="h-0.5 w-full overflow-hidden rounded-full bg-muted/50"
      role="progressbar"
      aria-valuetext="Loading"
    >
      <div className="td-fetch-bar h-full w-1/3 rounded-full bg-foreground/70" />
    </div>
  );
}

/** Table-shaped shimmer for Time Dashboard first paint. */
export function TimeDashboardTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="surface-card overflow-hidden animate-in fade-in duration-300">
      <div className="border-b border-border px-4 py-3 flex gap-3 items-center">
        <Shimmer className="h-4 w-10 shrink-0" />
        <Shimmer className="h-4 flex-1 max-w-[12rem]" />
        <Shimmer className="h-4 w-16 ml-auto hidden sm:block" />
        <Shimmer className="h-4 w-14 hidden sm:block" />
        <Shimmer className="h-4 w-14 hidden sm:block" />
        <Shimmer className="h-4 w-16 hidden sm:block" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-4 py-3 border-b border-border/50 flex items-center gap-3">
          <Shimmer className="h-5 w-5 rounded-full shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <Shimmer className="h-3.5 w-36 max-w-full" />
            <Shimmer className="h-3 w-48 max-w-full" />
          </div>
          <Shimmer className="h-3.5 w-12 shrink-0" />
          <Shimmer className="h-3.5 w-10 shrink-0 hidden sm:block" />
          <Shimmer className="h-3.5 w-10 shrink-0 hidden sm:block" />
          <Shimmer className="h-3.5 w-12 shrink-0 hidden sm:block" />
        </div>
      ))}
    </div>
  );
}
