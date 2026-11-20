// OB-2207: the OB dashboard's header bell reads the live alert count from the realtime snapshot.
import { describe, expect, mock, test } from "bun:test";
import { renderToString } from "react-dom/server";

const rt: { snap: { alertCount: number } | null } = { snap: null };
void mock.module("../../../platform/dashboard-kit/src/lib/useRealtime.ts", () => ({
  useRealtime: () => ({ snap: rt.snap, connected: rt.snap !== null }),
}));

const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { AlertBell } = await import("../src/components/AlertBell.tsx");

async function renderBell(): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: AlertBell }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

describe("AlertBell (OB-2207)", () => {
  test("shows the snapshot's live count and links to /alerts (serve.test.ts covers the empty label)", async () => {
    rt.snap = { alertCount: 3 };
    const html = await renderBell();
    expect(html).toContain('aria-label="3 alerts need attention');
    expect(html).toContain('href="/alerts"');
    expect(html).toMatch(/>3<\/span>/);
  });
});
