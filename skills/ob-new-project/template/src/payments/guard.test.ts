import { describe, expect, test, vi } from "vitest";
import { guardedPayment, SmokePaymentRefused } from "./guard";

const smoke = { id: "smoke-account-1", isSmoke: true };

describe("payment guard", () => {
  test("a smoke account with live keys is refused before any provider call", async () => {
    const provider = vi.fn<() => Promise<string>>(async () => "charged");
    await expect(
      guardedPayment({ account: smoke, key: "sk_live_x" }, provider),
    ).rejects.toBeInstanceOf(SmokePaymentRefused);
    expect(provider).not.toHaveBeenCalled();
  });

  test("a smoke account with test keys reaches the sandbox", async () => {
    const provider = vi.fn<() => Promise<string>>(async () => "sandbox");
    await expect(guardedPayment({ account: smoke, key: "sk_test_x" }, provider)).resolves.toBe(
      "sandbox",
    );
  });
});
