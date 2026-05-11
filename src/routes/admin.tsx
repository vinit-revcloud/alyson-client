import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { useAuth, ROLE_LABEL, type AppRole } from "@/lib/auth";
import { Shield, Users, Database, Activity, Webhook, Key } from "lucide-react";
import { useState } from "react";
import { UsersRolesDrawer } from "@/components/drawers/UsersRolesDrawer";
import { toast } from "sonner";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin — Alyson HR" }] }),
  component: AdminPage,
});

function AdminPage() {
  const auth = useAuth();
  const effective = auth.demoRole ? [auth.demoRole] : auth.realRoles;
  const [usersOpen, setUsersOpen] = useState(false);

  if (!auth.hasRole("super_admin")) {
    return (
      <div>
        <PageHeader eyebrow="Admin" title="Access denied" description="This area is restricted to Super Admins." />
      </div>
    );
  }

  const sections = [
    { key: "users", icon: Users, title: "Users & roles", desc: "Manage who has access and what they can do.", action: () => setUsersOpen(true) },
    { key: "security", icon: Shield, title: "Security & SSO", desc: "Configure SSO, MFA, IP allowlists.", action: () => toast.info("SSO config coming soon") },
    { key: "data", icon: Database, title: "Data sources", desc: "Connect HRIS, payroll providers, accounting systems.", action: () => toast.info("Data sources panel coming soon") },
    { key: "webhooks", icon: Webhook, title: "Webhooks", desc: "Push events to Slack, ATS, finance tools.", action: () => toast.info("Webhook builder coming soon") },
    { key: "keys", icon: Key, title: "API keys", desc: "Service tokens for programmatic access.", action: () => toast.info("API key manager coming soon") },
    { key: "audit", icon: Activity, title: "Audit log", desc: "Every privileged action, queryable and exportable.", action: () => toast.info("Audit explorer coming soon") },
  ];

  return (
    <div>
      <PageHeader eyebrow="Admin" title="Workspace settings" description="Super-admin controls for the entire Alyson HR workspace." />
      <div className="px-5 md:px-8 py-6 md:py-7 space-y-6">
        <div className="surface-card p-5">
          <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Your roles</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {effective.length === 0 ? (
              <span className="text-xs text-muted-foreground">No roles assigned</span>
            ) : (
              effective.map((r) => <span key={r} className="pill pill-info">{ROLE_LABEL[r as AppRole]}</span>)
            )}
          </div>
          {auth.demoRole && (
            <div className="mt-2 text-xs text-muted-foreground">
              Currently in demo mode — viewing as {ROLE_LABEL[auth.demoRole]}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sections.map((s) => (
            <button key={s.key} onClick={s.action} className="surface-card p-5 hover:shadow-lg transition-shadow text-left">
              <div className="h-9 w-9 rounded-md bg-accent text-accent-foreground grid place-items-center mb-3">
                <s.icon className="h-4 w-4" />
              </div>
              <div className="font-medium">{s.title}</div>
              <div className="text-[12px] text-muted-foreground mt-1 leading-relaxed">{s.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <UsersRolesDrawer open={usersOpen} onClose={() => setUsersOpen(false)} />
    </div>
  );
}
