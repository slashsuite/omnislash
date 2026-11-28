// OS-132: `POST /spinoffs` refuses a `model` with an empty half by name (400), so a raw call or an older
// client cannot queue a row that would only fail at drain. T3's catalog stays the client's check.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db/store.ts";
import { createObApi } from "../src/api/server.ts";
import { OB_API_PREFIX } from "../src/api/contract.ts";

const TOKEN = "os132-test-token";
const dir = mkdtempSync(join(tmpdir(), "ob-api-os132-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.each(["anthropic:", ":claude-haiku-5-5"])("a model of '%s' is a 400 naming 'model', and no row is written", async (model) => {
  const store = await openStore({ kind: "sqlite", path: join(dir, `ob-${model.length}.sqlite`), create: true });
  const handler = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const post = (body: unknown) =>
    handler(
      new Request(`http://api-host.local${OB_API_PREFIX}/spinoffs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const res = await post({ mode: "interactive", ticket_ref: "OS-1", repo: dir, branch: "os-1", brief: "do it", model });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("'model' must be [provider:]model");
  const list = await handler(new Request(`http://api-host.local${OB_API_PREFIX}/spinoffs`, { headers: { authorization: `Bearer ${TOKEN}` } }));
  expect(((await list.json()) as { spinoffs: unknown[] }).spinoffs).toEqual([]);
});
