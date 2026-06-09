import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Drawer } from "@/components/Drawer";
import { Field, FormFooter, GhostBtn, PrimaryBtn, TextArea, TextInput } from "@/components/forms/FormField";
import { ONBOARDING_COLUMNS, type OnboardingRow } from "@/lib/onboarding-schema";

function isDateColumn(col: string): boolean {
  const c = col.toLowerCase();
  if (c.includes("timestamp")) return false;
  return c.includes("date") || c.includes("dob");
}

function isLongColumn(col: string): boolean {
  const c = col.toLowerCase();
  return (
    c.includes("address") ||
    c.includes("bank") ||
    c.includes("benefits") ||
    c.includes("property") ||
    c.includes("access") ||
    c.includes("shared")
  );
}

function toDateInputValue(v: string): string {
  const trimmed = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type Props = {
  open: boolean;
  mode: "add" | "edit";
  initialRow: OnboardingRow | null;
  saving?: boolean;
  onClose: () => void;
  onSave: (row: OnboardingRow) => void;
};

export function OnboardingEmployeeFormDrawer({ open, mode, initialRow, saving, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<OnboardingRow | null>(null);

  useEffect(() => {
    if (open && initialRow) {
      setDraft({ ...initialRow });
    } else if (!open) {
      setDraft(null);
    }
  }, [open, initialRow]);

  if (!open || !draft) return null;

  const setField = (col: string, value: string) => {
    setDraft((prev) => (prev ? { ...prev, [col]: value } : prev));
  };

  const title = mode === "add" ? "Add onboarding employee" : draft.Name?.trim() || "Edit employee";
  const eyebrow = mode === "add" ? "New record" : "Edit record";

  return (
    <Drawer open={open} onClose={onClose} title={title} eyebrow={eyebrow} width="xl">
      <form
        className="flex flex-col flex-1 min-h-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.Name?.trim()) return;
          onSave(draft);
        }}
      >
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-foreground">Identity</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(["Employee ID", "Name", "Personal Email", "Official Email", "Contact Phone Number", "Emergency Contact Phone Number"] as const).map(
                (col) => (
                  <Field key={col} label={col}>
                    {col === "Employee ID" ? (
                      <TextInput value={String(draft[col] ?? "")} readOnly className="opacity-70" />
                    ) : (
                      <TextInput
                        value={String(draft[col] ?? "")}
                        required={col === "Name"}
                        onChange={(e) => setField(col, e.target.value)}
                      />
                    )}
                  </Field>
                ),
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-foreground">Role & team</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(["Location", "Team", "Manager", "Job Title", "Employment Status", "Employment Type", "HR"] as const).map(
                (col) => (
                  <Field key={col} label={col}>
                    <TextInput value={String(draft[col] ?? "")} onChange={(e) => setField(col, e.target.value)} />
                  </Field>
                ),
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-foreground">Personal & compliance</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(["Age", "DOB", "Gender", "National ID Number", "Last Woking Date"] as const).map((col) => (
                <Field key={col} label={col}>
                  {isDateColumn(col) ? (
                    <TextInput
                      type="date"
                      value={toDateInputValue(String(draft[col] ?? ""))}
                      onChange={(e) => setField(col, e.target.value)}
                    />
                  ) : (
                    <TextInput value={String(draft[col] ?? "")} onChange={(e) => setField(col, e.target.value)} />
                  )}
                </Field>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-foreground">Compensation & equity</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(["Base Salary", "Benefits", "Shares/Equity", "Shares Awarded Date"] as const).map((col) => (
                <Field key={col} label={col}>
                  {isDateColumn(col) ? (
                    <TextInput
                      type="date"
                      value={toDateInputValue(String(draft[col] ?? ""))}
                      onChange={(e) => setField(col, e.target.value)}
                    />
                  ) : isLongColumn(col) ? (
                    <TextArea
                      rows={2}
                      value={String(draft[col] ?? "")}
                      onChange={(e) => setField(col, e.target.value)}
                    />
                  ) : (
                    <TextInput value={String(draft[col] ?? "")} onChange={(e) => setField(col, e.target.value)} />
                  )}
                </Field>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-foreground">Addresses & access</h3>
            <div className="grid grid-cols-1 gap-3">
              {ONBOARDING_COLUMNS.filter(
                (col) =>
                  ![
                    "Employee ID",
                    "Name",
                    "Location",
                    "Personal Email",
                    "Official Email",
                    "Team",
                    "Manager",
                    "Employment Status",
                    "Last Woking Date",
                    "Contact Phone Number",
                    "Emergency Contact Phone Number",
                    "Job Title",
                    "Employment Type",
                    "HR",
                    "Age",
                    "DOB",
                    "National ID Number",
                    "Base Salary",
                    "Benefits",
                    "Gender",
                    "Shares/Equity",
                    "Shares Awarded Date",
                  ].includes(col),
              ).map((col) => (
                <Field key={col} label={col}>
                  {isLongColumn(col) ? (
                    <TextArea
                      rows={col === "Shared" ? 2 : 3}
                      value={String(draft[col] ?? "")}
                      onChange={(e) => setField(col, e.target.value)}
                    />
                  ) : (
                    <TextInput value={String(draft[col] ?? "")} onChange={(e) => setField(col, e.target.value)} />
                  )}
                </Field>
              ))}
            </div>
          </section>
        </div>

        <FormFooter>
          <GhostBtn type="button" onClick={onClose} disabled={saving}>
            Cancel
          </GhostBtn>
          <PrimaryBtn type="submit" disabled={saving || !draft.Name?.trim()}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : mode === "add" ? (
              "Add employee"
            ) : (
              "Save changes"
            )}
          </PrimaryBtn>
        </FormFooter>
      </form>
    </Drawer>
  );
}
