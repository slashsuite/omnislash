// OS-24: the OB header nav lists the pages that exist (Home, Queue, Alerts, Tokens, Models, Timeline, Machine, Overview, Schedules), in that order, and marks
// the current one with aria-current. The e2e (e2e/home.spec.ts) checks the same at desktop and phone width.
import { describe, expect, mock, test } from "bun:test";
import { renderToString } from "react-dom/server";

void mock.module("../../../platform/dashboard-kit/src/lib/useRealtime.ts", () => ({
  useRealtime: () => ({ snap: null, connected: false }),
}));

const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { ObFrame } = await import("../src/components/ObFrame.tsx");

async function header(path: string): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ObFrame>page</ObFrame> }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

/** The Pages nav's links, in order, with whether each is marked current. */
function navLinks(html: string): { href: string; label: string; current: boolean }[] {
  const nav = /<nav[^>]*aria-label="Pages"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<a([^>]*)>(.*?)<\/a>/gs)].map(([, attrs, inner]) => ({
    href: /href="([^"]*)"/.exec(attrs!)?.[1] ?? "",
    label: inner!.replace(/<[^>]+>/g, ""),
    current: /aria-current="page"/.test(attrs!),
  }));
}

describe("ObFrame nav (OS-24)", () => {
  for (const page of ["/", "/queue", "/alerts", "/tokens", "/models", "/timeline", "/machine", "/overview", "/schedules"]) {
    test(`on ${page} the nav marks ${page} as the current page`, async () => {
      const links = navLinks(await header(page));
      expect(links.map((l) => [l.href, l.label])).toEqual([
        ["/", "Home"],
        ["/queue", "Queue"],
        ["/alerts", "Alerts"],
        ["/tokens", "Tokens"],
        ["/models", "Models"],
        ["/timeline", "Timeline"],
        ["/machine", "Machine"],
        ["/overview", "Overview"],
        ["/schedules", "Schedules"],
      ]);
      expect(links.filter((l) => l.current).map((l) => l.href)).toEqual([page]);
    });
  }
});
