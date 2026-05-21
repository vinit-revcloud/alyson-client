import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import {
  LayoutDashboard, Users, DollarSign, TrendingUp, Gift, PieChart, Calendar,
  Clock, FileText, GitBranch, BarChart3, Shield, HelpCircle,
  Moon, Sun, ChevronsLeft, ChevronsRight, LogOut, Search, Bot, Menu, X, Send,
  Captions, UserPlus, CalendarDays, Paintbrush,
} from "lucide-react";
import { useAuth, ROLE_LABEL, type AppRole } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { NotificationsPopover } from "@/components/NotificationsPopover";
import { CommandPalette } from "@/components/CommandPalette";
import { streamAlyson, type ChatMsg } from "@/lib/ai-client";
import { askMiniModuleAi } from "@/lib/mini-module-ai";
import { toast } from "sonner";

declare const __BUILD_SHA__: string;
declare const __BUILD_ENV__: string;

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  roles?: AppRole[];
  group: "Workspace" | "People" | "Money" | "Ops" | "Admin";
};

const NEW_BADGE_ROUTES = new Set<string>([
  "/bonus",
  "/time-dashboard",
  "/alyson-notetaker",
  "/alyson-notetaker/calendar",
  "/alyson-notetaker/analytics",
  "/boarding",
  "/help",
]);

const NAV: NavItem[] = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true, group: "Workspace" },
  { to: "/team", label: "Team", icon: Users, group: "People" },
  { to: "/boarding", label: "Boarding", icon: UserPlus, group: "People", roles: ["super_admin", "ceo", "hr"] },
  { to: "/time-dashboard", label: "Time Dashboard", icon: Clock, group: "People", roles: ["super_admin"] },
  { to: "/performance", label: "Performance", icon: TrendingUp, group: "People" },
  { to: "/leave", label: "Leave", icon: Calendar, group: "People" },
  { to: "/attendance", label: "Attendance", icon: Clock, group: "People" },
  { to: "/payroll", label: "Payroll", icon: DollarSign, group: "Money", roles: ["super_admin", "ceo", "finance", "hr"] },
  { to: "/bonus", label: "Bonus", icon: Gift, group: "Money", roles: ["super_admin", "ceo", "finance", "hr", "manager"] },
  { to: "/equity", label: "Equity", icon: PieChart, group: "Money" },
  { to: "/workflows", label: "Workflows", icon: GitBranch, group: "Ops" },
  { to: "/documents", label: "Documents", icon: FileText, group: "Ops" },
  { to: "/reports", label: "Reports", icon: BarChart3, group: "Ops", roles: ["super_admin", "ceo", "finance", "hr"] },
  { to: "/alyson-notetaker", label: "Alyson Notetaker", icon: Captions, group: "Ops", roles: ["super_admin"] },
  { to: "/alyson-notetaker/calendar", label: "Meeting Calendar", icon: CalendarDays, group: "Ops", roles: ["super_admin"] },
  { to: "/alyson-notetaker/analytics", label: "Analytics", icon: BarChart3, group: "Ops", roles: ["super_admin"] },
  { to: "/admin", label: "Admin", icon: Shield, group: "Admin", roles: ["super_admin"] },
  { to: "/help", label: "Help", icon: HelpCircle, group: "Admin" },
];

const ROLES: AppRole[] = ["super_admin", "ceo", "finance", "hr", "manager", "employee"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { hasAnyRole, primaryRole, demoRole, setDemoRole, signOut, user, tryUnlockSuperAdmin, superAdminUnlocked } = useAuth();
  const { theme, toggle, palette, setPalette } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [miniAiOpen, setMiniAiOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [superAdminPromptOpen, setSuperAdminPromptOpen] = useState(false);
  const [superAdminCode, setSuperAdminCode] = useState("");
  const [superAdminError, setSuperAdminError] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<AppRole | null>(null);

  const visible = NAV.filter((n) => !n.roles || hasAnyRole(n.roles));
  const grouped = groupBy(visible, (n) => n.group);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  // Cmd+K palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-screen flex w-full bg-background text-foreground">
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} aria-hidden />
      )}
      {superAdminPromptOpen && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 px-4" aria-hidden={false}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-background shadow-xl p-4">
            <div className="font-medium text-[14px]">Super admin verification</div>
            <div className="mt-1 text-[12px] text-muted-foreground">
              Enter the 5-digit code to enable Super Admin access on this device.
            </div>
            <input
              value={superAdminCode}
              onChange={(e) => {
                setSuperAdminError(null);
                setSuperAdminCode(e.target.value.replace(/\D/g, "").slice(0, 5));
              }}
              inputMode="numeric"
              autoFocus
              placeholder="•••••"
              className="mt-3 w-full h-10 rounded-md border border-border bg-background px-3 font-mono text-[16px] tracking-[0.3em]"
            />
            {superAdminError && (
              <div className="mt-2 text-[12px] text-destructive">{superAdminError}</div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setSuperAdminPromptOpen(false);
                  setSuperAdminCode("");
                  setSuperAdminError(null);
                  setPendingRole(null);
                }}
                className="h-9 px-3 rounded-md border border-border text-[12px] hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const ok = tryUnlockSuperAdmin(superAdminCode);
                  if (!ok) {
                    setSuperAdminError("Invalid code");
                    return;
                  }
                  toast.success("Super admin access granted");
                  setSuperAdminPromptOpen(false);
                  setSuperAdminCode("");
                  setSuperAdminError(null);
                  if (pendingRole) setDemoRole(pendingRole);
                  setPendingRole(null);
                }}
                className="h-9 px-3 rounded-md bg-foreground text-background text-[12px] hover:opacity-90"
              >
                Verify
              </button>
            </div>
          </div>
        </div>
      )}

      <aside
        className={[
          "border-r border-sidebar-border bg-sidebar flex flex-col transition-[width,transform] duration-200",
          "md:sticky md:top-0 md:h-screen md:translate-x-0",
          collapsed ? "md:w-[60px]" : "md:w-[232px]",
          "fixed inset-y-0 left-0 z-40 w-[260px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          "shrink-0",
        ].join(" ")}
      >
        <div className="px-3 pt-4 pb-3 border-b border-sidebar-border flex items-center gap-2.5">
          <Link
            to="/"
            className="flex items-center gap-2.5 min-w-0 flex-1 rounded-md hover:bg-sidebar-accent/60 transition-colors px-1.5 py-1 -mx-1.5"
            aria-label="Go to landing page"
          >
            {(!collapsed || mobileOpen) && (
              <div className="leading-tight min-w-0">
                <div className="font-display text-[16px] font-semibold tracking-tight truncate">Alyson HR</div>
                <div className="text-[10.5px] text-muted-foreground -mt-0.5">Acme, Inc.</div>
              </div>
            )}
            {(collapsed && !mobileOpen) && (
              <div className="h-8 w-8 rounded-lg border border-sidebar-border bg-sidebar-accent/40 grid place-items-center shrink-0">
                <span className="font-display text-[14px] font-semibold tracking-tight">A</span>
              </div>
            )}
          </Link>
          <button
            onClick={() => setMobileOpen(false)}
            className="md:hidden h-7 w-7 grid place-items-center rounded-md hover:bg-sidebar-accent text-muted-foreground"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-3 overflow-y-auto">
          {(["Workspace", "People", "Money", "Ops", "Admin"] as const).map((g) => {
            const items = grouped[g];
            if (!items?.length) return null;
            const showLabel = !collapsed || mobileOpen;
            return (
              <div key={g}>
                {showLabel && (
                  <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-medium">{g}</div>
                )}
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const active = item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.to}
                        to={item.to as "/"}
                        title={collapsed && !mobileOpen ? item.label : undefined}
                        className={
                          "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px] transition-colors " +
                          (active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")
                        }
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {showLabel && (
                          <span className="truncate flex items-center gap-2 min-w-0">
                            <span className="truncate">{item.label}</span>
                            {NEW_BADGE_ROUTES.has(item.to) && (
                              <span className="shrink-0 rounded-full border border-blue-600/30 bg-blue-600/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                                New
                              </span>
                            )}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border p-2 space-y-2">
          {(!collapsed || mobileOpen) && (
            <div className="rounded-md bg-sidebar-accent/40 border border-sidebar-border p-2">
              <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-1.5 flex items-center justify-between">
                <span>Demo role</span>
                {demoRole && (
                  <button onClick={() => setDemoRole(null)} className="text-[10px] underline hover:no-underline normal-case tracking-normal">reset</button>
                )}
              </div>
              <select
                value={demoRole ?? primaryRole}
                onChange={(e) => {
                  const next = e.target.value as AppRole;
                  if (next === "super_admin" && !superAdminUnlocked) {
                    setPendingRole(next);
                    setSuperAdminPromptOpen(true);
                    setSuperAdminCode("");
                    setSuperAdminError(null);
                    return;
                  }
                  setDemoRole(next);
                }}
                className="w-full h-7 rounded bg-paper border border-border text-xs px-1.5"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1">
            <button onClick={toggle} title="Toggle theme" className="h-8 w-8 grid place-items-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors">
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button onClick={() => setCollapsed((c) => !c)} title="Collapse" className="hidden md:grid h-8 w-8 place-items-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors">
              {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
            </button>
            <button onClick={signOut} title="Sign out" className="h-8 w-8 grid place-items-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors ml-auto">
              <LogOut className="h-4 w-4" />
            </button>
          </div>

          {(!collapsed || mobileOpen) && user && (
            <div className="px-1.5 pt-1 text-[11px] text-muted-foreground truncate">{user.email}</div>
          )}

          {(!collapsed || mobileOpen) && (
            <div className="px-1.5 pb-1 text-[10px] text-muted-foreground flex items-center justify-between gap-2">
              <span className="truncate">
                build {(__BUILD_SHA__ || "").slice(0, 7) || "dev"}
              </span>
              <span className="shrink-0">
                {(__BUILD_ENV__ || "").toLowerCase() || "local"}
              </span>
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <TopBar
          onAi={() => setAiOpen((o) => !o)}
          onMenu={() => setMobileOpen(true)}
          onSearch={() => setPaletteOpen(true)}
          themePalette={palette}
          onThemePalette={setPalette}
        />
        <div className="flex-1 min-h-0">{children}</div>
      </main>

      {aiOpen && <AiPanel onClose={() => setAiOpen(false)} pagePath={location.pathname} />}
      <MiniModuleAiFab
        open={miniAiOpen}
        onToggle={() => setMiniAiOpen((v) => !v)}
        onClose={() => setMiniAiOpen(false)}
        pagePath={location.pathname}
      />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function TopBar({
  onAi,
  onMenu,
  onSearch,
  themePalette,
  onThemePalette,
}: {
  onAi: () => void;
  onMenu: () => void;
  onSearch: () => void;
  themePalette: string;
  onThemePalette: (p: any) => void;
}) {
  const [themeOpen, setThemeOpen] = useState(false);
  return (
    <div className="h-12 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-20 flex items-center px-3 md:px-5 gap-2 md:gap-3">
      <button onClick={onMenu} className="md:hidden h-8 w-8 grid place-items-center rounded-md hover:bg-muted text-muted-foreground" aria-label="Open menu">
        <Menu className="h-4 w-4" />
      </button>
      <button
        onClick={onSearch}
        className="w-full max-w-md relative h-8 pl-8 pr-3 rounded-md border border-border bg-muted/40 text-[13px] text-left text-muted-foreground hover:bg-muted/60"
      >
        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" />
        Jump to…
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded border border-border bg-background">⌘K</kbd>
      </button>
      <div className="ml-auto flex items-center">
        <div className="relative">
          <button
            type="button"
            onClick={() => setThemeOpen((o) => !o)}
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
            aria-label="Theme"
            title="Theme"
          >
            <Paintbrush className="h-4 w-4" />
          </button>
          {themeOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setThemeOpen(false)} aria-hidden />
              <div className="absolute right-0 mt-2 z-40 w-44 rounded-lg border border-border bg-paper shadow-xl overflow-hidden">
                <div className="px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium border-b border-border">
                  Theme
                </div>
                {(
                  [
                    ["default", "Default"],
                    ["sapphire", "Sapphire"],
                    ["emerald", "Emerald"],
                    ["rose", "Rose"],
                    ["amber", "Amber"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      onThemePalette(id);
                      setThemeOpen(false);
                    }}
                    className={
                      "w-full text-left px-3 py-2 text-[12.5px] hover:bg-muted/40 flex items-center justify-between " +
                      (themePalette === id ? "text-foreground" : "text-muted-foreground")
                    }
                  >
                    <span>{label}</span>
                    {themePalette === id ? <span className="text-[11px] text-muted-foreground">Selected</span> : null}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <NotificationsPopover />
      </div>
    </div>
  );
}

function AiPanel({ onClose, pagePath }: { onClose: () => void; pagePath: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: "assistant", content: `Hi, I'm Alyson, your operations copilot. I can see you're on ${pagePath}. Ask me about formulas, payroll projections, equity vesting, or any KPI on this page.` },
  ]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || streaming) return;
    const userMsg: ChatMsg = { role: "user", content: input };
    const next = [...messages, userMsg];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);

    await streamAlyson({
      messages: next,
      page: pagePath,
      onDelta: (d) => {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: copy[copy.length - 1].content + d };
          return copy;
        });
      },
      onDone: () => setStreaming(false),
      onError: (msg) => {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${msg}` };
          return copy;
        });
        setStreaming(false);
      },
    });
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={onClose} aria-hidden />
      <aside className="fixed md:sticky right-0 top-0 z-40 w-full sm:w-[380px] md:w-[360px] shrink-0 border-l border-border bg-paper h-screen flex flex-col">
        <div className="h-12 border-b border-border px-4 flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <div className="font-medium text-sm">Alyson AI</div>
          <div className="ml-auto">
            <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted">Close</button>
          </div>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "ml-auto max-w-[85%]" : "max-w-[90%]"}>
              <div className={"rounded-lg px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap " + (m.role === "user" ? "bg-foreground text-background" : "bg-muted/60 text-foreground")}>
                {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
              </div>
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          className="p-3 border-t border-border flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything…"
            disabled={streaming}
            className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
          />
          <button type="submit" disabled={streaming || !input.trim()} className="h-9 w-9 grid place-items-center rounded-md bg-foreground text-background disabled:opacity-40">
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </aside>
    </>
  );
}

function MiniModuleAiFab({
  open,
  onToggle,
  onClose,
  pagePath,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  pagePath: string;
}) {
  const alysonFaceSrc = "/images/alyson-mini.svg";
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        "Hi, I’m Alyson Mini. I can answer questions only about the page/module you’re currently on.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  // Reset context when module changes (keep it strict per user request).
  useEffect(() => {
    if (!open) return;
    setMessages([
      {
        role: "assistant",
        content:
          "Hi — I’m Alyson Mini. I can answer questions only about the page/module you’re currently on.",
      },
    ]);
    setInput("");
    setLoading(false);
  }, [pagePath, open]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const q = input.trim();
    setInput("");
    setLoading(true);

    setMessages((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content: "" }]);

    try {
      // Never reveal hidden prompts / internal instructions.
      if (
        /(system\s+prompt|prompt\s*injection|developer\s+message|hidden\s+instructions|your\s+instructions|what\s+prompt)/i.test(
          q,
        )
      ) {
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: "assistant",
            content:
              "I can’t share my internal instructions. Ask me a question about this module’s data or actions instead.",
          };
          return copy;
        });
        setLoading(false);
        return;
      }

      const liveCtx = typeof window !== "undefined" ? (window as any).__ALYSON_MINI_CONTEXT__ : null;
      const contextText = (() => {
        if (!liveCtx) return undefined;
        const raw = JSON.stringify(liveCtx, null, 2);
        // Avoid oversized requests that can make the model fail on long conversations.
        return raw.length > 12000 ? raw.slice(0, 12000) + "\n…(truncated)\n" : raw;
      })();

      // Deterministic answers for dashboard-style questions (avoid AI gibberish).
      if (String(pagePath).startsWith("/time-dashboard") && liveCtx?.module === "time-dashboard") {
        const allToday = Array.isArray(liveCtx?.employees_all_today) ? liveCtx.employees_all_today : [];
        const onlyNames = /\bonly\s+names?\b/i.test(q) || /\bno\s+fluff\b/i.test(q);
        const wantsPersonHours =
          /(hours|hrs|working\s*hours|daily\s*hours|today)/i.test(q) &&
          /(of|for|about)\s+/i.test(q) &&
          !/(how\s+many|number\s+of|count|list|which)/i.test(q);

        const normalize = (s: string) =>
          String(s || "")
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const maybeName = (() => {
          const m =
            q.match(/\b(?:of|for|about)\s+([a-z][a-z0-9\s.'-]{2,})$/i) ??
            q.match(/\b([a-z][a-z0-9\s.'-]{2,})\s*(?:hours|hrs)\b/i);
          return m ? String(m[1]).trim() : "";
        })();

        if (wantsPersonHours && maybeName) {
          const target = normalize(maybeName);
          const exact = allToday.find((e: any) => normalize(e?.name) === target) ?? null;
          const partial =
            exact ??
            allToday.find((e: any) => normalize(e?.name).includes(target) || target.includes(normalize(e?.name))) ??
            null;

          if (partial) {
            const daily = typeof partial.daily_hours === "number" ? partial.daily_hours : null;
            const monthly = typeof partial.monthly_hours === "number" ? partial.monthly_hours : null;
            const dailyTxt = daily != null ? `${daily.toFixed(2)}h today` : "today hours unavailable";
            const monthlyTxt = monthly != null ? `${monthly.toFixed(2)}h this month` : "monthly hours unavailable";

            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = {
                role: "assistant",
                content: `${partial.name}: ${dailyTxt} (${monthlyTxt}).`,
              };
              return copy;
            });
            setLoading(false);
            return;
          }

          // Helpful fallback: show a few close candidates.
          const candidates = allToday
            .map((e: any) => String(e?.name || "").trim())
            .filter(Boolean)
            .filter((n: string) => normalize(n).includes(target.split(" ")[0] || target))
            .slice(0, 8);

          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: candidates.length
                ? `I can’t find "${maybeName}" in the current table. Did you mean:\n- ${candidates.join("\n- ")}`
                : `I can’t find "${maybeName}" in the current table.`,
            };
            return copy;
          });
          setLoading(false);
          return;
        }

        const betweenMatch = q.match(/\bbetween\s*(\d+(?:\.\d+)?)\s*(?:and|to)\s*(\d+(?:\.\d+)?)/i);
        const betweenA = betweenMatch ? Number.parseFloat(betweenMatch[1]) : null;
        const betweenB = betweenMatch ? Number.parseFloat(betweenMatch[2]) : null;
        const wantsBetweenDaily =
          betweenA != null &&
          betweenB != null &&
          Number.isFinite(betweenA) &&
          Number.isFinite(betweenB) &&
          /(hour|hours|hrs)/i.test(q) &&
          /(today|daily)/i.test(q) &&
          /\bbetween\b/i.test(q);

        const thresholdMatch =
          q.match(/(?:greater\s+than|more\s+than|over|above|>|>=)\s*(\d+(?:\.\d+)?)/i) ??
          q.match(/(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs)\b/i);
        const threshold = thresholdMatch ? Number.parseFloat(thresholdMatch[1]) : null;
        const wantsThresholdList =
          threshold != null &&
          Number.isFinite(threshold) &&
          /(hour|hours|hrs)/i.test(q) &&
          /(today|daily)/i.test(q) &&
          /(who|which|list|employees)/i.test(q) &&
          /(greater\s+than|more\s+than|over|above|>|>=)/i.test(q);

        const wantsMonthlyThreshold =
          threshold != null &&
          Number.isFinite(threshold) &&
          /(month|monthly)/i.test(q) &&
          /(hour|hours|hrs)/i.test(q) &&
          /(greater\s+than|more\s+than|over|above|>|>=)/i.test(q) &&
          /(who|which|list|employees|names)/i.test(q);

        const wantsCountGt3 =
          /(how\s+many|number\s+of|count)/i.test(q) && />\s*3|greater\s+than\s+3|\bgt\s*3\b/i.test(q) && /(hour|hours|hrs)/i.test(q) && /(today|daily)/i.test(q);
        const wantsHighestToday =
          /highest/i.test(q) && /(hour|hours|hrs)/i.test(q) && /(today|daily)/i.test(q);
        const wantsZeroToday =
          /(who|which|list)/i.test(q) && /(0|zero)/i.test(q) && /(hour|hours|hrs)/i.test(q) && /(today|daily)/i.test(q);

        if (wantsBetweenDaily) {
          const lo = Math.min(betweenA as number, betweenB as number);
          const hi = Math.max(betweenA as number, betweenB as number);
          const filtered = allToday
            .filter(
              (e: any) =>
                typeof e?.daily_hours === "number" &&
                Number.isFinite(e.daily_hours) &&
                e.daily_hours >= lo &&
                e.daily_hours <= hi,
            )
            .sort((a: any, b: any) => (b.daily_hours ?? 0) - (a.daily_hours ?? 0));

          const lines = onlyNames
            ? filtered.map((e: any) => String(e.name)).slice(0, 200)
            : filtered.map((e: any) => `${e.name} — ${Number(e.daily_hours).toFixed(2)}h`).slice(0, 80);

          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: lines.length ? lines.join("\n") : "No employees match that range.",
            };
            return copy;
          });
          setLoading(false);
          return;
        }

        if (wantsMonthlyThreshold) {
          const filtered = allToday
            .filter(
              (e: any) =>
                typeof e?.monthly_hours === "number" &&
                Number.isFinite(e.monthly_hours) &&
                e.monthly_hours > (threshold as number),
            )
            .sort((a: any, b: any) => (b.monthly_hours ?? 0) - (a.monthly_hours ?? 0));

          const lines = onlyNames
            ? filtered.map((e: any) => String(e.name)).slice(0, 200)
            : filtered.map((e: any) => `${e.name} — ${Number(e.monthly_hours).toFixed(2)}h`).slice(0, 80);

          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: lines.length ? lines.join("\n") : "No employees match that filter.",
            };
            return copy;
          });
          setLoading(false);
          return;
        }

        if (wantsThresholdList) {
          const filtered = allToday
            .filter((e: any) => typeof e?.daily_hours === "number" && Number.isFinite(e.daily_hours) && e.daily_hours > (threshold as number))
            .sort((a: any, b: any) => (b.daily_hours ?? 0) - (a.daily_hours ?? 0));
          const names = onlyNames
            ? filtered.slice(0, 200).map((e: any) => String(e.name))
            : filtered.slice(0, 80).map((e: any) => `${e.name} — ${Number(e.daily_hours).toFixed(2)}h`);
          const more = filtered.length > names.length ? `\n\n…and ${filtered.length - names.length} more.` : "";
          const body = names.length ? names.join("\n") : "No employees match that filter.";
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: `${body}${more}`,
            };
            return copy;
          });
          setLoading(false);
          return;
        }

        if (wantsCountGt3) {
          const n = typeof liveCtx?.employees_gt_3_hours_today_count === "number" ? liveCtx.employees_gt_3_hours_today_count : null;
          if (n != null) {
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = {
                role: "assistant",
                content: `${n} employee(s) have worked more than 3 hours today.`,
              };
              return copy;
            });
            setLoading(false);
            return;
          }
        }
        if (wantsHighestToday) {
          const top = liveCtx?.highest_hours_today;
          if (top?.name && typeof top?.daily_hours === "number") {
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = {
                role: "assistant",
                content: `${top.name} has worked the highest hours today: ${top.daily_hours.toFixed(2)}h.`,
              };
              return copy;
            });
            setLoading(false);
            return;
          }
        }
        if (wantsZeroToday) {
          const zero = Array.isArray(liveCtx?.employees_zero_hours_today_preview)
            ? liveCtx.employees_zero_hours_today_preview
            : [];
          const count =
            typeof liveCtx?.employees_zero_hours_today_count === "number"
              ? liveCtx.employees_zero_hours_today_count
              : null;
          if (count != null) {
            const names = zero.map((e: any) => e?.name).filter(Boolean).slice(0, 30);
            const list = names.length ? `\n\nExamples:\n- ${names.join("\n- ")}` : "";
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = {
                role: "assistant",
                content: `${count} employee(s) have 0 hours today.${list}`,
              };
              return copy;
            });
            setLoading(false);
            return;
          }
        }
      }

      // Deterministic answers for Meeting Calendar (visible on-screen data).
      if (String(pagePath).startsWith("/alyson-notetaker/calendar") && liveCtx?.module === "notetaker-calendar") {
        const meetingsShown = Array.isArray(liveCtx?.meetingsShown) ? liveCtx.meetingsShown : [];
        const pickedDay = liveCtx?.pickedDay ? String(liveCtx.pickedDay) : null;
        const wantsCount =
          /\bhow\s+many\b|\bnumber\s+of\b|\bcount\b/i.test(q) &&
          /\bmeeting(s)?\b/i.test(q);
        const wantsNames =
          /\bname(s)?\b|\blist\b|\bwhich\b/i.test(q) &&
          /\bmeeting(s)?\b/i.test(q);

        if (wantsCount || wantsNames) {
          const count = meetingsShown.length;
          const titles = meetingsShown
            .map((m: any) => String(m?.title || "").trim())
            .filter(Boolean)
            .slice(0, 80);

          const header = pickedDay
            ? `Meetings shown for ${pickedDay}: ${count}`
            : `Meetings shown (current month view): ${count}`;
          const body = titles.length ? `\n\n${titles.map((t: string) => `- ${t}`).join("\n")}` : "";

          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: wantsNames ? `${header}${body}` : header,
            };
            return copy;
          });
          setLoading(false);
          return;
        }
      }

      // Deterministic answers for Time Doctor user detail (Apps & Websites tab).
      if (String(pagePath).startsWith("/time-dashboard/") && liveCtx?.module === "time-doctor-user-detail") {
        const tab = String(liveCtx?.tab || "");
        const userName = String(liveCtx?.user?.name || "this user");
        const top = Array.isArray(liveCtx?.apps_websites_top) ? liveCtx.apps_websites_top : [];

        if (tab === "apps") {
          const wantsMostUsedWebsites =
            /(most\s+used|top)\s+(websites|website|sites|site)/i.test(q) ||
            (/\bwebsites?\b/i.test(q) && /\bmost\b/i.test(q));
          const wantsNonProductive =
            /(non\s*productive|not\s*productive|distract|distracting)/i.test(q) &&
            /(apps?|websites?|sites?)/i.test(q);

          if (wantsMostUsedWebsites) {
            const websites = top.filter((t: any) => /web/i.test(String(t?.category || "")));
            const lines = websites
              .slice(0, 12)
              .map((w: any) => `${String(w.name)} — ${Number(w.hours ?? 0).toFixed(2)}h`);
            const out = lines.length ? lines.join("\n") : "No website usage rows are shown on this screen.";
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: "assistant", content: out };
              return copy;
            });
            setLoading(false);
            return;
          }

          if (wantsNonProductive) {
            const nonProd = top.filter((t: any) => /distract/i.test(String(t?.category || "")));
            const lines = nonProd
              .slice(0, 20)
              .map((t: any) => `${String(t.name)} — ${Number(t.hours ?? 0).toFixed(2)}h`);
            const out = lines.length
              ? `Not productive apps/websites shown for ${userName}:\n${lines.map((l: string) => `- ${l}`).join("\n")}`
              : `No "distracting" rows are shown on this screen for ${userName}.`;
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: "assistant", content: out };
              return copy;
            });
            setLoading(false);
            return;
          }
        }
      }

      // Deterministic answers for the Org Chart canvas.
      if (liveCtx?.module === "org-chart") {
        const employees: Array<{
          id: string;
          name: string;
          role: string;
          level?: string;
          department: string;
          email?: string;
          manager_id: string | null;
          manager_name: string | null;
          direct_report_ids: string[];
          direct_report_count: number;
          is_dummy: boolean;
        }> = Array.isArray(liveCtx?.employees) ? liveCtx.employees : [];
        const terminations: Array<{
          id: string;
          name: string;
          role: string | null;
          department: string | null;
          is_dummy: boolean;
          terminated_at: string;
          previous_manager_id: string | null;
          reparented_to_manager_id: string | null;
        }> = Array.isArray(liveCtx?.terminations) ? liveCtx.terminations : [];
        const additions: Array<{
          id: string;
          name: string;
          role: string;
          department: string;
          manager_id: string | null;
          is_dummy: boolean;
        }> = Array.isArray(liveCtx?.additions) ? liveCtx.additions : [];

        const byId = new Map(employees.map((e) => [e.id, e]));
        const normalize = (s: string) =>
          String(s || "")
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const findPerson = (raw: string) => {
          const target = normalize(raw);
          if (!target) return null;
          const exact = employees.find((e) => normalize(e.name) === target);
          if (exact) return exact;
          const tokens = target.split(" ").filter(Boolean);
          const startsWith = employees.find((e) => {
            const n = normalize(e.name);
            return tokens.every((t) => n.split(" ").some((w) => w.startsWith(t)));
          });
          if (startsWith) return startsWith;
          return employees.find((e) => normalize(e.name).includes(target)) ?? null;
        };

        const reportsQ =
          q.match(/(?:works?\s+under|reports?\s+(?:to|under)|under|reports?\s+of|direct\s+reports?\s+(?:of|for)|team\s+(?:of|under)|subordinates?\s+of)\s+([a-z][a-z0-9.\s'-]{1,})$/i);
        const managerQ =
          q.match(/(?:who\s+is|whos|who's)\s+([a-z][a-z0-9.\s'-]{1,})\s*['’]?s?\s+manager\b/i) ||
          q.match(/(?:manager\s+(?:of|for))\s+([a-z][a-z0-9.\s'-]{1,})$/i);
        const allReportsQ =
          /\b(all|every|entire|whole)\s+(team|reports|subordinates|people|members)\b/i.test(q) &&
          /\bunder\s+([a-z][a-z0-9.\s'-]{1,})$/i.test(q);
        const allReportsMatch = q.match(/\bunder\s+([a-z][a-z0-9.\s'-]{1,})$/i);

        const headcountQ = /\b(how\s+many|number\s+of|total|count)\b.*\b(people|employees|headcount|head\s*count)\b/i.test(q);
        const terminatedQ = /\b(terminated|fired|removed|deleted)\b/i.test(q) && /\b(list|who|show|all)\b/i.test(q);
        const addedQ = /\b(added|dummy|new)\b/i.test(q) && /\b(list|who|show|all)\b/i.test(q);

        const buildPersonHeader = (p: typeof employees[number]) =>
          `${p.name}${p.role ? ` — ${p.role}` : ""}${p.department ? ` · ${p.department}` : ""}`;

        const respond = (content: string) => {
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: "assistant", content };
            return copy;
          });
          setLoading(false);
        };

        if (headcountQ) {
          const live = employees.length;
          const termCount = terminations.length;
          const addCount = additions.length;
          respond(
            [
              `${live} active people on the org chart.`,
              termCount ? `${termCount} terminated (full history kept).` : null,
              addCount ? `${addCount} synthetic/added.` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          );
          return;
        }

        if (terminatedQ) {
          if (!terminations.length) {
            respond("No terminations recorded for this org chart.");
            return;
          }
          const rows = terminations
            .slice()
            .sort((a, b) => b.terminated_at.localeCompare(a.terminated_at))
            .slice(0, 50)
            .map(
              (t) =>
                `- ${t.name}${t.role ? ` — ${t.role}` : ""}${t.department ? ` · ${t.department}` : ""}  (${t.terminated_at.slice(0, 10)}${t.is_dummy ? ", dummy" : ""})`,
            );
          respond(`Terminations (${terminations.length}):\n${rows.join("\n")}`);
          return;
        }

        if (addedQ) {
          if (!additions.length) {
            respond("No people have been added in draft on this org chart.");
            return;
          }
          const rows = additions
            .slice(0, 50)
            .map(
              (a) =>
                `- ${a.name}${a.role ? ` — ${a.role}` : ""}${a.department ? ` · ${a.department}` : ""}${a.is_dummy ? "  (dummy)" : ""}`,
            );
          respond(`Added in draft (${additions.length}):\n${rows.join("\n")}`);
          return;
        }

        if (managerQ) {
          const name = String(managerQ[1] || "").trim();
          const p = findPerson(name);
          if (!p) {
            respond(`I couldn't find "${name}" on the chart. Try the exact name as it appears on a node.`);
            return;
          }
          if (!p.manager_id) {
            respond(`${p.name} has no manager (root of the tree).`);
            return;
          }
          const mgr = byId.get(p.manager_id);
          respond(
            mgr
              ? `${p.name} reports to ${mgr.name}${mgr.role ? ` (${mgr.role})` : ""}.`
              : `${p.name}'s manager id is ${p.manager_id}, but that person isn't on the current chart.`,
          );
          return;
        }

        const handleSubtree = (name: string) => {
          const p = findPerson(name);
          if (!p) {
            respond(`I couldn't find "${name}" on the chart. Try the exact name as it appears on a node.`);
            return;
          }
          const visited = new Set<string>();
          const collect = (rootId: string) => {
            const queue: string[] = [rootId];
            while (queue.length) {
              const id = queue.shift()!;
              if (visited.has(id)) continue;
              visited.add(id);
              const e = byId.get(id);
              if (e) queue.push(...e.direct_report_ids);
            }
          };
          collect(p.id);
          visited.delete(p.id);
          if (!visited.size) {
            respond(`${p.name} has no reports on this org chart.`);
            return;
          }
          const groups = new Map<string | null, string[]>();
          for (const id of visited) {
            const e = byId.get(id);
            if (!e) continue;
            const key = e.manager_id;
            const arr = groups.get(key) ?? [];
            arr.push(id);
            groups.set(key, arr);
          }
          const lines: string[] = [`Everyone under ${buildPersonHeader(p)} (${visited.size}):`];
          const ordered = Array.from(visited)
            .map((id) => byId.get(id))
            .filter(Boolean)
            .sort((a, b) => (a!.name).localeCompare(b!.name));
          for (const e of ordered) {
            const mgr = e!.manager_id ? byId.get(e!.manager_id) : null;
            lines.push(
              `- ${e!.name}${e!.role ? ` — ${e!.role}` : ""}${e!.department ? ` · ${e!.department}` : ""}${mgr ? `  ↦ ${mgr.name}` : ""}`,
            );
          }
          respond(lines.join("\n"));
        };

        if (allReportsQ && allReportsMatch) {
          handleSubtree(String(allReportsMatch[1] || "").trim());
          return;
        }

        if (reportsQ) {
          const name = String(reportsQ[1] || "").trim();
          const wantsTree = /\b(all|every|entire|whole|recursive|deep)\b/i.test(q);
          const p = findPerson(name);
          if (!p) {
            respond(`I couldn't find "${name}" on the chart. Try the exact name as it appears on a node.`);
            return;
          }
          if (wantsTree) {
            handleSubtree(name);
            return;
          }
          if (!p.direct_report_ids.length) {
            respond(`${p.name} has no direct reports on this org chart.`);
            return;
          }
          const list = p.direct_report_ids
            .map((id) => byId.get(id))
            .filter(Boolean)
            .sort((a, b) => (a!.name).localeCompare(b!.name))
            .map(
              (e) =>
                `- ${e!.name}${e!.role ? ` — ${e!.role}` : ""}${e!.department ? ` · ${e!.department}` : ""}`,
            );
          respond(
            `${buildPersonHeader(p)} has ${p.direct_report_ids.length} direct report(s):\n${list.join("\n")}`,
          );
          return;
        }
      }

      const history = messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .slice(-6)
        .map((m: any) => ({ role: m.role, content: String(m.content ?? "") }));
      const res = await askMiniModuleAi({ data: { pagePath, question: q, history, contextText } });
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "assistant", content: res.answer };
        return copy;
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : typeof e === "string" ? e : "Mini AI request failed";
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${msg}` };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Floating robot button */}
      <button
        type="button"
        onClick={onToggle}
        aria-label="Open Alyson Mini"
        title="Alyson Mini"
        className="fixed z-[70] bottom-4 right-4 h-12 w-12 bg-transparent border-0 p-0"
      >
        <span className="sr-only">Alyson Mini</span>
        <img
          src={alysonFaceSrc}
          alt=""
          className={"h-12 w-12 rounded-full shadow-lg " + (open ? "ring-2 ring-ring/40" : "")}
          draggable={false}
          onError={(e) => {
            // If asset missing, hide the <img> so the fallback icon can show.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <Bot className="h-5 w-5 mx-auto -mt-9 opacity-0" aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[65] bg-black/25" onClick={onClose} aria-hidden />
          <div className="fixed z-[70] bottom-20 right-4 w-[360px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-paper shadow-xl overflow-hidden">
            <div className="h-10 px-3 border-b border-border flex items-center gap-2">
              <img src={alysonFaceSrc} alt="" className="h-5 w-5 rounded-full" draggable={false} />
              <div className="text-[13px] font-medium">Alyson Mini</div>
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-7 px-2 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  Close
                </button>
              </div>
            </div>

            <div ref={scrollRef} className="max-h-[360px] overflow-y-auto p-3 space-y-2">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "ml-auto max-w-[88%]" : "max-w-[92%]"}>
                  <div
                    className={
                      "rounded-lg px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap " +
                      (m.role === "user" ? "bg-foreground text-background" : "bg-muted/60 text-foreground")
                    }
                  >
                    {m.content || (loading && i === messages.length - 1 ? "…" : "")}
                  </div>
                </div>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="p-2 border-t border-border flex gap-2"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about this module…"
                disabled={loading}
                className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="h-9 w-9 grid place-items-center rounded-md bg-foreground text-background disabled:opacity-40"
                aria-label="Send"
                title="Send"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        </>
      )}
    </>
  );
}

export function PageHeader({
  eyebrow, title, description, actions, dense = false,
}: {
  eyebrow?: string; title: string; description?: string; actions?: React.ReactNode; dense?: boolean;
}) {
  return (
    <div className={`flex flex-col md:flex-row md:items-start md:justify-between gap-4 md:gap-6 px-5 md:px-8 ${dense ? "pt-5 pb-4" : "pt-7 md:pt-9 pb-5 md:pb-6"} border-b border-border`}>
      <div>
        {eyebrow && (
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-medium mb-1.5">{eyebrow}</div>
        )}
        <h1 className={`font-display ${dense ? "text-xl md:text-2xl" : "text-2xl md:text-[34px]"} font-semibold tracking-tight text-foreground leading-tight`}>{title}</h1>
        {description && (
          <p className="mt-1.5 text-[13px] md:text-[14px] text-muted-foreground max-w-2xl leading-relaxed">{description}</p>
        )}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function TableScroll({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`surface-ops overflow-x-auto ${className}`}>
      <div className="min-w-[640px]">{children}</div>
    </div>
  );
}

export function EmptyState({
  title, description, icon: Icon, action,
}: {
  title: string; description?: string; icon?: React.ComponentType<{ className?: string }>; action?: React.ReactNode;
}) {
  return (
    <div className="surface-card p-10 text-center">
      {Icon && (
        <div className="mx-auto h-10 w-10 rounded-full bg-muted grid place-items-center text-muted-foreground mb-3">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="font-medium text-[15px]">{title}</div>
      {description && <div className="text-[13px] text-muted-foreground mt-1 max-w-md mx-auto">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function groupBy<T, K extends string>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of arr) {
    const k = key(item);
    (out[k] ||= []).push(item);
  }
  return out;
}
