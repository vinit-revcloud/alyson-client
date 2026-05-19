import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type ReactFlowInstance,
  type Node,
  type Edge,
  type NodeProps,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
} from "reactflow";
import {
  Save,
  Edit3,
  Send,
  RotateCcw,
  Link2Off,
  UserMinus,
  UserPlus,
  X,
  Cloud,
  CloudOff,
  Loader2,
  History,
} from "lucide-react";
import type { EmployeeFull } from "@/lib/queries";
import { fmtCurrency, fmtRelative } from "@/lib/format";
import { toast } from "sonner";
import {
  applyOrgChartEvent,
  getOrgChartFromS3,
  putOrgChartToS3,
  resetOrgChartOnS3,
} from "@/lib/orgchart-functions";
import type {
  OrgChartTerminationRecord,
  OrgChartAuditEventType,
} from "@/lib/orgchart-s3.server";

type EmpNode = Node<{
  employee: EmployeeFull;
  isHighlighted: boolean;
  onPick: (id: string) => void;
  effectiveManagerId: string | null;
  canEditNow: boolean;
  onBreakReportingLine: () => void;
  onTerminate: () => void;
}>;

function getManagerId(emp: EmployeeFull, overrides: Record<string, string | null>): string | null {
  const raw = (emp as { manager_id?: string | null }).manager_id ?? null;
  if (Object.prototype.hasOwnProperty.call(overrides, emp.id)) {
    return overrides[emp.id] ?? null;
  }
  return raw;
}

function PersonNode({ data }: NodeProps<EmpNode["data"]>) {
  const e = data.employee;
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const showBreakLink = data.canEditNow && data.effectiveManagerId !== null;
  const showActions = data.canEditNow;

  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as globalThis.Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!showActions) setMenuOpen(false);
  }, [showActions]);

  return (
    <div ref={rootRef} className="relative">
      {showActions && (
        <div
          aria-hidden={!menuOpen}
          className={
            "absolute left-1/2 bottom-full z-30 mb-2 -translate-x-1/2 transition-all duration-200 ease-out will-change-transform " +
            (menuOpen
              ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
              : "pointer-events-none translate-y-1 scale-90 opacity-0")
          }
        >
          <div className="flex items-center gap-1">
            {showBreakLink && (
              <button
                type="button"
                aria-label="Break"
                className="group/break relative flex items-center gap-1 rounded-full border border-destructive/25 bg-paper/85 px-2 py-[3px] text-[9.5px] font-medium tracking-tight text-destructive/90 shadow-[0_6px_18px_-8px_oklch(0.55_0.18_28/0.55)] backdrop-blur-md transition-all duration-150 ease-out hover:-translate-y-px hover:border-destructive/55 hover:bg-destructive hover:text-destructive-foreground hover:shadow-[0_8px_22px_-8px_oklch(0.55_0.18_28/0.7)] active:translate-y-0 active:scale-[0.97]"
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  data.onBreakReportingLine();
                  setMenuOpen(false);
                }}
              >
                <Link2Off
                  className="h-[10px] w-[10px] transition-transform duration-200 ease-out group-hover/break:-rotate-12"
                  strokeWidth={2.4}
                />
                <span>Break</span>
              </button>
            )}
            <button
              type="button"
              aria-label={`Terminate ${e.full_name}`}
              className="group/term relative flex items-center gap-1 rounded-full border border-destructive/30 bg-paper/85 px-2 py-[3px] text-[9.5px] font-semibold tracking-tight text-destructive shadow-[0_6px_18px_-8px_oklch(0.55_0.18_28/0.55)] backdrop-blur-md transition-all duration-150 ease-out hover:-translate-y-px hover:border-destructive/60 hover:bg-destructive hover:text-destructive-foreground hover:shadow-[0_8px_22px_-8px_oklch(0.55_0.18_28/0.7)] active:translate-y-0 active:scale-[0.97]"
              onMouseDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.stopPropagation();
                data.onTerminate();
                setMenuOpen(false);
              }}
            >
              <UserMinus
                className="h-[10px] w-[10px] transition-transform duration-200 ease-out group-hover/term:scale-110"
                strokeWidth={2.4}
              />
              <span>Terminate</span>
            </button>
          </div>
          <span
            aria-hidden
            className="absolute left-1/2 top-full -mt-[3px] h-1.5 w-1.5 -translate-x-1/2 rotate-45 border-b border-r border-destructive/25 bg-paper/85 backdrop-blur-md"
          />
        </div>
      )}
      <div
        onClick={() => {
          data.onPick(e.id);
          if (showActions) setMenuOpen((o) => !o);
        }}
        className={
          "px-3 py-2 rounded-lg border bg-paper shadow-sm min-w-[180px] cursor-pointer transition-all " +
          (data.isHighlighted
            ? "border-primary ring-2 ring-primary/30"
            : "border-border hover:border-primary/50") +
          (menuOpen ? " ring-2 ring-destructive/25 border-destructive/40" : "")
        }
      >
        <Handle type="target" position={Position.Top} />
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-accent text-accent-foreground grid place-items-center text-xs font-medium shrink-0">
            {e.full_name
              .split(" ")
              .map((s) => s[0])
              .slice(0, 2)
              .join("")}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium truncate">{e.full_name}</div>
            <div className="text-[10.5px] text-muted-foreground truncate">{e.role}</div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="pill pill-neutral">{e.department_name}</span>
          <span className="font-mono">{fmtCurrency(e.total_comp, { compact: true })}</span>
        </div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    </div>
  );
}

const nodeTypes = { person: PersonNode };

const LAYOUT_KEY = "alyson-orgchart-layout-v3";
const ROSTER_FP_KEY = "alyson-orgchart-roster-fp-v3";

type CachedChart = {
  positions: Record<string, { x: number; y: number }>;
  managerOverrides: Record<string, string | null>;
  terminations: OrgChartTerminationRecord[];
  added: EmployeeFull[];
};

function loadCachedChart(): CachedChart {
  const empty: CachedChart = { positions: {}, managerOverrides: {}, terminations: [], added: [] };
  if (typeof window === "undefined") return empty;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    const o = parsed as Record<string, unknown>;
    return {
      positions:
        o.positions && typeof o.positions === "object"
          ? (o.positions as Record<string, { x: number; y: number }>)
          : {},
      managerOverrides:
        o.managerOverrides && typeof o.managerOverrides === "object"
          ? (o.managerOverrides as Record<string, string | null>)
          : {},
      terminations: Array.isArray(o.terminations)
        ? (o.terminations as OrgChartTerminationRecord[])
        : [],
      added: Array.isArray(o.added) ? (o.added as EmployeeFull[]) : [],
    };
  } catch {
    return empty;
  }
}

function saveCachedChart(chart: CachedChart) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(chart));
  } catch {
    // ignore
  }
}

function rosterFingerprint(employees: EmployeeFull[]) {
  return employees
    .map((e) => e.id)
    .sort()
    .join("|");
}

/** Drop stale overrides from old rosters or broken manager references. */
function sanitizeManagerOverrides(
  overrides: Record<string, string | null>,
  employees: EmployeeFull[],
): Record<string, string | null> {
  const ids = new Set(employees.map((e) => e.id));
  const out: Record<string, string | null> = {};
  for (const [empId, mgrId] of Object.entries(overrides)) {
    if (!ids.has(empId)) continue;
    if (mgrId !== null && !ids.has(mgrId)) continue;
    out[empId] = mgrId;
  }
  return out;
}

function managerOverridesEqual(a: Record<string, string | null>, b: Record<string, string | null>) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function addedEmployeesEqual(a: EmployeeFull[], b: EmployeeFull[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || a[i]!.manager_id !== b[i]!.manager_id) return false;
  }
  return true;
}

function nodesLayoutEqual(a: EmpNode[], b: EmpNode[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.position.x !== y.position.x || x.position.y !== y.position.y) return false;
  }
  return true;
}

function edgesLayoutEqual(a: Edge[], b: Edge[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || a[i]!.source !== b[i]!.source || a[i]!.target !== b[i]!.target) return false;
  }
  return true;
}

/** Keep dummy/add-on people reporting to the right manager after roster ID changes. */
function reconcileAddedPeopleManagers(added: EmployeeFull[], roster: EmployeeFull[]): EmployeeFull[] {
  const byId = new Map(roster.map((e) => [e.id, e]));
  const findByName = (hint: string) =>
    roster.find((e) => e.full_name.toLowerCase().includes(hint.toLowerCase())) ?? null;

  return added.map((a) => {
    if (a.manager_id && byId.has(a.manager_id)) return a;
    const thiru = findByName("thirumalai");
    if (thiru && (a.manager_id?.includes("thirumalai") || a.email?.includes("dummy"))) {
      return { ...a, manager_id: thiru.id };
    }
    return a;
  });
}

function mergeTerminationRecords(
  a: OrgChartTerminationRecord[],
  b: OrgChartTerminationRecord[],
): OrgChartTerminationRecord[] {
  const map = new Map<string, OrgChartTerminationRecord>();
  for (const t of [...a, ...b]) map.set(t.employeeId, t);
  return [...map.values()].sort((x, y) => y.terminatedAt.localeCompare(x.terminatedAt));
}

function mergeAddedPeople(a: EmployeeFull[], b: EmployeeFull[]): EmployeeFull[] {
  const map = new Map<string, EmployeeFull>();
  for (const p of [...a, ...b]) map.set(p.id, p);
  return [...map.values()];
}

type EditCtx = {
  canEditNow: boolean;
  onBreakReportingLine: (empId: string) => void;
  onTerminate: (empId: string) => void;
};

/** Lay out tree top-down by manager chain (with optional overrides), compact (centers parent over children). */
function layout(
  employees: EmployeeFull[],
  highlightId: string | null,
  onPick: (id: string) => void,
  managerOverrides: Record<string, string | null>,
  editCtx: EditCtx,
): { nodes: EmpNode[]; edges: Edge[] } {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const children = new Map<string | null, EmployeeFull[]>();
  for (const e of employees) {
    let k = getManagerId(e, managerOverrides);
    if (k && !byId.has(k)) k = null;
    if (!children.has(k)) children.set(k, []);
    children.get(k)!.push(e);
  }
  const reportingChain = new Set<string>();
  if (highlightId) {
    let cur: string | null = highlightId;
    while (cur) {
      if (reportingChain.has(cur)) break;
      reportingChain.add(cur);
      const emp = byId.get(cur);
      const next = emp ? getManagerId(emp, managerOverrides) : null;
      cur = next && byId.has(next) ? next : null;
    }
  }
  const nodes: EmpNode[] = [];
  const edges: Edge[] = [];
  const VX = 220; // horizontal unit
  const VY = 140; // vertical unit

  const sorted = (list: EmployeeFull[]) =>
    list
      .slice()
      .sort(
        (a, b) =>
          (a.department_name ?? "").localeCompare(b.department_name ?? "") ||
          (a.full_name ?? "").localeCompare(b.full_name ?? ""),
      );

  const widthUnits = new Map<string, number>();
  const roots = sorted(children.get(null) ?? []);
  const widthVisiting = new Set<string>();
  const placeVisiting = new Set<string>();

  const computeWidth = (id: string): number => {
    if (widthUnits.has(id)) return widthUnits.get(id)!;
    if (widthVisiting.has(id)) return 1;
    widthVisiting.add(id);
    const kids = sorted(children.get(id) ?? []);
    const w = kids.length ? kids.reduce((s, k) => s + computeWidth(k.id), 0) : 1;
    widthVisiting.delete(id);
    widthUnits.set(id, w);
    return w;
  };
  roots.forEach((r) => computeWidth(r.id));

  const placeNode = (id: string, depth: number, xUnitStart: number): { width: number; center: number } => {
    if (placeVisiting.has(id)) return { width: 1, center: xUnitStart + 0.5 };
    placeVisiting.add(id);
    const emp = byId.get(id);
    if (!emp) {
      placeVisiting.delete(id);
      return { width: 1, center: xUnitStart + 0.5 };
    }
    const kids = sorted(children.get(id) ?? []);
    const w = widthUnits.get(id) ?? 1;

    let center: number;
    if (!kids.length) {
      center = xUnitStart + 0.5;
    } else {
      let cursor = xUnitStart;
      const childCenters: number[] = [];
      for (const k of kids) {
        const cw = widthUnits.get(k.id) ?? 1;
        const placed = placeNode(k.id, depth + 1, cursor);
        childCenters.push(placed.center);
        cursor += cw;

        edges.push({
          id: `${id}->${k.id}`,
          source: id,
          target: k.id,
          type: "smoothstep",
          style: {
            stroke: reportingChain.has(k.id) ? "var(--primary)" : "var(--muted-foreground)",
            strokeWidth: reportingChain.has(k.id) ? 2 : 1,
          },
        });
      }
      center = (childCenters[0]! + childCenters[childCenters.length - 1]!) / 2;
    }

    nodes.push({
      id: emp.id,
      type: "person",
      position: { x: center * VX - 90, y: depth * VY },
      data: {
        employee: emp,
        isHighlighted: reportingChain.has(emp.id),
        onPick,
        effectiveManagerId: getManagerId(emp, managerOverrides),
        canEditNow: editCtx.canEditNow,
        onBreakReportingLine: () => editCtx.onBreakReportingLine(emp.id),
        onTerminate: () => editCtx.onTerminate(emp.id),
      },
    });
    placeVisiting.delete(id);
    return { width: w, center };
  };

  let cursor = 0;
  for (const r of roots) {
    const w = widthUnits.get(r.id) ?? 1;
    placeNode(r.id, 0, cursor);
    cursor += w + 1; // gap between root trees
  }

  return { nodes, edges };
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 32) || "user";
}

function makeDummyId() {
  const rnd =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `dummy-${rnd}`;
}

function AddPersonModal({
  open,
  employees,
  onCancel,
  onAdd,
}: {
  open: boolean;
  employees: EmployeeFull[];
  onCancel: () => void;
  onAdd: (e: EmployeeFull) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("Software Engineer");
  const [department, setDepartment] = useState("Engineering");
  const [level, setLevel] = useState("L3");
  const [managerId, setManagerId] = useState<string>("");

  useEffect(() => {
    if (open) return;
    setFullName("");
    setRole("Software Engineer");
    setDepartment("Engineering");
    setLevel("L3");
    setManagerId("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const trimmedName = fullName.trim();
  const canSubmit = trimmedName.length >= 2;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const dept = department.trim() || "General";
    const emp: EmployeeFull = {
      id: makeDummyId(),
      full_name: trimmedName,
      email: `${slugify(trimmedName)}@dummy.local`,
      role: role.trim() || "Employee",
      level: level.trim() || "L1",
      department_id: slugify(dept),
      hire_date: new Date().toISOString().slice(0, 10),
      performance_score: 0,
      manager_id: managerId || null,
      manager_name: null,
      department_name: dept,
      comp: null,
      total_comp: 0,
      effective_bonus: 0,
    };
    onAdd(emp);
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/30 p-4 backdrop-blur-sm"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-paper shadow-[0_20px_60px_-20px_oklch(0_0_0/0.45)]"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
          <div>
            <div className="text-sm font-medium">Add a dummy person</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Saved locally — perfect for experimenting with the org chart.
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            className="h-6 w-6 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <label className="block">
            <span className="text-[11px] font-medium text-muted-foreground">Full name</span>
            <input
              autoFocus
              value={fullName}
              onChange={(ev) => setFullName(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && canSubmit) handleSubmit();
              }}
              placeholder="e.g. Ada Lovelace"
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Role</span>
              <input
                value={role}
                onChange={(ev) => setRole(ev.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Level</span>
              <input
                value={level}
                onChange={(ev) => setLevel(ev.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium text-muted-foreground">Department</span>
            <input
              value={department}
              onChange={(ev) => setDepartment(ev.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-muted-foreground">Manager</span>
            <select
              value={managerId}
              onChange={(ev) => setManagerId(ev.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
            >
              <option value="">— No manager (root) —</option>
              {employees
                .slice()
                .sort((a, b) => a.full_name.localeCompare(b.full_name))
                .map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.full_name} · {emp.role}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-md border border-border text-xs hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="h-8 px-3 rounded-md bg-foreground text-background text-xs font-medium flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <UserPlus className="h-3.5 w-3.5" /> Add person
          </button>
        </div>
      </div>
    </div>
  );
}

function TerminateConfirmModal({
  target,
  onCancel,
  onConfirm,
}: {
  target: EmployeeFull | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    setTyped("");
  }, [target?.id]);

  useEffect(() => {
    if (!target) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, onCancel]);

  if (!target) return null;

  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const matches = normalize(typed) === normalize(target.full_name);
  const isDummy = target.id.startsWith("dummy-");

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/30 p-4 backdrop-blur-sm"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-paper shadow-[0_20px_60px_-20px_oklch(0_0_0/0.45)]"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 h-7 w-7 grid place-items-center rounded-full bg-destructive/10 text-destructive">
              <UserMinus className="h-3.5 w-3.5" />
            </div>
            <div>
              <div className="text-sm font-medium">
                {isDummy ? "Remove dummy person" : "Terminate employee"}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Their direct reports will be re-assigned to their current manager.
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            className="h-6 w-6 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="text-[12.5px] font-medium">{target.full_name}</div>
            <div className="text-[11px] text-muted-foreground truncate">
              {target.role} · {target.department_name}
            </div>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium text-muted-foreground">
              Type <span className="font-mono text-foreground">{target.full_name}</span> to confirm
            </span>
            <input
              autoFocus
              value={typed}
              onChange={(ev) => setTyped(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && matches) onConfirm();
              }}
              placeholder={target.full_name}
              className={
                "mt-1 h-9 w-full rounded-md border bg-background px-2.5 text-[13px] outline-none transition-colors " +
                (typed.length === 0
                  ? "border-border focus:border-primary"
                  : matches
                    ? "border-emerald-500/60 focus:border-emerald-500"
                    : "border-destructive/50 focus:border-destructive")
              }
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-md border border-border text-xs hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!matches}
            onClick={onConfirm}
            className="h-8 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-medium flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <UserMinus className="h-3.5 w-3.5" />
            {isDummy ? "Remove" : "Terminate"}
          </button>
        </div>
      </div>
    </div>
  );
}

type SyncStatus = "idle" | "loading" | "saving" | "synced" | "error" | "offline";

function formatRelativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleString();
}

function SyncIndicator({ status, lastSyncedAt }: { status: SyncStatus; lastSyncedAt: string | null }) {
  const meta: { label: string; tone: string; Icon: typeof Cloud; spin?: boolean } = (() => {
    switch (status) {
      case "loading":
        return { label: "Loading…", tone: "text-muted-foreground", Icon: Loader2, spin: true };
      case "saving":
        return { label: "Syncing…", tone: "text-muted-foreground", Icon: Loader2, spin: true };
      case "error":
        return { label: "Sync failed", tone: "text-destructive", Icon: CloudOff };
      case "offline":
        return { label: "Offline", tone: "text-destructive", Icon: CloudOff };
      case "synced": {
        const rel = formatRelativeTime(lastSyncedAt);
        return { label: rel ? `Synced · ${rel}` : "Synced", tone: "text-emerald-600 dark:text-emerald-400", Icon: Cloud };
      }
      default:
        return { label: "—", tone: "text-muted-foreground", Icon: Cloud };
    }
  })();
  const { label, tone, Icon, spin } = meta;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2 py-[2px] text-[10.5px] font-medium ${tone}`}
      title={lastSyncedAt ? `Last cloud sync: ${new Date(lastSyncedAt).toLocaleString()}` : undefined}
    >
      <Icon className={`h-3 w-3 ${spin ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}

export function OrgChart({ employees, canEdit = false }: { employees: EmployeeFull[]; canEdit?: boolean }) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingChanges, setPendingChanges] = useState(0);
  const [layoutStore, setLayoutStore] = useState<Record<string, { x: number; y: number }>>({});
  const [managerOverrides, setManagerOverrides] = useState<Record<string, string | null>>({});
  const [terminations, setTerminations] = useState<OrgChartTerminationRecord[]>([]);
  const [addedEmployees, setAddedEmployees] = useState<EmployeeFull[]>([]);
  const [nodes, setNodes] = useState<EmpNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);
  const fitViewDoneRef = useRef(false);

  const [terminateTargetId, setTerminateTargetId] = useState<string | null>(null);
  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>("loading");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const employeesRef = useRef(employees);
  employeesRef.current = employees;

  const canEditNow = canEdit && editMode;

  const terminatedIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of terminations) s.add(t.employeeId);
    return s;
  }, [terminations]);

  const effectiveEmployees = useMemo(() => {
    const seen = new Set<string>();
    const out: EmployeeFull[] = [];
    for (const e of [...employees, ...addedEmployees]) {
      if (seen.has(e.id)) continue;
      if (terminatedIds.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }, [employees, addedEmployees, terminatedIds]);

  const activeAdditions = useMemo(
    () => addedEmployees.filter((a) => !terminatedIds.has(a.id)),
    [addedEmployees, terminatedIds],
  );

  const managerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of [...employees, ...addedEmployees]) m.set(e.id, e.full_name);
    return m;
  }, [employees, addedEmployees]);

  const handlePick = useCallback((id: string) => setHighlightId(id), []);

  useEffect(() => {
    const cached = loadCachedChart();
    setLayoutStore(cached.positions);
    setManagerOverrides(cached.managerOverrides);
    setTerminations(cached.terminations);
    setAddedEmployees(cached.added);

    let cancelled = false;
    setSyncStatus("loading");
    getOrgChartFromS3()
      .then((snap) => {
        if (cancelled) return;
        const mergedOverrides = sanitizeManagerOverrides(
          { ...cached.managerOverrides, ...(snap.managerOverrides ?? {}) },
          employeesRef.current,
        );
        const mergedTerms = mergeTerminationRecords(snap.terminated ?? [], cached.terminations);
        const mergedAdded = reconcileAddedPeopleManagers(
          mergeAddedPeople(snap.added ?? [], cached.added),
          employeesRef.current,
        );
        setLayoutStore(snap.positions ?? cached.positions);
        setManagerOverrides(mergedOverrides);
        setTerminations(mergedTerms);
        setAddedEmployees(mergedAdded);
        setLastSyncedAt(snap.updatedAt);
        setSyncStatus("synced");
        saveCachedChart({
          positions: snap.positions ?? {},
          managerOverrides: mergedOverrides,
          terminations: mergedTerms,
          added: mergedAdded,
        });
        hydratedRef.current = true;
      })
      .catch(async (err) => {
        if (cancelled) return;
        hydratedRef.current = true;
        setSyncStatus("offline");
        const msg = err instanceof Response ? await err.text() : err instanceof Error ? err.message : "Unknown error";
        toast.error("Could not load org chart from cloud", { description: msg });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Track roster version — never wipe S3-backed additions/terminations from the UI.
  useEffect(() => {
    if (typeof window === "undefined" || !employees.length) return;
    localStorage.setItem(ROSTER_FP_KEY, rosterFingerprint(employees));
  }, [employees]);

  useEffect(() => {
    setManagerOverrides((prev) => {
      const next = sanitizeManagerOverrides(prev, effectiveEmployees);
      return managerOverridesEqual(prev, next) ? prev : next;
    });
    setAddedEmployees((prev) => {
      const next = reconcileAddedPeopleManagers(prev, employees);
      return addedEmployeesEqual(prev, next) ? prev : next;
    });
  }, [effectiveEmployees, employees]);

  const persistRef = useRef({
    managerOverrides,
    terminations,
    addedEmployees,
    layoutStore,
  });
  useEffect(() => {
    persistRef.current = { managerOverrides, terminations, addedEmployees, layoutStore };
  }, [managerOverrides, terminations, addedEmployees, layoutStore]);

  const persistEvent = useCallback(
    async (
      type: OrgChartAuditEventType,
      payload: Record<string, unknown>,
      patch?: Partial<CachedChart>,
    ) => {
      if (!hydratedRef.current) return;
      const snapshot: CachedChart = {
        positions: patch?.positions ?? persistRef.current.layoutStore,
        managerOverrides: patch?.managerOverrides ?? persistRef.current.managerOverrides,
        terminations: patch?.terminations ?? persistRef.current.terminations,
        added: patch?.added ?? persistRef.current.addedEmployees,
      };
      saveCachedChart(snapshot);
      setSyncStatus("saving");
      try {
        const r = await applyOrgChartEvent({
          data: {
            positions: snapshot.positions,
            managerOverrides: snapshot.managerOverrides,
            terminated: snapshot.terminations,
            added: snapshot.added,
            event: { type, payload },
          },
        });
        setLastSyncedAt(r.updatedAt);
        setSyncStatus("synced");
      } catch (err) {
        setSyncStatus("error");
        const msg = err instanceof Response ? await err.text() : err instanceof Error ? err.message : "Unknown error";
        toast.error("Cloud save failed", {
          description: `${msg}. Change kept locally — retry from Save layout.`,
        });
      }
    },
    [],
  );

  const breakReportingLine = useCallback(
    (empId: string) => {
      const emp = effectiveEmployees.find((e) => e.id === empId) ?? null;
      const previousManagerId = emp ? getManagerId(emp, managerOverrides) : null;
      const nextOverrides = { ...managerOverrides, [empId]: null };
      setManagerOverrides(nextOverrides);
      setPendingChanges((c) => c + 1);
      toast.success("Reporting line cleared", {
        description: "Drag from a manager’s handle onto this person’s top handle to assign a new manager.",
      });
      void persistEvent(
        "manager_change",
        {
          kind: "break",
          employeeId: empId,
          employeeName: emp?.full_name ?? null,
          previousManagerId,
          newManagerId: null,
        },
        { managerOverrides: nextOverrides },
      );
    },
    [effectiveEmployees, managerOverrides, persistEvent],
  );

  const requestTerminate = useCallback((empId: string) => {
    setTerminateTargetId(empId);
  }, []);

  const terminateTarget = useMemo(
    () => effectiveEmployees.find((e) => e.id === terminateTargetId) ?? null,
    [effectiveEmployees, terminateTargetId],
  );

  const confirmTerminate = useCallback(() => {
    if (!terminateTarget) return;
    const targetId = terminateTarget.id;
    const previousManagerId = getManagerId(terminateTarget, managerOverrides);

    const nextOverrides: Record<string, string | null> = { ...managerOverrides };
    for (const e of effectiveEmployees) {
      if (e.id === targetId) continue;
      const mgr = getManagerId(e, managerOverrides);
      if (mgr === targetId) nextOverrides[e.id] = previousManagerId;
    }

    const record: OrgChartTerminationRecord = {
      employeeId: targetId,
      fullName: terminateTarget.full_name,
      role: terminateTarget.role ?? null,
      departmentName: terminateTarget.department_name ?? null,
      isDummy: targetId.startsWith("dummy-"),
      terminatedAt: new Date().toISOString(),
      previousManagerId,
      reparentedToManagerId: previousManagerId,
      reason: null,
    };

    const nextTerminations = [...terminations.filter((t) => t.employeeId !== targetId), record];
    const nextAdded = addedEmployees.filter((e) => e.id !== targetId);

    setManagerOverrides(nextOverrides);
    setTerminations(nextTerminations);
    setAddedEmployees(nextAdded);
    setPendingChanges((c) => c + 1);
    setTerminateTargetId(null);
    if (highlightId === targetId) setHighlightId(null);

    toast.success(
      record.isDummy ? "Dummy person removed" : "Employee terminated",
      { description: `${terminateTarget.full_name} was removed from the chart.` },
    );
    void persistEvent(
      "terminate",
      { ...record, reparentedFromIds: Object.keys(nextOverrides).filter((id) => nextOverrides[id] === previousManagerId && managerOverrides[id] !== previousManagerId) },
      { managerOverrides: nextOverrides, terminations: nextTerminations, added: nextAdded },
    );
  }, [terminateTarget, managerOverrides, effectiveEmployees, highlightId, terminations, addedEmployees, persistEvent]);

  const addPerson = useCallback(
    (emp: EmployeeFull) => {
      const nextAdded = [...addedEmployees, emp];
      setAddedEmployees(nextAdded);
      setPendingChanges((c) => c + 1);
      setAddPersonOpen(false);
      toast.success("Dummy person added", {
        description: `${emp.full_name} was added${emp.manager_id ? "" : " as a root"}.`,
      });
      void persistEvent(
        "add_person",
        {
          employeeId: emp.id,
          fullName: emp.full_name,
          role: emp.role,
          departmentName: emp.department_name,
          managerId: emp.manager_id ?? null,
          isDummy: emp.id.startsWith("dummy-"),
        },
        { added: nextAdded },
      );
    },
    [addedEmployees, persistEvent],
  );

  useEffect(() => {
    const base = layout(effectiveEmployees, highlightId, handlePick, managerOverrides, {
      canEditNow,
      onBreakReportingLine: breakReportingLine,
      onTerminate: requestTerminate,
    });
    const n = base.nodes.map((node) => {
      const p = layoutStore?.[node.id];
      return p ? { ...node, position: { x: p.x, y: p.y } } : node;
    });
    setNodes((prev) => (nodesLayoutEqual(prev, n) ? prev : n));
    setEdges((prev) => (edgesLayoutEqual(prev, base.edges) ? prev : base.edges));
  }, [
    effectiveEmployees,
    highlightId,
    handlePick,
    layoutStore,
    managerOverrides,
    canEditNow,
    breakReportingLine,
    requestTerminate,
  ]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      const moved = changes.some((c) => c.type === "position" || c.type === "dimensions");
      if (canEditNow && moved) setPendingChanges((c) => c + changes.length);
    },
    [canEditNow],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  const onConnect = useCallback(
    (params: { source: string | null; target: string | null }) => {
      if (!canEditNow) return;
      if (!params.source || !params.target) return;
      if (params.source === params.target) return;
      const targetId = params.target;
      const newManagerId = params.source;
      const targetEmp = effectiveEmployees.find((e) => e.id === targetId) ?? null;
      const sourceEmp = effectiveEmployees.find((e) => e.id === newManagerId) ?? null;
      const previousManagerId = targetEmp ? getManagerId(targetEmp, managerOverrides) : null;
      const nextOverrides = { ...managerOverrides, [targetId]: newManagerId };
      setManagerOverrides(nextOverrides);
      setPendingChanges((c) => c + 1);
      toast.success("Reporting line updated", {
        description: targetEmp && sourceEmp ? `${targetEmp.full_name} → ${sourceEmp.full_name}` : "Saved to cloud.",
      });
      void persistEvent(
        "manager_change",
        {
          kind: "connect",
          employeeId: targetId,
          employeeName: targetEmp?.full_name ?? null,
          previousManagerId,
          newManagerId,
          newManagerName: sourceEmp?.full_name ?? null,
        },
        { managerOverrides: nextOverrides },
      );
    },
    [canEditNow, effectiveEmployees, managerOverrides, persistEvent],
  );

  // search highlight
  useEffect(() => {
    if (!search.trim()) return;
    const match = effectiveEmployees.find((e) => e.full_name.toLowerCase().includes(search.toLowerCase()));
    if (match) setHighlightId(match.id);
  }, [search, effectiveEmployees]);

  const suggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return effectiveEmployees
      .filter((e) => e.full_name.toLowerCase().includes(q) || e.role.toLowerCase().includes(q))
      .slice(0, 8);
  }, [effectiveEmployees, search]);

  useEffect(() => {
    fitViewDoneRef.current = false;
  }, [effectiveEmployees.length]);

  useEffect(() => {
    if (!rf || nodes.length === 0 || fitViewDoneRef.current) return;
    fitViewDoneRef.current = true;
    requestAnimationFrame(() => {
      rf.fitView({ padding: 0.15 });
    });
  }, [rf, nodes.length]);

  useEffect(() => {
    if (!rf || !highlightId) return;
    const node = nodes.find((n) => n.id === highlightId);
    if (!node) return;
    // Node width ~180, height ~80 (rough). Center using a safe offset.
    const centerX = node.position.x + 90;
    const centerY = node.position.y + 40;
    // Smoothly pan/zoom to the node.
    rf.setCenter(centerX, centerY, { zoom: 1.05, duration: 450 });
  }, [rf, highlightId, nodes]);

  // Publish a rich context object so Alyson Mini can answer org-chart questions
  // ("who reports to X", "team under X", "who is X's manager", etc.).
  useEffect(() => {
    if (typeof window === "undefined") return;

    const empById = new Map(effectiveEmployees.map((e) => [e.id, e]));
    const directReports = new Map<string | null, string[]>();
    for (const e of effectiveEmployees) {
      const m = getManagerId(e, managerOverrides);
      const key = m && empById.has(m) ? m : null;
      const list = directReports.get(key) ?? [];
      list.push(e.id);
      directReports.set(key, list);
    }

    const employeesPayload = effectiveEmployees.map((e) => {
      const mgrId = getManagerId(e, managerOverrides);
      const mgr = mgrId ? empById.get(mgrId) ?? null : null;
      const reports = directReports.get(e.id) ?? [];
      return {
        id: e.id,
        name: e.full_name,
        role: e.role,
        level: e.level,
        department: e.department_name,
        email: e.email,
        manager_id: mgrId,
        manager_name: mgr ? mgr.full_name : null,
        direct_report_ids: reports,
        direct_report_count: reports.length,
        is_dummy: e.id.startsWith("dummy-"),
      };
    });

    (window as { __ALYSON_MINI_CONTEXT__?: unknown }).__ALYSON_MINI_CONTEXT__ = {
      module: "org-chart",
      view: "team-orgchart",
      generated_at: new Date().toISOString(),
      total_employees: effectiveEmployees.length,
      root_employee_ids: directReports.get(null) ?? [],
      employees: employeesPayload,
      terminations: terminations.map((t) => ({
        id: t.employeeId,
        name: t.fullName,
        role: t.role,
        department: t.departmentName,
        is_dummy: t.isDummy,
        terminated_at: t.terminatedAt,
        previous_manager_id: t.previousManagerId,
        reparented_to_manager_id: t.reparentedToManagerId,
      })),
      additions: addedEmployees.map((e) => ({
        id: e.id,
        name: e.full_name,
        role: e.role,
        department: e.department_name,
        manager_id: e.manager_id ?? null,
        is_dummy: e.id.startsWith("dummy-"),
      })),
      highlighted_employee_id: highlightId,
    };

    return () => {
      const cur = (window as { __ALYSON_MINI_CONTEXT__?: { module?: string } }).__ALYSON_MINI_CONTEXT__;
      if (cur && cur.module === "org-chart") {
        (window as { __ALYSON_MINI_CONTEXT__?: unknown }).__ALYSON_MINI_CONTEXT__ = undefined;
      }
    };
  }, [effectiveEmployees, managerOverrides, terminations, addedEmployees, highlightId]);

  return (
    <div className="surface-card overflow-hidden flex flex-col" style={{ height: 620 }}>
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border bg-paper/80">
        <div className="relative">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSuggestOpen(true);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => {
              // allow click selection before closing
              window.setTimeout(() => setSuggestOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSuggestOpen(false);
              if (e.key === "Enter" && suggestions[0]) {
                setHighlightId(suggestions[0].id);
                setSearch(suggestions[0].full_name);
                setSuggestOpen(false);
              }
            }}
            placeholder="Search employee…"
            className="h-8 w-56 px-3 rounded-md border border-border bg-background text-[13px]"
            role="combobox"
            aria-expanded={suggestOpen && suggestions.length > 0}
            aria-autocomplete="list"
          />
          {suggestOpen && suggestions.length > 0 && (
            <div className="absolute left-0 mt-1 w-80 max-w-[70vw] rounded-md border border-border bg-paper shadow-lg overflow-hidden z-20">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setHighlightId(s.id);
                    setSearch(s.full_name);
                    setSuggestOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-muted/40 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{s.full_name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{s.role} · {s.department_name}</div>
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono shrink-0">
                    L{s.level}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        {highlightId && (
          <button
            onClick={() => setHighlightId(null)}
            className="text-[11px] text-muted-foreground hover:text-foreground underline"
          >
            Clear chain
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className={
              "h-8 px-2.5 rounded-md border text-xs flex items-center gap-1.5 " +
              (historyOpen
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-muted")
            }
            title="People you added and terminated (stored in S3)"
          >
            <History className="h-3.5 w-3.5" />
            Chart records
            {(activeAdditions.length > 0 || terminations.length > 0) && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium">
                {activeAdditions.length + terminations.length}
              </span>
            )}
          </button>
          <SyncIndicator status={syncStatus} lastSyncedAt={lastSyncedAt} />
          {pendingChanges > 0 && (
            <span className="pill pill-warning">{pendingChanges} pending</span>
          )}
          {canEdit && editMode ? (
            <>
              <button
                onClick={() => setAddPersonOpen(true)}
                className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
              >
                <UserPlus className="h-3.5 w-3.5" /> Add person
              </button>
              <button
                onClick={async () => {
                  const next: Record<string, { x: number; y: number }> = {};
                  nodes.forEach((n) => (next[n.id] = { x: n.position.x, y: n.position.y }));
                  setLayoutStore(next);
                  setSyncStatus("saving");
                  try {
                    const r = await putOrgChartToS3({
                      data: {
                        positions: next,
                        managerOverrides,
                        terminated: terminations,
                        added: addedEmployees,
                        event: { type: "positions_saved", payload: { nodeCount: nodes.length } },
                      },
                    });
                    saveCachedChart({
                      positions: next,
                      managerOverrides,
                      terminations,
                      added: addedEmployees,
                    });
                    setLastSyncedAt(r.updatedAt);
                    setSyncStatus("synced");
                    toast.success("Layout saved", {
                      description: `${pendingChanges} change(s) synced to cloud.`,
                    });
                    setPendingChanges(0);
                  } catch (err) {
                    setSyncStatus("error");
                    const msg = err instanceof Response ? await err.text() : err instanceof Error ? err.message : "Unknown error";
                    toast.error("Save failed", { description: msg });
                  }
                }}
                className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
              >
                <Save className="h-3.5 w-3.5" /> Save layout
              </button>
              <button
                onClick={() => {
                  void persistEvent("publish", { nodeCount: nodes.length });
                  toast.success("Org chart published", {
                    description: "Audit log entry created in cloud.",
                  });
                  setPendingChanges(0);
                  setEditMode(false);
                }}
                className="h-8 px-3 rounded-md bg-foreground text-background text-xs flex items-center gap-1.5"
              >
                <Send className="h-3.5 w-3.5" /> Publish
              </button>
              <button
                onClick={async () => {
                  if (typeof window !== "undefined") {
                    const ok = window.confirm(
                      "Clear draft layout and manager overrides? Terminations, additions, and full audit history stay in S3. A full snapshot is archived before anything changes.",
                    );
                    if (!ok) return;
                  }
                  setLayoutStore({});
                  setManagerOverrides({});
                  setPendingChanges(0);
                  setEditMode(false);
                  saveCachedChart({
                    positions: {},
                    managerOverrides: {},
                    terminations,
                    added: addedEmployees,
                  });
                  setSyncStatus("saving");
                  try {
                    const r = await resetOrgChartOnS3();
                    setLastSyncedAt(r.updatedAt);
                    setSyncStatus("synced");
                    toast.success("Draft layout cleared", {
                      description: "Overrides reset in S3. Terminations and audit log preserved.",
                    });
                  } catch (err) {
                    setSyncStatus("error");
                    const msg = err instanceof Response ? await err.text() : err instanceof Error ? err.message : "Unknown error";
                    toast.error("Cloud reset failed", { description: msg });
                  }
                }}
                className="h-8 w-8 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                title="Clear draft layout (archives first; never deletes audit log)"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </>
          ) : canEdit ? (
            <button
              onClick={() => setEditMode(true)}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
            >
              <Edit3 className="h-3.5 w-3.5" /> Edit org
            </button>
          ) : null}
        </div>
      </div>
      {historyOpen && (
        <div className="border-b border-border bg-muted/20 px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[200px] overflow-y-auto">
          <div>
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
              <UserPlus className="h-3 w-3" /> Added on chart ({activeAdditions.length})
            </div>
            {activeAdditions.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No custom additions.</p>
            ) : (
              <ul className="space-y-1.5">
                {activeAdditions.map((a) => (
                  <li key={a.id} className="text-[12px] flex justify-between gap-2">
                    <span className="truncate font-medium">{a.full_name}</span>
                    <span className="text-muted-foreground shrink-0">
                      → {managerNameById.get(a.manager_id ?? "") ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
              <UserMinus className="h-3 w-3" /> Terminated / removed ({terminations.length})
            </div>
            {terminations.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No terminations recorded.</p>
            ) : (
              <ul className="space-y-1.5">
                {terminations.map((t) => (
                  <li key={t.employeeId} className="text-[12px]">
                    <div className="flex justify-between gap-2">
                      <span className="truncate font-medium">{t.fullName}</span>
                      <span className="text-muted-foreground shrink-0">{fmtRelative(t.terminatedAt)}</span>
                    </div>
                    <div className="text-[10.5px] text-muted-foreground">
                      Was under {managerNameById.get(t.previousManagerId ?? "") ?? "—"}
                      {t.isDummy ? " · dummy" : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onInit={setRf}
          nodesDraggable={canEditNow}
          nodesConnectable={canEditNow}
          edgesUpdatable={canEditNow}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(n) =>
              (n.data as any)?.isHighlighted ? "var(--primary)" : "var(--muted-foreground)"
            }
            maskColor="oklch(0.95 0.01 80 / 0.6)"
            style={{ background: "var(--paper)" }}
          />
        </ReactFlow>
      </div>
      <AddPersonModal
        open={addPersonOpen}
        employees={effectiveEmployees}
        onCancel={() => setAddPersonOpen(false)}
        onAdd={addPerson}
      />
      <TerminateConfirmModal
        target={terminateTarget}
        onCancel={() => setTerminateTargetId(null)}
        onConfirm={confirmTerminate}
      />
    </div>
  );
}
