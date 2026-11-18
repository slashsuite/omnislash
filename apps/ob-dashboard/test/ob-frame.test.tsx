// OB-2208: Tokens (with the WhatsApp pairing panel) moved to the OB dashboard, and the OB header links to it.
import { describe, expect, mock, test } from "bun:test";
import { renderToString } from "react-dom/server";

mock.module("../../../platform/dashboard-kit/src/lib/useRealtime.ts", () => ({
  useRealtime: () => ({ snap: null, connected: false }),
}));

const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { ObFrame } = await import("../src/components/ObFrame.tsx");

describe("ObFrame (OB-2208)", () => {
  test("the header has a plain link to /tokens", async () => {
    const router = createRouter({
      routeTree: createRootRoute({ component: () => <ObFrame>page</ObFrame> }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const html = renderToString(<RouterProvider router={router} />);
    expect(html).toMatch(/<a[^>]*href="\/tokens"[^>]*>(?:(?!<\/a>).)*Tokens/s);
  });
});
