import { useRouterState } from "@tanstack/react-router";
import { AppShell, AppShellBrand, Tabs } from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { LiveBadge } from "../../../../platform/dashboard-kit/src/components/LiveBadge.tsx";
import { AlertBell } from "./AlertBell.tsx";

// OB-2207: the OB dashboard's header: the app name (the way home) and, at the end, the alert bell and the
// live badge. OB-2210 (step 8) adds the page nav to the `nav` slot.
// OB-2208: Tokens (with the WhatsApp pairing panel) moved here; a plain link to it sits before the bell until
// step 8 gives the header its full nav.
export function ObFrame({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    // 0.11 sets running text at 1rem; the OB dashboard keeps the 14px step, as the dashboard does.
    <AppShell
      density="compact"
      brand={<AppShellBrand logo={<img src="/omnislash-logo-light.svg" alt="" />} label="OB" href="/" />}
      controls={
        <>
          <Tabs
            label="Pages"
            items={[
              { label: "Tokens", selected: pathname === "/tokens", href: "/tokens" },
              { label: "Models", selected: pathname === "/models", href: "/models" },
            ]}
          />
          <AlertBell />
          <LiveBadge />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
