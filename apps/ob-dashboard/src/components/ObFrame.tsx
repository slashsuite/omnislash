import { useRouterState } from "@tanstack/react-router";
import { AppShell, AppShellBrand, Tabs } from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { LiveBadge } from "../../../../platform/dashboard-kit/src/components/LiveBadge.tsx";
import { AlertBell } from "./AlertBell.tsx";

// OB-2207: the OB dashboard's header: the app name (the way home), the page nav, then the alert bell and the
// live badge. OS-24 (OB-2199 step 8): the nav lists only the pages that exist; Queue and Timeline join it in the
// tickets that build them. Below `md` AppShell moves the nav into its Menu, so every page stays reachable on a phone.
const PAGES = [
  { label: "Home", href: "/" },
  { label: "Alerts", href: "/alerts" },
  { label: "Tokens", href: "/tokens" },
  { label: "Models", href: "/models" },
] as const;

export function ObFrame({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    // 0.11 sets running text at 1rem; the OB dashboard keeps the 14px step, as the dashboard does.
    <AppShell
      density="compact"
      brand={<AppShellBrand logo={<img src="/omnislash-logo-light.svg" alt="" />} label="OB" href="/" />}
      nav={<Tabs label="Pages" items={PAGES.map((p) => ({ label: p.label, href: p.href, selected: pathname === p.href }))} />}
      controls={
        <>
          <AlertBell />
          <LiveBadge />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
