import { describe, expect, it } from "bun:test";
import { freshDb } from "../../../cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../cli/src/db/store.ts";
import { runCredentialCheck } from "../../../cli/src/credentials.ts";
import { inMemoryMasterKey, setSecret } from "../../../cli/src/secrets.ts";
import { checkedAtText, creditState } from "./credit.ts";

// OS-23. The e2e drives ok, failed and never checked on the page; running low is only ever a phrase inside an ok
// check's detail, so it is read here from the detail the real `ob creds check opencode-go` writes (through its
// http seam: no network, no real key), not from a copy of that phrase.

describe("creditState (OS-23)", () => {
  it("reads the CLI's own running-low warning as running low", async () => {
    const key = inMemoryMasterKey();
    const store = sqliteStoreFor(freshDb());
    await setSecret(store, "opencode-go", "oc_go_test_key", key.get());
    const window = (percent: number) => ({ status: "ok", percent, resetsAt: "2026-12-01T00:00:00.000Z" });
    const body = { usage: { rolling: window(10), weekly: window(95), monthly: window(50) } };
    const http = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const row = await runCredentialCheck(store, "opencode-go", { http, masterKey: key });
    expect(row.ok).toBe(true);
    expect(creditState(row)).toEqual({ label: "running low", tone: "warn" });
  });
});

describe("checkedAtText", () => {
  it("is UTC to the minute", () => expect(checkedAtText("2026-11-24T08:30:12.000Z")).toBe("2026-11-24 08:30 UTC"));
  it("shows an unreadable stamp as stored", () => expect(checkedAtText("soon")).toBe("soon"));
});
