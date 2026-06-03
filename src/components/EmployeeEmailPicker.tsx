import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search, User } from "lucide-react";
import { getEmployeePickerDirectory, type EmployeePickerEntry } from "@/lib/employee-picker-functions";

const MAX_SUGGESTIONS = 12;

export function resolveEmployeeFromQuery(
  query: string,
  roster: EmployeePickerEntry[],
  extra?: Array<{ email: string; label: string }>,
): EmployeePickerEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const merged: EmployeePickerEntry[] = [...roster];
  for (const o of extra ?? []) {
    const email = o.email.trim().toLowerCase();
    if (!email || merged.some((m) => m.email === email)) continue;
    merged.push({ email, name: o.label.split("(")[0]?.trim() || o.label });
  }

  if (looksLikeEmail(q)) {
    const exact = merged.find((e) => e.email === q);
    if (exact) return exact;
    return { email: q, name: q.split("@")[0] || q };
  }

  const matches = merged.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      e.email.split("@")[0]?.includes(q),
  );
  if (matches.length === 1) return matches[0]!;
  const exactName = matches.find((e) => e.name.toLowerCase() === q);
  if (exactName) return exactName;
  return null;
}

function looksLikeEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function EmployeeEmailPicker({
  query,
  onQueryChange,
  selectedEmail,
  onSelect,
  disabled,
  extraOptions,
  placeholder = "Type a name (e.g. Thiru)…",
}: {
  query: string;
  onQueryChange: (v: string) => void;
  selectedEmail: string | null;
  onSelect: (emp: EmployeePickerEntry) => void;
  disabled?: boolean;
  extraOptions?: Array<{ email: string; label: string }>;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  const directoryQ = useQuery({
    queryKey: ["employee-picker-directory"],
    queryFn: () => getEmployeePickerDirectory(),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });

  const roster = useMemo(() => {
    const base = directoryQ.data?.employees ?? [];
    const extra: EmployeePickerEntry[] = (extraOptions ?? []).map((o) => ({
      email: o.email.trim().toLowerCase(),
      name: o.label.replace(/\s*\([^)]*\)\s*$/, "").trim() || o.email,
    }));
    const map = new Map<string, EmployeePickerEntry>();
    for (const e of [...base, ...extra]) {
      if (e.email) map.set(e.email, e);
    }
    return Array.from(map.values());
  }, [directoryQ.data?.employees, extraOptions]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roster.slice(0, MAX_SUGGESTIONS);
    return roster
      .filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.email.toLowerCase().includes(q) ||
          e.email.split("@")[0]?.toLowerCase().includes(q),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [query, roster]);

  const resolved = useMemo(
    () => resolveEmployeeFromQuery(query, roster, extraOptions),
    [query, roster, extraOptions],
  );

  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter" && suggestions[0]) {
              onSelect(suggestions[0]);
              onQueryChange(suggestions[0].name);
              setOpen(false);
            }
          }}
          disabled={disabled || directoryQ.isLoading}
          placeholder={directoryQ.isLoading ? "Loading employee list…" : placeholder}
          className="w-full h-8 pl-8 pr-8 rounded-md border border-border bg-background text-[13px] disabled:opacity-60"
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-autocomplete="list"
        />
        {directoryQ.isLoading ? (
          <Loader2 className="h-3.5 w-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : null}
        {open && suggestions.length > 0 ? (
          <div className="absolute left-0 right-0 mt-1 z-30 rounded-md border border-border bg-paper shadow-lg overflow-hidden max-h-64 overflow-y-auto">
            {suggestions.map((s) => (
              <button
                key={s.email}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(s);
                  onQueryChange(s.name);
                  setOpen(false);
                }}
                className={
                  "w-full text-left px-3 py-2 hover:bg-muted/50 flex items-center gap-2 border-b border-border/50 last:border-0 " +
                  (selectedEmail === s.email ? "bg-muted/40" : "")
                }
              >
                <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{s.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{s.email}</div>
                </div>
              </button>
            ))}
          </div>
        ) : null}
        {open && query.trim() && suggestions.length === 0 && !directoryQ.isLoading ? (
          <div className="absolute left-0 right-0 mt-1 z-30 rounded-md border border-border bg-paper px-3 py-2 text-[12px] text-muted-foreground shadow-lg">
            No match — try another name or paste a full email.
          </div>
        ) : null}
      </div>
      {resolved ? (
        <div className="text-[11px] text-muted-foreground truncate">
          Selected: <span className="text-foreground font-medium">{resolved.name}</span> · {resolved.email}
        </div>
      ) : query.trim() ? (
        <div className="text-[11px] text-amber-800 dark:text-amber-200">
          Pick a name from the list (or type a unique match).
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">Search by first name, full name, or email.</div>
      )}
    </div>
  );
}
