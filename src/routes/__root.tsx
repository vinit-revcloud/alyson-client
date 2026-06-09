import { Outlet, createRootRoute, HeadContent, Scripts, useRouterState, useNavigate, Link } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import appCss from "../styles.css?url";
import { AppShell } from "@/components/AppShell";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-7xl text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-medium">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:opacity-90"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Alyson HR — People, Pay & Equity OS" },
      {
        name: "description",
        content:
          "Alyson HR is a complete operating system for people, payroll, performance, and equity — built for modern operators.",
      },
      { property: "og:title", content: "Alyson HR — People, Pay & Equity OS" },
      { property: "og:description", content: "Alyson HR is a Compensation & Metrics Intelligence System for easy data exploration and analysis." },
      { property: "og:type", content: "website" },
      { name: "twitter:title", content: "Alyson HR — People, Pay & Equity OS" },
      { name: "description", content: "Alyson HR is a Compensation & Metrics Intelligence System for easy data exploration and analysis." },
      { name: "twitter:description", content: "Alyson HR is a Compensation & Metrics Intelligence System for easy data exploration and analysis." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/0478b816-e5d2-4dad-add0-c558372bedd6/id-preview-20cefd44--d9d2dbbc-ad15-469e-b728-96027041e5fa.lovable.app-1776803855904.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/0478b816-e5d2-4dad-add0-c558372bedd6/id-preview-20cefd44--d9d2dbbc-ad15-469e-b728-96027041e5fa.lovable.app-1776803855904.png" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "icon", href: "/images/alyson-mini.svg", type: "image/svg+xml" },
      { rel: "stylesheet", href: appCss },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=EB+Garamond:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } } })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthGate />
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AuthGate() {
  const { session, loading } = useAuth();
  const router = useRouterState();
  const navigate = useNavigate();
  const path = router.location.pathname;
  const isAuthRoute = path === "/auth";
  const isLandingRoute = path === "/";
  const isPublicRoute = isAuthRoute || isLandingRoute;

  useEffect(() => {
    if (loading) return;
    if (!session && !isPublicRoute) {
      navigate({ to: "/auth", replace: true });
    } else if (session && (isAuthRoute || isLandingRoute)) {
      navigate({ to: "/app", replace: true });
    }
  }, [session, loading, isPublicRoute, isAuthRoute, isLandingRoute, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="font-display text-2xl text-muted-foreground">Alyson HR</div>
      </div>
    );
  }

  if (isPublicRoute) return <Outlet />;
  if (!session) return null;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
